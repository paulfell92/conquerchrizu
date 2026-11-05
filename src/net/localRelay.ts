/**
 * Local relay: the offline stand-in for the multiplayer relay server.
 * Every command – from the human, from a bot – goes through here and is
 * scheduled COMMAND_DELAY_TICKS in the future, exactly like lockstep online.
 * A future NetworkRelay implements the same Relay interface over WebSocket.
 */
import { COMMAND_DELAY_TICKS, step, hashState } from '../sim';
import type { Command, GameState, PlayerCommand, PlayerId } from '../sim';

export interface Relay {
  readonly state: GameState;
  /** Queue a command from a local player; it executes at state.tick + delay. */
  submit(player: PlayerId, cmd: Command): void;
  /** Run one sim tick if allowed (online: only when the turn bundle arrived). Returns false if blocked. */
  advance(): boolean;
  /** Full command log for replays. */
  readonly log: PlayerCommand[];
}

export class LocalRelay implements Relay {
  readonly log: PlayerCommand[] = [];
  private pending: PlayerCommand[] = [];
  /** Hash every N ticks, kept for desync tooling / replay verification. */
  readonly hashes: { tick: number; hash: number }[] = [];

  constructor(readonly state: GameState, private hashEvery = 100) {}

  submit(player: PlayerId, cmd: Command): void {
    if (this.state.winner !== null) return;
    const pc: PlayerCommand = { player, tick: this.state.tick + COMMAND_DELAY_TICKS, cmd };
    this.pending.push(pc);
    this.log.push(pc);
  }

  advance(): boolean {
    if (this.state.winner !== null) return false;
    const now = this.state.tick;
    const due = this.pending.filter((c) => c.tick === now);
    // stable order: player 0 first, then player 1, submission order within a player
    due.sort((a, b) => a.player - b.player);
    this.pending = this.pending.filter((c) => c.tick > now);
    step(this.state, due);
    if (this.state.tick % this.hashEvery === 0) {
      this.hashes.push({ tick: this.state.tick, hash: hashState(this.state) });
    }
    return true;
  }
}
