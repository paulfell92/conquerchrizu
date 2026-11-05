/**
 * One running match from the client's point of view: state + relay + bot,
 * fixed-rate stepping with an accumulator, client-side memory (explored tiles,
 * remembered enemy buildings), selection and cosmetic effects fed by events.
 */
import type { Age, Building, BuildingKind, Command, GameConfig, GameEvent, GameState, PlayerCommand, PlayerId, Scenario, Squad } from '../sim/types';
import { TICK_RATE } from '../sim/types';
import type { Relay } from '../net/localRelay';
import * as botModule from '../bot';
import { Bot, type Difficulty, type Personality } from '../bot';
import { getApi, type SimApi } from './api';

/**
 * HUMAN / CPU are the LOCAL player and the opponent. They are live bindings:
 * an online guest plays as player 1, so `setLocalPlayer(1)` swaps them.
 */
export let HUMAN: PlayerId = 0;
export let CPU: PlayerId = 1;
export function setLocalPlayer(p: PlayerId) {
  HUMAN = p;
  CPU = (1 - p) as PlayerId;
}
export const COLORS = ['#3d7be0', '#d9483b'] as const;
const TICK_MS = 1000 / TICK_RATE;

export interface Remembered {
  id: number;
  kind: BuildingKind;
  owner: PlayerId;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  building: boolean; // under construction when seen
}

/** Cosmetic effect record (pooled). */
export interface Fx {
  kind: 0 | 1 | 2 | 3 | 4 | 5; // 0 arrow, 1 melee spark, 2 death puff, 3 move marker, 4 command line, 5 tap ripple (screen px)
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number; // ms (performance.now)
  dur: number;
  color: string;
  big: boolean;
  active: boolean;
}

export interface SessionOptions {
  peaceTicks?: number;
  passiveBot?: boolean;
  tutorial?: boolean;
  personality?: Personality;
  aggression?: number;
  maxAge?: Age;
  scenario?: Scenario;
  /** No bot at all (online, replay). */
  noBot?: boolean;
  /** Use this exact config instead of building one (replay, online). */
  config?: GameConfig;
  /** Custom relay (online). */
  relay?: (state: GameState) => Relay;
  /** Local player id (online guest = 1). */
  me?: PlayerId;
  /** Replay mode: commands come from a log, fog is off. */
  replayLog?: PlayerCommand[];
  /** Online match: no pause, no speed change. */
  online?: boolean;
}

/** One stats sample for the end-screen charts (every 5 s game time). */
export interface StatSample {
  tick: number;
  vp: [number, number];
  army: [number, number];
  points: [number, number];
  gathered: [number, number];
}
export const SAMPLE_TICKS = 5 * TICK_RATE;

const FALLBACK_INCOME: Record<Difficulty, number> = { easy: 80, normal: 100, hard: 110 };
/** Bot income handicap from the bot module, with a local fallback if it is missing. */
export function botIncomePct(d: Difficulty): number {
  const fn = (botModule as unknown as { difficultyIncomePct?: (d: Difficulty) => number }).difficultyIncomePct;
  try {
    const v = fn ? fn(d) : NaN;
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  } catch {
    /* ignore */
  }
  return FALLBACK_INCOME[d];
}

export type SessionListener = (ev: GameEvent, s: Session) => void;

export class Session {
  readonly api: SimApi;
  readonly state: GameState;
  readonly relay: Relay;
  bot: Bot | null;
  readonly difficulty: Difficulty;

  /** Previous-tick squad positions for interpolation, keyed by squad id. */
  readonly prev = new Map<number, { x: number; y: number }>();
  /** Tiles: 1 = currently visible for the human. */
  vis: number[];
  /** Tiles: 1 = seen at least once. */
  readonly explored: Uint8Array;
  visVersion = 0;
  readonly remembered = new Map<number, Remembered>();

  readonly selected = new Set<number>();
  /** Selected building / slot / point (mutually exclusive with squad selection). */
  selBuilding: number | null = null;
  selSlot: number | null = null;
  selPoint: number | null = null;
  selEnemy: number | null = null;
  selVersion = 0;

  /** Pending tap mode: next world tap sets rally or attacks. */
  mode: 'none' | 'rally' | 'attack' = 'none';

  paused = false;
  speed = 1;
  private acc = 0;
  /** Interpolation fraction 0..1 between previous and current tick. */
  alpha = 0;
  readonly fx: Fx[] = [];
  private listeners: SessionListener[] = [];
  private botBroken = false;
  /** Last tick each squad/building was hit (for flash). */
  readonly lastHit = new Map<number, number>();

  readonly tutorial: boolean;

  readonly opts: SessionOptions;
  /** Replay: full fog-free view; commands are fed from the log. */
  readonly replay: boolean;
  readonly online: boolean;
  private replayCmds: PlayerCommand[] = [];
  private replayIdx = 0;
  readonly samples: StatSample[] = [];
  /** Bot personality actually used (for the HUD / end screen). */
  readonly personality: Personality | null;

  constructor(difficulty: Difficulty, seed: number, opts: SessionOptions = {}) {
    this.api = getApi();
    this.difficulty = difficulty;
    this.opts = opts;
    this.tutorial = !!opts.tutorial;
    this.replay = !!opts.replayLog;
    this.online = !!opts.online;
    setLocalPlayer(opts.me ?? 0);
    const config: GameConfig = opts.config ?? {
      seed,
      mapId: 'chrizu-tal',
      players: [
        { name: 'Du', color: COLORS[0], isBot: false, incomePct: 100 },
        { name: 'CPU', color: COLORS[1], isBot: true, incomePct: botIncomePct(difficulty) },
      ],
      peaceTicks: Math.max(0, Math.round(opts.peaceTicks ?? 0)),
      ...(opts.scenario ? { scenario: opts.scenario } : {}),
    };
    if (opts.relay) {
      // a network relay owns its state (created from the server's config)
      this.relay = opts.relay(null as unknown as GameState);
      this.state = this.relay.state;
    } else {
      this.state = this.api.createGame(config);
      this.relay = this.api.makeRelay(this.state);
    }
    if (opts.replayLog) {
      this.replayCmds = opts.replayLog
        .map((c, i) => ({ c, i }))
        .sort((a, b) => a.c.tick - b.c.tick || a.c.player - b.c.player || a.i - b.i)
        .map((x) => x.c);
    }
    this.bot = null;
    this.personality = null;
    if (!opts.noBot && !opts.replayLog) {
      try {
        const botOpts = {
          player: CPU,
          difficulty,
          seed: seed ^ 0x5bd1e995,
          passive: !!opts.passiveBot,
          ...(opts.personality ? { personality: opts.personality } : {}),
          ...(opts.aggression !== undefined ? { aggression: opts.aggression } : {}),
          ...(opts.maxAge !== undefined ? { maxAge: opts.maxAge } : {}),
        };
        this.bot = new Bot(botOpts);
        this.personality = this.bot.personality;
      } catch (e) {
        console.warn('[client] Bot konnte nicht erstellt werden', e);
        this.bot = null;
      }
    }
    this.sample();
    this.explored = new Uint8Array(this.state.mapW * this.state.mapH);
    this.vis = [];
    this.refreshVisibility();
    for (const s of this.state.squads) this.prev.set(s.id, { x: s.x, y: s.y });
    for (let i = 0; i < 96; i++)
      this.fx.push({ kind: 0, x0: 0, y0: 0, x1: 0, y1: 0, t0: 0, dur: 0, color: '', big: false, active: false });
  }

  on(fn: SessionListener) {
    this.listeners.push(fn);
  }
  private tickHooks: ((s: Session) => void)[] = [];
  /** Called after every sim tick (mission objectives, online bookkeeping). */
  onTick(fn: (s: Session) => void) {
    this.tickHooks.push(fn);
  }

  get me() {
    return this.state.players[HUMAN];
  }
  get peace(): boolean {
    try {
      return this.api.isPeace(this.state);
    } catch {
      return false;
    }
  }
  get peaceLeft(): number {
    try {
      return this.api.peaceTicksLeft(this.state);
    } catch {
      return 0;
    }
  }
  get over() {
    return this.state.winner !== null;
  }

  submit(cmd: Command) {
    this.relay.submit(HUMAN, cmd);
  }

  validate(cmd: Command): string | null {
    try {
      return this.api.validateCommand(this.state, HUMAN, cmd);
    } catch {
      return null;
    }
  }

  /** Advance by real elapsed ms. Returns number of ticks stepped. */
  update(dtMs: number): number {
    if (this.paused || this.over) {
      this.alpha = 1;
      return 0;
    }
    this.acc += Math.min(dtMs, 250) * this.speed;
    const maxSteps = Math.max(2, Math.ceil(4 * this.speed));
    let n = 0;
    while (this.acc >= TICK_MS && n < maxSteps) {
      this.tick();
      this.acc -= TICK_MS;
      n++;
      if (this.over) break;
    }
    if (n === maxSteps && this.acc > TICK_MS) this.acc = TICK_MS * 0.5; // drop backlog
    this.alpha = Math.min(1, this.acc / TICK_MS);
    return n;
  }

  /** One sim tick: remember positions, advance relay, events, bot. */
  tick() {
    const st = this.state;
    for (const s of st.squads) {
      const p = this.prev.get(s.id);
      if (p) {
        p.x = s.x;
        p.y = s.y;
      } else this.prev.set(s.id, { x: s.x, y: s.y });
    }
    if (this.replay) {
      const due: PlayerCommand[] = [];
      const c = this.replayCmds;
      while (this.replayIdx < c.length && c[this.replayIdx].tick < st.tick) this.replayIdx++;
      while (this.replayIdx < c.length && c[this.replayIdx].tick === st.tick) due.push(c[this.replayIdx++]);
      this.api.step(st, due);
    } else if (!this.relay.advance()) return;
    for (const ev of st.events) this.handleEvent(ev);
    if (st.tick % SAMPLE_TICKS === 0 || st.winner !== null) this.sample();
    for (const f of this.tickHooks) f(this);
    if (this.bot && !this.botBroken && st.winner === null) {
      try {
        const cmds = this.bot.update(st);
        for (const c of cmds) this.relay.submit(CPU, c);
      } catch (e) {
        this.botBroken = true;
        console.warn('[client] Bot-Fehler, CPU pausiert:', e);
      }
    }
    if (st.tick % 2 === 0 || st.winner !== null) this.refreshVisibility();
    if (st.tick % 20 === 0) this.prunePrev();
    this.pruneSelection();
  }

  /** Last tick of the replay log (seek bar length). */
  get replayEnd(): number {
    const c = this.replayCmds;
    return c.length ? c[c.length - 1].tick : 0;
  }

  /** Fast-forward without rendering (replay seek). Events are skipped. */
  fastForward(toTick: number) {
    const st = this.state;
    while (st.tick < toTick && st.winner === null) {
      const due: PlayerCommand[] = [];
      const c = this.replayCmds;
      while (this.replayIdx < c.length && c[this.replayIdx].tick < st.tick) this.replayIdx++;
      while (this.replayIdx < c.length && c[this.replayIdx].tick === st.tick) due.push(c[this.replayIdx++]);
      this.api.step(st, due);
      if (st.tick % SAMPLE_TICKS === 0 || st.winner !== null) this.sample();
    }
    for (const q of st.squads) this.prev.set(q.id, { x: q.x, y: q.y });
    this.refreshVisibility();
  }

  private sample() {
    const st = this.state;
    const last = this.samples[this.samples.length - 1];
    if (last && last.tick === st.tick) return;
    const army: [number, number] = [0, 0];
    for (const q of st.squads) army[q.owner] += q.hp;
    const points: [number, number] = [0, 0];
    for (const p of st.points) if (p.owner === 0 || p.owner === 1) points[p.owner]++;
    this.samples.push({
      tick: st.tick,
      vp: [Math.max(0, st.players[0].vp), Math.max(0, st.players[1].vp)],
      army,
      points,
      gathered: [st.players[0].stats.resourcesGathered, st.players[1].stats.resourcesGathered],
    });
  }

  private prunePrev() {
    if (this.prev.size <= this.state.squads.length + 8) return;
    const alive = new Set(this.state.squads.map((s) => s.id));
    for (const id of this.prev.keys()) if (!alive.has(id)) this.prev.delete(id);
  }

  private pruneSelection() {
    if (this.selected.size) {
      let changed = false;
      for (const id of this.selected) {
        const e = this.squadById(id);
        if (!e) {
          this.selected.delete(id);
          changed = true;
        }
      }
      if (changed) this.selVersion++;
    }
    if (this.selBuilding !== null && !this.buildingById(this.selBuilding)) {
      this.selBuilding = null;
      this.selVersion++;
    }
    if (this.selEnemy !== null) {
      const e = this.squadById(this.selEnemy) ?? this.buildingById(this.selEnemy);
      if (!e || !this.isVisible(e.x, e.y)) {
        this.selEnemy = null;
        this.selVersion++;
      }
    }
  }

  refreshVisibility() {
    try {
      if (this.replay) {
        if (this.vis.length !== this.state.mapW * this.state.mapH) this.vis = new Array(this.state.mapW * this.state.mapH).fill(1);
      } else this.vis = this.api.computeVisibility(this.state, HUMAN);
    } catch {
      this.vis = new Array(this.state.mapW * this.state.mapH).fill(1);
    }
    const v = this.vis;
    const ex = this.explored;
    for (let i = 0; i < v.length; i++) if (v[i]) ex[i] = 1;
    // remember / forget enemy buildings
    for (const b of this.state.buildings) {
      if (b.owner === HUMAN) continue;
      if (this.isVisible(b.x, b.y)) {
        let r = this.remembered.get(b.id);
        if (!r) {
          r = { id: b.id, kind: b.kind, owner: b.owner, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp, building: false };
          this.remembered.set(b.id, r);
        }
        r.hp = b.hp;
        r.maxHp = b.maxHp;
        r.building = b.buildTicksLeft > 0;
      }
    }
    for (const r of this.remembered.values()) {
      if (this.isVisible(r.x, r.y) && !this.buildingById(r.id)) this.remembered.delete(r.id);
    }
    this.visVersion++;
  }

  isVisible(x: number, y: number): boolean {
    const tx = Math.floor(x / 1000);
    const ty = Math.floor(y / 1000);
    if (tx < 0 || ty < 0 || tx >= this.state.mapW || ty >= this.state.mapH) return false;
    return this.vis[ty * this.state.mapW + tx] === 1;
  }

  squadById(id: number): Squad | null {
    const a = this.state.squads;
    // binary search (sorted by id)
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m].id === id) return a[m];
      if (a[m].id < id) lo = m + 1;
      else hi = m - 1;
    }
    return null;
  }
  buildingById(id: number): Building | null {
    for (const b of this.state.buildings) if (b.id === id) return b;
    return null;
  }

  // ------------------------------------------------------------ selection

  clearSelection() {
    this.selected.clear();
    this.selBuilding = this.selSlot = this.selPoint = this.selEnemy = null;
    this.mode = 'none';
    this.selVersion++;
  }
  selectSquads(ids: number[], add = false) {
    if (!add) this.clearSelection();
    this.selBuilding = this.selSlot = this.selPoint = this.selEnemy = null;
    for (const id of ids) this.selected.add(id);
    this.mode = 'none';
    this.selVersion++;
  }
  toggleSquad(id: number) {
    this.selBuilding = this.selSlot = this.selPoint = this.selEnemy = null;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.selVersion++;
  }
  selectBuilding(id: number) {
    this.clearSelection();
    this.selBuilding = id;
  }
  selectSlot(slot: number) {
    this.clearSelection();
    this.selSlot = slot;
  }
  selectPoint(id: number) {
    this.clearSelection();
    this.selPoint = id;
  }
  selectEnemy(id: number) {
    this.clearSelection();
    this.selEnemy = id;
  }
  selectedIds(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }
  myArmy(): Squad[] {
    return this.state.squads.filter((s) => s.owner === HUMAN);
  }

  // ------------------------------------------------------------ events

  private handleEvent(ev: GameEvent) {
    const now = performance.now();
    switch (ev.t) {
      case 'hit': {
        const a = this.squadById(ev.from) ?? this.buildingById(ev.from);
        const b = this.squadById(ev.to) ?? this.buildingById(ev.to);
        this.lastHit.set(ev.to, this.state.tick);
        if (!a || !b) break;
        if (!this.isVisible(a.x, a.y) && !this.isVisible(b.x, b.y)) break;
        if (ev.ranged || (a as Building).slot !== undefined) {
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          this.spawnFx(0, a.x, a.y - 300, b.x, b.y - 200, now, 160 + d * 0.05, '#2a2016', false);
        } else {
          this.spawnFx(1, b.x, b.y, a.x, a.y, now, 260, '#fff3c4', false);
        }
        break;
      }
      case 'death':
        if (this.isVisible(ev.x, ev.y) || ev.owner === HUMAN)
          this.spawnFx(2, ev.x, ev.y, 0, 0, now, ev.kind in BUILDING_SET ? 1100 : 750, '#e9e1cf', ev.kind in BUILDING_SET);
        this.remembered.delete(ev.id);
        this.lastHit.delete(ev.id);
        break;
    }
    for (const l of this.listeners) l(ev, this);
  }

  spawnFx(kind: Fx['kind'], x0: number, y0: number, x1: number, y1: number, t0: number, dur: number, color: string, big: boolean) {
    let f = this.fx.find((e) => !e.active);
    if (!f) {
      // recycle the oldest
      f = this.fx[0];
      for (const e of this.fx) if (e.t0 < f.t0) f = e;
    }
    f.kind = kind;
    f.x0 = x0;
    f.y0 = y0;
    f.x1 = x1;
    f.y1 = y1;
    f.t0 = t0;
    f.dur = dur;
    f.color = color;
    f.big = big;
    f.active = true;
  }
}

const BUILDING_SET: Record<string, 1> = {
  towncenter: 1,
  barracks: 1,
  range: 1,
  stable: 1,
  blacksmith: 1,
  workshop: 1,
  tower: 1,
};
