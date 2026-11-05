/**
 * Client-side view of the sim API. Uses the real sim (src/sim) when it works;
 * falls back to the hand-built fixture (dev/fixture.ts) while the sim is still
 * a stub, or when forced with ?fixture=1.
 */
import * as sim from '../sim';
import type {
  Building,
  BuildingKind,
  Command,
  GameConfig,
  GameState,
  PlayerCommand,
  PlayerId,
  Resources,
  Squad,
  TechId,
  UnitKind,
  Vec,
} from '../sim/types';
import { BUILDINGS, TECHS, UNITS, RULES } from '../content';
import { COMMAND_DELAY_TICKS } from '../sim/types';
import { LocalRelay, type Relay } from '../net/localRelay';
import * as fx from './dev/fixture';

export interface SimApi {
  readonly real: boolean;
  createGame(config: GameConfig): GameState;
  makeRelay(state: GameState): Relay;
  validateCommand(state: GameState, player: PlayerId, cmd: Command): string | null;
  slots(state: GameState, player: PlayerId): { slot: number; pos: Vec; building: Building | null }[];
  townCenter(state: GameState, player: PlayerId): Building | null;
  entity(state: GameState, id: number): Squad | Building | null;
  computeVisibility(state: GameState, player: PlayerId): number[];
  unitCost(state: GameState, player: PlayerId, kind: UnitKind): Resources;
  buildingCost(state: GameState, player: PlayerId, kind: BuildingKind): Resources;
  techCost(state: GameState, player: PlayerId, tech: TechId): Resources;
  isPeace(state: GameState): boolean;
  peaceTicksLeft(state: GameState): number;
}

const peaceLeftLocal = (s: GameState) => Math.max(0, (s.config.peaceTicks ?? 0) - s.tick);

const realApi: SimApi = {
  real: true,
  createGame: sim.createGame,
  makeRelay: (s) => new LocalRelay(s),
  validateCommand: sim.validateCommand,
  slots: sim.slots,
  townCenter: sim.townCenter,
  entity: sim.entity,
  computeVisibility: sim.computeVisibility,
  unitCost: sim.unitCost,
  buildingCost: sim.buildingCost,
  techCost: sim.techCost,
  isPeace: (s) => ((sim as { isPeace?: (s: GameState) => boolean }).isPeace ?? ((x: GameState) => peaceLeftLocal(x) > 0))(s),
  peaceTicksLeft: (s) => ((sim as { peaceTicksLeft?: (s: GameState) => number }).peaceTicksLeft ?? peaceLeftLocal)(s),
};

/** Relay with the same contract as LocalRelay but stepping the fixture sim. */
class FixtureRelay implements Relay {
  readonly log: PlayerCommand[] = [];
  private pending: PlayerCommand[] = [];
  constructor(readonly state: GameState) {}
  submit(player: PlayerId, cmd: Command): void {
    if (this.state.winner !== null) return;
    const pc = { player, tick: this.state.tick + COMMAND_DELAY_TICKS, cmd };
    this.pending.push(pc);
    this.log.push(pc);
  }
  advance(): boolean {
    if (this.state.winner !== null) return false;
    const now = this.state.tick;
    const due = this.pending.filter((c) => c.tick <= now).sort((a, b) => a.player - b.player);
    this.pending = this.pending.filter((c) => c.tick > now);
    fx.fixtureStep(this.state, due);
    return true;
  }
}

const fixtureApi: SimApi = {
  real: false,
  createGame: (c) => fx.createFixture(c, new URLSearchParams(location.search).get('fixture') === 'demo'),
  makeRelay: (s) => new FixtureRelay(s),
  validateCommand: fx.fixtureValidate,
  slots: fx.fixtureSlots,
  townCenter: fx.fixtureTownCenter,
  entity: fx.fixtureEntity,
  computeVisibility: fx.fixtureVisibility,
  unitCost: (_s, _p, k) => UNITS[k].cost,
  buildingCost: (_s, _p, k) => BUILDINGS[k].cost,
  techCost: (_s, _p, t) => TECHS[t].cost,
  isPeace: (s) => peaceLeftLocal(s) > 0,
  peaceTicksLeft: peaceLeftLocal,
};

let chosen: SimApi | null = null;

/** Probe once: does the real sim run? */
export function getApi(): SimApi {
  if (chosen) return chosen;
  const q = new URLSearchParams(location.search);
  if (q.has('fixture')) return (chosen = fixtureApi);
  try {
    const s = sim.createGame({
      seed: 1,
      mapId: 'chrizu-tal',
      players: [
        { name: 'a', color: '#000000', isBot: false },
        { name: 'b', color: '#000000', isBot: true },
      ],
    });
    sim.step(s, []);
    sim.computeVisibility(s, 0);
    sim.slots(s, 0);
    chosen = realApi;
  } catch (e) {
    console.info('[client] Sim noch nicht bereit – nutze Fixture.', (e as Error).message);
    chosen = fixtureApi;
  }
  return chosen;
}

export { RULES };
