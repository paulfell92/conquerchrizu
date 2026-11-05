/** Integer math helpers (deterministic, no Math.sqrt / trig). */

/** floor(sqrt(n)) for integers 0 <= n < 2^53. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  if (n < 4) return 1;
  let x = 1;
  while (x * x < n) x *= 2; // x >= sqrt(n)
  let y = Math.floor((x + Math.floor(n / x)) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return isqrt(dist2(ax, ay, bx, by));
}

/**
 * Octant 0..7 of a direction vector, screen coordinates (y down):
 * 0 = east, 1 = south-east, 2 = south, 3 = south-west, 4 = west,
 * 5 = north-west, 6 = north, 7 = north-east. Returns -1 for a zero vector.
 */
export function octant(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return -1;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  // tan(22.5°) ≈ 0.4142
  if (ay * 1000 <= ax * 414) return dx > 0 ? 0 : 4;
  if (ax * 1000 <= ay * 414) return dy > 0 ? 2 : 6;
  if (dx > 0) return dy > 0 ? 1 : 7;
  return dy > 0 ? 3 : 5;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
