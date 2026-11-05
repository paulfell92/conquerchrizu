/**
 * DOM overlay HUD: top bar, minimap + tool buttons, squad card strip,
 * context panel, toasts, mode hint. Plain DOM, keyed updates, rebuilds only
 * when a content signature changes (so taps never hit a replaced node).
 */
import type { Building, BuildingKind, Command, Resources, Squad, TechId, UnitKind } from '../../sim/types';
import { AGE_NAMES, BUILDINGS, POINT_NAMES, RULES, TECHS, UNITS } from '../../content';
import { iconFor, svgIcon, type IconName } from '../icons';
import { costParts, esc, formatClock } from '../util';
import { CPU, HUMAN, type Session } from '../session';

export interface HudActions {
  select(ids: number[], add: boolean): void;
  selectKind(kind: UnitKind): void;
  selectArmy(): void;
  stop(): void;
  retreat(): void;
  attackMode(): void;
  rallyMode(): void;
  cancelMode(): void;
  deselect(): void;
  issue(cmd: Command): void;
  jumpTo(x: number, y: number): void;
  jumpHome(): void;
  togglePause(): void;
  toggleSpeed(): void;
  toggleBoxMode(): void;
  minimapJump(fx: number, fy: number): void;
  toggleFollow(): void;
  replayPause(): void;
  replaySpeed(v: number): void;
  replaySeek(tick: number): void;
  replayEnd(): void;
  netAction(id: string): void;
}

const ORDER_TEXT: Record<string, string> = {
  idle: 'Bereit',
  move: 'Marschiert',
  attack: 'Greift an',
  retreat: 'Rückzug',
};

function costHtml(c: Resources, have: Resources | null): string {
  const parts = costParts(c);
  if (!parts.length) return '<span>kostenlos</span>';
  return parts
    .map((p) => {
      const lack = have && have[p.k] < p.v ? ' lack' : '';
      return `<span class="${p.k}${lack}">${svgIcon(p.k as IconName)}${p.v}</span>`;
    })
    .join('');
}

const speedLabel = (v: number) => (v === 0.75 ? '0,75×' : `${v}×`);

export class Hud {
  readonly root: HTMLElement;
  private s: Session | null = null;
  private els: Record<string, HTMLElement> = {};
  private mm!: HTMLCanvasElement;
  private cardEls = new Map<number, { el: HTMLElement; sig: string }>();
  private cardsSig = '';
  private ctxSig = '';
  private topSig = '';
  private lastCardTap = { id: -1, t: 0 };
  boxMode = false;
  /** Set by main from prefs: show the double-tap hint chip. */
  commandHint = true;
  /** Opponent label in the top bar, e.g. "CPU · Wirtschafter" or "Gegner". */
  opponentLabel = 'CPU';
  meLabel = 'Du';
  private seeking = false;

  constructor(
    parent: HTMLElement,
    private act: HudActions,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="topbar">
        <div class="panel res" id="res">
          <div class="r food" title="Nahrung">${svgIcon('food')}<span>0</span></div>
          <div class="r wood" title="Holz">${svgIcon('wood')}<span>0</span></div>
          <div class="r gold" title="Gold">${svgIcon('gold')}<span>0</span></div>
          <div class="sep"></div>
          <div class="r pop" title="Bevölkerung">${svgIcon('pop')}<span>0/0</span></div>
        </div>
        <div class="panel vp" id="vp">
          <div class="side me"><div class="lbl"><b>0</b><span class="pts">Du · 0 Punkte</span></div><div class="bar"><i></i></div></div>
          <div class="clock"><span>00:00</span><small>Dorfzeitalter</small></div>
          <div class="side cpu"><div class="lbl"><b>0</b><span class="pts">CPU · 0 Punkte</span></div><div class="bar"><i></i></div></div>
        </div>
        <div class="tb-btns">
          <span class="panel tbtn hidden" id="ping" title="Ping">– ms</span>
          <button class="panel tbtn" id="speed" title="Spieltempo">1×</button>
          <button class="panel tbtn" id="pause" title="Pause (P)" aria-label="Pause">${svgIcon('pause')}</button>
        </div>
      </div>
      <div id="mmwrap">
        <div id="tools">
          <button class="panel" id="t-box" title="Auswahlrahmen: Ziehen wählt Trupps aus">${svgIcon('select')}Auswahl</button>
          <button class="panel" id="t-army" title="Ganze Armee wählen (A)">${svgIcon('army')}Armee</button>
          <button class="panel" id="t-home" title="Zum Dorfzentrum (Leertaste)">${svgIcon('towncenter')}Basis</button>
          <button class="panel" id="t-follow" title="Neue Trupps folgen der Armee: Sammelpunkt aller Gebäude wandert mit deinen Befehlen" aria-pressed="true">${svgIcon('flag')}Folgen</button>
        </div>
        <canvas id="minimap"></canvas>
      </div>
      <div id="cards"></div>
      <div id="ctx" class="panel hidden"></div>
      <div id="toasts" aria-live="polite"></div>
      <div id="modehint" class="panel hidden"><span></span><button>Abbrechen</button></div>
      <div id="peace" class="panel hidden">${svgIcon('flag')}<span></span></div>
      <div id="objective" class="panel hidden"><div class="ot"></div><div class="ob"><i></i></div></div>
      <div id="replaybar" class="panel hidden">
        <button class="tbtn" data-r="pause" aria-label="Pause">${svgIcon('pause')}</button>
        <div class="rspeeds">${[1, 4, 8].map((v) => `<button class="tbtn" data-r="speed" data-v="${v}">${v}×</button>`).join('')}</div>
        <input type="range" id="seek" min="0" max="100" step="1" value="0" aria-label="Zeitleiste">
        <span class="rtime">00:00 / 00:00</span>
        <button class="tbtn rend" data-r="end">Replay beenden</button>
      </div>
      <div id="netover" class="overlay dim hidden"><div class="dialog panel"><h2></h2><p class="sub"></p><div class="btns"></div></div></div>
      <div id="cmdhint" class="hidden">${svgIcon('target')}<span>Doppeltippen = Befehl</span></div>
    `;
    parent.appendChild(this.root);
    for (const id of ['res', 'vp', 'speed', 'pause', 'cards', 'ctx', 'toasts', 'modehint', 'peace', 'cmdhint', 't-box', 't-army', 't-home', 't-follow', 'objective', 'replaybar', 'netover', 'ping'])
      this.els[id] = this.root.querySelector('#' + id)!;
    this.mm = this.root.querySelector('#minimap')!;

    this.els.speed.addEventListener('click', () => act.toggleSpeed());
    this.els.pause.addEventListener('click', () => act.togglePause());
    this.els['t-box'].addEventListener('click', () => act.toggleBoxMode());
    this.els['t-army'].addEventListener('click', () => act.selectArmy());
    this.els['t-home'].addEventListener('click', () => act.jumpHome());
    this.els['t-follow'].addEventListener('click', () => act.toggleFollow());
    const rb = this.els.replaybar;
    rb.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.r === 'pause') act.replayPause();
      if (b.dataset.r === 'speed') act.replaySpeed(Number(b.dataset.v));
      if (b.dataset.r === 'end') act.replayEnd();
    });
    const seek = rb.querySelector('#seek') as HTMLInputElement;
    seek.addEventListener('input', () => (this.seeking = true));
    seek.addEventListener('change', () => {
      this.seeking = false;
      act.replaySeek(Number(seek.value));
    });
    this.els.netover.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-n]') as HTMLElement | null;
      if (b) act.netAction(b.dataset.n!);
    });
    this.els.modehint.querySelector('button')!.addEventListener('click', () => act.cancelMode());

    // minimap: tap / drag to jump
    let mmDown = false;
    const mmJump = (e: PointerEvent) => {
      const r = this.mm.getBoundingClientRect();
      act.minimapJump((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    this.mm.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      mmDown = true;
      try {
        this.mm.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      mmJump(e);
    });
    this.mm.addEventListener('pointermove', (e) => mmDown && mmJump(e));
    this.mm.addEventListener('pointerup', () => (mmDown = false));
    this.mm.addEventListener('pointercancel', () => (mmDown = false));

    // cards: delegation
    this.els.cards.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest('.card') as HTMLElement | null;
      if (!c) return;
      const id = Number(c.dataset.id);
      const now = performance.now();
      const q = this.s?.squadById(id);
      if (q && this.lastCardTap.id === id && now - this.lastCardTap.t < 350) {
        act.selectKind(q.kind);
        this.lastCardTap.id = -1;
        return;
      }
      this.lastCardTap = { id, t: now };
      act.select([id], (e as MouseEvent).shiftKey || (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey);
    });

    // context panel: delegation
    this.els.ctx.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (!b) return;
      this.ctxAction(b);
    });
  }

  get minimap(): HTMLCanvasElement {
    return this.mm;
  }

  bind(s: Session) {
    this.s = s;
    this.cardEls.clear();
    this.els.cards.innerHTML = '';
    this.cardsSig = this.ctxSig = this.topSig = '';
    this.els.toasts.innerHTML = '';
    this.setMode('none');
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  sizeMinimap(dpr: number) {
    const r = this.mm.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width * dpr));
    const h = Math.max(10, Math.round(r.height * dpr));
    if (this.mm.width !== w || this.mm.height !== h) {
      this.mm.width = w;
      this.mm.height = h;
    }
  }

  setBoxMode(on: boolean) {
    this.boxMode = on;
    this.els['t-box'].classList.toggle('on', on);
  }

  setMode(mode: 'none' | 'rally' | 'attack') {
    const el = this.els.modehint;
    if (mode === 'none') el.classList.add('hidden');
    else {
      el.classList.remove('hidden');
      el.querySelector('span')!.textContent =
        mode === 'rally' ? 'Tippe auf die Karte, um den Sammelpunkt zu setzen' : 'Tippe auf einen Gegner, den du angreifen willst';
    }
  }

  // ------------------------------------------------------------ per-frame

  update() {
    const s = this.s;
    if (!s) return;
    this.updateTop(s);
    this.updateCards(s);
    this.updateCtx(s);
  }

  private updateTop(s: Session) {
    const st = s.state;
    const me = st.players[HUMAN];
    const cpu = st.players[CPU];
    const pts = [0, 0];
    for (const p of st.points) if (p.owner >= 0) pts[p.owner]++;
    // peace countdown chip + command hint (cheap, update every frame)
    const left = s.peaceLeft;
    const pc = this.els.peace;
    if (left > 0) {
      const txt = `Friedenszeit ${formatClock(left + 19)}`;
      if (pc.classList.contains('hidden')) {
        pc.classList.remove('hidden');
        document.body.classList.add('has-peace');
      }
      const sp = pc.querySelector('span')!;
      if (sp.textContent !== txt) sp.textContent = txt;
    } else if (!pc.classList.contains('hidden')) {
      pc.classList.add('hidden');
      document.body.classList.remove('has-peace');
    }
    const showHint = this.commandHint && s.selected.size > 0 && s.mode === 'none';
    this.els.cmdhint.classList.toggle('hidden', !showHint);
    const sig = `${me.res.food}|${me.res.wood}|${me.res.gold}|${me.pop}|${me.popCap}|${me.vp}|${cpu.vp}|${pts}|${me.age}|${Math.floor(st.tick / 20)}|${s.speed}|${s.paused}|${this.opponentLabel}`;
    if (sig === this.topSig) return;
    this.topSig = sig;
    const r = this.els.res.querySelectorAll('.r span');
    r[0].textContent = String(me.res.food);
    r[1].textContent = String(me.res.wood);
    r[2].textContent = String(me.res.gold);
    r[3].textContent = `${me.pop}/${me.popCap}`;
    this.els.res.querySelector('.r.pop')!.classList.toggle('full', me.pop >= me.popCap);
    const vp = this.els.vp;
    const max = RULES.vpStart;
    const sides = vp.querySelectorAll('.side');
    const set = (el: Element, v: number, n: number, who: string) => {
      el.querySelector('b')!.textContent = String(Math.max(0, v));
      el.querySelector('.pts')!.textContent = `${who} · ${n} P.`;
      (el.querySelector('.pts') as HTMLElement).title = `${who}: ${n} ${n === 1 ? 'Punkt' : 'Punkte'}`;
      (el.querySelector('.bar i') as HTMLElement).style.width = `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
    };
    set(sides[0], me.vp, pts[HUMAN], this.meLabel);
    set(sides[1], cpu.vp, pts[CPU], this.opponentLabel);
    vp.querySelector('.clock span')!.textContent = formatClock(st.tick);
    vp.querySelector('.clock small')!.textContent = AGE_NAMES[me.age];
    this.els.speed.textContent = speedLabel(s.speed);
    this.els.speed.classList.toggle('on', s.speed !== 1);
  }

  private updateCards(s: Session) {
    const own: Squad[] = [];
    for (const q of s.state.squads) if (q.owner === HUMAN) own.push(q);
    const ids = own.map((q) => q.id).join(',');
    const box = this.els.cards;
    if (ids !== this.cardsSig) {
      this.cardsSig = ids;
      const keep = new Set(own.map((q) => q.id));
      for (const [id, c] of this.cardEls) if (!keep.has(id)) (c.el.remove(), this.cardEls.delete(id));
      box.querySelector('.cards-empty')?.remove();
      own.forEach((q, i) => {
        let c = this.cardEls.get(q.id);
        if (!c) {
          const el = document.createElement('button');
          el.className = 'card panel';
          el.dataset.id = String(q.id);
          el.innerHTML = `<span class="hk"></span><span class="st"></span>${svgIcon(q.kind as IconName)}<span class="n"></span><span class="hp"><i></i></span>`;
          c = { el, sig: '' };
          this.cardEls.set(q.id, c);
        }
        if (box.children[i] !== c.el) box.insertBefore(c.el, box.children[i] ?? null);
      });
      if (!own.length) box.insertAdjacentHTML('beforeend', '<div class="cards-empty panel">Keine Trupps – bilde welche im Dorfzentrum oder in der Kaserne aus.</div>');
    }
    own.forEach((q, i) => {
      const c = this.cardEls.get(q.id)!;
      const fighting = s.state.tick - q.lastCombatTick < 40;
      const st = fighting ? 'fight' : q.order === 'move' || q.order === 'retreat' ? 'move' : '';
      const hpPct = Math.round((q.hp / q.maxHp) * 100);
      const sel = s.selected.has(q.id);
      const sig = `${i}|${q.members}|${hpPct}|${st}|${sel}`;
      if (sig === c.sig) return;
      c.sig = sig;
      c.el.classList.toggle('sel', sel);
      c.el.title = `${UNITS[q.kind].name} – ${q.members} Mann`;
      c.el.querySelector('.hk')!.textContent = i < 9 ? String(i + 1) : '';
      c.el.querySelector('.n')!.textContent = String(q.members);
      c.el.querySelector('.st')!.className = 'st ' + st;
      const bar = c.el.querySelector('.hp i') as HTMLElement;
      bar.style.width = hpPct + '%';
      bar.style.background = hpPct > 60 ? 'var(--good)' : hpPct > 30 ? 'var(--warn)' : 'var(--bad)';
    });
  }

  // ------------------------------------------------------------ context panel

  private updateCtx(s: Session) {
    const html = this.ctxContent(s);
    const el = this.els.ctx;
    if (html === null) {
      if (!el.classList.contains('hidden')) {
        el.classList.add('hidden');
        document.body.classList.remove('ctx-open');
        this.ctxSig = '';
      }
      return;
    }
    if (html.sig !== this.ctxSig) {
      this.ctxSig = html.sig;
      const scroll = el.querySelector('.body')?.scrollTop ?? 0;
      el.innerHTML = html.html;
      const body = el.querySelector('.body');
      if (body) body.scrollTop = scroll;
      el.classList.remove('hidden');
      document.body.classList.add('ctx-open');
    }
    // live progress bars (no rebuild)
    for (const p of el.querySelectorAll<HTMLElement>('[data-prog]')) {
      const id = Number(p.dataset.prog);
      const b = s.buildingById(id);
      let f = 0;
      if (b) {
        if (p.dataset.kind === 'build') f = 1 - b.buildTicksLeft / Math.max(1, BUILDINGS[b.kind].buildTicks);
        else if (p.dataset.kind === 'hp') f = b.hp / b.maxHp;
        else if (b.queue[0]) f = 1 - b.queue[0].ticksLeft / Math.max(1, b.queue[0].totalTicks);
      }
      p.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
    }
  }

  private head(icon: IconName, color: string, title: string, sub: string): string {
    return `<div class="head"><div class="badge" style="background:${color}">${svgIcon(icon)}</div>
      <div class="t"><h3>${esc(title)}</h3><p>${esc(sub)}</p></div>
      <button class="x" data-a="close" aria-label="Schließen">${svgIcon('cancel')}</button></div>`;
  }

  private actBtn(a: string, extra: string, icon: IconName, name: string, cost: Resources | null, why: string | null, have: Resources, cls = ''): string {
    const off = why ? ' off' : '';
    return `<button class="act${off} ${cls}" data-a="${a}" ${extra} ${why ? `data-why="${esc(why)}"` : ''}>
      <span class="row">${svgIcon(icon)}<span class="nm">${esc(name)}</span></span>
      ${cost ? `<span class="cost">${costHtml(cost, have)}</span>` : ''}
      ${why ? `<span class="why">${esc(why)}</span>` : ''}</button>`;
  }

  private ctxContent(s: Session): { sig: string; html: string } | null {
    const st = s.state;
    const me = st.players[HUMAN];
    const resSig = `${me.res.food},${me.res.wood},${me.res.gold},${me.pop},${me.age},${me.techs.join('.')}`;

    // --- squads
    if (s.selected.size) {
      const list: Squad[] = [];
      for (const id of s.selected) {
        const q = s.squadById(id);
        if (q) list.push(q);
      }
      if (!list.length) return null;
      let hp = 0;
      let max = 0;
      let men = 0;
      for (const q of list) {
        hp += q.hp;
        max += q.maxHp;
        men += q.members;
      }
      const hpPct = Math.round((hp / max) * 100);
      let head: string;
      let detail = '';
      if (list.length === 1) {
        const q = list[0];
        const d = UNITS[q.kind];
        head = this.head(q.kind as IconName, me.color, d.name, `${q.members} Mann · ${ORDER_TEXT[q.order] ?? q.order}`);
        detail = `<div class="note">${esc(d.description)}</div>
          <div class="stats"><span>Leben</span><b>${q.hp} / ${q.maxHp}</b><span>Reichweite</span><b>${d.ranged ? 'Fernkampf' : 'Nahkampf'}</b></div>`;
      } else {
        const by = new Map<UnitKind, number>();
        for (const q of list) by.set(q.kind, (by.get(q.kind) ?? 0) + 1);
        const comp = [...by.entries()].map(([k, n]) => `${n}× ${UNITS[k].name}`).join(', ');
        head = this.head('army', me.color, `${list.length} Trupps`, `${men} Mann`);
        detail = `<div class="note">${esc(comp)}</div>`;
      }
      const html = `${head}<div class="body">
        <div class="hpline"><i style="width:${hpPct}%;background:${hpPct > 60 ? 'var(--good)' : hpPct > 30 ? 'var(--warn)' : 'var(--bad)'}"></i></div>
        ${detail}
        <div class="grid">
          ${this.actBtn('attack', '', 'target', 'Angriff', null, s.peace ? 'Friedenszeit' : null, me.res, s.mode === 'attack' ? 'hot' : '')}
          ${this.actBtn('stop', '', 'stop', 'Stopp', null, null, me.res)}
          ${this.actBtn('retreat', '', 'retreat', 'Rückzug', null, null, me.res)}
          ${this.actBtn('army', '', 'army', 'Ganze Armee', null, null, me.res)}
        </div>
        <div class="note">Doppeltippen: auf den Boden = marschieren, auf einen Gegner = angreifen, auf einen Punkt = einnehmen. Einmal tippen wählt nur aus.</div>
      </div>`;
      return { sig: `sq|${[...s.selected].join(',')}|${hpPct}|${list.length === 1 ? list[0].order + list[0].members : men}|${s.mode}|${s.peace}`, html };
    }

    // --- own building
    if (s.selBuilding !== null) {
      const b = s.buildingById(s.selBuilding);
      if (!b || b.owner !== HUMAN) return null;
      return this.buildingPanel(s, b, resSig);
    }

    // --- empty slot: build menu
    if (s.selSlot !== null) {
      const slot = s.selSlot;
      const kinds: BuildingKind[] = ['barracks', 'range', 'stable', 'tower', 'blacksmith', 'workshop'];
      const btns = kinds
        .map((k) => {
          const d = BUILDINGS[k];
          const why = s.validate({ t: 'build', slot, kind: k });
          const cost = s.api.buildingCost(st, HUMAN, k);
          return this.actBtn('build', `data-k="${k}"`, k as IconName, d.name, cost, why, me.res);
        })
        .join('');
      const html = `${this.head('build', '#7a6440', 'Bauplatz', 'Was soll hier entstehen?')}
        <div class="body"><div class="grid">${btns}</div>
        <div class="note">Gebäude brauchen etwas Zeit zum Bauen. Ein Zeitalter-Aufstieg erfordert fertige Gebäude.</div></div>`;
      return { sig: `slot|${slot}|${resSig}`, html };
    }

    // --- capture point
    if (s.selPoint !== null) {
      const p = st.points.find((x) => x.id === s.selPoint);
      if (!p) return null;
      const inc = RULES.pointIncome[p.kind];
      const lv = p.level as number;
      const mult = lv >= 3 ? (RULES as { pointLevel3IncomePct?: number }).pointLevel3IncomePct ?? 200 : lv === 2 ? RULES.pointLevel2IncomePct : 100;
      const parts = costParts({ food: Math.trunc((inc.food * mult) / 100), wood: Math.trunc((inc.wood * mult) / 100), gold: Math.trunc((inc.gold * mult) / 100) });
      const incTxt = parts.map((x) => `+${x.v} ${x.k === 'food' ? 'Nahrung' : x.k === 'wood' ? 'Holz' : 'Gold'}`).join(', ');
      const ownerTxt = p.owner === HUMAN ? 'Dein Punkt' : p.owner === CPU ? 'Gehört der CPU' : 'Neutral';
      const col = p.owner >= 0 ? st.players[p.owner].color : '#8a7d5e';
      let body = `<div class="stats"><span>Ertrag</span><b>${incTxt} / s</b><span>Stufe</span><b>${p.level}</b>
        <span>Einnahme</span><b>${Math.round((p.progress / RULES.captureMax) * 100)} %</b></div>`;
      const tower = s.api.pointTower(st, p.id);
      if (tower) body += `<div class="note">${svgIcon('tower', 'ic inl')} Befestigt: Wachturm ${tower.buildTicksLeft > 0 ? 'im Bau' : `${tower.hp}/${tower.maxHp}`}</div>`;
      if (p.owner === HUMAN) {
        const btns: string[] = [];
        if (lv < 3) {
          const why = s.validate({ t: 'upgradePoint', point: p.id });
          btns.push(this.actBtn('upgrade', `data-p="${p.id}"`, 'upgrade', lv === 1 ? 'Ausbauen (Stufe 2)' : 'Ausbauen (Stufe 3)', s.api.pointUpgradeCost(lv), why, me.res, 'wide'));
        }
        if (!tower && BUILDINGS.pointtower) {
          const why = s.validate({ t: 'fortifyPoint', point: p.id });
          btns.push(this.actBtn('fortify', `data-p="${p.id}"`, 'tower', 'Befestigen (Wachturm)', BUILDINGS.pointtower.cost, why, me.res, 'wide'));
        }
        if (btns.length) body += `<div class="grid">${btns.join('')}</div>`;
        body += `<div class="note">${lv >= 3 ? 'Voll ausgebaut. ' : ''}Wird der Punkt erobert, geht der Ausbau verloren.</div>`;
      } else {
        body += `<div class="note">Wähle Trupps und tippe doppelt auf den Punkt. Steht nur deine Seite im Kreis, gehört er bald dir.</div>`;
      }
      const html = `${this.head(p.kind as IconName, col, p.name, `${POINT_NAMES[p.kind]} · ${ownerTxt}`)}<div class="body">${body}</div>`;
      return { sig: `pt|${p.id}|${p.owner}|${p.level}|${Math.round(p.progress / 5)}|${resSig}|${tower ? tower.id + ':' + tower.buildTicksLeft + ':' + Math.round(tower.hp / 50) : 0}`, html };
    }

    // --- enemy info
    if (s.selEnemy !== null) {
      const q = s.squadById(s.selEnemy);
      const b = q ? null : s.buildingById(s.selEnemy);
      const e = q ?? b;
      if (!e) return null;
      const name = q ? UNITS[q.kind].name : BUILDINGS[b!.kind].name;
      const desc = q ? UNITS[q.kind].description : BUILDINGS[b!.kind].description;
      const pct = Math.round((e.hp / e.maxHp) * 100);
      const html = `${this.head(iconFor(q ? q.kind : b!.kind), st.players[CPU].color, name, q ? `${this.opponentLabel} · ${q.members} Mann` : this.opponentLabel)}
        <div class="body"><div class="hpline"><i style="width:${pct}%;background:var(--bad)"></i></div>
        <div class="note">${esc(desc)}</div>
        <div class="note">${s.peace ? 'Friedenszeit: Angriffe sind noch nicht möglich.' : 'Wähle eigene Trupps und tippe doppelt auf diesen Gegner, um anzugreifen.'}</div></div>`;
      return { sig: `en|${e.id}|${pct}|${s.peace}`, html };
    }
    return null;
  }

  private buildingPanel(s: Session, b: Building, resSig: string): { sig: string; html: string } {
    const st = s.state;
    const me = st.players[HUMAN];
    const d = BUILDINGS[b.kind];
    const building = b.buildTicksLeft > 0;
    const sub = building ? 'Im Bau' : b.queue.length ? 'Arbeitet' : 'Bereit';
    let body = `<div class="hpline"><i data-prog="${b.id}" data-kind="${building ? 'build' : 'hp'}" style="background:${building ? 'var(--warn)' : 'var(--good)'}"></i></div>`;
    if (building) {
      body += `<div class="note">${esc(d.description)} Wird gerade gebaut – danach kann es arbeiten.</div>`;
      return { sig: `b|${b.id}|build`, html: `${this.head(iconFor(b.kind), me.color, d.name, sub)}<div class="body">${body}</div>` };
    }
    // queue
    if (b.queue.length) {
      const items = b.queue
        .map((q, i) => {
          const icon = (q.item in UNITS ? q.item : q.item === 'age2' || q.item === 'age3' ? 'age' : 'hammer') as IconName;
          const prog = i === 0 ? `<span class="p"><i data-prog="${b.id}" data-kind="queue"></i></span>` : '';
          return `<div class="qi">${svgIcon(icon)}${prog}</div>`;
        })
        .join('');
      body += `<h4>Warteschlange</h4><div class="queue">${items}
        <button class="qi cancel" data-a="cancel" data-b="${b.id}" title="Letzten Auftrag abbrechen (volle Erstattung)" aria-label="Letzten Auftrag abbrechen">${svgIcon('cancel')}</button></div>`;
    }
    const btns: string[] = [];
    for (const u of d.trains) {
      const why = s.validate({ t: 'train', building: b.id, unit: u });
      const ud = UNITS[u];
      btns.push(this.actBtn('train', `data-b="${b.id}" data-u="${u}" title="${esc(ud.description)}"`, u as IconName, ud.name, s.api.unitCost(st, HUMAN, u), why, me.res));
    }
    for (const t of d.researches) {
      if (me.techs.includes(t)) continue;
      if ((t === 'age3' && me.age < 2) || (t === 'age2' && me.age >= 2)) continue;
      if (t === 'age3' && me.age >= 3) continue;
      const td = TECHS[t];
      if (!td) continue;
      // hide techs two ages ahead to keep the panel short
      if (td.age > me.age + 1) continue;
      const why = s.validate({ t: 'research', building: b.id, tech: t });
      const icon: IconName = t === 'age2' || t === 'age3' ? 'age' : t.startsWith('housing') ? 'village' : t.startsWith('armor') ? 'blacksmith' : 'sword';
      btns.push(this.actBtn('research', `data-b="${b.id}" data-t="${t}" title="${esc(td.description)}"`, icon, td.name, s.api.techCost(st, HUMAN, t as TechId), why, me.res));
    }
    if (btns.length) body += `<h4>${d.trains.length ? 'Ausbilden' : 'Erforschen'}</h4><div class="grid">${btns.join('')}</div>`;
    let hireSig = '';
    if (b.kind === 'towncenter' && (RULES as { hireCostPct?: number }).hireCostPct !== undefined) {
      const left = s.api.hireCooldownLeft(st, HUMAN);
      const kinds = (Object.keys(UNITS) as UnitKind[]).filter((u) => u !== 'scout' && UNITS[u].age <= Math.max(me.age, 2));
      const hb = kinds.map((u) => {
        const why = s.validate({ t: 'hire', unit: u });
        return this.actBtn('hire', `data-u="${u}" title="${esc(UNITS[u].description)}"`, u as IconName, UNITS[u].name, s.api.hireCost(u), why, me.res);
      });
      body += `<h4>Söldner <span class="h4sub">${left > 0 ? `bereit in ${formatClock(left + 19)}` : 'sofort, nur Gold'}</span></h4><div class="grid">${hb.join('')}</div>`;
      hireSig = `${Math.ceil(left / 20)}`;
    }
    if (d.trains.length) body += `<div class="grid">${this.actBtn('rally', `data-b="${b.id}"`, 'flag', b.rally ? 'Sammelpunkt ändern' : 'Sammelpunkt setzen', null, null, me.res, 'wide' + (s.mode === 'rally' ? ' hot' : ''))}</div>`;
    if (!btns.length && !d.trains.length) body += `<div class="note">${esc(d.description)}</div>`;
    else body += `<div class="note">${esc(d.description)}</div>`;
    const qsig = b.queue.map((q) => q.item).join('.');
    return {
      sig: `b|${b.id}|${qsig}|${resSig}|${!!b.rally}|${s.mode}|${hireSig}`,
      html: `${this.head(iconFor(b.kind), me.color, d.name, `${sub} · ${b.hp}/${b.maxHp}`)}<div class="body">${body}</div>`,
    };
  }

  private ctxAction(el: HTMLElement) {
    const a = el.dataset.a!;
    const why = el.dataset.why;
    if (why) {
      this.toast(why, 'warn', 'alert');
      return;
    }
    const n = (k: string) => Number(el.dataset[k]);
    switch (a) {
      case 'close':
        this.act.deselect();
        break;
      case 'attack':
        this.act.attackMode();
        break;
      case 'stop':
        this.act.stop();
        break;
      case 'retreat':
        this.act.retreat();
        break;
      case 'army':
        this.act.selectArmy();
        break;
      case 'build':
        this.act.issue({ t: 'build', slot: this.s!.selSlot!, kind: el.dataset.k as BuildingKind });
        break;
      case 'train':
        this.act.issue({ t: 'train', building: n('b'), unit: el.dataset.u as UnitKind });
        break;
      case 'research':
        this.act.issue({ t: 'research', building: n('b'), tech: el.dataset.t as TechId });
        break;
      case 'cancel':
        this.act.issue({ t: 'cancel', building: n('b') });
        break;
      case 'rally':
        this.act.rallyMode();
        break;
      case 'upgrade':
        this.act.issue({ t: 'upgradePoint', point: n('p') });
        break;
      case 'fortify':
        this.act.issue({ t: 'fortifyPoint', point: n('p') });
        break;
      case 'hire':
        this.act.issue({ t: 'hire', unit: el.dataset.u as UnitKind });
        break;
    }
  }

  // ------------------------------------------------------------ modes: follow, mission, replay, net

  setFollow(on: boolean) {
    const b = this.els['t-follow'];
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }

  /** Mission tracker; null hides it. */
  setObjective(o: { text: string; progress: number } | null) {
    const el = this.els.objective;
    if (!o) {
      el.classList.add('hidden');
      document.body.classList.remove('has-obj');
      return;
    }
    el.classList.remove('hidden');
    document.body.classList.add('has-obj');
    const t = el.querySelector('.ot')!;
    if (t.textContent !== o.text) t.textContent = o.text;
    (el.querySelector('.ob i') as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, o.progress)) * 100)}%`;
  }

  /** Replay mode: bar visible, gameplay HUD trimmed. */
  setReplay(on: boolean) {
    this.els.replaybar.classList.toggle('hidden', !on);
    document.body.classList.toggle('replay', on);
  }
  updateReplay(tick: number, end: number, paused: boolean, speed: number) {
    const rb = this.els.replaybar;
    const seek = rb.querySelector('#seek') as HTMLInputElement;
    const max = Math.max(1, end);
    if (seek.max !== String(max)) seek.max = String(max);
    if (!this.seeking) seek.value = String(Math.min(tick, max));
    const t = `${formatClock(tick)} / ${formatClock(end)}`;
    const tl = rb.querySelector('.rtime')!;
    if (tl.textContent !== t) tl.textContent = t;
    const pb = rb.querySelector('[data-r="pause"]')!;
    const want = paused ? 'play' : 'pause';
    if ((pb as HTMLElement).dataset.icon !== want) {
      (pb as HTMLElement).dataset.icon = want;
      pb.innerHTML = svgIcon(want);
      pb.setAttribute('aria-label', paused ? 'Abspielen' : 'Pause');
    }
    rb.querySelectorAll<HTMLElement>('[data-r="speed"]').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === speed));
  }

  /** Online overlay (disconnect countdown, desync). null hides it. */
  setNetOverlay(o: { title: string; text: string; buttons: { id: string; label: string; primary?: boolean }[] } | null) {
    const el = this.els.netover;
    if (!o) {
      el.classList.add('hidden');
      return;
    }
    el.querySelector('h2')!.textContent = o.title;
    el.querySelector('.sub')!.textContent = o.text;
    const sig = o.buttons.map((b) => b.id).join(',');
    const bx = el.querySelector('.btns') as HTMLElement;
    if (bx.dataset.sig !== sig) {
      bx.dataset.sig = sig;
      bx.innerHTML = o.buttons.map((b) => `<button class="btn ${b.primary ? 'primary' : ''}" data-n="${b.id}">${esc(b.label)}</button>`).join('');
    }
    el.classList.remove('hidden');
  }

  /** Online: no speed button; the pause button opens the surrender dialog. Shows the ping chip. */
  setOnline(on: boolean) {
    this.els.speed.classList.toggle('hidden', on);
    this.els.ping.classList.toggle('hidden', !on);
  }
  private lastPing = -1;
  setPing(ms: number | undefined) {
    const v = ms === undefined ? 0 : Math.round(ms);
    if (v === this.lastPing) return;
    this.lastPing = v;
    this.els.ping.textContent = ms === undefined ? '– ms' : `${v} ms`;
    this.els.ping.classList.toggle('bad', v > 250);
  }

  // ------------------------------------------------------------ toasts

  toast(text: string, kind: 'warn' | 'good' | 'info', icon: IconName, jump?: { x: number; y: number }) {
    const box = this.els.toasts;
    // dedupe: refresh an identical visible toast
    for (const t of box.children as HTMLCollectionOf<HTMLElement>) {
      if (t.dataset.text === text && !t.classList.contains('out')) {
        clearTimeout(Number(t.dataset.timer));
        t.dataset.timer = String(window.setTimeout(() => this.dropToast(t), jump ? 5000 : 2800));
        return;
      }
    }
    const el = document.createElement('div');
    el.className = `toast panel ${kind}`;
    el.dataset.text = text;
    el.innerHTML = `${svgIcon(icon)}<span>${esc(text)}</span>${jump ? '<button class="go">Zeigen</button>' : ''}`;
    if (jump) el.querySelector('.go')!.addEventListener('click', () => (this.act.jumpTo(jump.x, jump.y), this.dropToast(el)));
    box.prepend(el);
    while (box.children.length > 3) box.lastElementChild!.remove();
    el.dataset.timer = String(window.setTimeout(() => this.dropToast(el), jump ? 5000 : 2800));
  }

  private dropToast(el: HTMLElement) {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 320);
  }
}
