/**
 * Tactics layer (every few ticks, = reaction time): focus fire on visible
 * targets with the best counter value, retreat badly damaged squads when the
 * local fight is not being won, keep rams out of melee.
 */
import { RULES, UNITS } from '../content';
import type { Squad } from '../sim';
import { emit } from './brain';
import type { Ctx } from './brain';
import { bonus, dist, matchupPower, TPS } from './view';

const TILE = 1000;
const ENGAGE_R = 8 * TILE;

/** Value of hitting `t` with `s`: counter bonus, low hp (finish it), closeness. */
function targetValue(s: Squad, t: Squad, focus: boolean): number {
  const b = bonus(s.kind, t.kind) / 100;
  const frac = t.hp / Math.max(1, t.maxHp);
  const d = dist(s, t);
  const reach = UNITS[s.kind].range + 2 * RULES.squadRadius;
  const closeF = d <= reach ? 1.6 : 1 / (1 + (d - reach) / (3 * TILE));
  // rams are harmless; scouts are low value
  const kindF = t.kind === 'ram' ? 0.5 : t.kind === 'scout' ? 0.6 : 1;
  return b * kindF * closeF * (focus ? 1.6 - frac : 1);
}

export function runTactics(ctx: Ctx): void {
  const { b, v } = ctx;
  if (v.enemySquads.length === 0) return;
  const enemies = v.enemySquads;
  const mine = v.mySquads.filter((s) => s.kind !== 'ram' && b.roles.get(s.id) !== 'retreat');

  // --- retreat badly damaged squads unless the local fight is won
  for (const s of mine) {
    if (ctx.touched.has(s.id) || s.kind === 'scout') continue;
    if (s.hp >= s.maxHp * 0.3) continue;
    if (v.tick - s.lastCombatTick > 3 * TPS) continue;
    if (dist(s, v.myHome) < 9 * TILE) continue; // fight at home, TC helps
    const localEnemies = enemies.filter((e) => dist(e, s) < ENGAGE_R);
    const localMine = mine.filter((m) => dist(m, s) < ENGAGE_R);
    const winning = matchupPower(localMine, localEnemies) > matchupPower(localEnemies, localMine) * 1.4;
    if (winning) continue;
    if (b.rng.next() >= b.diff.retreatChance) continue;
    if (emit(ctx, { t: 'retreat', squads: [s.id] })) {
      b.roles.set(s.id, 'retreat');
      b.retreatSince.set(s.id, v.tick);
    }
  }

  // --- target selection (grouped by target to share commands)
  const byTarget = new Map<number, number[]>();
  for (const s of mine) {
    if (ctx.touched.has(s.id)) continue;
    if (s.order === 'retreat') continue;
    if (s.kind === 'scout' && b.roles.get(s.id) === 'scout') continue; // operations handles scouts
    const sight = UNITS[s.kind].sight;
    let best: Squad | null = null;
    let bestV = 0;
    for (const e of enemies) {
      if (dist(e, s) > Math.min(sight, ENGAGE_R)) continue;
      const val = b.diff.focusFire ? targetValue(s, e, true) : 1 / (1 + dist(e, s));
      if (val > bestV) {
        bestV = val;
        best = e;
      }
    }
    if (!best) continue;
    if (s.order === 'attack' && s.target === best.id) continue;
    // easy/normal: keep a current target that's still around unless it's much worse
    if (s.order === 'attack' && s.target !== null) {
      const cur = enemies.find((e) => e.id === s.target);
      if (cur && (!b.diff.focusFire || targetValue(s, cur, true) * 1.25 >= bestV)) continue;
    }
    const list = byTarget.get(best.id) ?? [];
    list.push(s.id);
    byTarget.set(best.id, list);
  }
  const entries = [...byTarget.entries()].sort((a, c) => c[1].length - a[1].length || a[0] - c[0]);
  for (const [target, squads] of entries) emit(ctx, { t: 'attack', squads, target }, 0);

  // --- rams: back off from enemy squads if no friendly army covers them
  for (const r of v.mySquads) {
    if (r.kind !== 'ram' || ctx.touched.has(r.id) || r.order === 'retreat') continue;
    const threat = enemies.some((e) => e.kind !== 'ram' && dist(e, r) < 4 * TILE);
    if (!threat) continue;
    const cover = mine.some((m) => dist(m, r) < 6 * TILE);
    if (!cover) emit(ctx, { t: 'retreat', squads: [r.id] }, 1);
  }
}
