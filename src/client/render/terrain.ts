/**
 * Terrain prerender: one offscreen canvas for the whole map (grass, roads,
 * water, rocks, decoration around capture points). Drawn once per match.
 */
import type { GameState } from '../../sim/types';
import { TILE } from '../../sim/types';
import { MAPS } from '../../content';
import type { MapDef } from '../../content/maps';
import { rng } from '../util';

export const TERRAIN_PX = 40; // canvas px per tile

export interface Terrain {
  canvas: HTMLCanvasElement;
  /** Tiny version for the minimap (1 px = 1 tile scaled ×4). */
  mini: HTMLCanvasElement;
}

export function buildTerrain(state: GameState): Terrain {
  const map: MapDef = MAPS[state.config.mapId] ?? Object.values(MAPS)[0];
  const W = state.mapW;
  const H = state.mapH;
  const P = TERRAIN_PX;
  const c = document.createElement('canvas');
  c.width = W * P;
  c.height = H * P;
  const g = c.getContext('2d')!;
  g.scale(P, P); // draw in tile units
  const R = rng(state.config.seed * 7 + 13);

  // ---- grass base + soft variation
  g.fillStyle = '#86a955';
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, col: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  for (let i = 0; i < 260; i++) {
    const light = R() < 0.5;
    blob(R() * W, R() * H, 1.5 + R() * 4, light ? 'rgba(178,196,96,0.22)' : 'rgba(76,112,52,0.22)');
  }
  for (let i = 0; i < 90; i++) blob(R() * W, R() * H, 0.6 + R() * 1.4, 'rgba(196,186,104,0.16)');

  // ---- dirt roads connecting the base, points and lanes
  const roads = roadPolylines(map);
  for (const pass of [
    { w: 1.25, col: 'rgba(120,98,52,0.18)' },
    { w: 0.95, col: 'rgba(196,164,104,0.75)' },
    { w: 0.55, col: 'rgba(214,186,128,0.6)' },
  ]) {
    g.lineWidth = pass.w;
    g.strokeStyle = pass.col;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const pts of roads) smoothLine(g, pts);
  }
  // pebbles on roads
  g.fillStyle = 'rgba(140,116,70,0.35)';
  for (const pts of roads) {
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
      for (let i = 0; i < n; i++) {
        const t = R();
        g.beginPath();
        g.arc(ax + (bx - ax) * t + (R() - 0.5) * 0.6, ay + (by - ay) * t + (R() - 0.5) * 0.6, 0.04 + R() * 0.04, 0, 7);
        g.fill();
      }
    }
  }

  // ---- grass tufts + flowers (skip blocked tiles)
  const blockedAt = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    return tx < 0 || ty < 0 || tx >= W || ty >= H || state.blocked[ty * W + tx] === 1;
  };
  g.lineWidth = 0.045;
  g.lineCap = 'round';
  for (let i = 0; i < W * H * 1.6; i++) {
    const x = R() * W;
    const y = R() * H;
    if (blockedAt(x, y)) continue;
    g.strokeStyle = R() < 0.5 ? 'rgba(62,98,40,0.55)' : 'rgba(170,196,98,0.55)';
    g.beginPath();
    g.moveTo(x - 0.09, y - 0.14);
    g.lineTo(x, y);
    g.lineTo(x + 0.09, y - 0.16);
    g.moveTo(x, y);
    g.lineTo(x + 0.01, y - 0.2);
    g.stroke();
  }
  const flowerCols = ['#f4efd8', '#f2cf5b', '#e9a0b4', '#c9b6f0'];
  for (let i = 0; i < W * H * 0.22; i++) {
    const x = R() * W;
    const y = R() * H;
    if (blockedAt(x, y)) continue;
    g.fillStyle = flowerCols[(R() * flowerCols.length) | 0];
    g.beginPath();
    g.arc(x, y, 0.05, 0, 7);
    g.fill();
  }

  // ---- decoration around capture points
  for (const p of map.points) {
    const x = p.x + 0.5;
    const y = p.y + 0.5;
    if (p.kind === 'forest') {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + R() * 0.4;
        const r = 1.55 + R() * 0.9;
        const tx = x + Math.cos(a) * r;
        const ty = y + Math.sin(a) * r;
        if (!blockedAt(tx, ty)) tree(g, tx, ty, 0.42 + R() * 0.2, R);
      }
    } else if (p.kind === 'mine') {
      blob(x, y, 2.2, 'rgba(120,96,66,0.35)');
      for (let i = 0; i < 6; i++) {
        const a = R() * Math.PI * 2;
        const r = 1.3 + R() * 0.9;
        boulder(g, x + Math.cos(a) * r, y + Math.sin(a) * r, 0.18 + R() * 0.16, R);
      }
    } else {
      // village: little wheat fields
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.6 + R() * 0.4;
        const fx = x + Math.cos(a) * 1.9;
        const fy = y + Math.sin(a) * 1.9;
        if (blockedAt(fx, fy)) continue;
        g.save();
        g.translate(fx, fy);
        g.rotate(a);
        g.fillStyle = i % 2 ? 'rgba(222,192,98,0.8)' : 'rgba(196,176,90,0.75)';
        g.fillRect(-0.5, -0.35, 1.0, 0.7);
        g.strokeStyle = 'rgba(150,120,50,0.5)';
        g.lineWidth = 0.04;
        for (let k = -0.35; k <= 0.36; k += 0.14) {
          g.beginPath();
          g.moveTo(-0.5, k);
          g.lineTo(0.5, k);
          g.stroke();
        }
        g.restore();
      }
    }
  }

  // ---- water & rocks
  map.blocked.forEach((r, i) => {
    const kind = map.blockedKind[i];
    if (kind === 'water') water(g, r, R);
  });
  map.blocked.forEach((r, i) => {
    const kind = map.blockedKind[i];
    if (kind === 'rock') rocks(g, r, R);
  });
  // any blocked tile not covered by a rect definition (safety): rocky fill
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (state.blocked[y * W + x] !== 1) continue;
      let covered = false;
      for (const [rx, ry, rw, rh] of map.blocked)
        if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) covered = true;
      if (!covered) rocks(g, [x, y, 1, 1], R);
    }

  // ---- trees along the very edge (decorative frame, map edge is not walkable anyway visually)
  for (let i = 0; i < 70; i++) {
    const side = (R() * 4) | 0;
    const t = R();
    const x = side === 0 ? t * W : side === 1 ? t * W : side === 2 ? -0.1 : W + 0.1;
    const y = side === 0 ? -0.15 : side === 1 ? H + 0.15 : t * H;
    tree(g, x, y, 0.5 + R() * 0.3, R);
  }

  // ---- vignette
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(30,30,10,0.28)');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);

  // ---- minimap version
  const mini = document.createElement('canvas');
  mini.width = W * 4;
  mini.height = H * 4;
  const mg = mini.getContext('2d')!;
  mg.imageSmoothingQuality = 'high';
  mg.drawImage(c, 0, 0, mini.width, mini.height);
  return { canvas: c, mini };
}

function smoothLine(g: CanvasRenderingContext2D, pts: [number, number][]) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const l = pts[pts.length - 1];
  g.lineTo(l[0], l[1]);
  g.stroke();
}

/** Road network derived from the map: TC → own points, three lanes across the middle. */
function roadPolylines(map: MapDef): [number, number][][] {
  const W = map.w;
  const H = map.h;
  const c = (x: number, y: number): [number, number] => [x + 0.5, y + 0.5];
  const tc0 = map.towncenters[0];
  const tc1 = map.towncenters[1];
  const mid = H / 2 - 0.5;
  const roads: [number, number][][] = [];
  // center lane: TC → TC straight across
  roads.push([c(tc0.x, tc0.y), c((tc0.x + W / 2) / 2, mid), c(W / 2 - 0.5, mid), c((tc1.x + W / 2) / 2, mid), c(tc1.x, tc1.y)]);
  // per point: a spur from the nearest TC (side points) or lane (middle points)
  const lakes = map.blocked.filter((_, i) => map.blockedKind[i] === 'water');
  const northEdge = lakes.length ? Math.min(...lakes.map((r) => r[1])) - 2.5 : 6;
  const southEdge = lakes.length ? Math.max(...lakes.map((r) => r[1] + r[3])) + 2.5 : H - 6;
  for (const lane of [northEdge, southEdge]) {
    const ly = Math.max(1.5, Math.min(H - 1.5, lane));
    const pts: [number, number][] = [c(tc0.x, tc0.y)];
    const side = map.points
      .filter((p) => (lane < mid ? p.y < mid - 3 : p.y > mid + 3))
      .sort((a, b) => a.x - b.x);
    for (const p of side) pts.push(c(p.x, p.y));
    pts.push(c(tc1.x, tc1.y));
    // keep the lane away from lakes by inserting lane-height waypoints in the lake band
    const fixed: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      fixed.push(pts[i]);
      const n = pts[i + 1];
      if (!n) continue;
      for (const r of lakes) {
        const midX = (pts[i][0] + n[0]) / 2;
        if (midX > r[0] - 2 && midX < r[0] + r[2] + 2) {
          // segment crosses lake columns → route along the lane
          if (pts[i][0] < r[0]) fixed.push([r[0] - 0.5, ly]);
          if (n[0] > r[0] + r[2]) fixed.push([r[0] + r[2] + 0.5, ly]);
          break;
        }
      }
    }
    roads.push(fixed);
  }
  return roads;
}

function tree(g: CanvasRenderingContext2D, x: number, y: number, r: number, R: () => number) {
  g.fillStyle = 'rgba(30,40,20,0.28)';
  g.beginPath();
  g.ellipse(x + r * 0.25, y + r * 0.3, r, r * 0.8, 0, 0, 7);
  g.fill();
  const dark = R() < 0.5;
  g.fillStyle = dark ? '#4f7a36' : '#5c8a3a';
  g.beginPath();
  g.arc(x, y, r, 0, 7);
  g.fill();
  g.fillStyle = dark ? '#62903f' : '#73a246';
  g.beginPath();
  g.arc(x - r * 0.25, y - r * 0.28, r * 0.62, 0, 7);
  g.fill();
  g.fillStyle = 'rgba(220,236,150,0.25)';
  g.beginPath();
  g.arc(x - r * 0.38, y - r * 0.42, r * 0.25, 0, 7);
  g.fill();
}

function boulder(g: CanvasRenderingContext2D, x: number, y: number, r: number, R: () => number) {
  const n = 7;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.8 + R() * 0.35);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85]);
  }
  g.fillStyle = 'rgba(30,30,20,0.3)';
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px + r * 0.25, py + r * 0.3) : g.moveTo(px + r * 0.25, py + r * 0.3)));
  g.fill();
  g.fillStyle = '#948f84';
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(50,48,44,0.55)';
  g.lineWidth = 0.035;
  g.stroke();
  g.fillStyle = '#b9b4a6';
  g.beginPath();
  g.ellipse(x - r * 0.25, y - r * 0.28, r * 0.42, r * 0.28, -0.4, 0, 7);
  g.fill();
}

function rocks(g: CanvasRenderingContext2D, r: [number, number, number, number], R: () => number) {
  const [x, y, w, h] = r;
  // dark soil base
  g.fillStyle = 'rgba(92,84,70,0.55)';
  g.beginPath();
  g.roundRect(x - 0.1, y - 0.1, w + 0.2, h + 0.2, 0.6);
  g.fill();
  const n = Math.max(3, Math.round(w * h * 2.2));
  for (let i = 0; i < n; i++) {
    boulder(g, x + 0.3 + R() * (w - 0.6), y + 0.3 + R() * (h - 0.6), 0.32 + R() * 0.28, R);
  }
}

function water(g: CanvasRenderingContext2D, r: [number, number, number, number], R: () => number) {
  const [x, y, w, h] = r;
  const shape = (grow: number) => {
    g.beginPath();
    g.roundRect(x - grow, y - grow, w + grow * 2, h + grow * 2, Math.min(w, h) / 2 + grow);
  };
  // sand bank
  g.fillStyle = '#d9c78f';
  shape(0.45);
  g.fill();
  g.fillStyle = 'rgba(160,190,120,0.5)';
  shape(0.5);
  g.lineWidth = 0.12;
  g.strokeStyle = 'rgba(110,140,70,0.5)';
  g.stroke();
  // shallows → deep
  g.fillStyle = '#7fbcc4';
  shape(0.15);
  g.fill();
  const gr = g.createLinearGradient(x, y, x, y + h);
  gr.addColorStop(0, '#3f86ad');
  gr.addColorStop(1, '#2f6c95');
  g.fillStyle = gr;
  shape(-0.25);
  g.fill();
  // ripples
  g.strokeStyle = 'rgba(230,245,250,0.45)';
  g.lineWidth = 0.05;
  g.lineCap = 'round';
  for (let i = 0; i < w * h * 0.9; i++) {
    const rx = x + 0.6 + R() * (w - 1.2);
    const ry = y + 0.5 + R() * (h - 1.0);
    g.beginPath();
    g.arc(rx, ry, 0.22, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  }
  // lily pads
  g.fillStyle = '#5f9a4a';
  for (let i = 0; i < 4; i++) {
    const a = R() * Math.PI * 2;
    const lx = x + w / 2 + Math.cos(a) * (w / 2 - 0.4);
    const ly = y + h / 2 + Math.sin(a) * (h / 2 - 0.4);
    g.beginPath();
    g.arc(lx, ly, 0.16, 0.3, Math.PI * 2 - 0.3);
    g.lineTo(lx, ly);
    g.fill();
  }
}

export const tileOf = (m: number) => Math.floor(m / TILE);
