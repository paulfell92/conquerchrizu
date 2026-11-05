/**
 * Last finished game (config + command log) in localStorage. Logs are small
 * (a few thousand commands), but we pack them compactly: commands are stored
 * as [tick, player, cmd] tuples, and the JSON is deflate-compressed + base64
 * when CompressionStream exists. Every storage access is guarded.
 */
import type { GameConfig, PlayerCommand } from '../sim/types';

const KEY = 'cc.replay.v1';

export interface StoredReplay {
  v: 1;
  config: GameConfig;
  log: PlayerCommand[];
  endTick: number;
  winner: number | null;
  /** Labels for the HUD, e.g. "Du" / "CPU · Verteidiger". */
  names: [string, string];
  savedAt: number;
}

interface Packed {
  v: 1;
  config: GameConfig;
  log: [number, number, unknown][];
  endTick: number;
  winner: number | null;
  names: [string, string];
  savedAt: number;
}

function pack(r: StoredReplay): string {
  const p: Packed = { ...r, log: r.log.map((c) => [c.tick, c.player, c.cmd]) };
  return JSON.stringify(p);
}
function unpack(json: string): StoredReplay | null {
  const p = JSON.parse(json) as Packed;
  if (!p || p.v !== 1 || !p.config || !Array.isArray(p.log)) return null;
  return {
    ...p,
    log: p.log.map(([tick, player, cmd]) => ({ tick, player: player as 0 | 1, cmd: cmd as PlayerCommand['cmd'] })),
  };
}

async function deflate(text: string): Promise<string | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CS('deflate-raw'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch {
    return null;
  }
}
async function inflate(b64: string): Promise<string | null> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) return null;
  try {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const stream = new Blob([buf]).stream().pipeThrough(new DS('deflate-raw'));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

export async function saveReplay(r: StoredReplay): Promise<boolean> {
  const json = pack(r);
  const z = await deflate(json);
  const value = z ? 'z:' + z : 'j:' + json;
  try {
    localStorage.setItem(KEY, value);
    return true;
  } catch {
    return false;
  }
}

export async function loadReplay(): Promise<StoredReplay | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    if (raw.startsWith('z:')) {
      const json = await inflate(raw.slice(2));
      return json ? unpack(json) : null;
    }
    if (raw.startsWith('j:')) return unpack(raw.slice(2));
  } catch {
    /* corrupt */
  }
  return null;
}

export function hasReplay(): boolean {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}
