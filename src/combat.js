// Attack patterns, damage, explosions, pushes, projectiles, charges and spikes.
// Every attack = a list of tiles + one shared damage routine (SV.damageAt).
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    const EXPLOSION_DAMAGE = 3;
    const IMPACT_DAMAGE = 1;
    const KNIFE_DAMAGE = 1;
    const SPIKE_DAMAGE = 2;

    // Slimes hit this turn; they split once the current action is over (SV.resolveSplits).
    const splitQueue = [];

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

    // A shieldbearer blocks hits whose source lies in front of it (the half it faces).
    SV.isShielded = function (enemy, fromX, fromY) {
        if (!SV.ENEMY_TYPES[enemy.type].shield || !enemy.facing) return false;
        return (fromX - enemy.x) * enemy.facing.dx + (fromY - enemy.y) * enemy.facing.dy > 0;
    };

    // The one damage routine: hits whatever stands on (x, y) - player, enemy or barrel.
    // source is a noun phrase for the log: 'you', 'the rat', 'the explosion', 'your knife'...
    // from = where a weapon hit or projectile came from (shields check it); omitted for
    // explosions, impacts and spikes, which shields can't block.
    SV.damageAt = function (state, x, y, amount, source, from) {
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
        const type = SV.ENEMY_TYPES[enemy.type];
        if (from && SV.isShielded(enemy, from.x, from.y)) {
            SV.log(state, `The ${type.name}'s shield blocks ${source === 'you' ? 'your blow' : source}.`, 'system');
            return;
        }
        enemy.hp = Math.max(0, enemy.hp - amount);
        if (enemy.hp === 0) {
            state.enemies = state.enemies.filter(e => e !== enemy);
            state.kills++;
            SV.log(state, source === 'you' ? `You slay the ${type.name}.` : `${capitalize(source)} kills the ${type.name}.`, 'combat-player');
        } else {
            SV.log(state, source === 'you' ? `You hit the ${type.name} (${enemy.hp} HP left).` : `${capitalize(source)} hits the ${type.name}.`, 'combat-player');
            if (type.splits) splitQueue.push(enemy);
        }
    };

    // Each wounded slime becomes two slimelets sharing its remaining HP
    // (one stays, one appears on the first free neighbour: up, right, down, left).
    SV.resolveSplits = function (state) {
        while (splitQueue.length > 0) {
            const slime = splitQueue.shift();
            if (!state.enemies.includes(slime) || slime.type !== 'slime') continue;
            const stay = Math.ceil(slime.hp / 2);
            const leave = slime.hp - stay;
            slime.type = 'slimelet';
            slime.hp = stay;
            SV.log(state, 'The slime splits in two!', 'combat-enemy');
            if (leave === 0) continue;
            const spot = SV.DIRS.map(([dx, dy]) => ({ x: slime.x + dx, y: slime.y + dy }))
                .find(t => !SV.isBlocked(state, t.x, t.y));
            if (!spot) continue;
            const twin = SV.makeEnemy(state, 'slimelet', spot.x, spot.y);
            twin.hp = leave;
            state.enemies.push(twin);
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

    // Raised spikes hurt whoever (player or enemy) ends a move on them.
    SV.enterTile = function (state, x, y) {
        const trap = SV.trapAt(state, x, y);
        if (trap && SV.spikesUp(trap) && !SV.barrelAt(state, x, y)) SV.damageAt(state, x, y, SPIKE_DAMAGE, 'the spikes');
    };

    // Environment step: timed spikes advance one phase; rising spikes hurt whoever stands there.
    SV.tickTraps = function (state) {
        for (const trap of state.traps) {
            if (!trap.timed) continue;
            trap.phase = (trap.phase + 1) % 3;
            if (trap.phase === 2 && !SV.barrelAt(state, trap.x, trap.y)) SV.damageAt(state, trap.x, trap.y, SPIKE_DAMAGE, 'the spikes');
        }
    };

    // Moves an enemy or barrel 1 tile. If the way is blocked: 1 impact damage to it
    // (and to whatever it hit), and a surviving enemy is stunned for its next action.
    // Returns true if it moved.
    SV.push = function (state, target, dx, dy) {
        const nx = target.x + dx;
        const ny = target.y + dy;
        const isBarrel = state.barrels.includes(target);
        if (!SV.isBlocked(state, nx, ny)) {
            target.x = nx;
            target.y = ny;
            if (!isBarrel) SV.enterTile(state, nx, ny);
            return true;
        }

        const name = isBarrel ? 'barrel' : SV.ENEMY_TYPES[target.type].name;
        const hitEntity = !!(SV.enemyAt(state, nx, ny) || SV.barrelAt(state, nx, ny));
        SV.log(state, `The ${name} slams into ${hitEntity ? 'something' : 'the wall'}!`, 'combat-player');
        SV.damageAt(state, target.x, target.y, IMPACT_DAMAGE, 'the impact');
        if (hitEntity) SV.damageAt(state, nx, ny, IMPACT_DAMAGE, 'the impact');
        if (!isBarrel && state.enemies.includes(target)) {
            target.stunned = 1;
            target.intent = null;
        }
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

    // Follows a straight line from (x, y) without changing anything.
    // Stops before a wall/door (hit = false) or on the first entity (hit = true).
    SV.traceProjectile = function (state, x, y, dx, dy, range) {
        let cx = x;
        let cy = y;
        for (let i = 1; i <= range; i++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!SV.isWalkable(state.map, nx, ny)) break;
            if (SV.isBlocked(state, nx, ny)) return { x: nx, y: ny, hit: true, distance: i };
            cx = nx;
            cy = ny;
        }
        return { x: cx, y: cy, hit: false, distance: Math.abs(cx - x) + Math.abs(cy - y) };
    };

    // Arrows and knives: fly in a line and damage the first thing they meet.
    SV.projectile = function (state, x, y, dx, dy, range, damage, source) {
        const stop = SV.traceProjectile(state, x, y, dx, dy, range);
        if (stop.hit) SV.damageAt(state, stop.x, stop.y, damage, source, { x, y });
        return stop;
    };

    // Returns false (no turn spent) if there's no room to throw.
    SV.throwKnife = function (state, dx, dy) {
        const p = state.player;
        const stop = SV.traceProjectile(state, p.x, p.y, dx, dy, Infinity);
        if (!stop.hit && stop.distance === 0) {
            SV.log(state, 'No room to throw there.', 'system');
            return false;
        }
        p.knives--;
        SV.log(state, 'You throw a knife.', 'combat-player');
        SV.projectile(state, p.x, p.y, dx, dy, Infinity, KNIFE_DAMAGE, 'your knife');
        state.items.push(SV.makeItem(state, 'knife', stop.x, stop.y)); // lands where it stopped
        return true;
    };

    // Charger: runs until blocked, then hits what it ran into (or slams into the wall).
    SV.charge = function (state, charger, dx, dy) {
        const type = SV.ENEMY_TYPES[charger.type];
        SV.log(state, 'The charger charges!', 'combat-enemy');
        while (!SV.isBlocked(state, charger.x + dx, charger.y + dy)) {
            charger.x += dx;
            charger.y += dy;
        }
        SV.enterTile(state, charger.x, charger.y);
        if (!state.enemies.includes(charger)) return; // died on spikes
        const nx = charger.x + dx;
        const ny = charger.y + dy;
        const p = state.player;
        if ((p.x === nx && p.y === ny) || SV.enemyAt(state, nx, ny) || SV.barrelAt(state, nx, ny)) {
            SV.damageAt(state, nx, ny, type.atk, 'the charger', { x: charger.x, y: charger.y });
        } else {
            SV.log(state, 'The charger slams into the wall!', 'combat-player');
            SV.damageAt(state, charger.x, charger.y, IMPACT_DAMAGE, 'the impact');
            if (state.enemies.includes(charger)) charger.stunned = 1;
        }
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
        const from = { x: p.x, y: p.y };
        const target = SV.enemyAt(state, p.x + dx, p.y + dy);
        for (const t of SV.PATTERNS[weapon.pattern](p.x, p.y, dx, dy)) {
            // Weapons only set off barrels right next to you (the spear's reach doesn't).
            const adjacent = Math.abs(t.x - p.x) <= 1 && Math.abs(t.y - p.y) <= 1;
            if (!adjacent && SV.barrelAt(state, t.x, t.y)) continue;
            SV.damageAt(state, t.x, t.y, damage, 'you', from);
        }
        // A shield stops the damage, not the force: the hammer still knocks it back.
        if (weapon.knockback && target && state.enemies.includes(target)) SV.push(state, target, dx, dy);
    };

    SV.enemyAttack = function (state, enemy) {
        const type = SV.ENEMY_TYPES[enemy.type];
        SV.damageAt(state, state.player.x, state.player.y, type.atk, `the ${type.name}`, { x: enemy.x, y: enemy.y });
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
