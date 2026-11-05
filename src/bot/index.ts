/**
 * Conquer Chrizu – CPU opponent public API.
 *
 * The bot is "a player without hands": it reads the GameState, but may only
 * use information its player could see (own entities, anything on tiles
 * visible per computeVisibility, public info like point owners and VP).
 * It never mutates the state; it returns Commands that the caller submits
 * through the relay, exactly like human input.
 *
 * Layers (see strategy.ts / operations.ts / tactics.ts):
 *  - strategy   every 3–5 s: build order, investments, unit mix, stance
 *  - operations ~1 s: army groups, objectives via influence, scouts, rams
 *  - tactics    every few ticks (reaction time): focus fire, retreat
 * Difficulty scales reaction time, command budget (cpm) and decision noise.
 */
import type { Command, GameState, PlayerId } from '../sim';
import { Brain, makeCtx } from './brain';
import type { BotStats, Stance } from './brain';
import { runOperations } from './operations';
import { PERSONALITIES, PERSONALITY_LIST } from './personalities';
import { hashSeed } from './rng';
import { runStrategy } from './strategy';
import { runTactics } from './tactics';
import { buildView } from './view';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Personality = 'rusher' | 'boomer' | 'turtle';

export interface BotOptions {
  player: PlayerId;
  difficulty: Difficulty;
  /** Omitted = picked from `seed`. */
  personality?: Personality;
  /** Seeds the bot's own RNG (not the sim RNG) so bot-vs-bot runs are reproducible. */
  seed: number;
}

/** Deterministic personality for a seed (used when BotOptions.personality is omitted). */
export function personalityFromSeed(seed: number): Personality {
  return PERSONALITY_LIST[hashSeed(seed) % PERSONALITY_LIST.length];
}

export class Bot {
  private readonly brain: Brain;
  private readonly _personality: Personality;

  constructor(readonly options: BotOptions) {
    this._personality = options.personality ?? personalityFromSeed(options.seed);
    this.brain = new Brain(options.player, options.difficulty, this._personality, options.seed);
  }

  /** Called once per sim tick, after step(). Returns commands to submit now (usually []). */
  update(state: Readonly<GameState>): Command[] {
    const s = state as GameState; // read-only use; never mutated
    if (s.winner !== null) return [];
    const b = this.brain;
    const tick = s.tick;
    // command budget: token bucket refilled per elapsed tick
    const elapsed = b.lastTick < 0 ? 1 : Math.max(0, tick - b.lastTick);
    b.lastTick = tick;
    b.tokens = Math.min(b.tokenCap, b.tokens + (elapsed * b.diff.cpm) / (60 * 20));
    for (const e of s.events) if (e.t === 'rejected' && e.owner === b.me) b.stats.rejectedBySim++;

    const t = tick + b.offset;
    const doTactics = t % b.diff.tacticsEvery === 0;
    const doOps = t % b.diff.opsEvery === 0;
    const doStrategy = (t + 3) % b.diff.strategyEvery === 0 || tick === 1;
    if (!doTactics && !doOps && !doStrategy) {
      // Still update memory cheaply? Memory only matters when deciding, so no.
      return [];
    }
    const view = buildView(s, b.me, b.memory);
    const ctx = makeCtx(b, view);
    // Strategy first so production isn't starved by unit micro; tactics before
    // operations so reactions win over re-positioning.
    if (doStrategy) runStrategy(ctx);
    if (doTactics) runTactics(ctx);
    if (doOps) runOperations(ctx);
    return ctx.out;
  }

  /** Human-readable personality for UI ("Rusher", "Boomer", "Turtle"). */
  get personality(): Personality {
    return this._personality;
  }

  get personalityLabel(): string {
    return PERSONALITIES[this._personality].label;
  }

  /** Debug info for tools/UI. */
  get debug(): { stance: Stance; saving: string | null; stats: BotStats; groups: number } {
    const b = this.brain;
    return { stance: b.stance, saving: b.saving, stats: { ...b.stats }, groups: b.groups.length };
  }
}
