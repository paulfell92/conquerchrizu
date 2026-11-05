/**
 * A* on the tile grid: 8-neighbour, no corner cutting, octile costs 10/14.
 * Scratch buffers are module-level typed arrays (NOT part of the state) and are
 * fully reset per search via a generation counter, so results are deterministic.
 */
import type { GameState, Vec } from './types';
import { TILE } from './types';

let cap = 0;
let gScore = new Int32Array(0);
let parent = new Int32Array(0);
let seenGen = new Uint32Array(0);
let closedGen = new Uint32Array(0);
let heapNode = new Int32Array(0);
let heapF = new Int32Array(0);
let gen = 0;

function ensure(n: number): void {
  if (n <= cap) return;
  cap = n;
  gScore = new Int32Array(n);
  parent = new Int32Array(n);
  seenGen = new Uint32Array(n);
  closedGen = new Uint32Array(n);
  heapNode = new Int32Array(n * 8 + 16);
  heapF = new Int32Array(n * 8 + 16);
  gen = 0;
}

export function tileOf(v: number): number {
  return Math.floor(v / TILE);
}

/**
 * Tile column of an x coordinate, mirror-symmetric: a point exactly on a
 * vertical tile border belongs to the column closer to the map center.
 */
export function tileColSym(state: GameState, x: number): number {
  const tx = Math.floor(x / TILE);
  if (x - tx * TILE !== 0 || tx === 0) return tx;
  const mid2 = state.mapW - 1; // 2 * center column
  const da = 2 * (tx - 1) - mid2;
  const db = 2 * tx - mid2;
  return (da < 0 ? -da : da) < (db < 0 ? -db : db) ? tx - 1 : tx;
}

export function tileCenter(t: number): number {
  return t * TILE + (TILE >> 1);
}

/** Strictly inside the map (0 and W*TILE excluded) so the bounds are mirror-symmetric (x -> W*TILE - x). */
export function inBounds(state: GameState, x: number, y: number): boolean {
  return x > 0 && y > 0 && x < state.mapW * TILE && y < state.mapH * TILE;
}

export function tileBlocked(state: GameState, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= state.mapW || ty >= state.mapH) return true;
  return state.blocked[ty * state.mapW + tx] !== 0;
}

/**
 * A point exactly on a tile border belongs to BOTH tiles and is walkable only
 * if both are, so walkability is mirror-symmetric (floor() alone would favour
 * the right/lower tile).
 */
export function walkable(state: GameState, x: number, y: number): boolean {
  if (!inBounds(state, x, y)) return false;
  const W = state.mapW;
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  const b = state.blocked;
  if (b[ty * W + tx] !== 0) return false;
  const ex = x - tx * TILE === 0;
  const ey = y - ty * TILE === 0;
  if (ex && b[ty * W + tx - 1] !== 0) return false;
  if (ey && b[(ty - 1) * W + tx] !== 0) return false;
  if (ex && ey && b[(ty - 1) * W + tx - 1] !== 0) return false;
  return true;
}

/** Walkable with a small clearance box around the point (used for straight-line checks). */
function clearAt(state: GameState, x: number, y: number, c: number): boolean {
  return (
    walkable(state, x - c, y - c) &&
    walkable(state, x + c, y - c) &&
    walkable(state, x - c, y + c) &&
    walkable(state, x + c, y + c)
  );
}

/** True if a straight segment stays on walkable tiles (sampled, with clearance). */
export function lineWalkable(state: GameState, ax: number, ay: number, bx: number, by: number, clearance = 150): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;
  const len = adx > ady ? adx : ady;
  const steps = Math.trunc(len / 125) + 1;
  for (let i = 0; i <= steps; i++) {
    const x = ax + Math.trunc((dx * i) / steps);
    const y = ay + Math.trunc((dy * i) / steps);
    if (!clearAt(state, x, y, clearance)) {
      // the endpoints only need to be walkable themselves (start may hug a wall)
      if ((i === 0 || i === steps) && walkable(state, x, y)) continue;
      return false;
    }
  }
  return true;
}

/**
 * Nearest walkable tile (center) to a world position. Ties: closer to the
 * vertical map center line (mirror-invariant), then smaller y, then smaller x
 * (only reached for queries exactly on the center line).
 */
export function nearestWalkable(state: GameState, x: number, y: number): Vec {
  const Wm = state.mapW * TILE;
  const cx = Math.min(Math.max(x, 1), Wm - 1);
  const cy = Math.min(Math.max(y, 1), state.mapH * TILE - 1);
  if (walkable(state, cx, cy)) return { x: cx, y: cy };
  const tx = tileColSym(state, cx);
  const ty = tileOf(cy);
  const maxR = state.mapW > state.mapH ? state.mapW : state.mapH;
  for (let r = 1; r <= maxR; r++) {
    let best = -1;
    let bestD = 0;
    let bestC = 0;
    let bx = 0;
    let by = 0;
    for (let yy = ty - r; yy <= ty + r; yy++) {
      for (let xx = tx - r; xx <= tx + r; xx++) {
        if (yy !== ty - r && yy !== ty + r && xx !== tx - r && xx !== tx + r) continue;
        if (tileBlocked(state, xx, yy)) continue;
        const px = tileCenter(xx);
        const py = tileCenter(yy);
        const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        const c = 2 * px > Wm ? 2 * px - Wm : Wm - 2 * px;
        if (best < 0 || d < bestD || (d === bestD && c < bestC)) {
          best = 1;
          bestD = d;
          bestC = c;
          bx = px;
          by = py;
        }
      }
    }
    if (best >= 0) return { x: bx, y: by };
  }
  return { x: cx, y: cy };
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? 14 * dy + 10 * (dx - dy) : 14 * dx + 10 * (dy - dx);
}

const NX = [1, 0, -1, 0, 1, -1, -1, 1];
const NY = [0, 1, 0, -1, 1, 1, -1, -1];

/**
 * Raw A*: tile indices from start (exclusive) to goal (inclusive), or null.
 * Side symmetry: the search runs in a canonical frame where the goal is never
 * left of the start (x mirrored otherwise), so mirrored queries explore and
 * break ties identically and return exactly mirrored paths.
 */
export function astar(state: GameState, rsx: number, sy: number, rgx: number, gy: number): number[] | null {
  const W = state.mapW;
  const H = state.mapH;
  const flip = rgx < rsx || (rgx === rsx && 2 * rsx > W - 1);
  const sx = flip ? W - 1 - rsx : rsx;
  const gx = flip ? W - 1 - rgx : rgx;
  const n = W * H;
  ensure(n);
  gen++;
  if (gen >= 0xfffffff0) {
    seenGen.fill(0);
    closedGen.fill(0);
    gen = 1;
  }
  const start = sy * W + sx;
  const goal = gy * W + gx;
  if (start === goal) return [];
  const blocked = state.blocked;
  let hs = 0;
  const push = (node: number, f: number) => {
    let i = hs++;
    heapNode[i] = node;
    heapF[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      // tie-break on node index for determinism
      if (heapF[p] < heapF[i] || (heapF[p] === heapF[i] && heapNode[p] <= heapNode[i])) break;
      const tn = heapNode[p];
      const tf = heapF[p];
      heapNode[p] = heapNode[i];
      heapF[p] = heapF[i];
      heapNode[i] = tn;
      heapF[i] = tf;
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapNode[0];
    hs--;
    if (hs > 0) {
      heapNode[0] = heapNode[hs];
      heapF[0] = heapF[hs];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < hs && (heapF[l] < heapF[m] || (heapF[l] === heapF[m] && heapNode[l] < heapNode[m]))) m = l;
        if (r < hs && (heapF[r] < heapF[m] || (heapF[r] === heapF[m] && heapNode[r] < heapNode[m]))) m = r;
        if (m === i) break;
        const tn = heapNode[m];
        const tf = heapF[m];
        heapNode[m] = heapNode[i];
        heapF[m] = heapF[i];
        heapNode[i] = tn;
        heapF[i] = tf;
        i = m;
      }
    }
    return top;
  };
  gScore[start] = 0;
  seenGen[start] = gen;
  parent[start] = -1;
  push(start, heuristic(sx, sy, gx, gy));
  while (hs > 0) {
    const cur = pop();
    if (closedGen[cur] === gen) continue;
    closedGen[cur] = gen;
    if (cur === goal) {
      const out: number[] = [];
      let c = goal;
      while (c !== start) {
        if (flip) {
          const cx0 = c % W;
          out.push(c - cx0 + (W - 1 - cx0));
        } else out.push(c);
        c = parent[c];
      }
      out.reverse();
      return out;
    }
    const cx = cur % W;
    const cy = (cur - cx) / W;
    const g = gScore[cur];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k];
      const ny = cy + NY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      const rnx = flip ? W - 1 - nx : nx;
      if (blocked[ny * W + rnx] !== 0) continue;
      if (k >= 4) {
        // no corner cutting
        const rcx = flip ? W - 1 - cx : cx;
        if (blocked[cy * W + rnx] !== 0 || blocked[ny * W + rcx] !== 0) continue;
      }
      if (closedGen[ni] === gen) continue;
      const ng = g + (k >= 4 ? 14 : 10);
      if (seenGen[ni] === gen && gScore[ni] <= ng) continue;
      seenGen[ni] = gen;
      gScore[ni] = ng;
      parent[ni] = cur;
      push(ni, ng + heuristic(nx, ny, gx, gy));
    }
  }
  return null;
}

/**
 * Path from (sx,sy) to (tx,ty) in milli-tiles. Returns smoothed waypoints
 * (tile centers, last one = exact destination when it is walkable).
 * An unreachable/blocked destination is replaced by the nearest walkable tile.
 */
export function findPath(state: GameState, sx: number, sy: number, tx: number, ty: number): Vec[] {
  let dest: Vec = walkable(state, tx, ty) ? { x: tx, y: ty } : nearestWalkable(state, tx, ty);
  if (lineWalkable(state, sx, sy, dest.x, dest.y)) return [dest];
  const stx = tileColSym(state, sx);
  const sty = tileOf(sy);
  const gtx = tileColSym(state, dest.x);
  const gty = tileOf(dest.y);
  const tiles = astar(state, stx, sty, gtx, gty);
  if (!tiles) return [];
  const W = state.mapW;
  // keep only the first tile, direction-change corners and the goal: straight
  // 8-direction runs between them are walkable by construction (no corner cutting)
  const raw: Vec[] = [];
  let pdx = 0;
  let pdy = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const x = t % W;
    const y = (t - x) / W;
    if (i > 0 && i < tiles.length - 1) {
      const nt = tiles[i + 1];
      const nx = nt % W;
      const ndx = nx - x;
      const ndy = (nt - nx) / W - y;
      const same = ndx === pdx && ndy === pdy;
      pdx = ndx;
      pdy = ndy;
      if (same) continue;
    } else if (i === 0 && tiles.length > 1) {
      const nt = tiles[1];
      const nx = nt % W;
      pdx = nx - x;
      pdy = (nt - nx) / W - y;
    }
    raw.push({ x: tileCenter(x), y: tileCenter(y) });
  }
  // replace the goal tile center with the exact destination
  if (raw.length > 0) raw[raw.length - 1] = dest;
  else raw.push(dest);
  // greedy string pulling
  const out: Vec[] = [];
  let ax = sx;
  let ay = sy;
  let i = 0;
  while (i < raw.length) {
    let j = i;
    while (j + 1 < raw.length && lineWalkable(state, ax, ay, raw[j + 1].x, raw[j + 1].y)) j++;
    out.push(raw[j]);
    ax = raw[j].x;
    ay = raw[j].y;
    i = j + 1;
  }
  return out;
}
