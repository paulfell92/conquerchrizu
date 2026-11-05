/**
 * Map definitions in TILE coordinates (integers). The sim converts a tile
 * coordinate t to milli-tiles as t * 1000 + 500 (tile center).
 * Maps are mirrored left/right: player 0 on the left, player 1 on the right.
 */
import type { PointKind } from '../sim/types';

export interface MapDef {
  id: string;
  name: string;
  w: number; // tiles
  h: number; // tiles
  /** Blocked rectangles [x, y, w, h] in tiles (water, rocks). Inclusive of x..x+w-1. */
  blocked: [number, number, number, number][];
  /** Terrain kind per blocked rect, rendering only (same order as `blocked`). */
  blockedKind: ('water' | 'rock')[];
  towncenters: [{ x: number; y: number }, { x: number; y: number }]; // tile of TC center per player
  /** Build slot offsets relative to the TC tile for player 0. Player 1 mirrors x. */
  slotOffsets: { x: number; y: number }[]; // exactly 8
  points: { kind: PointKind; name: string; x: number; y: number }[];
  /** Spawn tiles for the starting squads per player (one spear + one scout). */
  startSquads: { kind: 'spear' | 'scout'; dx: number; dy: number }[];
}

const W = 57; // odd width so x = 28 is the exact center column
const H = 36;
const mx = (x: number) => W - 1 - x; // mirror tile x

const leftPoints: { kind: PointKind; name: string; x: number; y: number }[] = [
  { kind: 'village', name: 'Nordhof', x: 11, y: 8 },
  { kind: 'forest', name: 'Südwald', x: 11, y: 28 },
  { kind: 'mine', name: 'Hausmine', x: 17, y: 18 },
  { kind: 'forest', name: 'Hügelwald', x: 21, y: 9 },
  { kind: 'village', name: 'Flussdorf', x: 21, y: 27 },
];
const rightNames = ['Ostkate', 'Kiefernhain', 'Felsmine', 'Dunkelwald', 'Mühlendorf'];

const chrizuTal: MapDef = {
  id: 'chrizu-tal',
  name: 'Chrizu-Tal',
  w: W,
  h: H,
  blocked: [
    // two lakes split the center into three lanes
    [24, 9, 9, 4],
    [24, 23, 9, 4],
    // small rock groups near each base (mirrored)
    [14, 13, 2, 2],
    [14, 21, 2, 2],
    [mx(15), 13, 2, 2],
    [mx(15), 21, 2, 2],
    // map edge rocks
    [26, 0, 5, 2],
    [26, 34, 5, 2],
  ],
  blockedKind: ['water', 'water', 'rock', 'rock', 'rock', 'rock', 'rock', 'rock'],
  towncenters: [
    { x: 6, y: 18 },
    { x: mx(6), y: 18 },
  ],
  slotOffsets: [
    { x: -3, y: -4 },
    { x: 0, y: -5 },
    { x: 3, y: -4 },
    { x: -4, y: 0 },
    { x: 4, y: 0 },
    { x: -3, y: 4 },
    { x: 0, y: 5 },
    { x: 3, y: 4 },
  ],
  points: [
    ...leftPoints,
    { kind: 'mine', name: 'Nordmine', x: 28, y: 5 },
    { kind: 'village', name: 'Chrizu', x: 28, y: 18 },
    { kind: 'mine', name: 'Südmine', x: 28, y: 31 },
    ...leftPoints.map((p, i) => ({ ...p, name: rightNames[i], x: mx(p.x) })),
  ],
  startSquads: [
    { kind: 'spear', dx: 3, dy: 2 },
    { kind: 'scout', dx: 3, dy: -2 },
  ],
};

export const MAPS: Record<string, MapDef> = { [chrizuTal.id]: chrizuTal };
