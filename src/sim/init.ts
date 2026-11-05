/** Initial state construction. */
import { BUILDINGS, MAPS, RULES, UNITS } from '../content';
import type { MapDef } from '../content';
import type { Building, BuildingKind, CapturePoint, GameConfig, GameState, PlayerId, PlayerState, Squad, UnitKind, Vec } from './types';
import { TILE } from './types';
import { seedRng } from './rng';
import { nearestWalkable, tileCenter } from './pathfinding';


export function mapOf(state: GameState): MapDef {
  const m = MAPS[state.config.mapId];
  if (!m) throw new Error(`Unknown map ${state.config.mapId}`);
  return m;
}

/** Slot tile position (tile coords) for a player. Player 1 mirrors x. */
export function slotTile(map: MapDef, player: PlayerId, slot: number): { x: number; y: number } {
  const tc = map.towncenters[player];
  const off = map.slotOffsets[slot];
  return { x: player === 0 ? tc.x + off.x : tc.x - off.x, y: tc.y + off.y };
}

export function slotPos(map: MapDef, player: PlayerId, slot: number): Vec {
  const t = slotTile(map, player, slot);
  return { x: tileCenter(t.x), y: tileCenter(t.y) };
}

export function newSquad(state: GameState, owner: PlayerId, kind: UnitKind, x: number, y: number): Squad {
  const def = UNITS[kind];
  const maxHp = def.members * def.hpPerMember;
  const s: Squad = {
    id: state.nextId++,
    owner,
    kind,
    x,
    y,
    hp: maxHp,
    maxHp,
    members: def.members,
    order: 'idle',
    target: null,
    dest: null,
    path: [],
    cooldown: 0,
    lastCombatTick: -100000,
    facing: owner === 0 ? 0 : 4,
    guard: null,
  };
  state.squads.push(s); // ids are monotonic, so the array stays sorted
  return s;
}

export function newBuilding(state: GameState, owner: PlayerId, kind: BuildingKind, slot: number, x: number, y: number, complete: boolean): Building {
  const def = BUILDINGS[kind];
  const b: Building = {
    id: state.nextId++,
    owner,
    kind,
    slot,
    x,
    y,
    hp: complete || def.buildTicks === 0 ? def.hp : Math.max(1, Math.trunc(def.hp / 10)),
    maxHp: def.hp,
    buildTicksLeft: complete ? 0 : def.buildTicks,
    queue: [],
    rally: null,
    cooldown: 0,
    target: null,
  };
  state.buildings.push(b);
  return b;
}

export function createInitialState(config: GameConfig, version: string): GameState {
  if (!config.players || config.players.length !== 2) throw new Error('GameConfig needs exactly 2 players');
  const map = MAPS[config.mapId];
  if (!map) throw new Error(`Unknown map ${config.mapId}`);
  const W = map.w;
  const H = map.h;
  const blocked: number[] = new Array(W * H).fill(0);
  for (const [bx, by, bw, bh] of map.blocked) {
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        if (x >= 0 && y >= 0 && x < W && y < H) blocked[y * W + x] = 1;
      }
    }
  }
  const players: PlayerState[] = config.players.map((p, i) => ({
    id: i as PlayerId,
    name: p.name,
    color: p.color,
    isBot: p.isBot,
    res: { ...RULES.startRes },
    age: 1,
    vp: RULES.vpStart,
    techs: [],
    pop: 0,
    popCap: RULES.popCap,
    surrendered: false,
    stats: { squadsTrained: 0, squadsLost: 0, squadsKilled: 0, pointsCaptured: 0, resourcesGathered: 0 },
  }));
  const state: GameState = {
    version,
    config: JSON.parse(JSON.stringify(config)),
    tick: 0,
    rng: seedRng(config.seed >>> 0),
    nextId: 1,
    mapW: W,
    mapH: H,
    blocked,
    players,
    squads: [],
    buildings: [],
    points: [],
    events: [],
    winner: null,
    winReason: null,
    alerts: [],
  };
  // town centers
  for (const pid of [0, 1] as PlayerId[]) {
    const tc = map.towncenters[pid];
    newBuilding(state, pid, 'towncenter', -1, tileCenter(tc.x), tileCenter(tc.y), true);
  }
  // capture points
  for (const p of map.points) {
    const cp: CapturePoint = {
      id: state.nextId++,
      kind: p.kind,
      name: p.name,
      x: tileCenter(p.x),
      y: tileCenter(p.y),
      owner: -1,
      progress: 0,
      capturer: -1,
      level: 1,
    };
    state.points.push(cp);
  }
  // start squads
  for (const pid of [0, 1] as PlayerId[]) {
    const tc = map.towncenters[pid];
    for (const ss of map.startSquads) {
      const tx = pid === 0 ? tc.x + ss.dx : tc.x - ss.dx;
      const ty = tc.y + ss.dy;
      const pos = nearestWalkable(state, tx * TILE + 500, ty * TILE + 500);
      newSquad(state, pid, ss.kind, pos.x, pos.y);
      players[pid].pop += UNITS[ss.kind].pop;
    }
  }
  return state;
}
