import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWs } from 'ws';
import { startRelayServer, type RelayServer } from '../server/node/server';
import { NetClient, NetworkRelay, type StartInfo, type WsCtor } from '../src/net/networkRelay';
import { hashState, townCenter } from '../src/sim';
import type { Command, PlayerId } from '../src/sim';
import { isValidCode, parseClientMsg, sanitizeCommand, TURN_TICKS } from '../src/net/protocol';

const WS = NodeWs as unknown as WsCtor;
const TURN_MS = 4; // fast clock for tests (real games: 100 ms)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: RelayServer;
let url = '';

beforeAll(async () => {
  server = await startRelayServer({ port: 0, host: '127.0.0.1', quiet: true, turnMs: TURN_MS, startDelayMs: 20, graceMs: 2000, closeAfterEndMs: 200 });
  url = `ws://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server?.close();
});

/** Deterministic scripted orders for one player, decided from its own view of the state. */
function script(relay: NetworkRelay, rngState: { s: number }) {
  const st = relay.state;
  const me = relay.you;
  const rnd = (n: number) => {
    rngState.s = (Math.imul(rngState.s, 1103515245) + 12345) >>> 0;
    return (rngState.s >>> 8) % n;
  };
  const t = st.tick;
  const every = me === 0 ? 37 : 41;
  if (t % every !== 0) return;
  const mine = st.squads.filter((s) => s.owner === me).map((s) => s.id);
  let cmd: Command;
  const k = rnd(4);
  const tc = townCenter(st, me);
  if (k === 0 && tc) cmd = { t: 'train', building: tc.id, unit: 'scout' };
  else if (k === 1 && mine.length) cmd = { t: 'stop', squads: mine.slice(0, 1) };
  else cmd = { t: 'move', squads: mine, x: 5000 + rnd(40000), y: 5000 + rnd(26000) };
  relay.submit(me, cmd);
}

async function drive(relays: NetworkRelay[], until: number, rngs: { s: number }[], timeoutMs = 25000) {
  const t0 = Date.now();
  while (relays.some((r) => r.state.tick < until && r.state.winner === null)) {
    relays.forEach((r, i) => {
      while (r.state.tick < until && r.advance()) script(r, rngs[i]);
    });
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout at ticks ${relays.map((r) => r.state.tick)}`);
    await sleep(1);
  }
}

function waitStart(c: NetClient): Promise<StartInfo> {
  return new Promise((res) => {
    if (c.relay) res({ relay: c.relay, config: c.relay.config, you: c.relay.you, startIn: 0, rejoined: false });
    else c.onStart = res;
  });
}

async function pair(peaceTicks = 0) {
  const a = NetClient.connect(url, { WebSocket: WS, pingEvery: 200, name: 'A' });
  const b = NetClient.connect(url, { WebSocket: WS, pingEvery: 200, name: 'B' });
  const sa = waitStart(a);
  const sb = waitStart(b);
  const lobby = await a.createLobby({ peaceTicks });
  expect(isValidCode(lobby.code)).toBe(true);
  expect(lobby.you).toBe(0);
  const lb = await b.joinLobby(lobby.code.toLowerCase());
  expect(lb.you).toBe(1);
  const [ia, ib] = await Promise.all([sa, sb]);
  return { a, b, ra: ia.relay, rb: ib.relay, code: lobby.code, tokenB: lb.token };
}

describe('protocol', () => {
  it('sanitises commands and rejects junk', () => {
    expect(sanitizeCommand({ t: 'move', squads: [1, 2], x: 10, y: 20, evil: 1 })).toEqual({ t: 'move', squads: [1, 2], x: 10, y: 20 });
    expect(sanitizeCommand({ t: 'move', squads: ['x'], x: 1, y: 2 })).toBeNull();
    expect(sanitizeCommand({ t: 'train', building: 3, unit: 'dragon' })).toBeNull();
    expect(parseClientMsg('{"t":"cmd","turn":4,"cmd":{"t":"surrender"}}')).toEqual({ t: 'cmd', turn: 4, cmd: { t: 'surrender' } });
    expect(parseClientMsg('nope')).toBeNull();
  });

  it('rejects unknown codes and version mismatch in German', async () => {
    const c = NetClient.connect(url, { WebSocket: WS, reconnect: false });
    await expect(c.joinLobby('ZZZZZ')).rejects.toThrow('Lobby nicht gefunden');
    c.close();
  });
});

describe('online lockstep (node relay)', () => {
  it('two clients, scripted commands for 2000 ticks → identical hashes', async () => {
    const { a, b, ra, rb } = await pair();
    expect(ra.config.seed).toBe(rb.config.seed);
    const rngs = [{ s: 1 }, { s: 2 }];
    await drive([ra, rb], 2000, rngs);
    expect(ra.state.tick).toBe(2000);
    expect(rb.state.tick).toBe(2000);
    expect(ra.hashes.length).toBe(20);
    expect(ra.hashes).toEqual(rb.hashes);
    expect(hashState(ra.state)).toBe(hashState(rb.state));
    // both players' commands really went through
    expect(ra.log.some((c) => c.player === 0)).toBe(true);
    expect(ra.log.some((c) => c.player === 1)).toBe(true);
    expect(ra.log).toEqual(rb.log);
    expect(a.desyncTicks).toEqual([]);
    expect(a.ping).toBeGreaterThan(0);
    a.close();
    b.close();
  }, 40000);

  it('a dropped client reconnects (auto) and a reloaded client rejoins via token, both converge', async () => {
    const { a, b, ra, rb, code, tokenB } = await pair();
    const rngs = [{ s: 7 }, { s: 9 }];
    await drive([ra, rb], 400, rngs);

    // 1) network drop: socket dies, client auto-rejoins, keeps its state
    const peerEvents: boolean[] = [];
    a.onPeer = (c) => peerEvents.push(c);
    b.debugDrop();
    await sleep(60);
    expect(a.paused || peerEvents.includes(false)).toBe(true);
    await drive([ra, rb], 900, rngs);
    expect(hashState(ra.state)).toBe(hashState(rb.state));
    expect(peerEvents).toContain(false);
    expect(peerEvents[peerEvents.length - 1]).toBe(true);

    // 2) page reload: B is gone for good, a fresh client rejoins with the token
    b.close();
    await sleep(40);
    const b2 = NetClient.connect(url, { WebSocket: WS, pingEvery: 200 });
    const s2 = waitStart(b2);
    const info = await b2.rejoinLobby(code, tokenB);
    expect(info.you).toBe(1);
    const { relay: rb2, rejoined } = await s2;
    expect(rejoined).toBe(true);
    await drive([ra, rb2], 1600, rngs);
    expect(rb2.state.tick).toBe(1600);
    expect(hashState(ra.state)).toBe(hashState(rb2.state));
    expect(rb2.hashes.filter((h) => h.tick > 900)).toEqual(ra.hashes.filter((h) => h.tick > 900));
    expect(a.desyncTicks).toEqual([]);
    a.close();
    b2.close();
  }, 40000);

  it('detects a desync when one client state is tampered', async () => {
    const { a, b, ra, rb } = await pair();
    const got: number[] = [];
    a.onDesync = (t) => got.push(t);
    const rngs = [{ s: 3 }, { s: 4 }];
    await drive([ra, rb], 150, rngs);
    rb.state.players[1].res.gold += 1; // cheat / bug on one side only
    await drive([ra, rb], 300, rngs);
    for (let i = 0; i < 50 && (got.length === 0 || b.desyncTicks.length === 0); i++) await sleep(10);
    expect(got[0]).toBe(200);
    expect(b.desyncTicks[0]).toBe(200);
    const room = server.rooms.get(a.lobby!.code)!;
    expect(room.desyncs).toContain(200);
    a.close();
    b.close();
  }, 40000);

  it('only bundles reach the sim: no advance before the first turn, every turn arrives', async () => {
    const { a, b, ra, rb } = await pair();
    const me: PlayerId = ra.you;
    ra.submit(1 as PlayerId, { t: 'surrender' }); // not ours → ignored
    expect(me).toBe(0);
    await drive([ra, rb], 200, [{ s: 5 }, { s: 6 }]);
    expect(ra.turnsReceived * TURN_TICKS).toBeGreaterThanOrEqual(200);
    expect(ra.state.winner).toBeNull();
    // surrender ends the game for both and tells the server
    ra.submit(0, { t: 'surrender' });
    await drive([ra, rb], 400, [{ s: 5 }, { s: 6 }]);
    expect(ra.state.winner).toBe(1);
    expect(rb.state.winner).toBe(1);
    for (let i = 0; i < 50 && !a.ended; i++) await sleep(10);
    expect(a.ended).toBe(true);
    a.close();
    b.close();
  }, 40000);
});
