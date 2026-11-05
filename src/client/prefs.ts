/** Per-device settings in localStorage. Every access is guarded: storage may be blocked. */
import type { Difficulty } from '../bot';

const KEY = 'cc.prefs.v1';
export const PEACE_OPTIONS = [0, 2, 3, 5] as const; // minutes
export type PeaceMin = (typeof PEACE_OPTIONS)[number];
/** Show the "Doppeltippen = Befehl" chip until this many commands were issued. */
const HINT_COMMANDS = 10;

interface Data {
  difficulty: Difficulty;
  peaceMin: PeaceMin;
  commands: number;
  tutorialSeen: boolean;
}

const DEFAULTS: Data = { difficulty: 'normal', peaceMin: 3, commands: 0, tutorialSeen: false };

class Prefs {
  private d: Data = { ...DEFAULTS };

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw) as Partial<Data>;
        if (v.difficulty === 'easy' || v.difficulty === 'normal' || v.difficulty === 'hard') this.d.difficulty = v.difficulty;
        if (PEACE_OPTIONS.includes(v.peaceMin as PeaceMin)) this.d.peaceMin = v.peaceMin as PeaceMin;
        if (typeof v.commands === 'number' && v.commands >= 0) this.d.commands = v.commands;
        if (typeof v.tutorialSeen === 'boolean') this.d.tutorialSeen = v.tutorialSeen;
      } else {
        // migrate the old single key
        const old = localStorage.getItem('cc.difficulty');
        if (old === 'easy' || old === 'normal' || old === 'hard') this.d.difficulty = old;
      }
    } catch {
      /* storage blocked: defaults */
    }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.d));
    } catch {
      /* ignore */
    }
  }

  get difficulty() {
    return this.d.difficulty;
  }
  set difficulty(v: Difficulty) {
    this.d.difficulty = v;
    this.save();
  }
  get peaceMin() {
    return this.d.peaceMin;
  }
  set peaceMin(v: PeaceMin) {
    this.d.peaceMin = v;
    this.save();
  }
  get tutorialSeen() {
    return this.d.tutorialSeen;
  }
  set tutorialSeen(v: boolean) {
    this.d.tutorialSeen = v;
    this.save();
  }
  get showCommandHint() {
    return this.d.commands < HINT_COMMANDS;
  }
  countCommand() {
    if (this.d.commands >= HINT_COMMANDS) return;
    this.d.commands++;
    this.save();
  }
}

export const prefs = new Prefs();
