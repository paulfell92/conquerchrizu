/**
 * Conquer Chrizu – client entry. Wires session (sim + relay + bot), camera,
 * renderer, input, HUD and menus; owns the frame loop.
 */
import type { Command, GameEvent, UnitKind } from '../sim/types';
import { TICK_RATE, TILE } from '../sim/types';
import { AGE_NAMES, BUILDINGS, RULES, TECHS, UNITS } from '../content';
import type { Difficulty } from '../bot';
import { CSS } from './hud/styles';
import { Camera } from './camera';
import { Renderer, type Pick } from './render/renderer';
import { DOUBLE_TAP_MS, Input, type InputHandler } from './input';
import { Hud } from './hud/hud';
import { Menus } from './hud/menus';
import { HUMAN, Session, setLocalPlayer, type SessionOptions } from './session';
import { MISSIONS, type MissionMemo } from './campaign/missions';
import { hasReplay, loadReplay, saveReplay, type StoredReplay } from './replayStore';
import { personalityInfo, type EndInfo } from './hud/menus';
import { OnlineController } from './online';
import { Tutorial } from './hud/tutorial';
import { prefs } from './prefs';
import { iconFor } from './icons';

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
function issue(cmd: Command): boolean {
  const s = session;
  if (!s || s.over) return false;
  const why = s.validate(cmd);
  if (why) {
    hud.toast(why, 'warn', 'alert');
    return false;
  }
  s.submit(cmd);
  if (cmd.t === 'build') {
    // close the slot menu; the building appears after the command delay
    s.clearSelection();
    pendingSelectSlot = cmd.slot;
  }
  return true;
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
  if (!issue({ t: 'move', squads: ids, x, y })) return;
  commandFeedback(ids, x, y, '#fff3c4');
  followArmy(ids, x, y);
}
/** „Neue Trupps folgen der Armee“: commanding the army also moves the rally of all training buildings. */
function followArmy(ids: number[], x: number, y: number) {
  const s = session;
  if (!s || !prefs.followArmy) return;
  // only when most of the army is commanded (not for a single scout)
  const army = s.myArmy().filter((q) => q.kind !== 'scout');
  const n = ids.filter((id) => army.some((q) => q.id === id)).length;
  if (army.length === 0 || n * 2 < army.length) return;
  const cmd: Command = { t: 'rallyAll', x, y };
  if (s.validate(cmd) === null) s.submit(cmd);
}
function attackWithSelected(target: number, x: number, y: number) {
  const s = session!;
  const ids = selectedOwn();
  if (!ids.length) return;
  if (!issue({ t: 'attack', squads: ids, target })) return;
  commandFeedback(ids, x, y, '#ff8a6e');
  followArmy(ids, x, y);
  void s;
}
/** Destination marker + a short-lived line from each commanded squad, counts toward the hint. */
function commandFeedback(ids: number[], x: number, y: number, color: string) {
  const s = session!;
  const now = performance.now();
  s.spawnFx(3, x, y, 0, 0, now, 450, color, false);
  for (const id of ids) {
    const p = renderer.squadPos.get(id);
    const q = s.squadById(id);
    if (q) s.spawnFx(4, p && p.x > -1e8 ? p.x : q.x, p && p.x > -1e8 ? p.y : q.y, x, y, now, 700, color, false);
  }
  prefs.countCommand();
  hud.commandHint = prefs.showCommandHint;
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
    const s = session;
    if (!s || s.online) return;
    const cyc = [0.75, 1, 2];
    s.speed = cyc[(cyc.indexOf(s.speed) + 1) % cyc.length] ?? 1;
  },
  toggleFollow: () => {
    prefs.followArmy = !prefs.followArmy;
    hud.setFollow(prefs.followArmy);
    hud.toast(prefs.followArmy ? 'Neue Trupps folgen der Armee' : 'Neue Trupps bleiben am Sammelpunkt', 'info', 'flag');
  },
  replayPause: () => {
    if (session?.replay) session.paused = !session.paused;
  },
  replaySpeed: (v) => {
    if (session?.replay) session.speed = v;
  },
  replaySeek: (t) => replaySeek(t),
  replayEnd: () => toMenu(),
  netAction: (id) => online.action(id),
  toggleBoxMode: () => hud.setBoxMode(!hud.boxMode),
  minimapJump: (fx, fy) => {
    if (!session) return;
    cam.centerOn(fx * session.state.mapW * TILE, fy * session.state.mapH * TILE);
  },
});

const menus = new Menus(app, {
  start: (d, peaceMin, pers) =>
    startGame(d, { peaceTicks: peaceMin * 60 * TICK_RATE, ...(pers !== 'random' ? { personality: pers } : {}) }, { revealPersonality: pers === 'random' }),
  tutorial: () => startTutorial(),
  mission: (i) => startMission(i),
  replay: () => void startReplay(),
  onlineCreate: () => online.create(),
  onlineJoin: (code) => online.join(code),
  onlineCancel: () => online.cancel(),
  retryMission: () => {
    if (mission) startMission(mission.index);
  },
  nextMission: () => {
    if (mission) startMission(mission.index + 1);
  },
  watchReplay: () => void startReplay(),
  resume: () => setPaused(false),
  surrender: () => {
    if (!session) return;
    session.submit({ t: 'surrender' });
    if (!session.online) setPaused(false);
    else menus.showPause(false);
  },
  toMenu: () => toMenu(),
});

function toMenu() {
  {
    cancelPendingTap();
    tutorial?.destroy();
    tutorial = null;
    mission = null;
    online.leave();
    hud.setObjective(null);
    hud.setReplay(false);
    hud.setNetOverlay(null);
    menus.replayAvailable = hasReplay();
    menus.showEnd(null);
    menus.showPause(false);
    hud.setVisible(false);
    menus.showMenu(true);
    // keep the old map as a backdrop but stop updates
    if (session) session.paused = true;
  }
}

const online = new OnlineController({
  hud: () => hud,
  menus: () => menus,
  startOnline: (opts, names) => startGame('normal', opts, { names }),
  session: () => session,
  toMenu: () => toMenu(),
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
  if (tc) cam.centerOn(tc.x + (HUMAN === 0 ? 4000 : -4000), tc.y + 500);
}

function setPaused(p: boolean) {
  const s = session;
  if (!s || s.over) return;
  if (s.online) {
    // no pause online; the button opens the surrender dialog only
    menus.showPause(p);
    return;
  }
  if (s.replay) {
    s.paused = p;
    return;
  }
  s.paused = p;
  menus.showPause(p);
}

// ---------------------------------------------------------------- input
/**
 * Tap model: a single tap only selects / inspects. A double tap (or right
 * click) commands the selected squads. While squads are selected, the single
 * tap's selection change is deferred by the double-tap window so the first
 * tap of a double tap never changes the selection.
 */
let pendingTap: { timer: number } | null = null;
function cancelPendingTap() {
  if (pendingTap) {
    clearTimeout(pendingTap.timer);
    pendingTap = null;
  }
}

/** The selection change a single tap on `pk` makes (no command, ever). */
function selectionFor(pk: Pick, shift: boolean): () => void {
  const s = session!;
  switch (pk.t) {
    case 'squad':
      if (pk.squad.owner === HUMAN) {
        const id = pk.squad.id;
        return shift ? () => s.toggleSquad(id) : () => s.selectSquads([id]);
      }
      return () => s.selectEnemy(pk.squad.id);
    case 'building':
      if (pk.building.owner === HUMAN) return () => s.selectBuilding(pk.building.id);
      return () => s.selectEnemy(pk.building.id);
    case 'slot':
      return () => s.selectSlot(pk.slot);
    case 'point':
      return () => s.selectPoint(pk.point.id);
    default:
      return () => {}; // empty ground / fogged memory: nothing
  }
}

/** Command for the selected squads at a picked target (double tap / right click). */
function commandAt(pk: Pick, x: number, y: number) {
  const s = session!;
  if (!s.selected.size) return;
  const wx = Math.round(cam.wx(x) * TILE);
  const wy = Math.round(cam.wy(y) * TILE);
  switch (pk.t) {
    case 'squad':
      if (pk.squad.owner !== HUMAN) attackWithSelected(pk.squad.id, pk.squad.x, pk.squad.y);
      else moveSelected(wx, wy);
      break;
    case 'building': {
      const b = pk.building;
      if (b.owner !== HUMAN) {
        attackWithSelected(b.id, b.x, b.y);
        break;
      }
      // own building: move next to it, on the side facing the squads
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const id of s.selected) {
        const q = s.squadById(id);
        if (q) {
          cx += q.x;
          cy += q.y;
          n++;
        }
      }
      const dx = n ? cx / n - b.x : 1;
      const dy = n ? cy / n - b.y : 0;
      const l = Math.hypot(dx, dy) || 1;
      const r = (b.kind === 'towncenter' ? RULES.townCenterRadius : RULES.buildingRadius) + RULES.squadRadius + 700;
      moveSelected(Math.round(b.x + (dx / l) * r), Math.round(b.y + (dy / l) * r));
      break;
    }
    case 'remembered':
      attackWithSelected(pk.rem.id, pk.rem.x, pk.rem.y);
      break;
    case 'point':
      moveSelected(pk.point.x, pk.point.y);
      break;
    default:
      moveSelected(wx, wy);
  }
}

const handler: InputHandler = {
  tap(x, y, o) {
    const s = session;
    if (!s || s.over || s.paused || s.replay) return;
    const now = performance.now();
    const wx = Math.round(cam.wx(x) * TILE);
    const wy = Math.round(cam.wy(y) * TILE);
    s.spawnFx(5, wx, wy, 0, 0, now, o.double ? 420 : 320, o.double ? '#ffe08a' : '#fff6da', o.double);
    // explicit modes from panel buttons act on a single tap
    if (s.mode === 'rally' && s.selBuilding !== null) {
      cancelPendingTap();
      issue({ t: 'rally', building: s.selBuilding, x: wx, y: wy });
      s.spawnFx(3, wx, wy, 0, 0, now, 450, '#fff3c4', false);
      s.mode = 'none';
      syncMode();
      return;
    }
    const pk = renderer.pick(x, y, o.touch);
    if (s.mode === 'attack') {
      cancelPendingTap();
      if (pk.t === 'squad' && pk.squad.owner !== HUMAN) attackWithSelected(pk.squad.id, pk.squad.x, pk.squad.y);
      else if (pk.t === 'building' && pk.building.owner !== HUMAN) attackWithSelected(pk.building.id, pk.building.x, pk.building.y);
      else if (pk.t === 'remembered') attackWithSelected(pk.rem.id, pk.rem.x, pk.rem.y);
      s.mode = 'none';
      syncMode();
      return;
    }
    if (o.double) {
      cancelPendingTap();
      if (pk.t === 'squad' && pk.squad.owner === HUMAN) {
        const kind = pk.squad.kind;
        s.selectSquads(s.myArmy().filter((m) => m.kind === kind).map((m) => m.id));
      } else if (s.selected.size) commandAt(pk, x, y);
      else selectionFor(pk, false)();
      syncMode();
      return;
    }
    const apply = selectionFor(pk, o.shift);
    cancelPendingTap();
    if (s.selected.size && !o.shift) {
      pendingTap = {
        timer: window.setTimeout(() => {
          pendingTap = null;
          if (session === s && !s.over) {
            apply();
            syncMode();
          }
        }, DOUBLE_TAP_MS + 30),
      };
    } else {
      apply();
      syncMode();
    }
  },
  command(x, y) {
    const s = session;
    if (!s || s.over || s.paused || s.replay || !s.selected.size) return;
    cancelPendingTap();
    commandAt(renderer.pick(x, y, false), x, y);
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
        if (b) hud.toast(`${BUILDINGS[b.kind]?.name ?? 'Gebäude'} fertig`, 'good', iconFor(b.kind));
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
    case 'peaceOver':
      hud.toast('Friedenszeit vorbei – jetzt wird gekämpft', 'warn', 'barracks');
      break;
    case 'gameOver':
      onGameOver(s);
      break;
  }
}

// ---------------------------------------------------------------- lifecycle
interface StartExtra {
  revealPersonality?: boolean;
  /** Labels for HUD + end screen [player 0, player 1]. */
  names?: [string, string];
}
let startExtra: StartExtra = {};

function startGame(d: Difficulty, opts: SessionOptions = {}, extra: StartExtra = {}) {
  cancelPendingTap();
  tutorial?.destroy();
  tutorial = null;
  if (!opts.scenario) mission = null;
  startExtra = extra;
  const seed = params.has('seed') ? Number(params.get('seed')) : (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
  session = new Session(d, seed, opts);
  const s = session;
  s.on(onEvent);
  cam.setMap(s.state.mapW, s.state.mapH);
  renderer.setSession(s);
  hud.bind(s);
  hud.commandHint = prefs.showCommandHint && !s.replay;
  const pers = s.personality ? personalityInfo(s.personality).label : null;
  hud.meLabel = extra.names?.[HUMAN] ?? 'Du';
  hud.opponentLabel = extra.names?.[1 - HUMAN] ?? (pers && !extra.revealPersonality ? pers : 'CPU');
  hud.setFollow(prefs.followArmy);
  document.body.classList.toggle('p1', HUMAN === 1);
  hud.setOnline(s.online);
  hud.setReplay(s.replay);
  hud.setObjective(null);
  hud.setNetOverlay(null);
  hud.setVisible(true);
  hud.setBoxMode(false);
  menus.showMenu(false);
  menus.showPause(false);
  menus.showEnd(null);
  menus.showBriefing(null);
  layout();
  cam.zoom = Math.max(cam.minZoom, Math.min(cam.maxZoom, 48, cam.viewW / 26, cam.viewH / 12));
  if (s.replay) {
    cam.zoom = cam.minZoom * 1.1;
    cam.centerOn((s.state.mapW / 2) * TILE, (s.state.mapH / 2) * TILE);
  } else jumpHome();
  if (DEBUG)
    (window as unknown as { __game: unknown }).__game = {
      session: s, cam, renderer, hud, menus, online,
      get tutorial() { return tutorial; },
      get mission() { return mission; },
    };
}

function endNames(s: Session): [string, string] {
  if (startExtra.names) return startExtra.names;
  const pers = s.personality ? personalityInfo(s.personality).label : null;
  const op = pers ? `CPU (${pers})` : 'CPU';
  return HUMAN === 0 ? ['Du', op] : [op, 'Du'];
}

function onGameOver(s: Session) {
  const st = s.state;
  let missionInfo: EndInfo['mission'] = null;
  if (mission && !s.replay) {
    const won = st.winner === HUMAN;
    const m = MISSIONS[mission.index];
    if (won) prefs.missionWon(mission.index, m.id, st.tick);
    missionInfo = { index: mission.index, title: m.title, won, best: prefs.bestTime(m.id), failText: mission.failText };
  }
  const names = endNames(s);
  const finish = (replayOk: boolean) => {
    window.setTimeout(() => {
      if (session !== s) return;
      hud.setVisible(false);
      hud.setNetOverlay(null);
      menus.showEnd(st, {
        names,
        samples: s.samples,
        personality: startExtra.revealPersonality && s.personality ? personalityInfo(s.personality).label : null,
        mission: missionInfo,
        online: s.online,
        replayAvailable: replayOk,
        isReplay: s.replay,
      });
    }, 900);
  };
  if (s.replay || s.tutorial) return finish(hasReplay());
  const log = s.relay.log.filter((c) => c.tick <= st.tick);
  saveReplay({ v: 1, config: st.config, log, endTick: st.tick, winner: st.winner, names, savedAt: Date.now() })
    .then((ok) => finish(ok))
    .catch(() => finish(false));
}

// ---------------------------------------------------------------- campaign
let mission: { index: number; memo: MissionMemo; failText?: string; sent: boolean } | null = null;

function startMission(i: number) {
  const m = MISSIONS[i];
  if (!m) return toMenu();
  startGame(
    m.difficulty,
    {
      scenario: m.scenario,
      peaceTicks: m.peaceTicks ?? 0,
      passiveBot: !!m.passive,
      ...(m.personality ? { personality: m.personality } : {}),
      ...(m.aggression !== undefined ? { aggression: m.aggression } : {}),
      ...(m.maxAge !== undefined ? { maxAge: m.maxAge } : {}),
    },
    {},
  );
  mission = { index: i, memo: {}, sent: false };
  const s = session!;
  s.onTick((ss) => {
    if (!mission || mission.sent || ss.over) return;
    const o = MISSIONS[mission.index].check(ss.state, mission.memo);
    hud.setObjective(o);
    if (o.done || o.failed) {
      mission.sent = true;
      mission.failText = o.failText;
      ss.submit({ t: 'objective', won: o.done });
    }
  });
  hud.setObjective(m.check(s.state, mission.memo));
}

// ---------------------------------------------------------------- replay
let replayData: StoredReplay | null = null;

async function startReplay() {
  const r = await loadReplay();
  if (!r) {
    hud.toast('Kein Replay gespeichert', 'warn', 'alert');
    return;
  }
  replayData = r;
  setLocalPlayer(0);
  startGame('normal', { config: r.config, replayLog: r.log, noBot: true }, { names: r.names });
  session!.speed = 4;
}

function replaySeek(t: number) {
  const r = replayData;
  const cur = session;
  if (!r || !cur?.replay) return;
  const speed = cur.speed;
  const paused = cur.paused;
  const camX = cam.x;
  const camY = cam.y;
  const z = cam.zoom;
  if (t < cur.state.tick) {
    startGame('normal', { config: r.config, replayLog: r.log, noBot: true }, { names: r.names });
  }
  const s = session!;
  s.fastForward(Math.max(0, Math.min(t, r.endTick)));
  s.speed = speed;
  s.paused = paused;
  cam.zoom = z;
  cam.x = camX;
  cam.y = camY;
  cam.clamp();
}

let tutorial: Tutorial | null = null;
function startTutorial() {
  prefs.tutorialSeen = true;
  startGame('easy', { peaceTicks: 10 * 60 * TICK_RATE, passiveBot: true, tutorial: true });
  tutorial = new Tutorial(app, session!, cam, {
    finish: (goMenu) => {
      tutorial = null;
      if (goMenu) toMenu();
    },
    focus: (x, y) => cam.centerOn(x, y),
  });
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
    tutorial?.update(now);
    if (s.replay) hud.updateReplay(s.state.tick, replayData?.endTick ?? s.replayEnd, s.paused, s.speed);
    online.frame(now);
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
menus.onlineAvailable = online.available;
menus.replayAvailable = hasReplay();
menus.showMenu(true);
if (params.has('autostart')) startGame((params.get('autostart') as Difficulty) || 'normal');
if (params.has('mission')) startMission(Number(params.get('mission')) || 0);
else if (!params.has('autostart') && online.tryRejoin()) menus.showMenu(true, 'online');
if (DEBUG) (window as unknown as { __cc: unknown }).__cc = { startMission, startReplay, menus, online };
requestAnimationFrame(frame);
