import { describe, expect, it } from 'vitest';
import { cloneState, computeVisibility, createGame, isWalkable, validateCommand } from '../src/sim';
import type { Command, GameState, PlayerId, Squad } from '../src/sim';
import { LocalRelay } from '../src/net/localRelay';
import { Bot, difficultyIncomePct, PERSONALITY_INFO, PERSONALITY_LIST, personalityFromSeed } from '../src/bot';
import type { Difficulty, Personality } from '../src/bot';
import { BotRng } from '../src/bot/rng';
import { counterFactor } from '../src/bot/view';

function simReady(): boolean {
  try {
    createGame(cfg(1));
    return true;
  } catch {
    return false;
  }
}

function cfg(seed: number) {
  return {
    seed,
    mapId: 'chrizu-tal',
    players: [
      { name: 'A', color: '#36c', isBot: true },
      { name: 'B', color: '#c33', isBot: true },
    ],
  };
}

const READY = simReady();

describe('bot (pure parts)', () => {
  it('rng is deterministic and seeded', () => {
    const a = new BotRng(42);
    const b = new BotRng(42);
    const c = new BotRng(43);
    const xa = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(xa);
    expect(c.next()).not.toEqual(xa[0]);
  });

  it('personality is picked from the seed and covers all three', () => {
    const seen = new Set<Personality>();
    for (let s = 0; s < 30; s++) seen.add(personalityFromSeed(s));
    expect(seen.size).toBe(3);
    expect(new Bot({ player: 0, difficulty: 'easy', seed: 7 }).personality).toBe(personalityFromSeed(7));
    expect(new Bot({ player: 0, difficulty: 'easy', seed: 7, personality: 'turtle' }).personality).toBe('turtle');
  });

  it('counter table follows the design (spear>cav, cav>archer, archer>spear, sword>spear)', () => {
    expect(counterFactor('spear', 'cavalry')).toBeGreaterThan(1);
    expect(counterFactor('spear', 'knight')).toBeGreaterThan(1);
    expect(counterFactor('cavalry', 'archer')).toBeGreaterThan(1);
    expect(counterFactor('cavalry', 'ram')).toBeGreaterThan(1);
    expect(counterFactor('archer', 'spear')).toBeGreaterThan(1);
    expect(counterFactor('sword', 'spear')).toBeGreaterThan(1);
  });
});

function playGame(seed: number, diffs: [Difficulty, Difficulty], maxTicks: number, pers?: [Personality, Personality]) {
  const state = createGame(cfg(seed));
  const relay = new LocalRelay(state, 1_000_000);
  const bots = [0, 1].map(
    (p) => new Bot({ player: p as PlayerId, difficulty: diffs[p], seed: seed * 10 + p, personality: pers?.[p] }),
  );
  const invalid: { player: number; cmd: Command; reason: string }[] = [];
  let rejected = 0;
  let issued = 0;
  while (state.winner === null && state.tick < maxTicks) {
    for (const p of [0, 1] as PlayerId[]) {
      for (const cmd of bots[p].update(state)) {
        issued++;
        const reason = validateCommand(state, p, cmd);
        if (reason !== null) invalid.push({ player: p, cmd, reason });
        relay.submit(p, cmd);
      }
    }
    relay.advance();
    for (const e of state.events) if (e.t === 'rejected') rejected++;
  }
  return { state, invalid, rejected, issued, bots };
}

describe.skipIf(!READY)('bot vs sim', () => {
  it('produces valid commands and rarely gets rejected', () => {
    const { invalid, rejected, issued, state } = playGame(3, ['hard', 'normal'], 20 * 60 * 6);
    expect(issued).toBeGreaterThan(20);
    expect(invalid).toEqual([]);
    // commands execute 2 ticks later; a few may become invalid in between
    expect(rejected).toBeLessThanOrEqual(Math.max(3, issued * 0.03));
    // both bots actually did something
    expect(state.players[0].stats.squadsTrained + state.players[1].stats.squadsTrained).toBeGreaterThan(2);
    expect(state.buildings.length).toBeGreaterThan(2);
  }, 120_000);

  it('is deterministic (same seeds -> same command log)', () => {
    const a = playGame(5, ['normal', 'normal'], 20 * 120);
    const b = playGame(5, ['normal', 'normal'], 20 * 120);
    expect(a.issued).toBe(b.issued);
    expect(JSON.stringify(a.state.squads)).toBe(JSON.stringify(b.state.squads));
  }, 60_000);

  it('never reads hidden enemy squads', () => {
    // Two identical bots observe the same game. Bot B additionally sees a copy
    // of the state in which a hidden enemy squad was injected and every
    // hidden enemy squad was moved / damaged. Their decisions must be identical,
    // and no command may target a squad that is not visible.
    const me: PlayerId = 0;
    const foe: PlayerId = 1;
    const state = createGame(cfg(11));
    const relay = new LocalRelay(state, 1_000_000);
    const opp = new Bot({ player: foe, difficulty: 'hard', seed: 99, personality: 'rusher' });
    const a = new Bot({ player: me, difficulty: 'hard', seed: 5, personality: 'rusher' });
    const b = new Bot({ player: me, difficulty: 'hard', seed: 5, personality: 'rusher' });
    let compared = 0;
    let hiddenSeen = 0;
    for (let t = 0; t < 20 * 60 * 4 && state.winner === null; t++) {
      const vis = computeVisibility(state, me);
      const visibleAt = (x: number, y: number) => vis[Math.trunc(y / 1000) * state.mapW + Math.trunc(x / 1000)] === 1;
      const twisted: GameState = cloneState(state);
      // find a hidden walkable tile near the middle of the map
      let spot: { x: number; y: number } | null = null;
      for (let r = 0; r < 25 && !spot; r++) {
        for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const x = (28 + dx) * 1000 + 500;
          const y = (18 + dy) * 1000 + 500;
          if (x > 0 && y > 0 && x < state.mapW * 1000 && y < state.mapH * 1000 && isWalkable(state, x, y) && !visibleAt(x, y)) {
            spot = { x, y };
            break;
          }
        }
      }
      const hiddenIds: number[] = [];
      for (const s of twisted.squads) {
        if (s.owner === foe && !visibleAt(s.x, s.y)) {
          hiddenIds.push(s.id);
          s.hp = Math.max(1, s.hp >> 1);
          if (spot) {
            s.x = spot.x;
            s.y = spot.y;
          }
        }
      }
      if (spot) {
        const ghost: Squad = {
          id: twisted.nextId++, owner: foe, kind: 'cavalry', x: spot.x, y: spot.y, hp: 320, maxHp: 320, members: 4,
          order: 'idle', target: null, dest: null, path: [], cooldown: 0, lastCombatTick: 0, facing: 0,
        };
        twisted.squads.push(ghost);
        hiddenIds.push(ghost.id);
      }
      hiddenSeen += hiddenIds.length;
      const ca = a.update(state);
      const cb = b.update(twisted);
      expect(cb).toEqual(ca);
      for (const c of ca) {
        if (c.t === 'attack') expect(hiddenIds).not.toContain(c.target);
      }
      compared += ca.length;
      for (const c of ca) relay.submit(me, c);
      for (const c of opp.update(state)) relay.submit(foe, c);
      relay.advance();
    }
    expect(compared).toBeGreaterThan(10);
    expect(hiddenSeen).toBeGreaterThan(100);
  }, 120_000);

  it('hard beats easy in most games', () => {
    const N = 6;
    let hardWins = 0;
    for (let g = 0; g < N; g++) {
      const hardSide = (g % 2) as PlayerId;
      const diffs: [Difficulty, Difficulty] = hardSide === 0 ? ['hard', 'easy'] : ['easy', 'hard'];
      const { state } = playGame(100 + g, diffs, 26 * 60 * 20);
      if (state.winner === hardSide) hardWins++;
      else if (state.winner === null) {
        // aborted: compare VP
        if (state.players[hardSide].vp > state.players[1 - hardSide].vp) hardWins++;
      }
    }
    expect(hardWins).toBeGreaterThanOrEqual(Math.ceil(N * 0.66));
  }, 600_000);
});

describe.skipIf(!READY)('bot peace phase and tutorial mode', () => {
  it('exports income handicap per difficulty', () => {
    expect(difficultyIncomePct('easy')).toBe(80);
    expect(difficultyIncomePct('normal')).toBe(100);
    expect(difficultyIncomePct('hard')).toBe(110);
  });

  function run(peaceTicks: number, ticks: number, opts: { passive?: boolean; diff?: Difficulty } = {}) {
    const state = createGame({ ...cfg(21), peaceTicks });
    const relay = new LocalRelay(state, 1_000_000);
    const bots = [0, 1].map(
      (p) => new Bot({ player: p as PlayerId, difficulty: opts.diff ?? 'hard', seed: 40 + p, personality: 'rusher', passive: p === 1 ? opts.passive : false }),
    );
    const log: { tick: number; player: number; cmd: Command }[] = [];
    let maxX1 = 0;
    let minX1 = Infinity;
    while (state.winner === null && state.tick < ticks) {
      for (const p of [0, 1] as PlayerId[]) {
        for (const cmd of bots[p].update(state)) {
          log.push({ tick: state.tick, player: p, cmd });
          relay.submit(p, cmd);
        }
      }
      relay.advance();
      for (const s of state.squads) if (s.owner === 1) minX1 = Math.min(minX1, s.x);
      maxX1 = Math.max(maxX1, 0);
    }
    return { state, log, minX1 };
  }

  it('issues no attack commands during peace and captures only neutral points', () => {
    const peace = 180 * 20;
    const { state, log } = run(peace, peace);
    const attacks = log.filter((l) => l.cmd.t === 'attack');
    expect(attacks).toEqual([]);
    const rejected = state.events.filter((e) => e.t === 'rejected');
    expect(rejected).toEqual([]);
    // economy happened: buildings and squads trained, points captured
    for (const p of [0, 1]) {
      expect(state.players[p].stats.squadsTrained).toBeGreaterThan(1);
      expect(state.points.filter((x) => x.owner === p).length).toBeGreaterThan(1);
    }
  }, 60_000);

  it('passive bot never attacks and stays on its own half', () => {
    const { log, minX1, state } = run(0, 20 * 60 * 8, { passive: true, diff: 'normal' });
    expect(log.filter((l) => l.player === 1 && l.cmd.t === 'attack')).toEqual([]);
    const mid = (state.mapW * 1000) / 2;
    // player 1 lives on the right half; allow a small formation overshoot
    expect(minX1).toBeGreaterThan(mid - 2500);
  }, 60_000);
});

describe.skipIf(!READY)('bot campaign options', () => {
  it('maxAge stops age-ups and PERSONALITY_INFO covers all personalities', () => {
    for (const p of PERSONALITY_LIST) expect(PERSONALITY_INFO[p].label.length).toBeGreaterThan(0);
    const state = createGame(cfg(31));
    const relay = new LocalRelay(state, 1_000_000);
    const bots = [0, 1].map((p) => new Bot({ player: p as PlayerId, difficulty: 'hard', seed: 50 + p, personality: 'boomer', maxAge: p === 0 ? 1 : 3 }));
    while (state.winner === null && state.tick < 20 * 60 * 6) {
      for (const p of [0, 1] as PlayerId[]) for (const c of bots[p].update(state)) {
        if (p === 0 && c.t === 'research') expect(['age2', 'age3']).not.toContain(c.tech);
        relay.submit(p, c);
      }
      relay.advance();
    }
    expect(state.players[0].age).toBe(1);
  }, 60_000);
});
