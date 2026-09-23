// Game flow: run/floor transitions, the turn sequence, input, save/load, debug.
// Loaded last: every other SV.* function exists by now.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    const SAVE_KEY = 'sunless-vault-save';
    const SAVE_VERSION = 1;          // bump whenever the shape of `state` changes
    const HELP_SEEN_KEY = 'sunless-vault-help-seen';
    const REST_HEAL = 6;             // HP recovered between floors (potions arrive in Phase 2)
    const LOG_LIMIT = 30;

    const KEY_DIRS = {
        ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1], ArrowLeft: [-1, 0],
        w: [0, -1], d: [1, 0], s: [0, 1], a: [-1, 0],
    };

    const canvas = document.getElementById('game-canvas');
    const helpOverlay = document.getElementById('help-overlay');
    const helpButton = document.getElementById('help-button');
    const helpClose = document.getElementById('help-close');

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
        state.player.x = floor.start.x;
        state.player.y = floor.start.y;
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

    // dx = dy = 0 means "wait a turn".
    function playerAction(dx, dy) {
        const p = state.player;

        // 1-2. Player action
        if (dx !== 0 || dy !== 0) {
            const nx = p.x + dx;
            const ny = p.y + dy;
            if (SV.enemyAt(state, nx, ny)) {
                SV.playerAttack(state, SV.PATTERNS.melee(p.x, p.y, dx, dy));
            } else if (SV.isWalkable(state.map, nx, ny)) {
                p.x = nx;
                p.y = ny;
            } else {
                return; // bumping a wall costs no turn
            }
        }
        state.turn++;

        // Stairs end the floor immediately: enemies don't get a last move.
        if (SV.tileAt(state.map, p.x, p.y) === SV.TILE.STAIRS) {
            completeFloor();
            return;
        }

        // 3. Enemies (stops as soon as the player dies)
        SV.enemiesAct(state);
        if (p.hp <= 0) {
            SV.log(state, `You were slain by ${state.killedBy} on floor ${currentNode().depth}.`, 'combat-enemy');
            endRun('dead');
            return;
        }

        // 4. Environment effects: none yet (traps and status ticks arrive in Phase 2-3).

        // 5-6. Autosave and redraw
        saveGame();
        render();
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

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) return; // leave browser shortcuts alone
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

        if (state.mode === 'floor') {
            if (KEY_DIRS[key]) {
                e.preventDefault();
                playerAction(KEY_DIRS[key][0], KEY_DIRS[key][1]);
            } else if (key === ' ') {
                e.preventDefault();
                playerAction(0, 0);
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
            if (dx === 0 && dy === 0) playerAction(0, 0);
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
