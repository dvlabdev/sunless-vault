// Player and enemy definitions, factories and enemy behaviour.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    // Stats live here, not in `state`: saved enemies only keep { type, hp }.
    // cost = share of a floor's enemyBudget; minDepth = first floor it can appear on.
    SV.ENEMY_TYPES = {
        rat:   { name: 'rat',   hp: 2, atk: 1, cost: 1, minDepth: 1 },
        ghoul: { name: 'ghoul', hp: 4, atk: 2, cost: 2, minDepth: 3 },
        brute: { name: 'brute', hp: 6, atk: 3, cost: 4, minDepth: 6 },
    };

    SV.makePlayer = function () {
        return { x: 0, y: 0, hp: 20, maxHp: 20, atk: 2 };
    };

    SV.makeEnemy = function (state, type, x, y) {
        return { id: state.nextId++, type, x, y, hp: SV.ENEMY_TYPES[type].hp };
    };

    SV.enemyAt = function (state, x, y) {
        return state.enemies.find(e => e.x === x && e.y === y) || null;
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

    // Each enemy in turn: attack if next to the player, otherwise step closer.
    // Stops as soon as the player dies.
    SV.enemiesAct = function (state) {
        const p = state.player;
        const w = state.map.width;
        const dist = SV.distanceMap(state.map, p.x, p.y);
        for (const e of state.enemies) {
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
                if (d < 0 || d >= bestDist || SV.enemyAt(state, nx, ny)) continue;
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
