// Floors and the run map: floor plan, floor generation, reachability and distances.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    const WALL = '#';
    const FLOOR = '.';
    const STAIRS = '>';
    SV.TILE = { WALL, FLOOR, STAIRS };

    // Fixed order (up, right, down, left) so ties are always broken the same way.
    const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    SV.DIRS = DIRS;

    // One entry per floor, from floor 1 upward to the last floor before the Vault.
    // Sizes include the outer walls. special: null | 'ambush' | 'corridor' | 'cavern'.
    SV.FLOOR_PLAN = [
        { width: 9,  height: 9,  enemyBudget: 2,  special: null },
        { width: 11, height: 11, enemyBudget: 3,  special: null },
        { width: 13, height: 11, enemyBudget: 4,  special: null },
        { width: 15, height: 15, enemyBudget: 5,  special: null },
        { width: 9,  height: 9,  enemyBudget: 5,  special: 'ambush' },
        { width: 15, height: 15, enemyBudget: 6,  special: null },
        { width: 17, height: 7,  enemyBudget: 6,  special: 'corridor' },
        { width: 15, height: 15, enemyBudget: 8,  special: null },
        { width: 13, height: 13, enemyBudget: 8,  special: null },
        { width: 17, height: 17, enemyBudget: 10, special: 'cavern' },
    ];
    SV.FLOOR_COUNT = SV.FLOOR_PLAN.length;

    // Linear run: floor 1 -> ... -> floor N -> Vault. Each node gets its own seed,
    // so a floor's layout depends only on the run seed, not on what the player did.
    SV.buildRun = function (seed) {
        const holder = { rng: seed };
        const nodes = SV.FLOOR_PLAN.map((cfg, i) => ({
            id: i,
            depth: i + 1,
            seed: Math.floor(SV.random(holder) * 4294967296),
            type: 'floor',
            floor: { width: cfg.width, height: cfg.height, enemyBudget: cfg.enemyBudget, vision: null, special: cfg.special },
            next: [i + 1],
            status: i === 0 ? 'current' : 'ahead',
        }));
        nodes.push({ id: nodes.length, depth: nodes.length + 1, seed: 0, type: 'vault', floor: null, next: [], status: 'ahead' });
        return { nodes, current: 0 };
    };

    SV.tileAt = function (map, x, y) {
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) return WALL;
        return map.tiles[y * map.width + x];
    };

    SV.isWalkable = function (map, x, y) {
        return SV.tileAt(map, x, y) !== WALL;
    };

    // Breadth-first search: steps from (sx, sy) to every tile; -1 = unreachable.
    SV.distanceMap = function (map, sx, sy) {
        const w = map.width;
        const dist = new Array(w * map.height).fill(-1);
        const queue = [sy * w + sx];
        dist[queue[0]] = 0;
        for (let head = 0; head < queue.length; head++) {
            const i = queue[head];
            const x = i % w;
            const y = (i - x) / w;
            for (const [dx, dy] of DIRS) {
                const nx = x + dx;
                const ny = y + dy;
                const n = ny * w + nx;
                if (!SV.isWalkable(map, nx, ny) || dist[n] !== -1) continue;
                dist[n] = dist[i] + 1;
                queue.push(n);
            }
        }
        return dist;
    };

    // Builds a floor from its config and seed. Always returns a playable floor.
    SV.generateFloor = function (cfg, seed, depth) {
        const holder = { rng: seed };
        for (let attempt = 0; attempt < 30; attempt++) {
            const floor = tryGenerate(cfg, depth, holder, true);
            if (floor) return floor;
        }
        return tryGenerate(cfg, depth, holder, false); // no inner walls: cannot fail
    };

    function tryGenerate(cfg, depth, holder, withWalls) {
        const w = cfg.width;
        const h = cfg.height;
        const tiles = new Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                tiles[y * w + x] = (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? WALL : FLOOR;
            }
        }
        const map = { width: w, height: h, tiles };
        const inner = (w - 2) * (h - 2);

        // Wall clusters: short random walks of 1-3 tiles.
        if (withWalls) {
            let toPlace = Math.round(inner * (cfg.special === 'ambush' ? 0.08 : 0.16));
            while (toPlace > 0) {
                let x = SV.randInt(holder, 1, w - 2);
                let y = SV.randInt(holder, 1, h - 2);
                const length = SV.randInt(holder, 1, 3);
                for (let i = 0; i < length && toPlace > 0; i++) {
                    if (tiles[y * w + x] === FLOOR) {
                        tiles[y * w + x] = WALL;
                        toPlace--;
                    }
                    const [dx, dy] = SV.pick(holder, DIRS);
                    x = Math.min(w - 2, Math.max(1, x + dx));
                    y = Math.min(h - 2, Math.max(1, y + dy));
                }
            }
        }

        const open = [];
        tiles.forEach((t, i) => { if (t === FLOOR) open.push(i); });
        const startIndex = SV.pick(holder, open);
        const start = { x: startIndex % w, y: Math.floor(startIndex / w) };

        // Pockets the player can't reach become walls, so everything left is reachable.
        const dist = SV.distanceMap(map, start.x, start.y);
        const reachable = [];
        tiles.forEach((t, i) => {
            if (t !== FLOOR) return;
            if (dist[i] < 0) tiles[i] = WALL;
            else reachable.push(i);
        });
        if (withWalls && reachable.length < inner * 0.6) return null;

        // Stairs far from the start.
        const maxDist = Math.max(...reachable.map(i => dist[i]));
        const stairsIndex = SV.pick(holder, reachable.filter(i => dist[i] >= maxDist * 0.7));
        tiles[stairsIndex] = STAIRS;

        // Enemies not too close to the start.
        const minDist = cfg.special === 'ambush' ? 2 : 4;
        const spots = SV.shuffle(holder, reachable.filter(i => i !== stairsIndex && dist[i] >= minDist));
        const types = SV.chooseEnemies(holder, cfg.enemyBudget, depth);
        const enemies = [];
        for (let k = 0; k < types.length && k < spots.length; k++) {
            enemies.push({ type: types[k], x: spots[k] % w, y: Math.floor(spots[k] / w) });
        }

        return { map, start, enemies };
    }
})();
