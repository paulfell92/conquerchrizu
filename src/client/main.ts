/**
 * Conquer Chrizu – client entry. Wires session (sim + relay + bot), camera,
 * renderer, input, HUD and menus; owns the frame loop.
 */
import type { Command, GameEvent, UnitKind } from '../sim/types';
import { TILE } from '../sim/types';
import { AGE_NAMES, BUILDINGS, TECHS, UNITS } from '../content';
import type { Difficulty } from '../bot';
import { CSS } from './hud/styles';
import { Camera } from './camera';
import { Renderer } from './render/renderer';
import { Input, type InputHandler } from './input';
import { Hud } from './hud/hud';
import { Menus } from './hud/menus';
import { HUMAN, Session } from './session';

// ---------------------------------------------------------------- DOM setup
const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

const app = document.getElementById('app')!;
const canvas = document.createElement('canvas');
canvas.id = 'world';
app.appendChild(canvas);

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const cam = new Camera();
const renderer = new Renderer(canvas, cam);
let session: Session | null = null;
let lastFrame = performance.now();
let mmTimer = 0;

// ---------------------------------------------------------------- actions
function issue(cmd: Command) {
  const s = session;
  if (!s || s.over) return;
  const why = s.validate(cmd);
  if (why) {
    hud.toast(why, 'warn', 'alert');
    return;
  }
  s.submit(cmd);
  if (cmd.t === 'build') {
    // close the slot menu; the building appears after the command delay
    s.clearSelection();
    pendingSelectSlot = cmd.slot;
  }
}
/** After placing a building, select it once it exists so its panel opens. */
let pendingSelectSlot: number | null = null;

function selectedOwn(): number[] {
  return session ? session.selectedIds() : [];
}

function moveSelected(x: number, y: number) {
  const s = session!;
  const ids = selectedOwn();
  if (!ids.length) return;
  issue({ t: 'move', squads: ids, x, y });
  s.spawnFx(3, x, y, 0, 0, performance.now(), 450, '#fff3c4', false);
}
function attackWithSelected(target: number, x: number, y: number) {
  const s = session!;
  const ids = selectedOwn();
  if (!ids.length) return;
  issue({ t: 'attack', squads: ids, target });
  s.spawnFx(3, x, y, 0, 0, performance.now(), 450, '#ff8a6e', false);
}

const hud = new Hud(app, {
  select: (ids, add) => {
    const s = session;
    if (!s) return;
    if (add) {
      for (const id of ids) s.toggleSquad(id);
    } else s.selectSquads(ids);
    syncMode();
  },
  selectKind: (kind: UnitKind) => {
    const s = session;
    if (!s) return;
    s.selectSquads(s.myArmy().filter((q) => q.kind === kind).map((q) => q.id));
    syncMode();
  },
  selectArmy: () => selectArmy(),
  stop: () => {
    const ids = selectedOwn();
    if (ids.length) issue({ t: 'stop', squads: ids });
  },
  retreat: () => {
    const ids = selectedOwn();
    if (ids.length) issue({ t: 'retreat', squads: ids });
  },
  attackMode: () => {
    if (!session) return;
    session.mode = session.mode === 'attack' ? 'none' : 'attack';
    syncMode();
  },
  rallyMode: () => {
    if (!session) return;
    session.mode = session.mode === 'rally' ? 'none' : 'rally';
    syncMode();
  },
  cancelMode: () => {
    if (!session) return;
    session.mode = 'none';
    syncMode();
  },
  deselect: () => {
    session?.clearSelection();
    syncMode();
  },
  issue,
  jumpTo: (x, y) => cam.centerOn(x, y),
  jumpHome: () => jumpHome(),
  togglePause: () => setPaused(!session?.paused),
  toggleSpeed: () => {
    if (session) session.speed = session.speed === 1 ? 2 : 1;
  },
  toggleBoxMode: () => hud.setBoxMode(!hud.boxMode),
  minimapJump: (fx, fy) => {
    if (!session) return;
    cam.centerOn(fx * session.state.mapW * TILE, fy * session.state.mapH * TILE);
  },
});

const menus = new Menus(app, {
  start: (d) => startGame(d),
  resume: () => setPaused(false),
  surrender: () => {
    if (!session) return;
    session.submit({ t: 'surrender' });
    setPaused(false);
  },
  toMenu: () => {
    menus.showEnd(null);
    hud.setVisible(false);
    menus.showMenu(true);
    // keep the old map as a backdrop but stop updates
    if (session) session.paused = true;
  },
});

function syncMode() {
  hud.setMode(session?.mode ?? 'none');
}

function selectArmy() {
  const s = session;
  if (!s) return;
  s.selectSquads(s.myArmy().map((q) => q.id));
  syncMode();
}

function jumpHome() {
  const s = session;
  if (!s) return;
  const tc = s.api.townCenter(s.state, HUMAN);
  if (tc) cam.centerOn(tc.x + 4000, tc.y + 500);
}

function setPaused(p: boolean) {
  const s = session;
  if (!s || s.over) return;
  s.paused = p;
  menus.showPause(p);
}

// ---------------------------------------------------------------- input
const handler: InputHandler = {
  tap(x, y, o) {
    const s = session;
    if (!s || s.over || s.paused) return;
    const pk = renderer.pick(x, y, o.touch);
    // pending modes
    if (s.mode === 'rally' && s.selBuilding !== null) {
      const wx = Math.round(cam.wx(x) * TILE);
      const wy = Math.round(cam.wy(y) * TILE);
      issue({ t: 'rally', building: s.selBuilding, x: wx, y: wy });
      s.spawnFx(3, wx, wy, 0, 0, performance.now(), 450, '#fff3c4', false);
      s.mode = 'none';
      syncMode();
      return;
    }
    const hasArmy = s.selected.size > 0;
    switch (pk.t) {
      case 'squad': {
        const q = pk.squad;
        if (q.owner === HUMAN) {
          if (o.double) {
            s.selectSquads(s.myArmy().filter((m) => m.kind === q.kind).map((m) => m.id));
          } else if (o.shift) s.toggleSquad(q.id);
          else if (s.mode === 'attack') {
            /* ignore own in attack mode */
          } else s.selectSquads([q.id]);
        } else if (hasArmy) attackWithSelected(q.id, q.x, q.y);
        else s.selectEnemy(q.id);
        break;
      }
      case 'building': {
        const b = pk.building;
        if (b.owner === HUMAN) {
          if (hasArmy && s.mode !== 'attack') {
            // tapping own base with an army selected: move there
            moveSelected(Math.round(cam.wx(x) * TILE), Math.round(cam.wy(y) * TILE));
          } else s.selectBuilding(b.id);
        } else if (hasArmy) attackWithSelected(b.id, b.x, b.y);
        else s.selectEnemy(b.id);
        break;
      }
      case 'remembered':
        if (hasArmy) attackWithSelected(pk.rem.id, pk.rem.x, pk.rem.y);
        break;
      case 'slot':
        if (hasArmy) moveSelected(Math.round(cam.wx(x) * TILE), Math.round(cam.wy(y) * TILE));
        else s.selectSlot(pk.slot);
        break;
      case 'point':
        if (hasArmy) moveSelected(pk.point.x, pk.point.y);
        else s.selectPoint(pk.point.id);
        break;
      case 'ground':
        if (hasArmy && s.mode !== 'attack') moveSelected(pk.x, pk.y);
        else if (s.mode === 'attack') {
          s.mode = 'none';
        } else s.clearSelection();
        break;
    }
    if (s.mode === 'attack' && pk.t !== 'squad') s.mode = 'none';
    if (s.mode === 'attack' && pk.t === 'squad' && pk.squad.owner !== HUMAN) s.mode = 'none';
    syncMode();
  },
  command(x, y) {
    const s = session;
    if (!s || s.over || s.paused || !s.selected.size) return;
    const pk = renderer.pick(x, y, false);
    if (pk.t === 'squad' && pk.squad.owner !== HUMAN) attackWithSelected(pk.squad.id, pk.squad.x, pk.squad.y);
    else if (pk.t === 'building' && pk.building.owner !== HUMAN) attackWithSelected(pk.building.id, pk.building.x, pk.building.y);
    else if (pk.t === 'remembered') attackWithSelected(pk.rem.id, pk.rem.x, pk.rem.y);
    else if (pk.t === 'point') moveSelected(pk.point.x, pk.point.y);
    else moveSelected(Math.round(cam.wx(x) * TILE), Math.round(cam.wy(y) * TILE));
  },
  boxSelect(x0, y0, x1, y1, shift) {
    const s = session;
    if (!s || s.over) return;
    const ids = renderer.squadsInBox(x0, y0, x1, y1);
    if (ids.length) s.selectSquads(ids, shift && s.selected.size > 0);
    else if (!shift) s.clearSelection();
    syncMode();
  },
  boxPreview(b) {
    renderer.box = b;
  },
  boxModeTouch: () => hud.boxMode,
  cameraMoved() {},
  key(e) {
    const s = session;
    if (!s) return;
    if (e.key === 'Escape') {
      if (menus.pauseVisible) setPaused(false);
      else if (s.mode !== 'none') {
        s.mode = 'none';
        syncMode();
      } else s.clearSelection();
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      setPaused(!s.paused);
      return;
    }
    if (s.paused || s.over) return;
    if (e.key >= '1' && e.key <= '9') {
      const army = s.myArmy();
      const q = army[Number(e.key) - 1];
      if (q) {
        if (e.shiftKey) s.toggleSquad(q.id);
        else s.selectSquads([q.id]);
      }
    } else if (e.key === 'a' || e.key === 'A') selectArmy();
    else if (e.key === 's' || e.key === 'S') {
      const ids = selectedOwn();
      if (ids.length) issue({ t: 'stop', squads: ids });
    } else if (e.key === 'r' || e.key === 'R') {
      const ids = selectedOwn();
      if (ids.length) issue({ t: 'retreat', squads: ids });
    } else if (e.key === ' ') {
      e.preventDefault();
      jumpHome();
    } else if (e.key === '+' || e.key === '=') cam.zoomAt(cam.viewW / 2, cam.viewH / 2, 1.2);
    else if (e.key === '-') cam.zoomAt(cam.viewW / 2, cam.viewH / 2, 1 / 1.2);
    syncMode();
  },
};
const input = new Input(canvas, cam, handler);

// ---------------------------------------------------------------- events → toasts
function onEvent(ev: GameEvent, s: Session) {
  switch (ev.t) {
    case 'underAttack':
      if (ev.owner === HUMAN) hud.toast('Du wirst angegriffen!', 'warn', 'alert', { x: ev.x, y: ev.y });
      break;
    case 'rejected':
      if (ev.owner === HUMAN) hud.toast(ev.reason, 'warn', 'alert');
      break;
    case 'captured': {
      const p = s.state.points.find((q) => q.id === ev.point);
      if (!p) break;
      if (ev.owner === HUMAN) hud.toast(`${p.name} erobert`, 'good', p.kind);
      else if (ev.prevOwner === HUMAN) hud.toast(`${p.name} verloren`, 'warn', p.kind, { x: p.x, y: p.y });
      else if (ev.owner !== -1) hud.toast(`CPU erobert ${p.name}`, 'info', p.kind);
      break;
    }
    case 'ageUp':
      if (ev.owner === HUMAN) hud.toast(`${AGE_NAMES[ev.age]} erreicht`, 'good', 'age');
      else hud.toast(`CPU erreicht das ${AGE_NAMES[ev.age]}`, 'info', 'age');
      break;
    case 'built':
      if (ev.owner === HUMAN) {
        const b = s.buildingById(ev.building);
        if (b) hud.toast(`${BUILDINGS[b.kind].name} fertig`, 'good', b.kind);
      }
      break;
    case 'researched':
      if (ev.owner === HUMAN && ev.tech !== 'age2' && ev.tech !== 'age3') hud.toast(`${TECHS[ev.tech].name} erforscht`, 'good', 'hammer');
      break;
    case 'trained':
      if (ev.owner === HUMAN) {
        const q = s.squadById(ev.squad);
        if (q && s.selected.size === 0 && s.selBuilding === null && s.selSlot === null) {
          /* stay quiet; the card strip shows it */
        }
        void UNITS;
      }
      break;
    case 'gameOver':
      window.setTimeout(() => {
        hud.setVisible(false);
        menus.showEnd(s.state);
      }, 900);
      break;
  }
}

// ---------------------------------------------------------------- lifecycle
function startGame(d: Difficulty) {
  const seed = params.has('seed') ? Number(params.get('seed')) : (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
  session = new Session(d, seed);
  session.on(onEvent);
  cam.setMap(session.state.mapW, session.state.mapH);
  renderer.setSession(session);
  hud.bind(session);
  hud.setVisible(true);
  hud.setBoxMode(false);
  menus.showMenu(false);
  menus.showPause(false);
  menus.showEnd(null);
  layout();
  cam.zoom = Math.max(cam.minZoom, Math.min(cam.maxZoom, 48, cam.viewW / 26, cam.viewH / 12));
  jumpHome();
  if (DEBUG) (window as unknown as { __game: unknown }).__game = { session, cam, renderer, hud, menus };
}

/** Backdrop for the menu: a fresh state without a bot, not ticking. */
function backdrop() {
  try {
    session = new Session('normal', 7);
    session.paused = true;
    session.bot = null;
    cam.setMap(session.state.mapW, session.state.mapH);
    renderer.setSession(session);
    layout();
    cam.zoom = cam.minZoom * 1.35;
    cam.centerOn((session.state.mapW / 2) * TILE, (session.state.mapH / 2) * TILE);
  } catch (e) {
    console.error('[client] Hintergrund konnte nicht erstellt werden', e);
    session = null;
  }
}

function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.resize(w, h, dpr);
  cam.setView(w, h);
  hud.sizeMinimap(dpr);
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 200));
document.addEventListener('visibilitychange', () => {
  lastFrame = performance.now();
});
// block iOS pinch-zoom of the page and double-tap zoom
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

function frame(now: number) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(250, now - lastFrame);
  lastFrame = now;
  const s = session;
  if (!s) return;
  input.update(dt);
  s.update(dt);
  if (pendingSelectSlot !== null) {
    const b = s.state.buildings.find((x) => x.owner === HUMAN && x.slot === pendingSelectSlot);
    if (b) {
      if (s.selected.size === 0 && s.selBuilding === null && s.selSlot === null) s.selectBuilding(b.id);
      pendingSelectSlot = null;
    } else if (s.state.tick > 0 && s.relay.log.length && s.state.tick > s.relay.log[s.relay.log.length - 1].tick + 2) pendingSelectSlot = null;
  }
  renderer.render(now);
  if (hud.root.style.display !== 'none') {
    hud.update();
    mmTimer -= dt;
    if (mmTimer <= 0) {
      mmTimer = 100;
      renderer.drawMinimap(hud.minimap);
    }
  }
}

hud.setVisible(false);
layout();
backdrop();
menus.showMenu(true);
if (params.has('autostart')) startGame((params.get('autostart') as Difficulty) || 'normal');
requestAnimationFrame(frame);
