/**
 * Strategy layer (every 3–5 s): opening build order from personality data,
 * then utility-scored investments – buildings, age-ups, research, point
 * upgrades, unit production with counters to what the bot has SEEN – and the
 * overall stance (defend / expand / attack / push).
 */
import { slots } from '../sim';
import type { Building, BuildingKind, Resources, TechId, UnitKind } from '../sim';
import { BUILDINGS, RULES, TECHS, UNITS } from '../content';
import { affordable, aggressionOk, costValue, emit, inPeace, peaceTicks, reserve, spend } from './brain';
import type { Ctx } from './brain';
import type { OpeningStep } from './personalities';
import { basePower, believedEnemies, counterFactor, dangerAt, dist, enemyPowerEstimate, matchupPower, TPS } from './view';
import type { View } from './view';

const MIN = 60 * TPS;

// ---------------------------------------------------------------- helpers

export function completed(v: View, kind?: BuildingKind): Building[] {
  return v.myBuildings.filter((b) => b.buildTicksLeft <= 0 && (kind === undefined || b.kind === kind));
}

function countKind(v: View, kind: BuildingKind): number {
  let n = 0;
  for (const b of v.myBuildings) if (b.kind === kind) n++;
  return n;
}

function nonTcCompleted(v: View): number {
  let n = 0;
  for (const b of v.myBuildings) if (b.kind !== 'towncenter' && b.buildTicksLeft <= 0) n++;
  return n;
}

function nonTcTotal(v: View): number {
  let n = 0;
  for (const b of v.myBuildings) if (b.kind !== 'towncenter') n++;
  return n;
}

export function armySquads(v: View) {
  return v.mySquads.filter((s) => s.kind !== 'scout' && s.kind !== 'ram');
}

function queueLen(ctx: Ctx, b: Building): number {
  return b.queue.length + (ctx.queued.get(b.id) ?? 0);
}

function researching(v: View, tech: TechId): boolean {
  for (const b of v.myBuildings) for (const q of b.queue) if (q.item === tech) return true;
  return false;
}

function hasTech(v: View, tech: TechId): boolean {
  return v.player.techs.includes(tech);
}

/** Pick a free slot: towers face the enemy, everything else sits behind the TC. */
function pickSlot(ctx: Ctx, kind: BuildingKind): number | null {
  const v = ctx.v;
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const s of slots(v.state, v.me)) {
    if (s.building || ctx.usedSlots.has(s.slot)) continue;
    const d = dist(s.pos, v.foeHome);
    const score = kind === 'tower' ? -d : d;
    if (score > bestScore) {
      bestScore = score;
      best = s.slot;
    }
  }
  return best;
}

function tryBuild(ctx: Ctx, kind: BuildingKind): boolean {
  const cost = BUILDINGS[kind].cost;
  if (!affordable(ctx.res, cost)) return false;
  if (countKind(ctx.v, kind) >= BUILDINGS[kind].maxPerPlayer) return false;
  if (BUILDINGS[kind].age > ctx.v.player.age) return false;
  const slot = pickSlot(ctx, kind);
  if (slot === null) return false;
  if (!emit(ctx, { t: 'build', slot, kind })) return false;
  ctx.usedSlots.add(slot);
  spend(ctx.res, cost);
  return true;
}

function floating(ctx: Ctx): boolean {
  return ctx.res.food + ctx.res.wood + ctx.res.gold > 900;
}

function producers(ctx: Ctx, unit: UnitKind): Building[] {
  const bk = UNITS[unit].building;
  const depth = ctx.b.diff.queueDepth + (floating(ctx) ? 1 : 0);
  return completed(ctx.v, bk)
    .filter((b) => queueLen(ctx, b) < depth)
    .sort((a, c) => queueLen(ctx, a) - queueLen(ctx, c) || a.id - c.id);
}

function tryTrain(ctx: Ctx, unit: UnitKind, at?: Building): boolean {
  const def = UNITS[unit];
  if (def.age > ctx.v.player.age) return false;
  if (ctx.pop + def.pop > ctx.v.player.popCap) return false;
  if (!affordable(ctx.res, def.cost)) return false;
  const b = at ?? producers(ctx, unit)[0];
  if (!b) return false;
  if (!emit(ctx, { t: 'train', building: b.id, unit })) return false;
  spend(ctx.res, def.cost);
  ctx.pop += def.pop;
  ctx.queued.set(b.id, (ctx.queued.get(b.id) ?? 0) + 1);
  if (!ctx.b.rallied.has(b.id)) {
    // Rally just in front of the base, towards the map center.
    const v = ctx.v;
    const x = Math.trunc(v.myHome.x + (v.foeHome.x - v.myHome.x) * 0.18);
    if (emit(ctx, { t: 'rally', building: b.id, x, y: v.myHome.y + (b.y > v.myHome.y ? 1500 : -1500) }, 1)) {
      ctx.b.rallied.add(b.id);
    }
  }
  return true;
}

function tryResearch(ctx: Ctx, tech: TechId): boolean {
  const def = TECHS[tech];
  if (!affordable(ctx.res, def.cost)) return false;
  const b = completed(ctx.v, def.building).find((x) => queueLen(ctx, x) === 0 || (def.building === 'towncenter' && queueLen(ctx, x) < 2));
  if (!b) return false;
  if (!emit(ctx, { t: 'research', building: b.id, tech })) return false;
  spend(ctx.res, def.cost);
  ctx.queued.set(b.id, (ctx.queued.get(b.id) ?? 0) + 1);
  return true;
}

/** Point income value per second in "food-equivalent" units. */
export function pointIncomeValue(kind: 'village' | 'forest' | 'mine'): number {
  const r = RULES.pointIncome[kind];
  return r.food + r.wood + r.gold * 1.5;
}

function bestUpgradePoint(ctx: Ctx): number | null {
  const v = ctx.v;
  let best: number | null = null;
  let bestScore = 0;
  for (const p of v.points) {
    if (p.owner !== v.me || p.level !== 1) continue;
    const dMine = dist(p, v.myHome);
    const dFoe = dist(p, v.foeHome);
    if (dMine > dFoe * 1.05) continue; // no frontline upgrades
    if (dangerAt(v, p, 7000) > 0) continue;
    const score = pointIncomeValue(p.kind) * (dFoe / (dMine + dFoe));
    if (score > bestScore) {
      bestScore = score;
      best = p.id;
    }
  }
  return best;
}

function tryUpgrade(ctx: Ctx): boolean {
  const cost = RULES.pointUpgradeCost;
  if (!affordable(ctx.res, cost)) return false;
  const p = bestUpgradePoint(ctx);
  if (p === null) return false;
  if (!emit(ctx, { t: 'upgradePoint', point: p })) return false;
  spend(ctx.res, cost);
  return true;
}

// ---------------------------------------------------------------- unit choice

/** Score units we could train now, with counters to the SEEN enemy composition. */
export function unitScores(ctx: Ctx): { unit: UnitKind; score: number }[] {
  const { b, v } = ctx;
  const seen = v.memory.seenKinds;
  let seenTotal = 0;
  for (const k of Object.keys(seen) as UnitKind[]) if (k !== 'scout') seenTotal += seen[k] ?? 0;
  const useCounters = seenTotal > 0 && b.rng.next() >= b.diff.counterSkip;

  const mine: Partial<Record<UnitKind, number>> = {};
  let mineTotal = 0;
  for (const s of v.mySquads) {
    if (s.kind === 'scout' || s.kind === 'ram') continue;
    mine[s.kind] = (mine[s.kind] ?? 0) + 1;
    mineTotal++;
  }
  const out: { unit: UnitKind; score: number }[] = [];
  for (const k of Object.keys(UNITS) as UnitKind[]) {
    if (k === 'scout' || k === 'ram') continue;
    const def = UNITS[k];
    if (def.age > v.player.age) continue;
    let s = b.pers.unitWeights[k] ?? 0.5;
    s *= basePower(k) / Math.sqrt(costValue(def.cost));
    if (useCounters) {
      let c = 0;
      for (const e of Object.keys(seen) as UnitKind[]) {
        if (e === 'scout') continue;
        c += ((seen[e] ?? 0) / seenTotal) * Math.log(counterFactor(k, e));
      }
      s *= Math.exp(1.6 * b.diff.counterWeight * c);
    }
    // keep some diversity
    const share = mineTotal > 0 ? (mine[k] ?? 0) / mineTotal : 0;
    if (share > 0.45) s *= 1 / (1 + (share - 0.45) * 3);
    s *= b.rng.noise(b.diff.noise);
    out.push({ unit: k, score: s });
  }
  out.sort((a, c) => c.score - a.score);
  return out;
}

// ---------------------------------------------------------------- opening

function runOpening(ctx: Ctx): void {
  const { b, v } = ctx;
  const steps = b.pers.opening;
  while (b.openingIdx < steps.length) {
    const st: OpeningStep = steps[b.openingIdx];
    let done = false;
    let cost: Resources | null = null;
    if ('b' in st) {
      if (countKind(v, st.b) >= BUILDINGS[st.b].maxPerPlayer) done = true;
      else {
        cost = BUILDINGS[st.b].cost;
        done = tryBuild(ctx, st.b);
      }
    } else if ('u' in st) {
      cost = UNITS[st.u].cost;
      if (ctx.pop + UNITS[st.u].pop > v.player.popCap) done = true; // skip
      else done = tryTrain(ctx, st.u);
    } else if ('tech' in st) {
      cost = TECHS[st.tech].cost;
      done = hasTech(v, st.tech) || researching(v, st.tech) || tryResearch(ctx, st.tech);
    } else {
      cost = RULES.pointUpgradeCost;
      done = tryUpgrade(ctx);
    }
    if (done) {
      b.openingIdx++;
      b.openingStall = 0;
      continue;
    }
    b.openingStall++;
    // a step that can't happen (e.g. no producer yet) is skipped after a while
    if (b.openingStall > 10) {
      b.openingIdx++;
      b.openingStall = 0;
      continue;
    }
    if (cost) reserve(ctx.res, cost);
    b.saving = 'opening';
    return;
  }
}

// ---------------------------------------------------------------- stance

export function updateStance(ctx: Ctx): void {
  const { b, v } = ctx;
  const army = armySquads(v);
  const enemies = believedEnemies(v).map((e) => e.s).filter((s) => s.kind !== 'ram');
  const myPower = matchupPower(army, enemies);
  const foePower = Math.max(30, enemyPowerEstimate(v));
  const ratio = (myPower / foePower) * b.rng.noise(b.diff.noise);

  let mine = 0;
  let theirs = 0;
  for (const p of v.points) {
    if (p.owner === v.me) mine++;
    else if (p.owner === v.foe) theirs++;
  }
  const vpLead = v.player.vp - v.foeVp;
  const late = v.tick > 14 * MIN;
  const caution = b.diff.attackCaution;
  const hasRams = v.mySquads.some((s) => s.kind === 'ram');
  const armyPop = army.length;

  // base threatened?
  let threat = 0;
  for (const e of v.enemySquads) {
    if (e.kind === 'scout') continue;
    if (dist(e, v.myHome) < 12000) threat++;
  }
  // Peace phase / post-peace delay / tutorial: build up and hold, never attack.
  if (!aggressionOk(b, v)) {
    b.stance = threat > 0 && !inPeace(v) && !b.passive ? 'defend' : 'expand';
    return;
  }
  if (threat > 0) {
    b.stance = 'defend';
    return;
  }
  // softer early game after peace, and the first attack needs a clearly bigger army
  const sincePeace = v.tick - peaceTicks(v);
  let caution2 = caution * (sincePeace < 5 * MIN ? b.diff.earlyCaution : 1);
  if (!b.firstAttackDone) caution2 *= b.diff.firstAttackRatio;
  const pushNeed = b.pers.pushRatio * caution2 * (hasRams ? 0.85 : 1) * (late && vpLead < 0 ? 0.8 : 1);
  const minArmy = b.firstAttackDone ? 4 : b.difficulty === 'easy' ? 6 : 4;
  if (armyPop >= 6 && ratio >= pushNeed && (v.player.age >= 2 || ratio > pushNeed * 1.3)) b.stance = 'push';
  else if (
    armyPop >= minArmy &&
    (ratio >= b.pers.attackRatio * caution2 || (b.firstAttackDone && mine <= theirs) || (late && vpLead < 0))
  )
    b.stance = 'attack';
  else if (b.firstAttackDone && mine < theirs && armyPop >= 4) b.stance = 'attack';
  else b.stance = 'expand';
  if (b.stance === 'attack' || b.stance === 'push') b.firstAttackDone = true;
}

// ---------------------------------------------------------------- main

interface Candidate {
  name: string;
  score: number;
  cost: Resources;
  run: () => boolean;
  /** If true, being unaffordable reserves its cost (saving for it). */
  save: boolean;
}

export function runStrategy(ctx: Ctx): void {
  const { b, v } = ctx;
  b.saving = null;
  updateStance(ctx);
  runOpening(ctx);
  const inOpening = b.openingIdx < b.pers.opening.length;

  const army = armySquads(v);
  const armyPop = army.length;
  const age = v.player.age;
  const threatened = b.stance === 'defend';
  const popRoom = v.player.popCap - ctx.pop;
  const n = (x: number) => x * b.rng.noise(b.diff.noise);
  const cands: Candidate[] = [];

  // --- age up
  if (age < 3) {
    const tech: TechId = age === 1 ? 'age2' : 'age3';
    const def = TECHS[tech];
    const armyNeed = age === 1 ? b.pers.armyBeforeAge2 : b.pers.armyBeforeAge3;
    const tooEarly = age === 1 && v.tick < b.diff.minAge2Tick;
    if (!researching(v, tech) && nonTcCompleted(v) >= def.requiresBuildings && !threatened && !tooEarly) {
      const ready = armyPop >= armyNeed || popRoom <= 0;
      const minutes = v.tick / MIN;
      const score = b.pers.ageUpWeight * b.diff.ageUpMul * (ready ? 1.4 : 0.5) * (1 + minutes / 12);
      cands.push({ name: tech, score: n(score), cost: def.cost, run: () => tryResearch(ctx, tech), save: ready && b.diff.ageUpMul >= 0.8 });
    }
  }

  // --- buildings from the plan (counts per kind up to plan occurrences)
  const planned: Partial<Record<BuildingKind, number>> = {};
  let planIdx = 0;
  for (const item of b.pers.buildPlan) {
    planIdx++;
    planned[item.kind] = (planned[item.kind] ?? 0) + 1;
    if (item.age > age) continue;
    if (countKind(v, item.kind) >= (planned[item.kind] ?? 0)) continue;
    const kind = item.kind;
    let score = 1.3 - planIdx * 0.08;
    // need buildings for the next age
    const need = age === 1 ? TECHS.age2.requiresBuildings : age === 2 ? TECHS.age3.requiresBuildings : 0;
    if (nonTcTotal(v) < need) score += 0.5;
    if (kind === 'tower') score *= threatened ? 1.4 : b.pers.towers >= 2 ? 1 : 0.6;
    cands.push({ name: 'build ' + kind, score: n(score), cost: BUILDINGS[kind].cost, run: () => tryBuild(ctx, kind), save: score > 1 });
    break; // one plan item at a time keeps the order
  }
  // building that produces our current favourite counter
  const scores = unitScores(ctx);
  if (scores.length > 0) {
    const fav = scores[0].unit;
    const bk = UNITS[fav].building;
    if (countKind(v, bk) === 0) {
      cands.push({ name: 'build ' + bk, score: n(1.1), cost: BUILDINGS[bk].cost, run: () => tryBuild(ctx, bk), save: true });
    }
  }
  // floating resources: add production for the units we want most
  if (scores.length > 0 && v.tick > 4 * MIN && ctx.res.food + ctx.res.wood + ctx.res.gold > 700) {
    for (const { unit } of scores.slice(0, 2)) {
      const bk = UNITS[unit].building;
      if (countKind(v, bk) >= BUILDINGS[bk].maxPerPlayer) continue;
      cands.push({ name: 'extra ' + bk, score: n(0.9), cost: BUILDINGS[bk].cost, run: () => tryBuild(ctx, bk), save: false });
      break;
    }
  }
  // towers for turtles / when under pressure
  if (countKind(v, 'tower') < b.pers.towers && v.tick > 3 * MIN) {
    cands.push({ name: 'tower', score: n(threatened ? 1.2 : 0.55), cost: BUILDINGS.tower.cost, run: () => tryBuild(ctx, 'tower'), save: false });
  }
  // workshop when we want to push
  if (age >= 2 && countKind(v, 'workshop') === 0 && b.pers.rams > 0 && (b.stance === 'push' || b.stance === 'attack')) {
    cands.push({ name: 'workshop', score: n(0.9), cost: BUILDINGS.workshop.cost, run: () => tryBuild(ctx, 'workshop'), save: false });
  }

  // --- research
  for (const tech of ['attack1', 'armor1', 'attack2'] as TechId[]) {
    const def = TECHS[tech];
    if (def.age > age || hasTech(v, tech) || researching(v, tech)) continue;
    if (completed(v, 'blacksmith').length === 0) continue;
    const score = b.pers.techWeight * (armyPop >= 5 ? 0.95 : 0.45);
    cands.push({ name: tech, score: n(score), cost: def.cost, run: () => tryResearch(ctx, tech), save: false });
    break;
  }

  // --- point upgrades
  if (bestUpgradePoint(ctx) !== null) {
    const minutes = v.tick / MIN;
    const score = b.pers.upgradeWeight * (minutes < 14 ? 0.85 : 0.4);
    cands.push({ name: 'upgrade', score: n(score), cost: RULES.pointUpgradeCost, run: () => tryUpgrade(ctx), save: false });
  }

  // --- units
  const armyMin = threatened ? 99 : inOpening ? 0 : Math.min(v.player.popCap, 3 + Math.trunc(v.tick / MIN));
  const unitScore = threatened ? 2 : armyPop < armyMin ? 1.25 : popRoom > 0 ? 0.8 : 0;
  if (popRoom > 0) {
    cands.push({ name: 'units', score: n(unitScore), cost: { food: 0, wood: 0, gold: 0 }, run: () => trainUnits(ctx, scores), save: false });
  }
  // scouts early (cheap, fast capturers, eyes)
  const scouts = v.mySquads.filter((s) => s.kind === 'scout').length + queuedOf(v, 'scout');
  if (scouts < b.pers.scouts && v.tick < 6 * MIN && popRoom > 0) {
    cands.push({ name: 'scout', score: n(1.15), cost: UNITS.scout.cost, run: () => tryTrain(ctx, 'scout'), save: false });
  }
  // rams for the push
  if (age >= 2 && (b.stance === 'push' || (b.stance === 'attack' && armyPop >= 7))) {
    const rams = v.mySquads.filter((s) => s.kind === 'ram').length + queuedOf(v, 'ram');
    if (rams < b.pers.rams && popRoom >= 2) {
      cands.push({ name: 'ram', score: n(1.0), cost: UNITS.ram.cost, run: () => tryTrain(ctx, 'ram'), save: false });
    }
  }

  cands.sort((a, c) => c.score - a.score);
  let saved = false;
  for (const c of cands) {
    if (c.score <= 0) continue;
    if (affordable(ctx.res, c.cost)) {
      c.run();
    } else if (c.save && !saved && !threatened) {
      reserve(ctx.res, c.cost);
      b.saving = c.name;
      saved = true;
    }
  }
  // spend floating resources on more units if nothing else wants them
  if (popRoom > 0 && ctx.res.food + ctx.res.wood + ctx.res.gold > 450) trainUnits(ctx, scores);
}

function queuedOf(v: View, unit: UnitKind): number {
  let n = 0;
  for (const b of v.myBuildings) for (const q of b.queue) if (q.item === unit) n++;
  return n;
}

function trainUnits(ctx: Ctx, scores: { unit: UnitKind; score: number }[]): boolean {
  let any = false;
  for (let guard = 0; guard < 6; guard++) {
    let done = false;
    for (const { unit } of scores) {
      if (producers(ctx, unit).length === 0) continue;
      if (tryTrain(ctx, unit)) {
        done = true;
        any = true;
        break;
      }
    }
    if (!done) break;
  }
  return any;
}
