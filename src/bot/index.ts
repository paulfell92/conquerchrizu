/**
 * Conquer Chrizu – CPU opponent public API.
 * STATUS: contract stub – the bot agent implements it.
 *
 * The bot is "a player without hands": it reads the GameState, but may only
 * use information its player could see (own entities, anything on tiles
 * visible per computeVisibility, public info like point owners and VP).
 * It never mutates the state; it returns Commands that the caller submits
 * through the relay, exactly like human input.
 */
import type { Command, GameState, PlayerId } from '../sim';

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

export class Bot {
  constructor(readonly options: BotOptions) {}

  /** Called once per sim tick, after step(). Returns commands to submit now (usually []). */
  update(state: Readonly<GameState>): Command[] {
    return [];
  }

  /** Human-readable personality for UI ("Rusher", "Boomer", "Turtle"). */
  get personality(): Personality {
    return this.options.personality ?? 'boomer';
  }
}
