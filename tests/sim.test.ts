import { describe, expect, it } from 'vitest';
import {
  cloneState,
  computeVisibility,
  createGame,
  formatClock,
  hashState,
  slots,
  step,
  townCenter,
  validateCommand,
} from '../src/sim';
import type { Command, GameConfig, GameEvent, GameState, PlayerCommand, PlayerId, UnitKind } from '../src/sim';
import { newSquad } from '../src/sim/init';
import { MAPS, RULES, UNITS } from '../src/content';

const CONFIG: GameConfig = {
  seed: 42,
  mapId: 'chrizu-tal',
  players: [
    { name: 'Spieler', color: '#c33', isBot: false },
    { name: 'CPU', color: '#36c', isBot: true },
  ],
};

function run(state: GameState, ticks: number, cmds: PlayerCommand[] = []): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks && state.winner === null; i++) {
    step(state, cmds.filter((c) => c.tick === state.tick));
    events.push(...state.events);
  }
  return events;
}

function exec(state: GameState, player: PlayerId, cmd: Command): GameEvent[] {
  step(state, [{ player, tick: state.tick, cmd }]);
  return state.events;
}

/** Empty battlefield in the middle of the map: no start squads. */
function arena(): GameState {
  const g = createGame(CONFIG);
  g.squads = [];
  g.players[0].pop = 0;
  g.players[1].pop = 0;
  return g;
}

function battle(a: UnitKind, na: number, b: UnitKind, nb: number, gap: number): { a: number; b: number } {
  const g = arena();
  const cx = 28500;
  const cy = 18500;
  for (let i = 0; i < na; i++) newSquad(g, 0, a, cx - gap / 2 - 600 * (i % 2), cy - (1300 * (na - 1)) / 2 + 1300 * i);
  for (let i = 0; i < nb; i++) newSquad(g, 1, b, cx + gap / 2 + 600 * (i % 2), cy - (1300 * (nb - 1)) / 2 + 1300 * i);
  for (let t = 0; t < 20 * 120; t++) {
    step(g, []);
    if (!g.squads.some((s) => s.owner === 0) || !g.squads.some((s) => s.owner === 1)) break;
  }
  return { a: g.squads.filter((s) => s.owner === 0).length, b: g.squads.filter((s) => s.owner === 1).length };
}

const totalCost = (k: UnitKind) => UNITS[k].cost.food + UNITS[k].cost.wood + UNITS[k].cost.gold;

describe('createGame', () => {
  it('builds the initial state from content', () => {
    const g = createGame(CONFIG);
    const map = MAPS['chrizu-tal'];
    expect(g.mapW).toBe(57);
    expect(g.mapH).toBe(36);
    expect(g.blocked.length).toBe(57 * 36);
    // grid matches the blocked rectangles exactly
    const expected = new Array(57 * 36).fill(0);
    for (const [x, y, w, h] of map.blocked) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) expected[yy * 57 + xx] = 1;
    expect(g.blocked).toEqual(expected);
    const tcs = g.buildings.filter((b) => b.kind === 'towncenter');
    expect(tcs.length).toBe(2);
    expect(townCenter(g, 0)!.x).toBe(map.towncenters[0].x * 1000 + 500);
    expect(townCenter(g, 1)!.x).toBe(map.towncenters[1].x * 1000 + 500);
    expect(tcs.every((t) => t.hp === t.maxHp && t.buildTicksLeft === 0)).toBe(true);
    expect(g.points.length).toBe(13);
    expect(g.points.every((p) => p.owner === -1 && p.level === 1)).toBe(true);
    for (const pid of [0, 1] as PlayerId[]) {
      const own = g.squads.filter((s) => s.owner === pid).map((s) => s.kind).sort();
      expect(own).toEqual(['scout', 'spear']);
      expect(g.players[pid].res).toEqual(RULES.startRes);
      expect(g.players[pid].pop).toBe(2);
      expect(g.players[pid].age).toBe(1);
      expect(g.players[pid].vp).toBe(RULES.vpStart);
      expect(slots(g, pid).length).toBe(8);
    }
    // ids ascending
    const ids = [...g.buildings.map((b) => b.id), ...g.points.map((p) => p.id), ...g.squads.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
    expect(formatClock(20 * 75)).toBe('01:15');
    const vis = computeVisibility(g, 0);
    expect(vis.length).toBe(57 * 36);
    expect(vis[18 * 57 + 6]).toBe(1);
    expect(vis[18 * 57 + 50]).toBe(0);
  });
});

describe('determinism', () => {
  function script(g: GameState): PlayerCommand[] {
    const s0 = g.squads.filter((s) => s.owner === 0).map((s) => s.id);
    const s1 = g.squads.filter((s) => s.owner === 1).map((s) => s.id);
    const tc0 = townCenter(g, 0)!.id;
    const tc1 = townCenter(g, 1)!.id;
    const pts = g.points;
    return [
      { player: 0, tick: 2, cmd: { t: 'move', squads: s0, x: pts[2].x, y: pts[2].y } },
      { player: 1, tick: 2, cmd: { t: 'move', squads: s1, x: pts[10].x, y: pts[10].y } },
      { player: 0, tick: 3, cmd: { t: 'build', slot: 4, kind: 'barracks' } },
      { player: 1, tick: 3, cmd: { t: 'build', slot: 4, kind: 'barracks' } },
      { player: 0, tick: 5, cmd: { t: 'train', building: tc0, unit: 'scout' } },
      { player: 1, tick: 5, cmd: { t: 'train', building: tc1, unit: 'scout' } },
      { player: 0, tick: 6, cmd: { t: 'rally', building: tc0, x: pts[0].x, y: pts[0].y } },
      { player: 1, tick: 6, cmd: { t: 'rally', building: tc1, x: pts[8].x, y: pts[8].y } },
      { player: 0, tick: 400, cmd: { t: 'train', building: 20, unit: 'spear' } }, // ids may be wrong -> rejected is fine
      { player: 0, tick: 700, cmd: { t: 'move', squads: s0, x: pts[6].x, y: pts[6].y } },
      { player: 1, tick: 700, cmd: { t: 'move', squads: s1, x: pts[6].x, y: pts[6].y } },
      { player: 0, tick: 1600, cmd: { t: 'attack', squads: s0, target: s1[0] } },
      { player: 1, tick: 1700, cmd: { t: 'retreat', squads: s1 } },
      { player: 0, tick: 2200, cmd: { t: 'move', squads: s0, x: 52000, y: 18500 } },
      { player: 1, tick: 2500, cmd: { t: 'stop', squads: s1 } },
    ];
  }

  it('same seed + same commands -> same hashes; clone mid-game continues identically', () => {
    const a = createGame(CONFIG);
    const b = createGame(CONFIG);
    const cmds = script(a);
    expect(script(b)).toEqual(cmds);
    let mid: GameState | null = null;
    for (let t = 0; t < 3000; t++) {
      const due = cmds.filter((c) => c.tick === t);
      step(a, due);
      step(b, JSON.parse(JSON.stringify(due)));
      if (a.tick % 100 === 0) expect(hashState(a)).toBe(hashState(b));
      if (a.tick === 1500) mid = cloneState(a);
    }
    expect(a.squads.length).toBeGreaterThan(2);
    const finalHash = hashState(a);
    const c = mid!;
    expect(hashState(c)).not.toBe(finalHash);
    while (c.tick < 3000) step(c, cmds.filter((x) => x.tick === c.tick));
    expect(hashState(c)).toBe(finalHash);
    // events do not affect the hash
    const h = hashState(c);
    c.events.push({ t: 'rejected', owner: 0, reason: 'x' });
    expect(hashState(c)).toBe(h);
    // different seed still hashes differently (rng is part of the state)
    expect(hashState(createGame({ ...CONFIG, seed: 43 }))).not.toBe(hashState(createGame(CONFIG)));
  });
});

describe('combat counters (equal cost)', () => {
  // equal cost: 4 spears (90) = 360 vs 3 cavalry (120) = 360
  it('spears beat cavalry', () => {
    expect(4 * totalCost('spear')).toBe(3 * totalCost('cavalry'));
    for (const gap of [3000, 5000]) {
      const r = battle('spear', 4, 'cavalry', 3, gap);
      expect(r.b).toBe(0);
      expect(r.a).toBeGreaterThan(0);
    }
  });
  // 5 cavalry (600) vs 6 archers (600)
  it('cavalry beats archers', () => {
    expect(5 * totalCost('cavalry')).toBe(6 * totalCost('archer'));
    for (const gap of [3000, 5000]) {
      const r = battle('cavalry', 5, 'archer', 6, gap);
      expect(r.b).toBe(0);
      expect(r.a).toBeGreaterThan(0);
    }
  });
  // 1:1 at equal cost (100 vs 90 -> archers even pay more)
  it('archers beat spears', () => {
    for (const gap of [3000, 5000]) {
      for (const n of [1, 3]) {
        const r = battle('archer', n, 'spear', n, gap);
        expect(r.b).toBe(0);
        expect(r.a).toBeGreaterThan(0);
      }
    }
    // 9 archers (900) vs 10 spears (900)
    const big = battle('archer', 9, 'spear', 10, 5000);
    expect(big.b).toBe(0);
  });
  it('squads lose members with hp, bounty and VP loss on death', () => {
    const g = arena();
    const a = newSquad(g, 0, 'cavalry', 28000, 18500);
    const b = newSquad(g, 1, 'archer', 29500, 18500);
    const gold0 = g.players[0].res.gold;
    const ev = run(g, 400);
    expect(ev.some((e) => e.t === 'hit')).toBe(true);
    expect(ev.some((e) => e.t === 'death' && e.id === b.id)).toBe(true);
    expect(g.players[0].res.gold).toBeGreaterThanOrEqual(gold0 + Math.trunc((totalCost('archer') * 20) / 100));
    expect(g.players[1].vp).toBe(RULES.vpStart - RULES.vpLossPerSquadDeath);
    expect(g.players[0].stats.squadsKilled).toBe(1);
    expect(a.members).toBe(Math.ceil(a.hp / UNITS.cavalry.hpPerMember));
    expect(ev.some((e) => e.t === 'underAttack')).toBe(true);
  });
});

describe('capture & income', () => {
  it('one squad captures a neutral point in ~17 s, contested blocks, income arrives', () => {
    const g = arena();
    const pt = g.points.find((p) => p.name === 'Chrizu')!;
    newSquad(g, 0, 'spear', pt.x, pt.y);
    const ev: GameEvent[] = [];
    let capturedAt = -1;
    while (g.tick < 40 * 20) {
      step(g, []);
      ev.push(...g.events);
      if (capturedAt < 0 && g.events.some((e) => e.t === 'captured')) capturedAt = g.tick;
    }
    expect(capturedAt).toBeGreaterThanOrEqual(16 * 20);
    expect(capturedAt).toBeLessThanOrEqual(18 * 20);
    expect(pt.owner).toBe(0);
    expect(g.players[0].stats.pointsCaptured).toBe(1);
    // income: TC + village per second
    const f0 = g.players[0].res.food;
    run(g, 20);
    expect(g.players[0].res.food - f0).toBe(RULES.townCenterIncome.food + RULES.pointIncome.village.food);
    // upgrade -> 150 %
    g.players[0].res.wood = 1000;
    g.players[0].res.gold = 1000;
    exec(g, 0, { t: 'upgradePoint', point: pt.id });
    expect(pt.level).toBe(2);
    const f1 = g.players[0].res.food;
    run(g, 20);
    expect(g.players[0].res.food - f1).toBe(RULES.townCenterIncome.food + 6);

    // contested: an enemy squad on the point -> no progress
    const pt2 = g.points.find((p) => p.name === 'Nordmine')!;
    const a = newSquad(g, 0, 'scout', pt2.x - 300, pt2.y);
    const b = newSquad(g, 1, 'scout', pt2.x + 300, pt2.y);
    // keep them from fighting: give them move orders onto their own spot every tick
    for (let i = 0; i < 100; i++) {
      a.hp = a.maxHp;
      b.hp = b.maxHp;
      step(g, []);
    }
    expect(pt2.progress).toBe(0);
    expect(pt2.owner).toBe(-1);
  });

  it('enemy point must be neutralised first, then captured', () => {
    const g = arena();
    const pt = g.points.find((p) => p.name === 'Chrizu')!;
    pt.owner = 1;
    pt.capturer = 1;
    pt.progress = 100;
    pt.level = 2;
    for (let i = 0; i < 3; i++) newSquad(g, 0, 'spear', pt.x - 1000 + i * 1000, pt.y);
    const ev = run(g, 20 * 14);
    const caps = ev.filter((e) => e.t === 'captured');
    expect(caps[0]).toMatchObject({ owner: -1, prevOwner: 1 });
    expect(caps[1]).toMatchObject({ owner: 0, prevOwner: -1 });
    expect(pt.level).toBe(1);
  });
});

describe('build, train, pop, cancel', () => {
  it('build -> train -> spawn; pop cap; cancel refunds', () => {
    const g = createGame(CONFIG);
    const res0 = { ...g.players[0].res };
    exec(g, 0, { t: 'build', slot: 4, kind: 'barracks' });
    const bar = g.buildings.find((b) => b.kind === 'barracks')!;
    expect(g.players[0].res.wood).toBe(res0.wood - 120);
    expect(bar.buildTicksLeft).toBe(15 * 20 - 1);
    expect(bar.hp).toBeLessThan(bar.maxHp);
    expect(validateCommand(g, 0, { t: 'build', slot: 4, kind: 'range' })).toBe('Bauplatz belegt');
    expect(validateCommand(g, 0, { t: 'train', building: bar.id, unit: 'spear' })).toBe('Gebäude noch im Bau');
    const ev = run(g, 15 * 20);
    expect(ev.some((e) => e.t === 'built' && e.building === bar.id)).toBe(true);
    expect(bar.hp).toBe(bar.maxHp);

    const before = g.squads.length;
    exec(g, 0, { t: 'rally', building: bar.id, x: 15500, y: 18500 });
    exec(g, 0, { t: 'train', building: bar.id, unit: 'spear' });
    expect(g.players[0].pop).toBe(3);
    const ev2 = run(g, 12 * 20 + 2);
    const tr = ev2.find((e) => e.t === 'trained');
    expect(tr).toBeTruthy();
    expect(g.squads.length).toBe(before + 1);
    const sq = g.squads.find((s) => s.id === (tr as { squad: number }).squad)!;
    expect(sq.kind).toBe('spear');
    expect(sq.order).toBe('move');
    expect(g.players[0].stats.squadsTrained).toBe(1);

    // pop cap
    g.players[0].res = { food: 5000, wood: 5000, gold: 5000 };
    g.players[0].pop = RULES.popCap;
    const r = exec(g, 0, { t: 'train', building: bar.id, unit: 'spear' });
    expect(r).toContainEqual({ t: 'rejected', owner: 0, reason: 'Bevölkerungslimit erreicht' });
    g.players[0].pop = 3;

    // queue max + cancel refund
    for (let i = 0; i < 5; i++) exec(g, 0, { t: 'train', building: bar.id, unit: 'spear' });
    expect(bar.queue.length).toBe(5);
    expect(validateCommand(g, 0, { t: 'train', building: bar.id, unit: 'spear' })).toBe('Warteschlange voll');
    const resQ = { ...g.players[0].res };
    exec(g, 0, { t: 'cancel', building: bar.id });
    expect(bar.queue.length).toBe(4);
    expect(g.players[0].res.food).toBe(resQ.food + 60);
    expect(g.players[0].res.wood).toBe(resQ.wood + 30);
    expect(g.players[0].pop).toBe(3 + 4);

    // unaffordable
    g.players[0].res = { food: 0, wood: 0, gold: 0 };
    expect(validateCommand(g, 0, { t: 'build', slot: 0, kind: 'range' })).toBe('Zu wenig Holz');
    expect(validateCommand(g, 0, { t: 'train', building: townCenter(g, 0)!.id, unit: 'scout' })).toBe('Zu wenig Nahrung');
    // foreign building
    expect(validateCommand(g, 1, { t: 'train', building: bar.id, unit: 'spear' })).toBe('Gebäude ungültig');
  });
});

describe('ages', () => {
  it('age2 needs 2 buildings + cost, then sword is trainable', () => {
    const g = createGame(CONFIG);
    g.players[0].res = { food: 2000, wood: 2000, gold: 2000 };
    const tc = townCenter(g, 0)!;
    exec(g, 0, { t: 'build', slot: 3, kind: 'barracks' });
    const bar = g.buildings.find((b) => b.kind === 'barracks')!;
    run(g, 15 * 20);
    expect(validateCommand(g, 0, { t: 'research', building: tc.id, tech: 'age2' })).toBe('Benötigt 2 fertige Gebäude');
    expect(validateCommand(g, 0, { t: 'train', building: bar.id, unit: 'sword' })).toBe('Benötigt Burgzeitalter');
    expect(validateCommand(g, 0, { t: 'build', slot: 0, kind: 'workshop' })).toBe('Benötigt Burgzeitalter');
    exec(g, 0, { t: 'build', slot: 5, kind: 'range' });
    run(g, 15 * 20);
    g.players[0].res = { food: 399, wood: 0, gold: 500 };
    expect(validateCommand(g, 0, { t: 'research', building: tc.id, tech: 'age2' })).toBe('Zu wenig Nahrung');
    g.players[0].res = { food: 400, wood: 0, gold: 200 };
    exec(g, 0, { t: 'research', building: tc.id, tech: 'age2' });
    expect(g.players[0].res).toEqual({ food: 0, wood: 0, gold: 0 });
    expect(validateCommand(g, 0, { t: 'research', building: tc.id, tech: 'age2' })).toBe('Wird bereits erforscht');
    const ev = run(g, 40 * 20);
    expect(ev).toContainEqual({ t: 'ageUp', owner: 0, age: 2 });
    expect(g.players[0].age).toBe(2);
    expect(g.players[0].techs).toContain('age2');
    g.players[0].res = { food: 1000, wood: 1000, gold: 1000 };
    expect(validateCommand(g, 0, { t: 'train', building: bar.id, unit: 'sword' })).toBeNull();
    expect(validateCommand(g, 0, { t: 'research', building: tc.id, tech: 'age3' })).toBe('Benötigt 3 fertige Gebäude');
  });
});

describe('victory', () => {
  it('VP drain per point difference, doubled after 18:00', () => {
    const g = arena();
    g.points[0].owner = 0;
    g.points[1].owner = 0;
    g.points[2].owner = 1;
    run(g, 20);
    expect(g.players[1].vp).toBe(RULES.vpStart - 1);
    expect(g.players[0].vp).toBe(RULES.vpStart);
    g.tick = RULES.vpDrainDoubleAfterTicks;
    run(g, 20);
    expect(g.players[1].vp).toBe(RULES.vpStart - 3);
    g.players[1].vp = 2;
    const ev = run(g, 40);
    expect(g.winner).toBe(0);
    expect(g.winReason).toBe('vp');
    expect(ev.filter((e) => e.t === 'gameOver').length).toBe(1);
  });

  it('destroying the TC ends the game (towncenter)', () => {
    const g = arena();
    const tc1 = townCenter(g, 1)!;
    tc1.hp = 30;
    const r = newSquad(g, 0, 'cavalry', tc1.x - 2500, tc1.y);
    exec(g, 0, { t: 'attack', squads: [r.id], target: tc1.id });
    const ev = run(g, 400);
    expect(ev.some((e) => e.t === 'death' && e.id === tc1.id)).toBe(true);
    expect(g.winner).toBe(0);
    expect(g.winReason).toBe('towncenter');
    const t = g.tick;
    step(g, []);
    expect(g.tick).toBe(t); // frozen after game over
  });

  it('surrender', () => {
    const g = createGame(CONFIG);
    const ev = exec(g, 1, { t: 'surrender' });
    expect(ev).toContainEqual({ t: 'gameOver', winner: 0, reason: 'surrender' });
    expect(g.players[1].surrendered).toBe(true);
  });

  it('an idle game ends at the 25:00 hard cap as a draw', () => {
    const g = createGame(CONFIG);
    const ev = run(g, RULES.hardCapTicks + 100);
    expect(g.tick).toBe(RULES.hardCapTicks);
    expect(g.winner).toBe(-1);
    expect(g.winReason).toBe('timeout');
    expect(ev.filter((e) => e.t === 'gameOver').length).toBe(1);
    expect(g.squads.length).toBe(4);
  });
});

describe('movement', () => {
  it('group move reaches distinct formation spots without entering blocked tiles', () => {
    const g = arena();
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(newSquad(g, 0, 'scout', 9500, 15500 + i * 1000).id);
    exec(g, 0, { t: 'move', squads: ids, x: 28500, y: 7500 }); // north of the north lake
    let ok = true;
    for (let i = 0; i < 20 * 30; i++) {
      step(g, []);
      for (const s of g.squads) if (g.blocked[Math.floor(s.y / 1000) * 57 + Math.floor(s.x / 1000)]) ok = false;
    }
    expect(ok).toBe(true);
    const sq = g.squads.filter((s) => ids.includes(s.id));
    expect(sq.every((s) => s.order === 'idle')).toBe(true);
    for (const s of sq) expect(Math.abs(s.x - 28500) + Math.abs(s.y - 7500)).toBeLessThan(6000);
    for (let i = 0; i < sq.length; i++)
      for (let j = i + 1; j < sq.length; j++) expect(Math.abs(sq[i].x - sq[j].x) + Math.abs(sq[i].y - sq[j].y)).toBeGreaterThan(500);
  });

  it('rejects bad input with German reasons', () => {
    const g = createGame(CONFIG);
    const enemy = g.squads.find((s) => s.owner === 1)!;
    expect(validateCommand(g, 0, { t: 'move', squads: [enemy.id], x: 1000, y: 1000 })).toBe('Keine Trupps ausgewählt');
    expect(validateCommand(g, 0, { t: 'move', squads: [g.squads[0].id], x: -5, y: 1000 })).toBe('Ziel außerhalb der Karte');
    expect(validateCommand(g, 0, { t: 'attack', squads: [g.squads[0].id], target: g.squads[1].id })).toBe(
      'Eigene Einheiten nicht angreifbar',
    );
    const ev = exec(g, 0, { t: 'upgradePoint', point: g.points[0].id });
    expect(ev).toContainEqual({ t: 'rejected', owner: 0, reason: 'Punkt gehört dir nicht' });
  });
});

describe('performance', () => {
  it('40-squad battle averages well under 1 ms per tick', () => {
    const kinds: UnitKind[] = ['spear', 'archer', 'cavalry', 'sword', 'scout'];
    const g = createGame(CONFIG);
    for (let i = 0; i < 20; i++) {
      newSquad(g, 0, kinds[i % 5], 9500 + (i % 4) * 1200, 8500 + Math.floor(i / 4) * 4000);
      newSquad(g, 1, kinds[i % 5], 47500 - (i % 4) * 1200, 8500 + Math.floor(i / 4) * 4000);
    }
    const s0 = g.squads.filter((s) => s.owner === 0).map((s) => s.id);
    const s1 = g.squads.filter((s) => s.owner === 1).map((s) => s.id);
    const cmds: PlayerCommand[] = [
      { player: 0, tick: 0, cmd: { t: 'move', squads: s0, x: 30500, y: 18500 } },
      { player: 1, tick: 0, cmd: { t: 'move', squads: s1, x: 26500, y: 18500 } },
    ];
    const t0 = performance.now();
    run(g, 2400, cmds);
    const avg = (performance.now() - t0) / 2400;
    expect(avg).toBeLessThan(1);
  });
});
