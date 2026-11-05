/**
 * Data for the CPU opponent: difficulty knobs and personality profiles.
 * Tuning lives here (not in code paths) so it can be adjusted with
 * tools/simulate.ts results.
 */
import type { BuildingKind, TechId, UnitKind } from '../sim/types';
import type { Difficulty, Personality } from './index';

export interface DifficultyDef {
  /** Ticks between tactics passes (= reaction time). */
  tacticsEvery: number;
  /** Ticks between operations passes. */
  opsEvery: number;
  /** Ticks between strategy passes. */
  strategyEvery: number;
  /** Command budget per minute (token bucket). */
  cpm: number;
  /** Multiplicative noise amplitude on utility scores (0.2 = ±20 %). */
  noise: number;
  /** How much the seen enemy composition drives unit choice (0..1). */
  counterWeight: number;
  /** Probability per pass to skip the counter logic entirely. */
  counterSkip: number;
  /** Focus fire (shared targets, weakest first) vs. nearest target. */
  focusFire: boolean;
  /** Retreat damaged squads. Probability a retreat decision is actually taken. */
  retreatChance: number;
  /** Keep fast units with the slow ones before engaging. */
  regroup: boolean;
  /** Max groups the field army is split into. */
  maxGroups: number;
  /** Production queue depth per building. */
  queueDepth: number;
  /** Multiplier on the personality's attack thresholds (>1 = more cautious). */
  attackCaution: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  easy: {
    tacticsEvery: 30, opsEvery: 40, strategyEvery: 100, cpm: 30,
    noise: 0.25, counterWeight: 0.4, counterSkip: 0.35, focusFire: false,
    retreatChance: 0.3, regroup: false, maxGroups: 1, queueDepth: 1, attackCaution: 1.25,
  },
  normal: {
    tacticsEvery: 16, opsEvery: 20, strategyEvery: 80, cpm: 60,
    noise: 0.1, counterWeight: 0.8, counterSkip: 0.1, focusFire: true,
    retreatChance: 0.8, regroup: true, maxGroups: 2, queueDepth: 1, attackCaution: 1.0,
  },
  hard: {
    tacticsEvery: 6, opsEvery: 12, strategyEvery: 60, cpm: 120,
    noise: 0.02, counterWeight: 1.0, counterSkip: 0, focusFire: true,
    retreatChance: 1, regroup: true, maxGroups: 3, queueDepth: 2, attackCaution: 0.95,
  },
};

/** One step of a scripted opening. Executed in order; each step waits until affordable. */
export type OpeningStep =
  | { b: BuildingKind }
  | { u: UnitKind }
  | { tech: TechId }
  | { upgrade: true };

export interface PersonalityDef {
  label: string;
  opening: OpeningStep[];
  /** Buildings wanted after the opening, in priority order (repeats = second copy). */
  buildPlan: { kind: BuildingKind; age: 1 | 2 | 3 }[];
  /** Base unit preference (relative weights). */
  unitWeights: Partial<Record<UnitKind, number>>;
  /** Scouts kept alive in the early game (before minute 6). */
  scouts: number;
  /** Desired towers. */
  towers: number;
  /** Utility weights for the strategy layer. */
  ageUpWeight: number;
  upgradeWeight: number;
  techWeight: number;
  /** Army pop to have before investing in age-ups. */
  armyBeforeAge2: number;
  armyBeforeAge3: number;
  /** Strength ratio (own / estimated enemy) to go and take enemy points. */
  attackRatio: number;
  /** Strength ratio to push the enemy town center. */
  pushRatio: number;
  /** Max rams in the army. */
  rams: number;
  /** Extra value for the center points (rusher pressure). */
  centerBias: number;
}

export const PERSONALITIES: Record<Personality, PersonalityDef> = {
  rusher: {
    label: 'Rusher',
    opening: [{ u: 'scout' }, { b: 'barracks' }, { u: 'spear' }, { b: 'stable' }, { u: 'spear' }, { u: 'cavalry' }],
    buildPlan: [
      { kind: 'barracks', age: 1 }, { kind: 'stable', age: 1 }, { kind: 'range', age: 1 },
      { kind: 'blacksmith', age: 1 }, { kind: 'workshop', age: 2 }, { kind: 'barracks', age: 2 },
      { kind: 'stable', age: 2 }, { kind: 'range', age: 3 },
    ],
    unitWeights: { spear: 1.0, cavalry: 1.3, archer: 0.8, sword: 1.2, knight: 1.4 },
    scouts: 2, towers: 0,
    ageUpWeight: 0.8, upgradeWeight: 0.5, techWeight: 0.8,
    armyBeforeAge2: 7, armyBeforeAge3: 10,
    attackRatio: 0.9, pushRatio: 1.5, rams: 2, centerBias: 0.6,
  },
  boomer: {
    label: 'Boomer',
    opening: [{ u: 'scout' }, { b: 'barracks' }, { u: 'spear' }, { b: 'range' }, { u: 'archer' }, { u: 'spear' }, { upgrade: true }, { b: 'blacksmith' }],
    buildPlan: [
      { kind: 'barracks', age: 1 }, { kind: 'range', age: 1 }, { kind: 'blacksmith', age: 1 },
      { kind: 'stable', age: 2 }, { kind: 'workshop', age: 2 }, { kind: 'stable', age: 3 },
      { kind: 'barracks', age: 3 }, { kind: 'tower', age: 2 },
    ],
    unitWeights: { spear: 0.9, archer: 1.1, cavalry: 1.0, sword: 1.2, knight: 1.6 },
    scouts: 2, towers: 1,
    ageUpWeight: 1.6, upgradeWeight: 1.4, techWeight: 1.2,
    armyBeforeAge2: 5, armyBeforeAge3: 8,
    attackRatio: 1.1, pushRatio: 1.6, rams: 2, centerBias: 0.3,
  },
  turtle: {
    label: 'Turtle',
    opening: [{ u: 'scout' }, { b: 'barracks' }, { u: 'spear' }, { u: 'spear' }, { b: 'range' }, { u: 'archer' }, { u: 'spear' }, { b: 'tower' }],
    buildPlan: [
      { kind: 'barracks', age: 1 }, { kind: 'range', age: 1 }, { kind: 'tower', age: 1 },
      { kind: 'blacksmith', age: 1 }, { kind: 'tower', age: 2 }, { kind: 'stable', age: 2 },
      { kind: 'workshop', age: 2 }, { kind: 'tower', age: 2 },
    ],
    unitWeights: { spear: 1.1, archer: 1.3, cavalry: 0.8, sword: 1.2, knight: 1.3 },
    scouts: 2, towers: 3,
    ageUpWeight: 1.1, upgradeWeight: 1.0, techWeight: 1.4,
    armyBeforeAge2: 5, armyBeforeAge3: 8,
    attackRatio: 1.15, pushRatio: 1.7, rams: 1, centerBias: 0.3,
  },
};

export const PERSONALITY_LIST: Personality[] = ['rusher', 'boomer', 'turtle'];
