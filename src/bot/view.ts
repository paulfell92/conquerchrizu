/**
 * What the bot is allowed to know. Everything about the enemy goes through
 * this module: own entities are fully known; enemy squads/buildings only when
 * their tile is visible per computeVisibility (buildings are remembered once
 * seen, squads are remembered for a while with their last known position).
 * Public: point owners/levels, both players' VP, the map (TC positions).
 */
import { computeVisibility } from '../sim';
import type { Building, BuildingKind, CapturePoint, GameState, PlayerId, PlayerState, Squad, UnitKind, Vec } from '../sim';
import { BUILDINGS, MAPS, RULES, UNITS } from '../content';

export const TPS = 20;
const T = 1000; // milli-tiles per tile

// ---------------------------------------------------------------- unit evaluation

const BASE_POWER: Record<UnitKind, number> = {} as Record<UnitKind, number>;
for (const k of Object.keys(UNITS) as UnitKind[]) {
  const u = UNITS[k];
  const hp = u.members * u.hpPerMember;
  const dps = (u.members * u.dmgPerMember * TPS) / u.cooldownTicks;
  // Ranged units get free hits while melee closes in.
  const rangedF = u.ranged ? 1.3 : 1;
  // Rams barely hurt squads.
  const unitBonus = k === 'ram' ? 0.1 : 1;
  BASE_POWER[k] = Math.sqrt(hp * dps * unitBonus) * rangedF;
}

export function basePower(kind: UnitKind): number {
  return BASE_POWER[kind];
}

export function bonus(a: UnitKind, b: UnitKind | 'building'): number {
  return UNITS[a].bonus[b] ?? 100;
}

/** > 1 if `a` is favoured against `b` (symmetrical log-scale counter factor). */
const CF = new Map<string, number>();
export function counterFactor(a: UnitKind, b: UnitKind): number {
  const key = a + '|' + b;
  let v = CF.get(key);
  if (v === undefined) {
    v = Math.sqrt(bonus(a, b) / bonus(b, a));
    CF.set(key, v);
  }
  return v;
}

export interface Unitish {
  kind: UnitKind;
  hp: number;
  maxHp: number;
}

export function squadPower(s: Unitish): number {
  const frac = s.maxHp > 0 ? Math.min(1, s.hp / s.maxHp) : 1;
  return BASE_POWER[s.kind] * (0.25 + 0.75 * frac);
}

/** Strength of `ours` vs `theirs`, taking counters into account. */
export function matchupPower(ours: readonly Unitish[], theirs: readonly Unitish[]): number {
  if (ours.length === 0) return 0;
  if (theirs.length === 0) {
    let p = 0;
    for (const s of ours) p += squadPower(s);
    return p;
  }
  let theirTotal = 0;
  for (const t of theirs) theirTotal += squadPower(t);
  let p = 0;
  for (const s of ours) {
    let f = 0;
    for (const t of theirs) f += (squadPower(t) / theirTotal) * counterFactor(s.kind, t.kind);
    p += squadPower(s) * f;
  }
  return p;
}

export function dist(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function centroid(list: readonly Vec[]): Vec {
  if (list.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of list) {
    x += p.x;
    y += p.y;
  }
  return { x: Math.trunc(x / list.length), y: Math.trunc(y / list.length) };
}

// ---------------------------------------------------------------- memory

export interface SeenSquad {
  id: number;
  kind: UnitKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  lastSeen: number;
  /** Last known position was re-checked and the squad was not there. */
  stale: boolean;
}

export interface SeenBuilding {
  id: number;
  kind: BuildingKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  lastSeen: number;
}

/** Forget squads not seen for this long (they may have died elsewhere). */
const SQUAD_MEMORY_TICKS = 90 * TPS;

export class Memory {
  readonly squads = new Map<number, SeenSquad>();
  readonly buildings = new Map<number, SeenBuilding>();
  /** Exponentially-decayed count of enemy unit kinds ever seen (for counters). */
  readonly seenKinds: Partial<Record<UnitKind, number>> = {};
  readonly countedIds = new Set<number>();
  lastVis: number[] | null = null;
  lastVisTick = -1;
}

// ---------------------------------------------------------------- view

export interface View {
  state: GameState;
  tick: number;
  me: PlayerId;
  foe: PlayerId;
  player: PlayerState;
  /** Public info about the enemy: VP only. */
  foeVp: number;
  vis: number[];
  mySquads: Squad[];
  myBuildings: Building[];
  myTc: Building | null;
  /** Enemy squads on currently visible tiles. */
  enemySquads: Squad[];
  /** Enemy buildings: currently visible ones plus remembered ones. */
  enemyBuildings: SeenBuilding[];
  points: CapturePoint[];
  myHome: Vec;
  foeHome: Vec;
  memory: Memory;
}

export function tileIndex(state: GameState, x: number, y: number): number {
  const tx = Math.trunc(x / T);
  const ty = Math.trunc(y / T);
  if (tx < 0 || ty < 0 || tx >= state.mapW || ty >= state.mapH) return -1;
  return ty * state.mapW + tx;
}

export function isVisible(state: GameState, vis: number[], x: number, y: number): boolean {
  const i = tileIndex(state, x, y);
  return i >= 0 && vis[i] === 1;
}

export function homePositions(state: GameState, me: PlayerId): { mine: Vec; foe: Vec } {
  const map = MAPS[state.config.mapId];
  const tc = (p: number): Vec => {
    if (!map) return { x: p === 0 ? 6500 : state.mapW * T - 6500, y: Math.trunc((state.mapH * T) / 2) };
    const t = map.towncenters[p];
    return { x: t.x * T + 500, y: t.y * T + 500 };
  };
  return { mine: tc(me), foe: tc(1 - me) };
}

/**
 * Build the per-pass view and update memory. Calls computeVisibility at most
 * once per tick. Never touches hidden enemy entities.
 */
export function buildView(state: GameState, me: PlayerId, memory: Memory): View {
  const foe = (1 - me) as PlayerId;
  let vis: number[];
  if (memory.lastVisTick === state.tick && memory.lastVis) vis = memory.lastVis;
  else {
    vis = computeVisibility(state, me);
    memory.lastVis = vis;
    memory.lastVisTick = state.tick;
  }
  const tick = state.tick;

  const mySquads: Squad[] = [];
  const enemySquads: Squad[] = [];
  for (const s of state.squads) {
    if (s.owner === me) mySquads.push(s);
    else if (isVisible(state, vis, s.x, s.y)) enemySquads.push(s);
  }
  const myBuildings: Building[] = [];
  let myTc: Building | null = null;
  const visibleFoeBuildings = new Set<number>();
  for (const b of state.buildings) {
    if (b.owner === me) {
      myBuildings.push(b);
      if (b.kind === 'towncenter') myTc = b;
    } else if (isVisible(state, vis, b.x, b.y)) {
      visibleFoeBuildings.add(b.id);
      memory.buildings.set(b.id, { id: b.id, kind: b.kind, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp, lastSeen: tick });
    }
  }
  // Remembered buildings whose tile is visible but which are gone -> destroyed.
  for (const [id, b] of memory.buildings) {
    if (!visibleFoeBuildings.has(id) && isVisible(state, vis, b.x, b.y)) memory.buildings.delete(id);
  }

  // Squad memory.
  const visibleIds = new Set<number>();
  for (const s of enemySquads) {
    visibleIds.add(s.id);
    memory.squads.set(s.id, { id: s.id, kind: s.kind, x: s.x, y: s.y, hp: s.hp, maxHp: s.maxHp, lastSeen: tick, stale: false });
    if (!memory.countedIds.has(s.id)) {
      memory.countedIds.add(s.id);
      // decay older observations so recent composition dominates
      for (const k of Object.keys(memory.seenKinds) as UnitKind[]) memory.seenKinds[k] = (memory.seenKinds[k] ?? 0) * 0.93;
      memory.seenKinds[s.kind] = (memory.seenKinds[s.kind] ?? 0) + 1;
    }
  }
  for (const [id, s] of memory.squads) {
    if (visibleIds.has(id)) continue;
    if (tick - s.lastSeen > SQUAD_MEMORY_TICKS) memory.squads.delete(id);
    else if (!s.stale && isVisible(state, vis, s.x, s.y)) s.stale = true;
  }
  // Deaths we could witness (tile visible) remove the memory entry.
  for (const e of state.events) {
    if (e.t === 'death' && e.owner === foe && memory.squads.has(e.id) && isVisible(state, vis, e.x, e.y)) {
      memory.squads.delete(e.id);
    }
  }

  const homes = homePositions(state, me);
  return {
    state,
    tick,
    me,
    foe,
    player: state.players[me],
    foeVp: state.players[foe].vp,
    vis,
    mySquads,
    myBuildings,
    myTc,
    enemySquads,
    enemyBuildings: [...memory.buildings.values()],
    points: state.points,
    myHome: myTc ? { x: myTc.x, y: myTc.y } : homes.mine,
    foeHome: homes.foe,
    memory,
  };
}

/** Enemy squads we believe exist (visible now + remembered), with confidence weight. */
export function believedEnemies(view: View): { s: SeenSquad; w: number }[] {
  const out: { s: SeenSquad; w: number }[] = [];
  for (const s of view.memory.squads.values()) {
    const age = view.tick - s.lastSeen;
    const w = age <= 0 ? 1 : Math.max(0.3, 1 - age / (60 * TPS)) * (s.stale ? 0.7 : 1);
    out.push({ s, w });
  }
  return out;
}

/** Rough guess of the enemy's army size from game time (no peeking). */
export function expectedEnemyPop(view: View): number {
  const minutes = view.tick / (60 * TPS);
  return Math.min(RULES.popCap, 2 + minutes * 1.6);
}

/** Estimated total enemy power: remembered squads + a prior for unseen ones. */
export function enemyPowerEstimate(view: View): number {
  let p = 0;
  let n = 0;
  for (const { s, w } of believedEnemies(view)) {
    if (s.kind === 'ram') continue;
    p += squadPower(s) * w;
    n += 1;
  }
  const unseen = Math.max(0, expectedEnemyPop(view) - n);
  const avg = view.tick < 6 * 60 * TPS ? 55 : view.tick < 12 * 60 * TPS ? 75 : 90;
  return p + unseen * avg * 0.5;
}

/** Danger near a position from believed enemy squads and known defensive buildings. */
export function dangerAt(view: View, pos: Vec, radius: number): number {
  const r2 = radius * radius;
  let d = 0;
  for (const { s, w } of believedEnemies(view)) {
    if (s.kind === 'ram' || s.kind === 'scout') continue;
    if (dist2(s, pos) <= r2) d += squadPower(s) * w;
  }
  for (const b of view.memory.buildings.values()) {
    if (b.kind !== 'tower' && b.kind !== 'towncenter') continue;
    const def = BUILDINGS[b.kind];
    const reach = def.range + 1500;
    if (dist2(b, pos) <= reach * reach) d += b.kind === 'tower' ? 45 : 40;
  }
  return d;
}

export function isRam(s: { kind: UnitKind }): boolean {
  return s.kind === 'ram';
}
