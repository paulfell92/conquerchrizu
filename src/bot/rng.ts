/**
 * The bot's own seeded RNG (mulberry32). Never Math.random: bot-vs-bot runs
 * must be reproducible from (sim seed, bot seed).
 */
export class BotRng {
  private s: number;

  constructor(seed: number) {
    this.s = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
    if (this.s === 0) this.s = 0x1234567;
  }

  /** Float in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Multiplicative noise factor in [1 - amp, 1 + amp]. */
  noise(amp: number): number {
    return amp <= 0 ? 1 : 1 + amp * (2 * this.next() - 1);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
}

/** Small integer hash, used to derive a personality from a seed. */
export function hashSeed(seed: number): number {
  let h = Math.trunc(seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
