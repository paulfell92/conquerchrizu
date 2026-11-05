/** Start menu, pause overlay, end screen, rotate hint. */
import type { GameState, WinReason } from '../../sim/types';
import type { Difficulty } from '../../bot';
import { formatClock } from '../util';
import { svgIcon } from '../icons';
import { HUMAN, CPU } from '../session';

const DIFF: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Leicht' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Schwer' },
];

const SHIELD = `<svg class="shield" viewBox="0 0 58 68" aria-hidden="true">
  <path d="M29 2 L55 10 V32 C55 50 43 61 29 66 C15 61 3 50 3 32 V10 Z" fill="#2a2118" stroke="#d9b25a" stroke-width="2.5"/>
  <path d="M29 7 V61 C17 56 8 47 8 32 V13.5 Z" fill="#3d7be0"/>
  <path d="M29 7 L50 13.5 V32 C50 47 41 56 29 61 Z" fill="#d9483b"/>
  <path d="M18 40 L40 18 M36 17 L41.5 16.5 L41 22 M17 36 L22 41" stroke="#f3e8cc" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M40 40 L18 18 M22 17 L16.5 16.5 L17 22 M41 36 L36 41" stroke="#f3e8cc" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`;

const REASON: Record<WinReason, [string, string]> = {
  // [win text, lose text]
  towncenter: ['Das gegnerische Dorfzentrum ist gefallen.', 'Dein Dorfzentrum wurde zerstört.'],
  vp: ['Die CPU hat keine Siegpunkte mehr.', 'Deine Siegpunkte sind aufgebraucht.'],
  timeout: ['Zeit abgelaufen – du hattest mehr Siegpunkte.', 'Zeit abgelaufen – die CPU hatte mehr Siegpunkte.'],
  surrender: ['Die CPU hat aufgegeben.', 'Du hast aufgegeben.'],
};

export class Menus {
  private menu: HTMLElement;
  private pause: HTMLElement;
  private end: HTMLElement;
  difficulty: Difficulty = 'normal';

  constructor(
    parent: HTMLElement,
    private h: { start(d: Difficulty): void; resume(): void; surrender(): void; toMenu(): void },
  ) {
    try {
      const d = localStorage.getItem('cc.difficulty') as Difficulty | null;
      if (d && DIFF.some((x) => x.id === d)) this.difficulty = d;
    } catch {
      /* storage blocked */
    }
    this.menu = document.createElement('div');
    this.menu.id = 'menu';
    this.menu.className = 'overlay';
    this.menu.innerHTML = `
      <div class="menu">
        <div class="title">
          <div class="crest">${SHIELD}</div>
          <h1>Conquer<span>Chrizu</span></h1>
          <p class="lede">Zwei Burgen, ein Tal, dreizehn Dörfer, Wälder und Minen. Wer das Land hält, gewinnt.</p>
        </div>
        <div class="box panel">
          <h2>Schwierigkeit</h2>
          <div class="seg" role="radiogroup">${DIFF.map((d) => `<button data-d="${d.id}" role="radio">${d.label}</button>`).join('')}</div>
          <button class="btn primary" id="startbtn">${svgIcon('play')}Spiel starten</button>
          <ol class="howto">
            <li><b>Trupps wählen:</b> Antippen oder unten in der Leiste. Boden tippen = marschieren, Gegner tippen = angreifen.</li>
            <li><b>Punkte erobern:</b> Stell dich in den Kreis von Dorf, Wald oder Mine – sie bringen Nahrung, Holz und Gold.</li>
            <li><b>Basis ausbauen:</b> Tippe auf einen freien Bauplatz neben dem Dorfzentrum und bilde neue Trupps aus.</li>
            <li><b>Sieg:</b> Wer weniger Punkte hält, verliert Siegpunkte. Fällt dein Dorfzentrum, ist das Spiel vorbei.</li>
          </ol>
          <div class="foot">Ziehen = Karte bewegen · Zwei Finger = Zoom</div>
        </div>
      </div>`;
    parent.appendChild(this.menu);
    this.menu.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
      b.addEventListener('click', () => {
        this.difficulty = b.dataset.d as Difficulty;
        try {
          localStorage.setItem('cc.difficulty', this.difficulty);
        } catch {
          /* ignore */
        }
        this.syncSeg();
      }),
    );
    this.menu.querySelector('#startbtn')!.addEventListener('click', () => h.start(this.difficulty));
    this.syncSeg();

    this.pause = document.createElement('div');
    this.pause.className = 'overlay dim hidden';
    this.pause.innerHTML = `<div class="dialog panel"><h2>Pause</h2><p class="sub">Das Spiel ist angehalten.</p>
      <div class="btns"><button class="btn primary" data-a="resume">${svgIcon('play')}Weiterspielen</button>
      <button class="btn danger" data-a="surrender">${svgIcon('flag')}Aufgeben</button></div></div>`;
    parent.appendChild(this.pause);
    this.pause.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (a?.dataset.a === 'resume') h.resume();
      if (a?.dataset.a === 'surrender') h.surrender();
    });

    this.end = document.createElement('div');
    this.end.className = 'overlay dim hidden';
    parent.appendChild(this.end);
    this.end.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (a?.dataset.a === 'new') h.toMenu();
    });

    const rot = document.createElement('div');
    rot.id = 'rotate';
    rot.className = 'panel';
    rot.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M2 14a8 8 0 0 0 6 7M20 10a8 8 0 0 0-6-7"/></svg>Bitte Gerät drehen<small style="font-family:var(--sans);font-size:12px;color:var(--parch-dim)">Conquer Chrizu spielt sich im Querformat.</small>`;
    parent.appendChild(rot);
  }

  private syncSeg() {
    this.menu.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => {
      const on = b.dataset.d === this.difficulty;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  showMenu(v: boolean) {
    this.menu.classList.toggle('hidden', !v);
    if (v) (this.menu.querySelector('#startbtn') as HTMLElement).focus({ preventScroll: true });
  }
  showPause(v: boolean) {
    this.pause.classList.toggle('hidden', !v);
  }
  get pauseVisible() {
    return !this.pause.classList.contains('hidden');
  }

  showEnd(st: GameState | null) {
    if (!st) {
      this.end.classList.add('hidden');
      return;
    }
    const win = st.winner === HUMAN;
    const draw = st.winner === -1;
    const reason = st.winReason ?? 'timeout';
    const txt = draw ? 'Zeit abgelaufen – beide Seiten haben gleich viele Siegpunkte.' : REASON[reason][win ? 0 : 1];
    const a = st.players[HUMAN];
    const b = st.players[CPU];
    const pts = [0, 0];
    for (const p of st.points) if (p.owner >= 0) pts[p.owner]++;
    const row = (label: string, x: number | string, y: number | string) => `<tr><td>${label}</td><td>${x}</td><td>${y}</td></tr>`;
    this.end.innerHTML = `<div class="dialog panel end ${win ? 'win' : draw ? '' : 'lose'}">
      <h2>${win ? 'Sieg!' : draw ? 'Unentschieden' : 'Niederlage'}</h2>
      <p class="sub">${txt} Spieldauer ${formatClock(st.tick)}.</p>
      <table><thead><tr><th></th><th class="p0">Du</th><th class="p1">CPU</th></tr></thead><tbody>
      ${row('Siegpunkte', Math.max(0, a.vp), Math.max(0, b.vp))}
      ${row('Gehaltene Punkte', pts[0], pts[1])}
      ${row('Punkte erobert', a.stats.pointsCaptured, b.stats.pointsCaptured)}
      ${row('Trupps ausgebildet', a.stats.squadsTrained, b.stats.squadsTrained)}
      ${row('Trupps besiegt', a.stats.squadsKilled, b.stats.squadsKilled)}
      ${row('Trupps verloren', a.stats.squadsLost, b.stats.squadsLost)}
      ${row('Rohstoffe gesammelt', a.stats.resourcesGathered, b.stats.resourcesGathered)}
      </tbody></table>
      <div class="btns"><button class="btn primary" data-a="new">${svgIcon('play')}Neues Spiel</button></div></div>`;
    this.end.classList.remove('hidden');
  }
}
