import { describe, expect, it } from 'vitest';
import { createGame, step } from '../src/sim';
import type { BuildingKind, Command, GameState, PlayerCommand, PlayerId, UnitKind } from '../src/sim';
import { newSquad } from '../src/sim/init';

const CONFIG = {
  seed: 7,
  mapId: 'chrizu-tal',
  players: [
    { name: 'A', color: '#00f', isBot: true },
    { name: 'B', color: '#f00', isBot: true },
  ],
};

const mir = (s: GameState, x: number) => s.mapW * 1000 - x;

/** Asserts that player 1's world is the mirror image of player 0's. */
function expectMirrored(s: GameState, tolTiles = 1, hpTolPct = 2): void {
  const p0 = s.squads.filter((q) => q.owner === 0);
  const p1 = s.squads.filter((q) => q.owner === 1);
  expect(p1.length).toBe(p0.length);
  // match squads greedily by mirrored position
  const used = new Set<number>();
  for (const a of p0) {
    let best = -1;
    let bd = Infinity;
    p1.forEach((b, i) => {
      if (used.has(i) || b.kind !== a.kind) return;
      const d = Math.abs(mir(s, b.x) - a.x) + Math.abs(b.y - a.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    expect(best).toBeGreaterThanOrEqual(0);
    used.add(best);
    expect(Math.abs(mir(s, p1[best].x) - a.x)).toBeLessThanOrEqual(tolTiles * 1000);
    expect(Math.abs(p1[best].y - a.y)).toBeLessThanOrEqual(tolTiles * 1000);
  }
  const hp0 = p0.reduce((t, q) => t + q.hp, 0);
  const hp1 = p1.reduce((t, q) => t + q.hp, 0);
  expect(Math.abs(hp0 - hp1)).toBeLessThanOrEqual(Math.ceil((Math.max(hp0, hp1) * hpTolPct) / 100));
  expect(s.players[1].res).toEqual(s.players[0].res);
  expect(s.players[1].vp).toBe(s.players[0].vp);
  expect(s.players[1].stats).toEqual(s.players[0].stats);
  const owned = (p: PlayerId) => s.points.filter((q) => q.owner === p).length;
  expect(owned(1)).toBe(owned(0));
  // each owned point has a mirrored counterpart with the other owner
  for (const pt of s.points) {
    const twin = s.points.find((q) => q.x === mir(s, pt.x) && q.y === pt.y)!;
    expect(twin).toBeTruthy();
    expect(twin.owner).toBe(pt.owner === -1 ? -1 : 1 - pt.owner);
    expect(twin.progress).toBe(pt.progress);
  }
  const bl = (p: PlayerId) =>
    s.buildings
      .filter((b) => b.owner === p)
      .map((b) => `${b.kind}:${p === 1 ? mir(s, b.x) : b.x},${b.y}:${b.hp}:${b.queue.length}`)
      .sort();
  expect(bl(1)).toEqual(bl(0));
}

function sideOf(s: GameState, x: number): PlayerId | -1 {
  const mid = (s.mapW * 1000) / 2;
  return x < mid - 1000 ? 0 : x > mid + 1000 ? 1 : -1;
}

describe('side symmetry', () => {
  it('coordinator mirror script: identical economy/fight outcome after 4 min', () => {
    const s = createGame(CONFIG);
    const pending: PlayerCommand[] = [];
    const submit = (player: PlayerId, cmd: Command) => pending.push({ player, tick: s.tick + 2, cmd });
    for (let t = 0; t < 20 * 240; t++) {
      if (t === 1)
        for (const pl of [0, 1] as const) {
          const mine = s.points.find((p) => p.kind === 'mine' && sideOf(s, p.x) === pl)!;
          submit(pl, { t: 'move', squads: s.squads.filter((q) => q.owner === pl).map((q) => q.id), x: mine.x, y: mine.y });
          submit(pl, { t: 'build', slot: 4, kind: 'barracks' });
        }
      if (t > 0 && t % 400 === 0)
        for (const pl of [0, 1] as const) {
          const b = s.buildings.find((x) => x.owner === pl && x.kind === 'barracks');
          if (b) submit(pl, { t: 'train', building: b.id, unit: 'spear' });
        }
      if (t === 20 * 90)
        for (const pl of [0, 1] as const) {
          const c = s.points.find((p) => p.name === 'Chrizu')!;
          submit(pl, { t: 'move', squads: s.squads.filter((q) => q.owner === pl).map((q) => q.id), x: c.x, y: c.y });
        }
      const due = pending.filter((c) => c.tick === s.tick).sort((a, b) => a.player - b.player);
      step(s, due);
    }
    expect(s.players[0].stats.squadsTrained).toBeGreaterThan(5);
    expectMirrored(s);
  });

  it('pure battle in the center is mirrored', () => {
    const kinds: UnitKind[] = ['spear', 'archer', 'cavalry', 'sword', 'scout'];
    for (const gap of [4000, 9000]) {
      const s = createGame(CONFIG);
      s.squads = [];
      s.players[0].pop = 0;
      s.players[1].pop = 0;
      for (let i = 0; i < 10; i++) {
        const x = 28500 - gap / 2 - (i % 2) * 900;
        const y = 14500 + i * 900;
        newSquad(s, 0, kinds[i % 5], x, y);
        newSquad(s, 1, kinds[i % 5], mir(s, x), y);
      }
      let mid: GameState | null = null;
      for (let t = 0; t < 20 * 60; t++) {
        step(s, []);
        if (t === 60) mid = JSON.parse(JSON.stringify(s));
      }
      expectMirrored(mid!);
      expectMirrored(s);
    }
  });

  it('randomised mirrored script stays mirrored', () => {
    const s = createGame({ ...CONFIG, seed: 11 });
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const bk: BuildingKind[] = ['barracks', 'range', 'stable', 'tower', 'blacksmith'];
    for (let t = 0; t < 20 * 240; t++) {
      const cmds: PlayerCommand[] = [];
      if (t % 25 === 0) {
        const r = rnd(5);
        const x = 2000 + rnd(53000);
        const y = 2000 + rnd(32000);
        const slot = rnd(8);
        const kind = bk[rnd(bk.length)];
        const pick = rnd(1000);
        for (const pl of [0, 1] as const) {
          const own = s.squads.filter((q) => q.owner === pl);
          const sel = own.filter((_, i) => (pick >> i % 10) & 1).map((q) => q.id);
          let cmd: Command;
          if (r === 0) cmd = { t: 'build', slot, kind };
          else if (r === 1) {
            const b = s.buildings.filter((q) => q.owner === pl && q.kind !== 'tower' && q.kind !== 'blacksmith');
            const bb = b[pick % Math.max(1, b.length)];
            const unit: UnitKind = bb?.kind === 'barracks' ? 'spear' : bb?.kind === 'range' ? 'archer' : bb?.kind === 'stable' ? 'cavalry' : 'scout';
            cmd = { t: 'train', building: bb?.id ?? 0, unit };
          } else cmd = { t: 'move', squads: sel.length ? sel : own.map((q) => q.id), x: pl === 0 ? x : mir(s, x), y };
          cmds.push({ player: pl, tick: s.tick, cmd });
        }
        s.players[0].res.food += 40;
        s.players[1].res.food += 40;
        s.players[0].res.wood += 40;
        s.players[1].res.wood += 40;
        s.players[0].res.gold += 20;
        s.players[1].res.gold += 20;
      }
      step(s, cmds);
    }
    expect(s.players[0].stats.squadsTrained).toBeGreaterThan(3);
    expect(s.players[0].stats.squadsKilled + s.players[0].stats.pointsCaptured).toBeGreaterThan(0);
    expectMirrored(s);
  });
});
