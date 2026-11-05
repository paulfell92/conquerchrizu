/**
 * Online lockstep protocol (JSON over WebSocket). Shared by the browser client
 * (src/net/networkRelay.ts) and every relay host (server/core, server/node,
 * server/cloudflare). Only commands travel; each client runs the full sim.
 *
 * Timing: 1 turn = TURN_TICKS sim ticks = TURN_MS ms. The relay emits EVERY
 * turn (empty bundles too). Commands of turn n execute at tick n * TURN_TICKS.
 * A client may only simulate tick t once it holds the bundle for turn
 * floor(t / TURN_TICKS). Commands submitted at client tick t target turn
 * >= floor(t / TURN_TICKS) + delay (delay 2..4, adaptive by ping). Commands
 * arriving after their turn was emitted are moved to the next open turn.
 *
 * URL scheme: `<relay>/lobby/new` to create, `<relay>/lobby/<CODE>` to join or
 * rejoin. The first client message must be create / join / rejoin.
 */
import type { BuildingKind, Command, GameConfig, Owner, PlayerCommand, PlayerId, TechId, UnitKind } from '../sim/types';

export const PROTOCOL_VERSION = 1;
export const TURN_TICKS = 2;
export const TURN_MS = 100;
export const HASH_EVERY_TICKS = 100;
export const MIN_DELAY_TURNS = 2;
export const MAX_DELAY_TURNS = 4;
/** Disconnect grace: the game pauses this long before the absent player forfeits. */
export const GRACE_MS = 60_000;
/** A finished room closes this long after the end. */
export const CLOSE_AFTER_END_MS = 60_000;
/** Countdown between both seats filled and turn 0. */
export const START_DELAY_MS = 3_000;

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I L O 0 1
export const CODE_LENGTH = 5;
export const ONLINE_COLORS = ['#3d7be0', '#d9483b'] as const;
export const DEFAULT_MAP = 'chrizu-tal';

export function isValidCode(code: string): boolean {
  if (typeof code !== 'string' || code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** Upper-cases and strips spaces; maps look-alikes (O→0 is not in the alphabet, so O stays invalid). */
export function normalizeCode(code: string): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** What the host picks; the relay adds the seed and the guest. */
export interface LobbyOptions {
  name?: string;
  mapId?: string;
  peaceTicks?: number;
}

// ---------------------------------------------------------------- client → server

export type ClientMsg =
  | ({ t: 'create'; v: number; simVersion: string } & LobbyOptions)
  | { t: 'join'; v: number; code: string; simVersion: string; name?: string }
  | { t: 'rejoin'; v: number; code: string; token: string }
  | { t: 'cmd'; turn: number; cmd: Command }
  | { t: 'hash'; tick: number; hash: number }
  | { t: 'over'; tick: number; winner: Owner }
  | { t: 'ping'; id: number };

// ---------------------------------------------------------------- server → client

export type EndReason = 'over' | 'abandoned' | 'closed';

export type ServerMsg =
  | { t: 'lobby'; code: string; token: string; you: PlayerId; v: number }
  | { t: 'start'; config: GameConfig; startAt: number; startIn: number; turnMs: number }
  | { t: 'turn'; n: number; cmds: PlayerCommand[] }
  /** Full history on rejoin: bundles for turns 0..turns-1 (only non-empty commands listed). */
  | { t: 'history'; turns: number; cmds: PlayerCommand[] }
  | { t: 'peer'; connected: boolean }
  | { t: 'paused'; paused: boolean; graceMs: number }
  | { t: 'desync'; tick: number }
  | { t: 'end'; reason: EndReason; winner: Owner | null; tick: number }
  | { t: 'error'; reason: string; fatal: boolean }
  | { t: 'pong'; id: number; turn: number };

export const ERR = {
  badMessage: 'Ungültige Nachricht',
  protocol: 'Protokollversion passt nicht – bitte Seite neu laden',
  simVersion: 'Spielversion unterschiedlich – bitte beide die Seite neu laden',
  notFound: 'Lobby nicht gefunden',
  full: 'Lobby ist voll',
  taken: 'Lobby-Code bereits vergeben – bitte nochmal versuchen',
  badToken: 'Sitzung abgelaufen – Wiederverbinden nicht möglich',
  closed: 'Lobby wurde geschlossen',
  replaced: 'In einem anderen Fenster wieder verbunden',
} as const;

// ---------------------------------------------------------------- command sanitising

const UNIT_KINDS: readonly string[] = ['scout', 'spear', 'archer', 'cavalry', 'sword', 'ram', 'knight'];
const BUILDING_KINDS: readonly string[] = ['towncenter', 'barracks', 'range', 'stable', 'blacksmith', 'workshop', 'tower'];
const TECH_IDS: readonly string[] = ['age2', 'age3', 'attack1', 'armor1', 'attack2'];

const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const ids = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length <= 200 && v.every(int) ? (v as number[]).slice() : null;

/**
 * Rebuild a command from untrusted JSON with only known fields. Returns null
 * for malformed input. The sim still validates game rules (affordability etc.).
 */
export function sanitizeCommand(raw: unknown): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  switch (c.t) {
    case 'move':
    case 'rally': {
      if (!int(c.x) || !int(c.y)) return null;
      if (c.t === 'rally') return int(c.building) ? { t: 'rally', building: c.building, x: c.x, y: c.y } : null;
      const s = ids(c.squads);
      return s ? { t: 'move', squads: s, x: c.x, y: c.y } : null;
    }
    case 'attack': {
      const s = ids(c.squads);
      return s && int(c.target) ? { t: 'attack', squads: s, target: c.target } : null;
    }
    case 'stop':
    case 'retreat': {
      const s = ids(c.squads);
      return s ? { t: c.t, squads: s } : null;
    }
    case 'build':
      return int(c.slot) && typeof c.kind === 'string' && BUILDING_KINDS.includes(c.kind)
        ? { t: 'build', slot: c.slot, kind: c.kind as BuildingKind }
        : null;
    case 'train':
      return int(c.building) && typeof c.unit === 'string' && UNIT_KINDS.includes(c.unit)
        ? { t: 'train', building: c.building, unit: c.unit as UnitKind }
        : null;
    case 'research':
      return int(c.building) && typeof c.tech === 'string' && TECH_IDS.includes(c.tech)
        ? { t: 'research', building: c.building, tech: c.tech as TechId }
        : null;
    case 'cancel':
      return int(c.building) ? { t: 'cancel', building: c.building } : null;
    case 'upgradePoint':
      return int(c.point) ? { t: 'upgradePoint', point: c.point } : null;
    case 'surrender':
      return { t: 'surrender' };
    default:
      return null;
  }
}

/** Parse + shape-check a client message. Returns null if unusable. */
export function parseClientMsg(data: string): ClientMsg | null {
  if (typeof data !== 'string' || data.length > 8192) return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const str = (v: unknown, max = 64) => typeof v === 'string' && v.length <= max;
  switch (o.t) {
    case 'create':
      if (!int(o.v) || !str(o.simVersion)) return null;
      return {
        t: 'create',
        v: o.v,
        simVersion: o.simVersion as string,
        name: str(o.name, 24) ? (o.name as string) : undefined,
        mapId: str(o.mapId) ? (o.mapId as string) : undefined,
        peaceTicks: int(o.peaceTicks) && o.peaceTicks >= 0 && o.peaceTicks <= 20 * 60 * 30 ? o.peaceTicks : undefined,
      };
    case 'join':
      if (!int(o.v) || !str(o.code, 16) || !str(o.simVersion)) return null;
      return {
        t: 'join',
        v: o.v,
        code: normalizeCode(o.code as string),
        simVersion: o.simVersion as string,
        name: str(o.name, 24) ? (o.name as string) : undefined,
      };
    case 'rejoin':
      if (!int(o.v) || !str(o.code, 16) || !str(o.token, 128)) return null;
      return { t: 'rejoin', v: o.v, code: normalizeCode(o.code as string), token: o.token as string };
    case 'cmd': {
      const cmd = sanitizeCommand(o.cmd);
      return int(o.turn) && cmd ? { t: 'cmd', turn: o.turn, cmd } : null;
    }
    case 'hash':
      return int(o.tick) && typeof o.hash === 'number' && Number.isFinite(o.hash)
        ? { t: 'hash', tick: o.tick, hash: o.hash }
        : null;
    case 'over':
      return int(o.tick) && (o.winner === 0 || o.winner === 1 || o.winner === -1)
        ? { t: 'over', tick: o.tick, winner: o.winner }
        : null;
    case 'ping':
      return int(o.id) ? { t: 'ping', id: o.id } : null;
    default:
      return null;
  }
}

/** Adaptive input delay in turns from a measured round trip. */
export function delayForPing(rttMs: number): number {
  if (!Number.isFinite(rttMs) || rttMs <= 0) return MIN_DELAY_TURNS;
  const d = 1 + Math.ceil(rttMs / TURN_MS);
  return Math.max(MIN_DELAY_TURNS, Math.min(MAX_DELAY_TURNS, d));
}
