/**
 * Command validation (single source of truth, also used by step()) and
 * command application.
 */
import { BUILDINGS, RESOURCE_NAMES, RULES, TECHS, UNITS, AGE_NAMES } from '../content';
import type { Age, Building, Command, GameState, PlayerId, Resources, Squad, Vec } from './types';
import { TILE } from './types';
import { inPeace, findBuilding, findSquad, completedNonTcBuildings, buildingCount, getTownCenter, enemyOf, reject, emit } from './world';
import { mapOf, newBuilding, slotPos } from './init';
import { findPath, nearestWalkable } from './pathfinding';
import { isqrt } from './fixed';

const RES_KEYS: (keyof Resources)[] = ['food', 'wood', 'gold'];

export function hasRes(res: Resources, cost: Resources): boolean {
  return res.food >= cost.food && res.wood >= cost.wood && res.gold >= cost.gold;
}

function lackReason(res: Resources, cost: Resources): string | null {
  for (const k of RES_KEYS) if (res[k] < cost[k]) return `Zu wenig ${RESOURCE_NAMES[k]}`;
  return null;
}

function pay(res: Resources, cost: Resources): void {
  res.food -= cost.food;
  res.wood -= cost.wood;
  res.gold -= cost.gold;
}

function refund(res: Resources, cost: Resources): void {
  res.food += cost.food;
  res.wood += cost.wood;
  res.gold += cost.gold;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function ageReason(age: Age): string {
  return `Benötigt ${AGE_NAMES[age]}`;
}

/** Own, alive squads from a list (deduplicated, ascending id). */
export function ownSquads(state: GameState, player: PlayerId, ids: unknown): Squad[] {
  if (!Array.isArray(ids)) return [];
  const sorted = ids.filter(isInt).slice().sort((a, b) => a - b);
  const out: Squad[] = [];
  let last = -1;
  for (const id of sorted) {
    if (id === last) continue;
    last = id;
    const s = findSquad(state, id);
    if (s && s.owner === player && s.hp > 0) out.push(s);
  }
  return out;
}

function ownCompletedBuilding(state: GameState, player: PlayerId, id: unknown): Building | string {
  if (!isInt(id)) return 'Gebäude ungültig';
  const b = findBuilding(state, id);
  if (!b || b.owner !== player || b.hp <= 0) return 'Gebäude ungültig';
  if (b.buildTicksLeft > 0) return 'Gebäude noch im Bau';
  return b;
}

/** Coordinates may arrive as floats from the UI; the sim truncates them on apply. */
function inMap(state: GameState, x: unknown, y: unknown): boolean {
  return (
    typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) &&
    x >= 0 && y >= 0 && x < state.mapW * TILE && y < state.mapH * TILE
  );
}

function techQueuedOrDone(state: GameState, player: PlayerId, tech: string): 'done' | 'queued' | null {
  if ((state.players[player].techs as string[]).includes(tech)) return 'done';
  for (const b of state.buildings) {
    if (b.owner !== player) continue;
    for (const q of b.queue) if (q.item === tech) return 'queued';
  }
  return null;
}

export function validate(state: GameState, player: PlayerId, cmd: Command): string | null {
  if (state.winner !== null) return 'Spiel ist vorbei';
  if (player !== 0 && player !== 1) return 'Ungültiger Spieler';
  if (!cmd || typeof cmd !== 'object') return 'Ungültiger Befehl';
  const p = state.players[player];
  switch (cmd.t) {
    case 'move': {
      if (ownSquads(state, player, cmd.squads).length === 0) return 'Keine Trupps ausgewählt';
      if (!inMap(state, cmd.x, cmd.y)) return 'Ziel außerhalb der Karte';
      return null;
    }
    case 'attack': {
      if (ownSquads(state, player, cmd.squads).length === 0) return 'Keine Trupps ausgewählt';
      if (!isInt(cmd.target)) return 'Ungültiges Ziel';
      const ts = findSquad(state, cmd.target);
      const tb = ts ? null : findBuilding(state, cmd.target);
      const t = ts ?? tb;
      if (!t || t.hp <= 0) return 'Ungültiges Ziel';
      if (t.owner === player) return 'Eigene Einheiten nicht angreifbar';
      if (inPeace(state)) return 'Friedenszeit';
      return null;
    }
    case 'stop':
      if (ownSquads(state, player, cmd.squads).length === 0) return 'Keine Trupps ausgewählt';
      return null;
    case 'retreat':
      if (ownSquads(state, player, cmd.squads).length === 0) return 'Keine Trupps ausgewählt';
      if (!getTownCenter(state, player)) return 'Kein Dorfzentrum';
      return null;
    case 'build': {
      if (!isInt(cmd.slot) || cmd.slot < 0 || cmd.slot > 7) return 'Ungültiger Bauplatz';
      const def = BUILDINGS[cmd.kind];
      if (!def || cmd.kind === 'towncenter') return 'Ungültiges Gebäude';
      for (const b of state.buildings) if (b.owner === player && b.slot === cmd.slot) return 'Bauplatz belegt';
      if (p.age < def.age) return ageReason(def.age);
      if (buildingCount(state, player, cmd.kind) >= def.maxPerPlayer) return `Maximal ${def.maxPerPlayer}× ${def.name}`;
      return lackReason(p.res, def.cost);
    }
    case 'train': {
      const b = ownCompletedBuilding(state, player, cmd.building);
      if (typeof b === 'string') return b;
      const u = UNITS[cmd.unit];
      if (!u || !BUILDINGS[b.kind].trains.includes(cmd.unit)) return 'Kann hier nicht ausgebildet werden';
      if (p.age < u.age) return ageReason(u.age);
      if (b.queue.length >= RULES.queueMax) return 'Warteschlange voll';
      if (p.pop + u.pop > p.popCap) return 'Bevölkerungslimit erreicht';
      return lackReason(p.res, u.cost);
    }
    case 'research': {
      const b = ownCompletedBuilding(state, player, cmd.building);
      if (typeof b === 'string') return b;
      const t = TECHS[cmd.tech];
      if (!t || !BUILDINGS[b.kind].researches.includes(cmd.tech)) return 'Kann hier nicht erforscht werden';
      const st = techQueuedOrDone(state, player, cmd.tech);
      if (st === 'done') return 'Bereits erforscht';
      if (st === 'queued') return 'Wird bereits erforscht';
      if (p.age < t.age) return ageReason(t.age);
      if (cmd.tech === 'age2' && p.age >= 2) return 'Bereits erforscht';
      if (cmd.tech === 'age3' && p.age >= 3) return 'Bereits erforscht';
      if (t.requiresBuildings > 0 && completedNonTcBuildings(state, player) < t.requiresBuildings) {
        return `Benötigt ${t.requiresBuildings} fertige Gebäude`;
      }
      if (b.queue.length >= RULES.queueMax) return 'Warteschlange voll';
      return lackReason(p.res, t.cost);
    }
    case 'cancel': {
      if (!isInt(cmd.building)) return 'Gebäude ungültig';
      const b = findBuilding(state, cmd.building);
      if (!b || b.owner !== player) return 'Gebäude ungültig';
      if (b.queue.length === 0) return 'Warteschlange leer';
      return null;
    }
    case 'rally': {
      if (!isInt(cmd.building)) return 'Gebäude ungültig';
      const b = findBuilding(state, cmd.building);
      if (!b || b.owner !== player) return 'Gebäude ungültig';
      if (!inMap(state, cmd.x, cmd.y)) return 'Ziel außerhalb der Karte';
      return null;
    }
    case 'upgradePoint': {
      if (!isInt(cmd.point)) return 'Ungültiger Punkt';
      const pt = state.points.find((q) => q.id === cmd.point);
      if (!pt) return 'Ungültiger Punkt';
      if (pt.owner !== player) return 'Punkt gehört dir nicht';
      if (pt.level >= 2) return 'Bereits ausgebaut';
      return lackReason(p.res, RULES.pointUpgradeCost);
    }
    case 'surrender':
      return null;
    default:
      return 'Ungültiger Befehl';
  }
}

// ---------------------------------------------------------------- formation

const SPACING = 1400;

/**
 * Formation destinations for a group move, oriented along the move direction
 * (centroid -> click point): ranks perpendicular to it, block centred on the
 * click point. Squads are assigned by their current forward/lateral position,
 * so the result is mirror-symmetric for mirrored inputs.
 */
export function formationDests(state: GameState, player: PlayerId, list: Squad[], center: Vec): Vec[] {
  const n = list.length;
  if (n === 1) return [nearestWalkable(state, center.x, center.y)];
  // centroid computed relative to the map middle (trunc is odd-symmetric -> mirror exact)
  const mid = (state.mapW * TILE) >> 1;
  let rx = 0;
  let cy = 0;
  for (const s of list) {
    rx += s.x - mid;
    cy += s.y;
  }
  const cx = mid + Math.trunc(rx / n);
  cy = Math.trunc(cy / n);
  let fx = center.x - cx;
  let fy = center.y - cy;
  let L = isqrt(fx * fx + fy * fy);
  if (L < 500) {
    // no clear direction: face the enemy side
    fx = player === 0 ? 1000 : -1000;
    fy = 0;
    L = 1000;
  }
  // lateral axis: perpendicular, pointing down (+y); if horizontal, toward the map center
  let lx = -fy;
  let ly = fx;
  if (ly < 0 || (ly === 0 && (cx < mid ? lx < 0 : lx > 0))) {
    lx = -lx;
    ly = -ly;
  }
  const cols = n <= 3 ? n : isqrt(n - 1) + 1;
  const ranks = Math.ceil(n / cols);
  // order squads: front-most first (forward projection desc), then lateral asc, then id
  const keyed = list.map((s, i) => ({
    i,
    id: s.id,
    fwd: Math.trunc(((s.x - cx) * fx + (s.y - cy) * fy) / L),
    lat: Math.trunc(((s.x - cx) * lx + (s.y - cy) * ly) / L),
  }));
  keyed.sort((a, b) => b.fwd - a.fwd || a.id - b.id);
  const out: Vec[] = new Array(n);
  const half = SPACING >> 1;
  for (let r = 0; r < ranks; r++) {
    const rank = keyed.slice(r * cols, r * cols + cols);
    rank.sort((a, b) => a.lat - b.lat || a.id - b.id);
    const k = rank.length;
    const fOff = (ranks - 1 - 2 * r) * half;
    for (let c = 0; c < k; c++) {
      const lOff = (2 * c - (k - 1)) * half;
      const x = center.x + Math.trunc((fx * fOff + lx * lOff) / L);
      const y = center.y + Math.trunc((fy * fOff + ly * lOff) / L);
      out[rank[c].i] = nearestWalkable(state, x, y);
    }
  }
  return out;
}

export function orderMove(state: GameState, s: Squad, dest: Vec, order: 'move' | 'retreat'): void {
  s.order = order;
  s.target = null;
  s.guard = null;
  s.dest = { x: dest.x, y: dest.y };
  s.path = findPath(state, s.x, s.y, dest.x, dest.y);
  if (s.path.length === 0) {
    s.order = 'idle';
    s.dest = null;
  }
}

export function setIdle(s: Squad): void {
  s.order = 'idle';
  s.target = null;
  s.dest = null;
  s.path = [];
  s.guard = null;
}

export function retreatPoint(state: GameState, player: PlayerId): Vec | null {
  const tc = getTownCenter(state, player);
  if (!tc) return null;
  const dir = player === 0 ? 1 : -1;
  return nearestWalkable(state, tc.x + dir * (RULES.townCenterRadius + 1200), tc.y);
}

// ---------------------------------------------------------------- apply

export function applyCommand(state: GameState, player: PlayerId, cmd: Command): void {
  const why = validate(state, player, cmd);
  if (why !== null) {
    if (player === 0 || player === 1) reject(state, player, why);
    return;
  }
  const p = state.players[player];
  switch (cmd.t) {
    case 'move': {
      const list = ownSquads(state, player, cmd.squads);
      const center = nearestWalkable(state, Math.trunc(cmd.x), Math.trunc(cmd.y));
      const dests = formationDests(state, player, list, center);
      list.forEach((s, i) => orderMove(state, s, dests[i], 'move'));
      return;
    }
    case 'attack': {
      for (const s of ownSquads(state, player, cmd.squads)) {
        s.order = 'attack';
        s.target = cmd.target;
        s.guard = null;
        s.dest = null;
        s.path = [];
      }
      return;
    }
    case 'stop':
      for (const s of ownSquads(state, player, cmd.squads)) setIdle(s);
      return;
    case 'retreat': {
      const list = ownSquads(state, player, cmd.squads);
      const center = retreatPoint(state, player)!;
      const dests = formationDests(state, player, list, center);
      list.forEach((s, i) => orderMove(state, s, dests[i], 'retreat'));
      return;
    }
    case 'build': {
      const def = BUILDINGS[cmd.kind];
      pay(p.res, def.cost);
      const pos = slotPos(mapOf(state), player, cmd.slot);
      newBuilding(state, player, cmd.kind, cmd.slot, pos.x, pos.y, false);
      return;
    }
    case 'train': {
      const b = findBuilding(state, cmd.building)!;
      const u = UNITS[cmd.unit];
      pay(p.res, u.cost);
      p.pop += u.pop;
      b.queue.push({ item: cmd.unit, ticksLeft: u.trainTicks, totalTicks: u.trainTicks });
      return;
    }
    case 'research': {
      const b = findBuilding(state, cmd.building)!;
      const t = TECHS[cmd.tech];
      pay(p.res, t.cost);
      b.queue.push({ item: cmd.tech, ticksLeft: t.researchTicks, totalTicks: t.researchTicks });
      return;
    }
    case 'cancel': {
      const b = findBuilding(state, cmd.building)!;
      const it = b.queue.pop()!;
      if (it.item in UNITS) {
        const u = UNITS[it.item as keyof typeof UNITS];
        refund(p.res, u.cost);
        p.pop -= u.pop;
      } else {
        refund(p.res, TECHS[it.item as keyof typeof TECHS].cost);
      }
      return;
    }
    case 'rally': {
      const b = findBuilding(state, cmd.building)!;
      b.rally = nearestWalkable(state, Math.trunc(cmd.x), Math.trunc(cmd.y));
      return;
    }
    case 'upgradePoint': {
      const pt = state.points.find((q) => q.id === cmd.point)!;
      pay(p.res, RULES.pointUpgradeCost);
      pt.level = 2;
      return;
    }
    case 'surrender': {
      p.surrendered = true;
      endGame(state, enemyOf(player), 'surrender');
      return;
    }
  }
}

export function endGame(state: GameState, winner: PlayerId | -1, reason: 'towncenter' | 'vp' | 'timeout' | 'surrender'): void {
  if (state.winner !== null) return;
  state.winner = winner;
  state.winReason = reason;
  emit(state, { t: 'gameOver', winner, reason });
}

export { pay, refund };
