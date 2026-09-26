// Headless check: load the logic files in a sandbox and generate many floors.
// Usage: node tools/gen-test.js   (300 seeds x 10 floors; expects "0 problems")
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = path.join(__dirname, '..', 'src');
const sandbox = { console, Math };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['rng.js', 'map.js', 'entities.js', 'combat.js']) {
    vm.runInContext(fs.readFileSync(path.join(src, f), 'utf8'), sandbox, { filename: f });
}
const SV = sandbox.SV;

let problems = 0;
let floors = 0;
const counts = {};
const fail = (msg) => { problems++; if (problems < 20) console.log('FAIL', msg); };

for (let seed = 0; seed < 300; seed++) {
    const run = SV.buildRun(seed);
    if (run.nodes.length !== SV.FLOOR_COUNT + 1) fail(`seed ${seed}: node count`);
    for (const node of run.nodes) {
        if (node.type !== 'floor') continue;
        floors++;
        const cfg = node.floor;
        const a = SV.generateFloor(cfg, node.seed, node.depth);
        const b = SV.generateFloor(cfg, node.seed, node.depth);
        if (JSON.stringify(a) !== JSON.stringify(b)) fail(`seed ${seed} floor ${node.depth}: not deterministic`);
        const { map, start, enemies, items, barrels, traps } = a;
        const tag = `seed ${seed} floor ${node.depth}`;
        const w = map.width;
        if (map.width !== cfg.width || map.height !== cfg.height) fail(`${tag}: size`);
        for (let x = 0; x < w; x++) for (const y of [0, map.height - 1]) if (SV.tileAt(map, x, y) !== '#') fail(`${tag}: border`);
        for (let y = 0; y < map.height; y++) for (const x of [0, w - 1]) if (SV.tileAt(map, x, y) !== '#') fail(`${tag}: border`);
        if (SV.tileAt(map, start.x, start.y) !== '.') fail(`${tag}: start not on floor`);
        if (map.tiles.filter(t => t === '>').length !== 1) fail(`${tag}: stairs count`);

        // Doors / closets
        const doors = map.tiles.filter(t => t === 'D').length;
        if (doors !== (cfg.closet ? 1 : 0)) fail(`${tag}: ${doors} doors, closet=${cfg.closet}`);
        const open = SV.distanceMap(map, start.x, start.y, true);
        const closed = SV.distanceMap(map, start.x, start.y, false);
        map.tiles.forEach((t, i) => { if (t !== '#' && open[i] < 0) fail(`${tag}: unreachable tile ${i}`); });
        if (map.tiles[closed.indexOf(-1)] === undefined) {} // noop
        const behindDoor = map.tiles.map((t, i) => (t === '.' && closed[i] < 0) ? i : -1).filter(i => i >= 0);
        if (cfg.closet && behindDoor.length !== 2) fail(`${tag}: closet has ${behindDoor.length} tiles`);
        if (!cfg.closet && behindDoor.length !== 0) fail(`${tag}: hidden tiles without closet`);
        if (closed[map.tiles.indexOf('>')] < 0) fail(`${tag}: stairs behind door`);

        // Entities
        const seen = new Set([`${start.x},${start.y}`]);
        const place = (kind, e) => {
            const k = `${e.x},${e.y}`;
            if (seen.has(k)) fail(`${tag}: ${kind} overlaps at ${k}`);
            seen.add(k);
            const t = SV.tileAt(map, e.x, e.y);
            if (t !== '.') fail(`${tag}: ${kind} on '${t}'`);
            counts[kind] = (counts[kind] || 0) + 1;
        };
        enemies.forEach(e => place(e.type, e));
        items.forEach(i => place(i.kind, i));
        barrels.forEach(br => place('barrel', br));
        traps.forEach(t => place(t.timed ? 'timedSpikes' : 'spikes', t));
        if (traps.length !== cfg.traps) fail(`${tag}: ${traps.length} traps, expected ${cfg.traps}`);
        traps.forEach(t => {
            if (closed[t.y * w + t.x] < 2) fail(`${tag}: trap too close to start`);
            if (t.timed && node.depth < 4) fail(`${tag}: timed trap too early`);
            if (![0, 1, 2].includes(t.phase)) fail(`${tag}: bad phase`);
        });
        enemies.forEach(e => { if (SV.ENEMY_TYPES[e.type].minDepth > node.depth) fail(`${tag}: ${e.type} too early`); });
        const keys = items.filter(i => i.kind === 'key');
        if (keys.length !== (cfg.closet ? 1 : 0)) fail(`${tag}: ${keys.length} keys`);
        keys.forEach(k => { if (closed[k.y * w + k.x] < 0) fail(`${tag}: key behind door`); });
        if (cfg.closet) {
            const inCloset = items.filter(i => closed[i.y * w + i.x] < 0);
            if (inCloset.length < 1) fail(`${tag}: empty closet`);
        }
        barrels.forEach(br => { if (closed[br.y * w + br.x] < 3) fail(`${tag}: barrel too close to start`); });
        const budget = enemies.reduce((s, e) => s + SV.ENEMY_TYPES[e.type].cost, 0);
        if (budget > cfg.enemyBudget) fail(`${tag}: over budget`);
    }
}
console.log(`${floors} floors checked, ${problems} problems.`);
console.log(counts);

// One sample closet floor, printed.
const node = SV.buildRun(42).nodes[3];
const sample = SV.generateFloor(node.floor, node.seed, node.depth);
const rows = [];
for (let y = 0; y < sample.map.height; y++) {
    let row = '';
    for (let x = 0; x < sample.map.width; x++) {
        const e = sample.enemies.find(en => en.x === x && en.y === y);
        const it = sample.items.find(en => en.x === x && en.y === y);
        const br = sample.barrels.find(en => en.x === x && en.y === y);
        row += (sample.start.x === x && sample.start.y === y) ? '@' : e ? e.type[0] : br ? 'O' : it ? it.kind[0].toUpperCase() : sample.map.tiles[y * sample.map.width + x];
    }
    rows.push(row);
}
console.log(rows.join('\n'));
