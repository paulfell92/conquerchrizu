/**
 * Persistent bot state + the per-pass context shared by the three layers
 * (strategy / operations / tactics). Commands are only emitted through
 * `emit`, which enforces the command budget (cpm), checks validateCommand and
 * keeps a local resource/pop ledger so several commands in one pass don't
 * overspend.
 */
import { validateCommand } from '../sim';
import type { Command, PlayerId, Resources, Vec } from '../sim';
import type { Difficulty, Personality } from './index';
import { DIFFICULTIES, PERSONALITIES } from './personalities';
import type { DifficultyDef, PersonalityDef } from './personalities';
import { BotRng } from './rng';
import { Memory } from './view';
import { emptySinkUse } from './sinks';
import type { View } from './view';

export type Role = 'army' | 'scout' | 'retreat';
export type Stance = 'defend' | 'expand' | 'attack' | 'push';
export type ObjKind = 'capture' | 'defendPoint' | 'defendBase' | 'push' | 'hold';

export interface Objective {
  kind: ObjKind;
  pos: Vec;
  point?: number;
  score: number;
}

export interface Group {
  id: number;
  squads: number[];
  objective: Objective | null;
  since: number;
  gathering: boolean;
}

export interface BotStats {
  commands: number;
  validationFailures: number;
  rejectedBySim: number;
  budgetDenied: number;
}

export class Brain {
  readonly rng: BotRng;
  readonly diff: DifficultyDef;
  readonly pers: PersonalityDef;
  readonly memory = new Memory();
  tokens: number;
  readonly tokenCap: number;
  lastTick = -1;
  /** Phase offsets so the layers of both bots don't all run on the same tick. */
  readonly offset: number;
  openingIdx = 0;
  openingStall = 0;
  stance: Stance = 'expand';
  readonly roles = new Map<number, Role>();
  readonly retreatSince = new Map<number, number>();
  groups: Group[] = [];
  nextGroupId = 1;
  /** point id -> tick until which the point is avoided (after a lost fight). */
  readonly avoid = new Map<number, number>();
  readonly rallied = new Set<number>();
  /** Name of the investment we are currently saving for (debug/UI). */
  saving: string | null = null;
  readonly stats: BotStats = { commands: 0, validationFailures: 0, rejectedBySim: 0, budgetDenied: 0 };
  /** Set once the bot has gone on the offensive (attack/push stance). */
  firstAttackDone = false;
  rallyAllDone = false;
  /** Ticks of own squad deaths (for "hire after losses"). */
  readonly lossTicks: number[] = [];
  readonly sinkUse = emptySinkUse();

  constructor(
    readonly me: PlayerId,
    readonly difficulty: Difficulty,
    readonly personality: Personality,
    seed: number,
    /** Tutorial mode: stays on its own half, never attacks. */
    readonly passive = false,
    /** Campaign: 0.5 = cautious, 1 = default, 1.5 = reckless. */
    readonly aggression = 1,
    /** Campaign: never research beyond this age. */
    readonly maxAge: 1 | 2 | 3 = 3,
  ) {
    this.rng = new BotRng(seed * 31 + me * 7919 + 17);
    this.diff = DIFFICULTIES[difficulty];
    this.pers = PERSONALITIES[personality];
    this.tokenCap = Math.max(4, Math.round(this.diff.cpm / 6));
    this.tokens = this.tokenCap;
    this.offset = (me * 7 + this.rng.int(5)) | 0;
  }
}

/** Peace phase length in ticks (GameConfig.peaceTicks, default 0). */
export function peaceTicks(v: View): number {
  return v.state.config.peaceTicks ?? 0;
}

export function inPeace(v: View): boolean {
  return v.tick < peaceTicks(v);
}

/** May the bot take offensive actions (attack enemy squads/buildings/points, raid)? */
export function aggressionOk(b: Brain, v: View): boolean {
  if (b.passive) return false;
  // aggression scales the post-peace delay (reckless bots start sooner)
  const delay = Math.trunc(b.diff.postPeaceDelay / Math.max(0.25, b.aggression)) + (b.aggression < 1 ? Math.trunc((1 - b.aggression) * 60 * 20) : 0);
  return v.tick >= peaceTicks(v) + delay;
}

/** Multiplier on attack thresholds from BotOptions.aggression (>1 = more cautious). */
export function aggressionCaution(b: Brain): number {
  return 1 / Math.max(0.25, b.aggression);
}

/** Position is on the bot's own half of the map (closer to own TC than to the enemy's). */
export function onMyHalf(v: View, p: Vec): boolean {
  const mid = (v.myHome.x + v.foeHome.x) / 2;
  return v.myHome.x < v.foeHome.x ? p.x < mid : p.x > mid;
}

export interface Ctx {
  b: Brain;
  v: View;
  out: Command[];
  /** Resources still available this pass after emitted commands. */
  res: Resources;
  /** Pop used incl. queued, updated by emitted train commands. */
  pop: number;
  /** Extra queue items emitted this pass per building. */
  queued: Map<number, number>;
  /** Slots used by build commands this pass. */
  usedSlots: Set<number>;
  /** Squad ids already commanded this pass (ops/tactics don't double-command). */
  touched: Set<number>;
}

export function makeCtx(b: Brain, v: View): Ctx {
  return {
    b,
    v,
    out: [],
    res: { ...v.player.res },
    pop: v.player.pop,
    queued: new Map(),
    usedSlots: new Set(),
    touched: new Set(),
  };
}

/**
 * Emit a command if budget allows and the sim says it is valid.
 * `reserve`: keep this many tokens untouched (lower-priority callers).
 */
export function emit(ctx: Ctx, cmd: Command, reserve = 0): boolean {
  const b = ctx.b;
  if (b.tokens < 1 + reserve) {
    b.stats.budgetDenied++;
    return false;
  }
  const reason = validateCommand(ctx.v.state, b.me, cmd);
  if (reason !== null) {
    b.stats.validationFailures++;
    return false;
  }
  b.tokens -= 1;
  b.stats.commands++;
  ctx.out.push(cmd);
  if ('squads' in cmd) for (const id of cmd.squads) ctx.touched.add(id);
  return true;
}

export function affordable(res: Resources, cost: Resources): boolean {
  return res.food >= cost.food && res.wood >= cost.wood && res.gold >= cost.gold;
}

export function spend(res: Resources, cost: Resources): void {
  res.food -= cost.food;
  res.wood -= cost.wood;
  res.gold -= cost.gold;
}

/** Reserve (never below zero) – used when saving for an expensive item. */
export function reserve(res: Resources, cost: Resources): void {
  res.food = Math.max(0, res.food - cost.food);
  res.wood = Math.max(0, res.wood - cost.wood);
  res.gold = Math.max(0, res.gold - cost.gold);
}

export function costValue(c: Resources): number {
  return c.food + c.wood + c.gold * 1.5;
}
