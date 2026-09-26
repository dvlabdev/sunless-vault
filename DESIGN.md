# Project Specification: The Sunless Vault

## 1. Project Overview
- **Name:** The Sunless Vault
- **Genre:** Turn-based Micro-Roguelike (small, fully visible tactical floors)
- **Goal of a run:** Descend through a fixed number of floors (`FLOOR_COUNT`, default 10) and reach the Sunless Vault.
- **Target Platform:** Web browsers, desktop and mobile (keyboard + touch).
- **Tech Stack:** Vanilla JavaScript (classic `<script>` files, shared `SV` namespace), HTML5 Canvas, CSS3. No frameworks, libraries, build step or server.
- **How to run:** Double-click `index.html`. No local server needed.

## 2. Core Architecture Rules
1. **State-Render Separation:** Game logic never touches the DOM or canvas. It only changes `state`. Rendering only reads `state` and draws it.
2. **Single Plain-Data State:** All game data lives in one `state` object made of plain values only (numbers, strings, booleans, arrays, plain objects). No DOM nodes, images, functions or class instances inside it. This is what makes autosave a one-liner (see §5).
3. **Deterministic Turn Engine:** Time moves ONLY when the player acts (Move, Attack, Wait, Use Item). No animation loop: the screen is redrawn after each turn or input.
4. **Seeded RNG:** All randomness goes through `SV.rng` (a small seeded generator, e.g. mulberry32). Its current value is stored in `state`, so any run and any bug can be reproduced. `Math.random()` is not used for gameplay.
5. **No Hardcoded Sizes:** Code never writes `15` or `13` for the map. Everything reads `map.width` / `map.height`.
6. **Classic Scripts, One Namespace:** No `import`/`export` (ES modules don't load from `file://`). Each file is wrapped in its own function so its helpers stay private, and attaches its public functions to `SV`:
   ```js
   (function () {
       'use strict';
       const SV = window.SV = window.SV || {};
       // ...
   })();
   ```
   (A top-level `const SV` in two classic scripts would throw "already declared".) Script order in `index.html` matters. Level data lives in `.js` files, not JSON (no `fetch()` from `file://`).
7. **File Layout (starting point, not a cage):**
   | File | Responsibility |
   |---|---|
   | `src/rng.js` | Seeded random generator |
   | `src/map.js` | Floor generation, reachability check, run map (nodes) |
   | `src/entities.js` | Player/enemy/item data definitions and factories |
   | `src/combat.js` | Attack patterns, damage, death |
   | `src/render.js` | Canvas drawing + HUD/log DOM updates |
   | `src/main.js` | Input, turn sequence, game modes, save/load (loaded last) |

   New files are allowed when a phase justifies them (e.g. `items.js` in Phase 2).
8. **Token & Scope Efficiency:** Write concise, robust code. Avoid unnecessary abstraction layers or premature optimizations.

## 3. Gameplay Mechanics

### 3.1 Game Modes
`state.mode` is one of `'map' | 'floor' | 'dead' | 'won'`. Input handling and rendering switch on it.

### 3.2 Run Map (the "higher map")
- A run is a list of nodes in `state.run.nodes`:
  `{ id, depth, seed, floor: <floor config>, next: [ids], status: 'cleared' | 'current' | 'ahead' }`
- **Phase 1 — linear:** every node has exactly one `next`. The last node is the Vault.
- **Phase 3 — branching:** nodes have 2–3 `next` options with different risk/reward (e.g. a dark floor with more loot vs. a plain floor). The player picks one (arrows + Enter, or tap).
- **Phase 5 — endless:** nodes are generated as the player advances instead of all at run start.
- **Map screen** (drawn on the game canvas): a vertical track from floor 1 up to the Vault, showing the player marker, cleared floors, icons for the next 1–2 floors (dark, big, ambush) and `?` for floors further ahead. A status line shows HP, attack, weapon and kills (counters are in the HUD). Enter / tap descends.
- **Flow:** new run → `map` → descend → floor generated from the node's `seed` → reach the stairs → back to `map` (node `cleared`, marker moves up) → … → Vault reached → `won`.

### 3.3 Floors
- **Variable size:** each floor has its own `width` × `height` (outer walls included). Allowed range 7–19 on each side; default 15×15. Rectangles are allowed (e.g. a 17×7 corridor).
- **Floor config** (stored on its run-map node): `{ width, height, enemyBudget, vision, special, loot, barrels, closet }`. This one config drives difficulty and "peculiar" floors (e.g. a cramped 9×9 ambush). Hand-made special floors carry their own size and layout.
  - `loot` = loose items, weighted: potion 5, bomb 3, random weapon 1, heart 1 (floor 3+), whetstone 1 (floor 4+).
  - `barrels` = explosive barrels (from floor 2).
  - `closet` = a treasure closet + its key (floors 2, 4, 6, 8, 10).
- **Treasure closet:** a 2-tile room against a random outer wall, enclosed by walls, with one locked door facing inward (the tile in front of the door is kept open). It holds 1 treasure (random weapon, whetstone or heart) and a 50% chance of a potion. The key lies in the main area, never behind the door. Opening the closet is optional.
- **Generation:** random wall scatter or hand-made room templates, placed with `SV.rng`. The number of walls, enemies and items scales with floor area, so small floors aren't overcrowded and large ones aren't empty. No BSP room/corridor generation (grids are too small).
- **Reachability check:** after placing walls, a flood fill from the player's start (treating the closet door as open) finds every reachable tile. Unreachable pockets are turned into walls, so every open tile is reachable. If less than 60% of the inner area is reachable without opening the door, or the door can't be reached, regenerate with the next RNG value (after 30 failed tries, the floor has no inner walls).
- **Placement:** stairs go on a tile at least 70% of the maximum distance from the start. Everything else goes on distinct tiles of the main area: enemies at least 4 steps from the start (2 on ambush floors), the key at least 2, barrels at least 3.

### 3.4 Movement & Input
- 4-directional grid movement: WASD / Arrow Keys. Space = wait one turn.
- **Tap-to-move (mobile):** tapping the board moves the player one step in the dominant direction (horizontal or vertical) of the tap relative to the player. Tap position is converted to a tile using the current tile size and board offset.
- Walking into: an enemy attacks it; a barrel kicks it (§3.11); a locked door opens it if you have a key (costs a turn; without a key nothing happens and no turn is spent).
- `I` / tapping the weapon in the HUD: prints what the held weapon does and its damage.
- `P` / `!` HUD button: drink a potion. `B` / `*` HUD button: use a bomb. Both cost a turn; with none left (or at full HP for potions) nothing happens.
- Enter / tap: descend from the run map; start a new run from the death or victory screen.
- `?` or `H` key / `?` button: help overlay (controls). Shown automatically on the first run.
- `R`, or the **New game** button in the help screen (the touch equivalent): abandon the run and start a new game (with confirmation).
- **Every action has a touch equivalent:** tap the board (move/attack/kick/unlock, spear step-and-strike), tap yourself (wait / axe spin), HUD buttons for weapon details, potion, bomb and help, New game in the help screen.
- `?seed=123` at the end of the page address starts that exact run (bug reproduction).

### 3.5 Combat
- **Bump combat:** moving into an enemy's tile attacks it.
- **Fixed damage, no miss chance.** Every outcome is predictable, so the game is about positioning, not luck.
- **Attack patterns:** every attack is a function that returns the list of tiles it hits; one shared routine applies damage to whatever stands there. All weapon types below plug into this.
  - *Phase 1 — melee bump:* hits the one tile you moved into.
  - *Phase 2 — weapon patterns:* the player holds one weapon (starts with the sword). Walking over a weapon swaps it (the old one stays on that tile; no inventory screen). Attacks still happen only by walking into an enemy. Damage = `max(1, attack + bonus)`. Sidegrades: none is strictly best.
    | Weapon | Glyph | Hits | Bonus | Notes |
    |---|---|---|---|---|
    | Sword | `/` | The tile in front | 0 | Starting weapon |
    | Spear | `↑` | The tile in front + the one behind it | 0 | **Step and strike:** moving toward an enemy 2 tiles away (free tile in between) moves you 1 tile and attacks it in the same turn |
    | Axe | `Y` | All 8 tiles around you | −1 | **Spin:** waiting (Space / tap yourself) swings it if any enemy is among the 8 tiles; hits adjacent barrels too |
    | Hammer | `T` | The tile in front | −1 | Knockback 1 tile (§3.11). The −1 (audit balance pass) offsets how much control knockback + wall stuns give |
  - *Phase 2 — bomb:* instant and player-safe: a 3×3 explosion centred on the player that spares the player's tile. Barrels it sets off can still hurt you. `B` key or HUD button; stored as a counter.
  - *Phase 3a — throwing knives* `†`: ammo counter (start with 2; knife loot). Throw in a direction: **Shift + direction**, or **T** then a direction (T/Esc cancels); touch: the **† HUD button**, then tap a direction (tapping yourself or the button cancels). The knife flies until the next tile is a wall/door (lands on the last free tile) or holds something: 1 damage to it (shields block from the front; a barrel explodes — safe if it's ≥ 2 tiles away) and lands on that tile, to be picked up again. Throwing into an adjacent wall does nothing (no turn). While aiming, the 4 flight lines and their targets are previewed.
  - *Phase 3 (last) — free-aim targeting:* for thrown items/spells. Keyboard: a key opens a cursor on the nearest enemy, arrows move it, Enter confirms, Esc cancels. Mobile: tap the item button, tap a target tile, tap again to confirm. Limited range + line-of-sight check (shared with straight-line ranged and fog of war).

### 3.6 Enemy AI
- Once per turn, compute a BFS "distance-to-player" map for the whole floor. Walking enemies step to the neighbouring tile with the lowest distance.
- Enemies never share a tile, never step onto barrels, raised spikes or spikes about to rise. Their distance map treats those spikes as walls, so they **route around** spikes instead of waiting behind them (an enemy already standing on such a tile steps to any reachable neighbour). If the best tile is occupied, the enemy tries the next best or waits. Locked doors block their paths. (Pushed or charging enemies can still end up on spikes.)
- A stunned enemy skips its next action **and loses any announced move**.
- Enemies act one by one over a snapshot of the list (a bomber can kill others mid-phase).
- **Every big move is announced one turn ahead** (`intent`, red `!` on the enemy, red outline on the tiles it will hit). Fixed damage, no luck.

| Enemy | Glyph | HP | Damage | Cost | From floor | Behaviour |
|---|---|---|---|---|---|---|
| Rat | `r` | 2 | 1 | 1 | 1 | Melee: attacks when orthogonally adjacent, otherwise walks toward you |
| Ghoul | `g` | 4 | 2 | 2 | 3 | Melee |
| Brute | `B` | 6 | 3 | 4 | 6 | Melee |
| Slime | `s` | 4 | 1 | 3 | 2 | Melee. **Splits** when damaged but not killed: its remaining HP is shared by two slimelets (⌈r/2⌉ stays, ⌊r/2⌋ appears on the first free neighbour: up, right, down, left). Splits resolve after the current action. |
| Slimelet | small `s` | ≤ 2 | 1 | — | never spawned | Melee, doesn't split |
| Archer | `a` | 2 | 2 | 3 | 3 | Lined up with you (same row/column, ≤ 6 tiles, nothing in between) → **aims** (announced). Next turn **shoots** along that line: the arrow hits the first thing in it (you, an enemy, a barrel) even if you moved away. Never melees. |
| Charger | `C` | 5 | 3 | 4 | 4 | Lined up (≤ 8, clear line) → **lowers its head** (announced). Next turn **charges** until blocked and hits what it runs into for 3 (barrel explodes; shields block from the front). Runs into a wall/door → 1 impact damage and stunned. |
| Bomber | `x` | 2 | 3 (blast) | 3 | 5 | In the 8 tiles around you → **lights its fuse** (announced). Next turn **explodes** (normal explosion: 3×3, breaks inner walls, chains barrels, hurts everyone). Killed first = no explosion. |
| Shieldbearer | `S` | 4 | 2 | 4 | 6 | Melee. **Faces the way it last moved** (starts facing you; attacking doesn't turn it; bar drawn on the shield side) and **blocks weapon hits, knives, arrows and charges coming from the half it faces**. Counterplay: step diagonally away, it has to move to reach you and exposes its flank. Explosions, impacts and spikes aren't blocked; hammer knockback still pushes it. (It used to turn toward you after every action, which made it unbeatable in melee — the audit's biggest finding.) |

### 3.7 Turn Sequence
1. Player inputs an action.
2. Player action resolves (move, attack, push, open door, item). Invalid actions (walking into a wall) do not spend a turn. **If the action killed the player (an explosion or impact next to them), stop.** Stepping onto the stairs ends the floor immediately (enemies don't get a last move).
3. Enemies act one by one. **After each enemy, check the player's HP; at 0, stop immediately.**
4. Environment effects: timed spikes advance one phase; spikes rising under someone deal 2.
5. Autosave (§5).

Slime splits resolve after steps 2, 3 and 4, each followed by a death check.
6. Renderer redraws.

### 3.8 Progression & Items
- **Player start:** 20 HP, 2 attack, 2 knives.
- **Resting:** reaching the stairs heals `REST_HEAL` (3) HP, up to max HP. (Was 6 in Phase 1; lowered together with ~25% higher enemy budgets after playtests showed the run was too easy.)
- Enemy types and stats: §3.6.
- **Items** are picked up by stepping on them (everything on the tile; items can share a tile). No equipment slots.
  | Item | Glyph | Effect |
  |---|---|---|
  | Potion | `!` | Counter. Drink: heal 8 HP |
  | Bomb | `*` | Counter. See §3.5 |
  | Key | `⚷` | Counter, kept between floors. Opens one locked door `+` |
  | Whetstone | `≡` | +1 attack (permanent) |
  | Heart | `♥` | +4 max HP and heal 4 (permanent) |
  | Knife | `†` | Counter. Thrown ammo (§3.5), lands where it stops |
  | Weapons | `/ ↑ Y T` | Swap with the held weapon |
- **Counters shown in the HUD:** potions, bombs and knives (tappable buttons), keys.
- Loose loot weights: potion 2, bomb 3, knife 3, random weapon 1, heart 1 (floor 3+), whetstone 1 (floor 4+). (Potion was 5; the audit run ended with 8 unused potions.)
- Difficulty rises with depth through the floor config (`enemyBudget`, size, `vision`, special floors).

### 3.9 Fog of War (Phase 3, per floor)
- Controlled by the floor config's `vision`: `null` means the whole floor is visible (default, good for small floors). A number is the sight radius in tiles.
- Unseen tiles are black; seen tiles stay visible but dimmed; enemies are shown only while in sight. Walls block sight.
- Seen tiles are stored as a plain array in `state`.
- Fits the "Sunless" theme: deeper floors can get darker.

### 3.10 End States
- **Permadeath:** HP 0 → `dead` mode, save deleted, option to start a new run.
- **Victory:** reaching the Vault → `won` mode, save deleted.

### 3.11 Environment & Hazards (Phase 2–3a)
All damage goes through one routine, `SV.damageAt(state, x, y, amount, source, from)`, which hits whatever entity stands on a tile. `from` (the attacker's or thrower's tile) is only passed by weapon hits, knives, arrows and charges, so shields can check it; explosions, impacts and spikes pass none and can't be blocked.
- **Spikes** `^` (`state.traps: [{ x, y, timed, phase }]`, tiles stay walkable so they never block a path):
  - Fixed spikes are always up. Timed spikes (from floor 4) cycle every turn: phase 0 down (grey, safe) → phase 1 down but **rising at the end of this turn** (orange, red outline) → phase 2 up (red).
  - **Entering raised spikes: 2 damage. Spikes rising under someone: 2 damage.** Applies to the player and enemies (barrels ignore spikes).
  - Placed on distinct main-area tiles ≥ 2 steps from the start; count per floor in `FLOOR_PLAN.traps` (0 on floor 1 … 5 on floor 10), 50% timed from floor 4 with a random starting phase.
- **Explosive Barrels** `O`: destructible entities with 1 HP that block movement. Taking any damage makes them explode: 3 damage to every entity in the 3×3 around the barrel, and inner wall tiles in that 3×3 become floor.
  - **Kick & roll:** walking into a barrel kicks it (with any weapon): it rolls in a straight line until the next tile is blocked (wall, door, enemy, barrel), then explodes there. If it rolled at least 1 tile, you're outside the blast; if it was blocked right away, it explodes next to you. So barrels are a ranged weapon: line one up with enemies and kick. They can never permanently block a path.
  - Weapons only damage a barrel when you're right next to it (8 neighbours): the axe sweep does, the spear's second tile doesn't. Hammer-knocked enemies (impact), bombs and other explosions also set barrels off.
  - The outer border wall is indestructible (the board edge must stay closed).
  - Stairs, locked doors and items are unaffected (otherwise keys become pointless).
  - Chain reactions use a queue: a barrel caught in a blast explodes after the current one, and each barrel explodes only once (no infinite loops).
- **Push & Collision:** a pushed entity (e.g. Hammer knockback) moves 1 tile. If that tile holds a solid wall, a closed door or another entity, the push fails and:
  - The pushed entity takes 1 impact damage; if it hit another entity, that one takes 1 too (a barrel taking impact damage explodes).
  - A surviving pushed enemy is stunned (`stunned: 1`, drawn dimmed), skips its next action and loses any announced move. A successful push onto raised spikes hurts it. If the player is ever stunned (not possible yet), the enemies act twice.

## 4. Rendering & Layout

### 4.1 Layout: the board fills the screen
- The canvas takes all space left after a thin HUD and is resized when the window changes size.
  - Landscape: board centered, HUD as a narrow column on the side.
  - Portrait (phones): HUD on top, board below. On narrow phones the HUD may wrap to a second row (phones held upright have spare height) instead of hiding counters.
- **Tile size** = the largest multiple of 16 that fits the board area for the current floor (minimum 16). The board is drawn centered. This keeps pixel art even at every size.
- The canvas backing size is multiplied by `devicePixelRatio`, so it stays sharp on phones and high-DPI screens.
- Floor size never depends on screen shape: the same floor is equally hard on phone and desktop.

### 4.2 Minimal UI
- **HUD:** one compact line of icon + number: HP, floor, keys, turn (more counters added as items arrive).
- **Log:** only the last 2–3 messages, older ones fade out. No scrolling panel.
- **Help:** `?` overlay replaces a permanent controls footer. It shows the controls for the current input device (touch list or key list), a **Show hints** checkbox and a **New game** button.
- **Input mode** (UI only, not saved in `state`): starts as touch on devices without hover and with a coarse pointer, otherwise keys; switches to keys on any key press and to touch on any touch. Help and hints are worded accordingly.
- **Hint line:** one line above the log with the 1–2 most useful things you can do right now, worded for touch or keys, in priority order: descend / new run (map and end screens) → knife aiming instructions (while aiming) → warnings when you stand in an announced threat (archer line, charge lane, lit bomber, rising spikes) → a shield blocking your attack → attack available (bump, spear step-and-strike, axe spin) → kick an adjacent barrel (with a warning if it would blow up next to you) → unlock an adjacent door / find the key → drink a potion when HP ≤ 1/3 → throw a knife at an enemy in line → "floor clear: head for the stairs" → how to move and wait. It reuses the threat-preview analysis, so both always agree. Can be turned off in the help screen (stored per browser).
- **Weapon in the HUD:** name + damage (gold number); tappable for its description.

### 4.2b Threat preview (planning aid)
Positioning is the core strategy, so the board always shows what your next move would do. Drawn under the entities:
- **Faint gold:** every tile the held weapon can reach from where you stand (sword: 4 around you; spear: 4 + the tiles 2 away; axe: all 8).
- **Bright gold:** tiles your next key press would hit right now: an enemy next to you (bump), a spear step-and-strike on an enemy 2 tiles away, or an axe spin when any enemy is among the 8 tiles.
- **Gold HP pips:** the damage an enemy would take from that attack; all gold = it dies.
- **Barrels:** next to you in a straight line → its roll path and the 3×3 blast where it would stop (orange; red if you'd be inside). Diagonally next to you → red blast zone (a bomb would catch you). Hit by your attack → its blast zone.
- **Shields:** an attack into a shieldbearer's front shows no gold pips (it would be blocked).
- **Knife aim mode:** the 4 flight lines (faint) and what each would hit (bright), replacing the weapon preview.
- **Enemy side, kept light** (a first version outlined every threatened tile on the board and was too crowded):
  - **Red dots near you:** your own tile and the 4 tiles you can step to get a small red dot if ending your turn there would hurt you (next to a melee enemy, in an archer's line or a charge lane, in a lit bomber's 3×3, on spikes about to rise; for the neighbours also on raised spikes). Nothing is marked around enemies elsewhere.
  - **Announced big moves, drawn anywhere:** an aiming archer → thin red line with an arrowhead where the arrow stops; a charger winding up → dashed red line along its lane; a lit bomber → faint red tint over its 3×3. Those enemies also carry a red `!`.
  - Raised spikes are a red `^`, rising ones orange.

### 4.3 Drawing
- **Phase 1–3:** glyph renderer only (ASCII/Unicode characters with colors, drawn on the canvas).
- Every drawable thing has an entry in one `appearance` table (`glyph`, `color`, later `sprite`). The renderer only reads this table.
- **Phase 4:** add 16×16 pixel-art sprites by filling in `sprite` in the `appearance` table. Set `ctx.imageSmoothingEnabled = false` (CSS `image-rendering` only affects how the canvas element is scaled, not images drawn into it). No runtime "fallback mode".
- **Optional mood (Phase 4):** toggleable CSS scanline + vignette overlay for a vintage CRT feel. No 4:3 constraint.

## 5. Save System (Autosave)
- After every completed turn and every mode change: `localStorage["sunless-vault-save"] = JSON.stringify({ version: SAVE_VERSION, state })`.
- On page load: if a save exists and its `version` matches `SAVE_VERSION`, resume it (on the map screen or mid-floor, as saved). Otherwise start a new run.
- The RNG's current value is part of `state`, so a restored game continues exactly as it would have. Refreshing mid-fight restores the same turn; it can't be used to undo a move.
- The save is deleted on death and on victory.
- Bump `SAVE_VERSION` whenever the shape of `state` changes during development, so old saves are discarded instead of crashing the game.
- Every `localStorage` call is wrapped in `try/catch`. If storage is unavailable (private window, blocked), the game runs normally without saving.
- Limits: clearing browser data deletes the save; saves are per browser.

## 6. Debugging
- `state.debug` is toggled with the key left of `1` (matched by position, `e.code === 'Backquote'`: `~` on US keyboards, `\` on Italian ones; the `` ` `` / `~` characters also work) or `SV.toggleDebug()` from the browser console. The HUD shows `DEBUG` (`DEBUG·GOD` with god mode) while it's on. Debug stays on when starting a new run.
- **Debug keys** (only while debug is on):
  - `G`: toggle infinite HP (god mode, `state.godMode`): damage to the player is ignored.
  - `F`: toggle full map visibility (`state.fullVision`, bypasses fog of war; no effect until fog exists in Phase 3).
  - `N`: instantly clear the current floor and descend to the next node (from the run map it skips the next floor).
- Every debug action logs to the browser console with a `[DEBUG]` prefix.
- `state.debugUsed` becomes true the first time debug is turned on in a run and never resets, so that run can't record a best score (Phase 5).
- `SV.getState()` in the browser console returns the live game state for inspection.

## 7. Development Roadmap
- [x] **Phase 1 (MVP):** seeded RNG, full-screen canvas layout + compact HUD/log, floor generation with reachability check (variable size), player movement (keyboard + tap), BFS enemy pathing, bump combat with fixed damage, stairs, linear run map screen, game over / restart, victory at the Vault, autosave/resume, `?` help overlay, debug tools.
- [x] **Phase 2 (Items & Hazards):** potions, keys + locked doors, stat pickups, weapon patterns (sword/spear/axe/hammer), area consumables (bomb), push & collision, explosive barrels.
- [x] **Phase 2.1 (Playtest fixes):** weapon damage + description in the HUD, threat preview, kick & roll barrels, spear step-and-strike, axe spin, weapons hit barrels only when adjacent, harder numbers (rest heal 3, enemy budgets +25%), device-aware help with New game button, contextual hint line.
- [x] **Phase 3a (Combat depth):** slime, archer, charger, bomber, shieldbearer (announced moves), fixed and timed spikes, throwing knives, enemy-threat display (red dots near you + announced-move lines, after a first "outline everything" version proved too crowded) and warning hints (save version 3).
- [x] **Phase 3a.1 (Audit balance pass):** shieldbearer faces the way it last moved (flankable), potion loot weight 5 → 2, hammer −1 damage, enemies route around dangerous spikes, log grammar fixes, outlined item glyphs.
- [ ] **Phase 3b (Exploration):** per-floor fog of war, branching run map, then free-aim targeting. Candidates from the audit: a light/torch that burns down per turn (time pressure against kiting and slow play), a reason to fight (drops or score).
- [ ] **Phase 4 (Polish):** sprite rendering via the `appearance` table, sound effects via Web Audio API, optional CRT overlay.
- [ ] **Phase 5 (Endless Mode):** nodes generated on the fly, score = deepest floor, best score saved in `localStorage`, difficulty scaling beyond floor `FLOOR_COUNT`.

## 8. Development Workflow & Current Status
*Handoff notes so a new session can continue without the chat history. Update this section at the end of each phase.*

### 8.1 How we work
- The owner is not a professional developer: explain choices in plain language, discuss design options (with a recommendation) before building, and keep this file as the single source of truth for rules and decisions.
- Each phase: agree the design → plan → implement → verify (tools below + browser) → update this file → commit and push **only when the owner asks**.
- Repo: `github.com/dvlabdev/sunless-vault`, branch `main`.

### 8.2 Test tools (Node, no dependencies; run from the project folder)
| Command | What it checks |
|---|---|
| `node tools/gen-test.js` | 300 seeds × 10 floors: sizes, border, reachability, closets/keys, distinct placement of everything, trap rules, enemy depths, determinism. Expect `0 problems`. |
| `node tools/ai-test.js` | ~35 rule checks on hand-built boards: every enemy type, shields/flanking, splits, knives, barrels, spikes, hammer. Expect `ALL PASSED`. |
| `node tools/sim.js [runs]` | Bot playtests (a "rusher" and a "fighter", one-turn lookahead) over many seeds: win rate, death floors, HP per floor, damage by source, items found/used. `DUMP=1` prints boards where a bot gets stuck. Use to compare versions, not as human win rates. It mirrors the turn sequence of `src/main.js`: keep it in sync. |
- Browser testing: `.claude/launch.json` (git-ignored) defines a `static` server (`py -m http.server 5173`); `?seed=N` in the address replays a run; `SV.getState()` in the console inspects/edits the live state.

### 8.3 Status after Phase 3a.1 (audit balance pass)
- **Audit method:** one full hand-played run (seed 2026, won: 292 turns, 32 kills, never below 17 HP, 8 potions unused) + 200 bot runs per style.
- **Bot results before → after the balance pass:** rusher win 45% → 61%, fighter 31% → 60.5%; shieldbearer damage per run 9.6 → 4.1 (rusher) and 17.9 → 4.3 (fighter); potions found per run 2.4 → 1.3 / 3.6 → 2.2.
- **Still open (from the audit), in suggested order:**
  1. **No pressure in the early/mid game:** HP when leaving floors 1–9 is still ≈ full; deaths only happen on floors 6–10.
  2. **Kiting:** a melee enemy that steps next to you can't attack that turn, so a player who keeps moving is never hit by chasers; with no time cost, slow safe play (chokepoints, walking to the stairs) dominates. Proposed fix: a **light/torch meter** that burns down each turn and refills at the stairs (darkness hurts when it runs out) — fits the theme and Phase 3b fog of war.
  3. **No reason to fight:** kills give nothing. Options: occasional drops, or a score (kills/turns) on the victory screen.
  4. The "ambush" floor doesn't ambush (its budget buys ~2 enemies): spawn them around the player.
  5. Chargers are slow to kill (~20 turns of dodging); hammer knockback can still keep a melee enemy away indefinitely on open ground.
  6. Phone portrait: tiles are ~24 px with unused vertical space; use it for bigger tiles.
- **Next phase:** 3b (fog of war, branching run map, free aim) — decide first whether the light meter (item 2) goes in with it.
