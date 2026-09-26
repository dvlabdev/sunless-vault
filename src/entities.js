// Player, enemy, item, barrel and trap definitions, factories and enemy behaviour.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    // Stats live here, not in `state`: saved enemies only keep { type, hp, stunned, intent, facing }.
    // cost = share of a floor's enemyBudget; minDepth = first floor it can appear on.
    // ai: 'melee' | 'archer' | 'charger' | 'bomber' (see ENEMY_AI below).
    SV.ENEMY_TYPES = {
        rat:          { name: 'rat',          hp: 2, atk: 1, cost: 1, minDepth: 1, ai: 'melee' },
        ghoul:        { name: 'ghoul',        hp: 4, atk: 2, cost: 2, minDepth: 3, ai: 'melee' },
        brute:        { name: 'brute',        hp: 6, atk: 3, cost: 4, minDepth: 6, ai: 'melee' },
        slime:        { name: 'slime',        hp: 4, atk: 1, cost: 3, minDepth: 2, ai: 'melee', splits: true },
        slimelet:     { name: 'slimelet',     hp: 2, atk: 1, cost: 0, minDepth: Infinity, ai: 'melee' }, // only from splits
        archer:       { name: 'archer',       hp: 2, atk: 2, cost: 3, minDepth: 3, ai: 'archer', range: 6 },
        charger:      { name: 'charger',      hp: 5, atk: 3, cost: 4, minDepth: 4, ai: 'charger', range: 8 },
        bomber:       { name: 'bomber',       hp: 2, atk: 3, cost: 3, minDepth: 5, ai: 'bomber' },
        shieldbearer: { name: 'shieldbearer', hp: 4, atk: 2, cost: 4, minDepth: 6, ai: 'melee', shield: true },
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
        { kind: 'knife',     weight: 3, minDepth: 1 },
        { kind: 'weapon',    weight: 1, minDepth: 1 },
        { kind: 'heart',     weight: 1, minDepth: 3 },
        { kind: 'whetstone', weight: 1, minDepth: 4 },
    ];
    const TREASURE = ['weapon', 'whetstone', 'heart']; // what closets hold

    SV.makePlayer = function () {
        return { x: 0, y: 0, hp: 20, maxHp: 20, atk: 2, weapon: 'sword', potions: 0, bombs: 0, keys: 0, knives: 2 };
    };

    SV.makeEnemy = function (state, type, x, y) {
        const enemy = { id: state.nextId++, type, x, y, hp: SV.ENEMY_TYPES[type].hp, stunned: 0, intent: null };
        if (SV.ENEMY_TYPES[type].shield) enemy.facing = { dx: 0, dy: 1 };
        return enemy;
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

    SV.trapAt = function (state, x, y) {
        return state.traps.find(t => t.x === x && t.y === y) || null;
    };

    // Spikes: fixed ones are always up; timed ones cycle 0 (down) -> 1 (down, rising) -> 2 (up).
    SV.spikesUp = function (trap) {
        return !trap.timed || trap.phase === 2;
    };

    // Enemies won't step where spikes are up or about to rise.
    function spikeDanger(state, x, y) {
        const trap = SV.trapAt(state, x, y);
        return !!trap && (SV.spikesUp(trap) || trap.phase === 1);
    }

    // Can't be walked or pushed into: wall, locked door, enemy, barrel or the player.
    SV.isBlocked = function (state, x, y) {
        const p = state.player;
        return !SV.isWalkable(state.map, x, y) || !!SV.enemyAt(state, x, y) || !!SV.barrelAt(state, x, y) || (p.x === x && p.y === y);
    };

    // Turn to face (x, y) along the dominant axis (ties: horizontal).
    SV.faceToward = function (enemy, x, y) {
        const dx = x - enemy.x;
        const dy = y - enemy.y;
        if (dx === 0 && dy === 0) return;
        enemy.facing = Math.abs(dx) >= Math.abs(dy) ? { dx: Math.sign(dx), dy: 0 } : { dx: 0, dy: Math.sign(dy) };
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

    // If the player is in the same row/column within range and nothing stands in between,
    // returns the direction toward them.
    SV.lineOfFire = function (state, enemy, range) {
        const p = state.player;
        if (enemy.x !== p.x && enemy.y !== p.y) return null;
        const distance = Math.abs(p.x - enemy.x) + Math.abs(p.y - enemy.y);
        if (distance === 0 || distance > range) return null;
        const dx = Math.sign(p.x - enemy.x);
        const dy = Math.sign(p.y - enemy.y);
        for (let i = 1; i < distance; i++) {
            if (SV.isBlocked(state, enemy.x + dx * i, enemy.y + dy * i)) return null;
        }
        return { dx, dy };
    };

    // One step along the distance map, avoiding enemies, barrels and dangerous spikes.
    function stepToward(state, enemy, dist) {
        const w = state.map.width;
        let bestDist = dist[enemy.y * w + enemy.x];
        if (bestDist < 0) return; // walled off from the player
        let best = null;
        for (const [dx, dy] of SV.DIRS) {
            const nx = enemy.x + dx;
            const ny = enemy.y + dy;
            const d = dist[ny * w + nx];
            if (d < 0 || d >= bestDist || SV.enemyAt(state, nx, ny) || SV.barrelAt(state, nx, ny) || spikeDanger(state, nx, ny)) continue;
            best = { x: nx, y: ny };
            bestDist = d;
        }
        if (best) {
            enemy.x = best.x;
            enemy.y = best.y;
        }
    }

    function adjacentToPlayer(state, enemy) {
        const p = state.player;
        return Math.abs(enemy.x - p.x) + Math.abs(enemy.y - p.y) === 1;
    }

    // Behaviour per ai type. Every big move is announced one turn ahead (intent).
    const ENEMY_AI = {
        melee(state, e, dist) {
            if (adjacentToPlayer(state, e)) SV.enemyAttack(state, e);
            else stepToward(state, e, dist);
            if (SV.ENEMY_TYPES[e.type].shield) SV.faceToward(e, state.player.x, state.player.y);
        },

        archer(state, e, dist) {
            const type = SV.ENEMY_TYPES[e.type];
            if (e.intent && e.intent.kind === 'aim') {
                const { dx, dy } = e.intent;
                e.intent = null;
                SV.log(state, 'The archer shoots!', 'combat-enemy');
                SV.projectile(state, e.x, e.y, dx, dy, type.range, type.atk, 'the arrow');
                return;
            }
            const aim = SV.lineOfFire(state, e, type.range);
            if (aim) {
                e.intent = { kind: 'aim', dx: aim.dx, dy: aim.dy };
                SV.log(state, 'The archer takes aim at you.', 'combat-enemy');
                return;
            }
            stepToward(state, e, dist);
        },

        charger(state, e, dist) {
            const type = SV.ENEMY_TYPES[e.type];
            if (e.intent && e.intent.kind === 'charge') {
                const { dx, dy } = e.intent;
                e.intent = null;
                SV.charge(state, e, dx, dy);
                return;
            }
            const aim = SV.lineOfFire(state, e, type.range);
            if (aim) {
                e.intent = { kind: 'charge', dx: aim.dx, dy: aim.dy };
                SV.log(state, 'The charger lowers its head...', 'combat-enemy');
                return;
            }
            stepToward(state, e, dist);
        },

        bomber(state, e, dist) {
            const p = state.player;
            if (e.intent && e.intent.kind === 'fuse') {
                state.enemies = state.enemies.filter(o => o !== e);
                SV.log(state, 'The bomber explodes!', 'combat-enemy');
                SV.explode(state, e.x, e.y, 'the bomber', false);
                return;
            }
            if (Math.abs(e.x - p.x) <= 1 && Math.abs(e.y - p.y) <= 1) {
                e.intent = { kind: 'fuse' };
                SV.log(state, 'The bomber lights its fuse!', 'combat-enemy');
                return;
            }
            stepToward(state, e, dist);
        },
    };

    // Each enemy in turn (a snapshot: bombers can kill others mid-phase).
    // Stunned enemies skip their action and lose any announced move. Stops when the player dies.
    SV.enemiesAct = function (state) {
        const p = state.player;
        const dist = SV.distanceMap(state.map, p.x, p.y, false);
        for (const e of state.enemies.slice()) {
            if (!state.enemies.includes(e)) continue;
            if (e.stunned > 0) {
                e.stunned--;
                e.intent = null;
                continue;
            }
            ENEMY_AI[SV.ENEMY_TYPES[e.type].ai](state, e, dist);
            if (p.hp <= 0) return;
        }
    };
})();
