/** Read-only helpers: visibility, hashing, cloning, clock. */
import { BUILDINGS, UNITS } from '../content';
import type { GameState, PlayerId } from './types';
import { TICK_RATE, TILE } from './types';

const OWNED_POINT_SIGHT = 4000;

function stamp(vis: number[], W: number, H: number, cx: number, cy: number, r: number): void {
  const r2 = r * r;
  const tx0 = Math.max(0, Math.floor((cx - r) / TILE));
  const tx1 = Math.min(W - 1, Math.floor((cx + r) / TILE));
  const ty0 = Math.max(0, Math.floor((cy - r) / TILE));
  const ty1 = Math.min(H - 1, Math.floor((cy + r) / TILE));
  for (let ty = ty0; ty <= ty1; ty++) {
    const dy = ty * TILE + 500 - cy;
    const dy2 = dy * dy;
    if (dy2 > r2) continue;
    const row = ty * W;
    for (let tx = tx0; tx <= tx1; tx++) {
      const dx = tx * TILE + 500 - cx;
      if (dx * dx + dy2 <= r2) vis[row + tx] = 1;
    }
  }
}

export function visibility(state: GameState, player: PlayerId): number[] {
  const W = state.mapW;
  const H = state.mapH;
  const vis: number[] = new Array(W * H).fill(0);
  for (const s of state.squads) if (s.owner === player && s.hp > 0) stamp(vis, W, H, s.x, s.y, UNITS[s.kind].sight);
  for (const b of state.buildings) if (b.owner === player) stamp(vis, W, H, b.x, b.y, BUILDINGS[b.kind].sight);
  for (const p of state.points) if (p.owner === player) stamp(vis, W, H, p.x, p.y, OWNED_POINT_SIGHT);
  return vis;
}

// ---------------------------------------------------------------- hashing

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over a canonical serialisation: JSON with object keys sorted, the
 * top-level `events` field excluded, `undefined` fields skipped.
 */
export function hash(state: GameState): number {
  let h = FNV_OFFSET;
  const feedStr = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h ^= c & 0xff;
      h = Math.imul(h, FNV_PRIME);
      h ^= c >>> 8;
      h = Math.imul(h, FNV_PRIME);
    }
  };
  const walk = (v: unknown, top: boolean) => {
    if (v === null) {
      feedStr('n');
      return;
    }
    switch (typeof v) {
      case 'number':
        feedStr('#' + String(v) + ';');
        return;
      case 'string':
        feedStr('"' + v + '"');
        return;
      case 'boolean':
        feedStr(v ? 't' : 'f');
        return;
      case 'object': {
        if (Array.isArray(v)) {
          feedStr('[');
          for (const e of v) walk(e, false);
          feedStr(']');
          return;
        }
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o).sort();
        feedStr('{');
        for (const k of keys) {
          if (top && k === 'events') continue;
          const val = o[k];
          if (val === undefined) continue;
          feedStr(k + ':');
          walk(val, false);
        }
        feedStr('}');
        return;
      }
      default:
        return;
    }
  };
  walk(state, true);
  return h >>> 0;
}

export function clone(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

export function clock(tick: number): string {
  const total = Math.max(0, Math.floor(tick / TICK_RATE));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}
