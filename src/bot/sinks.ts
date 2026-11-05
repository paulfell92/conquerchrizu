/**
 * Resource sinks added in round 3: point level 3, point towers (fortifyPoint),
 * housing techs, armor2, mercenaries (hire), rallyAll. Used per personality:
 *  - boomer: point level 3 + housing early
 *  - turtle: fortify contested/border points, towers, armor
 *  - rusher: hire after losses, housing for bigger waves
 * Easy uses them sparingly and late. Nothing offensive here, so all of it is
 * peace-safe (hire only spawns at the own TC).
 *
 * All costs are read through `sinkCost` so content names live in one place;
 * validateCommand stays the final judge (emit() checks it).
 */
import { buildingCost, techCost } from '../sim';
import type { Building, CapturePoint, Resources, TechId, UnitKind, Vec } from '../sim';
import * as content from '../content';
import { affordable, emit, onMyHalf, spend } from './brain';
import type { Ctx } from './brain';
import { dangerAt, dist, TPS } from './view';
import type { View } from './view';

const MIN = 60 * TPS;
const TILE = 1000;
const ZERO: Resources = { food: 0, wood: 0, gold: 0 };

type AnyRec = Record<string, unknown>;
const C = content as unknown as { RULES: AnyRec; UNITS: AnyRec; BUILDINGS: AnyRec; TECHS: AnyRec };

function asRes(x: unknown): Resources | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Partial<Resources>;
  if (typeof r.food !== 'number' && typeof r.wood !== 'number' && typeof r.gold !== 'number') return null;
  return { food: r.food ?? 0, wood: r.wood ?? 0, gold: r.gold ?? 0 };
}

export type SinkKind = 'upgrade3' | 'fortify' | 'housing' | 'armor2' | 'hire' | 'rallyAll';

export interface SinkUse {
  upgrade2: number;
  upgrade3: number;
  fortify: number;
  housing: number;
  armor2: number;
  hire: number;
  rallyAll: number;
}

export function emptySinkUse(): SinkUse {
  return { upgrade2: 0, upgrade3: 0, fortify: 0, housing: 0, armor2: 0, hire: 0, rallyAll: 0 };
}

/** Cost of a level 2->3 point upgrade (content name may vary; falls back to 2x level-2 cost). */
export function upgrade3Cost(): Resources {
  const R = C.RULES;
  return (
    asRes(R.pointLevel3UpgradeCost) ??
    asRes(R.pointUpgrade3Cost) ??
    asRes(R.pointUpgradeCost3) ??
    asRes((R.pointUpgradeCosts as unknown[] | undefined)?.[1]) ??
    asRes((R.pointUpgradeCost as AnyRec | undefined)?.[3]) ?? {
      food: 0,
      wood: 2 * ((R.pointUpgradeCost as Resources).wood ?? 150),
      gold: 2 * ((R.pointUpgradeCost as Resources).gold ?? 50),
    }
  );
}

export function upgrade2Cost(): Resources {
  return asRes(C.RULES.pointUpgradeCost) ?? { food: 0, wood: 150, gold: 50 };
}

export function fortifyCost(v: View): Resources {
  try {
    return buildingCost(v.state, v.me, 'pointtower');
  } catch {
    return asRes((C.BUILDINGS.pointtower as AnyRec | undefined)?.cost) ?? { food: 0, wood: 150, gold: 50 };
  }
}

export function techCostSafe(v: View, tech: TechId): Resources {
  try {
    return techCost(v.state, v.me, tech);
  } catch {
    return asRes((C.TECHS[tech] as AnyRec | undefined)?.cost) ?? { food: 200, wood: 100, gold: 100 };
  }
}

/** Gold price of hiring `unit`. */
export function hireCost(unit: UnitKind): Resources {
  const R = C.RULES;
  const u = C.UNITS[unit] as AnyRec | undefined;
  const direct = asRes(u?.hireCost) ?? asRes((R.hireCost as AnyRec | undefined)?.[unit]);
  if (direct) return direct;
  const pct = (R.hireCostPct as number | undefined) ?? (R.hireGoldPctOfCost as number | undefined) ?? 150;
  const base = (u?.cost as Resources | undefined) ?? ZERO;
  return { food: 0, wood: 0, gold: Math.trunc(((base.food + base.wood + base.gold) * pct) / 100) };
}

function techResearchBuilding(tech: TechId): string {
  const t = C.TECHS[tech] as AnyRec | undefined;
  return (t?.building as string | undefined) ?? (tech.startsWith('housing') ? 'towncenter' : 'blacksmith');
}

function techAge(tech: TechId): number {
  const t = C.TECHS[tech] as AnyRec | undefined;
  return (t?.age as number | undefined) ?? (tech === 'housing2' || tech === 'armor2' ? 2 : 1);
}

// ---------------------------------------------------------------- helpers

function has(v: View, tech: TechId): boolean {
  return v.player.techs.includes(tech);
}

function researching(v: View, tech: TechId): boolean {
  for (const b of v.myBuildings) for (const q of b.queue) if (q.item === tech) return true;
  return false;
}

function pointTowerOn(v: View, p: CapturePoint): Building | null {
  for (const b of v.myBuildings) if (b.kind === 'pointtower' && b.point === p.id) return b;
  return null;
}

function countPointTowers(v: View): number {
  let n = 0;
  for (const b of v.myBuildings) if (b.kind === 'pointtower') n++;
  return n;
}

function minutes(v: View): number {
  return v.tick / MIN;
}

// ---------------------------------------------------------------- candidates

export interface SinkCandidate {
  name: SinkKind | 'upgrade2';
  score: number;
  cost: Resources;
  run: () => boolean;
  save: boolean;
}

function tryTech(ctx: Ctx, tech: TechId, use: SinkUse, key: keyof SinkUse): boolean {
  const v = ctx.v;
  const cost = techCostSafe(v, tech);
  if (!affordable(ctx.res, cost)) return false;
  const bk = techResearchBuilding(tech);
  const b = v.myBuildings.find(
    (x) => x.kind === bk && x.buildTicksLeft <= 0 && x.queue.length + (ctx.queued.get(x.id) ?? 0) < (bk === 'towncenter' ? 2 : 1),
  );
  if (!b) return false;
  if (!emit(ctx, { t: 'research', building: b.id, tech })) return false;
  spend(ctx.res, cost);
  ctx.queued.set(b.id, (ctx.queued.get(b.id) ?? 0) + 1);
  use[key]++;
  return true;
}

/** Point the bot most wants to fortify: border/contested own points. */
export function bestFortifyPoint(v: View, passive: boolean): CapturePoint | null {
  let best: CapturePoint | null = null;
  let bestScore = 0;
  const mid = (v.myHome.x + v.foeHome.x) / 2;
  for (const p of v.points) {
    if (p.owner !== v.me || pointTowerOn(v, p)) continue;
    if (passive && !onMyHalf(v, p)) continue;
    const dMine = dist(p, v.myHome);
    const dFoe = dist(p, v.foeHome);
    if (dFoe < 12 * TILE) continue; // deep in enemy land: won't survive
    // border-ness: close to the middle; contested = recently fought over / enemy seen near
    const border = 1 / (1 + Math.abs(p.x - mid) / (8 * TILE));
    const danger = dangerAt(v, p, 9 * TILE);
    const contested = p.progress < (C.RULES.captureMax as number) || danger > 0 ? 1.5 : 1;
    const home = dMine < 9 * TILE ? 0.4 : 1; // TC already covers home points
    const level = p.level >= 2 ? 1.3 : 1;
    const score = border * contested * home * level;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function bestUpgradePoint(v: View, level: 1 | 2): CapturePoint | null {
  let best: CapturePoint | null = null;
  let bestScore = 0;
  for (const p of v.points) {
    if (p.owner !== v.me || p.level !== level) continue;
    const dMine = dist(p, v.myHome);
    const dFoe = dist(p, v.foeHome);
    // level 3 only on safe points (own half) unless a point tower guards it
    const guarded = pointTowerOn(v, p) !== null;
    if (dMine > dFoe * (guarded ? 1.2 : 1.0)) continue;
    if (dangerAt(v, p, 7 * TILE) > 0 && !guarded) continue;
    const r = (C.RULES.pointIncome as Record<string, Resources>)[p.kind];
    const value = r.food + r.wood + r.gold * 1.5;
    const score = value * (dFoe / (dMine + dFoe)) * (guarded ? 1.3 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * Returns candidates for the strategy layer's utility list. `n` applies noise.
 * `lostRecently`: squads lost in the last 60 s (rusher hires after losses).
 */
export function sinkCandidates(ctx: Ctx, n: (x: number) => number, lostRecently: number, use: SinkUse): SinkCandidate[] {
  const { b, v } = ctx;
  const out: SinkCandidate[] = [];
  const pers = b.personality;
  const easy = b.difficulty === 'easy';
  const m = minutes(v);
  const age = v.player.age;
  const peace = v.tick < (v.state.config.peaceTicks ?? 0);
  const popFull = v.player.popCap - ctx.pop <= 1;
  // easy: only late and with a damped score
  const lateGate = easy ? 10 : 0;
  const ez = easy ? 0.5 : 1;

  // --- point level 3 (needs age 2)
  if (age >= ((C.RULES.pointLevel3Age as number | undefined) ?? 2) && m >= lateGate) {
    const p = bestUpgradePoint(v, 2);
    if (p) {
      const w = pers === 'boomer' ? 1.15 : pers === 'turtle' ? 0.75 : 0.45;
      const cost = upgrade3Cost();
      out.push({
        name: 'upgrade3', score: n(w * ez), cost, save: pers === 'boomer' && !easy,
        run: () => {
          if (!affordable(ctx.res, cost)) return false;
          if (!emit(ctx, { t: 'upgradePoint', point: p.id })) return false;
          spend(ctx.res, cost);
          use.upgrade3++;
          return true;
        },
      });
    }
  }

  // --- fortify points (turtle main tool; others sparingly)
  const towerCap = pers === 'turtle' ? 4 : pers === 'boomer' ? 2 : 1;
  const fortStart = (pers === 'turtle' ? 2 : 6) + lateGate;
  const ptDef = C.BUILDINGS.pointtower as { age?: number; maxPerPlayer?: number } | undefined;
  const ptMax = Math.min(towerCap, (C.RULES.pointTowersPerPlayer as number | undefined) ?? ptDef?.maxPerPlayer ?? 4);
  if (age >= (ptDef?.age ?? 1) && countPointTowers(v) < (easy ? 1 : ptMax) && m >= fortStart) {
    const p = bestFortifyPoint(v, b.passive);
    if (p) {
      const cost = fortifyCost(v);
      const w = pers === 'turtle' ? 1.25 : pers === 'boomer' ? 0.7 : 0.4;
      out.push({
        name: 'fortify', score: n(w * ez), cost, save: pers === 'turtle' && !easy,
        run: () => {
          if (!affordable(ctx.res, cost)) return false;
          if (!emit(ctx, { t: 'fortifyPoint', point: p.id })) return false;
          spend(ctx.res, cost);
          use.fortify++;
          return true;
        },
      });
    }
  }

  // --- housing (boomer early, rusher for bigger waves, turtle when full)
  for (const tech of ['housing1', 'housing2'] as TechId[]) {
    if (has(v, tech) || researching(v, tech)) continue;
    if (techAge(tech) > age) break;
    if (tech === 'housing2' && !has(v, 'housing1')) break;
    let w = 0;
    if (pers === 'boomer') w = m >= 2 ? 1.1 : 0;
    else if (pers === 'rusher') w = popFull ? 1.2 : m >= 6 ? 0.6 : 0;
    else w = popFull ? 0.9 : 0.3;
    if (easy) w = m >= 12 && popFull ? 0.6 : 0;
    if (w > 0) {
      out.push({ name: 'housing', score: n(w), cost: techCostSafe(v, tech), save: popFull && !easy, run: () => tryTech(ctx, tech, use, 'housing') });
    }
    break;
  }

  // --- armor2 (after armor1)
  if (has(v, 'armor1') && !has(v, 'armor2') && !researching(v, 'armor2') && techAge('armor2') <= age && m >= lateGate) {
    const w = (pers === 'turtle' ? 1.0 : 0.7) * ez;
    out.push({ name: 'armor2', score: n(w), cost: techCostSafe(v, 'armor2'), save: false, run: () => tryTech(ctx, 'armor2', use, 'armor2') });
  }

  // --- hire mercenaries (instant squad at own TC, gold only, cooldown)
  const ready = (v.player.hireReadyTick ?? 0) <= v.tick;
  const hireAge = (C.RULES.hireMinAge as number | undefined) ?? 1;
  if (ready && !peace && !b.passive && age >= hireAge && ctx.pop < v.player.popCap) {
    const unit = bestHireUnit(ctx);
    if (unit) {
      const cost = hireCost(unit);
      let w = 0;
      if (pers === 'rusher') w = lostRecently >= 1 ? 1.35 : 0.3;
      else if (pers === 'turtle') w = b.stance === 'defend' ? 1.3 : 0.2;
      else w = b.stance === 'defend' ? 1.1 : 0.15;
      if (easy) w = b.stance === 'defend' && m >= lateGate ? 0.5 : 0;
      // only from surplus gold – never starve the economy for mercs
      if (w > 0 && ctx.res.gold >= cost.gold + (pers === 'rusher' ? 0 : 60)) {
        out.push({
          name: 'hire', score: n(w), cost, save: false,
          run: () => {
            if (!affordable(ctx.res, cost)) return false;
            if (!emit(ctx, { t: 'hire', unit })) return false;
            spend(ctx.res, cost);
            ctx.pop += (C.UNITS[unit] as { pop: number }).pop;
            use.hire++;
            return true;
          },
        });
      }
    }
  }
  return out;
}

/** Best unit to hire right now: counters seen, must be allowed by age. */
function bestHireUnit(ctx: Ctx): UnitKind | null {
  const { b, v } = ctx;
  const order: UnitKind[] =
    b.personality === 'rusher' ? ['knight', 'cavalry', 'sword', 'spear'] : b.personality === 'turtle' ? ['sword', 'archer', 'spear'] : ['knight', 'sword', 'archer', 'spear'];
  // seen cavalry -> spears first; seen archers -> cavalry first
  const seen = v.memory.seenKinds;
  if ((seen.cavalry ?? 0) + (seen.knight ?? 0) > (seen.archer ?? 0) + (seen.spear ?? 0)) order.unshift('spear');
  else if ((seen.archer ?? 0) > (seen.spear ?? 0) + 1) order.unshift('cavalry');
  for (const u of order) {
    const def = C.UNITS[u] as { age: number; pop: number } | undefined;
    if (!def || def.age > v.player.age) continue;
    if (ctx.pop + def.pop > v.player.popCap) continue;
    if (!affordable(ctx.res, hireCost(u))) continue;
    return u;
  }
  return null;
}

/** One rallyAll per game (after the first production building), towards the hold point. */
export function maybeRallyAll(ctx: Ctx, hold: Vec, use: SinkUse): boolean {
  const { b, v } = ctx;
  if (b.rallyAllDone) return false;
  const producers = v.myBuildings.filter((x) => x.kind !== 'towncenter' && x.kind !== 'tower' && x.kind !== 'pointtower' && x.kind !== 'blacksmith');
  if (producers.length === 0) return false;
  if (!emit(ctx, { t: 'rallyAll', x: Math.trunc(hold.x), y: Math.trunc(hold.y) }, 1)) return false;
  b.rallyAllDone = true;
  for (const p of producers) b.rallied.add(p.id);
  use.rallyAll++;
  return true;
}
