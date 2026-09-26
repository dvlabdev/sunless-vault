// Player, enemy, item and barrel definitions, factories and enemy behaviour.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    // Stats live here, not in `state`: saved enemies only keep { type, hp, stunned }.
    // cost = share of a floor's enemyBudget; minDepth = first floor it can appear on.
    SV.ENEMY_TYPES = {
        rat:   { name: 'rat',   hp: 2, atk: 1, cost: 1, minDepth: 1 },
        ghoul: { name: 'ghoul', hp: 4, atk: 2, cost: 2, minDepth: 3 },
        brute: { name: 'brute', hp: 6, atk: 3, cost: 4, minDepth: 6 },
    };

    // Sidegrades: pattern = which tiles a bump attack hits (see SV.PATTERNS in combat.js),
    // bonus = added to the player's attack (minimum damage 1).
    SV.WEAPONS = {
        sword:  { name: 'sword',  pattern: 'sword',  bonus: 0,  desc: 'hits the tile in front' },
        spear:  { name: 'spear',  pattern: 'spear',  bonus: 0,  desc: 'hits the tile in front and the one behind it; stepping toward an enemy 2 tiles away strikes it', lunge: true },
        axe:    { name: 'axe',    pattern: 'axe',    bonus: -1, desc: 'hits all 8 tiles around you, 1 less damage; waiting swings it', spin: true },
        hammer: { name: 'hammer', pattern: 'hammer', bonus: 0,  desc: 'hits the tile in front and knocks the enemy back 1 tile', knockback: true },
    };

    // Loose floor loot: weight = relative chance; 'weapon' becomes a random weapon.
    const LOOT_TABLE = [
        { kind: 'potion',    weight: 5, minDepth: 1 },
        { kind: 'bomb',      weight: 3, minDepth: 1 },
        { kind: 'weapon',    weight: 1, minDepth: 1 },
        { kind: 'heart',     weight: 1, minDepth: 3 },
        { kind: 'whetstone', weight: 1, minDepth: 4 },
    ];
    const TREASURE = ['weapon', 'whetstone', 'heart']; // what closets hold

    SV.makePlayer = function () {
        return { x: 0, y: 0, hp: 20, maxHp: 20, atk: 2, weapon: 'sword', potions: 0, bombs: 0, keys: 0 };
    };

    SV.makeEnemy = function (state, type, x, y) {
        return { id: state.nextId++, type, x, y, hp: SV.ENEMY_TYPES[type].hp, stunned: 0 };
    };

    SV.makeItem = function (state, kind, x, y) {
        return { id: state.nextId++, kind, x, y };
    };

    SV.makeBarrel = function (state, x, y) {
        return { id: state.nextId++, x, y };
    };

    SV.enemyAt = function (state, x, y) {
        return state.enemies.find(e => e.x === x && e.y === y) || null;
    };

    SV.barrelAt = function (state, x, y) {
        return state.barrels.find(b => b.x === x && b.y === y) || null;
    };

    SV.itemAt = function (state, x, y) {
        return state.items.find(i => i.x === x && i.y === y) || null;
    };

    // Can't be walked or pushed into: wall, locked door, enemy, barrel or the player.
    SV.isBlocked = function (state, x, y) {
        const p = state.player;
        return !SV.isWalkable(state.map, x, y) || !!SV.enemyAt(state, x, y) || !!SV.barrelAt(state, x, y) || (p.x === x && p.y === y);
    };

    // Spends a floor's budget on random enemy types allowed at this depth.
    SV.chooseEnemies = function (holder, budget, depth) {
        const allowed = Object.keys(SV.ENEMY_TYPES).filter(t => SV.ENEMY_TYPES[t].minDepth <= depth);
        const chosen = [];
        while (budget > 0) {
            const affordable = allowed.filter(t => SV.ENEMY_TYPES[t].cost <= budget);
            if (affordable.length === 0) break;
            const type = SV.pick(holder, affordable);
            chosen.push(type);
            budget -= SV.ENEMY_TYPES[type].cost;
        }
        return chosen;
    };

    SV.chooseLoot = function (holder, count, depth) {
        const table = LOOT_TABLE.filter(l => l.minDepth <= depth);
        const total = table.reduce((sum, l) => sum + l.weight, 0);
        const kinds = [];
        for (let n = 0; n < count; n++) {
            let roll = SV.random(holder) * total;
            const entry = table.find(l => (roll -= l.weight) < 0) || table[table.length - 1];
            kinds.push(resolveWeapon(holder, entry.kind));
        }
        return kinds;
    };

    SV.chooseTreasure = function (holder) {
        return resolveWeapon(holder, SV.pick(holder, TREASURE));
    };

    function resolveWeapon(holder, kind) {
        return kind === 'weapon' ? SV.pick(holder, Object.keys(SV.WEAPONS)) : kind;
    }

    // Each enemy in turn: skip if stunned, attack if next to the player, otherwise step closer.
    // Stops as soon as the player dies.
    SV.enemiesAct = function (state) {
        const p = state.player;
        const w = state.map.width;
        const dist = SV.distanceMap(state.map, p.x, p.y, false);
        for (const e of state.enemies) {
            if (e.stunned > 0) {
                e.stunned--;
                continue;
            }
            if (Math.abs(e.x - p.x) + Math.abs(e.y - p.y) === 1) {
                SV.enemyAttack(state, e);
                if (p.hp <= 0) return;
                continue;
            }
            let bestDist = dist[e.y * w + e.x];
            if (bestDist < 0) continue; // walled off from the player
            let best = null;
            for (const [dx, dy] of SV.DIRS) {
                const nx = e.x + dx;
                const ny = e.y + dy;
                const d = dist[ny * w + nx];
                if (d < 0 || d >= bestDist || SV.enemyAt(state, nx, ny) || SV.barrelAt(state, nx, ny)) continue;
                best = { x: nx, y: ny };
                bestDist = d;
            }
            if (best) {
                e.x = best.x;
                e.y = best.y;
            }
        }
    };
})();
