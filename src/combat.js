// Attack patterns, damage, explosions and pushes.
// Every attack = a list of tiles + one shared damage routine (SV.damageAt).
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    const EXPLOSION_DAMAGE = 3;
    const IMPACT_DAMAGE = 1;

    // Pattern: (attacker x, y, facing dx, dy) -> tiles hit.
    SV.PATTERNS = {
        sword: (x, y, dx, dy) => [{ x: x + dx, y: y + dy }],
        spear: (x, y, dx, dy) => [{ x: x + dx, y: y + dy }, { x: x + 2 * dx, y: y + 2 * dy }],
        axe: (x, y) => {
            const tiles = [];
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox !== 0 || oy !== 0) tiles.push({ x: x + ox, y: y + oy });
                }
            }
            return tiles;
        },
        hammer: (x, y, dx, dy) => [{ x: x + dx, y: y + dy }],
    };

    // The one damage routine: hits whatever stands on (x, y) - player, enemy or barrel.
    // source is a noun phrase for the log: 'you', 'the rat', 'the explosion', 'the impact'.
    SV.damageAt = function (state, x, y, amount, source) {
        const p = state.player;
        if (p.x === x && p.y === y) {
            if (state.godMode) {
                console.log(`[DEBUG] God mode blocked ${amount} damage from ${source}.`);
                return;
            }
            p.hp = Math.max(0, p.hp - amount);
            SV.log(state, `${capitalize(source)} hits you for ${amount}.`, 'combat-enemy');
            if (p.hp === 0 && !state.killedBy) state.killedBy = source;
            return;
        }

        const barrel = SV.barrelAt(state, x, y);
        if (barrel) {
            state.barrels = state.barrels.filter(b => b !== barrel);
            SV.log(state, 'The barrel explodes!', 'combat-enemy');
            SV.explode(state, x, y, 'the explosion', false);
            return;
        }

        const enemy = SV.enemyAt(state, x, y);
        if (!enemy) return;
        const name = SV.ENEMY_TYPES[enemy.type].name;
        enemy.hp = Math.max(0, enemy.hp - amount);
        if (enemy.hp === 0) {
            state.enemies = state.enemies.filter(e => e !== enemy);
            state.kills++;
            SV.log(state, source === 'you' ? `You slay the ${name}.` : `${capitalize(source)} kills the ${name}.`, 'combat-player');
        } else {
            SV.log(state, source === 'you' ? `You hit the ${name} (${enemy.hp} HP left).` : `${capitalize(source)} hits the ${name}.`, 'combat-player');
        }
    };

    // 3x3 blast: damages entities, turns inner walls into floor. The outer border,
    // doors, stairs and items are untouched. Barrels caught in it go off afterwards,
    // one at a time, each only once. spareCenter = don't hit the centre tile (bombs).
    SV.explode = function (state, cx, cy, source, spareCenter) {
        const map = state.map;
        const queue = [{ x: cx, y: cy, source, spare: spareCenter }];
        while (queue.length > 0) {
            const blast = queue.shift();
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (blast.spare && ox === 0 && oy === 0) continue;
                    const x = blast.x + ox;
                    const y = blast.y + oy;
                    if (x <= 0 || y <= 0 || x >= map.width - 1 || y >= map.height - 1) continue;
                    const index = y * map.width + x;
                    if (map.tiles[index] === SV.TILE.WALL) {
                        map.tiles[index] = SV.TILE.FLOOR;
                        continue;
                    }
                    const barrel = SV.barrelAt(state, x, y);
                    if (barrel) {
                        state.barrels = state.barrels.filter(b => b !== barrel);
                        SV.log(state, 'Another barrel explodes!', 'combat-enemy');
                        queue.push({ x, y, source: 'the explosion', spare: false });
                        continue;
                    }
                    SV.damageAt(state, x, y, EXPLOSION_DAMAGE, blast.source);
                }
            }
        }
    };

    // Moves an enemy or barrel 1 tile. If the way is blocked: 1 impact damage to it
    // (and to whatever it hit), and a surviving enemy is stunned for its next action.
    // Returns true if it moved.
    SV.push = function (state, target, dx, dy) {
        const nx = target.x + dx;
        const ny = target.y + dy;
        if (!SV.isBlocked(state, nx, ny)) {
            target.x = nx;
            target.y = ny;
            return true;
        }

        const isBarrel = state.barrels.includes(target);
        const name = isBarrel ? 'barrel' : SV.ENEMY_TYPES[target.type].name;
        const hitEntity = !!(SV.enemyAt(state, nx, ny) || SV.barrelAt(state, nx, ny));
        SV.log(state, `The ${name} slams into ${hitEntity ? 'something' : 'the wall'}!`, 'combat-player');
        SV.damageAt(state, target.x, target.y, IMPACT_DAMAGE, 'the impact');
        if (hitEntity) SV.damageAt(state, nx, ny, IMPACT_DAMAGE, 'the impact');
        if (!isBarrel && state.enemies.includes(target)) target.stunned = 1;
        return false;
    };

    // Where a kicked barrel stops: it rolls until the next tile is blocked.
    SV.rollDestination = function (state, barrel, dx, dy) {
        let x = barrel.x;
        let y = barrel.y;
        while (!SV.isBlocked(state, x + dx, y + dy)) {
            x += dx;
            y += dy;
        }
        return { x, y, moved: Math.abs(x - barrel.x) + Math.abs(y - barrel.y) };
    };

    // Walking into a barrel kicks it: it rolls until it hits something, then explodes.
    SV.kickBarrel = function (state, barrel, dx, dy) {
        const stop = SV.rollDestination(state, barrel, dx, dy);
        barrel.x = stop.x;
        barrel.y = stop.y;
        SV.log(state, stop.moved > 0 ? 'You kick the barrel. It rolls and hits something!' : 'The barrel is blocked!', 'combat-player');
        SV.damageAt(state, barrel.x, barrel.y, IMPACT_DAMAGE, 'the impact');
    };

    // Is any enemy in the 8 tiles around the player? (axe spin)
    SV.enemyAround = function (state) {
        const p = state.player;
        return state.enemies.some(e => Math.abs(e.x - p.x) <= 1 && Math.abs(e.y - p.y) <= 1);
    };

    SV.weaponDamage = function (player) {
        return Math.max(1, player.atk + SV.WEAPONS[player.weapon].bonus);
    };

    // Bump attack with the held weapon: its pattern, damage bonus and knockback.
    SV.playerAttack = function (state, dx, dy) {
        const p = state.player;
        const weapon = SV.WEAPONS[p.weapon];
        const damage = SV.weaponDamage(p);
        const target = SV.enemyAt(state, p.x + dx, p.y + dy);
        for (const t of SV.PATTERNS[weapon.pattern](p.x, p.y, dx, dy)) {
            // Weapons only set off barrels right next to you (the spear's reach doesn't).
            const adjacent = Math.abs(t.x - p.x) <= 1 && Math.abs(t.y - p.y) <= 1;
            if (!adjacent && SV.barrelAt(state, t.x, t.y)) continue;
            SV.damageAt(state, t.x, t.y, damage, 'you');
        }
        if (weapon.knockback && target && state.enemies.includes(target)) SV.push(state, target, dx, dy);
    };

    SV.enemyAttack = function (state, enemy) {
        const type = SV.ENEMY_TYPES[enemy.type];
        SV.damageAt(state, state.player.x, state.player.y, type.atk, `the ${type.name}`);
    };

    // Player-safe bomb: a blast around the player that spares the player's own tile.
    SV.useBomb = function (state) {
        const p = state.player;
        p.bombs--;
        SV.log(state, 'You light a bomb!', 'item');
        SV.explode(state, p.x, p.y, 'the bomb', true);
    };

    function capitalize(text) {
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
})();
