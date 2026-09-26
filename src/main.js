// Game flow: run/floor transitions, the turn sequence, input, save/load, debug.
// Loaded last: every other SV.* function exists by now.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    const SAVE_KEY = 'sunless-vault-save';
    const SAVE_VERSION = 3;          // bump whenever the shape of `state` changes
    const HELP_SEEN_KEY = 'sunless-vault-help-seen';
    const HINTS_KEY = 'sunless-vault-hints';
    const REST_HEAL = 3;             // HP recovered between floors
    const POTION_HEAL = 8;
    const HEART_BONUS = 4;           // +max HP and heal
    const LOG_LIMIT = 30;

    const KEY_DIRS = {
        ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1], ArrowLeft: [-1, 0],
        w: [0, -1], d: [1, 0], s: [0, 1], a: [-1, 0],
    };

    const canvas = document.getElementById('game-canvas');
    const helpOverlay = document.getElementById('help-overlay');
    const helpButton = document.getElementById('help-button');
    const helpClose = document.getElementById('help-close');
    const newGameButton = document.getElementById('new-game');
    const hintsToggle = document.getElementById('hints-toggle');
    const weaponButton = document.getElementById('weapon-button');
    const potionButton = document.getElementById('potion-button');
    const bombButton = document.getElementById('bomb-button');
    const knifeButton = document.getElementById('knife-button');

    let state = null;
    let inputLockedUntil = 0; // brief pause after screen changes, so a held key or double tap doesn't skip them

    SV.log = function (st, text, cls) {
        st.log.push({ text, cls: cls || '' });
        if (st.log.length > LOG_LIMIT) st.log.shift();
    };

    // For inspecting the game from the browser console.
    SV.getState = function () {
        return state;
    };

    // ---- Run flow ---------------------------------------------------------

    function newRun(seed) {
        const s = {
            seed, rng: seed, mode: 'map', turn: 0, kills: 0, nextId: 1, killedBy: null,
            debug: false, debugUsed: false, godMode: false, fullVision: false,
            run: SV.buildRun(seed),
            player: SV.makePlayer(),
            map: null,
            enemies: [],
            items: [],
            barrels: [],
            traps: [],
            log: [],
        };
        SV.log(s, `A new descent begins. Seed ${seed}.`, 'system');
        return s;
    }

    function startNewRun(seed) {
        const previous = state;
        state = newRun(seed === undefined ? SV.newSeed() : seed);
        if (previous && previous.debug) { // keep debugging across runs
            state.debug = state.debugUsed = true;
            state.godMode = previous.godMode;
            state.fullVision = previous.fullVision;
        }
        saveGame();
        render();
    }

    function requestNewRun() {
        if (state.mode === 'dead' || state.mode === 'won' || window.confirm('Abandon this run and start a new one?')) {
            startNewRun();
        }
    }

    function currentNode() {
        return state.run.nodes[state.run.current];
    }

    function enterFloor() {
        const node = currentNode();
        const floor = SV.generateFloor(node.floor, node.seed, node.depth);
        state.map = floor.map;
        state.enemies = floor.enemies.map(e => SV.makeEnemy(state, e.type, e.x, e.y));
        state.items = floor.items.map(i => SV.makeItem(state, i.kind, i.x, i.y));
        state.barrels = floor.barrels.map(b => SV.makeBarrel(state, b.x, b.y));
        state.traps = floor.traps.map(t => Object.assign({}, t));
        state.player.x = floor.start.x;
        state.player.y = floor.start.y;
        state.enemies.forEach(e => { if (e.facing) SV.faceToward(e, state.player.x, state.player.y); });
        SV.aiming = false;
        state.mode = 'floor';
        SV.log(state, `Floor ${node.depth}. Find the stairs (>).`, 'system');
        if (node.floor.special === 'ambush') SV.log(state, 'Something is waiting for you here...', 'combat-enemy');
        saveGame();
        render();
    }

    function completeFloor() {
        const node = currentNode();
        node.status = 'cleared';
        state.run.current = node.next[0];
        state.map = null;
        state.enemies = [];
        state.items = [];
        state.barrels = [];
        state.traps = [];
        SV.aiming = false;
        const next = currentNode();
        next.status = 'current';

        if (next.type === 'vault') {
            SV.log(state, 'You step into the Sunless Vault.', 'item');
            endRun('won');
            return;
        }

        const p = state.player;
        const healed = Math.min(REST_HEAL, p.maxHp - p.hp);
        p.hp += healed;
        SV.log(state, healed > 0 ? `You rest on the stairs (+${healed} HP).` : 'You descend deeper.', 'system');
        state.mode = 'map';
        lockInput(400);
        saveGame();
        render();
    }

    function endRun(mode) {
        state.mode = mode;
        clearSave();
        lockInput(800);
        render();
    }

    function lockInput(ms) {
        inputLockedUntil = performance.now() + ms;
    }

    // ---- Turn sequence ----------------------------------------------------

    // 1-2. Player action. dx = dy = 0 means "wait a turn".
    function playerAction(dx, dy) {
        const p = state.player;
        if (dx !== 0 || dy !== 0) {
            const nx = p.x + dx;
            const ny = p.y + dy;
            const barrel = SV.barrelAt(state, nx, ny);
            if (SV.enemyAt(state, nx, ny)) {
                SV.playerAttack(state, dx, dy);
            } else if (barrel) {
                SV.kickBarrel(state, barrel, dx, dy);
            } else if (SV.tileAt(state.map, nx, ny) === SV.TILE.DOOR) {
                if (p.keys === 0) {
                    SV.log(state, 'The door is locked. You need a key.', 'system');
                    render();
                    return; // no turn spent
                }
                p.keys--;
                state.map.tiles[ny * state.map.width + nx] = SV.TILE.FLOOR;
                SV.log(state, 'You unlock the door.', 'item');
            } else if (SV.isWalkable(state.map, nx, ny)) {
                moveTo(nx, ny);
                // Spear: stepping toward an enemy 2 tiles away strikes it.
                if (SV.WEAPONS[p.weapon].lunge && SV.enemyAt(state, p.x + dx, p.y + dy)) SV.playerAttack(state, dx, dy);
            } else {
                return; // bumping a wall costs no turn
            }
        } else if (SV.WEAPONS[p.weapon].spin && SV.enemyAround(state)) {
            SV.playerAttack(state, 0, 0); // axe: waiting swings it
        }
        finishTurn();
    }

    function drinkPotion() {
        const p = state.player;
        if (p.potions === 0) {
            SV.log(state, 'You have no potions.', 'system');
        } else if (p.hp === p.maxHp) {
            SV.log(state, 'You are already at full health.', 'system');
        } else {
            const healed = Math.min(POTION_HEAL, p.maxHp - p.hp);
            p.potions--;
            p.hp += healed;
            SV.log(state, `You drink a potion (+${healed} HP).`, 'item');
            finishTurn();
            return;
        }
        render(); // no turn spent
    }

    function throwBomb() {
        if (state.player.bombs === 0) {
            SV.log(state, 'You have no bombs.', 'system');
            render();
            return;
        }
        SV.useBomb(state);
        finishTurn();
    }

    function moveTo(x, y) {
        const p = state.player;
        p.x = x;
        p.y = y;
        pickUp();
        SV.enterTile(state, x, y); // raised spikes
    }

    // Stepping onto a tile picks up everything on it. Weapons swap: the old one stays on the floor.
    function pickUp() {
        const p = state.player;
        let swapped = false;
        for (const item of state.items.filter(i => i.x === p.x && i.y === p.y)) {
            if (SV.WEAPONS[item.kind]) {
                if (swapped || item.kind === p.weapon) continue;
                const old = p.weapon;
                p.weapon = item.kind;
                item.kind = old;
                swapped = true;
                SV.log(state, `You take the ${p.weapon} and drop the ${old}.`, 'item');
                describeWeapon();
                continue;
            }
            state.items = state.items.filter(i => i !== item);
            collect(item.kind);
        }
    }

    function collect(kind) {
        const p = state.player;
        if (kind === 'knife') {
            p.knives++;
            SV.log(state, 'You pick up a knife.', 'item');
        } else if (kind === 'potion') {
            p.potions++;
            SV.log(state, 'You pick up a potion.', 'item');
        } else if (kind === 'bomb') {
            p.bombs++;
            SV.log(state, 'You pick up a bomb.', 'item');
        } else if (kind === 'key') {
            p.keys++;
            SV.log(state, 'You pick up a key.', 'item');
        } else if (kind === 'whetstone') {
            p.atk++;
            SV.log(state, `A whetstone! Your attack rises to ${p.atk}.`, 'item');
        } else if (kind === 'heart') {
            p.maxHp += HEART_BONUS;
            p.hp += HEART_BONUS;
            SV.log(state, `A heart! Max HP +${HEART_BONUS}.`, 'item');
        }
    }

    // Log line such as "Spear (2 damage): hits the tile in front and the one behind it."
    function describeWeapon() {
        const p = state.player;
        const weapon = SV.WEAPONS[p.weapon];
        const name = weapon.name.charAt(0).toUpperCase() + weapon.name.slice(1);
        SV.log(state, `${name} (${SV.weaponDamage(p)} damage): ${weapon.desc}.`, 'system');
    }

    // After any action that spends a turn.
    function finishTurn() {
        const p = state.player;
        state.turn++;
        SV.aiming = false;

        // Your own action can kill you (an explosion, impact or spikes).
        SV.resolveSplits(state);
        if (p.hp <= 0) return die();

        // Stairs end the floor immediately: enemies don't get a last move.
        if (SV.tileAt(state.map, p.x, p.y) === SV.TILE.STAIRS) {
            completeFloor();
            return;
        }

        // 3. Enemies (stops as soon as the player dies)
        SV.enemiesAct(state);
        SV.resolveSplits(state);
        if (p.hp <= 0) return die();

        // 4. Environment: timed spikes move; rising spikes hurt whoever stands on them.
        SV.tickTraps(state);
        SV.resolveSplits(state);
        if (p.hp <= 0) return die();

        // 5-6. Autosave and redraw
        saveGame();
        render();
    }

    // Knives: Shift+direction, T then a direction, or the knife button then a tap.
    function throwKnife(dx, dy) {
        SV.aiming = false;
        if (state.player.knives === 0) {
            SV.log(state, 'You have no knives.', 'system');
            render();
            return;
        }
        if (SV.throwKnife(state, dx, dy)) finishTurn();
        else render(); // no room: no turn spent
    }

    function toggleAiming() {
        if (state.mode !== 'floor') return;
        if (!SV.aiming && state.player.knives === 0) {
            SV.log(state, 'You have no knives.', 'system');
        } else {
            SV.aiming = !SV.aiming;
        }
        render();
    }

    function die() {
        SV.log(state, `You were slain by ${state.killedBy} on floor ${currentNode().depth}.`, 'combat-enemy');
        endRun('dead');
    }

    // ---- Debug ------------------------------------------------------------

    SV.toggleDebug = function () {
        state.debug = !state.debug;
        if (state.debug) state.debugUsed = true; // this run can never record a best score
        debugLog(`Debug mode ${state.debug ? 'ON' : 'OFF'}.`);
        saveGame();
        render();
        return state.debug;
    };

    function debugLog(message) {
        console.log(`[DEBUG] ${message}`);
    }

    // Returns true if the key was a debug command.
    function handleDebugKey(key) {
        if (key === 'g') {
            state.godMode = !state.godMode;
            debugLog(`God mode ${state.godMode ? 'ON' : 'OFF'}.`);
        } else if (key === 'f') {
            state.fullVision = !state.fullVision;
            debugLog(`Full visibility ${state.fullVision ? 'ON' : 'OFF'} (no effect until fog of war exists, Phase 3).`);
        } else if (key === 'n') {
            if (state.mode === 'map') enterFloor();
            if (state.mode !== 'floor') return true;
            debugLog(`Skipping floor ${currentNode().depth}.`);
            completeFloor();
            return true;
        } else {
            return false;
        }
        saveGame();
        render();
        return true;
    }

    // ---- Input ------------------------------------------------------------

    // Controls are explained for touch or keys depending on what was used last.
    function setInputMode(mode) {
        if (SV.inputMode === mode) return;
        SV.inputMode = mode;
        document.body.classList.toggle('touch', mode === 'touch');
        document.body.classList.toggle('keys', mode === 'keys');
        if (state) render();
    }

    document.addEventListener('pointerdown', (e) => {
        setInputMode(e.pointerType === 'touch' ? 'touch' : 'keys');
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) return; // leave browser shortcuts alone
        setInputMode('keys');
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

        if (!helpOverlay.hidden) {
            if (['Escape', 'Enter', ' ', '?', 'h'].includes(key)) {
                e.preventDefault();
                hideHelp();
            }
            return;
        }
        if (key === '?' || key === 'h') {
            e.preventDefault();
            showHelp();
            return;
        }
        // The key left of "1" (~ on US keyboards, \ on Italian ones), by position;
        // the characters are a fallback for keyboards that don't report positions.
        if (e.code === 'Backquote' || key === '`' || key === '~') {
            e.preventDefault();
            SV.toggleDebug();
            return;
        }
        if (state.debug && handleDebugKey(key)) {
            e.preventDefault();
            return;
        }
        if (performance.now() < inputLockedUntil) {
            e.preventDefault();
            return;
        }
        if (key === 'r') {
            e.preventDefault();
            requestNewRun();
            return;
        }
        if (key === 'i') {
            e.preventDefault();
            describeWeapon();
            render();
            return;
        }

        if (state.mode === 'floor') {
            const dir = KEY_DIRS[key];
            // Knives: Shift+direction, or T (aim) then a direction; T/Esc cancels aiming.
            if (dir && (e.shiftKey || SV.aiming)) {
                e.preventDefault();
                throwKnife(dir[0], dir[1]);
                return;
            }
            if (key === 't' || (key === 'Escape' && SV.aiming)) {
                e.preventDefault();
                toggleAiming();
                return;
            }
            SV.aiming = false; // any other action cancels aiming
            if (dir) {
                e.preventDefault();
                playerAction(dir[0], dir[1]);
            } else if (key === ' ') {
                e.preventDefault();
                playerAction(0, 0);
            } else if (key === 'p') {
                e.preventDefault();
                drinkPotion();
            } else if (key === 'b') {
                e.preventDefault();
                throwBomb();
            }
        } else if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            if (state.mode === 'map') enterFloor();
            else startNewRun();
        }
    });

    // Tap / click. On a floor: step toward the tap (tap yourself = wait).
    canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (performance.now() < inputLockedUntil) return;

        if (state.mode === 'map') {
            enterFloor();
        } else if (state.mode === 'dead' || state.mode === 'won') {
            startNewRun();
        } else if (state.mode === 'floor') {
            const rect = canvas.getBoundingClientRect();
            const px = (e.clientX - rect.left) * (canvas.width / rect.width);
            const py = (e.clientY - rect.top) * (canvas.height / rect.height);
            const dx = Math.floor((px - SV.view.ox) / SV.view.tile) - state.player.x;
            const dy = Math.floor((py - SV.view.oy) / SV.view.tile) - state.player.y;
            if (SV.aiming) {
                // Aiming a knife: throw toward the tap (tapping yourself cancels).
                if (dx === 0 && dy === 0) toggleAiming();
                else if (Math.abs(dx) >= Math.abs(dy)) throwKnife(Math.sign(dx), 0);
                else throwKnife(0, Math.sign(dy));
            } else if (dx === 0 && dy === 0) playerAction(0, 0);
            else if (Math.abs(dx) >= Math.abs(dy)) playerAction(Math.sign(dx), 0);
            else playerAction(0, Math.sign(dy));
        }
    });

    function showHelp() {
        helpOverlay.hidden = false;
    }

    function hideHelp() {
        helpOverlay.hidden = true;
    }

    // blur() so a later Space/Enter doesn't "click" the focused button again.
    helpButton.addEventListener('click', () => {
        helpButton.blur();
        if (helpOverlay.hidden) showHelp();
        else hideHelp();
    });
    helpClose.addEventListener('click', () => {
        helpClose.blur();
        hideHelp();
    });
    helpOverlay.addEventListener('click', (e) => {
        if (e.target === helpOverlay) hideHelp(); // tap outside the panel
    });
    // New game lives in the help screen too, so touch players can abandon a run.
    newGameButton.addEventListener('click', () => {
        newGameButton.blur();
        hideHelp();
        requestNewRun();
    });
    hintsToggle.addEventListener('change', () => {
        SV.hintsOn = hintsToggle.checked;
        storageSet(HINTS_KEY, SV.hintsOn ? 'on' : 'off');
        render();
    });

    // HUD buttons (mainly for touch screens): same as I, P and B.
    weaponButton.addEventListener('click', () => {
        weaponButton.blur();
        describeWeapon();
        render();
    });
    potionButton.addEventListener('click', () => {
        potionButton.blur();
        SV.aiming = false;
        if (state.mode === 'floor' && performance.now() >= inputLockedUntil) drinkPotion();
    });
    bombButton.addEventListener('click', () => {
        bombButton.blur();
        SV.aiming = false;
        if (state.mode === 'floor' && performance.now() >= inputLockedUntil) throwBomb();
    });
    knifeButton.addEventListener('click', () => {
        knifeButton.blur();
        if (performance.now() >= inputLockedUntil) toggleAiming();
    });

    // ---- Save / load (any storage failure = play without saving) ----------

    function saveGame() {
        if (state.mode === 'dead' || state.mode === 'won') return;
        storageSet(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, state }));
    }

    function loadGame() {
        const raw = storageGet(SAVE_KEY);
        if (!raw) return null;
        try {
            const data = JSON.parse(raw);
            return data && data.version === SAVE_VERSION && data.state ? data.state : null;
        } catch (err) {
            return null;
        }
    }

    function clearSave() {
        try {
            localStorage.removeItem(SAVE_KEY);
        } catch (err) { /* storage unavailable */ }
    }

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (err) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (err) { /* storage unavailable */ }
    }

    // ---- Start ------------------------------------------------------------

    function render() {
        SV.render(state);
    }

    function init() {
        // ?seed=123 in the address starts that exact run (for reproducing bugs).
        const seedParam = new URLSearchParams(window.location.search).get('seed');
        if (seedParam) {
            state = newRun(Number(seedParam) >>> 0);
        } else {
            state = loadGame();
            if (state) SV.log(state, 'Welcome back.', 'system');
            else state = newRun(SV.newSeed());
        }

        SV.aiming = false; // knife aim mode (UI only, never saved)
        SV.inputMode = null;
        setInputMode(window.matchMedia('(hover: none) and (pointer: coarse)').matches ? 'touch' : 'keys');
        SV.hintsOn = storageGet(HINTS_KEY) !== 'off';
        hintsToggle.checked = SV.hintsOn;

        if (!storageGet(HELP_SEEN_KEY)) {
            showHelp();
            storageSet(HELP_SEEN_KEY, '1');
        }

        SV.resizeCanvas();
        new ResizeObserver(() => {
            SV.resizeCanvas();
            render();
        }).observe(canvas);
        saveGame();
        render();
    }

    init();
})();
