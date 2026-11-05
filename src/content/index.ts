/**
 * Conquer Chrizu – game data. Balancing lives here, not in code.
 * All numbers are integers. Distances in milli-tiles, times in ticks (20/s),
 * speeds in milli-tiles per tick, multipliers in percent (100 = neutral).
 * Starting values; the integration step tunes them with bot-vs-bot runs.
 */
import type { Age, BuildingKind, PointKind, Resources, TechId, UnitKind } from '../sim/types';

const S = 20; // ticks per second

// ---------------------------------------------------------------- rules

export const RULES = {
  startRes: { food: 300, wood: 250, gold: 100 } as Resources,
  vpStart: 1000,
  /** Every second the side holding fewer points loses (diff * vpDrainPerPoint) VP. */
  vpDrainPerPoint: 1,
  vpDrainDoubleAfterTicks: 18 * 60 * S, // from 18:00 the drain doubles
  vpLossPerSquadDeath: 10,
  hardCapTicks: 25 * 60 * S, // at 25:00 the side with more VP wins (equal = draw)
  popCap: 12, // squads (pop units) per player
  captureMax: 100,
  /** Progress per second per capturing squad (max 3 squads count). Contested = no progress. */
  captureRatePerSquad: 6,
  captureRadius: 2500,
  /** Income is paid once per second. */
  incomeIntervalTicks: S,
  townCenterIncome: { food: 2, wood: 2, gold: 1 } as Resources,
  pointIncome: {
    village: { food: 4, wood: 0, gold: 0 },
    forest: { food: 0, wood: 4, gold: 0 },
    mine: { food: 0, wood: 0, gold: 3 },
  } as Record<PointKind, Resources>,
  pointLevel2IncomePct: 150,
  pointUpgradeCost: { food: 0, wood: 150, gold: 50 } as Resources,
  /** Own squads near own TC or on own points heal when out of combat. */
  healPctPerSecond: 2,
  healOutOfCombatTicks: 5 * S,
  healRadius: 3500,
  defenderDamageTakenPct: 85, // squads standing on own capture point take 85 % damage
  bountyGoldPctOfCost: 20, // killer receives 20 % of the dead squad's total cost as gold
  queueMax: 5,
  squadRadius: 600, // collision / body radius of a squad
  buildingRadius: 1100,
  townCenterRadius: 1600,
};

// ---------------------------------------------------------------- units

export interface UnitDef {
  kind: UnitKind;
  name: string; // German UI name
  short: string; // 2-3 letter label for compact UI
  building: BuildingKind;
  age: Age;
  cost: Resources;
  trainTicks: number;
  members: number;
  hpPerMember: number;
  dmgPerMember: number; // per attack, per living member
  range: number; // milli-tiles, edge to edge (subtract radii)
  cooldownTicks: number;
  speed: number; // milli-tiles per tick
  sight: number; // milli-tiles
  pop: number;
  ranged: boolean;
  /** Damage multiplier in percent against a target unit kind or 'building'. Default 100. */
  bonus: Partial<Record<UnitKind | 'building', number>>;
  description: string;
}

export const UNITS: Record<UnitKind, UnitDef> = {
  scout: {
    kind: 'scout', name: 'Späher', short: 'Sp', building: 'towncenter', age: 1,
    cost: { food: 40, wood: 0, gold: 0 }, trainTicks: 8 * S,
    members: 2, hpPerMember: 45, dmgPerMember: 3, range: 300, cooldownTicks: 20,
    speed: 180, sight: 9000, pop: 1, ranged: false,
    bonus: { building: 30 },
    description: 'Schnell, sieht weit. Gut zum Erobern leerer Punkte.',
  },
  spear: {
    kind: 'spear', name: 'Speerträger', short: 'Spe', building: 'barracks', age: 1,
    cost: { food: 60, wood: 30, gold: 0 }, trainTicks: 12 * S,
    members: 6, hpPerMember: 45, dmgPerMember: 3, range: 300, cooldownTicks: 24,
    speed: 80, sight: 6000, pop: 1, ranged: false,
    bonus: { cavalry: 250, knight: 250, scout: 200, building: 60 },
    description: 'Billig. Schlägt Reiter.',
  },
  archer: {
    kind: 'archer', name: 'Bogenschützen', short: 'Bo', building: 'range', age: 1,
    cost: { food: 40, wood: 60, gold: 0 }, trainTicks: 14 * S,
    members: 5, hpPerMember: 35, dmgPerMember: 3, range: 5000, cooldownTicks: 30,
    speed: 75, sight: 7000, pop: 1, ranged: true,
    bonus: { spear: 200, sword: 130, ram: 40, building: 30 },
    description: 'Fernkampf. Schlägt Speerträger.',
  },
  cavalry: {
    kind: 'cavalry', name: 'Reiter', short: 'Re', building: 'stable', age: 1,
    cost: { food: 80, wood: 0, gold: 40 }, trainTicks: 16 * S,
    members: 4, hpPerMember: 80, dmgPerMember: 5, range: 300, cooldownTicks: 24,
    speed: 150, sight: 7000, pop: 1, ranged: false,
    bonus: { archer: 200, ram: 200, building: 50 },
    description: 'Schnell und stark. Schlägt Bogenschützen.',
  },
  sword: {
    kind: 'sword', name: 'Schwertkämpfer', short: 'Sw', building: 'barracks', age: 2,
    cost: { food: 70, wood: 0, gold: 40 }, trainTicks: 14 * S,
    members: 6, hpPerMember: 60, dmgPerMember: 5, range: 300, cooldownTicks: 24,
    speed: 80, sight: 6000, pop: 1, ranged: false,
    bonus: { spear: 160, building: 80 },
    description: 'Allrounder. Stark gegen Speerträger.',
  },
  ram: {
    kind: 'ram', name: 'Ramme', short: 'Ra', building: 'workshop', age: 2,
    cost: { food: 0, wood: 160, gold: 60 }, trainTicks: 20 * S,
    members: 1, hpPerMember: 500, dmgPerMember: 50, range: 300, cooldownTicks: 50,
    speed: 50, sight: 4000, pop: 2, ranged: false,
    bonus: { building: 400, scout: 10, spear: 10, archer: 10, cavalry: 10, sword: 10, knight: 10, ram: 10 },
    description: 'Zerstört Gebäude. Wehrlos gegen Einheiten.',
  },
  knight: {
    kind: 'knight', name: 'Ritter', short: 'Ri', building: 'stable', age: 3,
    cost: { food: 100, wood: 0, gold: 90 }, trainTicks: 20 * S,
    members: 4, hpPerMember: 140, dmgPerMember: 9, range: 300, cooldownTicks: 24,
    speed: 130, sight: 7000, pop: 1, ranged: false,
    bonus: { archer: 180, sword: 120, building: 70 },
    description: 'Schwere Reiterei des Imperiums.',
  },
};

// ---------------------------------------------------------------- buildings

export interface BuildingDef {
  kind: BuildingKind;
  name: string;
  short: string;
  age: Age;
  cost: Resources;
  buildTicks: number;
  hp: number;
  trains: UnitKind[];
  researches: TechId[];
  /** Ranged attack (towers, town center). 0 = no attack. */
  dmg: number;
  range: number;
  cooldownTicks: number;
  sight: number;
  maxPerPlayer: number;
  description: string;
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  towncenter: {
    kind: 'towncenter', name: 'Dorfzentrum', short: 'DZ', age: 1,
    cost: { food: 0, wood: 0, gold: 0 }, buildTicks: 0, hp: 3000,
    trains: ['scout'], researches: ['age2', 'age3'],
    dmg: 12, range: 6000, cooldownTicks: 30, sight: 8000, maxPerPlayer: 1,
    description: 'Herz der Basis. Fällt es, ist das Spiel verloren.',
  },
  barracks: {
    kind: 'barracks', name: 'Kaserne', short: 'Ka', age: 1,
    cost: { food: 0, wood: 120, gold: 0 }, buildTicks: 15 * S, hp: 1200,
    trains: ['spear', 'sword'], researches: [],
    dmg: 0, range: 0, cooldownTicks: 0, sight: 5000, maxPerPlayer: 2,
    description: 'Bildet Speerträger und Schwertkämpfer aus.',
  },
  range: {
    kind: 'range', name: 'Schießplatz', short: 'Sch', age: 1,
    cost: { food: 0, wood: 150, gold: 0 }, buildTicks: 15 * S, hp: 1000,
    trains: ['archer'], researches: [],
    dmg: 0, range: 0, cooldownTicks: 0, sight: 5000, maxPerPlayer: 2,
    description: 'Bildet Bogenschützen aus.',
  },
  stable: {
    kind: 'stable', name: 'Stall', short: 'St', age: 1,
    cost: { food: 0, wood: 150, gold: 50 }, buildTicks: 18 * S, hp: 1100,
    trains: ['cavalry', 'knight'], researches: [],
    dmg: 0, range: 0, cooldownTicks: 0, sight: 5000, maxPerPlayer: 2,
    description: 'Bildet Reiter und Ritter aus.',
  },
  blacksmith: {
    kind: 'blacksmith', name: 'Schmiede', short: 'Sm', age: 1,
    cost: { food: 0, wood: 150, gold: 0 }, buildTicks: 15 * S, hp: 1000,
    trains: [], researches: ['attack1', 'armor1', 'attack2'],
    dmg: 0, range: 0, cooldownTicks: 0, sight: 5000, maxPerPlayer: 1,
    description: 'Verbessert Angriff und Rüstung.',
  },
  workshop: {
    kind: 'workshop', name: 'Werkstatt', short: 'We', age: 2,
    cost: { food: 0, wood: 200, gold: 50 }, buildTicks: 20 * S, hp: 1000,
    trains: ['ram'], researches: [],
    dmg: 0, range: 0, cooldownTicks: 0, sight: 5000, maxPerPlayer: 1,
    description: 'Baut Rammen.',
  },
  tower: {
    kind: 'tower', name: 'Turm', short: 'Tu', age: 1,
    cost: { food: 0, wood: 125, gold: 25 }, buildTicks: 20 * S, hp: 1500,
    trains: [], researches: [],
    dmg: 10, range: 6500, cooldownTicks: 24, sight: 8000, maxPerPlayer: 3,
    description: 'Verteidigt die Basis mit Pfeilen.',
  },
};

// ---------------------------------------------------------------- techs

export interface TechDef {
  id: TechId;
  name: string;
  building: BuildingKind;
  age: Age; // minimum age to start research
  cost: Resources;
  researchTicks: number;
  /** For age techs: buildings (non-TC, completed) the player must own first. */
  requiresBuildings: number;
  /** Effects (percent): applied to the player's squads, including existing ones. */
  dmgPct?: number; // +X % damage
  dmgTakenPct?: number; // -X % damage taken
  description: string;
}

export const TECHS: Record<TechId, TechDef> = {
  age2: {
    id: 'age2', name: 'Burgzeitalter', building: 'towncenter', age: 1,
    cost: { food: 400, wood: 0, gold: 200 }, researchTicks: 40 * S, requiresBuildings: 2,
    description: 'Schaltet Schwertkämpfer, Rammen, Werkstatt und Rüstung frei.',
  },
  age3: {
    id: 'age3', name: 'Imperiumszeitalter', building: 'towncenter', age: 2,
    cost: { food: 800, wood: 0, gold: 500 }, researchTicks: 60 * S, requiresBuildings: 3,
    description: 'Schaltet Ritter und Angriff II frei.',
  },
  attack1: {
    id: 'attack1', name: 'Geschmiedete Klingen', building: 'blacksmith', age: 1,
    cost: { food: 150, wood: 0, gold: 75 }, researchTicks: 30 * S, requiresBuildings: 0,
    dmgPct: 15, description: '+15 % Schaden für alle Trupps.',
  },
  armor1: {
    id: 'armor1', name: 'Kettenhemden', building: 'blacksmith', age: 2,
    cost: { food: 200, wood: 0, gold: 125 }, researchTicks: 35 * S, requiresBuildings: 0,
    dmgTakenPct: 15, description: '−15 % erlittener Schaden für alle Trupps.',
  },
  attack2: {
    id: 'attack2', name: 'Gehärteter Stahl', building: 'blacksmith', age: 3,
    cost: { food: 300, wood: 0, gold: 200 }, researchTicks: 40 * S, requiresBuildings: 0,
    dmgPct: 15, description: 'Weitere +15 % Schaden.',
  },
};

export const AGE_NAMES: Record<Age, string> = { 1: 'Dorfzeitalter', 2: 'Burgzeitalter', 3: 'Imperiumszeitalter' };
export const POINT_NAMES: Record<PointKind, string> = { village: 'Dorf', forest: 'Wald', mine: 'Mine' };
export const RESOURCE_NAMES: Record<keyof Resources, string> = { food: 'Nahrung', wood: 'Holz', gold: 'Gold' };

export { MAPS } from './maps';
export type { MapDef } from './maps';
