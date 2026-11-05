/**
 * Icon set as SVG path data on a 24×24 grid. The same strings are used for the
 * DOM HUD (inline <svg>) and for canvas drawing (Path2D), so the world and the
 * HUD speak one visual language. Stroke icons, round caps.
 */
export const ICONS = {
  food: 'M12 22V9M12 9C9 8 8 5 8 3c3 0 4 2 4 6M12 9c3-1 4-4 4-6-3 0-4 2-4 6M12 14c-3-1-5-3-5-5 3 0 5 2 5 5M12 14c3-1 5-3 5-5-3 0-5 2-5 5M12 19c-3-1-5-3-5-5 3 0 5 2 5 5M12 19c3-1 5-3 5-5-3 0-5 2-5 5',
  wood: 'M6 8h12a4 4 0 0 1 0 8H6M6 8a4 4 0 0 0 0 8a4 4 0 0 0 0-8M6 11a1 1 0 0 0 0 2M12 12h5',
  gold: 'M5 7a7 3 0 1 0 14 0a7 3 0 1 0-14 0M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5',
  pop: 'M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7',
  scout: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  spear: 'M5 19L15 9M13.5 5.5L20 4l-1.5 6.5zM4 16l4 4',
  archer: 'M6 3c9 2 11 16 0 18M6 3v18M3 12h16M16 9l3 3-3 3',
  cavalry: 'M8 21c0-4 1.5-6 1.5-9L5 13.5 4 10.5 10 5h3l1.5-2.5L16 5c3 2 4 6 4 9v7M12.5 8.5h.1',
  sword: 'M12 2.5l2 2.5v10h-4V5zM7 15h10M12 15v6.5',
  ram: 'M2 10h15l4 2-4 2H2zM7 19a2 2 0 1 0 0.01 0M15 19a2 2 0 1 0 0.01 0M5 14l2 3M15 14l0 3',
  knight: 'M6 20v-8a6 6 0 0 1 12 0v8zM8.5 13h7M12 13v7M12 6c1-3 4-4 6-3.5',
  towncenter: 'M4 21V9h3V6h3v3h4V6h3v3h3v12zM10 21v-5a2 2 0 0 1 4 0v5',
  barracks: 'M4 4l16 16M20 4L4 20M3 17l4 4M21 17l-4 4',
  range: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9M12 11.5a.5.5 0 1 0 0 1a.5.5 0 1 0 0-1',
  stable: 'M6.5 21V11a5.5 5.5 0 0 1 11 0v10M4.5 21h4M15.5 21h4M9 12.5h.1M15 12.5h.1M9 16.5h.1M15 16.5h.1',
  blacksmith: 'M3 7h13c0 3 2 4.5 5 4.5V14h-6l2 6H7l2-6c-3.5 0-6-2.5-6-7z',
  workshop: 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  tower: 'M7 21V9H5V3h3v2h2V3h4v2h2V3h3v6h-2v12zM10.5 21v-4h3v4M11 11h2',
  village: 'M3 11l9-8 9 8M5 9v12h14V9M10 21v-6h4v6',
  forest: 'M12 2l6 9h-3l4 6H5l4-6H6zM12 17v5',
  mine: 'M3 9.5c5-5.5 13-5.5 18 0M12 5.3L6.5 21',
  age: 'M3 19h18M3 19L4 7l5 5 3-7 3 7 5-5 1 12',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4.5l12 7.5-12 7.5z',
  flag: 'M5 21V4M5 4h12l-3 4 3 4H5',
  retreat: 'M9.5 6L4 11.5 9.5 17M4 11.5h11a5 5 0 0 1 5 5V20',
  stop: 'M6 6h12v12H6z',
  army: 'M8.5 4a3 3 0 1 0 0 6a3 3 0 1 0 0-6M15.5 4a3 3 0 1 0 0 6a3 3 0 1 0 0-6M2.5 20c0-3.5 2.5-6 6-6s6 2.5 6 6M15.5 14c3.5 0 6 2.5 6 6',
  select: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M10 12h4',
  upgrade: 'M12 20V5M6 11l6-6 6 6',
  cancel: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  hammer: 'M14 4l6 6-3 3-6-6zM12 9L4 17l3 3 8-8',
  build: 'M12 5v14M5 12h14',
} as const;

export type IconName = keyof typeof ICONS;

export function svgIcon(name: IconName, cls = 'ic'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}

const pathCache = new Map<string, Path2D>();
export function iconPath(name: IconName): Path2D {
  let p = pathCache.get(name);
  if (!p) {
    p = new Path2D(ICONS[name]);
    pathCache.set(name, p);
  }
  return p;
}

/** Draw an icon centered at (x,y) with the given size in current canvas units. */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  x: number,
  y: number,
  size: number,
  color: string,
  lineWidth = 2.2,
): void {
  const s = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(iconPath(name));
  ctx.restore();
}
