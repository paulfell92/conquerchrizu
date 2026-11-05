/**
 * Conquer Chrizu – public simulation API. Client, bot, relay and tools import
 * ONLY from this file (plus ./types and ../content). Internals live in other
 * files under src/sim/.
 */
import type {
  BuildingKind,
  Building,
  Command,
  GameConfig,
  GameState,
  PlayerCommand,
  PlayerId,
  Resources,
  Squad,
  TechId,
  UnitKind,
  Vec,
} from './types';
import { BUILDINGS, TECHS, UNITS } from '../content';
import { createInitialState, mapOf, slotPos } from './init';
import { stepState, squadDamage as squadDamageInternal } from './tick';
import { hasRes, hirePrice as hirePriceInternal, pointTowerOn, pointUpgradeCostFor, validate } from './commands';
import { findBuilding, findSquad, getTownCenter, inPeace, peaceTicksOf } from './world';
import { clock, clone, hash, visibility } from './queries';
import { findPath as findPathInternal, walkable } from './pathfinding';
import { dist as distInternal, isqrt as isqrtInternal } from './fixed';

export * from './types';

export const SIM_VERSION = '0.1.0';

/** Build the initial state: map grid, both town centers, 13 neutral points, start squads, start resources. */
export function createGame(config: GameConfig): GameState {
  return createInitialState(config, SIM_VERSION);
}

/**
 * Advance exactly one tick (1/20 s). Executes every command whose `tick` equals
 * state.tick (in array order: player 0 first, then player 1, then submission
 * order), then production, movement, combat, capture, income, healing, VP,
 * victory check. Clears and refills state.events. Increments state.tick.
 * Invalid commands are ignored and emit a 'rejected' event. Does nothing once
 * state.winner !== null.
 */
export function step(state: GameState, commands: PlayerCommand[]): void {
  stepState(state, commands);
}

/** Deterministic 32-bit hash of the full state except `events` (for desync checks). */
export function hashState(state: GameState): number {
  return hash(state);
}

/** Deep copy (structuredClone-equivalent, but safe for JSON state). */
export function cloneState(state: GameState): GameState {
  return clone(state);
}

// ---------------------------------------------------------------- queries
// Pure read-only helpers shared by client and bot so rules live in one place.

/** null if the command is valid for this player right now, else a short German reason ("Zu wenig Holz"). */
export function validateCommand(state: GameState, player: PlayerId, cmd: Command): string | null {
  return validate(state, player, cmd);
}

/** World position (milli-tiles, tile center) of a build slot 0..7 of a player. */
export function slotPosition(state: GameState, player: PlayerId, slot: number): Vec {
  return slotPos(mapOf(state), player, slot);
}

/** All 8 slots of a player with the building on it (or null). */
export function slots(state: GameState, player: PlayerId): { slot: number; pos: Vec; building: Building | null }[] {
  const map = mapOf(state);
  const out: { slot: number; pos: Vec; building: Building | null }[] = [];
  for (let i = 0; i < map.slotOffsets.length; i++) {
    let b: Building | null = null;
    for (const x of state.buildings) {
      if (x.owner === player && x.slot === i) {
        b = x;
        break;
      }
    }
    out.push({ slot: i, pos: slotPos(map, player, i), building: b });
  }
  return out;
}

export function townCenter(state: GameState, player: PlayerId): Building | null {
  return getTownCenter(state, player);
}

/** Squad or building by id, or null. */
export function entity(state: GameState, id: number): Squad | Building | null {
  return findSquad(state, id) ?? findBuilding(state, id);
}

export function canAfford(res: Resources, cost: Resources): boolean {
  return hasRes(res, cost);
}

/** Effective cost (content cost; hook for future discounts). */
export function unitCost(state: GameState, player: PlayerId, kind: UnitKind): Resources {
  return { ...UNITS[kind].cost };
}
export function buildingCost(state: GameState, player: PlayerId, kind: BuildingKind): Resources {
  return { ...BUILDINGS[kind].cost };
}
export function techCost(state: GameState, player: PlayerId, tech: TechId): Resources {
  return { ...TECHS[tech].cost };
}

/**
 * Fog of war: per-tile visibility for a player (length mapW*mapH, 1 = currently
 * visible). Union of sight circles of own squads, buildings and owned points.
 */
export function computeVisibility(state: GameState, player: PlayerId): number[] {
  return visibility(state, player);
}

/** Whether a world position is walkable. */
export function isWalkable(state: GameState, x: number, y: number): boolean {
  return walkable(state, x, y);
}

/** Ticks elapsed -> "mm:ss". */
export function formatClock(tick: number): string {
  return clock(tick);
}

// ---------------------------------------------------------------- additions (sim agent)

/**
 * Deterministic replay: createGame(config), then step with the logged commands
 * (per tick: player 0 first, then player 1, submission order – same as
 * LocalRelay). Runs until `untilTick` (state.tick === untilTick) or, if
 * omitted, until the game is over. Returns the resulting state.
 */
export function replay(config: GameConfig, log: PlayerCommand[], untilTick?: number): GameState {
  const state = createGame(config);
  const cmds = log
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.tick - b.c.tick || a.c.player - b.c.player || a.i - b.i)
    .map((x) => x.c);
  let k = 0;
  const limit = untilTick ?? Number.MAX_SAFE_INTEGER;
  while (state.tick < limit && state.winner === null) {
    while (k < cmds.length && cmds[k].tick < state.tick) k++;
    let e = k;
    while (e < cmds.length && cmds[e].tick === state.tick) e++;
    step(state, k === e ? [] : cmds.slice(k, e));
    k = e;
  }
  return state;
}

/** Gold price of hiring mercenaries of `kind` (cost sum × hireCostPct %, gold only). */
export function hireCost(kind: UnitKind): Resources {
  return hirePriceInternal(kind);
}

/** Ticks until `hire` is allowed again for a player (0 = ready). */
export function hireCooldownLeft(state: GameState, player: PlayerId): number {
  const left = (state.players[player].hireReadyTick ?? 0) - state.tick;
  return left > 0 ? left : 0;
}

/** Cost of the next upgrade of an own point (level 1 -> 2 or 2 -> 3). */
export function pointUpgradeCost(level: number): Resources {
  return { ...pointUpgradeCostFor(level) };
}

/** The point tower standing on a capture point, or null. */
export function pointTower(state: GameState, pointId: number): Building | null {
  return pointTowerOn(state, pointId);
}

/** True while the peace phase ("Friedenszeit", config.peaceTicks) is running. */
export function isPeace(state: GameState): boolean {
  return inPeace(state);
}

/** Ticks until peace ends (0 when there is no peace / it is over). */
export function peaceTicksLeft(state: GameState): number {
  const left = peaceTicksOf(state) - state.tick;
  return left > 0 ? left : 0;
}

/** Smoothed walkable path (waypoints in milli-tiles) – same planner the squads use. */
export function findPath(state: GameState, from: Vec, to: Vec): Vec[] {
  return findPathInternal(state, from.x, from.y, to.x, to.y);
}

/** Damage one attack of `attacker` would deal to `target` right now (spec formula). */
export function attackDamage(state: GameState, attacker: Squad, target: Squad | Building): number {
  return squadDamageInternal(state, attacker, target);
}

/** Integer distance in milli-tiles. */
export function distance(a: Vec, b: Vec): number {
  return distInternal(a.x, a.y, b.x, b.y);
}

/** Integer square root (floor). */
export function isqrt(n: number): number {
  return isqrtInternal(n);
}

/** Capture point counts: [owned by p0, owned by p1, neutral]. */
export function pointCounts(state: GameState): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (const p of state.points) c[p.owner === -1 ? 2 : p.owner]++;
  return c;
}

