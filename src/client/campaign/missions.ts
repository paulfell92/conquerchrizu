/**
 * Kampagne: five missions as data. Each mission sets up the match via
 * `config.scenario` (sim) plus bot options, and defines an objective that the
 * client checks every tick (see campaign/mission.ts). Point names refer to
 * the map „Chrizu-Tal“ (src/content/maps.ts).
 */
import type { Age, GameState, Scenario } from '../../sim/types';
import { TICK_RATE } from '../../sim/types';
import type { Difficulty, Personality } from '../../bot';

const MIN = 60 * TICK_RATE;

export interface ObjectiveStatus {
  /** One-line tracker text, e.g. „Punkte gehalten: 4/6“. */
  text: string;
  /** 0..1 for the tracker bar. */
  progress: number;
  done: boolean;
  failed: boolean;
  /** Optional reason shown on failure. */
  failText?: string;
}

/** Mutable per-run memory for objectives (e.g. "held since tick"). */
export type MissionMemo = Record<string, number>;

export interface Mission {
  id: string;
  title: string;
  briefing: string;
  goal: string; // short goal line for the briefing card
  difficulty: Difficulty;
  personality?: Personality;
  aggression?: number;
  maxAge?: Age;
  passive?: boolean;
  peaceTicks?: number;
  scenario: Scenario;
  /** Called every tick for the local player 0. */
  check(st: GameState, memo: MissionMemo): ObjectiveStatus;
}

const owned = (st: GameState, p: 0 | 1) => st.points.filter((x) => x.owner === p).length;
const clock = (t: number) => {
  const s = Math.max(0, Math.ceil(t / TICK_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const tcAlive = (st: GameState, p: 0 | 1) => st.buildings.some((b) => b.owner === p && b.kind === 'towncenter');

export const MISSIONS: Mission[] = [
  {
    id: 'm1',
    title: 'Das Tal erwacht',
    briefing:
      'Die Dörfer im Chrizu-Tal warten auf einen Herrn. Schick deine Trupps aus, besetze Dörfer, Wälder und Minen – und halte sie.',
    goal: 'Halte 6 Punkte gleichzeitig, bevor 6:00 vergangen sind.',
    difficulty: 'easy',
    passive: true,
    peaceTicks: 0,
    scenario: { vpEnabled: false },
    check(st) {
      const n = owned(st, 0);
      const left = 6 * MIN - st.tick;
      if (n >= 6) return { text: `Punkte gehalten: ${n}/6`, progress: 1, done: true, failed: false };
      if (left <= 0) return { text: `Punkte gehalten: ${n}/6`, progress: n / 6, done: false, failed: true, failText: 'Die Zeit ist abgelaufen.' };
      return { text: `Punkte gehalten: ${n}/6 · noch ${clock(left)}`, progress: n / 6, done: false, failed: false };
    },
  },
  {
    id: 'm2',
    title: 'Überfall im Morgengrauen',
    briefing:
      'Späher melden Fackeln im Osten. Die CPU greift in Wellen an, bevor die Sonne aufgeht. Deine Türme stehen schon – halte die Stellung.',
    goal: 'Überlebe 5:00. Dein Dorfzentrum darf nicht fallen.',
    difficulty: 'normal',
    aggression: 1.5,
    peaceTicks: 0,
    scenario: {
      vpEnabled: false,
      players: [{ startRes: { food: 600, wood: 450, gold: 250 } }, null],
      extraBuildings: [
        { owner: 0, kind: 'tower', slot: 2, built: true },
        { owner: 0, kind: 'tower', slot: 7, built: true },
        { owner: 0, kind: 'barracks', slot: 4, built: true },
      ],
    },
    check(st) {
      const left = 5 * MIN - st.tick;
      if (!tcAlive(st, 0)) return { text: 'Dorfzentrum gefallen', progress: 0, done: false, failed: true, failText: 'Dein Dorfzentrum ist gefallen.' };
      if (left <= 0) return { text: 'Überlebt!', progress: 1, done: true, failed: false };
      return { text: `Durchhalten: noch ${clock(left)}`, progress: st.tick / (5 * MIN), done: false, failed: false };
    },
  },
  {
    id: 'm3',
    title: 'Gold für die Krone',
    briefing: 'Die Krone verlangt Gold. Drei Minen liegen im Tal: Hausmine, Nordmine und Südmine. Wer alle drei hält, füllt die Schatzkammer.',
    goal: 'Halte alle 3 Minen gleichzeitig 60 Sekunden lang.',
    difficulty: 'normal',
    peaceTicks: 0,
    scenario: { pointOwners: [{ name: 'Hausmine', owner: 0 }] },
    check(st, memo) {
      const mines = st.points.filter((p) => p.kind === 'mine' && ['Hausmine', 'Nordmine', 'Südmine'].includes(p.name));
      const mine = mines.filter((p) => p.owner === 0).length;
      if (!tcAlive(st, 0)) return { text: 'Dorfzentrum gefallen', progress: 0, done: false, failed: true, failText: 'Dein Dorfzentrum ist gefallen.' };
      if (mine === mines.length && mines.length > 0) {
        if (memo.since === undefined) memo.since = st.tick;
        const held = st.tick - memo.since;
        if (held >= MIN) return { text: 'Alle Minen gehalten!', progress: 1, done: true, failed: false };
        return { text: `Alle Minen: ${clock(MIN - held)} halten`, progress: held / MIN, done: false, failed: false };
      }
      delete memo.since;
      return { text: `Minen gehalten: ${mine}/${mines.length || 3}`, progress: 0, done: false, failed: false };
    },
  },
  {
    id: 'm4',
    title: 'Kein Zurück',
    briefing:
      'Diesmal zählen keine Siegpunkte. Du ziehst mit Belagerungsgerät los – die Werkstatt steht, das Burgzeitalter ist erreicht. Bring die Rammen ans gegnerische Dorfzentrum.',
    goal: 'Zerstöre das gegnerische Dorfzentrum.',
    difficulty: 'normal',
    personality: 'turtle',
    peaceTicks: 0,
    scenario: {
      vpEnabled: false,
      players: [{ age: 2, startRes: { food: 500, wood: 600, gold: 400 } }, { age: 2 }],
      extraBuildings: [
        { owner: 0, kind: 'workshop', slot: 4, built: true },
        { owner: 0, kind: 'barracks', slot: 2, built: true },
      ],
    },
    check(st) {
      if (!tcAlive(st, 0)) return { text: 'Dorfzentrum gefallen', progress: 0, done: false, failed: true, failText: 'Dein Dorfzentrum ist gefallen.' };
      const tc = st.buildings.find((b) => b.owner === 1 && b.kind === 'towncenter');
      if (!tc) return { text: 'Gegnerisches Dorfzentrum zerstört!', progress: 1, done: true, failed: false };
      const pct = Math.round((tc.hp / tc.maxHp) * 100);
      return { text: `Gegnerisches Dorfzentrum: ${pct} %`, progress: 1 - tc.hp / tc.maxHp, done: false, failed: false };
    },
  },
  {
    id: 'm5',
    title: 'Die Schlacht um Chrizu',
    briefing:
      'Der Verteidiger hat seine Mine befestigt. Nutze die Friedenszeit zum Aufbau, dann gewinne über Siegpunkte oder sein Dorfzentrum – gegen eine angriffslustige CPU.',
    goal: 'Gewinne das Match gegen die befestigte CPU.',
    difficulty: 'normal',
    aggression: 1.2,
    personality: 'turtle',
    // 2:30 Friedenszeit: the defender starts with a fortified mine, so the
    // player needs time to build up before the VP race starts.
    peaceTicks: (5 * MIN) / 2,
    scenario: {
      players: [{ startRes: { food: 500, wood: 450, gold: 200 } }, null],
      pointOwners: [
        { name: 'Felsmine', owner: 1 },
      ],
      extraBuildings: [{ owner: 1, kind: 'pointtower', slot: 0, built: true, point: 'Felsmine' }],
    },
    check(st) {
      // the normal win conditions decide; the tracker just shows the VP race
      const a = Math.max(0, st.players[0].vp);
      const b = Math.max(0, st.players[1].vp);
      return { text: `Siegpunkte ${a} : ${b}`, progress: a / Math.max(1, a + b), done: false, failed: false };
    },
  },
];
