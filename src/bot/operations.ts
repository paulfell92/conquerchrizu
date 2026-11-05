/**
 * Operations layer (~1 s): splits the field army into groups, assigns each
 * group an objective from a simple influence map (value of a point vs. the
 * enemy strength the bot believes is near it), defends own points / the TC,
 * harasses with scouts, and pushes the enemy TC with rams when ahead.
 */
import { RULES, UNITS } from '../content';
import type { CapturePoint, Squad, Vec } from '../sim';
import { aggressionCaution, aggressionOk, emit, onMyHalf } from './brain';
import type { Ctx, Group, Objective } from './brain';
import { pointIncomeValue } from './strategy';
import { centroid, dangerAt, dist, matchupPower, squadPower, TPS } from './view';
import type { View } from './view';

const TILE = 1000;
const MIN = 60 * TPS;
const BASE_THREAT_RADIUS = 13 * TILE;

function power(list: readonly Squad[]): number {
  let p = 0;
  for (const s of list) p += squadPower(s);
  return p;
}

/** Visible enemy combat squads near the own base. */
export function baseThreats(v: View): Squad[] {
  return v.enemySquads.filter((e) => e.kind !== 'scout' && dist(e, v.myHome) < BASE_THREAT_RADIUS);
}

function isCenterPoint(v: View, p: Vec): boolean {
  const mid = (v.myHome.x + v.foeHome.x) / 2;
  return Math.abs(p.x - mid) < 3 * TILE;
}

/** Own point currently being taken (public capture state) or with visible enemies on it. */
function pointUnderAttack(v: View, p: CapturePoint): Squad[] | null {
  if (p.owner !== v.me) return null;
  const r = RULES.captureRadius + 3 * TILE;
  const near = v.enemySquads.filter((e) => e.kind !== 'ram' && dist(e, p) < r);
  const contested = p.capturer === v.foe || (p.progress < RULES.captureMax && p.capturer !== v.me);
  if (near.length > 0 || contested) return near;
  return null;
}

// ---------------------------------------------------------------- groups

function updateRoles(ctx: Ctx): void {
  const { b, v } = ctx;
  const alive = new Set(v.mySquads.map((s) => s.id));
  for (const id of [...b.roles.keys()]) if (!alive.has(id)) b.roles.delete(id);
  for (const id of [...b.retreatSince.keys()]) if (!alive.has(id)) b.retreatSince.delete(id);
  const scoutPhase = v.tick < 9 * MIN;
  for (const s of v.mySquads) {
    const r = b.roles.get(s.id);
    if (r === 'retreat') {
      const frac = s.hp / s.maxHp;
      const since = b.retreatSince.get(s.id) ?? v.tick;
      const homeD = dist(s, v.myHome);
      if (frac >= 0.75 || v.tick - since > 75 * TPS || (homeD < 9 * TILE && baseThreats(v).length > 0)) {
        b.roles.set(s.id, s.kind === 'scout' ? 'scout' : 'army');
        b.retreatSince.delete(s.id);
      }
      continue;
    }
    if (s.kind === 'scout') b.roles.set(s.id, scoutPhase ? 'scout' : 'army');
    else b.roles.set(s.id, 'army');
  }
}

function assignGroups(ctx: Ctx, army: Squad[]): void {
  const { b, v } = ctx;
  const prev = new Map<number, number>();
  b.groups.forEach((g, gi) => g.squads.forEach((id) => prev.set(id, gi)));
  let nGroups = 1;
  if (b.stance !== 'defend' && b.stance !== 'push') {
    // early game with no contact: spread out to grab neutral points quickly
    const early = v.tick < 4 * MIN && v.enemySquads.every((e) => e.kind === 'scout');
    nGroups = Math.min(b.diff.maxGroups, early ? Math.floor(army.length / 1.5) : Math.floor(army.length / 3));
  } else if (b.stance === 'push' && army.length >= 9) nGroups = Math.min(2, b.diff.maxGroups);
  nGroups = Math.max(1, nGroups);
  const lists: Squad[][] = Array.from({ length: nGroups }, () => []);
  const free: Squad[] = [];
  for (const s of army) {
    const gi = prev.get(s.id);
    if (gi !== undefined && gi < nGroups) lists[gi].push(s);
    else free.push(s);
  }
  // raider groups (1..n-1) get ~30 % (2 groups) or ~25 % (3 groups) each, fast squads first
  const share = nGroups === 2 ? 0.35 : 0.25;
  const raidSize = nGroups === 1 ? 0 : Math.max(1, Math.floor(army.length * share));
  free.sort((a, c) => UNITS[c.kind].speed - UNITS[a.kind].speed || a.id - c.id);
  for (let gi = 1; gi < nGroups; gi++) {
    while (lists[gi].length > raidSize) free.push(lists[gi].pop()!);
  }
  free.sort((a, c) => UNITS[c.kind].speed - UNITS[a.kind].speed || a.id - c.id);
  for (let gi = 1; gi < nGroups; gi++) {
    while (lists[gi].length < raidSize && free.length > 0) lists[gi].push(free.shift()!);
  }
  lists[0].push(...free);
  const groups: Group[] = [];
  lists.forEach((list, gi) => {
    if (list.length === 0) return;
    const old = b.groups[gi];
    groups.push({
      id: old?.id ?? b.nextGroupId++,
      squads: list.map((s) => s.id).sort((a, c) => a - c),
      objective: old?.objective ?? null,
      since: old?.since ?? v.tick,
      gathering: old?.gathering ?? false,
    });
  });
  b.groups = groups;
}

// ---------------------------------------------------------------- objectives

function objectives(ctx: Ctx, groupPower: number, at: Vec, raider: boolean, taken: Set<number>): Objective[] {
  const { b, v } = ctx;
  const out: Objective[] = [];
  const stance = b.stance;
  const caution = b.diff.attackCaution * aggressionCaution(b);
  const aggressive = aggressionOk(b, v);

  const threats = baseThreats(v);
  if (threats.length > 0 && v.tick >= (v.state.config.peaceTicks ?? 0)) {
    out.push({ kind: 'defendBase', pos: centroid(threats), score: 100 });
  }

  for (const p of v.points) {
    if (taken.has(p.id)) continue;
    const dHere = dist(p, at);
    const travel = 1 + dHere / (14 * TILE);
    const income = pointIncomeValue(p.kind) * (p.level === 2 ? 1.5 : 1);
    const danger = dangerAt(v, p, 7 * TILE);
    if (p.owner === v.me) {
      const attackers = pointUnderAttack(v, p);
      if (attackers) {
        const enemyP = attackers.length ? power(attackers) : 20;
        if (groupPower >= enemyP * 0.8 * caution) {
          out.push({ kind: 'defendPoint', pos: { x: p.x, y: p.y }, point: p.id, score: ((income + 12) * 1.6) / travel });
        }
      }
      continue;
    }
    const avoidUntil = b.avoid.get(p.id) ?? -1;
    if (avoidUntil > v.tick) continue;
    const dFoe = dist(p, v.foeHome);
    const deep = dFoe < 13 * TILE;
    // peace / post-peace delay: only neutral points outside the enemy base area;
    // tutorial (passive): only points on the own half
    if (!aggressive && (p.owner !== -1 || deep)) continue;
    if (b.passive && !onMyHalf(v, p)) continue;
    let value = income + 8 + (p.owner === v.foe ? 6 : 0);
    if (isCenterPoint(v, p)) value += 10 * b.pers.centerBias;
    if (raider && danger < 1) value *= 1.4;
    if (deep) {
      if (stance === 'expand') value *= 0.25;
      else if (stance === 'attack') value *= 0.7;
    }
    const tolerance = stance === 'expand' ? 0.85 : stance === 'attack' ? 1.1 : 1.3;
    const ratio = groupPower / (danger + 1);
    if (danger > 0 && ratio < (1 / tolerance) * caution) continue;
    const safety = danger > 0 ? Math.min(1, ratio / 2) : 1;
    out.push({ kind: 'capture', pos: { x: p.x, y: p.y }, point: p.id, score: (value * safety) / travel });
  }

  if (stance === 'push' && !raider && aggressive) {
    out.push({ kind: 'push', pos: { ...v.foeHome }, score: 60 });
  }
  out.push({ kind: 'hold', pos: holdPoint(v), score: 0.5 });
  for (const o of out) o.score *= b.rng.noise(b.diff.noise);
  out.sort((a, c) => c.score - a.score);
  return out;
}

/** Defensive position: the own point closest to the enemy, on the own half. */
function holdPoint(v: View): Vec {
  let hold: Vec = { x: Math.trunc(v.myHome.x + (v.foeHome.x - v.myHome.x) * 0.25), y: v.myHome.y };
  let bestD = Infinity;
  for (const p of v.points) {
    if (p.owner !== v.me || !onMyHalf(v, p)) continue;
    const d = dist(p, v.foeHome);
    if (d < bestD) {
      bestD = d;
      hold = { x: p.x, y: p.y };
    }
  }
  return hold;
}

function sameObjective(a: Objective | null, c: Objective): boolean {
  if (!a || a.kind !== c.kind) return false;
  if (a.point !== undefined || c.point !== undefined) return a.point === c.point;
  return dist(a.pos, c.pos) < 4 * TILE;
}

// ---------------------------------------------------------------- movement

/** Send the group's squads that aren't already heading to `pos`. */
function steer(ctx: Ctx, squads: Squad[], pos: Vec, arriveR: number, force = false): void {
  const send: number[] = [];
  for (const s of squads) {
    if (ctx.touched.has(s.id)) continue;
    if (s.order === 'attack' && !force) {
      // abandon long chases away from the objective
      if (dist(s, pos) < 14 * TILE) continue;
    }
    if (s.order === 'move' && s.dest && dist(s.dest, pos) < 3.5 * TILE) continue;
    if (s.order === 'idle' && dist(s, pos) < arriveR) continue;
    if (s.order === 'retreat') continue;
    send.push(s.id);
  }
  if (send.length === 0) return;
  emit(ctx, { t: 'move', squads: send, x: Math.trunc(pos.x), y: Math.trunc(pos.y) }, 0);
}

/** Staging point 9 tiles in front of `target`, towards the own base. */
function stagingPoint(v: View, target: Vec): Vec {
  const dx = v.myHome.x - target.x;
  const dy = v.myHome.y - target.y;
  const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const k = Math.min(1, (11 * TILE) / d);
  return { x: Math.trunc(target.x + dx * k), y: Math.trunc(target.y + dy * k) };
}

function runGroup(ctx: Ctx, g: Group, raider: boolean, taken: Set<number>): void {
  const { b, v } = ctx;
  const squads = g.squads.map((id) => v.mySquads.find((s) => s.id === id)!).filter(Boolean);
  if (squads.length === 0) return;
  const at = centroid(squads);
  const gp = power(squads);
  const objs = objectives(ctx, gp, at, raider, taken);
  let best = objs[0];
  // hysteresis: keep the current objective unless a clearly better one appears
  const cur = g.objective ? objs.find((o) => sameObjective(g.objective, o)) : undefined;
  if (cur && best !== cur && best.kind !== 'defendBase' && best.score < cur.score * 1.35) best = cur;
  if (!sameObjective(g.objective, best)) {
    g.objective = best;
    g.since = v.tick;
    g.gathering = b.diff.regroup && (best.kind === 'push' || dist(at, best.pos) > 18 * TILE);
  } else g.objective = best;
  if (best.point !== undefined) taken.add(best.point);

  // Group-level retreat if the fight in front of us is lost.
  const nearEnemies = v.enemySquads.filter((e) => e.kind !== 'scout' && dist(e, at) < 9 * TILE);
  if (nearEnemies.length > 0 && best.kind !== 'defendBase') {
    const mine = matchupPower(squads, nearEnemies);
    const theirs = matchupPower(nearEnemies, squads) * (best.kind === 'push' ? 1 : 1.1);
    if (mine < theirs * 0.6 && b.rng.next() < b.diff.retreatChance) {
      const ids = squads.filter((s) => s.order !== 'retreat').map((s) => s.id);
      if (ids.length > 0 && emit(ctx, { t: 'retreat', squads: ids }, 0)) {
        if (best.point !== undefined) b.avoid.set(best.point, v.tick + 40 * TPS);
        for (const id of ids) {
          b.roles.set(id, 'retreat');
          b.retreatSince.set(id, v.tick);
        }
        g.objective = null;
      }
      return;
    }
  }

  const obj = best;
  // smaller attack waves (easy): only the first `waveMax` squads go on offense
  const offensive = obj.kind === 'push' || (obj.kind === 'capture' && obj.point !== undefined && v.points.find((p) => p.id === obj.point)?.owner === v.foe);
  if (offensive && squads.length > b.diff.waveMax) {
    const stay = squads.slice(b.diff.waveMax);
    squads.length = b.diff.waveMax;
    steer(ctx, stay, holdPoint(v), 4 * TILE);
  }
  if (g.gathering) {
    const stage = stagingPoint(v, obj.pos);
    let spread = 0;
    for (const s of squads) spread = Math.max(spread, dist(s, stage));
    if (spread < 5 * TILE || v.tick - g.since > 45 * TPS) g.gathering = false;
    else {
      steer(ctx, squads, stage, 3 * TILE);
      return;
    }
  }
  if (obj.kind === 'push') {
    // attack the TC directly when no visible enemy army around
    const tcSeen = [...v.memory.buildings.values()].find((x) => x.kind === 'towncenter');
    const nearTc = squads.filter((s) => dist(s, obj.pos) < 10 * TILE);
    if (tcSeen && nearEnemies.length === 0 && nearTc.length > 0) {
      const ids = squads.filter((s) => !ctx.touched.has(s.id) && !(s.order === 'attack' && s.target === tcSeen.id)).map((s) => s.id);
      if (ids.length > 0) emit(ctx, { t: 'attack', squads: ids, target: tcSeen.id }, 0);
      return;
    }
  }
  const arrive = obj.kind === 'capture' || obj.kind === 'defendPoint' ? RULES.captureRadius - 600 : 4 * TILE;
  steer(ctx, squads, obj.pos, arrive);
}

// ---------------------------------------------------------------- scouts

function runScouts(ctx: Ctx, taken: Set<number>): void {
  const { b, v } = ctx;
  const scouts = v.mySquads.filter((s) => b.roles.get(s.id) === 'scout');
  for (const s of scouts) {
    if (ctx.touched.has(s.id)) continue;
    // flee from combat squads
    const threat = v.enemySquads.find((e) => e.kind !== 'scout' && e.kind !== 'ram' && dist(e, s) < 6 * TILE);
    if (threat) {
      if (s.order !== 'retreat' && s.hp < s.maxHp * 0.95) emit(ctx, { t: 'retreat', squads: [s.id] }, 1);
      else if (s.order === 'idle' || (s.order === 'attack' && s.target === threat.id)) emit(ctx, { t: 'retreat', squads: [s.id] }, 1);
      continue;
    }
    // harass: kill a visible enemy scout or capture an empty point
    let best: { pos: Vec; id: number; score: number } | null = null;
    const aggressive = aggressionOk(b, v);
    for (const p of v.points) {
      if (p.owner === v.me || taken.has(p.id)) continue;
      // no scout raids before aggression is allowed: neutral points outside the enemy base only
      if (!aggressive && (p.owner !== -1 || dist(p, v.foeHome) < 13 * TILE)) continue;
      if (b.passive && !onMyHalf(v, p)) continue;
      const danger = dangerAt(v, p, 7 * TILE);
      if (danger > 0) continue;
      if ((b.avoid.get(p.id) ?? -1) > v.tick) continue;
      const value = pointIncomeValue(p.kind) + 8 + (p.owner === v.foe ? 4 : 0);
      const score = value / (1 + dist(p, s) / (12 * TILE));
      if (!best || score > best.score) best = { pos: p, id: p.id, score };
    }
    if (!best) {
      steer(ctx, [s], v.myHome, 6 * TILE);
      continue;
    }
    taken.add(best.id);
    if (s.order === 'attack') continue;
    steer(ctx, [s], best.pos, RULES.captureRadius - 700);
  }
}

// ---------------------------------------------------------------- rams

function runRams(ctx: Ctx): void {
  const { b, v } = ctx;
  const rams = v.mySquads.filter((s) => s.kind === 'ram' && !ctx.touched.has(s.id));
  if (rams.length === 0) return;
  const main = b.groups[0];
  const pushing = main?.objective?.kind === 'push';
  const mainSquads = main ? v.mySquads.filter((s) => main.squads.includes(s.id)) : [];
  if (!pushing || mainSquads.length === 0) {
    const wait = { x: Math.trunc(v.myHome.x + (v.foeHome.x - v.myHome.x) * 0.15), y: v.myHome.y };
    steer(ctx, rams, wait, 4 * TILE);
    return;
  }
  const armyAt = centroid(mainSquads);
  // known enemy buildings, closest to the ram front first; TC preferred if close
  const known = [...v.memory.buildings.values()];
  for (const r of rams) {
    if (r.order === 'attack') continue;
    let target: { id: number; d: number } | null = null;
    for (const bd of known) {
      let d = dist(bd, r);
      if (bd.kind === 'towncenter') d *= 0.6;
      if (bd.kind === 'tower') d *= 0.8;
      if (!target || d < target.d) target = { id: bd.id, d };
    }
    if (target && target.d < 16 * TILE && dist(armyAt, r) < 10 * TILE) {
      emit(ctx, { t: 'attack', squads: [r.id], target: target.id }, 0);
    } else {
      steer(ctx, [r], armyAt, 3 * TILE);
    }
  }
}

// ---------------------------------------------------------------- main

/** Tutorial mode: pull back squads the sim's auto-acquire dragged across the middle. */
function leashPassive(ctx: Ctx): void {
  const { v } = ctx;
  const ids = v.mySquads.filter((s) => !onMyHalf(v, { x: s.x + (v.myHome.x < v.foeHome.x ? 3 : -3) * TILE, y: s.y }) && s.order !== 'retreat').map((s) => s.id);
  if (ids.length > 0) emit(ctx, { t: 'retreat', squads: ids });
}

export function runOperations(ctx: Ctx): void {
  const { b, v } = ctx;
  if (b.passive) leashPassive(ctx);
  updateRoles(ctx);
  for (const [pid, until] of [...b.avoid]) if (until <= v.tick) b.avoid.delete(pid);
  const army = v.mySquads.filter((s) => b.roles.get(s.id) === 'army' && s.kind !== 'ram');
  assignGroups(ctx, army);
  const taken = new Set<number>();
  b.groups.forEach((g, i) => runGroup(ctx, g, i > 0, taken));
  runScouts(ctx, taken);
  runRams(ctx);
}
