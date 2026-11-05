import type { Resources } from '../sim/types';
import { TICK_RATE } from '../sim/types';
import { RESOURCE_NAMES } from '../content';

/** Small seeded PRNG for cosmetic randomness (terrain decoration). Never used for game state. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function formatClock(tick: number): string {
  const s = Math.floor(tick / TICK_RATE);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function costParts(c: Resources): { k: keyof Resources; v: number }[] {
  const out: { k: keyof Resources; v: number }[] = [];
  if (c.food) out.push({ k: 'food', v: c.food });
  if (c.wood) out.push({ k: 'wood', v: c.wood });
  if (c.gold) out.push({ k: 'gold', v: c.gold });
  return out;
}

export function costText(c: Resources): string {
  return costParts(c)
    .map((p) => `${p.v} ${RESOURCE_NAMES[p.k]}`)
    .join(', ');
}

/** Parse "#rrggbb" to [r,g,b]. */
export function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shade(hex: string, f: number): string {
  const [r, g, b] = hexRgb(hex);
  const m = (v: number) => Math.round(clamp(f < 0 ? v * (1 + f) : v + (255 - v) * f, 0, 255));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export const isTouchDevice = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
