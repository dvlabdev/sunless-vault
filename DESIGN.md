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
- Walking into: an enemy attacks it; a barrel pushes it (you follow it if it moves); a locked door opens it if you have a key (costs a turn; without a key nothing happens and no turn is spent).
- `P` / `!` HUD button: drink a potion. `B` / `*` HUD button: use a bomb. Both cost a turn; with none left (or at full HP for potions) nothing happens.
- Enter / tap: descend from the run map; start a new run from the death or victory screen.
- `?` or `H` key / `?` button: help overlay (controls). Shown automatically on the first run.
- `R`: abandon the run and start a new game (with confirmation).
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
    | Spear | `↑` | The tile in front + the one behind it | 0 | Can detonate a barrel 2 tiles away |
    | Axe | `Y` | All 8 tiles around you | −1 | Also hits adjacent barrels |
    | Hammer | `T` | The tile in front | 0 | Knockback 1 tile (§3.11) |
  - *Phase 2 — bomb:* instant and player-safe: a 3×3 explosion centred on the player that spares the player's tile. Barrels it sets off can still hurt you. `B` key or HUD button; stored as a counter.
  - *Phase 3 — straight-line ranged:* Shift + direction (keyboard) or tap an enemy on the same row/column (mobile). The shot travels until it hits a wall or an enemy. Uses ammo. Ranged enemies (archers) show their aim line one turn before firing.
  - *Phase 3 (last) — free-aim targeting:* for thrown items/spells. Keyboard: a key opens a cursor on the nearest enemy, arrows move it, Enter confirms, Esc cancels. Mobile: tap the item button, tap a target tile, tap again to confirm. Limited range + line-of-sight check (shared with straight-line ranged and fog of war).

### 3.6 Enemy AI
- Once per turn, compute a BFS "distance-to-player" map for the whole floor. Each enemy steps to the neighbouring tile with the lowest distance; if it's adjacent to the player, it attacks instead.
- Enemies never share a tile and never step onto barrels. If the best tile is occupied, the enemy tries the next best or waits. Locked doors block their paths.
- A stunned enemy skips its next action.

### 3.7 Turn Sequence
1. Player inputs an action.
2. Player action resolves (move, attack, push, open door, item). Invalid actions (walking into a wall) do not spend a turn. **If the action killed the player (an explosion or impact next to them), stop.** Stepping onto the stairs ends the floor immediately (enemies don't get a last move).
3. Enemies act one by one. **After each enemy, check the player's HP; at 0, stop immediately.**
4. Environment effects trigger (traps, status ticks).
5. Autosave (§5).
6. Renderer redraws.

### 3.8 Progression & Items
- **Player start:** 20 HP, 2 attack.
- **Resting:** reaching the stairs heals `REST_HEAL` (6) HP, up to max HP.
- **Phase 1 enemies** (same behaviour, different stats; real archetypes come in Phase 3):
  | Enemy | HP | Attack | Budget cost | From floor |
  |---|---|---|---|---|
  | Rat `r` | 2 | 1 | 1 | 1 |
  | Ghoul `g` | 4 | 2 | 2 | 3 |
  | Brute `B` | 6 | 3 | 4 | 6 |
- **Items** are picked up by stepping on them. No equipment slots.
  | Item | Glyph | Effect |
  |---|---|---|
  | Potion | `!` | Counter. Drink: heal 8 HP |
  | Bomb | `*` | Counter. See §3.5 |
  | Key | `⚷` | Counter, kept between floors. Opens one locked door `+` |
  | Whetstone | `≡` | +1 attack (permanent) |
  | Heart | `♥` | +4 max HP and heal 4 (permanent) |
  | Weapons | `/ ↑ Y T` | Swap with the held weapon |
- **Counters shown in the HUD:** potions and bombs (tappable buttons), keys; ammo arrives with ranged attacks in Phase 3.
- Difficulty rises with depth through the floor config (`enemyBudget`, size, `vision`, special floors).

### 3.9 Fog of War (Phase 3, per floor)
- Controlled by the floor config's `vision`: `null` means the whole floor is visible (default, good for small floors). A number is the sight radius in tiles.
- Unseen tiles are black; seen tiles stay visible but dimmed; enemies are shown only while in sight. Walls block sight.
- Seen tiles are stored as a plain array in `state`.
- Fits the "Sunless" theme: deeper floors can get darker.

### 3.10 End States
- **Permadeath:** HP 0 → `dead` mode, save deleted, option to start a new run.
- **Victory:** reaching the Vault → `won` mode, save deleted.

### 3.11 Environment & Hazards (Phase 2)
All damage goes through one routine, `SV.damageAt(state, x, y, amount, source)`, which hits whatever entity stands on a tile. Barrels, bombs, knockback and collisions all use it.
- **Explosive Barrels** `O`: destructible entities with 1 HP that block movement. Taking any damage makes them explode: 3 damage to every entity in the 3×3 around the barrel, and inner wall tiles in that 3×3 become floor.
  - **Walking into a barrel pushes it** (with any weapon) instead of attacking it; you follow it if it moves. Weapon sweeps (axe), spear reach, bombs, other explosions and impacts damage it. A barrel that can't move takes impact damage and explodes where it stands, so a barrel can never permanently block a path.
  - The outer border wall is indestructible (the board edge must stay closed).
  - Stairs, locked doors and items are unaffected (otherwise keys become pointless).
  - Chain reactions use a queue: a barrel caught in a blast explodes after the current one, and each barrel explodes only once (no infinite loops).
- **Push & Collision:** a pushed entity (e.g. Hammer knockback) moves 1 tile. If that tile holds a solid wall, a closed door or another entity, the push fails and:
  - The pushed entity takes 1 impact damage; if it hit another entity, that one takes 1 too (a barrel taking impact damage explodes).
  - A surviving pushed enemy is stunned (`stunned: 1`, drawn dimmed) and skips its next action. If the player is ever stunned (only possible once enemies can push, Phase 3), the enemies act twice.

## 4. Rendering & Layout

### 4.1 Layout: the board fills the screen
- The canvas takes all space left after a thin HUD and is resized when the window changes size.
  - Landscape: board centered, HUD as a narrow column on the side.
  - Portrait (phones): one-line HUD on top, board below.
- **Tile size** = the largest multiple of 16 that fits the board area for the current floor (minimum 16). The board is drawn centered. This keeps pixel art even at every size.
- The canvas backing size is multiplied by `devicePixelRatio`, so it stays sharp on phones and high-DPI screens.
- Floor size never depends on screen shape: the same floor is equally hard on phone and desktop.

### 4.2 Minimal UI
- **HUD:** one compact line of icon + number: HP, floor, keys, turn (more counters added as items arrive).
- **Log:** only the last 2–3 messages, older ones fade out. No scrolling panel.
- **Help:** `?` overlay replaces a permanent controls footer.

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
- [ ] **Phase 3 (Depth):** multiple enemy archetypes incl. archers, room hazards, straight-line ranged attacks, per-floor fog of war, branching run map, then free-aim targeting.
- [ ] **Phase 4 (Polish):** sprite rendering via the `appearance` table, sound effects via Web Audio API, optional CRT overlay.
- [ ] **Phase 5 (Endless Mode):** nodes generated on the fly, score = deepest floor, best score saved in `localStorage`, difficulty scaling beyond floor `FLOOR_COUNT`.
