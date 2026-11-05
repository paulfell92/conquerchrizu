/**
 * Cloudflare host for the relay: a stateless Worker routes each lobby code to
 * its own Durable Object (`LobbyRoom`), which runs the shared Room core.
 *
 * Turn clock: plain setInterval inside the Durable Object. We use the standard
 * (non-hibernating) WebSocket API on purpose: a running match needs a 10 Hz
 * clock and in-memory state anyway, so hibernation would buy nothing; the
 * object stays alive while sockets are open and is evicted after the room
 * closes. One room ≈ one match ≈ a few minutes of DO duration.
 *
 * Routes: GET /lobby/new (WebSocket upgrade, creates a code),
 *         GET /lobby/<CODE> (join / rejoin), GET /health.
 */
import { Room, randomCode, type RoomHost } from '../../core/room';
import { ERR, isValidCode, normalizeCode } from '../../../src/net/protocol';
import type { DurableObjectNamespace, DurableObjectState, CfWebSocket } from './cf';

export interface Env {
  LOBBY: DurableObjectNamespace;
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'conquerchrizu-relay' }), {
        headers: { 'content-type': 'application/json', ...CORS },
      });
    }
    const m = /^\/lobby\/([A-Za-z0-9]+)$/.exec(path);
    if (!m) return new Response('not found', { status: 404, headers: CORS });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426, headers: CORS });
    }
    if (m[1].toLowerCase() === 'new') {
      // Pick a free code: the DO answers 409 if its room is already in use.
      for (let i = 0; i < 8; i++) {
        const code = randomCode();
        const res = await forward(env, code, req, true);
        if (res.status !== 409) return res;
      }
      return new Response('no free code', { status: 503, headers: CORS });
    }
    const code = normalizeCode(m[1]);
    if (!isValidCode(code)) return rejectSocket(ERR.notFound);
    return forward(env, code, req, false);
  },
};

function forward(env: Env, code: string, req: Request, create: boolean): Promise<Response> {
  const stub = env.LOBBY.get(env.LOBBY.idFromName(code));
  const headers = new Headers(req.headers);
  headers.set('X-Lobby-Code', code);
  headers.set('X-Lobby-Create', create ? '1' : '0');
  return stub.fetch(new Request(req.url, { headers, method: 'GET' }));
}

/** Accept the socket only to tell the client why, then close it. */
function rejectSocket(reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.send(JSON.stringify({ t: 'error', reason, fatal: true }));
  server.close(4004, 'not found');
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

export class LobbyRoom {
  private room: Room | null = null;
  private host: RoomHost;

  constructor(_state: DurableObjectState, _env: Env) {
    this.host = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        return () => clearTimeout(h);
      },
      setInterval: (fn, ms) => {
        const h = setInterval(fn, ms);
        return () => clearInterval(h);
      },
      log: (msg, data) => (data === undefined ? console.log(msg) : console.log(msg, JSON.stringify(data))),
      onClosed: (r) => {
        if (this.room === r) this.room = null;
      },
    };
  }

  async fetch(req: Request): Promise<Response> {
    const code = req.headers.get('X-Lobby-Code') ?? '';
    const create = req.headers.get('X-Lobby-Create') === '1';
    if (create) {
      if (this.room && !this.room.closed && !this.room.vacant) return new Response('taken', { status: 409 });
      if (!this.room || this.room.closed) this.room = new Room(code, this.host);
    }
    const room = this.room;
    if (!room || room.closed) return rejectSocket(ERR.notFound);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const handle = room.attach({
      send: (d) => server.send(d),
      close: (c, r) => server.close(c ?? 1000, r ?? ''),
    });
    server.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') handle.message(ev.data);
    });
    server.addEventListener('close', () => handle.closed());
    server.addEventListener('error', () => handle.closed());
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
}

// Workers global (declared in ./cf.ts types)
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };
