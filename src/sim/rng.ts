/** Seeded RNG (mulberry32) whose whole state is the uint32 `GameState.rng`. */
import type { GameState } from './types';

export function seedRng(seed: number): number {
  // mix the seed so small seeds still give well spread states
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Next uint32 from the state's RNG (advances state.rng). */
export function nextRng(state: GameState): number {
  const a = (state.rng + 0x6d2b79f5) >>> 0;
  state.rng = a;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Uniform integer in [0, n). */
export function rngInt(state: GameState, n: number): number {
  return n <= 1 ? 0 : nextRng(state) % n;
}
