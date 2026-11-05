/**
 * Conquer Chrizu – shared contract between sim, bot, client and net.
 *
 * DETERMINISM RULES (apply to everything under src/sim and src/content):
 *  - All game-state numbers are INTEGERS. Positions are in milli-tiles
 *    (1 tile = 1000 units). Use Math.trunc / integer helpers, isqrt for roots.
 *  - No Math.random, Date.now, performance.now, Math.sin/cos/sqrt/atan2 in sim.
 *    Use the seeded RNG stored in GameState.rng.
 *  - Iterate arrays in ascending id order. No iteration over object keys whose
 *    insertion order depends on runtime events.
 *  - GameState must stay plain JSON (no classes, Maps, Sets, typed arrays) so it
 *    can be hashed, cloned and sent over the network.
 */

export type PlayerId = 0 | 1;
export type Owner = PlayerId | -1; // -1 = neutral

export const TICK_RATE = 20; // ticks per second
export const TILE = 1000; // milli-tiles per tile
export const COMMAND_DELAY_TICKS = 2; // local relay schedules commands tick+2 (100 ms)

export type UnitKind = 'scout' | 'spear' | 'archer' | 'cavalry' | 'sword' | 'ram' | 'knight';
export type BuildingKind =
  | 'towncenter'
  | 'barracks'
  | 'range'
  | 'stable'
  | 'blacksmith'
  | 'workshop'
  | 'tower';
export type PointKind = 'village' | 'forest' | 'mine';
export type TechId = 'age2' | 'age3' | 'attack1' | 'armor1' | 'attack2';
export type Age = 1 | 2 | 3;

export interface Resources {
  food: number;
  wood: number;
  gold: number;
}

export interface Vec {
  x: number; // milli-tiles
  y: number; // milli-tiles
}

// ---------------------------------------------------------------- commands

export type Command =
  | { t: 'move'; squads: number[]; x: number; y: number }
  | { t: 'attack'; squads: number[]; target: number } // target = squad or building id
  | { t: 'stop'; squads: number[] }
  | { t: 'retreat'; squads: number[] } // move back to own town center
  | { t: 'build'; slot: number; kind: BuildingKind } // slot index 0..7 of own base
  | { t: 'train'; building: number; unit: UnitKind }
  | { t: 'research'; building: number; tech: TechId }
  | { t: 'cancel'; building: number } // remove LAST queue item, refund 100 %
  | { t: 'rally'; building: number; x: number; y: number }
  | { t: 'upgradePoint'; point: number } // own capture point level 1 -> 2
  | { t: 'surrender' };

export interface PlayerCommand {
  player: PlayerId;
  tick: number; // tick at which the sim executes it (before movement of that tick)
  cmd: Command;
}

// ---------------------------------------------------------------- state

export type SquadOrder = 'idle' | 'move' | 'attack' | 'retreat';

export interface Squad {
  id: number;
  owner: PlayerId;
  kind: UnitKind;
  x: number;
  y: number;
  hp: number; // total hp of the squad
  maxHp: number; // members * hpPerMember (after techs)
  members: number; // = ceil(hp / hpPerMember), recomputed by sim; drives rendering
  order: SquadOrder;
  target: number | null; // entity id being attacked
  dest: Vec | null; // final destination of a move/retreat
  path: Vec[]; // remaining waypoints (tile centers in milli-tiles)
  cooldown: number; // ticks until next attack
  lastCombatTick: number; // last tick it dealt or took damage
  facing: number; // 0..7 octant, only for rendering
  /**
   * Sim-internal leash anchor: set when an idle squad auto-acquires (or
   * retaliates); it walks back here when the chase leads too far. null for
   * explicit orders. Optional only so hand-built states stay valid.
   */
  guard?: Vec | null;
}

export interface QueueItem {
  item: UnitKind | TechId;
  ticksLeft: number;
  totalTicks: number;
}

export interface Building {
  id: number;
  owner: PlayerId;
  kind: BuildingKind;
  slot: number; // -1 for town center
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  buildTicksLeft: number; // > 0 while under construction (not functional)
  queue: QueueItem[]; // max 5
  rally: Vec | null;
  cooldown: number;
  target: number | null;
}

export interface CapturePoint {
  id: number;
  kind: PointKind;
  name: string;
  x: number;
  y: number;
  owner: Owner;
  /** Capture progress 0..CAPTURE_MAX for `capturer`. Owner changes when it hits max. */
  progress: number;
  capturer: Owner;
  level: 1 | 2;
}

export interface PlayerStats {
  squadsTrained: number;
  squadsLost: number;
  squadsKilled: number;
  pointsCaptured: number;
  resourcesGathered: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string; // css color, rendering only
  isBot: boolean;
  res: Resources;
  age: Age;
  vp: number; // victory points, starts at VP_START
  techs: TechId[];
  pop: number; // current pop used (incl. queued units)
  popCap: number;
  surrendered: boolean;
  stats: PlayerStats;
}

export type GameEvent =
  | { t: 'hit'; from: number; to: number; dmg: number; ranged: boolean }
  | { t: 'death'; id: number; owner: PlayerId; kind: UnitKind | BuildingKind; x: number; y: number }
  | { t: 'captured'; point: number; owner: Owner; prevOwner: Owner }
  | { t: 'built'; building: number; owner: PlayerId }
  | { t: 'trained'; squad: number; owner: PlayerId }
  | { t: 'researched'; owner: PlayerId; tech: TechId }
  | { t: 'ageUp'; owner: PlayerId; age: Age }
  | { t: 'rejected'; owner: PlayerId; reason: string } // invalid/unaffordable command
  | { t: 'underAttack'; owner: PlayerId; x: number; y: number }
  | { t: 'gameOver'; winner: Owner; reason: WinReason };

export type WinReason = 'towncenter' | 'vp' | 'timeout' | 'surrender';

export interface GameConfig {
  seed: number;
  mapId: string;
  players: { name: string; color: string; isBot: boolean }[]; // exactly 2
}

export interface GameState {
  version: string; // SIM_VERSION
  config: GameConfig;
  tick: number;
  rng: number; // uint32 state of the seeded RNG
  nextId: number;
  mapW: number; // tiles
  mapH: number; // tiles
  /** Row-major tile grid, length mapW*mapH: 0 = walkable, 1 = blocked (water/rock). */
  blocked: number[];
  players: PlayerState[]; // index = PlayerId
  squads: Squad[]; // sorted by id
  buildings: Building[]; // sorted by id
  points: CapturePoint[]; // sorted by id
  /** Events emitted during the LAST step() only. Cleared at the start of each step. */
  events: GameEvent[];
  winner: Owner | null; // null = running, -1 = draw
  winReason: WinReason | null;
  /**
   * Sim-internal throttle for 'underAttack' events (last alert tick per player
   * and 8-tile area). Optional so hand-built states stay valid; sorted by key.
   */
  alerts?: AlertMark[];
}

export interface AlertMark {
  owner: PlayerId;
  /** area key = ay * 1000 + ax with ax/ay = position / 8 tiles */
  area: number;
  tick: number;
}
