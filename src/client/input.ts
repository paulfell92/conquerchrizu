/**
 * Unified pointer input (touch + mouse + pen) and keyboard.
 *  - one finger / left mouse tap: select or command (see Controller.tap)
 *  - one finger drag: pan (or box select when the „Auswahl“ toggle is on)
 *  - two fingers: pinch zoom + pan
 *  - mouse: left drag = box select, right click = move/attack, right/middle drag = pan, wheel = zoom
 */
import type { Camera } from './camera';

export interface InputHandler {
  tap(x: number, y: number, opts: { touch: boolean; shift: boolean; double: boolean }): void;
  command(x: number, y: number): void; // right click
  boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean): void;
  boxPreview(b: { x0: number; y0: number; x1: number; y1: number } | null): void;
  key(e: KeyboardEvent): void;
  boxModeTouch(): boolean;
  /** Called when the camera moved through user input. */
  cameraMoved(): void;
}

interface Ptr {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  type: string;
  button: number;
}

export class Input {
  private ptrs = new Map<number, Ptr>();
  private mode: 'none' | 'pending' | 'pan' | 'box' | 'pinch' = 'none';
  private pinchDist = 0;
  private pinchCx = 0;
  private pinchCy = 0;
  private lastTapT = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private suppressUntilAllUp = false;
  /** Keyboard pan state */
  private keys = new Set<string>();

  constructor(
    private el: HTMLElement,
    private cam: Camera,
    private h: InputHandler,
  ) {
    el.addEventListener('pointerdown', this.down, { passive: false });
    window.addEventListener('pointermove', this.move, { passive: false });
    window.addEventListener('pointerup', this.up, { passive: false });
    window.addEventListener('pointercancel', this.cancel, { passive: false });
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const p = this.local(e);
    this.ptrs.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, t0: performance.now(), type: e.pointerType, button: e.button });
    if (this.ptrs.size === 2) {
      // second finger: switch to pinch, cancel any box
      if (this.mode === 'box') this.h.boxPreview(null);
      this.mode = 'pinch';
      this.initPinch();
      this.suppressUntilAllUp = true;
    } else if (this.ptrs.size === 1) {
      this.mode = 'pending';
    }
  };

  private initPinch() {
    const [a, b] = [...this.ptrs.values()];
    this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchCx = (a.x + b.x) / 2;
    this.pinchCy = (a.y + b.y) / 2;
  }

  private move = (e: PointerEvent) => {
    const ptr = this.ptrs.get(e.pointerId);
    if (!ptr) return;
    e.preventDefault();
    const p = this.local(e);
    const dx = p.x - ptr.x;
    const dy = p.y - ptr.y;
    ptr.x = p.x;
    ptr.y = p.y;
    if (this.mode === 'pinch' && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      this.cam.pan(cx - this.pinchCx, cy - this.pinchCy);
      this.cam.zoomAt(cx, cy, d / this.pinchDist);
      this.pinchDist = d;
      this.pinchCx = cx;
      this.pinchCy = cy;
      this.h.cameraMoved();
      return;
    }
    if (this.mode === 'pending') {
      const thr = ptr.type === 'mouse' ? 5 : 10;
      if (Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > thr) {
        const mouseLeft = ptr.type === 'mouse' && ptr.button === 0;
        const boxTouch = ptr.type !== 'mouse' && this.h.boxModeTouch();
        this.mode = mouseLeft || boxTouch ? 'box' : 'pan';
        if (this.mode === 'pan') this.cam.pan(p.x - ptr.sx, p.y - ptr.sy);
      }
    } else if (this.mode === 'pan') {
      this.cam.pan(dx, dy);
      this.h.cameraMoved();
    }
    if (this.mode === 'box') this.h.boxPreview({ x0: ptr.sx, y0: ptr.sy, x1: p.x, y1: p.y });
  };

  private up = (e: PointerEvent) => {
    const ptr = this.ptrs.get(e.pointerId);
    if (!ptr) return;
    e.preventDefault();
    this.ptrs.delete(e.pointerId);
    const p = this.local(e);
    if (this.mode === 'pinch') {
      if (this.ptrs.size >= 2) this.initPinch();
      else if (this.ptrs.size === 1) {
        // continue as pan with the remaining finger
        this.mode = 'pan';
      }
      return;
    }
    if (this.ptrs.size === 0) {
      const wasSuppressed = this.suppressUntilAllUp;
      this.suppressUntilAllUp = false;
      if (this.mode === 'box') {
        this.h.boxPreview(null);
        this.h.boxSelect(ptr.sx, ptr.sy, p.x, p.y, e.shiftKey);
      } else if (this.mode === 'pending' && !wasSuppressed) {
        if (ptr.type === 'mouse' && ptr.button === 2) this.h.command(p.x, p.y);
        else if (ptr.type !== 'mouse' || ptr.button === 0) {
          const now = performance.now();
          const dbl = now - this.lastTapT < 320 && Math.hypot(p.x - this.lastTapX, p.y - this.lastTapY) < 24;
          this.lastTapT = dbl ? 0 : now;
          this.lastTapX = p.x;
          this.lastTapY = p.y;
          this.h.tap(p.x, p.y, { touch: ptr.type !== 'mouse', shift: e.shiftKey, double: dbl });
        }
      }
      this.mode = 'none';
    }
  };

  private cancel = (e: PointerEvent) => {
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size === 0) {
      if (this.mode === 'box') this.h.boxPreview(null);
      this.mode = 'none';
      this.suppressUntilAllUp = false;
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    this.cam.zoomAt(p.x, p.y, f);
    this.h.cameraMoved();
  };

  private keydown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key.startsWith('Arrow')) {
      this.keys.add(e.key);
      e.preventDefault();
      return;
    }
    this.h.key(e);
  };

  /** Keyboard panning, call every frame. */
  update(dtMs: number) {
    if (!this.keys.size) return;
    const v = (dtMs / 1000) * 700;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx += v;
    if (this.keys.has('ArrowRight')) dx -= v;
    if (this.keys.has('ArrowUp')) dy += v;
    if (this.keys.has('ArrowDown')) dy -= v;
    if (dx || dy) {
      this.cam.pan(dx, dy);
      this.h.cameraMoved();
    }
  }
}
