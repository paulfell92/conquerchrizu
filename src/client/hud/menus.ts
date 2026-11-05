/**
 * Start menu (with sub-screens: Kampagne, Online), mission briefing, pause
 * overlay, end screen with „Auswertung“, rotate hint. Plain DOM.
 */
import type { GameState, WinReason } from '../../sim/types';
import type { Difficulty, Personality } from '../../bot';
import * as botModule from '../../bot';
import { esc, formatClock } from '../util';
import { svgIcon } from '../icons';
import { HUMAN, CPU, COLORS, type StatSample } from '../session';
import { prefs, PEACE_OPTIONS, type PeaceMin, type PersonalityPick } from '../prefs';
import { MISSIONS, type Mission } from '../campaign/missions';
import { CHARTS, drawChart, insight } from './charts';

const DIFF: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Leicht' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Schwer' },
];

/** Personality labels/descriptions from the bot module, with fallbacks. */
const FALLBACK_INFO: Record<Personality, { label: string; desc: string }> = {
  rusher: { label: 'Stürmer', desc: 'Greift früh an und drückt auf die Mitte.' },
  boomer: { label: 'Wirtschafter', desc: 'Baut Wirtschaft aus und kommt später stark.' },
  turtle: { label: 'Verteidiger', desc: 'Befestigt Punkte, baut Türme und kontert.' },
};
export function personalityInfo(p: Personality): { label: string; desc: string } {
  const info = (botModule as unknown as { PERSONALITY_INFO?: Record<Personality, { label: string; desc: string }> }).PERSONALITY_INFO;
  return info?.[p] ?? FALLBACK_INFO[p];
}
const PERS: { id: PersonalityPick; label: string }[] = [
  { id: 'random', label: 'Zufall' },
  { id: 'rusher', label: personalityInfo('rusher').label },
  { id: 'boomer', label: personalityInfo('boomer').label },
  { id: 'turtle', label: personalityInfo('turtle').label },
];

const SHIELD = `<svg class="shield" viewBox="0 0 58 68" aria-hidden="true">
  <path d="M29 2 L55 10 V32 C55 50 43 61 29 66 C15 61 3 50 3 32 V10 Z" fill="#2a2118" stroke="#d9b25a" stroke-width="2.5"/>
  <path d="M29 7 V61 C17 56 8 47 8 32 V13.5 Z" fill="#3d7be0"/>
  <path d="M29 7 L50 13.5 V32 C50 47 41 56 29 61 Z" fill="#d9483b"/>
  <path d="M18 40 L40 18 M36 17 L41.5 16.5 L41 22 M17 36 L22 41" stroke="#f3e8cc" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M40 40 L18 18 M22 17 L16.5 16.5 L17 22 M41 36 L36 41" stroke="#f3e8cc" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`;

const REASON: Record<string, [string, string]> = {
  // [win text, lose text]; {o} = opponent name
  towncenter: ['Das gegnerische Dorfzentrum ist gefallen.', 'Dein Dorfzentrum wurde zerstört.'],
  vp: ['{o} hat keine Siegpunkte mehr.', 'Deine Siegpunkte sind aufgebraucht.'],
  timeout: ['Zeit abgelaufen – du hattest mehr Siegpunkte.', 'Zeit abgelaufen – {o} hatte mehr Siegpunkte.'],
  surrender: ['{o} hat aufgegeben.', 'Du hast aufgegeben.'],
  objective: ['Auftrag erfüllt.', 'Auftrag gescheitert.'],
};

export interface MenuHandlers {
  start(d: Difficulty, peaceMin: number, personality: PersonalityPick): void;
  tutorial(): void;
  mission(index: number): void;
  replay(): void;
  onlineCreate(): void;
  onlineJoin(code: string): void;
  onlineCancel(): void;
  resume(): void;
  surrender(): void;
  toMenu(): void;
  retryMission(): void;
  nextMission(): void;
  watchReplay(): void;
}

export interface EndInfo {
  /** Display names [player 0, player 1] for the charts and table. */
  names: [string, string];
  samples: StatSample[];
  /** Revealed bot personality (shown in the subtitle). */
  personality?: string | null;
  mission?: { index: number; title: string; won: boolean; best: number | null; failText?: string } | null;
  online?: boolean;
  replayAvailable?: boolean;
  isReplay?: boolean;
}

type Screen = 'main' | 'campaign' | 'online';

export class Menus {
  private menu: HTMLElement;
  private pause: HTMLElement;
  private end: HTMLElement;
  private brief: HTMLElement;
  private screen: Screen = 'main';
  difficulty: Difficulty = 'normal';
  peaceMin: PeaceMin = 3;
  personality: PersonalityPick = 'random';
  /** Set by main: whether online play is possible here (relay URL known). */
  onlineAvailable = false;
  replayAvailable = false;

  constructor(
    parent: HTMLElement,
    private h: MenuHandlers,
  ) {
    this.difficulty = prefs.difficulty;
    this.peaceMin = prefs.peaceMin;
    this.personality = prefs.personality;
    this.menu = document.createElement('div');
    this.menu.id = 'menu';
    this.menu.className = 'overlay';
    parent.appendChild(this.menu);
    this.menu.addEventListener('click', (e) => this.onMenuClick(e));
    this.menu.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'joincode' && e.key === 'Enter') this.h.onlineJoin(t.value);
    });
    this.menu.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'joincode') t.value = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    });

    this.brief = document.createElement('div');
    this.brief.className = 'overlay dim hidden';
    this.brief.id = 'brief';
    parent.appendChild(this.brief);

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
    this.end.id = 'endscreen';
    parent.appendChild(this.end);
    this.end.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      const k = a?.dataset.a;
      if (k === 'new') h.toMenu();
      if (k === 'retry') h.retryMission();
      if (k === 'next') h.nextMission();
      if (k === 'watch') h.watchReplay();
      if (k === 'tab') this.endTab(a!.dataset.t as 'stats' | 'charts');
    });

    const rot = document.createElement('div');
    rot.id = 'rotate';
    rot.className = 'panel';
    rot.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M2 14a8 8 0 0 0 6 7M20 10a8 8 0 0 0-6-7"/></svg>Bitte Gerät drehen<small style="font-family:var(--sans);font-size:12px;color:var(--parch-dim)">Conquer Chrizu spielt sich im Querformat.</small>`;
    parent.appendChild(rot);
    this.render();
  }

  // ------------------------------------------------------------ main menu

  private render() {
    const title = `<div class="title">
        <div class="crest">${SHIELD}</div>
        <h1>Conquer<span>Chrizu</span></h1>
        <p class="lede">Zwei Burgen, ein Tal, dreizehn Dörfer, Wälder und Minen. Wer das Land hält, gewinnt.</p>
        <div class="modes">
          <button class="btn" data-a="go-campaign">${svgIcon('flag')}Kampagne</button>
          <button class="btn" data-a="go-online" ${this.onlineAvailable ? '' : 'aria-disabled="true"'}>${svgIcon('army')}Online spielen</button>
          <button class="btn" data-a="replay" ${this.replayAvailable ? '' : 'disabled'}>${svgIcon('clock')}Letztes Replay</button>
        </div>
      </div>`;
    let box = '';
    if (this.screen === 'main') {
      const pi = this.personality === 'random' ? null : personalityInfo(this.personality);
      box = `<div class="box panel">
        <div id="firsttime" class="first ${prefs.tutorialSeen ? 'hidden' : ''}">
          <span>Erstes Mal hier?</span>
          <button class="btn small" data-a="tut">${svgIcon('play')}Tutorial starten</button>
        </div>
        <div class="opt"><h2>Schwierigkeit</h2>
          <div class="seg" role="radiogroup" aria-label="Schwierigkeit">${DIFF.map((d) => this.segBtn('d', d.id, d.label, d.id === this.difficulty)).join('')}</div></div>
        <div class="opt"><h2>CPU-Persönlichkeit</h2>
          <div class="seg seg4" role="radiogroup" aria-label="CPU-Persönlichkeit">${PERS.map((p) => this.segBtn('pers', p.id, p.label, p.id === this.personality)).join('')}</div>
          <p class="pdesc">${esc(pi ? pi.desc : 'Die CPU wählt zufällig – du erfährst es am Ende.')}</p></div>
        <div class="opt"><h2>Friedenszeit</h2>
          <div class="seg seg4" role="radiogroup" aria-label="Friedenszeit">${PEACE_OPTIONS.map((m) => this.segBtn('p', String(m), m ? m + ' Min' : 'Aus', m === this.peaceMin)).join('')}</div></div>
        <div class="row2">
          <button class="btn primary" id="startbtn" data-a="start">${svgIcon('play')}Spiel starten</button>
          <button class="btn" id="tutbtn" data-a="tut">Tutorial</button>
        </div>
        <ol class="howto">
          <li><b>Antippen wählt aus:</b> Trupps, Gebäude, Bauplätze und Punkte.</li>
          <li><b>Doppeltippen gibt den Befehl:</b> Boden = marschieren, Gegner = angreifen, Dorf, Wald oder Mine = erobern.</li>
          <li><b>Sieg:</b> Wer weniger Punkte hält, verliert Siegpunkte. Fällt dein Dorfzentrum, ist das Spiel vorbei.</li>
        </ol>
      </div>`;
    } else if (this.screen === 'campaign') {
      const unlocked = prefs.campaignUnlocked;
      box = `<div class="box panel">
        <div class="subhead"><button class="btn small" data-a="back" aria-label="Zurück">${svgIcon('retreat')}</button><h2>Kampagne</h2>
          <span class="muted">${Math.min(unlocked, MISSIONS.length)}/${MISSIONS.length} geschafft</span></div>
        <ol class="missions">${MISSIONS.map((m, i) => {
          const best = prefs.bestTime(m.id);
          const locked = i > unlocked;
          return `<li><button class="mission ${locked ? 'locked' : ''} ${best !== null ? 'done' : ''}" data-a="mission" data-i="${i}" ${locked ? 'disabled' : ''}>
            <span class="mn">${i + 1}</span><span class="mt"><b>${esc(m.title)}</b><small>${esc(locked ? 'Gesperrt – schaff zuerst die vorige Mission' : m.goal)}</small></span>
            <span class="mb">${best !== null ? `Bestzeit<br><b>${formatClock(best)}</b>` : locked ? svgIcon('stop') : svgIcon('play')}</span></button></li>`;
        }).join('')}</ol>
      </div>`;
    } else {
      box = `<div class="box panel" id="onlinebox">
        <div class="subhead"><button class="btn small" data-a="back" aria-label="Zurück">${svgIcon('retreat')}</button><h2>Online spielen</h2></div>
        ${this.onlineHtml()}
      </div>`;
    }
    this.menu.innerHTML = `<div class="menu">${title}${box}</div>`;
  }

  private segBtn(k: string, v: string, label: string, on: boolean) {
    return `<button data-a="seg" data-k="${k}" data-v="${v}" role="radio" aria-checked="${on}" class="${on ? 'on' : ''}">${esc(label)}</button>`;
  }

  private onMenuClick(e: Event) {
    const a = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!a || (a as HTMLButtonElement).disabled) return;
    switch (a.dataset.a) {
      case 'seg': {
        const v = a.dataset.v!;
        if (a.dataset.k === 'd') this.difficulty = prefs.difficulty = v as Difficulty;
        if (a.dataset.k === 'p') this.peaceMin = prefs.peaceMin = Number(v) as PeaceMin;
        if (a.dataset.k === 'pers') this.personality = prefs.personality = v as PersonalityPick;
        this.render();
        break;
      }
      case 'start':
        this.h.start(this.difficulty, this.peaceMin, this.personality);
        break;
      case 'tut':
        this.h.tutorial();
        break;
      case 'go-campaign':
        this.screen = 'campaign';
        this.render();
        break;
      case 'go-online':
        this.screen = 'online';
        this.online = { phase: 'idle' };
        this.render();
        break;
      case 'back':
        if (this.screen === 'online') this.h.onlineCancel();
        this.screen = 'main';
        this.render();
        break;
      case 'mission':
        this.showBriefing(Number(a.dataset.i));
        break;
      case 'replay':
        this.h.replay();
        break;
      case 'create':
        this.h.onlineCreate();
        break;
      case 'join': {
        const inp = this.menu.querySelector('#joincode') as HTMLInputElement | null;
        this.h.onlineJoin(inp?.value ?? '');
        break;
      }
      case 'copy':
        this.copyCode();
        break;
      case 'cancel-online':
        this.h.onlineCancel();
        this.online = { phase: 'idle' };
        this.render();
        break;
    }
  }

  // ------------------------------------------------------------ online lobby

  online: { phase: 'idle' | 'creating' | 'waiting' | 'joining' | 'error'; code?: string; msg?: string; ping?: number } = { phase: 'idle' };

  setOnline(o: Menus['online']) {
    this.online = o;
    if (this.screen === 'online') {
      const box = this.menu.querySelector('#onlinebox');
      if (box) {
        const keep = (this.menu.querySelector('#joincode') as HTMLInputElement | null)?.value ?? '';
        box.innerHTML = `<div class="subhead"><button class="btn small" data-a="back" aria-label="Zurück">${svgIcon('retreat')}</button><h2>Online spielen</h2></div>${this.onlineHtml()}`;
        const inp = this.menu.querySelector('#joincode') as HTMLInputElement | null;
        if (inp) inp.value = keep;
      }
    }
  }

  private onlineHtml(): string {
    if (!this.onlineAvailable) {
      return `<p class="note big">Online-Spiele laufen in der GitHub-Pages-Version.</p>
        <p class="note">Diese Fassung hat keinen Spielserver. Öffne Conquer Chrizu über GitHub Pages, um gegen Freunde zu spielen.</p>`;
    }
    const o = this.online;
    const ping = o.ping !== undefined ? `<span class="ping">Ping ${Math.round(o.ping)} ms</span>` : '';
    if (o.phase === 'waiting' && o.code) {
      return `<p class="note">Gib deinem Gegner diesen Code:</p>
        <div class="code"><span id="lobbycode">${esc(o.code)}</span><button class="btn small" data-a="copy">Kopieren</button></div>
        <p class="note wait"><span class="spin"></span>Warte auf Gegner … ${ping}</p>
        <button class="btn" data-a="cancel-online">Abbrechen</button>`;
    }
    if (o.phase === 'creating' || o.phase === 'joining') {
      return `<p class="note wait"><span class="spin"></span>${o.phase === 'creating' ? 'Lobby wird erstellt …' : 'Verbinde …'} ${ping}</p>
        <button class="btn" data-a="cancel-online">Abbrechen</button>`;
    }
    return `${o.phase === 'error' ? `<p class="note err">${esc(o.msg ?? 'Verbindung fehlgeschlagen.')}</p>` : ''}
      <button class="btn primary" data-a="create">${svgIcon('build')}Lobby erstellen</button>
      <div class="joinrow"><input id="joincode" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="5" placeholder="CODE" aria-label="Lobby-Code">
        <button class="btn" data-a="join">Beitreten</button></div>
      <p class="note">Ein Spieler erstellt die Lobby, der andere tritt mit dem 5-stelligen Code bei.</p>`;
  }

  private copyCode() {
    const code = this.online.code ?? '';
    const done = (ok: boolean) => {
      const b = this.menu.querySelector('[data-a="copy"]');
      if (b) b.textContent = ok ? 'Kopiert' : 'Markiert';
    };
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).then(
          () => done(true),
          () => done(this.selectCode()),
        );
        return;
      }
    } catch {
      /* fall through */
    }
    done(this.selectCode());
  }
  private selectCode(): boolean {
    try {
      const el = this.menu.querySelector('#lobbycode');
      if (!el) return false;
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      return document.execCommand?.('copy') ?? false;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ briefing

  showBriefing(i: number | null) {
    if (i === null) {
      this.brief.classList.add('hidden');
      return;
    }
    const m: Mission = MISSIONS[i];
    const best = prefs.bestTime(m.id);
    this.brief.innerHTML = `<div class="dialog panel briefing">
      <p class="kicker">Mission ${i + 1} von ${MISSIONS.length}</p>
      <h2>${esc(m.title)}</h2>
      <p class="story">${esc(m.briefing)}</p>
      <div class="goal">${svgIcon('target')}<span>${esc(m.goal)}</span></div>
      ${best !== null ? `<p class="sub">Deine Bestzeit: ${formatClock(best)}</p>` : ''}
      <div class="btns"><button class="btn primary" data-a="go">${svgIcon('play')}Mission starten</button>
      <button class="btn" data-a="close">Zurück</button></div></div>`;
    this.brief.classList.remove('hidden');
    this.brief.onclick = (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (a?.dataset.a === 'go') {
        this.brief.classList.add('hidden');
        this.h.mission(i);
      }
      if (a?.dataset.a === 'close') this.brief.classList.add('hidden');
    };
  }

  showMenu(v: boolean, screen?: Screen) {
    if (v) {
      if (screen) this.screen = screen;
      this.render();
    }
    this.menu.classList.toggle('hidden', !v);
    if (v) (this.menu.querySelector('#startbtn') as HTMLElement | null)?.focus({ preventScroll: true });
  }
  showPause(v: boolean) {
    this.pause.classList.toggle('hidden', !v);
  }
  get pauseVisible() {
    return !this.pause.classList.contains('hidden');
  }

  // ------------------------------------------------------------ end screen

  private endInfo: EndInfo | null = null;

  showEnd(st: GameState | null, info?: EndInfo) {
    if (!st) {
      this.end.classList.add('hidden');
      return;
    }
    this.endInfo = info ?? { names: ['Du', 'CPU'], samples: [] };
    const I = this.endInfo;
    const me = HUMAN;
    const op = CPU;
    const win = st.winner === me;
    const draw = st.winner === -1;
    const reason: WinReason = st.winReason ?? 'timeout';
    const opName = I.names[op];
    let txt = draw ? 'Zeit abgelaufen – beide Seiten haben gleich viele Siegpunkte.' : (REASON[reason] ?? ['Gewonnen.', 'Verloren.'])[win ? 0 : 1].replace('{o}', opName);
    if (I.mission && !I.mission.won && I.mission.failText && reason === 'objective') txt = I.mission.failText;
    if (I.isReplay) txt = `Replay: ${st.winner === -1 ? 'Unentschieden' : `${I.names[st.winner as 0 | 1] ?? '?'} gewinnt`}.`;
    const a = st.players[me];
    const b = st.players[op];
    const pts = [0, 0];
    for (const p of st.points) if (p.owner === 0 || p.owner === 1) pts[p.owner]++;
    const row = (label: string, x: number | string, y: number | string) => `<tr><td>${label}</td><td>${x}</td><td>${y}</td></tr>`;
    const headline = I.mission ? (I.mission.won ? 'Mission erfüllt!' : 'Mission gescheitert') : win ? 'Sieg!' : draw ? 'Unentschieden' : 'Niederlage';
    const sub = [txt, `Spieldauer ${formatClock(st.tick)}.`];
    if (I.personality) sub.push(`Die CPU war: ${esc(I.personality)}.`);
    if (I.mission?.won && I.mission.best !== null) sub.push(`Bestzeit ${formatClock(I.mission.best)}.`);
    const names = [I.names[me], I.names[op]];
    const btns: string[] = [];
    if (I.mission) {
      if (I.mission.won && I.mission.index + 1 < MISSIONS.length) btns.push(`<button class="btn primary" data-a="next">${svgIcon('play')}Nächste Mission</button>`);
      btns.push(`<button class="btn ${I.mission.won ? '' : 'primary'}" data-a="retry">Nochmal</button>`);
      btns.push(`<button class="btn" data-a="new">Menü</button>`);
    } else {
      btns.push(`<button class="btn primary" data-a="new">${svgIcon('play')}${I.isReplay ? 'Zum Menü' : 'Neues Spiel'}</button>`);
    }
    if (I.replayAvailable && !I.isReplay) btns.push(`<button class="btn" data-a="watch">${svgIcon('clock')}Replay ansehen</button>`);
    this.end.innerHTML = `<div class="dialog panel end ${I.isReplay ? '' : win || I.mission?.won ? 'win' : draw ? '' : 'lose'}">
      <h2>${headline}</h2>
      <p class="sub">${sub.join(' ')}</p>
      <div class="tabs" role="tablist">
        <button data-a="tab" data-t="charts" role="tab" class="on">Auswertung</button>
        <button data-a="tab" data-t="stats" role="tab">Zahlen</button>
      </div>
      <div class="tabp" data-p="charts">
        <p class="insight">${esc(insight(I.samples, I.names))}</p>
        <div class="legend"><span class="sw" style="background:${COLORS[me]}"></span>${esc(names[0])}<span class="sw" style="background:${COLORS[op]}"></span>${esc(names[1])}</div>
        <div class="charts">${CHARTS.map((c, i) => `<figure><figcaption>${esc(c.title)}</figcaption><canvas data-c="${i}"></canvas></figure>`).join('')}</div>
      </div>
      <div class="tabp hidden" data-p="stats">
        <table><thead><tr><th></th><th class="p0">${esc(names[0])}</th><th class="p1">${esc(names[1])}</th></tr></thead><tbody>
        ${row('Siegpunkte', Math.max(0, a.vp), Math.max(0, b.vp))}
        ${row('Gehaltene Punkte', pts[me], pts[op])}
        ${row('Punkte erobert', a.stats.pointsCaptured, b.stats.pointsCaptured)}
        ${row('Trupps ausgebildet', a.stats.squadsTrained, b.stats.squadsTrained)}
        ${row('Trupps besiegt', a.stats.squadsKilled, b.stats.squadsKilled)}
        ${row('Trupps verloren', a.stats.squadsLost, b.stats.squadsLost)}
        ${row('Rohstoffe gesammelt', a.stats.resourcesGathered, b.stats.resourcesGathered)}
        </tbody></table>
      </div>
      <div class="btns">${btns.join('')}</div></div>`;
    this.end.classList.remove('hidden');
    requestAnimationFrame(() => this.drawCharts());
  }

  private endTab(t: 'stats' | 'charts') {
    this.end.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    this.end.querySelectorAll<HTMLElement>('.tabp').forEach((p) => p.classList.toggle('hidden', p.dataset.p !== t));
    if (t === 'charts') this.drawCharts();
  }

  private drawCharts() {
    const I = this.endInfo;
    if (!I) return;
    // series order: local player first, colors by side
    const me = HUMAN;
    const swap = me === 1;
    const samples = swap
      ? I.samples.map((s) => ({ ...s, vp: [s.vp[1], s.vp[0]] as [number, number], army: [s.army[1], s.army[0]] as [number, number], points: [s.points[1], s.points[0]] as [number, number], gathered: [s.gathered[1], s.gathered[0]] as [number, number] }))
      : I.samples;
    const colors: [string, string] = [COLORS[me], COLORS[1 - me]];
    this.end.querySelectorAll<HTMLCanvasElement>('canvas[data-c]').forEach((cv) => drawChart(cv, samples, CHARTS[Number(cv.dataset.c)], colors));
  }

  get endVisible() {
    return !this.end.classList.contains('hidden');
  }
}
