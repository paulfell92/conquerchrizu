/**
 * Platform-independent lockstep relay room (one lobby code = one Room).
 * No Node / Cloudflare APIs here: the host passes in a clock, timers, a logger
 * and wraps each WebSocket as a `Conn`. Used by server/node and server/cloudflare.
 *
 * Lifecycle: lobby (host waits) → countdown (both seated, start sent) →
 * running (turn every turnMs) → ended (close after closeAfterEndMs) → closed.
 */
import type { GameConfig, Owner, PlayerCommand, PlayerId } from '../../src/sim/types';
import {
  CLOSE_AFTER_END_MS,
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_MAP,
  ERR,
  GRACE_MS,
  HASH_EVERY_TICKS,
  ONLINE_COLORS,
  PROTOCOL_VERSION,
  START_DELAY_MS,
  TURN_MS,
  TURN_TICKS,
  parseClientMsg,
  type ClientMsg,
  type EndReason,
  type ServerMsg,
} from '../../src/net/protocol';

export interface Conn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RoomHost {
  now(): number;
  /** Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
  /** Returns a cancel function. */
  setInterval(fn: () => void, ms: number): () => void;
  log(msg: string, data?: unknown): void;
  /** Called once when the room is finished and can be dropped. */
  onClosed?(room: Room): void;
}

export interface RoomOptions {
  turnMs?: number;
  graceMs?: number;
  closeAfterEndMs?: number;
  startDelayMs?: number;
  /** A lobby nobody joins is closed after this long. */
  lobbyTimeoutMs?: number;
  /** Max commands per seat per turn (extra ones are dropped). */
  maxCmdsPerTurn?: number;
}

/** Handle the host keeps per socket: forward messages and the close event. */
export interface RoomSocket {
  message(data: string): void;
  closed(): void;
}

interface Seat {
  token: string;
  name: string;
  conn: Conn | null;
  leftAt: number;
}

type Phase = 'lobby' | 'countdown' | 'running' | 'ended' | 'closed';

const MAX_FUTURE_TURNS = 50;

export function randomCode(): string {
  const out: string[] = [];
  const buf = new Uint8Array(16);
  while (out.length < CODE_LENGTH) {
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      // rejection sampling keeps the distribution uniform
      if (b < 256 - (256 % CODE_ALPHABET.length) && out.length < CODE_LENGTH) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
    }
  }
  return out.join('');
}

function randomToken(): string {
  const a = new Uint8Array(16);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSeed(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] >>> 1 || 1; // positive 31-bit, never 0
}

export class Room {
  readonly turnMs: number;
  readonly graceMs: number;
  readonly closeAfterEndMs: number;
  readonly startDelayMs: number;
  readonly lobbyTimeoutMs: number;
  readonly maxCmdsPerTurn: number;

  phase: Phase = 'lobby';
  readonly seats: [Seat | null, Seat | null] = [null, null];
  simVersion = '';
  mapId = DEFAULT_MAP;
  peaceTicks = 0;
  config: GameConfig | null = null;
  startAt = 0;

  /** Next turn number to emit (= number of turns emitted so far). */
  nextTurn = 0;
  private nextTurnAt = 0;
  /** Commands waiting for their turn, keyed by turn number. */
  private pending = new Map<number, PlayerCommand[]>();
  /** Every command ever emitted, in emission order (full replay log). */
  readonly log: PlayerCommand[] = [];
  /** Reported hashes per tick: [seat0, seat1]. */
  readonly hashes = new Map<number, [number | null, number | null]>();
  readonly desyncs: number[] = [];
  paused = false;
  endReason: EndReason | null = null;
  winner: Owner | null = null;
  endTick = 0;
  private forfeited: PlayerId | null = null;

  private stopClock: (() => void) | null = null;
  private timers = new Set<() => void>();
  private graceTimer: (() => void) | null = null;
  private sockets = new Set<Conn>();

  constructor(readonly code: string, private host: RoomHost, opts: RoomOptions = {}) {
    this.turnMs = opts.turnMs ?? TURN_MS;
    this.graceMs = opts.graceMs ?? GRACE_MS;
    this.closeAfterEndMs = opts.closeAfterEndMs ?? CLOSE_AFTER_END_MS;
    this.startDelayMs = opts.startDelayMs ?? START_DELAY_MS;
    this.lobbyTimeoutMs = opts.lobbyTimeoutMs ?? 30 * 60_000;
    this.maxCmdsPerTurn = opts.maxCmdsPerTurn ?? 40;
    this.later(() => {
      if (this.phase === 'lobby') this.close('Lobby-Zeit abgelaufen');
    }, this.lobbyTimeoutMs);
  }

  get closed(): boolean {
    return this.phase === 'closed';
  }

  /** True while nobody holds a seat (a fresh room). */
  get vacant(): boolean {
    return !this.seats[0] && !this.seats[1];
  }

  // ------------------------------------------------------------ sockets

  attach(conn: Conn): RoomSocket {
    this.sockets.add(conn);
    return {
      message: (data: string) => this.onMessage(conn, data),
      closed: () => this.onSocketClosed(conn),
    };
  }

  private seatOf(conn: Conn): PlayerId | null {
    if (this.seats[0]?.conn === conn) return 0;
    if (this.seats[1]?.conn === conn) return 1;
    return null;
  }

  private send(conn: Conn | null | undefined, msg: ServerMsg) {
    if (!conn) return;
    try {
      conn.send(JSON.stringify(msg));
    } catch (e) {
      this.host.log(`[${this.code}] send failed`, String(e));
    }
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const s of this.seats) {
      if (!s?.conn) continue;
      try {
        s.conn.send(data);
      } catch {
        /* socket dying; close event follows */
      }
    }
  }

  private fail(conn: Conn, reason: string, fatal = true) {
    this.send(conn, { t: 'error', reason, fatal });
    if (fatal) {
      try {
        conn.close(4000, 'error');
      } catch {
        /* ignore */
      }
    }
  }

  private onMessage(conn: Conn, data: string) {
    if (this.phase === 'closed') return this.fail(conn, ERR.closed);
    const msg = parseClientMsg(data);
    if (!msg) return this.fail(conn, ERR.badMessage, false);
    const seat = this.seatOf(conn);
    if (seat === null) return this.handshake(conn, msg);
    switch (msg.t) {
      case 'cmd':
        return this.onCmd(seat, msg.turn, msg.cmd);
      case 'hash':
        return this.onHash(seat, msg.tick, msg.hash);
      case 'over':
        return this.onOver(seat, msg.tick, msg.winner);
      case 'ping':
        return this.send(conn, { t: 'pong', id: msg.id, turn: this.nextTurn });
      default:
        return this.fail(conn, ERR.badMessage, false);
    }
  }

  private handshake(conn: Conn, msg: ClientMsg) {
    if (msg.t === 'ping') return this.send(conn, { t: 'pong', id: msg.id, turn: this.nextTurn });
    if (msg.t !== 'create' && msg.t !== 'join' && msg.t !== 'rejoin') return this.fail(conn, ERR.badMessage);
    if (msg.v !== PROTOCOL_VERSION) return this.fail(conn, ERR.protocol);

    if (msg.t === 'create') {
      if (!this.vacant) return this.fail(conn, ERR.taken);
      this.simVersion = msg.simVersion;
      this.mapId = msg.mapId ?? DEFAULT_MAP;
      this.peaceTicks = msg.peaceTicks ?? 0;
      const seat: Seat = { token: randomToken(), name: msg.name || 'Spieler 1', conn, leftAt: 0 };
      this.seats[0] = seat;
      this.host.log(`[${this.code}] created (map ${this.mapId}, peace ${this.peaceTicks})`);
      this.send(conn, { t: 'lobby', code: this.code, token: seat.token, you: 0, v: PROTOCOL_VERSION });
      return;
    }

    if (msg.t === 'join') {
      if (!this.seats[0]) return this.fail(conn, ERR.notFound);
      if (this.seats[1] || this.phase !== 'lobby') return this.fail(conn, ERR.full);
      if (msg.simVersion !== this.simVersion) return this.fail(conn, ERR.simVersion);
      const seat: Seat = { token: randomToken(), name: msg.name || 'Spieler 2', conn, leftAt: 0 };
      this.seats[1] = seat;
      this.send(conn, { t: 'lobby', code: this.code, token: seat.token, you: 1, v: PROTOCOL_VERSION });
      this.host.log(`[${this.code}] joined`);
      this.begin();
      return;
    }

    // rejoin
    const id: PlayerId | null = this.seats[0]?.token === msg.token ? 0 : this.seats[1]?.token === msg.token ? 1 : null;
    if (id === null) return this.fail(conn, ERR.badToken);
    const seat = this.seats[id]!;
    if (seat.conn && seat.conn !== conn) {
      const old = seat.conn;
      seat.conn = null;
      this.fail(old, ERR.replaced);
    }
    seat.conn = conn;
    this.host.log(`[${this.code}] seat ${id} rejoined at turn ${this.nextTurn}`);
    this.send(conn, { t: 'lobby', code: this.code, token: seat.token, you: id, v: PROTOCOL_VERSION });
    if (this.config) {
      this.send(conn, {
        t: 'start',
        config: this.config,
        startAt: this.startAt,
        startIn: Math.max(0, this.startAt - this.host.now()),
        turnMs: this.turnMs,
      });
      this.send(conn, { t: 'history', turns: this.nextTurn, cmds: this.log });
    }
    const other = this.seats[(1 - id) as PlayerId];
    this.send(conn, { t: 'peer', connected: !!other?.conn });
    this.send(other?.conn, { t: 'peer', connected: true });
    if (this.phase === 'ended') {
      this.send(conn, { t: 'end', reason: this.endReason ?? 'over', winner: this.winner, tick: this.endTick });
      return;
    }
    this.refreshPause();
  }

  private onSocketClosed(conn: Conn) {
    this.sockets.delete(conn);
    const id = this.seatOf(conn);
    if (id === null) {
      if (this.vacant && this.phase === 'lobby' && this.sockets.size === 0) this.close('leer');
      return;
    }
    const seat = this.seats[id]!;
    seat.conn = null;
    seat.leftAt = this.host.now();
    this.host.log(`[${this.code}] seat ${id} disconnected (turn ${this.nextTurn})`);
    if (this.phase === 'ended') {
      if (!this.seats[0]?.conn && !this.seats[1]?.conn) this.close('beendet, alle weg');
      return;
    }
    this.send(this.seats[(1 - id) as PlayerId]?.conn, { t: 'peer', connected: false });
    this.refreshPause();
  }

  // ------------------------------------------------------------ game flow

  private begin() {
    const s0 = this.seats[0]!;
    const s1 = this.seats[1]!;
    this.config = {
      seed: randomSeed(),
      mapId: this.mapId,
      players: [
        { name: s0.name, color: ONLINE_COLORS[0], isBot: false, incomePct: 100 },
        { name: s1.name, color: ONLINE_COLORS[1], isBot: false, incomePct: 100 },
      ],
      peaceTicks: this.peaceTicks,
    };
    const now = this.host.now();
    this.startAt = now + this.startDelayMs;
    this.nextTurnAt = this.startAt;
    this.phase = 'countdown';
    this.broadcast({ t: 'start', config: this.config, startAt: this.startAt, startIn: this.startDelayMs, turnMs: this.turnMs });
    this.broadcast({ t: 'peer', connected: true });
    this.host.log(`[${this.code}] start seed ${this.config.seed}`);
    this.startClock();
  }

  private startClock() {
    if (this.stopClock) return;
    this.stopClock = this.host.setInterval(() => this.pump(), this.turnMs);
    this.pump();
  }

  private haltClock() {
    this.stopClock?.();
    this.stopClock = null;
  }

  /** Emit every turn that is due. Called by the host's interval timer. */
  pump() {
    if (this.paused || (this.phase !== 'countdown' && this.phase !== 'running')) return;
    const now = this.host.now();
    let n = 0;
    while (now >= this.nextTurnAt && n < 20) {
      this.emitTurn();
      this.nextTurnAt += this.turnMs;
      n++;
    }
    if (now >= this.nextTurnAt) this.nextTurnAt = now + this.turnMs; // timer starved: don't burst forever
  }

  private emitTurn() {
    this.phase = 'running';
    const n = this.nextTurn++;
    const cmds = this.pending.get(n) ?? [];
    this.pending.delete(n);
    for (const c of cmds) this.log.push(c);
    this.broadcast({ t: 'turn', n, cmds });
  }

  private onCmd(seat: PlayerId, turn: number, cmd: PlayerCommand['cmd']) {
    if (this.phase !== 'countdown' && this.phase !== 'running') return;
    let target = Math.max(turn, this.nextTurn);
    target = Math.min(target, this.nextTurn + MAX_FUTURE_TURNS);
    let list = this.pending.get(target);
    if (!list) {
      list = [];
      this.pending.set(target, list);
    }
    if (list.filter((c) => c.player === seat).length >= this.maxCmdsPerTurn) return;
    list.push({ player: seat, tick: target * TURN_TICKS, cmd });
    // stable: player 0 first, then player 1, arrival order within a player
    list.sort((a, b) => a.player - b.player);
  }

  private onHash(seat: PlayerId, tick: number, hash: number) {
    if (tick <= 0 || tick % HASH_EVERY_TICKS !== 0 || tick > (this.nextTurn + 1) * TURN_TICKS) return;
    let e = this.hashes.get(tick);
    if (!e) {
      e = [null, null];
      this.hashes.set(tick, e);
    }
    const prevOwn = e[seat];
    e[seat] = hash;
    const other = e[1 - seat];
    if (other === null) return;
    if (prevOwn === hash && prevOwn !== null) return; // replayed hash after rejoin, already compared
    if (other !== hash) {
      if (this.desyncs.includes(tick)) return;
      this.desyncs.push(tick);
      this.host.log(`[${this.code}] DESYNC at tick ${tick}: p0=${e[0]} p1=${e[1]}`);
      this.broadcast({ t: 'desync', tick });
    }
  }

  private onOver(seat: PlayerId, tick: number, winner: Owner) {
    if (this.phase === 'ended' || this.phase === 'closed') return;
    if (this.phase === 'lobby') return;
    this.endGame(this.forfeited !== null ? 'abandoned' : 'over', winner, tick);
    this.host.log(`[${this.code}] over reported by seat ${seat}: winner ${winner} at tick ${tick}`);
  }

  private endGame(reason: EndReason, winner: Owner | null, tick: number) {
    this.phase = 'ended';
    this.endReason = reason;
    this.winner = winner;
    this.endTick = tick;
    this.haltClock();
    this.clearGrace();
    this.broadcast({ t: 'end', reason, winner, tick });
    this.later(() => this.close('Spielende'), this.closeAfterEndMs);
  }

  /** Pause while a seat is empty during a match; start/stop the grace timer. */
  private refreshPause() {
    if (this.phase === 'lobby') {
      // host alone in the lobby: close if gone for the grace period
      if (!this.seats[0]?.conn) this.armGrace(() => this.close('Host weg'));
      else this.clearGrace();
      return;
    }
    if (this.phase !== 'countdown' && this.phase !== 'running') return;
    const missing = ([0, 1] as PlayerId[]).filter((i) => !this.seats[i]?.conn);
    const shouldPause = missing.length > 0 && this.forfeited === null;
    if (shouldPause && !this.paused) {
      this.paused = true;
      this.haltClock();
      this.broadcast({ t: 'paused', paused: true, graceMs: this.graceMs });
      this.armGrace(() => this.graceExpired());
    } else if (!shouldPause && this.paused) {
      this.paused = false;
      this.clearGrace();
      this.nextTurnAt = Math.max(this.nextTurnAt, this.host.now() + this.turnMs);
      this.broadcast({ t: 'paused', paused: false, graceMs: 0 });
      this.startClock();
    }
  }

  private graceExpired() {
    this.graceTimer = null;
    const missing = ([0, 1] as PlayerId[]).filter((i) => !this.seats[i]?.conn);
    if (missing.length === 0) return;
    if (missing.length === 2 || this.phase === 'countdown') {
      this.close(missing.length === 2 ? 'beide weg' : 'Start abgebrochen');
      return;
    }
    // One player stayed: the absent one surrenders (a normal command, so both sims agree).
    const absent = missing[0];
    this.forfeited = absent;
    this.host.log(`[${this.code}] seat ${absent} forfeits after grace`);
    this.paused = false;
    this.broadcast({ t: 'paused', paused: false, graceMs: 0 });
    this.onCmd(absent, this.nextTurn, { t: 'surrender' });
    this.nextTurnAt = this.host.now();
    this.startClock();
    // safety: if the remaining client never reports the end, close eventually
    this.later(() => {
      if (this.phase === 'running') this.endGame('abandoned', (1 - absent) as PlayerId, this.nextTurn * TURN_TICKS);
    }, Math.max(10_000, this.turnMs * 100));
  }

  private armGrace(fn: () => void) {
    if (this.graceTimer) return;
    this.graceTimer = this.host.setTimeout(fn, this.graceMs);
  }

  private clearGrace() {
    this.graceTimer?.();
    this.graceTimer = null;
  }

  private later(fn: () => void, ms: number) {
    const cancel = this.host.setTimeout(() => {
      this.timers.delete(cancel);
      fn();
    }, ms);
    this.timers.add(cancel);
  }

  close(why = 'closed') {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.haltClock();
    this.clearGrace();
    for (const c of this.timers) c();
    this.timers.clear();
    this.host.log(`[${this.code}] closed (${why}); turns ${this.nextTurn}, cmds ${this.log.length}, desyncs ${this.desyncs.length}`);
    for (const conn of this.sockets) {
      try {
        conn.close(1000, 'closed');
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    this.host.onClosed?.(this);
  }

  /** Small status object for logs / health endpoints. */
  info() {
    return {
      code: this.code,
      phase: this.phase,
      turn: this.nextTurn,
      paused: this.paused,
      connected: [!!this.seats[0]?.conn, !!this.seats[1]?.conn],
      cmds: this.log.length,
      desyncs: this.desyncs.slice(),
    };
  }
}
