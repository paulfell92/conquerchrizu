import { describe, expect, it } from 'vitest';
import {
  createGame,
  hashState,
  hireCooldownLeft,
  hireCost,
  pointTower,
  replay,
  step,
  townCenter,
  validateCommand,
} from '../src/sim';
import type { Command, GameConfig, GameEvent, GameState, PlayerCommand, PlayerId, Scenario } from '../src/sim';
import { newBuilding, newSquad, slotPos } from '../src/sim/init';
import { mapOf } from '../src/sim/init';
import { LocalRelay } from '../src/net/localRelay';
import { BUILDINGS, RULES, TECHS, UNITS } from '../src/content';

function cfg(extra: Partial<GameConfig> = {}): GameConfig {
  return {
    seed: 9,
    mapId: 'chrizu-tal',
    players: [
      { name: 'A', color: '#00f', isBot: false },
      { name: 'B', color: '#f00', isBot: true },
    ],
    ...extra,
  };
}
function run(s: GameState, n: number): GameEvent[] {
  const ev: GameEvent[] = [];
  for (let i = 0; i < n && s.winner === null; i++) {
    step(s, []);
    ev.push(...s.events);
  }
  return ev;
}
function exec(s: GameState, player: PlayerId, cmd: Command): GameEvent[] {
  step(s, [{ player, tick: s.tick, cmd }]);
  return s.events;
}
function rich(s: GameState, p: PlayerId = 0): void {
  s.players[p].res = { food: 5000, wood: 5000, gold: 5000 };
}
function completeBuilding(s: GameState, owner: PlayerId, kind: 'barracks' | 'range' | 'stable' | 'blacksmith', slot: number) {
  const pos = slotPos(mapOf(s), owner, slot);
  return newBuilding(s, owner, kind, slot, pos.x, pos.y, true);
}

describe('rallyAll', () => {
  it('sets defaultRally and the rally of all training buildings; later buildings inherit it', () => {
    const s = createGame(cfg());
    const bar = completeBuilding(s, 0, 'barracks', 3);
    const smith = completeBuilding(s, 0, 'blacksmith', 5);
    exec(s, 0, { t: 'rallyAll', x: 15500, y: 18500 });
    expect(s.players[0].defaultRally).toEqual({ x: 15500, y: 18500 });
    expect(bar.rally).toEqual({ x: 15500, y: 18500 });
    expect(townCenter(s, 0)!.rally).toEqual({ x: 15500, y: 18500 });
    expect(smith.rally).toBeNull(); // does not train
    expect(townCenter(s, 1)!.rally).toBeNull();
    rich(s);
    exec(s, 0, { t: 'build', slot: 4, kind: 'range' });
    const rng = s.buildings.find((b) => b.kind === 'range')!;
    expect(rng.rally).toBeNull();
    run(s, BUILDINGS.range.buildTicks);
    expect(rng.buildTicksLeft).toBe(0);
    expect(rng.rally).toEqual({ x: 15500, y: 18500 });
    expect(validateCommand(s, 0, { t: 'rallyAll', x: -1, y: 5 })).toBe('Ziel außerhalb der Karte');
  });
});

describe('point level 3', () => {
  it('level 2 -> 3 needs age 2 and wood 300 / gold 150, gives 200 % income; capture resets the level', () => {
    const s = createGame(cfg());
    s.squads = [];
    const pt = s.points.find((p) => p.name === 'Nordhof')!; // village, 4 food
    pt.owner = 0;
    pt.capturer = 0;
    pt.progress = RULES.captureMax;
    rich(s);
    exec(s, 0, { t: 'upgradePoint', point: pt.id });
    expect(pt.level).toBe(2);
    expect(validateCommand(s, 0, { t: 'upgradePoint', point: pt.id })).toBe('Benötigt Burgzeitalter');
    s.players[0].age = 2;
    s.players[0].res = { food: 0, wood: 299, gold: 150 };
    expect(validateCommand(s, 0, { t: 'upgradePoint', point: pt.id })).toBe('Zu wenig Holz');
    s.players[0].res = { food: 0, wood: 300, gold: 150 };
    exec(s, 0, { t: 'upgradePoint', point: pt.id });
    expect(pt.level).toBe(3);
    expect(s.players[0].res).toEqual({ food: 0, wood: 0, gold: 0 });
    expect(validateCommand(s, 0, { t: 'upgradePoint', point: pt.id })).toBe('Bereits voll ausgebaut');
    while (s.tick % 20 !== 0) step(s, []);
    const f = s.players[0].res.food;
    run(s, 20);
    expect(s.players[0].res.food - f).toBe(RULES.townCenterIncome.food + 8);
    // enemy neutralises it -> level 1
    for (let i = 0; i < 3; i++) newSquad(s, 1, 'spear', pt.x - 600 + i * 600, pt.y);
    const ev = run(s, 20 * 20);
    expect(ev.some((e) => e.t === 'captured' && e.point === pt.id)).toBe(true);
    expect(pt.level).toBe(1);
  });
});

describe('fortifyPoint / point tower', () => {
  it('validation, construction, protection, shooting and destruction', () => {
    const s = createGame(cfg());
    s.squads = [];
    const pt = s.points.find((p) => p.name === 'Chrizu')!;
    pt.owner = 0;
    pt.capturer = 0;
    pt.progress = RULES.captureMax;
    const other = s.points.find((p) => p.name === 'Nordmine')!;
    rich(s);
    expect(validateCommand(s, 0, { t: 'fortifyPoint', point: other.id })).toBe('Punkt gehört dir nicht');
    expect(validateCommand(s, 0, { t: 'fortifyPoint', point: pt.id })).toBe('Benötigt Burgzeitalter');
    expect(validateCommand(s, 0, { t: 'build', slot: 0, kind: 'pointtower' })).toBe('Wachtürme werden auf Punkten gebaut');
    s.players[0].age = 2;
    exec(s, 0, { t: 'fortifyPoint', point: pt.id });
    const tw = pointTower(s, pt.id)!;
    expect(tw).toBeTruthy();
    expect(tw.kind).toBe('pointtower');
    expect(tw.slot).toBe(-2);
    expect(tw.point).toBe(pt.id);
    expect([tw.x, tw.y]).toEqual([pt.x, pt.y]);
    expect(s.players[0].res).toEqual({ food: 5000, wood: 4850, gold: 4950 });
    expect(validateCommand(s, 0, { t: 'fortifyPoint', point: pt.id })).toBe('Punkt ist bereits befestigt');
    // not counted for age requirements
    expect(validateCommand(s, 0, { t: 'research', building: townCenter(s, 0)!.id, tech: 'age3' })).toBe('Benötigt 3 fertige Gebäude');
    run(s, BUILDINGS.pointtower.buildTicks);
    expect(tw.buildTicksLeft).toBe(0);
    expect(tw.hp).toBe(1000);

    // a ram (does not count for capture) is irrelevant; use spears: point must hold while the tower stands
    const enemies = [0, 1, 2].map((i) => newSquad(s, 1, 'spear', pt.x + 1200, pt.y - 1200 + i * 1200));
    tw.hp = tw.maxHp = 1_000_000; // keep the tower alive while the spears hit it
    const ev = run(s, 20 * 20);
    expect(enemies.some((e) => e.hp < e.maxHp)).toBe(true); // tower shot them
    expect(ev.some((e) => e.t === 'hit' && e.from === tw.id)).toBe(true); // tower shoots
    expect(pt.owner).toBe(0);
    expect(pt.progress).toBe(RULES.captureMax);
    // destroy the tower -> neutralisation possible
    tw.hp = 1;
    const fresh = [0, 1, 2].map((i) => newSquad(s, 1, 'spear', pt.x + 1000, pt.y - 1000 + i * 1000));
    const ev2 = run(s, 20 * 25);
    expect(fresh.length).toBe(3);
    expect(ev2.some((e) => e.t === 'death' && e.id === tw.id)).toBe(true);
    expect(pointTower(s, pt.id)).toBeNull();
    expect(ev2.some((e) => e.t === 'captured' && e.point === pt.id && e.owner === -1)).toBe(true);
  });

  it('max 4 per player; an unfinished tower is lost with its point; no shooting during peace', () => {
    const s = createGame(cfg({ peaceTicks: 20 * 60 }));
    s.squads = [];
    s.players[0].age = 2;
    rich(s);
    const mine = s.points.filter((p) => p.x < 28000).slice(0, 5);
    for (const p of mine) {
      p.owner = 0;
      p.capturer = 0;
      p.progress = RULES.captureMax;
    }
    for (let i = 0; i < 4; i++) exec(s, 0, { t: 'fortifyPoint', point: mine[i].id });
    expect(validateCommand(s, 0, { t: 'fortifyPoint', point: mine[4].id })).toBe('Maximal 4× Wachturm');
    const tw = pointTower(s, mine[0].id)!;
    run(s, BUILDINGS.pointtower.buildTicks);
    newSquad(s, 1, 'spear', mine[0].x + 1500, mine[0].y);
    expect(run(s, 100).some((e) => e.t === 'hit')).toBe(false);
    // unfinished tower on a lost point
    const s2 = createGame(cfg());
    s2.squads = [];
    s2.players[0].age = 2;
    rich(s2);
    const p2 = s2.points.find((p) => p.name === 'Chrizu')!;
    p2.owner = 0;
    p2.capturer = 0;
    p2.progress = 10;
    exec(s2, 0, { t: 'fortifyPoint', point: p2.id });
    const t2 = pointTower(s2, p2.id)!;
    for (let i = 0; i < 3; i++) {
      newSquad(s2, 1, 'spear', p2.x - 600 + i * 600, p2.y + 900);
    }
    const ev = run(s2, 60);
    expect(p2.owner).toBe(-1);
    expect(ev.some((e) => e.t === 'death' && e.id === t2.id)).toBe(true);
    expect(tw).toBeTruthy();
  });
});

describe('new techs', () => {
  it('housing1/housing2 raise the pop cap, armor2 reduces damage taken', () => {
    const s = createGame(cfg());
    const tc = townCenter(s, 0)!;
    rich(s);
    expect(validateCommand(s, 0, { t: 'research', building: tc.id, tech: 'housing1' })).toBe('Benötigt Burgzeitalter');
    s.players[0].age = 2;
    exec(s, 0, { t: 'research', building: tc.id, tech: 'housing1' });
    expect(s.players[0].res.food).toBe(5000 - 200);
    expect(s.players[0].res.wood).toBe(5000 - 200);
    const ev = run(s, TECHS.housing1.researchTicks);
    expect(ev).toContainEqual({ t: 'researched', owner: 0, tech: 'housing1' });
    expect(s.players[0].popCap).toBe(RULES.popCap + 3);
    expect(validateCommand(s, 0, { t: 'research', building: tc.id, tech: 'housing2' })).toBe('Benötigt Imperiumszeitalter');
    s.players[0].age = 3;
    exec(s, 0, { t: 'research', building: tc.id, tech: 'housing2' });
    run(s, TECHS.housing2.researchTicks);
    expect(s.players[0].popCap).toBe(RULES.popCap + 6);

    const smith = completeBuilding(s, 0, 'blacksmith', 2);
    exec(s, 0, { t: 'research', building: smith.id, tech: 'armor2' });
    expect(TECHS.armor2.name).toBe('Plattenpanzer');
    run(s, TECHS.armor2.researchTicks);
    expect(s.players[0].techs).toContain('armor2');
    // damage taken: compare an attack on a p0 squad with and without armor techs
    const t = createGame(cfg());
    t.squads = [];
    const a = newSquad(t, 1, 'sword', 28000, 18500);
    const v = newSquad(t, 0, 'spear', 28900, 18500);
    v.hp = v.maxHp = 100000;
    const hit = (st: GameState) => {
      const evs = run(st, 40);
      return (evs.find((e) => e.t === 'hit' && e.from === a.id) as { dmg: number }).dmg;
    };
    const base = hit(JSON.parse(JSON.stringify(t)));
    const armored = JSON.parse(JSON.stringify(t)) as GameState;
    armored.players[0].techs = ['armor1', 'armor2'];
    const withArmor = hit(armored);
    expect(withArmor).toBe(Math.max(1, Math.trunc((base * 70) / 100)));
  });
});

describe('hire (Söldner)', () => {
  it('age 2, gold-only price, instant spawn, pop, cooldown', () => {
    const s = createGame(cfg());
    rich(s);
    expect(validateCommand(s, 0, { t: 'hire', unit: 'spear' })).toBe('Benötigt Burgzeitalter');
    s.players[0].age = 2;
    expect(validateCommand(s, 0, { t: 'hire', unit: 'knight' })).toBe('Benötigt Imperiumszeitalter');
    const price = hireCost('cavalry');
    expect(price).toEqual({ food: 0, wood: 0, gold: Math.trunc(((80 + 0 + 40) * 150) / 100) });
    s.players[0].res = { food: 0, wood: 0, gold: price.gold - 1 };
    expect(validateCommand(s, 0, { t: 'hire', unit: 'cavalry' })).toBe('Zu wenig Gold');
    s.players[0].res = { food: 10, wood: 10, gold: price.gold };
    const before = s.squads.length;
    const pop = s.players[0].pop;
    const ev = exec(s, 0, { t: 'hire', unit: 'cavalry' });
    const tr = ev.find((e) => e.t === 'trained') as { squad: number };
    expect(tr).toBeTruthy();
    expect(s.squads.length).toBe(before + 1);
    expect(s.players[0].res).toEqual({ food: 10, wood: 10, gold: 0 });
    expect(s.players[0].pop).toBe(pop + 1);
    const sq = s.squads.find((q) => q.id === tr.squad)!;
    expect(sq.kind).toBe('cavalry');
    const tc = townCenter(s, 0)!;
    expect(Math.abs(sq.x - tc.x) + Math.abs(sq.y - tc.y)).toBeLessThan(5000);
    expect(hireCooldownLeft(s, 0)).toBe(RULES.hireCooldownTicks - 1);
    rich(s);
    expect(validateCommand(s, 0, { t: 'hire', unit: 'spear' })).toBe('Söldner erst wieder in 0:45');
    run(s, 13 * 20);
    expect(validateCommand(s, 0, { t: 'hire', unit: 'spear' })).toBe('Söldner erst wieder in 0:32');
    run(s, 32 * 20);
    expect(hireCooldownLeft(s, 0)).toBe(0);
    s.players[0].pop = s.players[0].popCap;
    expect(validateCommand(s, 0, { t: 'hire', unit: 'spear' })).toBe('Bevölkerungslimit erreicht');
    s.players[0].pop = 3;
    // spawn heads to the default rally
    exec(s, 0, { t: 'rallyAll', x: 15500, y: 10500 });
    const ev2 = exec(s, 0, { t: 'hire', unit: 'spear' });
    const sq2 = s.squads.find((q) => q.id === (ev2.find((e) => e.t === 'trained') as { squad: number }).squad)!;
    expect(sq2.order).toBe('move');
  });

  it('hire is mirror-symmetric', () => {
    const s = createGame(cfg());
    for (const p of [0, 1] as PlayerId[]) {
      rich(s, p);
      s.players[p].age = 2;
    }
    step(s, [
      { player: 0, tick: 0, cmd: { t: 'hire', unit: 'archer' } },
      { player: 1, tick: 0, cmd: { t: 'hire', unit: 'archer' } },
    ]);
    const a = s.squads.filter((q) => q.kind === 'archer');
    expect(a.length).toBe(2);
    expect(s.mapW * 1000 - a[1].x).toBe(a[0].x);
    expect(a[1].y).toBe(a[0].y);
  });
});

describe('scenario', () => {
  const scenario: Scenario = {
    players: [
      { startRes: { food: 50, wood: 60, gold: 70 }, age: 2, vpStart: 400, techs: ['housing1'] },
      { vpStart: 2000, popCap: 20 },
    ],
    extraSquads: [
      { owner: 0, kind: 'sword', x: 10, y: 18, hpPct: 50 },
      { owner: 1, kind: 'archer', x: 45, y: 10 },
    ],
    extraBuildings: [
      { owner: 0, kind: 'barracks', slot: 1, built: true },
      { owner: 1, kind: 'tower', slot: 3, built: false },
      { owner: 1, kind: 'pointtower', slot: 0, built: true, point: 'Felsmine' },
    ],
    pointOwners: [
      { name: 'Hausmine', owner: 0, level: 2 },
      { name: 'Felsmine', owner: 1 },
    ],
    removeStartSquads: [1],
  };

  it('applies per-player setup, extra squads/buildings, point owners and removed start squads', () => {
    const s = createGame(cfg({ scenario }));
    const p0 = s.players[0];
    const p1 = s.players[1];
    expect(p0.res).toEqual({ food: 50, wood: 60, gold: 70 });
    expect(p0.age).toBe(2);
    expect(p0.techs).toEqual(['age2', 'housing1']);
    expect(p0.vp).toBe(400);
    expect(p0.popCap).toBe(RULES.popCap + 3);
    expect(p1.vp).toBe(2000);
    expect(p1.popCap).toBe(20);
    expect(p1.res).toEqual(RULES.startRes);
    expect(s.squads.filter((q) => q.owner === 1).map((q) => q.kind)).toEqual(['archer']);
    const sw = s.squads.find((q) => q.kind === 'sword')!;
    expect(sw.hp).toBe(Math.trunc((sw.maxHp * 50) / 100));
    expect(sw.members).toBe(Math.ceil(sw.hp / UNITS.sword.hpPerMember));
    expect([sw.x, sw.y]).toEqual([10500, 18500]);
    expect(p0.pop).toBe(3);
    expect(p1.pop).toBe(1);
    const bar = s.buildings.find((b) => b.kind === 'barracks')!;
    expect(bar.buildTicksLeft).toBe(0);
    expect(bar.hp).toBe(bar.maxHp);
    const tower = s.buildings.find((b) => b.kind === 'tower')!;
    expect(tower.owner).toBe(1);
    expect(tower.buildTicksLeft).toBe(BUILDINGS.tower.buildTicks);
    const felsmine = s.points.find((p) => p.name === 'Felsmine')!;
    expect(felsmine).toMatchObject({ owner: 1, progress: RULES.captureMax, level: 1 });
    expect(pointTower(s, felsmine.id)!.owner).toBe(1);
    expect(s.points.find((p) => p.name === 'Hausmine')).toMatchObject({ owner: 0, level: 2 });
    expect(validateCommand(s, 0, { t: 'train', building: bar.id, unit: 'sword' })).toBe('Zu wenig Nahrung');
  });

  it('vpEnabled false: no drain, no VP loss on death; hardCapTicks override; draw at the cap', () => {
    const s = createGame(cfg({ scenario: { vpEnabled: false, hardCapTicks: 20 * 60, pointOwners: [{ name: 'Nordhof', owner: 0 }] } }));
    s.squads = [];
    const v = newSquad(s, 1, 'scout', 28500, 18500);
    v.hp = 1;
    newSquad(s, 0, 'cavalry', 29400, 18500);
    const ev = run(s, 20 * 60 + 10);
    expect(ev.some((e) => e.t === 'death' && e.id === v.id)).toBe(true);
    expect(s.players[1].vp).toBe(RULES.vpStart);
    expect(s.tick).toBe(20 * 60);
    expect(s.winner).toBe(-1);
    expect(s.winReason).toBe('timeout');
    // VP <= 0 is not a loss either
    const t = createGame(cfg({ scenario: { vpEnabled: false } }));
    t.players[0].vp = 0;
    run(t, 40);
    expect(t.winner).toBeNull();
  });

  it('objective command ends a mission game; rejected outside scenarios', () => {
    const plain = createGame(cfg());
    expect(validateCommand(plain, 0, { t: 'objective', won: true })).toBe('Nur in Missionen');
    const s = createGame(cfg({ scenario: {} }));
    const ev = exec(s, 0, { t: 'objective', won: true });
    expect(ev).toContainEqual({ t: 'gameOver', winner: 0, reason: 'objective' });
    const l = createGame(cfg({ scenario: {} }));
    exec(l, 0, { t: 'objective', won: false });
    expect(l.winner).toBe(1);
    expect(l.winReason).toBe('objective');
  });

  it('scenario state is deterministic and JSON-clean', () => {
    const a = createGame(cfg({ scenario }));
    const b = createGame(cfg({ scenario: JSON.parse(JSON.stringify(scenario)) }));
    expect(hashState(a)).toBe(hashState(b));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

describe('replay', () => {
  it('a relay log of a scripted random game replays to the identical final hash', () => {
    const config = cfg({ seed: 77, peaceTicks: 20 * 30 });
    const relay = new LocalRelay(createGame(config));
    const s = relay.state;
    let seed = 4242;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const kinds = ['barracks', 'range', 'stable', 'blacksmith', 'tower'] as const;
    const units = ['scout', 'spear', 'archer', 'cavalry', 'sword'] as const;
    const techs = ['age2', 'attack1', 'housing1', 'armor1'] as const;
    let accepted = 0;
    const hashes: number[] = [];
    while (s.winner === null && s.tick < 20 * 60 * 10) {
      for (const p of [0, 1] as PlayerId[]) {
        if (rnd(12) !== 0) continue;
        const own = s.squads.filter((q) => q.owner === p).map((q) => q.id);
        const foes = [...s.squads, ...s.buildings].filter((q) => q.owner !== p).map((q) => q.id);
        const blds = s.buildings.filter((b) => b.owner === p);
        const myPts = s.points.filter((q) => q.owner === p);
        const pick = <T,>(a: readonly T[]) => a[rnd(Math.max(1, a.length))];
        const options: Command[] = [
          { t: 'move', squads: own.filter(() => rnd(2) === 0), x: 1000 + rnd(55000), y: 1000 + rnd(34000) },
          { t: 'attack', squads: own, target: pick(foes) ?? 0 },
          { t: 'build', slot: rnd(8), kind: pick(kinds) },
          { t: 'train', building: pick(blds)?.id ?? 0, unit: pick(units) },
          { t: 'research', building: pick(blds)?.id ?? 0, tech: pick(techs) },
          { t: 'upgradePoint', point: pick(myPts)?.id ?? 0 },
          { t: 'fortifyPoint', point: pick(myPts)?.id ?? 0 },
          { t: 'hire', unit: pick(units) },
          { t: 'rallyAll', x: 1000 + rnd(55000), y: 1000 + rnd(34000) },
          { t: 'retreat', squads: own },
          { t: 'cancel', building: pick(blds)?.id ?? 0 },
        ];
        const cmd = options[rnd(options.length)];
        if (validateCommand(s, p, cmd) === null) {
          relay.submit(p, cmd);
          accepted++;
        }
      }
      relay.advance();
      if (s.tick % 1000 === 0) hashes.push(hashState(s));
    }
    if (s.winner === null) {
      relay.submit(1, { t: 'surrender' });
      relay.advance();
      relay.advance();
      relay.advance();
    }
    expect(s.winner).not.toBeNull();
    expect(accepted).toBeGreaterThan(200);
    const log: PlayerCommand[] = JSON.parse(JSON.stringify(relay.log));
    const r = replay(config, log);
    expect(r.tick).toBe(s.tick);
    expect(hashState(r)).toBe(hashState(s));
    expect(r.winner).toBe(s.winner);
    // partial replays hit the same intermediate hashes
    const mid = replay(config, log, 5000);
    expect(mid.tick).toBe(5000);
    expect(hashState(mid)).toBe(hashes[4]);
  });
});
