# Conquer Chrizu – Game Spec (MVP: 1v1 gegen CPU)

Genre: Territorium-RTS „Gebiete & Trupps“. Ziel: ein Match dauert 15–20 Minuten,
spielbar per Touch (Handy quer) und Maus. Sprache der UI: Deutsch.

Data and balancing: `src/content/`. Shared types: `src/sim/types.ts`.
Public sim API: `src/sim/index.ts`. Relay: `src/net/localRelay.ts`. Bot API: `src/bot/index.ts`.

## Module ownership

| Folder | Owner | Notes |
| --- | --- | --- |
| `src/sim/` | sim agent | deterministic; no DOM imports |
| `src/content/` | coordinator (balancing tweaks allowed by sim/bot agents only if they say so in their report) |
| `src/bot/`, `tools/simulate.ts` | bot agent | |
| `src/client/`, `index.html` | client agent | |
| `src/net/` | coordinator | |
| `tests/` | each agent adds `tests/<module>.test.ts` | vitest |

Do not edit another module's files. If the contract (types.ts, index.ts signatures, content) blocks you, work around it locally and list the needed change in your final report.

## Core rules

**Squads.** A squad is ONE entity with `members` soldiers. `hp` is the squad total; `members = ceil(hp / hpPerMember)`. Damage dealt per attack = `members * dmgPerMember * bonusPct/100 * (100+attackerTechDmgPct)/100 * (100-targetTechArmorPct)/100 * defenderPct/100` (integer math, truncate at the end, minimum 1). Ranged attacks hit instantly (projectiles are cosmetic, client-side).

**Range.** Attack range is edge-to-edge: distance between centers minus both radii (`RULES.squadRadius`, `RULES.buildingRadius`, `RULES.townCenterRadius`) must be ≤ `range`.

**Orders.**
- `move`: path to destination (A* on tile grid, 8-neighbour, no corner cutting through blocked tiles), ignore enemies while moving. On arrival → `idle`.
- `attack`: chase the target (repath at most every 10 ticks), attack when in range. Target gone → `idle`.
- `idle`: auto-acquire the nearest visible enemy squad within own `sight` (buildings only if no squads); acquire also when hit. Idle squads near their own TC/points defend.
- `retreat`: move to own TC, ignore enemies; on arrival `idle`.
- `stop`: clear path and target → `idle`.
- Multiple squads given one move get a simple formation: destination offsets on a ring/grid around the click point (deterministic by squad id order) so they don't stack.
- Separation: overlapping own squads push each other apart slightly (integer, deterministic). Squads never enter blocked tiles.

**Capture points.** Each second (every 20 ticks): count non-ram squads of each player within `captureRadius`. If only one player is present and the point is not already fully theirs, progress moves toward that player by `captureRatePerSquad × min(count,3)` per second. Progress model: a point owned by the enemy must first be neutralised (progress down to 0 → owner −1), then captured (progress up to `captureMax` → owner = capturer). Contested (both present) = no change. Empty = slowly regenerate 2/s back toward the current owner state. Emit `captured` on owner change. Upgrading (`upgradePoint`) costs `pointUpgradeCost`, sets level 2 (+50 % income); captured points lose their level (back to 1).

**Economy.** Once per second each player gains `townCenterIncome` + income of owned points (level 2 = 150 %, truncated). `stats.resourcesGathered` += total.

**Buildings.** `build` places a building on a free own slot (cost paid immediately, `buildTicksLeft = buildTicks`, hp starts at 10 % and grows linearly to max while under construction). Requires age ≥ def.age and count < maxPerPlayer. Under construction: no training/research/attacks. Destroyed buildings free the slot. TC and towers shoot the nearest enemy squad in range (TC: dmg vs squads only).

**Training.** `train` validates age, affordability and pop (`pop + unit.pop ≤ popCap`; queued units count toward pop). Cost is paid when queued; `cancel` refunds the last item fully. Queue max 5, only the first item progresses. Finished squad spawns next to the building (nearest walkable tile, deterministic) and moves to `rally` if set.

**Research.** `research` at TC (ages) or blacksmith. Age techs require `requiresBuildings` completed non-TC buildings. While a TC researches an age it cannot train scouts (same queue). Completing `age2/age3` sets `player.age`, emits `ageUp`. Tech effects apply to all present and future squads.

**Healing.** Squads out of combat for `healOutOfCombatTicks` within `healRadius` of own TC or own point regain `healPctPerSecond` of maxHp per second (members come back).

**Bounty.** When a squad dies, killer gains `bountyGoldPctOfCost` % of its unit cost (sum of food+wood+gold) as gold; owner loses `vpLossPerSquadDeath` VP.

**Victory points.** Both start with `vpStart`. Every second, side holding fewer points loses `(diff × vpDrainPerPoint)` VP (doubled from `vpDrainDoubleAfterTicks`). VP ≤ 0 → loss (`vp`). TC destroyed → loss (`towncenter`). At `hardCapTicks`: more VP wins, equal = draw (`timeout`). `surrender` → loss. Emit `gameOver` once.

**Under attack.** Emit `underAttack` for a player at most once per 10 s per 8-tile area when their squad/building takes damage (client shows a warning + jump button).

**Start.** Each player: TC (full hp), start resources, start squads per map (`startSquads`), age 1, pop counting the start squads. All 13 points neutral.

## Client UX requirements (mobile first)

- Landscape. Canvas fills the screen; DOM overlay HUD. Top bar: food/wood/gold, pop, VP bars both players, clock, age. Bottom: squad cards (tap = select, double-tap = select all of type), right side: context panel (build menu on slot tap, train/research on building tap, squad actions: Stopp, Rückzug, Angriff…).
- Tap own squad = select; tap ground = move selected; tap enemy = attack with selected; tap own building = open its panel; tap empty slot = build menu (radial or list). One-finger drag = pan, pinch = zoom, mouse wheel = zoom, right-click = move/attack, left-drag = box select on desktop; a toggle button „Auswahl“ makes one-finger drag a box select on touch.
- Minimap bottom-left, tap to jump. Warnings toast for `underAttack`, `rejected` reasons, `captured`, `ageUp`.
- Fog of war: tiles not visible are darkened; enemy squads/buildings only drawn when visible (buildings remembered once seen).
- Main menu: Titel „Conquer Chrizu“, Schwierigkeit (Leicht/Normal/Schwer), Start. Kurzanleitung (3–4 Sätze). End screen: Sieg/Niederlage, Grund, Dauer, Stats, Neues Spiel.
- Pause button (vs CPU only). Game speed 1× (optional 2× toggle for testing).
- Render: interpolate squad positions between sim ticks; 60 fps target; cap devicePixelRatio at 2.
- Touch targets ≥ 44 px.
