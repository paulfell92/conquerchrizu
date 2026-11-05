/**
 * One simulation tick: commands, production, movement, combat, capture,
 * economy, healing, victory points, victory.
 */
import { BUILDINGS, RULES, TECHS, UNITS } from '../content';
import type { Building, GameState, PlayerCommand, PlayerId, Squad, TechId, UnitKind, Vec } from './types';
import { TICK_RATE } from './types';
import { dist2, isqrt, octant } from './fixed';
import { findPath, nearestWalkable, walkable } from './pathfinding';
import {
  alertUnderAttack,
  bodyRadius,
  emit,
  enemyOf,
  findBuilding,
  findSquad,
  getTownCenter,
  isBuilding,
  membersOf,
  pruneAlerts,
  techArmorPct,
  techDmgPct,
} from './world';
import { applyCommand, endGame, orderMove, setIdle } from './commands';
import { newSquad } from './init';

const REPATH_TICKS = 10;
const REPATH_DRIFT = 300;
/** Auto-acquired chases give up beyond (sight + LEASH_EXTRA) from where they started. */
const LEASH_EXTRA = 4000;
/** Separation: own squads closer than this (center to center) push apart. */
const SEP_DIST = RULES.squadRadius * 2;
const SEP_MAX_PUSH = 40;
/** Chasers close in until this far inside their attack range. */
const APPROACH_MARGIN = 150;

export function stepState(state: GameState, commands: PlayerCommand[]): void {
  state.events = [];
  if (state.winner !== null) return;

  // 1. commands (caller order: player 0 first, then player 1, submission order)
  for (const pc of commands) {
    if (pc.tick !== state.tick) continue;
    applyCommand(state, pc.player, pc.cmd);
    if (state.winner !== null) {
      state.tick++;
      return;
    }
  }

  // 2. production
  production(state);
  // 3. movement / target acquisition
  movement(state);
  separation(state);
  // 4. combat
  combat(state);
  // 5. per-second rules
  if (state.tick % TICK_RATE === TICK_RATE - 1) {
    capture(state);
    income(state);
    healing(state);
    victoryPoints(state);
  }
  pruneAlerts(state);
  // 6. victory
  victory(state);
  state.tick++;
  if (state.winner === null && state.tick >= RULES.hardCapTicks) {
    const a = state.players[0].vp;
    const b = state.players[1].vp;
    endGame(state, a > b ? 0 : b > a ? 1 : -1, 'timeout');
  }
}

// ---------------------------------------------------------------- production

function spawnPos(state: GameState, b: Building): Vec {
  const r = bodyRadius(b) + RULES.squadRadius + 300;
  let dx: number;
  let dy: number;
  if (b.rally) {
    dx = b.rally.x - b.x;
    dy = b.rally.y - b.y;
  } else if (b.kind === 'towncenter') {
    dx = b.owner === 0 ? 1 : -1;
    dy = 0;
  } else {
    const tc = getTownCenter(state, b.owner);
    dx = tc ? b.x - tc.x : b.owner === 0 ? 1 : -1;
    dy = tc ? b.y - tc.y : 0;
  }
  const d = isqrt(dx * dx + dy * dy);
  if (d === 0) return nearestWalkable(state, b.x + (b.owner === 0 ? r : -r), b.y);
  return nearestWalkable(state, b.x + Math.trunc((dx * r) / d), b.y + Math.trunc((dy * r) / d));
}

function production(state: GameState): void {
  for (const b of state.buildings) {
    if (b.buildTicksLeft > 0) {
      const def = BUILDINGS[b.kind];
      const start = Math.max(1, Math.trunc(def.hp / 10));
      const doneBefore = def.buildTicks - b.buildTicksLeft;
      const hpBefore = start + Math.trunc(((def.hp - start) * doneBefore) / def.buildTicks);
      const hpAfter = start + Math.trunc(((def.hp - start) * (doneBefore + 1)) / def.buildTicks);
      b.hp = Math.min(b.maxHp, b.hp + (hpAfter - hpBefore));
      b.buildTicksLeft--;
      if (b.buildTicksLeft === 0) emit(state, { t: 'built', building: b.id, owner: b.owner });
      continue;
    }
    if (b.queue.length === 0) continue;
    const q = b.queue[0];
    q.ticksLeft--;
    if (q.ticksLeft > 0) continue;
    b.queue.shift();
    const p = state.players[b.owner];
    if (q.item in UNITS) {
      const kind = q.item as UnitKind;
      const pos = spawnPos(state, b);
      const s = newSquad(state, b.owner, kind, pos.x, pos.y);
      p.stats.squadsTrained++;
      emit(state, { t: 'trained', squad: s.id, owner: b.owner });
      if (b.rally) orderMove(state, s, b.rally, 'move');
    } else {
      const tech = q.item as TechId;
      if (!p.techs.includes(tech)) p.techs.push(tech);
      emit(state, { t: 'researched', owner: b.owner, tech });
      if (tech === 'age2' || tech === 'age3') {
        const age = tech === 'age2' ? 2 : 3;
        if (p.age < age) {
          p.age = age;
          emit(state, { t: 'ageUp', owner: b.owner, age });
        }
      }
    }
  }
}

// ---------------------------------------------------------------- movement

function inRange(a: Squad | Building, b: Squad | Building, range: number): boolean {
  const reach = range + bodyRadius(a) + bodyRadius(b);
  return dist2(a.x, a.y, b.x, b.y) <= reach * reach;
}

function tryMoveTo(state: GameState, s: Squad, nx: number, ny: number): boolean {
  if (walkable(state, nx, ny)) {
    s.x = nx;
    s.y = ny;
    return true;
  }
  if (nx !== s.x && walkable(state, nx, s.y)) {
    s.x = nx;
    return true;
  }
  if (ny !== s.y && walkable(state, s.x, ny)) {
    s.y = ny;
    return true;
  }
  return false;
}

/** Advance along path; returns true when the path is finished. */
function followPath(state: GameState, s: Squad, speed: number): boolean {
  let budget = speed;
  while (budget > 0 && s.path.length > 0) {
    const wp = s.path[0];
    const dx = wp.x - s.x;
    const dy = wp.y - s.y;
    const d = isqrt(dx * dx + dy * dy);
    const f = octant(dx, dy);
    if (f >= 0) s.facing = f;
    if (d <= budget) {
      if (!tryMoveTo(state, s, wp.x, wp.y)) {
        s.path = s.dest ? findPath(state, s.x, s.y, s.dest.x, s.dest.y) : [];
        return s.path.length === 0;
      }
      s.path.shift();
      budget -= d;
      if (d === 0) budget = Math.max(0, budget - 1);
    } else {
      const nx = s.x + Math.trunc((dx * budget) / d);
      const ny = s.y + Math.trunc((dy * budget) / d);
      if (!tryMoveTo(state, s, nx, ny)) {
        // blocked (pushed against a wall): repath from here
        const goal = s.dest ?? s.path[s.path.length - 1];
        s.path = findPath(state, s.x, s.y, goal.x, goal.y);
        return s.path.length === 0;
      }
      budget = 0;
    }
  }
  return s.path.length === 0;
}

// Start-of-movement snapshot of squad positions: every squad decides from the
// same picture, so the id iteration order cannot favour a side.
let snapX: number[] = [];
let snapY: number[] = [];
let snapIds: number[] = [];

function takeSnapshot(state: GameState): void {
  const n = state.squads.length;
  snapX = new Array(n);
  snapY = new Array(n);
  snapIds = new Array(n);
  for (let i = 0; i < n; i++) {
    const q = state.squads[i];
    snapX[i] = q.x;
    snapY[i] = q.y;
    snapIds[i] = q.id;
  }
}

/** Snapshot position of an entity (buildings never move). */
function posOf(e: Squad | Building): Vec {
  if (isBuilding(e)) return e;
  let lo = 0;
  let hi = snapIds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = snapIds[mid];
    if (v === e.id) return { x: snapX[mid], y: snapY[mid] };
    if (v < e.id) lo = mid + 1;
    else hi = mid - 1;
  }
  return e;
}

function targetOf(state: GameState, id: number | null): Squad | Building | null {
  if (id === null) return null;
  const s = findSquad(state, id);
  if (s) return s.hp > 0 ? s : null;
  const b = findBuilding(state, id);
  return b && b.hp > 0 ? b : null;
}

/** Nearest enemy squad (or building if none / ram) within sight. Ties: lowest id. */
function acquire(state: GameState, s: Squad): Squad | Building | null {
  const def = UNITS[s.kind];
  const sight2 = def.sight * def.sight;
  let best: Squad | Building | null = null;
  let bestD = 0;
  if (s.kind !== 'ram') {
    for (let i = 0; i < state.squads.length; i++) {
      const e = state.squads[i];
      if (e.owner === s.owner || e.hp <= 0) continue;
      const d = dist2(s.x, s.y, snapX[i], snapY[i]);
      if (d <= sight2 && (best === null || d < bestD)) {
        best = e;
        bestD = d;
      }
    }
    if (best) return best;
  }
  for (const b of state.buildings) {
    if (b.owner === s.owner || b.hp <= 0) continue;
    const reach = def.sight + bodyRadius(b);
    const d = dist2(s.x, s.y, b.x, b.y);
    if (d <= reach * reach && (best === null || d < bestD)) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

function movement(state: GameState): void {
  takeSnapshot(state);
  for (const s of state.squads) {
    if (s.hp <= 0) continue;
    const def = UNITS[s.kind];
    if (s.cooldown > 0) s.cooldown--;
    if (s.order === 'move' || s.order === 'retreat') {
      if (followPath(state, s, def.speed)) setIdle(s);
      continue;
    }
    if (s.order === 'attack') {
      const t = targetOf(state, s.target);
      if (!t) {
        setIdle(s);
      } else {
        chase(state, s, t);
        continue;
      }
    }
    // idle: auto-acquire
    const t = acquire(state, s);
    if (t) {
      s.order = 'attack';
      s.target = t.id;
      s.guard = { x: s.x, y: s.y };
      s.path = [];
      chase(state, s, t);
    }
  }
}

function chase(state: GameState, s: Squad, t: Squad | Building): void {
  const def = UNITS[s.kind];
  const tp = posOf(t);
  const reach = def.range + bodyRadius(s) + bodyRadius(t);
  if (dist2(s.x, s.y, tp.x, tp.y) <= reach * reach) {
    s.path = [];
    const f = octant(tp.x - s.x, tp.y - s.y);
    if (f >= 0) s.facing = f;
    return;
  }
  if (s.guard) {
    const leash = def.sight + LEASH_EXTRA;
    if (dist2(s.x, s.y, s.guard.x, s.guard.y) > leash * leash) {
      orderMove(state, s, s.guard, 'move');
      return;
    }
  }
  // repath when there is no path, or (at most every REPATH_TICKS, same phase for
  // everyone) when the target drifted away from the path end
  let repath = s.path.length === 0;
  if (!repath && state.tick % REPATH_TICKS === 0) {
    const end = s.path[s.path.length - 1];
    repath = dist2(end.x, end.y, tp.x, tp.y) > REPATH_DRIFT * REPATH_DRIFT;
  }
  if (repath) s.path = findPath(state, s.x, s.y, tp.x, tp.y);
  // do not overshoot deep into the target: stop a little inside the attack range
  const need = isqrt(dist2(s.x, s.y, tp.x, tp.y)) - reach + APPROACH_MARGIN;
  const speed = need < def.speed && need > 0 && s.path.length === 1 ? need : def.speed;
  const saved = s.dest;
  s.dest = { x: tp.x, y: tp.y };
  followPath(state, s, speed);
  s.dest = saved;
}

/** Attacking with the target in reach (chase() cleared the path). */
function engaged(s: Squad): boolean {
  return s.order === 'attack' && s.path.length === 0;
}

/**
 * Separation: all pushes are computed from the same positions, summed per
 * squad, then applied (order independent, mirror symmetric).
 */
function separation(state: GameState): void {
  const sq = state.squads;
  const n = sq.length;
  let ax: number[] | null = null;
  let ay: number[] | null = null;
  for (let i = 0; i < n; i++) {
    const a = sq[i];
    for (let j = i + 1; j < n; j++) {
      const b = sq[j];
      if (a.owner !== b.owner) continue;
      const dx = b.x - a.x;
      if (dx >= SEP_DIST || dx <= -SEP_DIST) continue;
      const dy = b.y - a.y;
      if (dy >= SEP_DIST || dy <= -SEP_DIST) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= SEP_DIST * SEP_DIST) continue;
      // squads engaged in combat hold their ground; the other one yields
      const ea = engaged(a);
      const eb = engaged(b);
      if (ea && eb) continue;
      const d = isqrt(d2);
      let push = (SEP_DIST - d) >> 2;
      if (push > SEP_MAX_PUSH) push = SEP_MAX_PUSH;
      if (push < 1) push = 1;
      let px: number;
      let py: number;
      if (d === 0) {
        // identical positions: split vertically (y is not mirrored), lower id up
        px = 0;
        py = push;
      } else {
        px = Math.trunc((dx * push) / d);
        py = Math.trunc((dy * push) / d);
      }
      const fa = eb ? 2 : ea ? 0 : 1;
      const fb = ea ? 2 : eb ? 0 : 1;
      if (!ax || !ay) {
        ax = new Array(n).fill(0);
        ay = new Array(n).fill(0);
      }
      ax[i] -= px * fa;
      ay[i] -= py * fa;
      ax[j] += px * fb;
      ay[j] += py * fb;
    }
  }
  if (!ax || !ay) return;
  for (let i = 0; i < n; i++) {
    let mx = ax[i];
    let my = ay[i];
    if (mx === 0 && my === 0) continue;
    const lim = SEP_MAX_PUSH * 2;
    mx = mx > lim ? lim : mx < -lim ? -lim : mx;
    my = my > lim ? lim : my < -lim ? -lim : my;
    const q = sq[i];
    if (walkable(state, q.x + mx, q.y + my)) {
      q.x += mx;
      q.y += my;
    } else if (mx !== 0 && walkable(state, q.x + mx, q.y)) q.x += mx;
    else if (my !== 0 && walkable(state, q.x, q.y + my)) q.y += my;
  }
}

// ---------------------------------------------------------------- combat

interface Hit {
  from: Squad | Building;
  to: Squad | Building;
  dmg: number;
  ranged: boolean;
}

function onOwnPoint(state: GameState, s: Squad): boolean {
  const r2 = RULES.captureRadius * RULES.captureRadius;
  for (const p of state.points) {
    if (p.owner === s.owner && dist2(s.x, s.y, p.x, p.y) <= r2) return true;
  }
  return false;
}

/** Damage formula from the spec (integer, truncate at the end, min 1). */
export function squadDamage(state: GameState, a: Squad, t: Squad | Building): number {
  const def = UNITS[a.kind];
  const members = membersOf(a);
  const bonusKey = isBuilding(t) ? 'building' : t.kind;
  const bonus = def.bonus[bonusKey] ?? 100;
  const tdmg = techDmgPct(state, a.owner);
  let num = members * def.dmgPerMember * bonus * (100 + tdmg);
  let den = 100 * 100;
  if (!isBuilding(t)) {
    num *= (100 - techArmorPct(state, t.owner)) * (onOwnPoint(state, t) ? RULES.defenderDamageTakenPct : 100);
    den *= 100 * 100;
  }
  const dmg = Math.trunc(num / den);
  return dmg < 1 ? 1 : dmg;
}

export function buildingDamage(state: GameState, b: Building, t: Squad): number {
  const def = BUILDINGS[b.kind];
  const num = def.dmg * (100 - techArmorPct(state, t.owner)) * (onOwnPoint(state, t) ? RULES.defenderDamageTakenPct : 100);
  const dmg = Math.trunc(num / 10000);
  return dmg < 1 ? 1 : dmg;
}

function combat(state: GameState): void {
  const hits: Hit[] = [];
  // squads
  for (const s of state.squads) {
    if (s.hp <= 0 || s.order !== 'attack' || s.cooldown > 0) continue;
    const t = targetOf(state, s.target);
    if (!t) continue;
    const def = UNITS[s.kind];
    if (!inRange(s, t, def.range)) continue;
    hits.push({ from: s, to: t, dmg: squadDamage(state, s, t), ranged: def.ranged });
    s.cooldown = def.cooldownTicks;
  }
  // town centers and towers
  for (const b of state.buildings) {
    const def = BUILDINGS[b.kind];
    if (def.dmg <= 0 || b.buildTicksLeft > 0 || b.hp <= 0) continue;
    if (b.cooldown > 0) b.cooldown--;
    let t = b.target !== null ? findSquad(state, b.target) : null;
    if (!t || t.hp <= 0 || t.owner === b.owner || !inRange(b, t, def.range)) {
      t = null;
      let bestD = 0;
      const reach0 = def.range + bodyRadius(b) + RULES.squadRadius;
      const reach2 = reach0 * reach0;
      for (const e of state.squads) {
        if (e.owner === b.owner || e.hp <= 0) continue;
        const d = dist2(b.x, b.y, e.x, e.y);
        if (d <= reach2 && (t === null || d < bestD)) {
          t = e;
          bestD = d;
        }
      }
      b.target = t ? t.id : null;
    }
    if (!t || b.cooldown > 0) continue;
    hits.push({ from: b, to: t, dmg: buildingDamage(state, b, t), ranged: true });
    b.cooldown = def.cooldownTicks;
  }
  if (hits.length === 0) return;

  // apply simultaneously
  for (const h of hits) {
    const t = h.to;
    t.hp -= h.dmg;
    emit(state, { t: 'hit', from: h.from.id, to: t.id, dmg: h.dmg, ranged: h.ranged });
    alertUnderAttack(state, t.owner, t.x, t.y);
    if (!isBuilding(h.from)) h.from.lastCombatTick = state.tick;
    if (!isBuilding(t)) t.lastCombatTick = state.tick;
  }
  // reactions only after ALL damage of this tick is applied (order independent)
  for (const h of hits) if (!isBuilding(h.to)) retaliate(state, h.to, h.from);

  // deaths (squads)
  let anyDead = false;
  for (const s of state.squads) {
    if (s.hp > 0) {
      s.members = membersOf(s);
      continue;
    }
    anyDead = true;
    const def = UNITS[s.kind];
    const p = state.players[s.owner];
    const killer = state.players[enemyOf(s.owner)];
    const total = def.cost.food + def.cost.wood + def.cost.gold;
    killer.res.gold += Math.trunc((total * RULES.bountyGoldPctOfCost) / 100);
    killer.stats.squadsKilled++;
    p.stats.squadsLost++;
    p.pop -= def.pop;
    p.vp -= RULES.vpLossPerSquadDeath;
    s.members = 0;
    emit(state, { t: 'death', id: s.id, owner: s.owner, kind: s.kind, x: s.x, y: s.y });
  }
  if (anyDead) state.squads = state.squads.filter((s) => s.hp > 0);

  // deaths (buildings)
  let anyB = false;
  for (const b of state.buildings) {
    if (b.hp > 0) continue;
    anyB = true;
    const p = state.players[b.owner];
    for (const q of b.queue) if (q.item in UNITS) p.pop -= UNITS[q.item as UnitKind].pop;
    b.queue = [];
    emit(state, { t: 'death', id: b.id, owner: b.owner, kind: b.kind, x: b.x, y: b.y });
  }
  if (anyB) state.buildings = state.buildings.filter((b) => b.hp > 0);
}

function retaliate(state: GameState, s: Squad, from: Squad | Building): void {
  if (s.hp <= 0 || from.hp <= 0) return;
  if (s.kind === 'ram' && !isBuilding(from)) return; // rams cannot fight units
  if (s.order === 'idle') {
    s.order = 'attack';
    s.target = from.id;
    s.guard = { x: s.x, y: s.y };
    s.path = [];
    return;
  }
  // auto-acquired chase whose target is out of reach: switch to whoever hits us
  if (s.order === 'attack' && s.guard && s.target !== from.id) {
    const cur = targetOf(state, s.target);
    if (!cur || !inRange(s, cur, UNITS[s.kind].range)) {
      if (isBuilding(from) && cur && !isBuilding(cur)) return; // prefer squads over towers
      s.target = from.id;
      s.path = [];
    }
  }
}

// ---------------------------------------------------------------- per-second rules

function capture(state: GameState): void {
  const r2 = RULES.captureRadius * RULES.captureRadius;
  const max = RULES.captureMax;
  for (const pt of state.points) {
    let c0 = 0;
    let c1 = 0;
    for (const s of state.squads) {
      if (s.kind === 'ram' || s.hp <= 0) continue;
      if (dist2(s.x, s.y, pt.x, pt.y) > r2) continue;
      if (s.owner === 0) c0++;
      else c1++;
    }
    const prevOwner = pt.owner;
    if (c0 > 0 && c1 > 0) continue; // contested
    if (c0 === 0 && c1 === 0) {
      // regenerate toward the current owner state
      if (pt.owner !== -1) {
        if (pt.progress < max) {
          pt.capturer = pt.owner;
          pt.progress = Math.min(max, pt.progress + 2);
        }
      } else if (pt.progress > 0) {
        pt.progress = Math.max(0, pt.progress - 2);
        if (pt.progress === 0) pt.capturer = -1;
      }
      continue;
    }
    const who: PlayerId = c0 > 0 ? 0 : 1;
    const rate = RULES.captureRatePerSquad * Math.min(c0 + c1, 3);
    if (pt.owner === who) {
      if (pt.progress < max) {
        pt.capturer = who;
        pt.progress = Math.min(max, pt.progress + rate);
      }
      continue;
    }
    if (pt.owner !== -1) {
      // neutralise the enemy point
      pt.capturer = who;
      pt.progress -= rate;
      if (pt.progress <= 0) {
        pt.progress = 0;
        pt.owner = -1;
        pt.level = 1;
        emit(state, { t: 'captured', point: pt.id, owner: -1, prevOwner });
      }
      continue;
    }
    // neutral point
    if (pt.capturer !== who && pt.progress > 0) {
      // undo the other side's partial capture first
      pt.progress -= rate;
      if (pt.progress <= 0) {
        pt.progress = 0;
        pt.capturer = who;
      }
      continue;
    }
    pt.capturer = who;
    pt.progress += rate;
    if (pt.progress >= max) {
      pt.progress = max;
      pt.owner = who;
      pt.level = 1;
      state.players[who].stats.pointsCaptured++;
      emit(state, { t: 'captured', point: pt.id, owner: who, prevOwner });
    }
  }
}

function income(state: GameState): void {
  for (const p of state.players) {
    let f = 0;
    let w = 0;
    let g = 0;
    if (getTownCenter(state, p.id)) {
      f += RULES.townCenterIncome.food;
      w += RULES.townCenterIncome.wood;
      g += RULES.townCenterIncome.gold;
    }
    for (const pt of state.points) {
      if (pt.owner !== p.id) continue;
      const inc = RULES.pointIncome[pt.kind];
      const pct = pt.level === 2 ? RULES.pointLevel2IncomePct : 100;
      f += Math.trunc((inc.food * pct) / 100);
      w += Math.trunc((inc.wood * pct) / 100);
      g += Math.trunc((inc.gold * pct) / 100);
    }
    p.res.food += f;
    p.res.wood += w;
    p.res.gold += g;
    p.stats.resourcesGathered += f + w + g;
  }
}

function healing(state: GameState): void {
  const r2 = RULES.healRadius * RULES.healRadius;
  for (const s of state.squads) {
    if (s.hp >= s.maxHp || s.hp <= 0) continue;
    if (state.tick - s.lastCombatTick < RULES.healOutOfCombatTicks) continue;
    let near = false;
    const tc = getTownCenter(state, s.owner);
    if (tc && dist2(s.x, s.y, tc.x, tc.y) <= r2) near = true;
    if (!near) {
      for (const p of state.points) {
        if (p.owner === s.owner && dist2(s.x, s.y, p.x, p.y) <= r2) {
          near = true;
          break;
        }
      }
    }
    if (!near) continue;
    const add = Math.max(1, Math.trunc((s.maxHp * RULES.healPctPerSecond) / 100));
    s.hp = Math.min(s.maxHp, s.hp + add);
    s.members = membersOf(s);
  }
}

function victoryPoints(state: GameState): void {
  let n0 = 0;
  let n1 = 0;
  for (const p of state.points) {
    if (p.owner === 0) n0++;
    else if (p.owner === 1) n1++;
  }
  if (n0 === n1) return;
  const diff = n0 > n1 ? n0 - n1 : n1 - n0;
  let drain = diff * RULES.vpDrainPerPoint;
  if (state.tick >= RULES.vpDrainDoubleAfterTicks) drain *= 2;
  const loser = n0 < n1 ? 0 : 1;
  state.players[loser].vp -= drain;
}

function victory(state: GameState): void {
  if (state.winner !== null) return;
  const tc0 = getTownCenter(state, 0) !== null;
  const tc1 = getTownCenter(state, 1) !== null;
  if (!tc0 || !tc1) {
    endGame(state, !tc0 && !tc1 ? -1 : tc0 ? 0 : 1, 'towncenter');
    return;
  }
  const v0 = state.players[0].vp;
  const v1 = state.players[1].vp;
  if (v0 <= 0 || v1 <= 0) {
    endGame(state, v0 <= 0 && v1 <= 0 ? (v0 > v1 ? 0 : v1 > v0 ? 1 : -1) : v0 <= 0 ? 1 : 0, 'vp');
  }
}


