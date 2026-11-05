/**
 * Headless bot-vs-bot simulation (no rendering).
 *
 *   npx tsx tools/simulate.ts --games 20 --a hard --b normal
 *
 * Options:
 *   --games N          number of games (default 10)
 *   --a / --b DIFF     difficulty of bot A / B (easy|normal|hard, default normal)
 *   --pa / --pb PERS   personality of A / B (rusher|boomer|turtle|random, default random)
 *   --seed S           base seed (default 1)
 *   --map ID           map id (default first map)
 *   --override FILE    JSON patch applied in memory to content before createGame:
 *                      { "RULES": {...}, "UNITS": { "spear": {...} }, "BUILDINGS": {...}, "TECHS": {...} }
 *   --set k=v,...      inline overrides, e.g. --set RULES.vpDrainPerPoint=2,UNITS.spear.cost.food=50
 *   --json             machine-readable output (one JSON object)
 *   --quiet            no per-game lines
 *   --peace SEC        peace phase in seconds (default 180)
 *   --no-handicap      don't apply difficultyIncomePct
 *   --agg-a / --agg-b X  BotOptions.aggression for A / B (default 1)
 *   --trace            print a per-30s timeline (VP, points, army, age, stance) per game
 *   --max-minutes M    abort a game after M minutes of game time (default: rules hard cap + 1)
 *
 * Sides alternate every game (A is player 0 in even games, player 1 in odd games).
 */
import { createGame, formatClock } from '../src/sim';
import type { GameState, PlayerId, WinReason } from '../src/sim';
import * as content from '../src/content';
import { LocalRelay } from '../src/net/localRelay';
import { Bot, difficultyIncomePct, personalityFromSeed } from '../src/bot';
import type { Difficulty, Personality } from '../src/bot';

// Node globals without @types/node (not a dependency of this project).
const proc = (globalThis as unknown as { process: { argv: string[] } }).process;
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(p: string, enc: string): string };

// ---------------------------------------------------------------- args

const argv = proc.argv.slice(2);
function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}
const has = (name: string) => argv.includes('--' + name);

const games = Number(arg('games', '10'));
const diffA = arg('a', 'normal') as Difficulty;
const diffB = arg('b', 'normal') as Difficulty;
const persA = arg('pa', 'random')!;
const persB = arg('pb', 'random')!;
const aggA = Number(arg('agg-a', '1'));
const aggB = Number(arg('agg-b', '1'));
const baseSeed = Number(arg('seed', '1'));
const mapId = arg('map', Object.keys(content.MAPS)[0])!;
const json = has('json');
const quiet = has('quiet') || json;
const trace = has('trace');
const peaceSec = Number(arg('peace', '180'));
const handicap = !has('no-handicap');

for (const d of [diffA, diffB]) {
  if (!['easy', 'normal', 'hard'].includes(d)) throw new Error('bad difficulty ' + d);
}

// ---------------------------------------------------------------- overrides

type Obj = Record<string, unknown>;
function deepMerge(target: Obj, patch: Obj, path: string, warn = true): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k] as Obj, v as Obj, path + '.' + k, warn);
    } else {
      if (warn && !(k in target)) console.error(`warning: override adds new key ${path}.${k}`);
      target[k] = v;
    }
  }
}
const overrides: Obj = {};
const overrideFile = arg('override');
if (overrideFile) deepMerge(overrides, JSON.parse(readFileSync(overrideFile, 'utf8')) as Obj, '', false);
const setArg = arg('set');
if (setArg) {
  for (const kv of setArg.split(',')) {
    const [k, raw] = kv.split('=');
    const keys = k.split('.');
    let o = overrides;
    for (const key of keys.slice(0, -1)) o = (o[key] ??= {}) as Obj;
    o[keys[keys.length - 1]] = JSON.parse(raw);
  }
}
const contentRoots: Obj = { RULES: content.RULES, UNITS: content.UNITS, BUILDINGS: content.BUILDINGS, TECHS: content.TECHS };
for (const [root, patch] of Object.entries(overrides)) {
  if (!(root in contentRoots)) throw new Error('unknown override root ' + root);
  deepMerge(contentRoots[root] as Obj, patch as Obj, root);
}

// ---------------------------------------------------------------- run

interface GameResult {
  game: number;
  seed: number;
  winner: 'A' | 'B' | 'draw' | 'none';
  reason: WinReason | 'aborted';
  ticks: number;
  duration: string;
  sideA: PlayerId;
  persA: Personality;
  persB: Personality;
  vpA: number;
  vpB: number;
  trainedA: number;
  trainedB: number;
  killedA: number;
  killedB: number;
  pointsA: number;
  pointsB: number;
  ageA: number;
  ageB: number;
  cmdsA: number;
  cmdsB: number;
  rejectedA: number;
  rejectedB: number;
  botMsPerTick: number;
  sinksA: Record<string, number>;
  sinksB: Record<string, number>;
}

function pickPers(p: string, seed: number): Personality {
  return p === 'random' ? personalityFromSeed(seed) : (p as Personality);
}

const hardCap = (content.RULES as { hardCapTicks: number }).hardCapTicks;
const maxTicks = arg('max-minutes') ? Number(arg('max-minutes')) * 60 * 20 : hardCap + peaceSec * 20 + 20 * 60;

function runGame(g: number): GameResult {
  const seed = baseSeed * 1000 + g;
  const sideA = (g % 2) as PlayerId;
  const pA = pickPers(persA, seed * 2 + 1);
  const pB = pickPers(persB, seed * 2 + 2);
  const diffOf = (p: number) => (p === sideA ? diffA : diffB);
  const state: GameState = createGame({
    seed,
    mapId,
    peaceTicks: peaceSec * 20,
    players: [0, 1].map((p) => ({
      name: 'P' + p,
      color: p === 0 ? '#36c' : '#c33',
      isBot: true,
      incomePct: handicap ? difficultyIncomePct(diffOf(p)) : 100,
    })),
  });
  const relay = new LocalRelay(state, 1_000_000);
  const bots: Bot[] = [];
  bots[sideA] = new Bot({ player: sideA, difficulty: diffA, personality: pA, seed: seed * 2 + 1, aggression: aggA });
  bots[1 - sideA] = new Bot({ player: (1 - sideA) as PlayerId, difficulty: diffB, personality: pB, seed: seed * 2 + 2, aggression: aggB });
  let botMs = 0;
  let ticks = 0;
  while (state.winner === null && state.tick < maxTicks) {
    const t0 = performance.now();
    for (const p of [0, 1] as PlayerId[]) {
      for (const cmd of bots[p].update(state)) relay.submit(p, cmd);
    }
    botMs += performance.now() - t0;
    relay.advance();
    ticks++;
    if (trace && state.tick % 600 === 0) {
      const line = ([sideA, 1 - sideA] as PlayerId[]).map((p) => {
        const pl = state.players[p];
        const army = state.squads.filter((s) => s.owner === p);
        const kinds: Record<string, number> = {};
        for (const s of army) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
        const pts = state.points.filter((x) => x.owner === p).length;
        const blds = state.buildings.filter((b) => b.owner === p && b.kind !== 'towncenter').map((b) => b.kind[0] + b.kind[1]).join('');
        const d = bots[p].debug;
        return `${p === sideA ? 'A' : 'B'} vp${pl.vp} pts${pts} age${pl.age} pop${pl.pop} res${pl.res.food}/${pl.res.wood}/${pl.res.gold} ${d.stance}${d.saving ? '[' + d.saving + ']' : ''} ${Object.entries(kinds).map(([k, n]) => k.slice(0, 2) + n).join(' ')} {${blds}}`;
      });
      console.log(`  ${formatClock(state.tick)}  ${line.join('  |  ')}`);
    }
  }
  const a = state.players[sideA];
  const b = state.players[1 - sideA];
  let winner: GameResult['winner'] = 'none';
  if (state.winner === -1) winner = 'draw';
  else if (state.winner === sideA) winner = 'A';
  else if (state.winner !== null) winner = 'B';
  const pts = (p: number) => state.points.filter((x) => x.owner === p).length;
  const dA = bots[sideA].debug.stats;
  const dB = bots[1 - sideA].debug.stats;
  return {
    game: g,
    seed,
    winner,
    reason: state.winReason ?? 'aborted',
    ticks: state.tick,
    duration: formatClock(state.tick),
    sideA,
    persA: pA,
    persB: pB,
    vpA: a.vp,
    vpB: b.vp,
    trainedA: a.stats.squadsTrained,
    trainedB: b.stats.squadsTrained,
    killedA: a.stats.squadsKilled,
    killedB: b.stats.squadsKilled,
    pointsA: pts(sideA),
    pointsB: pts(1 - sideA),
    ageA: a.age,
    ageB: b.age,
    cmdsA: dA.commands,
    cmdsB: dB.commands,
    rejectedA: dA.rejectedBySim,
    rejectedB: dB.rejectedBySim,
    botMsPerTick: botMs / Math.max(1, ticks) / 2,
    sinksA: { ...bots[sideA].debug.sinks },
    sinksB: { ...bots[1 - sideA].debug.sinks },
  };
}

const results: GameResult[] = [];
const t0 = performance.now();
for (let g = 0; g < games; g++) {
  const r = runGame(g);
  results.push(r);
  if (!quiet) {
    const w = r.winner === 'A' ? `A(${diffA}/${r.persA})` : r.winner === 'B' ? `B(${diffB}/${r.persB})` : r.winner;
    console.log(
      `#${String(g + 1).padStart(3)} ${r.duration}  winner ${w.padEnd(18)} ${r.reason.padEnd(10)} ` +
        `VP ${r.vpA}:${r.vpB}  pts ${r.pointsA}:${r.pointsB}  age ${r.ageA}:${r.ageB}  ` +
        `trained ${r.trainedA}:${r.trainedB}  killed ${r.killedA}:${r.killedB}  ` +
        `A=${r.persA} B=${r.persB} sideA=${r.sideA}  rej ${r.rejectedA}:${r.rejectedB}`,
    );
  }
}
const wallMs = performance.now() - t0;

// ---------------------------------------------------------------- summary

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);
const n = results.length;
const winsA = results.filter((r) => r.winner === 'A').length;
const winsB = results.filter((r) => r.winner === 'B').length;
const draws = results.filter((r) => r.winner === 'draw' || r.winner === 'none').length;
const ticks = results.map((r) => r.ticks);
const reasons: Record<string, number> = {};
for (const r of results) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;

// per personality: wins / games, counting both sides
const persStats: Record<string, { games: number; wins: number }> = {};
const byPers = (p: string, won: boolean) => {
  const s = (persStats[p] ??= { games: 0, wins: 0 });
  s.games++;
  if (won) s.wins++;
};
for (const r of results) {
  byPers(`A:${r.persA}`, r.winner === 'A');
  byPers(`B:${r.persB}`, r.winner === 'B');
}
// per side (player 0 / player 1)
let p0wins = 0;
for (const r of results) if ((r.winner === 'A' && r.sideA === 0) || (r.winner === 'B' && r.sideA === 1)) p0wins++;
const avg = (f: (r: GameResult) => number) => Math.round((10 * results.reduce((s, r) => s + f(r), 0)) / Math.max(1, n)) / 10;

const summary = {
  games: n,
  peaceSeconds: peaceSec,
  incomeHandicap: handicap,
  a: diffA,
  b: diffB,
  overrides,
  winRateA: pct(winsA, n),
  winRateB: pct(winsB, n),
  drawRate: pct(draws, n),
  winRatePlayer0: pct(p0wins, n - draws),
  personality: Object.fromEntries(Object.entries(persStats).map(([k, v]) => [k, { games: v.games, winRate: pct(v.wins, v.games) }])),
  lengthMedian: formatClock(median(ticks)),
  lengthMin: formatClock(Math.min(...ticks)),
  lengthMax: formatClock(Math.max(...ticks)),
  endReasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, pct(v, n)])),
  avgTrainedA: avg((r) => r.trainedA),
  avgTrainedB: avg((r) => r.trainedB),
  avgKilledA: avg((r) => r.killedA),
  avgKilledB: avg((r) => r.killedB),
  avgCommandsA: avg((r) => r.cmdsA),
  avgCommandsB: avg((r) => r.cmdsB),
  avgRejectedA: avg((r) => r.rejectedA),
  avgRejectedB: avg((r) => r.rejectedB),
  botMsPerTick: Math.round(1000 * avg((r) => r.botMsPerTick * 10) / 10) / 1000,
  wallSeconds: Math.round(wallMs / 100) / 10,
  /** Average uses per bot per game of each sink (both sides pooled). */
  sinksPerGame: (() => {
    const tot: Record<string, number> = {};
    for (const r of results) for (const side of [r.sinksA, r.sinksB]) for (const [k, x] of Object.entries(side)) tot[k] = (tot[k] ?? 0) + x;
    return Object.fromEntries(Object.entries(tot).map(([k, x]) => [k, Math.round((100 * x) / Math.max(1, 2 * n)) / 100]));
  })(),
};

if (json) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log('');
  console.log(`=== ${n} games  A=${diffA}  B=${diffB}  peace ${peaceSec}s  handicap ${handicap ? 'on' : 'off'}  (${summary.wallSeconds}s wall) ===`);
  if (Object.keys(overrides).length) console.log('overrides:', JSON.stringify(overrides));
  console.log(`win rate   A ${summary.winRateA}%   B ${summary.winRateB}%   draw ${summary.drawRate}%   (player0 side ${summary.winRatePlayer0}%)`);
  console.log(
    'personality',
    Object.entries(summary.personality)
      .map(([k, v]) => `${k} ${v.winRate}% (${v.games})`)
      .join('   '),
  );
  console.log(`length     median ${summary.lengthMedian}   min ${summary.lengthMin}   max ${summary.lengthMax}`);
  console.log('end reason', Object.entries(summary.endReasons).map(([k, v]) => `${k} ${v}%`).join('   '));
  console.log(`squads     trained A ${summary.avgTrainedA} B ${summary.avgTrainedB}   killed A ${summary.avgKilledA} B ${summary.avgKilledB}`);
  console.log(`commands   A ${summary.avgCommandsA} B ${summary.avgCommandsB}   sim-rejected A ${summary.avgRejectedA} B ${summary.avgRejectedB}`);
  console.log(`bot cost   ${summary.botMsPerTick} ms per bot per tick`);
  console.log('sinks/bot/game', Object.entries(summary.sinksPerGame).map(([k, x]) => `${k} ${x}`).join('   '));
}
