/** Shared internal helpers: lookups, tech modifiers, events. */
import { BUILDINGS, RULES, TECHS, UNITS } from '../content';
import type { Building, BuildingKind, GameEvent, GameState, PlayerId, Squad } from './types';
import { TICK_RATE, TILE } from './types';

export function findById<T extends { id: number }>(arr: T[], id: number): T | null {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid].id;
    if (v === id) return arr[mid];
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export function findSquad(state: GameState, id: number): Squad | null {
  return findById(state.squads, id);
}

export function findBuilding(state: GameState, id: number): Building | null {
  return findById(state.buildings, id);
}

export function getTownCenter(state: GameState, player: PlayerId): Building | null {
  for (const b of state.buildings) if (b.owner === player && b.kind === 'towncenter') return b;
  return null;
}

export function emit(state: GameState, ev: GameEvent): void {
  state.events.push(ev);
}

export function reject(state: GameState, owner: PlayerId, reason: string): void {
  emit(state, { t: 'rejected', owner, reason });
}

/** Configured peace length in ticks (>= 0, integer). */
export function peaceTicksOf(state: GameState): number {
  const p = state.config.peaceTicks;
  return typeof p === 'number' && p > 0 ? Math.trunc(p) : 0;
}

/** True while the peace phase ("Friedenszeit") is running. */
export function inPeace(state: GameState): boolean {
  return state.tick < peaceTicksOf(state);
}

/** Income handicap of a player in percent (default 100). */
export function incomePctOf(state: GameState, player: PlayerId): number {
  const v = state.config.players[player]?.incomePct;
  return typeof v === 'number' && v >= 0 ? Math.trunc(v) : 100;
}

export function enemyOf(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

/** Sum of +dmg% techs of a player. */
export function techDmgPct(state: GameState, player: PlayerId): number {
  let s = 0;
  for (const t of state.players[player].techs) s += TECHS[t].dmgPct ?? 0;
  return s;
}

/** Sum of −dmgTaken% techs of a player. */
export function techArmorPct(state: GameState, player: PlayerId): number {
  let s = 0;
  for (const t of state.players[player].techs) s += TECHS[t].dmgTakenPct ?? 0;
  return s > 90 ? 90 : s;
}

export function bodyRadius(e: Squad | Building): number {
  if ('slot' in e) return e.kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius;
  return RULES.squadRadius;
}

export function buildingRadiusOf(kind: BuildingKind): number {
  return kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius;
}

export function isBuilding(e: Squad | Building): e is Building {
  return 'slot' in e;
}

export function membersOf(squad: Squad): number {
  const hpm = UNITS[squad.kind].hpPerMember;
  return squad.hp <= 0 ? 0 : Math.ceil(squad.hp / hpm);
}

/** Completed base buildings (no TC, no point towers) – the age requirement count. */
export function completedBaseBuildings(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.owner === player && b.slot >= 0 && b.buildTicksLeft === 0) n++;
  }
  return n;
}

export function buildingCount(state: GameState, player: PlayerId, kind: BuildingKind): number {
  let n = 0;
  for (const b of state.buildings) if (b.owner === player && b.kind === kind) n++;
  return n;
}

/** Throttled 'underAttack' event: once per 10 s per player per 8-tile area. */
export function alertUnderAttack(state: GameState, owner: PlayerId, x: number, y: number): void {
  const area = Math.floor(y / (8 * TILE)) * 1000 + Math.floor(x / (8 * TILE));
  if (!state.alerts) state.alerts = [];
  const alerts = state.alerts;
  for (const a of alerts) {
    if (a.owner === owner && a.area === area) {
      if (state.tick - a.tick < 10 * TICK_RATE) return;
      a.tick = state.tick;
      emit(state, { t: 'underAttack', owner, x, y });
      return;
    }
  }
  alerts.push({ owner, area, tick: state.tick });
  alerts.sort((a, b) => a.owner - b.owner || a.area - b.area);
  emit(state, { t: 'underAttack', owner, x, y });
}

export function pruneAlerts(state: GameState): void {
  if (!state.alerts || state.alerts.length === 0) return;
  const keep = state.alerts.filter((a) => state.tick - a.tick < 10 * TICK_RATE);
  if (keep.length !== state.alerts.length) state.alerts = keep;
}

export function buildingDef(kind: BuildingKind) {
  return BUILDINGS[kind];
}
