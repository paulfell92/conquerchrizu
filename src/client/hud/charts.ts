/**
 * End screen „Auswertung“: small canvas line charts of the 5 s samples plus a
 * one-line insight (turning point of the VP race). Colors come from CSS tokens.
 */
import type { StatSample } from '../session';
import { formatClock } from '../util';

export interface ChartSpec {
  title: string;
  /** Pick the two series values from a sample. */
  get: (s: StatSample) => [number, number];
  /** Number formatting for the y axis and the end labels. */
  fmt?: (v: number) => string;
  /** Fixed y-axis maximum (e.g. the number of capture points). */
  max?: number;
}

export const CHARTS: ChartSpec[] = [
  { title: 'Siegpunkte', get: (s) => s.vp },
  { title: 'Armeestärke (Leben)', get: (s) => s.army, fmt: kfmt },
  { title: 'Gehaltene Punkte', get: (s) => s.points, max: 13 },
];

function kfmt(v: number): string {
  return v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
}

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Draw one chart into a canvas sized by CSS. `me` = local player index (drawn first in the legend). */
export function drawChart(cv: HTMLCanvasElement, samples: StatSample[], spec: ChartSpec, colors: [string, string]) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  const W = Math.max(120, Math.round(r.width));
  const H = Math.max(70, Math.round(r.height));
  cv.width = W * dpr;
  cv.height = H * dpr;
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const fmt = spec.fmt ?? ((v: number) => String(Math.round(v)));
  const ink = token('--parch-dim', '#c9bb9a');
  const grid = 'rgba(217,178,90,0.16)';
  const font = token('--sans', 'system-ui, sans-serif');
  if (samples.length < 2) {
    g.fillStyle = ink;
    g.font = `12px ${font}`;
    g.fillText('Zu kurz für eine Kurve', 8, H / 2);
    return;
  }
  const t0 = samples[0].tick;
  const t1 = samples[samples.length - 1].tick;
  let max = 1;
  for (const s of samples) {
    const [a, b] = spec.get(s);
    if (a > max) max = a;
    if (b > max) max = b;
  }
  max = spec.max ?? niceMax(max);
  const L = 34;
  const R = 8;
  const T = 6;
  const B = 18;
  const pw = W - L - R;
  const ph = H - T - B;
  const X = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * pw;
  const Y = (v: number) => T + ph - (v / max) * ph;
  // grid + y labels
  g.font = `10px ${font}`;
  g.textBaseline = 'middle';
  g.textAlign = 'right';
  g.strokeStyle = grid;
  g.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const v = (max * i) / 2;
    const y = Math.round(Y(v)) + 0.5;
    g.beginPath();
    g.moveTo(L, y);
    g.lineTo(W - R, y);
    g.stroke();
    g.fillStyle = ink;
    g.fillText(fmt(v), L - 4, y);
  }
  // x labels (mm:ss) at start, middle, end
  g.textBaseline = 'top';
  for (const [f, align] of [
    [0, 'left'],
    [0.5, 'center'],
    [1, 'right'],
  ] as const) {
    const t = t0 + (t1 - t0) * f;
    g.textAlign = align;
    g.fillText(formatClock(Math.round(t)), X(t), H - B + 4);
  }
  // series
  for (const k of [0, 1] as const) {
    g.strokeStyle = colors[k];
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    samples.forEach((s, i) => {
      const x = X(s.tick);
      const y = Y(spec.get(s)[k]);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    const last = samples[samples.length - 1];
    g.fillStyle = colors[k];
    g.beginPath();
    g.arc(X(last.tick), Y(spec.get(last)[k]), 3, 0, Math.PI * 2);
    g.fill();
  }
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Insight line: the last change of the VP leader, else the largest 30 s swing
 * of the VP difference. `names` = display names for player 0 / 1.
 */
export function insight(samples: StatSample[], names: [string, string]): string {
  if (samples.length < 3) return 'Das Spiel war zu kurz für eine Auswertung.';
  const lead = (s: StatSample) => Math.sign(s.vp[0] - s.vp[1]);
  let lastFlip = -1;
  for (let i = 1; i < samples.length; i++) {
    const a = lead(samples[i - 1]);
    const b = lead(samples[i]);
    if (b !== 0 && a !== b) lastFlip = i;
  }
  if (lastFlip > 0) {
    const s = samples[lastFlip];
    const who = s.vp[0] > s.vp[1] ? 0 : 1;
    const pts = s.points[who] - s.points[1 - who];
    const why = pts > 0 ? ` mit ${pts} ${pts === 1 ? 'Punkt' : 'Punkten'} mehr auf der Karte` : '';
    return `Wendepunkt bei ${formatClock(s.tick)} – ${names[who]} übernimmt die Führung${why}.`;
  }
  // largest swing over 30 s (6 samples)
  let best = 0;
  let at = 0;
  for (let i = 6; i < samples.length; i++) {
    const d0 = samples[i - 6].vp[0] - samples[i - 6].vp[1];
    const d1 = samples[i].vp[0] - samples[i].vp[1];
    if (Math.abs(d1 - d0) > Math.abs(best)) {
      best = d1 - d0;
      at = i;
    }
  }
  if (best !== 0) {
    const who = best > 0 ? 0 : 1;
    return `Wendepunkt bei ${formatClock(samples[at].tick)} – ${names[who]} holt in 30 s ${Math.abs(best)} Siegpunkte Vorsprung.`;
  }
  return 'Ein ausgeglichenes Spiel ohne klaren Wendepunkt.';
}
