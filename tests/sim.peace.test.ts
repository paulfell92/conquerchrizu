import { describe, expect, it } from 'vitest';
import { createGame, isPeace, peaceTicksLeft, step, townCenter, validateCommand } from '../src/sim';
import type { GameConfig, GameEvent, GameState } from '../src/sim';
import { newSquad } from '../src/sim/init';
import { RULES, UNITS } from '../src/content';

const PEACE = 20 * 60;
function cfg(extra: Partial<GameConfig> = {}): GameConfig {
  return {
    seed: 5,
    mapId: 'chrizu-tal',
    players: [
      { name: 'A', color: '#00f', isBot: false },
      { name: 'B', color: '#f00', isBot: true },
    ],
    peaceTicks: PEACE,
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

describe('peace phase', () => {
  it('no damage between adjacent armies, towers or TC during peace; fighting starts after', () => {
    const s = createGame(cfg());
    s.squads = [];
    const tc1 = townCenter(s, 1)!;
    const a = newSquad(s, 0, 'cavalry', tc1.x - 2200, tc1.y); // inside enemy TC range
    const b = newSquad(s, 1, 'spear', tc1.x - 3200, tc1.y);
    const c = newSquad(s, 0, 'archer', 28500, 18500);
    const d = newSquad(s, 1, 'archer', 29500, 18500);
    expect(isPeace(s)).toBe(true);
    expect(peaceTicksLeft(s)).toBe(PEACE);
    const ev = run(s, PEACE);
    expect(ev.some((e) => e.t === 'hit' || e.t === 'death' || e.t === 'underAttack')).toBe(false);
    for (const q of [a, b, c, d]) {
      expect(q.hp).toBe(q.maxHp);
      expect(q.order).toBe('idle');
    }
    expect(s.tick).toBe(PEACE);
    expect(isPeace(s)).toBe(false);
    expect(peaceTicksLeft(s)).toBe(0);
    const ev2 = run(s, 40);
    expect(ev2.filter((e) => e.t === 'peaceOver').length).toBe(1);
    expect(ev2.some((e) => e.t === 'hit')).toBe(true);
    expect(ev2.length).toBeGreaterThan(0);
    expect(run(s, 400).some((e) => e.t === 'peaceOver')).toBe(false);
  });

  it('peaceOver is emitted exactly once, and never without peace', () => {
    const s = createGame(cfg());
    const ev = run(s, PEACE + 100);
    expect(ev.filter((e) => e.t === 'peaceOver').length).toBe(1);
    const n = createGame(cfg({ peaceTicks: undefined }));
    expect(isPeace(n)).toBe(false);
    expect(run(n, 200).some((e) => e.t === 'peaceOver')).toBe(false);
  });

  it('attack commands on enemies are rejected with "Friedenszeit"', () => {
    const s = createGame(cfg());
    const own = s.squads.find((q) => q.owner === 0)!;
    const enemy = s.squads.find((q) => q.owner === 1)!;
    const cmd = { t: 'attack' as const, squads: [own.id], target: enemy.id };
    expect(validateCommand(s, 0, cmd)).toBe('Friedenszeit');
    expect(validateCommand(s, 0, { ...cmd, target: townCenter(s, 1)!.id })).toBe('Friedenszeit');
    step(s, [{ player: 0, tick: s.tick, cmd }]);
    expect(s.events).toContainEqual({ t: 'rejected', owner: 0, reason: 'Friedenszeit' });
    s.tick = PEACE;
    expect(validateCommand(s, 0, cmd)).toBeNull();
  });

  it('enemy points cannot be neutralised during peace, neutral ones can be captured; no VP drain', () => {
    const s = createGame(cfg());
    s.squads = [];
    const enemyPt = s.points.find((p) => p.name === 'Chrizu')!;
    enemyPt.owner = 1;
    enemyPt.capturer = 1;
    enemyPt.progress = RULES.captureMax;
    const neutral = s.points.find((p) => p.name === 'Nordmine')!;
    newSquad(s, 0, 'spear', enemyPt.x, enemyPt.y);
    newSquad(s, 0, 'spear', neutral.x, neutral.y);
    run(s, 20 * 30);
    expect(enemyPt.owner).toBe(1);
    expect(enemyPt.progress).toBe(RULES.captureMax);
    expect(neutral.owner).toBe(0);
    // p1 holds 1, p0 holds 1 -> give p0 more to create a difference
    s.points[0].owner = 0;
    s.points[1].owner = 0;
    const vp = s.players.map((p) => p.vp);
    run(s, 20 * 20);
    expect(s.players.map((p) => p.vp)).toEqual(vp);
    // after peace: neutralisation and drain resume
    run(s, PEACE - s.tick + 20 * 20);
    expect(enemyPt.owner).toBe(-1);
    expect(s.players[1].vp).toBeLessThan(vp[1]);
  });

  it('hard cap and drain doubling are shifted by the peace length', () => {
    const s = createGame(cfg());
    s.tick = RULES.hardCapTicks - 1;
    step(s, []);
    expect(s.winner).toBeNull();
    s.points[0].owner = 0;
    const vp1 = s.players[1].vp;
    run(s, 20);
    expect(s.players[1].vp).toBe(vp1 - 2); // past 18:00 + peace -> doubled
    s.tick = RULES.hardCapTicks + PEACE - 1;
    s.points[0].owner = -1;
    s.players[1].vp = s.players[0].vp;
    step(s, []);
    expect(s.winner).toBe(-1);
    expect(s.winReason).toBe('timeout');
    // before 18:00 + peace the drain is single
    const t = createGame(cfg());
    t.tick = RULES.vpDrainDoubleAfterTicks + PEACE - 40;
    t.points[0].owner = 0;
    run(t, 20);
    expect(t.players[1].vp).toBe(RULES.vpStart - 1);
  });
});

describe('incomePct handicap', () => {
  it('80 % income on TC/point payouts and bounty, truncated per payout', () => {
    const c = cfg({ peaceTicks: 0 });
    c.players[1] = { ...c.players[1], incomePct: 80 };
    const s = createGame(c);
    s.squads = [];
    s.points[0].owner = 0; // village (food 4) for p0
    s.points[s.points.length - 5].owner = 1; // mirrored village for p1
    const r0 = { ...s.players[0].res };
    const r1 = { ...s.players[1].res };
    run(s, 20 * 10);
    const g0 = s.players[0].res.food - r0.food;
    const g1 = s.players[1].res.food - r1.food;
    expect(g0).toBe(10 * (RULES.townCenterIncome.food + 4));
    expect(g1).toBe(10 * Math.trunc(((RULES.townCenterIncome.food + 4) * 80) / 100));
    expect(s.players[1].res.gold - r1.gold).toBe(10 * Math.trunc((RULES.townCenterIncome.gold * 80) / 100));
    expect(s.players[1].stats.resourcesGathered).toBe(
      (s.players[1].res.food - r1.food) + (s.players[1].res.wood - r1.wood) + (s.players[1].res.gold - r1.gold),
    );
    // bounty
    const gold = s.players[1].res.gold;
    const victim = newSquad(s, 0, 'archer', 28500, 18500);
    victim.hp = 1;
    newSquad(s, 1, 'cavalry', 29400, 18500);
    let killed = false;
    for (let i = 0; i < 100 && !killed; i++) {
      step(s, []);
      killed = s.events.some((e) => e.t === 'death' && e.id === victim.id);
      if (killed) {
        const cost = UNITS.archer.cost.food + UNITS.archer.cost.wood + UNITS.archer.cost.gold;
        const income = s.tick % 20 === 0 ? Math.trunc((RULES.townCenterIncome.gold * 80) / 100) : 0;
        expect(s.players[1].res.gold - gold - income).toBe(Math.trunc((Math.trunc((cost * 20) / 100) * 80) / 100));
      }
    }
    expect(killed).toBe(true);
  });
});
