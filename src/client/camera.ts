import { TILE } from '../sim/types';
import { clamp } from './util';

/**
 * Camera in world tiles (float). `x,y` = world tile at the screen center.
 * `zoom` = CSS pixels per tile. Screen coordinates are CSS pixels.
 */
export class Camera {
  x = 10;
  y = 18;
  zoom = 40;
  viewW = 800;
  viewH = 400;
  mapW = 57;
  mapH = 36;
  /** Insets (CSS px) covered by HUD, so clamping can let the map scroll under it. */
  padTop = 0;
  padBottom = 0;
  minZoom = 14;
  maxZoom = 90;

  setView(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
    // min zoom: whole map height fits (a bit of slack)
    this.minZoom = Math.min(w / this.mapW, h / this.mapH) * 0.95;
    this.maxZoom = Math.max(this.minZoom * 2, 96);
    this.zoom = clamp(this.zoom, this.minZoom, this.maxZoom);
    this.clamp();
  }

  setMap(w: number, h: number) {
    this.mapW = w;
    this.mapH = h;
    this.setView(this.viewW, this.viewH);
  }

  clamp() {
    const halfW = this.viewW / 2 / this.zoom;
    const halfH = this.viewH / 2 / this.zoom;
    const extraT = this.padTop / this.zoom;
    const extraB = this.padBottom / this.zoom;
    // allow showing a margin of 1.5 tiles beyond the map edge
    const m = 1.5;
    const minX = halfW - m;
    const maxX = this.mapW - halfW + m;
    const minY = halfH - m - extraT;
    const maxY = this.mapH - halfH + m + extraB;
    this.x = minX > maxX ? this.mapW / 2 : clamp(this.x, minX, maxX);
    this.y = minY > maxY ? this.mapH / 2 : clamp(this.y, minY, maxY);
  }

  /** world milli-tiles → screen css px */
  sx(mx: number): number {
    return (mx / TILE - this.x) * this.zoom + this.viewW / 2;
  }
  sy(my: number): number {
    return (my / TILE - this.y) * this.zoom + this.viewH / 2;
  }
  /** screen css px → world tiles (float) */
  wx(px: number): number {
    return (px - this.viewW / 2) / this.zoom + this.x;
  }
  wy(py: number): number {
    return (py - this.viewH / 2) / this.zoom + this.y;
  }

  pan(dxPx: number, dyPx: number) {
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
    this.clamp();
  }

  /** Zoom keeping the world point under (px,py) fixed. */
  zoomAt(px: number, py: number, factor: number) {
    const wx = this.wx(px);
    const wy = this.wy(py);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    this.x = wx - (px - this.viewW / 2) / this.zoom;
    this.y = wy - (py - this.viewH / 2) / this.zoom;
    this.clamp();
  }

  centerOn(mx: number, my: number) {
    this.x = mx / TILE;
    this.y = my / TILE;
    this.clamp();
  }
}
