/**
 * Hand-built GameState plus a crude stand-in step()/queries so the client can
 * be rendered and play-tested while the real sim is not ready. Only used when
 * the real sim throws (or with ?fixture=1). Not deterministic-grade code.
 */
import type {
  Building,
  BuildingKind,
  Command,
  GameConfig,
  GameState,
  PlayerCommand,
  PlayerId,
  Resources,
  Squad,
  UnitKind,
  Vec,
} from '../../sim/types';
import { TILE } from '../../sim/types';
import { BUILDINGS, MAPS, RULES, TECHS, UNITS } from '../../content';

const tc = (t: number) => t * TILE + 500;

function stats() {
  return { squadsTrained: 0, squadsLost: 0, squadsKilled: 0, pointsCaptured: 0, resourcesGathered: 0 };
}

export function fixtureSlotPosition(state: GameState, player: PlayerId, slot: number): Vec {
  const map = MAPS[state.config.mapId];
  const c = map.towncenters[player];
  const o = map.slotOffsets[slot];
  const dx = player === 0 ? o.x : -o.x;
  return { x: tc(c.x + dx), y: tc(c.y + o.y) };
}

function makeSquad(state: GameState, owner: PlayerId, kind: UnitKind, x: number, y: number, hpPct = 100): Squad {
  const d = UNITS[kind];
  const maxHp = d.members * d.hpPerMember;
  const hp = Math.max(1, Math.trunc((maxHp * hpPct) / 100));
  const s: Squad = {
    id: state.nextId++,
    owner,
    kind,
    x,
    y,
    hp,
    maxHp,
    members: Math.ceil(hp / d.hpPerMember),
    order: 'idle',
    target: null,
    dest: null,
    path: [],
    cooldown: 0,
    lastCombatTick: -1000,
    facing: owner === 0 ? 0 : 4,
  };
  state.squads.push(s);
  return s;
}

function makeBuilding(state: GameState, owner: PlayerId, kind: BuildingKind, slot: number, progressPct = 100): Building {
  const d = BUILDINGS[kind];
  const pos = slot < 0 ? null : fixtureSlotPosition(state, owner, slot);
  const map = MAPS[state.config.mapId];
  const b: Building = {
    id: state.nextId++,
    owner,
    kind,
    slot,
    x: pos ? pos.x : tc(map.towncenters[owner].x),
    y: pos ? pos.y : tc(map.towncenters[owner].y),
    hp: progressPct >= 100 ? d.hp : Math.max(1, Math.trunc((d.hp * (10 + (90 * progressPct) / 100)) / 100)),
    maxHp: d.hp,
    buildTicksLeft: progressPct >= 100 ? 0 : Math.trunc((d.buildTicks * (100 - progressPct)) / 100),
    queue: [],
    rally: null,
    cooldown: 0,
    target: null,
  };
  state.buildings.push(b);
  return b;
}

/** Fresh start state (like createGame) or, with `demo`, a mid-game scene with lots on screen. */
export function createFixture(config: GameConfig, demo = true): GameState {
  const map = MAPS[config.mapId] ?? MAPS['chrizu-tal'];
  const blocked = new Array(map.w * map.h).fill(0);
  for (const [x, y, w, h] of map.blocked) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) blocked[j * map.w + i] = 1;
  }
  const state: GameState = {
    version: 'fixture',
    config: { ...config, mapId: map.id },
    tick: demo ? 20 * 200 : 0,
    rng: 1,
    nextId: 1,
    mapW: map.w,
    mapH: map.h,
    blocked,
    players: config.players.map((p, i) => ({
      id: i as PlayerId,
      name: p.name,
      color: p.color,
      isBot: p.isBot,
      res: { ...RULES.startRes },
      age: 1,
      vp: RULES.vpStart,
      techs: [],
      pop: 2,
      popCap: RULES.popCap,
      surrendered: false,
      stats: stats(),
    })),
    squads: [],
    buildings: [],
    points: [],
    events: [],
    winner: null,
    winReason: null,
  };
  for (const pl of [0, 1] as PlayerId[]) makeBuilding(state, pl, 'towncenter', -1);
  map.points.forEach((p, i) => {
    state.points.push({
      id: state.nextId++,
      kind: p.kind,
      name: p.name,
      x: tc(p.x),
      y: tc(p.y),
      owner: -1,
      progress: 0,
      capturer: -1,
      level: 1,
    });
    void i;
  });
  for (const pl of [0, 1] as PlayerId[]) {
    const c = map.towncenters[pl];
    for (const s of map.startSquads) {
      const dx = pl === 0 ? s.dx : -s.dx;
      makeSquad(state, pl, s.kind, tc(c.x + dx), tc(c.y + s.dy));
    }
  }
  if (!demo) return state;

  // ---- mid-game demo scene
  const P = state.players;
  P[0].res = { food: 412, wood: 268, gold: 145 };
  P[1].res = { food: 380, wood: 300, gold: 120 };
  P[0].vp = 864;
  P[1].vp = 742;
  P[0].age = 2;
  P[0].techs = ['age2', 'attack1'];
  makeBuilding(state, 0, 'barracks', 0);
  makeBuilding(state, 0, 'range', 2, 55);
  makeBuilding(state, 0, 'blacksmith', 5);
  makeBuilding(state, 0, 'tower', 4);
  makeBuilding(state, 1, 'stable', 3);
  makeBuilding(state, 1, 'barracks', 0);
  const own = (i: number, o: -1 | 0 | 1, prog = 0, cap: -1 | 0 | 1 = -1, lvl: 1 | 2 = 1) => {
    const p = state.points[i];
    p.owner = o;
    p.progress = prog;
    p.capturer = cap;
    p.level = lvl;
  };
  own(0, 0, 100, 0, 2);
  own(2, 0, 100, 0);
  own(3, 0, 100, 0);
  own(1, 0, 100, 0);
  own(6, -1, 60, 0); // Chrizu being captured by blue
  own(8, 1, 100, 1);
  own(10, 1, 100, 1);
  own(11, 1, 100, 1);
  own(5, 1, 40, 1);
  const T = (x: number, y: number) => ({ x: tc(x), y: tc(y) });
  const add = (o: PlayerId, k: UnitKind, x: number, y: number, hp = 100) => {
    const p = T(x, y);
    return makeSquad(state, o, k, p.x, p.y, hp);
  };
  add(0, 'spear', 27, 17);
  add(0, 'archer', 25, 18, 70);
  add(0, 'sword', 27, 20);
  add(0, 'cavalry', 21, 7, 45);
  add(0, 'archer', 18, 25);
  add(0, 'ram', 12, 18);
  add(1, 'spear', 31, 18, 60);
  add(1, 'cavalry', 35, 14);
  add(1, 'archer', 33, 21);
  add(1, 'knight', 44, 19);
  add(1, 'scout', 28, 30);
  P[0].pop = state.squads.filter((s) => s.owner === 0).length + 1;
  P[1].pop = state.squads.filter((s) => s.owner === 1).length;
  const bar = state.buildings.find((b) => b.owner === 0 && b.kind === 'barracks')!;
  bar.queue.push({ item: 'spear', ticksLeft: 90, totalTicks: UNITS.spear.trainTicks });
  bar.rally = T(20, 18);
  return state;
}

// ---------------------------------------------------------------- queries

export function fixtureEntity(state: GameState, id: number): Squad | Building | null {
  for (const s of state.squads) if (s.id === id) return s;
  for (const b of state.buildings) if (b.id === id) return b;
  return null;
}

export function fixtureTownCenter(state: GameState, p: PlayerId): Building | null {
  return state.buildings.find((b) => b.owner === p && b.kind === 'towncenter') ?? null;
}

export function fixtureSlots(state: GameState, p: PlayerId) {
  const out: { slot: number; pos: Vec; building: Building | null }[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({
      slot: i,
      pos: fixtureSlotPosition(state, p, i),
      building: state.buildings.find((b) => b.owner === p && b.slot === i) ?? null,
    });
  }
  return out;
}

const afford = (r: Resources, c: Resources) => r.food >= c.food && r.wood >= c.wood && r.gold >= c.gold;
function missing(r: Resources, c: Resources): string | null {
  if (r.food < c.food) return 'Zu wenig Nahrung';
  if (r.wood < c.wood) return 'Zu wenig Holz';
  if (r.gold < c.gold) return 'Zu wenig Gold';
  return null;
}

export function fixtureValidate(state: GameState, player: PlayerId, cmd: Command): string | null {
  const P = state.players[player];
  switch (cmd.t) {
    case 'build': {
      const d = BUILDINGS[cmd.kind];
      if (state.buildings.some((b) => b.owner === player && b.slot === cmd.slot)) return 'Bauplatz belegt';
      if (P.age < d.age) return 'Benötigt Burgzeitalter';
      if (state.buildings.filter((b) => b.owner === player && b.kind === cmd.kind).length >= d.maxPerPlayer)
        return `Maximal ${d.maxPerPlayer}`;
      return missing(P.res, d.cost);
    }
    case 'train': {
      const b = fixtureEntity(state, cmd.building) as Building | null;
      if (!b || 'members' in b) return 'Gebäude fehlt';
      if (b.buildTicksLeft > 0) return 'Im Bau';
      const u = UNITS[cmd.unit];
      if (P.age < u.age) return u.age === 2 ? 'Benötigt Burgzeitalter' : 'Benötigt Imperiumszeitalter';
      if (b.queue.length >= RULES.queueMax) return 'Warteschlange voll';
      if (P.pop + u.pop > P.popCap) return 'Bevölkerungslimit erreicht';
      return missing(P.res, u.cost);
    }
    case 'research': {
      const t = TECHS[cmd.tech];
      if (P.techs.includes(cmd.tech)) return 'Bereits erforscht';
      if (P.age < t.age) return 'Benötigt höheres Zeitalter';
      const b = fixtureEntity(state, cmd.building) as Building | null;
      if (b && b.queue.some((q) => q.item === cmd.tech)) return 'Wird bereits erforscht';
      if (t.requiresBuildings) {
        const n = state.buildings.filter((x) => x.owner === player && x.kind !== 'towncenter' && x.buildTicksLeft === 0).length;
        if (n < t.requiresBuildings) return `Benötigt ${t.requiresBuildings} Gebäude`;
      }
      return missing(P.res, t.cost);
    }
    case 'upgradePoint': {
      const p = state.points.find((q) => q.id === cmd.point);
      if (!p || p.owner !== player) return 'Nicht dein Punkt';
      if (p.level === 2) return 'Bereits ausgebaut';
      return missing(P.res, RULES.pointUpgradeCost);
    }
    default:
      return null;
  }
}

export function fixtureVisibility(state: GameState, player: PlayerId): number[] {
  const W = state.mapW;
  const H = state.mapH;
  const vis = new Array(W * H).fill(0);
  const reveal = (x: number, y: number, r: number) => {
    const cx = x / TILE;
    const cy = y / TILE;
    const rt = r / TILE;
    const x0 = Math.max(0, Math.floor(cx - rt));
    const x1 = Math.min(W - 1, Math.ceil(cx + rt));
    const y0 = Math.max(0, Math.floor(cy - rt));
    const y1 = Math.min(H - 1, Math.ceil(cy + rt));
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const dx = i + 0.5 - cx;
        const dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= rt * rt) vis[j * W + i] = 1;
      }
  };
  for (const s of state.squads) if (s.owner === player) reveal(s.x, s.y, UNITS[s.kind].sight);
  for (const b of state.buildings) if (b.owner === player) reveal(b.x, b.y, BUILDINGS[b.kind].sight);
  for (const p of state.points) if (p.owner === player) reveal(p.x, p.y, 4000);
  return vis;
}

// ---------------------------------------------------------------- crude step

export function fixtureStep(state: GameState, commands: PlayerCommand[]): void {
  if (state.winner !== null) return;
  state.events = [];
  const ev = state.events;
  for (const pc of commands) {
    const reason = fixtureValidate(state, pc.player, pc.cmd);
    if (reason) {
      ev.push({ t: 'rejected', owner: pc.player, reason });
      continue;
    }
    exec(state, pc.player, pc.cmd);
  }
  // production
  for (const b of state.buildings) {
    if (b.buildTicksLeft > 0) {
      b.buildTicksLeft--;
      b.hp = Math.min(b.maxHp, b.hp + Math.ceil((b.maxHp * 0.9) / Math.max(1, BUILDINGS[b.kind].buildTicks)));
      if (b.buildTicksLeft === 0) {
        b.hp = b.maxHp;
        ev.push({ t: 'built', building: b.id, owner: b.owner });
      }
      continue;
    }
    const q = b.queue[0];
    if (q && --q.ticksLeft <= 0) {
      b.queue.shift();
      if (q.item in UNITS) {
        const s = makeSquad(state, b.owner, q.item as UnitKind, b.x + (b.owner === 0 ? 1800 : -1800), b.y + 600);
        state.players[b.owner].stats.squadsTrained++;
        ev.push({ t: 'trained', squad: s.id, owner: b.owner });
        if (b.rally) {
          s.order = 'move';
          s.dest = { ...b.rally };
        }
      } else {
        const P = state.players[b.owner];
        P.techs.push(q.item as never);
        ev.push({ t: 'researched', owner: b.owner, tech: q.item as never });
        if (q.item === 'age2' || q.item === 'age3') {
          P.age = q.item === 'age2' ? 2 : 3;
          ev.push({ t: 'ageUp', owner: b.owner, age: P.age });
        }
      }
    }
  }
  // movement + combat
  for (const s of state.squads) {
    const d = UNITS[s.kind];
    if (s.cooldown > 0) s.cooldown--;
    let goal: Vec | null = s.dest;
    if (s.order === 'attack' && s.target !== null) {
      const t = fixtureEntity(state, s.target);
      if (!t) {
        s.order = 'idle';
        s.target = null;
        continue;
      }
      const dist = Math.hypot(t.x - s.x, t.y - s.y);
      const tr = 'members' in t ? RULES.squadRadius : t.kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius;
      if (dist - RULES.squadRadius - tr <= d.range) {
        goal = null;
        s.facing = octant(t.x - s.x, t.y - s.y);
        if (s.cooldown === 0) {
          s.cooldown = d.cooldownTicks;
          const dmg = Math.max(1, s.members * d.dmgPerMember * 3);
          t.hp -= dmg;
          s.lastCombatTick = state.tick;
          ev.push({ t: 'hit', from: s.id, to: t.id, dmg, ranged: d.ranged });
          if (t.owner === 0 && state.tick % 200 < 30) ev.push({ t: 'underAttack', owner: 0, x: t.x, y: t.y });
        }
      } else goal = { x: t.x, y: t.y };
    }
    if (goal) {
      const dx = goal.x - s.x;
      const dy = goal.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= d.speed) {
        s.x = goal.x;
        s.y = goal.y;
        if (s.order !== 'attack') {
          s.order = 'idle';
          s.dest = null;
        }
      } else {
        s.x += Math.trunc((dx / dist) * d.speed);
        s.y += Math.trunc((dy / dist) * d.speed);
        s.facing = octant(dx, dy);
      }
    }
  }
  // deaths
  for (const s of state.squads) s.members = Math.max(0, Math.ceil(s.hp / UNITS[s.kind].hpPerMember));
  for (const arr of [state.squads, state.buildings] as (Squad | Building)[][]) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (e.hp <= 0) {
        arr.splice(i, 1);
        ev.push({ t: 'death', id: e.id, owner: e.owner, kind: e.kind, x: e.x, y: e.y });
        if ('members' in e) state.players[e.owner].pop--;
        if (e.kind === 'towncenter') {
          state.winner = (1 - e.owner) as PlayerId;
          state.winReason = 'towncenter';
          ev.push({ t: 'gameOver', winner: state.winner, reason: 'towncenter' });
        }
      }
    }
  }
  // income + capture (simple)
  if (state.tick % 20 === 0) {
    for (const P of state.players) {
      let f = 2,
        w = 2,
        g = 1;
      for (const p of state.points)
        if (p.owner === P.id) {
          const m = p.level === 2 ? 1.5 : 1;
          if (p.kind === 'village') f += Math.trunc(4 * m);
          if (p.kind === 'forest') w += Math.trunc(4 * m);
          if (p.kind === 'mine') g += Math.trunc(3 * m);
        }
      P.res.food += f;
      P.res.wood += w;
      P.res.gold += g;
    }
    for (const p of state.points) {
      const near = [0, 0];
      for (const s of state.squads)
        if (s.kind !== 'ram' && Math.hypot(s.x - p.x, s.y - p.y) <= RULES.captureRadius) near[s.owner]++;
      if (near[0] && near[1]) continue;
      const who = near[0] ? 0 : near[1] ? 1 : -1;
      if (who < 0 || p.owner === who) continue;
      const rate = RULES.captureRatePerSquad * Math.min(3, near[who]) * 3;
      if (p.owner !== -1) {
        p.progress -= rate;
        if (p.progress <= 0) {
          const prev = p.owner;
          p.owner = -1;
          p.progress = 0;
          p.level = 1;
          ev.push({ t: 'captured', point: p.id, owner: -1, prevOwner: prev });
        }
      } else {
        if (p.capturer !== who) {
          p.capturer = who as PlayerId;
          p.progress = 0;
        }
        p.progress += rate;
        if (p.progress >= RULES.captureMax) {
          p.progress = RULES.captureMax;
          p.owner = who as PlayerId;
          ev.push({ t: 'captured', point: p.id, owner: p.owner, prevOwner: -1 });
        }
      }
    }
    const own = [0, 0];
    for (const p of state.points) if (p.owner >= 0) own[p.owner]++;
    if (own[0] !== own[1]) state.players[own[0] < own[1] ? 0 : 1].vp -= Math.abs(own[0] - own[1]);
  }
  state.tick++;
}

function octant(dx: number, dy: number): number {
  const a = Math.atan2(dy, dx);
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}

function exec(state: GameState, player: PlayerId, cmd: Command): void {
  const P = state.players[player];
  const mine = (ids: number[]) => state.squads.filter((s) => s.owner === player && ids.includes(s.id));
  switch (cmd.t) {
    case 'move': {
      const list = mine(cmd.squads);
      list.forEach((s, i) => {
        const a = (i / Math.max(1, list.length)) * Math.PI * 2;
        const r = list.length > 1 ? 1200 : 0;
        s.order = 'move';
        s.target = null;
        s.dest = { x: cmd.x + Math.trunc(Math.cos(a) * r), y: cmd.y + Math.trunc(Math.sin(a) * r) };
      });
      break;
    }
    case 'attack':
      for (const s of mine(cmd.squads)) {
        s.order = 'attack';
        s.target = cmd.target;
        s.dest = null;
      }
      break;
    case 'stop':
      for (const s of mine(cmd.squads)) {
        s.order = 'idle';
        s.target = null;
        s.dest = null;
      }
      break;
    case 'retreat': {
      const t = fixtureTownCenter(state, player);
      if (t)
        for (const s of mine(cmd.squads)) {
          s.order = 'retreat';
          s.target = null;
          s.dest = { x: t.x + 2000 * (player === 0 ? 1 : -1), y: t.y };
        }
      break;
    }
    case 'build': {
      const d = BUILDINGS[cmd.kind];
      sub(P.res, d.cost);
      makeBuilding(state, player, cmd.kind, cmd.slot, 0);
      break;
    }
    case 'train': {
      const b = fixtureEntity(state, cmd.building) as Building;
      const u = UNITS[cmd.unit];
      sub(P.res, u.cost);
      P.pop += u.pop;
      b.queue.push({ item: cmd.unit, ticksLeft: u.trainTicks, totalTicks: u.trainTicks });
      break;
    }
    case 'research': {
      const b = fixtureEntity(state, cmd.building) as Building;
      const t = TECHS[cmd.tech];
      sub(P.res, t.cost);
      b.queue.push({ item: cmd.tech, ticksLeft: t.researchTicks, totalTicks: t.researchTicks });
      break;
    }
    case 'cancel': {
      const b = fixtureEntity(state, cmd.building) as Building;
      const q = b?.queue.pop();
      if (q) {
        const c = q.item in UNITS ? UNITS[q.item as UnitKind].cost : TECHS[q.item as keyof typeof TECHS].cost;
        P.res.food += c.food;
        P.res.wood += c.wood;
        P.res.gold += c.gold;
        if (q.item in UNITS) P.pop -= UNITS[q.item as UnitKind].pop;
      }
      break;
    }
    case 'rally': {
      const b = fixtureEntity(state, cmd.building) as Building;
      if (b) b.rally = { x: cmd.x, y: cmd.y };
      break;
    }
    case 'upgradePoint': {
      const p = state.points.find((q) => q.id === cmd.point)!;
      sub(P.res, RULES.pointUpgradeCost);
      p.level = 2;
      break;
    }
    case 'surrender':
      P.surrendered = true;
      state.winner = (1 - player) as PlayerId;
      state.winReason = 'surrender';
      state.events.push({ t: 'gameOver', winner: state.winner, reason: 'surrender' });
      break;
  }
}

function sub(r: Resources, c: Resources) {
  r.food -= c.food;
  r.wood -= c.wood;
  r.gold -= c.gold;
}

export { afford as fixtureCanAfford };
