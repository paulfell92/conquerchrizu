/**
 * Plain Node relay host (ws). For local testing (`npm run relay`) and simple
 * hosting on Render / Fly / a VPS. All rooms live in memory.
 *
 *   PORT=8787 npm run relay
 *
 * Routes: ws://host/lobby/new (create), ws://host/lobby/<CODE> (join/rejoin),
 * GET /health → JSON status.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, randomCode, type RoomHost, type RoomOptions } from '../core/room';
import { ERR, isValidCode, normalizeCode } from '../../src/net/protocol';

export interface RelayServerOptions extends RoomOptions {
  port?: number;
  host?: string;
  quiet?: boolean;
}

export interface RelayServer {
  readonly port: number;
  readonly rooms: Map<string, Room>;
  readonly http: Server;
  close(): Promise<void>;
}

export function startRelayServer(opts: RelayServerOptions = {}): Promise<RelayServer> {
  const rooms = new Map<string, Room>();
  const log = (msg: string, data?: unknown) => {
    if (opts.quiet) return;
    const ts = new Date().toISOString();
    if (data === undefined) console.log(`${ts} ${msg}`);
    else console.log(`${ts} ${msg}`, data);
  };
  const host: RoomHost = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      return () => clearTimeout(h);
    },
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      return () => clearInterval(h);
    },
    log,
    onClosed: (room) => {
      if (rooms.get(room.code) === room) rooms.delete(room.code);
    },
  };

  const http = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, list: [...rooms.values()].map((r) => r.info()) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/\/+$/, '');
    const m = /^\/lobby\/([A-Za-z0-9]+)$/.exec(path);
    if (!m) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let room: Room | undefined;
      if (m[1].toLowerCase() === 'new') {
        let code = randomCode();
        while (rooms.has(code)) code = randomCode();
        room = new Room(code, host, opts);
        rooms.set(code, room);
      } else {
        const code = normalizeCode(m[1]);
        room = isValidCode(code) ? rooms.get(code) : undefined;
      }
      if (!room || room.closed) {
        ws.send(JSON.stringify({ t: 'error', reason: ERR.notFound, fatal: true }));
        ws.close(4004, 'not found');
        return;
      }
      bind(ws, room);
    });
  });

  function bind(ws: WebSocket, room: Room) {
    const handle = room.attach({
      send: (d) => ws.send(d),
      close: (code, reason) => ws.close(code, reason),
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      handle.message(data.toString());
    });
    ws.on('close', () => handle.closed());
    ws.on('error', () => {
      /* close follows */
    });
  }

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 8787, opts.host ?? '0.0.0.0', () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 8787;
      log(`Conquer Chrizu relay on ws://localhost:${port}`);
      resolve({
        port,
        rooms,
        http,
        close: () =>
          new Promise<void>((done) => {
            for (const r of [...rooms.values()]) r.close('server stop');
            for (const c of wss.clients) c.terminate();
            wss.close();
            http.close(() => done());
            http.closeAllConnections?.();
          }),
      });
    });
  });
}

// CLI entry: `tsx server/node/server.ts`
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return import.meta.url === new URL(`file://${argv1}`).href || /server[\\/]node[\\/]server\.ts$/.test(argv1);
  } catch {
    return false;
  }
})();
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  startRelayServer({ port }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
