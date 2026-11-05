/**
 * Online lockstep client: `NetClient` handles the lobby (create / join /
 * rejoin, reconnect, ping); on start it builds a `NetworkRelay` (implements
 * Relay) that only advances the sim when it holds the turn bundle.
 *
 *   const net = NetClient.connect(relayUrl());
 *   net.onStart = ({ relay, you }) => startOnlineSession(relay, you);
 *   const lobby = await net.createLobby({ peaceTicks: 3600 });   // show lobby.code
 *   // other device: await net.joinLobby('K7QX2');
 *
 * Works in browsers (native WebSocket) and Node (global WebSocket in Node 22,
 * or pass `WebSocket` from 'ws').
 */
import { createGame, hashState, step, SIM_VERSION } from '../sim';
import type { Command, GameConfig, GameState, Owner, PlayerCommand, PlayerId } from '../sim';
import type { Relay } from './localRelay';
import {
  GRACE_MS,
  HASH_EVERY_TICKS,
  MIN_DELAY_TURNS,
  PROTOCOL_VERSION,
  TURN_TICKS,
  delayForPing,
  normalizeCode,
  type ClientMsg,
  type EndReason,
  type LobbyOptions,
  type ServerMsg,
} from './protocol';

// ---------------------------------------------------------------- relay URL

/**
 * Relay base URL: `?relay=wss://...` URL parameter > VITE_RELAY_URL (build
 * time) > ws://localhost:8787 in `npm run dev` > '' (online not configured).
 */
export function relayUrl(): string {
  try {
    const loc = (globalThis as { location?: { search?: string } }).location;
    if (loc?.search) {
      const p = new URLSearchParams(loc.search).get('relay');
      if (p) return p.trim();
    }
  } catch {
    /* ignore */
  }
  try {
    const env = import.meta.env as Record<string, unknown> | undefined;
    const v = env?.VITE_RELAY_URL;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (env?.DEV) return 'ws://localhost:8787';
  } catch {
    /* ignore */
  }
  return '';
}

/** True if this page can attempt online play at all (WebSocket + a relay URL). */
export function onlineAvailable(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' && relayUrl() !== '';
}

// ---------------------------------------------------------------- WebSocket shim

/** The subset of the WebSocket API we use (browser, Node 22 global, `ws`). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export type WsCtor = new (url: string) => WsLike;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------- relay

export class NetworkRelay implements Relay {
  readonly state: GameState;
  /** Every command executed (both players), in execution order. */
  readonly log: PlayerCommand[] = [];
  readonly hashes: { tick: number; hash: number }[] = [];
  /** Bundles by turn number. */
  private bundles: (PlayerCommand[] | undefined)[] = [];
  /** Turns 0..received-1 are all present. */
  private received = 0;
  private overSent = false;

  constructor(
    readonly config: GameConfig,
    readonly you: PlayerId,
    private client: NetClient,
  ) {
    this.state = createGame(config);
  }

  /** Number of turn bundles held (contiguous from 0). */
  get turnsReceived(): number {
    return this.received;
  }

  /** Sim ticks that could run right now. > ~4 means behind → run extra ticks this frame. */
  get ticksBehind(): number {
    if (this.state.winner !== null) return 0;
    return Math.max(0, this.received * TURN_TICKS - this.state.tick);
  }

  /** Waiting for the network (not paused by us, just no bundle yet). */
  get waiting(): boolean {
    return this.state.winner === null && this.ticksBehind === 0;
  }

  /** Only the local player's commands are sent; other ids are ignored. */
  submit(player: PlayerId, cmd: Command): void {
    if (player !== this.you || this.state.winner !== null) return;
    const ownTurn = Math.floor(this.state.tick / TURN_TICKS);
    const base = Math.max(ownTurn, this.received - 1);
    this.client.send({ t: 'cmd', turn: base + this.client.delayTurns, cmd });
  }

  advance(): boolean {
    const st = this.state;
    if (st.winner !== null) return false;
    const t = st.tick;
    const turn = Math.floor(t / TURN_TICKS);
    if (turn >= this.received) return false;
    let due: PlayerCommand[] = [];
    if (t % TURN_TICKS === 0) {
      due = this.bundles[turn] ?? [];
      for (const c of due) this.log.push(c);
      this.bundles[turn] = undefined; // free memory; the log keeps them
    }
    step(st, due);
    if (st.tick % HASH_EVERY_TICKS === 0) {
      const h = hashState(st);
      this.hashes.push({ tick: st.tick, hash: h });
      this.client.send({ t: 'hash', tick: st.tick, hash: h });
    }
    if (st.winner !== null && !this.overSent) {
      this.overSent = true;
      this.client.send({ t: 'over', tick: st.tick, winner: st.winner });
    }
    return true;
  }

  /** Run up to `max` ticks within `budgetMs` (catch-up without UI work). Returns ticks run. */
  fastForward(max = 1e9, budgetMs = 12): number {
    const t0 = now();
    let n = 0;
    while (n < max && this.advance()) {
      n++;
      if ((n & 15) === 0 && now() - t0 > budgetMs) break;
    }
    return n;
  }

  /** @internal called by NetClient */
  addTurn(n: number, cmds: PlayerCommand[]) {
    if (n < this.received || this.bundles[n] !== undefined) return;
    this.bundles[n] = cmds.map((c) => ({ player: c.player, tick: n * TURN_TICKS, cmd: c.cmd }));
    while (this.bundles[this.received] !== undefined) this.received++;
  }

  /** @internal history after rejoin: turns 0..turns-1, sparse command list. */
  addHistory(turns: number, cmds: PlayerCommand[]) {
    if (turns <= this.received) return;
    const by = new Map<number, PlayerCommand[]>();
    for (const c of cmds) {
      const n = Math.floor(c.tick / TURN_TICKS);
      let l = by.get(n);
      if (!l) by.set(n, (l = []));
      l.push(c);
    }
    for (let n = this.received; n < turns; n++) this.addTurn(n, by.get(n) ?? []);
  }
}

// ---------------------------------------------------------------- lobby client

export interface LobbyInfo {
  code: string;
  token: string;
  you: PlayerId;
}

export interface StartInfo {
  relay: NetworkRelay;
  config: GameConfig;
  you: PlayerId;
  /** ms until turn 0 (countdown); 0 on rejoin of a running game. */
  startIn: number;
  /** True when this start came from a rejoin (fast-forward pending). */
  rejoined: boolean;
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetClientOptions {
  WebSocket?: WsCtor;
  name?: string;
  /** Ping interval ms (default 2000). */
  pingEvery?: number;
  /** Auto-reconnect after an unexpected drop (default true). */
  reconnect?: boolean;
}

export class NetClient {
  // events (assign a function)
  onLobby: ((info: LobbyInfo) => void) | null = null;
  onStart: ((info: StartInfo) => void) | null = null;
  /** Opponent connected / disconnected. Show „Gegner getrennt“ when false. */
  onPeer: ((connected: boolean) => void) | null = null;
  /** Server paused the turn clock (a player is missing) / resumed. */
  onPause: ((paused: boolean, graceMs: number) => void) | null = null;
  onDesync: ((tick: number) => void) | null = null;
  /** German error text; fatal = connection is over. */
  onError: ((reason: string, fatal: boolean) => void) | null = null;
  onEnd: ((reason: EndReason, winner: Owner | null) => void) | null = null;
  onConnection: ((state: ConnState) => void) | null = null;

  /** Smoothed round trip in ms (0 until measured). */
  ping = 0;
  /** Current input delay in turns (2..4). */
  delayTurns = MIN_DELAY_TURNS;
  lobby: LobbyInfo | null = null;
  relay: NetworkRelay | null = null;
  peerConnected = false;
  paused = false;
  ended = false;
  connState: ConnState = 'idle';
  readonly desyncTicks: number[] = [];

  private ws: WsLike | null = null;
  private Ws: WsCtor;
  private outbox: string[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingId = 0;
  private pingSent = new Map<number, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dropAt = 0;
  private attempts = 0;
  private fatal = false;
  private lastHello: ClientMsg['t'] = 'create';
  private pendingLobby: { resolve: (l: LobbyInfo) => void; reject: (e: Error) => void } | null = null;

  constructor(readonly url: string, private opts: NetClientOptions = {}) {
    const W = opts.WebSocket ?? (globalThis as { WebSocket?: WsCtor }).WebSocket;
    if (!W) throw new Error('WebSocket nicht verfügbar');
    this.Ws = W;
  }

  static connect(url: string, opts?: NetClientOptions): NetClient {
    return new NetClient(url, opts);
  }

  createLobby(opts: LobbyOptions = {}): Promise<LobbyInfo> {
    return this.open('new', {
      t: 'create',
      v: PROTOCOL_VERSION,
      simVersion: SIM_VERSION,
      name: opts.name ?? this.opts.name,
      mapId: opts.mapId,
      peaceTicks: opts.peaceTicks,
    });
  }

  joinLobby(code: string): Promise<LobbyInfo> {
    const c = normalizeCode(code);
    return this.open(c, { t: 'join', v: PROTOCOL_VERSION, code: c, simVersion: SIM_VERSION, name: this.opts.name });
  }

  /** Re-enter a running game after a page reload (code + token from LobbyInfo, e.g. sessionStorage). */
  rejoinLobby(code: string, token: string): Promise<LobbyInfo> {
    const c = normalizeCode(code);
    return this.open(c, { t: 'rejoin', v: PROTOCOL_VERSION, code: c, token });
  }

  /** Leave for good (no reconnect). The server keeps the seat for the grace period. */
  close() {
    this.fatal = true;
    this.clearTimers();
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setConn('closed');
  }

  /** Testing aid: kill the socket as if the network dropped (auto-reconnect follows). */
  debugDrop() {
    try {
      this.ws?.close(4001, 'drop');
    } catch {
      /* ignore */
    }
  }

  /** @internal */
  send(msg: ClientMsg) {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
    else if (msg.t === 'cmd' || msg.t === 'over') this.outbox.push(data); // flushed after rejoin
  }

  // ------------------------------------------------------------ internals

  private open(path: string, hello: ClientMsg): Promise<LobbyInfo> {
    if (this.pendingLobby) this.pendingLobby.reject(new Error('abgebrochen'));
    this.fatal = false;
    return new Promise<LobbyInfo>((resolve, reject) => {
      this.pendingLobby = { resolve, reject };
      this.dial(path, hello);
    });
  }

  private dial(path: string, hello: ClientMsg) {
    this.lastHello = hello.t;
    this.setConn(this.relay ? 'reconnecting' : 'connecting');
    const base = this.url.replace(/\/+$/, '');
    let ws: WsLike;
    try {
      ws = new this.Ws(`${base}/lobby/${path}`);
    } catch (e) {
      this.failLobby('Verbindung zum Server fehlgeschlagen');
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempts = 0;
      ws.send(JSON.stringify(hello));
      this.setConn('open');
      this.startPing();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data) as ServerMsg;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onerror = () => {
      /* close follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (!opened && !this.lobby) {
        this.failLobby('Server nicht erreichbar');
        this.setConn('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    const canRejoin = this.lobby && !this.fatal && !this.ended && this.opts.reconnect !== false;
    if (!canRejoin) {
      this.setConn('closed');
      return;
    }
    if (this.attempts === 0) this.dropAt = now();
    if (now() - this.dropAt > GRACE_MS + 5000) {
      this.setConn('closed');
      this.onError?.('Verbindung verloren', true);
      return;
    }
    this.setConn('reconnecting');
    const wait = Math.min(4000, 250 * 2 ** this.attempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const l = this.lobby!;
      this.dial(l.code, { t: 'rejoin', v: PROTOCOL_VERSION, code: l.code, token: l.token });
    }, wait);
  }

  private handle(msg: ServerMsg) {
    switch (msg.t) {
      case 'lobby': {
        const info: LobbyInfo = { code: msg.code, token: msg.token, you: msg.you };
        this.lobby = info;
        // flush commands queued while offline
        const out = this.outbox;
        this.outbox = [];
        for (const d of out) this.ws?.send(d);
        if (this.pendingLobby) {
          this.pendingLobby.resolve(info);
          this.pendingLobby = null;
        }
        this.onLobby?.(info);
        return;
      }
      case 'start': {
        if (this.relay) return; // reconnect of a live relay: keep state, history fills gaps
        const you = this.lobby?.you ?? 0;
        this.relay = new NetworkRelay(msg.config, you, this);
        this.peerConnected = true;
        this.onStart?.({ relay: this.relay, config: msg.config, you, startIn: msg.startIn, rejoined: this.lastHello === 'rejoin' });
        return;
      }
      case 'history':
        this.relay?.addHistory(msg.turns, msg.cmds);
        return;
      case 'turn':
        this.relay?.addTurn(msg.n, msg.cmds);
        return;
      case 'peer':
        if (this.peerConnected !== msg.connected) {
          this.peerConnected = msg.connected;
          this.onPeer?.(msg.connected);
        }
        return;
      case 'paused':
        this.paused = msg.paused;
        this.onPause?.(msg.paused, msg.graceMs);
        return;
      case 'desync':
        if (!this.desyncTicks.includes(msg.tick)) {
          this.desyncTicks.push(msg.tick);
          this.onDesync?.(msg.tick);
        }
        return;
      case 'end':
        this.ended = true;
        this.onEnd?.(msg.reason, msg.winner);
        return;
      case 'error':
        if (msg.fatal) this.fatal = true;
        if (this.pendingLobby && msg.fatal) this.failLobby(msg.reason);
        else this.onError?.(msg.reason, msg.fatal);
        return;
      case 'pong': {
        const sent = this.pingSent.get(msg.id);
        if (sent === undefined) return;
        this.pingSent.delete(msg.id);
        const rtt = now() - sent;
        this.ping = this.ping === 0 ? rtt : Math.round(this.ping * 0.7 + rtt * 0.3);
        this.delayTurns = delayForPing(this.ping);
        return;
      }
    }
  }

  private failLobby(reason: string) {
    if (this.pendingLobby) {
      this.pendingLobby.reject(new Error(reason));
      this.pendingLobby = null;
    }
    this.onError?.(reason, true);
  }

  private startPing() {
    this.stopPing();
    const every = this.opts.pingEvery ?? 2000;
    const fire = () => {
      const id = ++this.pingId;
      this.pingSent.set(id, now());
      if (this.pingSent.size > 10) this.pingSent.delete(this.pingSent.keys().next().value!);
      this.send({ t: 'ping', id });
    };
    fire();
    this.pingTimer = setInterval(fire, every);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers() {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setConn(s: ConnState) {
    if (this.connState === s) return;
    this.connState = s;
    this.onConnection?.(s);
  }
}
