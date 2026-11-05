/**
 * Short guided tutorial (~2–3 min). A banner with the current step plus a
 * pulsing ring on the target (world position or HUD element). Steps advance
 * by watching the game state, never by timers alone. „Überspringen“ always.
 */
import type { CapturePoint, Squad } from '../../sim/types';
import { TILE } from '../../sim/types';
import { RULES } from '../../content';
import type { Camera } from '../camera';
import { HUMAN, type Session } from '../session';
import { svgIcon } from '../icons';

type Target =
  | { t: 'world'; x: number; y: number; r: number } // milli-tiles, radius in milli-tiles
  | { t: 'el'; sel: string }
  | null;

interface Step {
  title: string;
  text: string;
  /** Called every frame; returns true when the step is done. */
  done(s: Session, tut: Tutorial): boolean;
  target(s: Session, tut: Tutorial): Target;
  /** Show a „Weiter“ button instead of waiting for an action. */
  manual?: boolean;
  /** Pan the camera to the target when the step starts. */
  focus?: boolean;
}

export class Tutorial {
  private root: HTMLElement;
  private ring: HTMLElement;
  private i = 0;
  private s: Session;
  private shown = -1;
  private stepStart = 0;
  /** Squad / point / building ids the steps refer to. */
  spear: number | null = null;
  mine: number | null = null;
  barracksQueued = false;
  active = true;

  constructor(
    parent: HTMLElement,
    session: Session,
    private cam: Camera,
    private h: { finish(toMenu: boolean): void; focus(x: number, y: number): void },
  ) {
    this.s = session;
    const st = session.state;
    const sp = st.squads.find((q) => q.owner === HUMAN && q.kind === 'spear');
    this.spear = sp?.id ?? null;
    // the own mine closest to the own TC (the "Hausmine")
    const tc = session.api.townCenter(st, HUMAN);
    let best: CapturePoint | null = null;
    for (const p of st.points) {
      if (p.kind !== 'mine' || !tc) continue;
      if (!best || dist(p, tc) < dist(best, tc)) best = p;
    }
    this.mine = best?.id ?? null;

    this.root = document.createElement('div');
    this.root.id = 'tut';
    this.root.className = 'panel';
    this.root.innerHTML = `<div class="tstep"></div><div class="tbody"><h3></h3><p></p></div>
      <div class="tbtns"><button class="btn small primary hidden" data-a="next">Weiter</button>
      <button class="btn small" data-a="skip">Überspringen</button></div>`;
    parent.appendChild(this.root);
    this.ring = document.createElement('div');
    this.ring.id = 'tutring';
    parent.appendChild(this.ring);
    this.root.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (!a) return;
      if (a.dataset.a === 'skip') this.end(false);
      if (a.dataset.a === 'next') this.advance();
      if (a.dataset.a === 'menu') this.end(true);
      if (a.dataset.a === 'play') this.end(false);
    });
  }

  get step() {
    return this.i;
  }

  private squad(): Squad | null {
    return this.spear !== null ? this.s.squadById(this.spear) : null;
  }
  private point(): CapturePoint | null {
    return this.s.state.points.find((p) => p.id === this.mine) ?? null;
  }

  private readonly steps: Step[] = [
    {
      title: 'Trupp auswählen',
      text: 'Tippe einmal auf deine Speerträger. Einmal tippen wählt nur aus – es passiert noch nichts.',
      target: (s) => {
        const q = this.squad();
        return q ? { t: 'world', x: q.x, y: q.y, r: 900 } : { t: 'el', sel: '#cards .card' };
      },
      done: (s) => this.spear !== null && s.selected.has(this.spear),
      focus: true,
    },
    {
      title: 'Doppeltippen = Befehl',
      text: 'Tippe jetzt doppelt auf die Mine. Deine Speerträger marschieren hin und erobern sie.',
      target: () => {
        const p = this.point();
        return p ? { t: 'world', x: p.x, y: p.y, r: RULES.captureRadius * 0.55 } : null;
      },
      done: (s) => {
        const q = this.squad();
        const p = this.point();
        if (!q || !p) return true;
        const near = dist(q, p) <= RULES.captureRadius;
        return near || (q.order === 'move' && !!q.dest && dist(q.dest, p) <= RULES.captureRadius) || p.owner === HUMAN;
      },
      focus: true,
    },
    {
      title: 'Punkt erobern',
      text: 'Bleib im Kreis, bis der Ring voll ist. Minen bringen Gold, Wälder Holz, Dörfer Nahrung – jede Sekunde.',
      target: () => {
        const p = this.point();
        return p ? { t: 'world', x: p.x, y: p.y, r: RULES.captureRadius * 0.55 } : null;
      },
      done: () => this.point()?.owner === HUMAN,
    },
    {
      title: 'Kaserne bauen',
      text: 'Tippe auf einen freien Bauplatz neben deinem Dorfzentrum und wähle „Kaserne“.',
      target: (s) => {
        if (s.selSlot !== null) return { t: 'el', sel: '#ctx .act[data-k="barracks"]' };
        try {
          const free = s.api.slots(s.state, HUMAN).find((x) => !x.building);
          return free ? { t: 'world', x: free.pos.x, y: free.pos.y, r: 1300 } : null;
        } catch {
          return null;
        }
      },
      done: (s) => s.state.buildings.some((b) => b.owner === HUMAN && b.kind === 'barracks'),
      focus: true,
    },
    {
      title: 'Speerträger ausbilden',
      text: 'Tippe auf die Kaserne und dann auf „Speerträger“. Neue Trupps erscheinen unten in der Leiste.',
      target: (s) => {
        const b = s.state.buildings.find((x) => x.owner === HUMAN && x.kind === 'barracks');
        if (!b) return null;
        if (s.selBuilding === b.id && b.buildTicksLeft === 0) return { t: 'el', sel: '#ctx .act[data-u="spear"]' };
        return { t: 'world', x: b.x, y: b.y, r: 1400 };
      },
      done: (s) => {
        const b = s.state.buildings.find((x) => x.owner === HUMAN && x.kind === 'barracks');
        return !!b && b.queue.some((q) => q.item === 'spear');
      },
    },
    {
      title: 'Siegpunkte & Friedenszeit',
      text: 'Oben siehst du die Siegpunkte. Wer weniger Punkte hält, verliert jede Sekunde welche. Während der Friedenszeit kann niemand angreifen – nutze sie zum Aufbauen.',
      target: () => ({ t: 'el', sel: '#vp' }),
      done: () => false,
      manual: true,
    },
    {
      title: 'Du bist bereit!',
      text: 'Einmal tippen = auswählen, doppelt tippen = Befehl. Viel Erfolg im Chrizu-Tal.',
      target: () => null,
      done: () => false,
      manual: true,
    },
  ];

  private advance() {
    this.i++;
    if (this.i >= this.steps.length) this.end(true);
  }

  private end(toMenu: boolean) {
    if (!this.active) return;
    this.active = false;
    this.root.remove();
    this.ring.remove();
    this.h.finish(toMenu);
  }

  destroy() {
    this.active = false;
    this.root.remove();
    this.ring.remove();
  }

  /** Per frame. */
  update(now: number) {
    if (!this.active) return;
    const s = this.s;
    let step = this.steps[this.i];
    // auto-advance (allow skipping several finished steps at once, e.g. if the player is ahead)
    let guard = 0;
    while (step && !step.manual && step.done(s, this) && guard++ < 8) {
      this.i++;
      step = this.steps[this.i];
    }
    if (!step) return this.end(true);
    if (this.shown !== this.i) {
      this.shown = this.i;
      this.stepStart = now;
      this.root.querySelector('.tstep')!.textContent = `${this.i + 1}/${this.steps.length}`;
      this.root.querySelector('h3')!.textContent = step.title;
      this.root.querySelector('p')!.textContent = step.text;
      const next = this.root.querySelector('[data-a="next"]') as HTMLElement;
      const last = this.i === this.steps.length - 1;
      const btns = this.root.querySelector('.tbtns')!;
      if (last) {
        btns.innerHTML = `<button class="btn small primary" data-a="play">${svgIcon('play')}Weiterspielen</button>
          <button class="btn small" data-a="menu">Zum Menü</button>`;
      } else next.classList.toggle('hidden', !step.manual);
      if (step.focus) {
        const tg = step.target(s, this);
        if (tg && tg.t === 'world') this.h.focus(tg.x, tg.y);
      }
    }
    // ring placement
    const tg = step.target(s, this);
    const ring = this.ring;
    if (!tg) {
      ring.style.display = 'none';
      return;
    }
    let cx = 0;
    let cy = 0;
    let r = 0;
    if (tg.t === 'world') {
      cx = this.cam.sx(tg.x);
      cy = this.cam.sy(tg.y);
      r = Math.max(26, (tg.r / TILE) * this.cam.zoom);
    } else {
      const el = document.querySelector(tg.sel) as HTMLElement | null;
      if (!el || el.offsetParent === null) {
        ring.style.display = 'none';
        return;
      }
      const b = el.getBoundingClientRect();
      cx = b.left + b.width / 2;
      cy = b.top + b.height / 2;
      ring.classList.add('box');
      ring.style.display = 'block';
      ring.style.left = `${b.left - 5}px`;
      ring.style.top = `${b.top - 5}px`;
      ring.style.width = `${b.width + 10}px`;
      ring.style.height = `${b.height + 10}px`;
      return;
    }
    ring.classList.remove('box');
    ring.style.display = 'block';
    ring.style.left = `${cx - r}px`;
    ring.style.top = `${cy - r}px`;
    ring.style.width = ring.style.height = `${r * 2}px`;
    void this.stepStart;
  }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
