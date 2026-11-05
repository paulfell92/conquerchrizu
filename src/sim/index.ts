/**
 * Conquer Chrizu – public simulation API. Client, bot, relay and tools import
 * ONLY from this file (plus ./types and ../content). Internals may live in
 * other files under src/sim/.
 *
 * STATUS: contract stub – the sim agent implements these bodies.
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

export * from './types';

export const SIM_VERSION = '0.1.0';

/** Build the initial state: map grid, both town centers, 13 neutral points, start squads, start resources. */
export function createGame(config: GameConfig): GameState {
  throw new Error('not implemented');
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
  throw new Error('not implemented');
}

/** Deterministic 32-bit hash of the full state except `events` (for desync checks). */
export function hashState(state: GameState): number {
  throw new Error('not implemented');
}

/** Deep copy (structuredClone-equivalent, but safe for JSON state). */
export function cloneState(state: GameState): GameState {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------- queries
// Pure read-only helpers shared by client and bot so rules live in one place.

/** null if the command is valid for this player right now, else a short German reason ("Zu wenig Holz"). */
export function validateCommand(state: GameState, player: PlayerId, cmd: Command): string | null {
  throw new Error('not implemented');
}

/** World position (milli-tiles, tile center) of a build slot 0..7 of a player. */
export function slotPosition(state: GameState, player: PlayerId, slot: number): Vec {
  throw new Error('not implemented');
}

/** All 8 slots of a player with the building on it (or null). */
export function slots(state: GameState, player: PlayerId): { slot: number; pos: Vec; building: Building | null }[] {
  throw new Error('not implemented');
}

export function townCenter(state: GameState, player: PlayerId): Building | null {
  throw new Error('not implemented');
}

/** Squad or building by id, or null. */
export function entity(state: GameState, id: number): Squad | Building | null {
  throw new Error('not implemented');
}

export function canAfford(res: Resources, cost: Resources): boolean {
  throw new Error('not implemented');
}

/** Effective cost (content cost; hook for future discounts). */
export function unitCost(state: GameState, player: PlayerId, kind: UnitKind): Resources {
  throw new Error('not implemented');
}
export function buildingCost(state: GameState, player: PlayerId, kind: BuildingKind): Resources {
  throw new Error('not implemented');
}
export function techCost(state: GameState, player: PlayerId, tech: TechId): Resources {
  throw new Error('not implemented');
}

/**
 * Fog of war: per-tile visibility for a player (length mapW*mapH, 1 = currently
 * visible). Union of sight circles of own squads, buildings and owned points.
 */
export function computeVisibility(state: GameState, player: PlayerId): number[] {
  throw new Error('not implemented');
}

/** Whether a world position is walkable. */
export function isWalkable(state: GameState, x: number, y: number): boolean {
  throw new Error('not implemented');
}

/** Ticks elapsed -> "mm:ss". */
export function formatClock(tick: number): string {
  throw new Error('not implemented');
}
