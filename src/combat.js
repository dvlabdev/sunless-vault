// Attack patterns and damage. Every attack = a list of tiles + one shared damage routine.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    // Pattern: (attacker x, y, facing dx, dy) -> tiles hit. Phase 2 adds spear/axe/hammer.
    SV.PATTERNS = {
        melee: (x, y, dx, dy) => [{ x: x + dx, y: y + dy }],
    };

    // The one damage routine: hits whatever entity stands on (x, y).
    // source is a noun phrase for the log: 'you', 'the rat', later 'the explosion'.
    SV.damageAt = function (state, x, y, amount, source) {
        const p = state.player;
        if (p.x === x && p.y === y) {
            if (state.godMode) {
                console.log(`[DEBUG] God mode blocked ${amount} damage from ${source}.`);
                return;
            }
            p.hp = Math.max(0, p.hp - amount);
            SV.log(state, `${capitalize(source)} hits you for ${amount}.`, 'combat-enemy');
            if (p.hp === 0) state.killedBy = source;
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

    SV.playerAttack = function (state, tiles) {
        for (const t of tiles) SV.damageAt(state, t.x, t.y, state.player.atk, 'you');
    };

    SV.enemyAttack = function (state, enemy) {
        const type = SV.ENEMY_TYPES[enemy.type];
        SV.damageAt(state, state.player.x, state.player.y, type.atk, `the ${type.name}`);
    };

    function capitalize(text) {
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
})();
