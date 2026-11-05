/** Initial state construction. */
import { BUILDINGS, MAPS, RULES, TECHS, UNITS } from '../content';
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
    defaultRally: null,
    hireReadyTick: 0,
  }));
  const sc = config.scenario;
  // per-player scenario overrides
  for (const pl of players) {
    const sp = sc?.players?.[pl.id];
    if (!sp) continue;
    if (sp.startRes) pl.res = { food: Math.trunc(sp.startRes.food), wood: Math.trunc(sp.startRes.wood), gold: Math.trunc(sp.startRes.gold) };
    if (typeof sp.vpStart === 'number') pl.vp = Math.trunc(sp.vpStart);
    if (typeof sp.popCap === 'number') pl.popCap = Math.trunc(sp.popCap);
    if (sp.age === 2 || sp.age === 3) {
      pl.age = sp.age;
      pl.techs.push('age2');
      if (sp.age === 3) pl.techs.push('age3');
    }
    for (const t of sp.techs ?? []) {
      if (!TECHS[t]) throw new Error(`Scenario: unknown tech ${t}`);
      if (pl.techs.includes(t)) continue;
      pl.techs.push(t);
      pl.popCap += TECHS[t].popCapAdd ?? 0;
    }
  }
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
  // scenario point owners
  for (const po of sc?.pointOwners ?? []) {
    const pt = state.points.find((q) => q.name === po.name);
    if (!pt) throw new Error(`Scenario: unknown point ${po.name}`);
    pt.owner = po.owner;
    pt.capturer = po.owner;
    pt.progress = po.owner === -1 ? 0 : RULES.captureMax;
    pt.level = po.owner === -1 ? 1 : po.level ?? 1;
  }
  // start squads
  for (const pid of [0, 1] as PlayerId[]) {
    if (sc?.removeStartSquads?.includes(pid)) continue;
    const tc = map.towncenters[pid];
    for (const ss of map.startSquads) {
      const tx = pid === 0 ? tc.x + ss.dx : tc.x - ss.dx;
      const ty = tc.y + ss.dy;
      const pos = nearestWalkable(state, tx * TILE + 500, ty * TILE + 500);
      newSquad(state, pid, ss.kind, pos.x, pos.y);
      players[pid].pop += UNITS[ss.kind].pop;
    }
  }
  // scenario buildings
  for (const eb of sc?.extraBuildings ?? []) {
    const def = BUILDINGS[eb.kind];
    if (!def || eb.kind === 'towncenter') throw new Error(`Scenario: invalid building ${eb.kind}`);
    let b: Building;
    if (eb.kind === 'pointtower') {
      const pt = state.points.find((q) => q.name === eb.point);
      if (!pt) throw new Error(`Scenario: point tower needs a known point name (${eb.point})`);
      if (state.buildings.some((q) => q.point === pt.id)) throw new Error(`Scenario: point ${pt.name} already fortified`);
      b = newBuilding(state, eb.owner, 'pointtower', -2, pt.x, pt.y, eb.built);
      b.point = pt.id;
    } else {
      if (!Number.isInteger(eb.slot) || eb.slot < 0 || eb.slot >= map.slotOffsets.length) throw new Error(`Scenario: invalid slot ${eb.slot}`);
      if (state.buildings.some((q) => q.owner === eb.owner && q.slot === eb.slot)) throw new Error(`Scenario: slot ${eb.slot} used twice`);
      const pos = slotPos(map, eb.owner, eb.slot);
      b = newBuilding(state, eb.owner, eb.kind, eb.slot, pos.x, pos.y, eb.built);
    }
  }
  // scenario squads (tile coordinates)
  for (const es of sc?.extraSquads ?? []) {
    if (!UNITS[es.kind]) throw new Error(`Scenario: invalid unit ${es.kind}`);
    const pos = nearestWalkable(state, Math.trunc(es.x) * TILE + 500, Math.trunc(es.y) * TILE + 500);
    const s = newSquad(state, es.owner, es.kind, pos.x, pos.y);
    if (typeof es.hpPct === 'number' && es.hpPct < 100) {
      s.hp = Math.max(1, Math.trunc((s.maxHp * Math.max(1, Math.trunc(es.hpPct))) / 100));
      s.members = Math.ceil(s.hp / UNITS[es.kind].hpPerMember);
    }
    players[es.owner].pop += UNITS[es.kind].pop;
  }
  return state;
}
