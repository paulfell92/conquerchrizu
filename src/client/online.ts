/**
 * Online play controller: lobby UI state, starting the match on a
 * NetworkRelay, disconnect / desync overlays. Talks to the network agent's
 * module (src/net/networkRelay.ts) through a small adapter so the client
 * keeps building while that module evolves. If the module or a relay URL is
 * missing, online play is shown as unavailable.
 */
import type { Hud } from './hud/hud';
import type { Menus } from './hud/menus';
import type { Session, SessionOptions } from './session';
import { NetClient, onlineAvailable, relayUrl, type NetworkRelay } from '../net/networkRelay';
import { prefs } from './prefs';

interface Deps {
  hud(): Hud;
  menus(): Menus;
  startOnline(opts: SessionOptions, names: [string, string]): void;
  session(): Session | null;
  toMenu(): void;
}

export class OnlineController {
  private client: NetClient | null = null;
  private relay: NetworkRelay | null = null;
  private inGame = false;
  private pausedUntil = 0;
  private peerGone = false;
  private desynced = false;
  private reconnecting = false;

  constructor(private d: Deps) {}

  get available(): boolean {
    try {
      return onlineAvailable();
    } catch {
      return false;
    }
  }

  /** Current smoothed ping (ms) or undefined before the first measurement. */
  get ping(): number | undefined {
    return this.client && this.client.ping > 0 ? this.client.ping : undefined;
  }

  private connect(): NetClient | null {
    this.leave();
    try {
      const c = NetClient.connect(relayUrl(), { name: 'Spieler' });
      c.onLobby = (info) => {
        if (!this.inGame) this.d.menus().setOnline({ phase: 'waiting', code: info.code, ping: this.ping });
      };
      c.onStart = (info) => {
        this.inGame = true;
        this.relay = info.relay;
        const names: [string, string] = info.you === 0 ? ['Du', 'Gegner'] : ['Gegner', 'Du'];
        const relay = info.relay;
        this.d.startOnline({ config: info.config, relay: () => relay, me: info.you, noBot: true, online: true }, names);
        if (info.startIn > 0) this.d.hud().toast(`Spiel startet in ${Math.ceil(info.startIn / 1000)} s`, 'info', 'clock');
      };
      c.onPeer = (connected) => {
        this.peerGone = !connected;
        if (connected) this.pausedUntil = 0;
      };
      c.onPause = (paused, graceMs) => {
        this.pausedUntil = paused ? performance.now() + graceMs : 0;
        this.peerGone = paused;
      };
      c.onDesync = () => {
        this.desynced = true;
      };
      c.onEnd = (reason) => {
        if (reason === 'abandoned' && !this.d.session()?.over) this.d.hud().toast('Gegner hat das Spiel verlassen', 'warn', 'alert');
      };
      c.onError = (reason, fatal) => {
        if (!this.inGame) this.d.menus().setOnline({ phase: 'error', msg: reason });
        else if (fatal) this.d.hud().toast(reason, 'warn', 'alert');
      };
      c.onConnection = (st) => {
        this.reconnecting = st === 'reconnecting';
      };
      this.client = c;
      return c;
    } catch (e) {
      this.d.menus().setOnline({ phase: 'error', msg: (e as Error).message || 'Verbindung fehlgeschlagen.' });
      return null;
    }
  }

  create() {
    if (!this.available) return;
    this.d.menus().setOnline({ phase: 'creating' });
    const c = this.connect();
    if (!c) return;
    c.createLobby({ name: 'Spieler', peaceTicks: prefs.peaceMin * 60 * 20 }).catch((e: Error) => {
      if (this.client === c && !this.inGame) this.d.menus().setOnline({ phase: 'error', msg: e?.message || 'Lobby konnte nicht erstellt werden.' });
    });
  }

  join(code: string) {
    if (!this.available) return;
    const k = code.trim().toUpperCase();
    if (k.length !== 5) {
      this.d.menus().setOnline({ phase: 'error', msg: 'Der Code hat 5 Zeichen.' });
      return;
    }
    this.d.menus().setOnline({ phase: 'joining' });
    const c = this.connect();
    if (!c) return;
    c.joinLobby(k).catch((e: Error) => {
      if (this.client === c && !this.inGame) this.d.menus().setOnline({ phase: 'error', msg: e?.message || 'Beitreten fehlgeschlagen.' });
    });
  }

  cancel() {
    this.leave();
  }

  /** Close any lobby / connection (menu, new game). */
  leave() {
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.relay = null;
    this.inGame = false;
    this.peerGone = false;
    this.desynced = false;
    this.pausedUntil = 0;
  }

  action(id: string) {
    if (id === 'menu') this.d.toMenu();
    if (id === 'dismiss') this.desynced = false;
  }

  private pingTimer = 0;

  /** Per frame: lobby ping display; in game: catch-up and overlays. */
  frame(now: number) {
    const m = this.d.menus();
    if (!this.inGame && this.client && (m.online.phase === 'waiting' || m.online.phase === 'creating' || m.online.phase === 'joining')) {
      if (now - this.pingTimer > 1000 && this.ping !== undefined) {
        this.pingTimer = now;
        m.setOnline({ ...m.online, ping: this.ping });
      }
    }
    const s = this.d.session();
    if (!s?.online || !this.inGame) return;
    const hud = this.d.hud();
    // catch up if far behind (tab was hidden, rejoin)
    const r = this.relay;
    if (r && r.ticksBehind > 8) r.fastForward(r.ticksBehind - 4, 8);
    hud.setPing(this.ping);
    if (s.over) {
      hud.setNetOverlay(null);
      return;
    }
    if (this.peerGone) {
      const left = this.pausedUntil ? Math.max(0, Math.ceil((this.pausedUntil - now) / 1000)) : null;
      hud.setNetOverlay({
        title: 'Gegner getrennt',
        text: left !== null ? `Das Spiel ist pausiert. Kommt er nicht in ${left} s zurück, gewinnst du.` : 'Warte auf die Verbindung des Gegners …',
        buttons: [{ id: 'menu', label: 'Zum Menü' }],
      });
      return;
    }
    if (this.reconnecting) {
      hud.setNetOverlay({ title: 'Verbindung unterbrochen', text: 'Verbinde neu …', buttons: [{ id: 'menu', label: 'Zum Menü' }] });
      return;
    }
    if (this.desynced) {
      hud.setNetOverlay({
        title: 'Spielstände weichen ab',
        text: 'Die beiden Spiele laufen nicht mehr gleich. Das Ergebnis zählt eventuell nicht.',
        buttons: [
          { id: 'dismiss', label: 'Weiterspielen', primary: true },
          { id: 'menu', label: 'Zum Menü' },
        ],
      });
      return;
    }
    hud.setNetOverlay(null);
  }
}
