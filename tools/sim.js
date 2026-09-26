// Bot playtests: real rule files + the turn sequence from main.js, two play styles.
// Usage: node tools/sim.js [runsPerPolicy] [god]      (200 runs per style takes ~3-4 minutes)
//        set DUMP=1 to print the board and last turns whenever a bot gets stuck.
// Keep finishTurn/act/pickUp in sync with src/main.js when the turn sequence changes.
// Bots look only one turn ahead: use the numbers to compare versions, not as absolute human win rates.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = path.join(__dirname, '..', 'src');
const sandbox = { console: { log() {}, warn: console.warn, error: console.error }, Math, JSON };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['rng.js', 'map.js', 'entities.js', 'combat.js']) {
    vm.runInContext(fs.readFileSync(path.join(src, f), 'utf8'), sandbox, { filename: f });
}
const SV = sandbox.SV;
SV.log = () => {};

const REST_HEAL = 3, POTION_HEAL = 8, HEART_BONUS = 4, FLOOR_TURN_CAP = 250;
const RUNS = Number(process.argv[2] || 200);
const GOD = process.argv[3] === 'god';

// ---- Stats hooks: who damages the player, who dies ----------------------
let stats = null; // current run's stats
const realDamageAt = SV.damageAt;
SV.damageAt = function (state, x, y, amount, source, from) {
    // Count only what this call hit directly (explosions it triggers are counted by their own calls).
    const p = state.player;
    const hitsPlayer = p.x === x && p.y === y;
    const before = p.hp;
    const target = hitsPlayer ? null : SV.enemyAt(state, x, y);
    realDamageAt(state, x, y, amount, source, from);
    if (!stats || !state.__real) return;
    if (hitsPlayer && p.hp < before) {
        const key = source.replace(/^the |^your /, '');
        stats.damage[key] = (stats.damage[key] || 0) + (before - p.hp);
    }
    if (target && target.hp === 0 && !state.enemies.includes(target)) stats.kills[target.type] = (stats.kills[target.type] || 0) + 1;
};

// ---- Game flow (mirrors main.js) ------------------------------------------
function newRun(seed) {
    return {
        seed, rng: seed, mode: 'map', turn: 0, kills: 0, nextId: 1, killedBy: null,
        godMode: GOD, run: SV.buildRun(seed), player: SV.makePlayer(),
        map: null, enemies: [], items: [], barrels: [], traps: [], log: [], __real: true,
    };
}
const node = s => s.run.nodes[s.run.current];

function enterFloor(s) {
    const n = node(s);
    const f = SV.generateFloor(n.floor, n.seed, n.depth);
    s.map = f.map;
    s.enemies = f.enemies.map(e => SV.makeEnemy(s, e.type, e.x, e.y));
    s.items = f.items.map(i => SV.makeItem(s, i.kind, i.x, i.y));
    s.barrels = f.barrels.map(b => SV.makeBarrel(s, b.x, b.y));
    s.traps = f.traps.map(t => Object.assign({}, t));
    s.player.x = f.start.x;
    s.player.y = f.start.y;
    s.enemies.forEach(e => { if (e.facing) SV.faceToward(e, s.player.x, s.player.y); });
    s.mode = 'floor';
    s.floorTurns = 0;
    s.visits = {};
}

function completeFloor(s) {
    const n = node(s);
    n.status = 'cleared';
    s.run.current = n.next[0];
    s.map = null; s.enemies = []; s.items = []; s.barrels = []; s.traps = [];
    if (node(s).type === 'vault') { s.mode = 'won'; return; }
    const p = s.player;
    p.hp += Math.min(REST_HEAL, p.maxHp - p.hp);
    s.mode = 'map';
}

function pickUp(s) {
    const p = s.player;
    let swapped = false;
    for (const item of s.items.filter(i => i.x === p.x && i.y === p.y)) {
        if (SV.WEAPONS[item.kind]) {
            if (swapped || item.kind === p.weapon || !s.wantsWeapon(item.kind)) continue;
            const old = p.weapon; p.weapon = item.kind; item.kind = old; swapped = true;
            if (s.__real) stats.weaponsTaken[p.weapon] = (stats.weaponsTaken[p.weapon] || 0) + 1;
            continue;
        }
        s.items = s.items.filter(i => i !== item);
        if (s.__real) stats.found[item.kind] = (stats.found[item.kind] || 0) + 1;
        if (item.kind === 'knife') p.knives++;
        else if (item.kind === 'potion') p.potions++;
        else if (item.kind === 'bomb') p.bombs++;
        else if (item.kind === 'key') p.keys++;
        else if (item.kind === 'whetstone') p.atk++;
        else if (item.kind === 'heart') { p.maxHp += HEART_BONUS; p.hp += HEART_BONUS; }
    }
}

function moveTo(s, x, y) { s.player.x = x; s.player.y = y; pickUp(s); SV.enterTile(s, x, y); }

// Returns false if the action doesn't spend a turn.
function act(s, a) {
    const p = s.player;
    if (a.type === 'move') {
        const { dx, dy } = a, nx = p.x + dx, ny = p.y + dy;
        const barrel = SV.barrelAt(s, nx, ny);
        if (SV.enemyAt(s, nx, ny)) SV.playerAttack(s, dx, dy);
        else if (barrel) SV.kickBarrel(s, barrel, dx, dy);
        else if (SV.tileAt(s.map, nx, ny) === SV.TILE.DOOR) {
            if (p.keys === 0) return false;
            p.keys--; s.map.tiles[ny * s.map.width + nx] = SV.TILE.FLOOR;
        } else if (SV.isWalkable(s.map, nx, ny)) {
            moveTo(s, nx, ny);
            if (SV.WEAPONS[p.weapon].lunge && SV.enemyAt(s, p.x + dx, p.y + dy)) SV.playerAttack(s, dx, dy);
        } else return false;
    } else if (a.type === 'wait') {
        if (SV.WEAPONS[p.weapon].spin && SV.enemyAround(s)) SV.playerAttack(s, 0, 0);
    } else if (a.type === 'potion') {
        if (p.potions === 0 || p.hp === p.maxHp) return false;
        p.potions--; p.hp += Math.min(POTION_HEAL, p.maxHp - p.hp);
        if (s.__real) stats.used.potion = (stats.used.potion || 0) + 1;
    } else if (a.type === 'bomb') {
        if (p.bombs === 0) return false;
        SV.useBomb(s);
        if (s.__real) stats.used.bomb = (stats.used.bomb || 0) + 1;
    } else if (a.type === 'knife') {
        if (p.knives === 0 || !SV.throwKnife(s, a.dx, a.dy)) return false;
        if (s.__real) stats.used.knife = (stats.used.knife || 0) + 1;
    }
    finishTurn(s);
    return true;
}

function finishTurn(s) {
    const p = s.player;
    s.turn++; s.floorTurns++;
    SV.resolveSplits(s);
    if (p.hp <= 0) { s.mode = 'dead'; return; }
    if (SV.tileAt(s.map, p.x, p.y) === SV.TILE.STAIRS) { completeFloor(s); return; }
    SV.enemiesAct(s);
    SV.resolveSplits(s);
    if (p.hp <= 0) { s.mode = 'dead'; return; }
    SV.tickTraps(s);
    SV.resolveSplits(s);
    if (p.hp <= 0) { s.mode = 'dead'; return; }
}

// ---- Bots -----------------------------------------------------------------
const ACTIONS = [
    ...SV.DIRS.map(([dx, dy]) => ({ type: 'move', dx, dy })),
    { type: 'wait' }, { type: 'potion' }, { type: 'bomb' },
    ...SV.DIRS.map(([dx, dy]) => ({ type: 'knife', dx, dy })),
];

function clone(s) {
    const c = JSON.parse(JSON.stringify(s, (k, v) => (k === 'visits' ? undefined : v)));
    c.__real = false;
    c.wantsWeapon = s.wantsWeapon;
    c.visits = s.visits;
    return c;
}

function stepsTo(s, targets) {
    // BFS distance from the player to the nearest target index (doors passable only with a key).
    const map = s.map, w = map.width;
    const dist = SV.distanceMap(map, s.player.x, s.player.y, s.player.keys > 0);
    let best = Infinity;
    for (const t of targets) if (dist[t] >= 0 && dist[t] < best) best = dist[t];
    return best;
}

function evaluate(s, policy) {
    if (s.mode === 'dead') return -1e9;
    if (s.mode === 'won') return 1e9;
    const p = s.player;
    if (s.mode === 'map') {
        // Floor done: value HP and resources carried forward.
        return 5e5 + p.hp * 30 + p.maxHp * 10 + p.potions * 40 + (policy === 'fighter' ? 5000 : 0);
    }
    const w = s.map.width;
    const stairs = s.map.tiles.indexOf(SV.TILE.STAIRS);
    const enemyHp = s.enemies.reduce((sum, e) => sum + e.hp, 0);
    let score = p.hp * 30 + p.maxHp * 10 + p.atk * 25 + p.potions * 40 + p.bombs * 12 + p.knives * 8 + p.keys * 15;
    // Standing where you'd get hurt next turn is bad (lookahead is only 1 turn).
    score -= threatAtPlayer(s) * 12;
    const visits = s.visits[p.y * w + p.x] || 0;
    score -= visits * 6;
    // The fighter gives up clearing after a while and heads for the stairs.
    if (policy === 'rusher' || s.floorTurns > 80) {
        score -= stepsTo(s, [stairs]) * 10;
        score -= enemyHp * 3; // clear what's in the way
    } else {
        score -= enemyHp * 18;
        const targets = s.enemies.map(e => e.y * w + e.x).concat(s.items.filter(i => !SV.WEAPONS[i.kind]).map(i => i.y * w + i.x));
        const t = targets.length ? stepsTo(s, targets) : Infinity;
        score -= Number.isFinite(t) ? t * 6 : stepsTo(s, [stairs]) * 10;
    }
    return score;
}

// Damage the player would take next enemy phase if nothing moves (rough).
function threatAtPlayer(s) {
    const c = clone(s);
    const hp = c.player.hp;
    c.godMode = false;
    SV.enemiesAct(c);
    SV.tickTraps(c);
    return Math.max(0, hp - c.player.hp);
}

function chooseAction(s, policy) {
    let best = null, bestScore = -Infinity;
    for (const a of ACTIONS) {
        if (policy === 'rusher' && (a.type === 'bomb' || a.type === 'knife')) continue;
        if (a.type === 'potion' && s.player.hp > s.player.maxHp / 3) continue;
        const c = clone(s);
        if (!act(c, a)) continue;
        let score = evaluate(c, policy);
        if (a.type === 'bomb' || a.type === 'knife') score -= 5; // don't waste resources for nothing
        if (score > bestScore) { bestScore = score; best = a; }
    }
    return best || { type: 'wait' };
}

// Weapon preference: fighter likes to try other weapons, rusher keeps the sword.
const WEAPON_PREF = { fighter: k => k !== 'sword', rusher: () => false };

function playRun(seed, policy) {
    stats = { damage: {}, kills: {}, found: {}, used: {}, weaponsTaken: {}, hpExit: [], turnsPerFloor: [] };
    const s = newRun(seed);
    s.wantsWeapon = WEAPON_PREF[policy];
    while (s.mode !== 'dead' && s.mode !== 'won') {
        enterFloor(s);
        const depth = node(s).depth;
        while (s.mode === 'floor') {
            if (s.floorTurns >= FLOOR_TURN_CAP) {
                s.mode = 'stuck';
                const p = s.player;
                stats.stuckNextToShield = s.enemies.some(e => e.type === 'shieldbearer' && Math.abs(e.x - p.x) + Math.abs(e.y - p.y) <= 2);
                if (process.env.DUMP) dump(s, policy, depth);
                break;
            }
            const a = chooseAction(s, policy);
            const w = s.map.width;
            const before = `p ${s.player.x},${s.player.y} hp ${s.player.hp} | ` + s.enemies.map(e => `${e.type}@${e.x},${e.y} hp${e.hp} st${e.stunned} ${e.intent ? e.intent.kind : ''}`).join('; ');
            const spent = act(s, a);
            (s.recent = s.recent || []).push(`${JSON.stringify(a)} spent=${spent} :: ${before}`);
            if (s.recent.length > 6) s.recent.shift();
            if (s.mode === 'floor') s.visits[s.player.y * w + s.player.x] = (s.visits[s.player.y * w + s.player.x] || 0) + 1;
        }
        if (s.mode === 'stuck') break;
        stats.turnsPerFloor.push(s.floorTurns);
        if (s.mode === 'map' || s.mode === 'won') stats.hpExit.push(s.player.hp);
        else stats.deathFloor = depth;
    }
    return { seed, result: s.mode, deathFloor: stats.deathFloor || null, turns: s.turn, stats, final: s.player };
}

function dump(s, policy, depth) {
    const w = s.map.width, rows = [];
    for (let y = 0; y < s.map.height; y++) {
        let row = '';
        for (let x = 0; x < w; x++) {
            const e = SV.enemyAt(s, x, y), b = SV.barrelAt(s, x, y), it = SV.itemAt(s, x, y), t = SV.trapAt(s, x, y);
            row += (s.player.x === x && s.player.y === y) ? '@' : e ? SV.ENEMY_TYPES[e.type].name[0] : b ? 'O' : t ? '^' : it ? '*' : s.map.tiles[y * w + x];
        }
        rows.push(row);
    }
    const c = clone(s);
    const choice = chooseAction(s, policy);
    console.log(`STUCK ${policy} seed ${s.seed} floor ${depth} hp ${s.player.hp} keys ${s.player.keys} weapon ${s.player.weapon} next=${JSON.stringify(choice)}\n${rows.join('\n')}\n  last turns:\n  ${(s.recent || []).join('\n  ')}`);
}

// ---- Report ---------------------------------------------------------------
function summarize(policy, runs) {
    const n = runs.length;
    const wins = runs.filter(r => r.result === 'won').length;
    const stuck = runs.filter(r => r.result === 'stuck').length;
    const deaths = {};
    runs.filter(r => r.result === 'dead').forEach(r => { deaths[r.deathFloor] = (deaths[r.deathFloor] || 0) + 1; });
    const sum = (key) => {
        const out = {};
        runs.forEach(r => Object.entries(r.stats[key]).forEach(([k, v]) => { out[k] = (out[k] || 0) + v; }));
        Object.keys(out).forEach(k => { out[k] = +(out[k] / n).toFixed(2); });
        return out;
    };
    const hpByFloor = [];
    for (let f = 0; f < 10; f++) {
        const vals = runs.map(r => r.stats.hpExit[f]).filter(v => v !== undefined);
        hpByFloor.push(vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null);
    }
    const turnsByFloor = [];
    for (let f = 0; f < 10; f++) {
        const vals = runs.map(r => r.stats.turnsPerFloor[f]).filter(v => v !== undefined);
        turnsByFloor.push(vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null);
    }
    const reached = [];
    for (let f = 1; f <= 10; f++) reached.push(runs.filter(r => r.stats.turnsPerFloor.length + (r.result === 'won' ? 0 : 1) >= f).length);
    console.log(`\n=== ${policy.toUpperCase()} (${n} runs${GOD ? ', GOD MODE' : ''}) ===`);
    const stuckShield = runs.filter(r => r.result === 'stuck' && r.stats.stuckNextToShield).length;
    console.log(`win rate: ${(100 * wins / n).toFixed(1)}%   died: ${runs.filter(r => r.result === 'dead').length}   stuck: ${stuck} (next to a shieldbearer: ${stuckShield})`);
    const stuckFloors = {};
    runs.filter(r => r.result === 'stuck').forEach(r => { const f = r.stats.turnsPerFloor.length + 1; stuckFloors[f] = (stuckFloors[f] || 0) + 1; });
    console.log('stuck on floor:', JSON.stringify(stuckFloors));
    console.log('reached floor 1..10:', reached.join(' '));
    console.log('deaths by floor:', JSON.stringify(deaths));
    console.log('avg HP when leaving floor 1..10:', hpByFloor.join(' '));
    console.log('avg turns on floor 1..10:', turnsByFloor.join(' '));
    console.log('avg damage taken per run by source:', JSON.stringify(sum('damage')));
    console.log('avg kills per run:', JSON.stringify(sum('kills')));
    console.log('avg items picked up per run:', JSON.stringify(sum('found')));
    console.log('avg items used per run:', JSON.stringify(sum('used')));
    console.log('weapons taken per run:', JSON.stringify(sum('weaponsTaken')));
    const avgTurns = runs.reduce((a, r) => a + r.turns, 0) / n;
    console.log(`avg total turns: ${avgTurns.toFixed(0)}`);
}

const t0 = Date.now();
for (const policy of ['rusher', 'fighter']) {
    const runs = [];
    for (let seed = 1; seed <= RUNS; seed++) runs.push(playRun(seed * 7919, policy));
    summarize(policy, runs);
}
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
