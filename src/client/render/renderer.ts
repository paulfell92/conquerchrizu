/**
 * Canvas 2D world renderer. World drawing uses a transform where 1 unit = 1 tile;
 * bars and labels are drawn in screen space for crispness.
 */
import type { Building, BuildingKind, CapturePoint, Squad, UnitKind } from '../../sim/types';
import { TILE } from '../../sim/types';
import { BUILDINGS, RULES, UNITS } from '../../content';
import type { Camera } from '../camera';
import { CPU, HUMAN, type Remembered, type Session } from '../session';
import { buildTerrain, type Terrain, TERRAIN_PX } from './terrain';
import { drawIcon, type IconName } from '../icons';
import { hexRgb, shade } from '../util';

const NEUTRAL = '#d8cfb6';
const INK = '#2b2116';

interface Palette {
  base: string;
  dark: string;
  darker: string;
  light: string;
  glow: string;
}

function palette(hex: string): Palette {
  const [r, g, b] = hexRgb(hex);
  return {
    base: hex,
    dark: shade(hex, -0.3),
    darker: shade(hex, -0.55),
    light: shade(hex, 0.35),
    glow: `rgba(${r},${g},${b},0.28)`,
  };
}

/** Formation offsets (tiles) for 1..6 members, before rotation; front = +x. */
const FORMATION: [number, number][][] = [
  [],
  [[0, 0]],
  [[0.1, -0.17], [-0.1, 0.17]],
  [[0.16, 0], [-0.1, -0.2], [-0.1, 0.2]],
  [[0.13, -0.15], [0.13, 0.15], [-0.15, -0.15], [-0.15, 0.15]],
  [[0.2, 0], [0.04, -0.24], [0.04, 0.24], [-0.2, -0.12], [-0.2, 0.12]],
  [[0.16, -0.25], [0.16, 0], [0.16, 0.25], [-0.14, -0.25], [-0.14, 0], [-0.14, 0.25]],
];

const MEMBER_R: Record<UnitKind, number> = {
  scout: 0.12,
  spear: 0.1,
  archer: 0.1,
  cavalry: 0.13,
  sword: 0.11,
  ram: 0.3,
  knight: 0.14,
};

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  dpr = 1;
  private terrain: Terrain | null = null;
  private fog: HTMLCanvasElement;
  private fogCtx: CanvasRenderingContext2D;
  private fogImg: ImageData | null = null;
  private fogVersion = -1;
  private pal: Palette[] = [];
  private s: Session | null = null;
  /** Box selection rectangle in screen px, or null. */
  box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Interpolated squad positions from the last frame (tiles), for hit-testing. */
  readonly squadPos = new Map<number, { x: number; y: number }>();
  /** Set by main: show build slot plots. */
  now = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly cam: Camera) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.fog = document.createElement('canvas');
    this.fogCtx = this.fog.getContext('2d')!;
  }

  setSession(s: Session) {
    this.s = s;
    this.terrain = buildTerrain(s.state);
    this.pal = s.state.players.map((p) => palette(p.color));
    this.fog.width = s.state.mapW;
    this.fog.height = s.state.mapH;
    this.fogImg = this.fogCtx.createImageData(s.state.mapW, s.state.mapH);
    this.fogVersion = -1;
    this.squadPos.clear();
    this.spriteCache.clear();
  }

  get minimapTerrain(): HTMLCanvasElement | null {
    return this.terrain?.mini ?? null;
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  /** Set transform so that drawing units are tiles. */
  private worldTx() {
    const c = this.cam;
    const k = this.dpr * c.zoom;
    this.ctx.setTransform(k, 0, 0, k, this.dpr * (c.viewW / 2 - c.x * c.zoom), this.dpr * (c.viewH / 2 - c.y * c.zoom));
  }
  private screenTx() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  render(now: number) {
    const s = this.s;
    const g = this.ctx;
    const cam = this.cam;
    if (!s || !this.terrain) return;
    this.now = now;
    const st = s.state;
    const z = cam.zoom;

    // ---- background + terrain
    this.screenTx();
    g.fillStyle = '#3b4a2a';
    g.fillRect(0, 0, cam.viewW, cam.viewH);
    this.worldTx();
    g.imageSmoothingEnabled = true;
    g.drawImage(this.terrain.canvas, 0, 0, st.mapW, st.mapH);

    // view bounds in tiles for culling
    const vx0 = cam.wx(0) - 3;
    const vx1 = cam.wx(cam.viewW) + 3;
    const vy0 = cam.wy(0) - 3;
    const vy1 = cam.wy(cam.viewH) + 3;
    const inView = (mx: number, my: number) => {
      const x = mx / TILE;
      const y = my / TILE;
      return x > vx0 && x < vx1 && y > vy0 && y < vy1;
    };

    // ---- capture point areas (under everything)
    for (const p of st.points) if (inView(p.x, p.y)) this.drawPointArea(p);

    // ---- own empty build slots
    let slotList: ReturnType<Session['api']['slots']> = [];
    try {
      slotList = s.api.slots(st, HUMAN);
    } catch {
      slotList = [];
    }
    for (const sl of slotList) if (!sl.building) this.drawSlot(sl.slot, sl.pos.x, sl.pos.y, s.selSlot === sl.slot);

    // ---- rally line for selected building
    if (s.selBuilding !== null) {
      const b = s.buildingById(s.selBuilding);
      if (b && b.rally) this.drawRally(b.x, b.y, b.rally.x, b.rally.y, this.pal[b.owner].base);
    }

    // ---- remembered (fogged) enemy buildings
    for (const r of s.remembered.values()) {
      if (!s.isVisible(r.x, r.y) && inView(r.x, r.y)) this.drawBuildingShape(r.kind, r.owner, r.x, r.y, r.building ? 0.5 : 1, true);
    }
    // ---- live buildings
    for (const b of st.buildings) {
      if (!inView(b.x, b.y)) continue;
      if (b.owner !== HUMAN && !s.isVisible(b.x, b.y)) continue;
      this.drawBuilding(b, s.selBuilding === b.id || s.selEnemy === b.id);
    }

    // ---- fog
    this.updateFog();
    this.worldTx();
    g.imageSmoothingEnabled = true;
    g.drawImage(this.fog, 0, 0, st.mapW, st.mapH);

    // ---- point plaques (public info, above fog)
    for (const p of st.points) if (inView(p.x, p.y)) this.drawPointPlaque(p, s.selPoint === p.id);

    // ---- squads
    const a = s.alpha;
    for (const q of st.squads) {
      let x = q.x;
      let y = q.y;
      const pv = s.prev.get(q.id);
      if (pv) {
        const dx = q.x - pv.x;
        const dy = q.y - pv.y;
        if (dx * dx + dy * dy < 2000 * 2000) {
          x = pv.x + dx * a;
          y = pv.y + dy * a;
        }
      }
      let sp = this.squadPos.get(q.id);
      if (!sp) {
        sp = { x: 0, y: 0 };
        this.squadPos.set(q.id, sp);
      }
      sp.x = x;
      sp.y = y;
      if (q.owner !== HUMAN && !s.isVisible(q.x, q.y)) {
        sp.x = -1e9;
        continue;
      }
      if (!inView(x, y)) continue;
      this.drawSquad(q, x, y, s.selected.has(q.id) || s.selEnemy === q.id);
    }
    if (this.squadPos.size > st.squads.length + 16) {
      const alive = new Set(st.squads.map((q) => q.id));
      for (const id of this.squadPos.keys()) if (!alive.has(id)) this.squadPos.delete(id);
    }

    // ---- move destinations of selected squads
    if (s.selected.size) {
      this.worldTx();
      g.setLineDash([0.18, 0.14]);
      g.lineWidth = 1.6 / z;
      g.strokeStyle = 'rgba(255,248,220,0.55)';
      for (const id of s.selected) {
        const q = s.squadById(id);
        const sp = this.squadPos.get(id);
        if (!q || !sp) continue;
        let tx: number | null = null;
        let ty = 0;
        if (q.order === 'attack' && q.target !== null) {
          const t = s.squadById(q.target) ?? s.buildingById(q.target);
          if (t && (t.owner === HUMAN || s.isVisible(t.x, t.y))) {
            tx = t.x;
            ty = t.y;
            g.strokeStyle = 'rgba(255,140,110,0.75)';
          }
        } else if (q.dest) {
          tx = q.dest.x;
          ty = q.dest.y;
          g.strokeStyle = 'rgba(255,248,220,0.55)';
        }
        if (tx === null) continue;
        g.beginPath();
        g.moveTo(sp.x / TILE, sp.y / TILE);
        g.lineTo(tx / TILE, ty / TILE);
        g.stroke();
      }
      g.setLineDash([]);
    }

    // ---- fx
    this.drawFx(now);

    // ---- bars in screen space
    this.screenTx();
    for (const b of st.buildings) {
      if (b.owner !== HUMAN && !s.isVisible(b.x, b.y)) continue;
      if (!inView(b.x, b.y)) continue;
      const r = b.kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius;
      const sel = s.selBuilding === b.id || s.selEnemy === b.id;
      const sx = cam.sx(b.x);
      const sy = cam.sy(b.y - r) - 8;
      const w = Math.max(28, (r / TILE) * z * 1.5);
      if (b.buildTicksLeft > 0) {
        const tot = BUILDINGS[b.kind].buildTicks || 1;
        this.bar(sx, sy, w, 1 - b.buildTicksLeft / tot, '#e8c25a');
      } else if (b.hp < b.maxHp || sel) this.bar(sx, sy, w, b.hp / b.maxHp, this.hpColor(b.hp / b.maxHp, b.owner));
      if (b.queue.length && b.owner === HUMAN && b.buildTicksLeft === 0) {
        const q = b.queue[0];
        this.bar(sx, sy + 6, w * 0.8, 1 - q.ticksLeft / Math.max(1, q.totalTicks), '#f2e4b8', 3);
      }
    }
    for (const q of st.squads) {
      const sp = this.squadPos.get(q.id);
      if (!sp || sp.x < -1e8) continue;
      if (!inView(sp.x, sp.y)) continue;
      const sel = s.selected.has(q.id) || s.selEnemy === q.id;
      if (q.hp >= q.maxHp && !sel) continue;
      const sx = cam.sx(sp.x);
      const sy = cam.sy(sp.y) - Math.max(16, 0.78 * z) - 6;
      this.bar(sx, sy, Math.max(22, 0.9 * z), q.hp / q.maxHp, this.hpColor(q.hp / q.maxHp, q.owner), 4);
    }

    // ---- point names when zoomed in
    if (z >= 30) {
      g.font = '600 11px ' + FONT;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      for (const p of st.points) {
        if (!inView(p.x, p.y)) continue;
        const sx = cam.sx(p.x);
        const sy = cam.sy(p.y) + 0.62 * z + 2;
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(30,24,14,0.7)';
        g.strokeText(p.name, sx, sy);
        g.fillStyle = '#fbf3dc';
        g.fillText(p.name, sx, sy);
      }
    }

    // ---- box select
    if (this.box) {
      const b = this.box;
      const x = Math.min(b.x0, b.x1);
      const y = Math.min(b.y0, b.y1);
      const w = Math.abs(b.x1 - b.x0);
      const h = Math.abs(b.y1 - b.y0);
      g.fillStyle = 'rgba(255,240,190,0.12)';
      g.fillRect(x, y, w, h);
      g.strokeStyle = 'rgba(255,240,190,0.9)';
      g.lineWidth = 1.5;
      g.setLineDash([6, 4]);
      g.strokeRect(x + 0.5, y + 0.5, w, h);
      g.setLineDash([]);
    }
  }

  private hpColor(f: number, owner: number): string {
    if (owner !== HUMAN) return f > 0.35 ? '#e35b4c' : '#ff8a5c';
    return f > 0.6 ? '#7fd36b' : f > 0.3 ? '#e8c25a' : '#e3643f';
  }

  private bar(cx: number, y: number, w: number, f: number, col: string, h = 5) {
    const g = this.ctx;
    const x = Math.round(cx - w / 2);
    y = Math.round(y);
    g.fillStyle = 'rgba(20,16,10,0.75)';
    g.fillRect(x - 1, y - 1, w + 2, h + 2);
    g.fillStyle = col;
    g.fillRect(x, y, Math.max(0, Math.min(1, f)) * w, h);
  }

  // ------------------------------------------------------------ fog

  private updateFog() {
    const s = this.s!;
    if (this.fogVersion === s.visVersion || !this.fogImg) return;
    this.fogVersion = s.visVersion;
    const d = this.fogImg.data;
    const v = s.vis;
    const ex = s.explored;
    for (let i = 0, j = 0; i < v.length; i++, j += 4) {
      d[j] = 18;
      d[j + 1] = 22;
      d[j + 2] = 30;
      d[j + 3] = v[i] ? 0 : ex[i] ? 105 : 175;
    }
    this.fogCtx.putImageData(this.fogImg, 0, 0);
  }

  // ------------------------------------------------------------ points

  private drawPointArea(p: CapturePoint) {
    const g = this.ctx;
    this.worldTx();
    const x = p.x / TILE;
    const y = p.y / TILE;
    const r = RULES.captureRadius / TILE;
    const col = p.owner >= 0 ? this.pal[p.owner].base : NEUTRAL;
    const [cr, cg, cb] = p.owner >= 0 ? hexRgb(col) : [216, 207, 182];
    g.fillStyle = `rgba(${cr},${cg},${cb},${p.owner >= 0 ? 0.13 : 0.08})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 2 / this.cam.zoom;
    g.strokeStyle = `rgba(${cr},${cg},${cb},${p.owner >= 0 ? 0.65 : 0.4})`;
    g.setLineDash([0.35, 0.22]);
    g.stroke();
    g.setLineDash([]);
  }

  private drawPointPlaque(p: CapturePoint, sel: boolean) {
    const g = this.ctx;
    const z = this.cam.zoom;
    this.worldTx();
    const x = p.x / TILE;
    const y = p.y / TILE;
    // keep the plaque readable when zoomed out
    const R = Math.max(0.5, 15 / z);
    const own = p.owner >= 0 ? this.pal[p.owner] : null;
    // shadow
    g.fillStyle = 'rgba(20,16,8,0.35)';
    g.beginPath();
    g.ellipse(x + R * 0.12, y + R * 0.2, R * 1.05, R * 0.95, 0, 0, Math.PI * 2);
    g.fill();
    if (sel) {
      g.strokeStyle = '#fff6d0';
      g.lineWidth = 3 / z;
      g.beginPath();
      g.arc(x, y, R * 1.45, 0, Math.PI * 2);
      g.stroke();
    }
    // level 2: outer gold ring
    if (p.level === 2) {
      g.fillStyle = '#e7c55a';
      g.beginPath();
      g.arc(x, y, R * 1.2, 0, Math.PI * 2);
      g.fill();
    }
    // track ring
    g.fillStyle = 'rgba(30,24,14,0.85)';
    g.beginPath();
    g.arc(x, y, R * 1.08, 0, Math.PI * 2);
    g.fill();
    // progress arc
    const cap = p.capturer >= 0 ? p.capturer : p.owner;
    const frac = p.owner >= 0 && p.capturer === p.owner ? p.progress / RULES.captureMax : p.progress / RULES.captureMax;
    if (frac > 0 && cap >= 0) {
      g.strokeStyle = this.pal[cap].light;
      g.lineWidth = R * 0.22;
      g.beginPath();
      g.arc(x, y, R * 0.97, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
      g.stroke();
    }
    // disc
    g.fillStyle = own ? own.base : '#cfc4a5';
    g.beginPath();
    g.arc(x, y, R * 0.82, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = own ? own.dark : '#a89c7c';
    g.beginPath();
    g.arc(x, y + R * 0.08, R * 0.82, 0.15, Math.PI - 0.15);
    g.fill();
    g.fillStyle = own ? own.base : '#cfc4a5';
    g.beginPath();
    g.arc(x, y - R * 0.02, R * 0.74, 0, Math.PI * 2);
    g.fill();
    drawIcon(g, p.kind as IconName, x, y - R * 0.02, R * 1.05, own ? '#fffaf0' : INK, 2.4);
  }

  private drawSlot(slot: number, mx: number, my: number, sel: boolean) {
    const g = this.ctx;
    this.worldTx();
    const x = mx / TILE;
    const y = my / TILE;
    const r = (RULES.buildingRadius / TILE) * 0.85;
    const pulse = sel ? 0.5 + 0.5 * Math.sin(this.now / 220) : 0;
    g.fillStyle = sel ? `rgba(255,236,170,${0.25 + pulse * 0.15})` : 'rgba(245,232,190,0.16)';
    g.beginPath();
    g.roundRect(x - r, y - r, r * 2, r * 2, r * 0.3);
    g.fill();
    g.lineWidth = (sel ? 2.5 : 1.5) / this.cam.zoom;
    g.setLineDash([0.2, 0.14]);
    g.strokeStyle = sel ? '#fff3c4' : 'rgba(250,240,205,0.6)';
    g.stroke();
    g.setLineDash([]);
    drawIcon(g, 'build', x, y, r * 0.9, sel ? '#fff3c4' : 'rgba(250,240,205,0.7)', 2.4);
    void slot;
  }

  private drawRally(bx: number, by: number, rx: number, ry: number, col: string) {
    const g = this.ctx;
    this.worldTx();
    g.strokeStyle = 'rgba(255,248,220,0.7)';
    g.lineWidth = 1.5 / this.cam.zoom;
    g.setLineDash([0.2, 0.15]);
    g.beginPath();
    g.moveTo(bx / TILE, by / TILE);
    g.lineTo(rx / TILE, ry / TILE);
    g.stroke();
    g.setLineDash([]);
    const x = rx / TILE;
    const y = ry / TILE;
    g.strokeStyle = INK;
    g.lineWidth = 0.06;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - 0.7);
    g.stroke();
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x, y - 0.7);
    g.lineTo(x + 0.45, y - 0.56);
    g.lineTo(x, y - 0.42);
    g.fill();
  }

  // ------------------------------------------------------------ buildings

  private drawBuilding(b: Building, sel: boolean) {
    const tot = BUILDINGS[b.kind].buildTicks || 1;
    const prog = b.buildTicksLeft > 0 ? 1 - b.buildTicksLeft / tot : 1;
    const hit = this.s!.lastHit.get(b.id);
    const flash = hit !== undefined && this.s!.state.tick - hit < 3;
    if (sel) {
      const g = this.ctx;
      this.worldTx();
      const r = (b.kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius) / TILE;
      g.strokeStyle = b.owner === HUMAN ? '#fff3c4' : '#ffb4a2';
      g.lineWidth = 2.5 / this.cam.zoom;
      g.beginPath();
      g.ellipse(b.x / TILE, b.y / TILE + r * 0.08, r * 1.12, r * 1.02, 0, 0, Math.PI * 2);
      g.stroke();
    }
    this.drawBuildingShape(b.kind, b.owner, b.x, b.y, prog, false, flash);
    // towers / TC firing: small target line handled by fx
  }

  drawBuildingShape(kind: BuildingKind, owner: number, mx: number, my: number, prog: number, ghost: boolean, flash = false) {
    const g = this.ctx;
    this.worldTx();
    const x = mx / TILE;
    const y = my / TILE;
    const big = kind === 'towncenter';
    const r = (big ? RULES.townCenterRadius : RULES.buildingRadius) / TILE;
    const P = this.pal[owner] ?? palette('#888888');
    if (ghost) g.globalAlpha = 0.55;
    // ground shadow
    g.fillStyle = 'rgba(25,20,10,0.32)';
    g.beginPath();
    g.roundRect(x - r * 0.86 + r * 0.14, y - r * 0.8 + r * 0.2, r * 1.72, r * 1.68, r * 0.25);
    g.fill();

    if (prog < 1) {
      // construction site: foundation + scaffolding, roof grows with progress
      g.fillStyle = '#b79f74';
      g.beginPath();
      g.roundRect(x - r * 0.86, y - r * 0.8, r * 1.72, r * 1.6, r * 0.2);
      g.fill();
      g.strokeStyle = '#7c6240';
      g.lineWidth = 0.07;
      for (let i = -2; i <= 2; i++) {
        g.beginPath();
        g.moveTo(x + i * r * 0.4, y - r * 0.8);
        g.lineTo(x + i * r * 0.4, y + r * 0.8);
        g.stroke();
      }
      g.save();
      g.beginPath();
      g.rect(x - r, y + r * 0.85 - r * 1.75 * prog, r * 2, r * 1.75 * prog);
      g.clip();
      this.roof(kind, x, y, r, P);
      g.restore();
      g.strokeStyle = '#5c4528';
      g.lineWidth = 0.05;
      g.strokeRect(x - r * 0.86, y - r * 0.8, r * 1.72, r * 1.6);
      g.globalAlpha = 1;
      return;
    }
    this.roof(kind, x, y, r, P);
    const iconCol = 'rgba(255,250,236,0.92)';
    drawIcon(g, kind as IconName, x, y + (kind === 'tower' ? 0 : r * 0.06), r * (big ? 0.75 : 0.85), iconCol, 2.3);
    if (flash) {
      g.fillStyle = 'rgba(255,240,220,0.35)';
      g.beginPath();
      g.roundRect(x - r * 0.86, y - r * 0.8, r * 1.72, r * 1.6, r * 0.2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /** Per-kind top-down silhouette in owner colors. */
  private roof(kind: BuildingKind, x: number, y: number, r: number, P: Palette) {
    const g = this.ctx;
    const stone = '#cdbf9f';
    const stoneD = '#9b8b6a';
    switch (kind) {
      case 'towncenter': {
        // stone curtain wall with 4 corner towers, keep with owner roof
        g.fillStyle = stoneD;
        g.beginPath();
        g.roundRect(x - r * 0.88, y - r * 0.82, r * 1.76, r * 1.72, r * 0.12);
        g.fill();
        g.fillStyle = stone;
        g.beginPath();
        g.roundRect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.7, r * 0.12);
        g.fill();
        g.fillStyle = '#b5a681';
        g.fillRect(x - r * 0.62, y - r * 0.62, r * 1.24, r * 1.24);
        for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          g.fillStyle = stoneD;
          g.beginPath();
          g.arc(x + cx * r * 0.78, y + cy * r * 0.76 + 0.05, r * 0.24, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = P.dark;
          g.beginPath();
          g.arc(x + cx * r * 0.78, y + cy * r * 0.76, r * 0.22, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = P.base;
          g.beginPath();
          g.arc(x + cx * r * 0.78 - r * 0.04, y + cy * r * 0.76 - r * 0.04, r * 0.13, 0, Math.PI * 2);
          g.fill();
        }
        // keep: hipped roof
        this.hipRoof(x, y, r * 0.5, r * 0.5, P);
        break;
      }
      case 'tower': {
        g.fillStyle = stoneD;
        g.beginPath();
        g.arc(x, y + 0.06, r * 0.66, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = stone;
        g.beginPath();
        g.arc(x, y, r * 0.66, 0, Math.PI * 2);
        g.fill();
        // crenellations
        g.fillStyle = stoneD;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          g.beginPath();
          g.arc(x + Math.cos(a) * r * 0.56, y + Math.sin(a) * r * 0.56, r * 0.09, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = P.dark;
        g.beginPath();
        g.arc(x, y, r * 0.42, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = P.base;
        g.beginPath();
        g.arc(x - r * 0.05, y - r * 0.06, r * 0.34, 0, Math.PI * 2);
        g.fill();
        break;
      }
      case 'barracks': {
        // long hall, gable roof along x
        this.gable(x, y, r * 0.86, r * 0.6, P, true);
        break;
      }
      case 'range': {
        // open yard with fence + small shed
        g.fillStyle = '#c7b07e';
        g.beginPath();
        g.roundRect(x - r * 0.84, y - r * 0.78, r * 1.68, r * 1.56, r * 0.15);
        g.fill();
        g.strokeStyle = '#7d6240';
        g.lineWidth = 0.06;
        g.stroke();
        this.gable(x - r * 0.42, y, r * 0.38, r * 0.68, P, false);
        // straw targets
        for (const ty of [-0.45, 0, 0.45]) {
          g.fillStyle = '#efe0b0';
          g.beginPath();
          g.arc(x + r * 0.5, y + ty * r, r * 0.15, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = P.base;
          g.beginPath();
          g.arc(x + r * 0.5, y + ty * r, r * 0.07, 0, Math.PI * 2);
          g.fill();
        }
        return; // icon drawn by caller sits over shed; fine
      }
      case 'stable': {
        // U-shaped stalls around a paddock
        g.fillStyle = '#b89f6a';
        g.beginPath();
        g.roundRect(x - r * 0.84, y - r * 0.8, r * 1.68, r * 1.6, r * 0.15);
        g.fill();
        this.gable(x, y - r * 0.52, r * 0.84, r * 0.28, P, true);
        this.gable(x - r * 0.62, y + r * 0.12, r * 0.22, r * 0.56, P, false);
        this.gable(x + r * 0.62, y + r * 0.12, r * 0.22, r * 0.56, P, false);
        // hay
        g.fillStyle = '#e7cd6c';
        g.beginPath();
        g.arc(x, y + r * 0.42, r * 0.13, 0, Math.PI * 2);
        g.fill();
        break;
      }
      case 'blacksmith': {
        this.hipRoof(x, y, r * 0.78, r * 0.68, P);
        // chimney with glow
        g.fillStyle = '#6e6458';
        g.fillRect(x + r * 0.36, y - r * 0.62, r * 0.3, r * 0.3);
        g.fillStyle = '#f39a3c';
        g.fillRect(x + r * 0.42, y - r * 0.56, r * 0.18, r * 0.18);
        break;
      }
      case 'workshop': {
        this.gable(x, y, r * 0.82, r * 0.66, P, false);
        // lumber pile
        g.fillStyle = '#9a6a3c';
        for (let i = 0; i < 3; i++) g.fillRect(x - r * 0.8, y + r * 0.52 + i * r * 0.09, r * 0.6, r * 0.07);
        break;
      }
    }
  }

  private gable(x: number, y: number, hw: number, hh: number, P: Palette, alongX: boolean) {
    const g = this.ctx;
    // walls
    g.fillStyle = '#8a6d48';
    g.fillRect(x - hw, y - hh + 0.05, hw * 2, hh * 2);
    if (alongX) {
      g.fillStyle = P.light;
      g.fillRect(x - hw, y - hh, hw * 2, hh);
      g.fillStyle = P.dark;
      g.fillRect(x - hw, y, hw * 2, hh);
      g.strokeStyle = P.darker;
      g.lineWidth = 0.05;
      g.beginPath();
      g.moveTo(x - hw, y);
      g.lineTo(x + hw, y);
      g.stroke();
      // tile lines
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      g.lineWidth = 0.03;
      for (let i = -hw + 0.18; i < hw; i += 0.18) {
        g.beginPath();
        g.moveTo(x + i, y - hh);
        g.lineTo(x + i, y + hh);
        g.stroke();
      }
    } else {
      g.fillStyle = P.light;
      g.fillRect(x - hw, y - hh, hw, hh * 2);
      g.fillStyle = P.dark;
      g.fillRect(x, y - hh, hw, hh * 2);
      g.strokeStyle = P.darker;
      g.lineWidth = 0.05;
      g.beginPath();
      g.moveTo(x, y - hh);
      g.lineTo(x, y + hh);
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      g.lineWidth = 0.03;
      for (let i = -hh + 0.18; i < hh; i += 0.18) {
        g.beginPath();
        g.moveTo(x - hw, y + i);
        g.lineTo(x + hw, y + i);
        g.stroke();
      }
    }
    g.strokeStyle = P.darker;
    g.lineWidth = 0.05;
    g.strokeRect(x - hw, y - hh, hw * 2, hh * 2);
  }

  private hipRoof(x: number, y: number, hw: number, hh: number, P: Palette) {
    const g = this.ctx;
    const ix = hw * 0.35;
    const L = x - hw,
      R = x + hw,
      T = y - hh,
      B = y + hh;
    g.fillStyle = '#7a5f3e';
    g.fillRect(L, T + 0.06, hw * 2, hh * 2);
    const face = (pts: number[], col: string) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.closePath();
      g.fill();
    };
    face([L, T, R, T, x + ix, y, x - ix, y], P.light); // north
    face([R, T, R, B, x + ix, y], P.base); // east
    face([L, B, R, B, x + ix, y, x - ix, y], P.dark); // south
    face([L, T, L, B, x - ix, y], P.base); // west
    g.strokeStyle = P.darker;
    g.lineWidth = 0.045;
    g.beginPath();
    g.moveTo(L, T);
    g.lineTo(x - ix, y);
    g.lineTo(L, B);
    g.moveTo(R, T);
    g.lineTo(x + ix, y);
    g.lineTo(R, B);
    g.moveTo(x - ix, y);
    g.lineTo(x + ix, y);
    g.stroke();
    g.strokeRect(L, T, hw * 2, hh * 2);
  }

  // ------------------------------------------------------------ squads

  private drawSquad(q: Squad, mx: number, my: number, sel: boolean) {
    const g = this.ctx;
    const z = this.cam.zoom;
    this.worldTx();
    const x = mx / TILE;
    const y = my / TILE;
    const P = this.pal[q.owner];
    const R = RULES.squadRadius / TILE;
    const ang = (q.facing & 7) * (Math.PI / 4);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);

    // ground disc / selection ring
    g.fillStyle = q.owner === HUMAN ? 'rgba(40,70,140,0.22)' : 'rgba(140,40,30,0.22)';
    g.beginPath();
    g.ellipse(x, y + 0.05, R * 0.95, R * 0.8, 0, 0, Math.PI * 2);
    g.fill();
    if (sel) {
      g.strokeStyle = q.owner === HUMAN ? '#fff3c4' : '#ffb4a2';
      g.lineWidth = 2.4 / z;
      g.beginPath();
      g.ellipse(x, y + 0.05, R * 1.05, R * 0.9, 0, 0, Math.PI * 2);
      g.stroke();
    }

    const hit = this.s!.lastHit.get(q.id);
    const flash = hit !== undefined && this.s!.state.tick - hit < 3;
    const n = Math.max(0, Math.min(6, q.members));
    const mr = MEMBER_R[q.kind];
    const form = q.kind === 'ram' ? FORMATION[1] : FORMATION[n] ?? FORMATION[6];
    const moving = q.order === 'move' || q.order === 'retreat' || (q.order === 'attack' && q.path.length > 0);
    const bob = moving ? Math.sin(this.now / 90 + q.id) * 0.025 : 0;
    const scale = q.kind === 'cavalry' || q.kind === 'knight' ? 1.25 : 1;

    const spr = this.memberSprite(q.owner, q.kind, q.facing & 7, flash);
    for (let i = 0; i < form.length; i++) {
      const [fx, fy] = form[i];
      const ox = (fx * ca - fy * sa) * scale;
      const oy = (fx * sa + fy * ca) * scale;
      const px = x + ox;
      const py = y + oy + (i % 2 ? bob : -bob);
      g.drawImage(spr.c, px - spr.half, py - spr.half, spr.half * 2, spr.half * 2);
    }

    // kind badge (constant screen size, sits above the squad)
    const bR = Math.max(0.2, 9 / z);
    const bs = this.badgeSprite(q.owner, q.kind);
    const k = bR / 9; // tiles per css px at badge scale
    g.drawImage(bs, x + R * 0.75 - 11 * k, y - R * 0.75 - 11 * k, 22 * k, 22 * k);
  }

  private spriteCache = new Map<string, { c: HTMLCanvasElement; half: number }>();
  private spriteBucket = 0;

  /** One squad member pre-rendered (resolution bucketed by zoom × dpr). */
  private memberSprite(owner: number, kind: UnitKind, facing: number, flash: boolean) {
    const res = Math.min(256, Math.pow(2, Math.ceil(Math.log2(Math.max(16, this.cam.zoom * this.dpr)))));
    if (res !== this.spriteBucket) {
      this.spriteBucket = res;
      for (const k of [...this.spriteCache.keys()]) if (!k.startsWith('b')) this.spriteCache.delete(k);
    }
    const key = `m${owner}${kind}${facing}${flash ? 1 : 0}`;
    let e = this.spriteCache.get(key);
    if (e) return e;
    const mr = MEMBER_R[kind];
    const half = kind === 'ram' ? 0.75 : mr * 2.6 + 0.06;
    const c = document.createElement('canvas');
    c.width = c.height = Math.max(4, Math.ceil(half * 2 * res));
    const g = c.getContext('2d')!;
    g.scale(res, res);
    g.translate(half, half);
    const ang = facing * (Math.PI / 4);
    this.drawMember(g, kind, Math.cos(ang), Math.sin(ang), ang, mr, this.pal[owner], flash);
    e = { c, half };
    this.spriteCache.set(key, e);
    return e;
  }

  private badgeSprite(owner: number, kind: UnitKind): HTMLCanvasElement {
    const key = `b${owner}${kind}${this.dpr}`;
    const hit = this.spriteCache.get(key);
    if (hit) return hit.c;
    const k = this.dpr * 2;
    const c = document.createElement('canvas');
    c.width = c.height = Math.ceil(22 * k);
    const g = c.getContext('2d')!;
    g.scale(k, k);
    g.fillStyle = owner === HUMAN ? 'rgba(26,36,58,0.92)' : 'rgba(64,22,18,0.92)';
    g.beginPath();
    g.arc(11, 11, 9, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = this.pal[owner].light;
    g.lineWidth = 1.5;
    g.stroke();
    drawIcon(g, kind as IconName, 11, 11, 12.2, '#fff6e0', 2.6);
    this.spriteCache.set(key, { c, half: 0 });
    return c;
  }

  private drawMember(g: CanvasRenderingContext2D, kind: UnitKind, ca: number, sa: number, ang: number, mr: number, P: Palette, flash: boolean) {
    const px = 0;
    const py = 0;
    if (kind === 'ram') {
      this.drawRam(g, px, py, ca, sa, P);
      return;
    }
    if (kind === 'cavalry' || kind === 'knight') {
      g.save();
      g.rotate(ang);
      g.fillStyle = 'rgba(20,14,6,0.35)';
      g.beginPath();
      g.ellipse(0.03, 0.05, mr * 1.5, mr * 0.75, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = kind === 'knight' ? '#e8e2d4' : '#8a5a34';
      g.beginPath();
      g.ellipse(0, 0, mr * 1.45, mr * 0.68, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.ellipse(mr * 1.35, 0, mr * 0.5, mr * 0.34, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    g.fillStyle = 'rgba(20,14,6,0.35)';
    g.beginPath();
    g.arc(px + 0.03, py + 0.05, mr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = flash ? '#fff4e0' : P.dark;
    g.beginPath();
    g.arc(px, py, mr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = flash ? '#ffffff' : P.base;
    g.beginPath();
    g.arc(px - mr * 0.15, py - mr * 0.18, mr * 0.72, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = kind === 'sword' || kind === 'knight' ? '#c9ccd2' : '#f0d3a8';
    g.beginPath();
    g.arc(px + ca * mr * 0.15, py + sa * mr * 0.15, mr * 0.42, 0, Math.PI * 2);
    g.fill();
    this.weapon(g, kind, px, py, ca, sa, mr);
  }

  private weapon(g: CanvasRenderingContext2D, kind: UnitKind, px: number, py: number, ca: number, sa: number, mr: number) {
    g.lineCap = 'round';
    switch (kind) {
      case 'spear':
        g.strokeStyle = '#6b4a2a';
        g.lineWidth = 0.035;
        g.beginPath();
        g.moveTo(px - ca * mr * 0.6 + sa * mr * 0.6, py - sa * mr * 0.6 - ca * mr * 0.6);
        g.lineTo(px + ca * mr * 2.2 + sa * mr * 0.6, py + sa * mr * 2.2 - ca * mr * 0.6);
        g.stroke();
        g.fillStyle = '#d8dde4';
        g.beginPath();
        g.arc(px + ca * mr * 2.2 + sa * mr * 0.6, py + sa * mr * 2.2 - ca * mr * 0.6, 0.03, 0, Math.PI * 2);
        g.fill();
        break;
      case 'archer':
        g.strokeStyle = '#6b4a2a';
        g.lineWidth = 0.03;
        g.beginPath();
        g.arc(px + ca * mr * 0.5, py + sa * mr * 0.5, mr * 1.05, Math.atan2(sa, ca) - 1.1, Math.atan2(sa, ca) + 1.1);
        g.stroke();
        break;
      case 'sword':
      case 'knight':
        g.strokeStyle = '#dfe3ea';
        g.lineWidth = 0.035;
        g.beginPath();
        g.moveTo(px + ca * mr * 0.6 - sa * mr * 0.7, py + sa * mr * 0.6 + ca * mr * 0.7);
        g.lineTo(px + ca * mr * 1.8 - sa * mr * 0.7, py + sa * mr * 1.8 + ca * mr * 0.7);
        g.stroke();
        break;
      case 'scout':
        g.strokeStyle = '#efe6d0';
        g.lineWidth = 0.03;
        g.beginPath();
        g.moveTo(px - ca * mr * 0.8, py - sa * mr * 0.8);
        g.lineTo(px - ca * mr * 1.6 + sa * mr * 0.3, py - sa * mr * 1.6 - ca * mr * 0.3);
        g.stroke();
        break;
      default:
        break;
    }
  }

  private drawRam(g: CanvasRenderingContext2D, px: number, py: number, ca: number, sa: number, P: Palette) {
    const ang = Math.atan2(sa, ca);
    g.save();
    g.translate(px, py);
    g.rotate(ang);
    g.fillStyle = 'rgba(20,14,6,0.35)';
    g.fillRect(-0.42, -0.24, 0.9, 0.56);
    g.fillStyle = '#5b3d22';
    for (const wx of [-0.28, 0.22]) for (const wy of [-0.3, 0.26]) g.fillRect(wx, wy, 0.16, 0.06);
    g.fillStyle = '#7a5532';
    g.fillRect(-0.4, -0.26, 0.8, 0.52);
    g.fillStyle = P.dark;
    g.beginPath();
    g.moveTo(-0.4, -0.26);
    g.lineTo(0.4, -0.26);
    g.lineTo(0.4, 0.26);
    g.lineTo(-0.4, 0.26);
    g.closePath();
    g.fill();
    g.fillStyle = P.base;
    g.fillRect(-0.4, -0.26, 0.8, 0.24);
    g.fillStyle = '#4a4440';
    g.fillRect(0.38, -0.07, 0.2, 0.14);
    g.restore();
  }

  // ------------------------------------------------------------ fx

  private drawFx(now: number) {
    const g = this.ctx;
    const s = this.s!;
    this.worldTx();
    for (const f of s.fx) {
      if (!f.active) continue;
      const t = (now - f.t0) / f.dur;
      if (t >= 1 || t < -0.5) {
        f.active = false;
        continue;
      }
      if (t < 0) continue;
      if (f.kind === 0) {
        // arrow in flight with a slight arc
        const x = (f.x0 + (f.x1 - f.x0) * t) / TILE;
        const y = (f.y0 + (f.y1 - f.y0) * t) / TILE - Math.sin(t * Math.PI) * 0.6;
        const dx = (f.x1 - f.x0) / TILE;
        const dy = (f.y1 - f.y0) / TILE - Math.cos(t * Math.PI) * 0.6 * Math.PI * 0.4;
        const l = Math.hypot(dx, dy) || 1;
        g.strokeStyle = f.color;
        g.lineWidth = 0.045;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x - (dx / l) * 0.28, y - (dy / l) * 0.28);
        g.lineTo(x, y);
        g.stroke();
        g.strokeStyle = '#f4ecd8';
        g.lineWidth = 0.035;
        g.beginPath();
        g.moveTo(x - (dx / l) * 0.28, y - (dy / l) * 0.28);
        g.lineTo(x - (dx / l) * 0.2, y - (dy / l) * 0.2);
        g.stroke();
      } else if (f.kind === 1) {
        const x = f.x0 / TILE + Math.sin(f.t0) * 0.15;
        const y = f.y0 / TILE + Math.cos(f.t0) * 0.15;
        const r = 0.12 + t * 0.25;
        g.strokeStyle = `rgba(255,243,196,${1 - t})`;
        g.lineWidth = 0.05;
        g.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = i * (Math.PI / 2) + f.t0;
          g.moveTo(x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4);
          g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        g.stroke();
      } else if (f.kind === 2) {
        const x = f.x0 / TILE;
        const y = f.y0 / TILE;
        const base = f.big ? 1.2 : 0.45;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + f.t0 * 0.001;
          const d = base * (0.3 + t * 0.9);
          g.fillStyle = `rgba(233,225,207,${(1 - t) * 0.75})`;
          g.beginPath();
          g.arc(x + Math.cos(a) * d * 0.6, y + Math.sin(a) * d * 0.5 - t * 0.4, base * (0.35 + t * 0.4), 0, Math.PI * 2);
          g.fill();
        }
      } else if (f.kind === 3) {
        const x = f.x0 / TILE;
        const y = f.y0 / TILE;
        const r = 0.2 + t * 0.55;
        g.strokeStyle = f.color;
        g.globalAlpha = 1 - t;
        g.lineWidth = 2.2 / this.cam.zoom;
        g.beginPath();
        g.ellipse(x, y, r, r * 0.75, 0, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
    }
  }

  // ------------------------------------------------------------ minimap

  drawMinimap(mm: HTMLCanvasElement) {
    const s = this.s;
    if (!s || !this.terrain) return;
    const g = mm.getContext('2d')!;
    const W = mm.width;
    const H = mm.height;
    const st = s.state;
    const kx = W / st.mapW;
    const ky = H / st.mapH;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.terrain.mini, 0, 0, W, H);
    g.save();
    g.scale(kx, ky);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.fog, 0, 0, st.mapW, st.mapH);
    g.restore();
    const dot = (mx: number, my: number, r: number, col: string, ring?: string) => {
      g.fillStyle = col;
      g.beginPath();
      g.arc((mx / TILE) * kx, (my / TILE) * ky, r, 0, Math.PI * 2);
      g.fill();
      if (ring) {
        g.strokeStyle = ring;
        g.lineWidth = 1.5;
        g.stroke();
      }
    };
    for (const p of st.points) dot(p.x, p.y, 4.5 * (W / 180), p.owner >= 0 ? this.pal[p.owner].base : '#e8dfc6', '#1d1a14');
    const sq = (mx: number, my: number, r: number, col: string) => {
      g.fillStyle = '#1d1a14';
      g.fillRect((mx / TILE) * kx - r - 1, (my / TILE) * ky - r - 1, r * 2 + 2, r * 2 + 2);
      g.fillStyle = col;
      g.fillRect((mx / TILE) * kx - r, (my / TILE) * ky - r, r * 2, r * 2);
    };
    for (const r of s.remembered.values()) if (!s.isVisible(r.x, r.y)) sq(r.x, r.y, 3, this.pal[r.owner].dark);
    for (const b of st.buildings)
      if (b.owner === HUMAN || s.isVisible(b.x, b.y)) sq(b.x, b.y, b.kind === 'towncenter' ? 5 : 3, this.pal[b.owner].base);
    for (const q of st.squads)
      if (q.owner === HUMAN || s.isVisible(q.x, q.y)) dot(q.x, q.y, 2.4, q.owner === HUMAN ? '#9cc4ff' : '#ff9a8a');
    // camera rect
    const c = this.cam;
    g.strokeStyle = '#fff6da';
    g.lineWidth = 1.5;
    g.strokeRect(c.wx(0) * kx, c.wy(0) * ky, (c.viewW / c.zoom) * kx, (c.viewH / c.zoom) * ky);
    void CPU;
  }

  // ------------------------------------------------------------ hit testing

  /** Find the entity under a screen point. Returns typed result. */
  pick(px: number, py: number, touch: boolean): Pick {
    const s = this.s!;
    const st = s.state;
    const cam = this.cam;
    const wx = cam.wx(px) * TILE;
    const wy = cam.wy(py) * TILE;
    const slack = (touch ? 22 : 10) / cam.zoom * TILE; // finger tolerance in milli-tiles
    // squads first (smallest, on top)
    let best: Squad | null = null;
    let bestD = Infinity;
    for (const q of st.squads) {
      const sp = this.squadPos.get(q.id);
      if (!sp || sp.x < -1e8) continue;
      const d = Math.hypot(sp.x - wx, sp.y - wy);
      const lim = RULES.squadRadius + slack;
      // prefer own squads slightly when overlapping
      const dd = q.owner === HUMAN ? d - 150 : d;
      if (d <= lim && dd < bestD) {
        best = q;
        bestD = dd;
      }
    }
    if (best) return { t: 'squad', squad: best };
    for (const b of st.buildings) {
      if (b.owner !== HUMAN && !s.isVisible(b.x, b.y)) continue;
      const r = b.kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius;
      if (Math.abs(b.x - wx) <= r + slack * 0.5 && Math.abs(b.y - wy) <= r + slack * 0.5) return { t: 'building', building: b };
    }
    for (const r of s.remembered.values()) {
      if (s.isVisible(r.x, r.y)) continue;
      const rad = r.kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius;
      if (Math.abs(r.x - wx) <= rad && Math.abs(r.y - wy) <= rad) return { t: 'remembered', rem: r };
    }
    try {
      for (const sl of s.api.slots(st, HUMAN)) {
        if (sl.building) continue;
        const r = RULES.buildingRadius;
        if (Math.abs(sl.pos.x - wx) <= r + slack * 0.3 && Math.abs(sl.pos.y - wy) <= r + slack * 0.3) return { t: 'slot', slot: sl.slot };
      }
    } catch {
      /* sim not ready */
    }
    const plaque = Math.max(500, (15 / cam.zoom) * TILE) + slack * 0.5;
    for (const p of st.points) if (Math.hypot(p.x - wx, p.y - wy) <= plaque) return { t: 'point', point: p };
    return { t: 'ground', x: Math.round(wx), y: Math.round(wy) };
  }

  /** Own squads whose interpolated center lies inside a screen rectangle. */
  squadsInBox(x0: number, y0: number, x1: number, y1: number): number[] {
    const s = this.s!;
    const cam = this.cam;
    const ax = Math.min(x0, x1),
      bx = Math.max(x0, x1),
      ay = Math.min(y0, y1),
      by = Math.max(y0, y1);
    const out: number[] = [];
    for (const q of s.state.squads) {
      if (q.owner !== HUMAN) continue;
      const sp = this.squadPos.get(q.id);
      if (!sp) continue;
      const sx = cam.sx(sp.x);
      const sy = cam.sy(sp.y);
      if (sx >= ax && sx <= bx && sy >= ay && sy <= by) out.push(q.id);
    }
    return out;
  }
}

export type Pick =
  | { t: 'squad'; squad: Squad }
  | { t: 'building'; building: Building }
  | { t: 'remembered'; rem: Remembered }
  | { t: 'slot'; slot: number }
  | { t: 'point'; point: CapturePoint }
  | { t: 'ground'; x: number; y: number };

export const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
void TERRAIN_PX;
