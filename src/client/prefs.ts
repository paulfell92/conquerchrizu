/** Per-device settings in localStorage. Every access is guarded: storage may be blocked. */
import type { Difficulty } from '../bot';

const KEY = 'cc.prefs.v1';
export const PEACE_OPTIONS = [0, 2, 3, 5] as const; // minutes
export type PeaceMin = (typeof PEACE_OPTIONS)[number];
/** Show the "Doppeltippen = Befehl" chip until this many commands were issued. */
const HINT_COMMANDS = 10;

export type PersonalityPick = 'random' | 'rusher' | 'boomer' | 'turtle';

interface Data {
  difficulty: Difficulty;
  peaceMin: PeaceMin;
  commands: number;
  tutorialSeen: boolean;
  personality: PersonalityPick;
  followArmy: boolean;
  /** Campaign: highest unlocked mission index (0-based) and best times in ticks by mission id. */
  campaignUnlocked: number;
  campaignBest: Record<string, number>;
}

const DEFAULTS: Data = {
  difficulty: 'normal',
  peaceMin: 3,
  commands: 0,
  tutorialSeen: false,
  personality: 'random',
  followArmy: true,
  campaignUnlocked: 0,
  campaignBest: {},
};

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
        if (v.personality === 'random' || v.personality === 'rusher' || v.personality === 'boomer' || v.personality === 'turtle')
          this.d.personality = v.personality;
        if (typeof v.followArmy === 'boolean') this.d.followArmy = v.followArmy;
        if (typeof v.campaignUnlocked === 'number' && v.campaignUnlocked >= 0) this.d.campaignUnlocked = Math.floor(v.campaignUnlocked);
        if (v.campaignBest && typeof v.campaignBest === 'object') {
          for (const [k, t] of Object.entries(v.campaignBest)) if (typeof t === 'number') this.d.campaignBest[k] = t;
        }
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
  get personality() {
    return this.d.personality;
  }
  set personality(v: PersonalityPick) {
    this.d.personality = v;
    this.save();
  }
  get followArmy() {
    return this.d.followArmy;
  }
  set followArmy(v: boolean) {
    this.d.followArmy = v;
    this.save();
  }
  get campaignUnlocked() {
    return this.d.campaignUnlocked;
  }
  bestTime(id: string): number | null {
    return this.d.campaignBest[id] ?? null;
  }
  /** Record a mission win; unlocks the next one. */
  missionWon(index: number, id: string, ticks: number) {
    const b = this.d.campaignBest[id];
    if (b === undefined || ticks < b) this.d.campaignBest[id] = ticks;
    if (this.d.campaignUnlocked < index + 1) this.d.campaignUnlocked = index + 1;
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
