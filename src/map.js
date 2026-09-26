// Floors and the run map: floor plan, floor generation, reachability and distances.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    const WALL = '#';
    const FLOOR = '.';
    const STAIRS = '>';
    const DOOR = 'D'; // locked door; becomes FLOOR once opened
    SV.TILE = { WALL, FLOOR, STAIRS, DOOR };

    // Fixed order (up, right, down, left) so ties are always broken the same way.
    const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    SV.DIRS = DIRS;

    // One entry per floor, from floor 1 upward to the last floor before the Vault.
    // Sizes include the outer walls. special: null | 'ambush' | 'corridor' | 'cavern'.
    // loot = loose items, barrels = explosive barrels, closet = locked treasure closet + key.
    SV.FLOOR_PLAN = [
        { width: 9,  height: 9,  enemyBudget: 3,  special: null,       loot: 1, barrels: 0, closet: false },
        { width: 11, height: 11, enemyBudget: 4,  special: null,       loot: 1, barrels: 1, closet: true },
        { width: 13, height: 11, enemyBudget: 5,  special: null,       loot: 2, barrels: 1, closet: false },
        { width: 15, height: 15, enemyBudget: 6,  special: null,       loot: 2, barrels: 2, closet: true },
        { width: 9,  height: 9,  enemyBudget: 6,  special: 'ambush',   loot: 1, barrels: 2, closet: false },
        { width: 15, height: 15, enemyBudget: 8,  special: null,       loot: 2, barrels: 2, closet: true },
        { width: 17, height: 7,  enemyBudget: 8,  special: 'corridor', loot: 2, barrels: 2, closet: false },
        { width: 15, height: 15, enemyBudget: 10, special: null,       loot: 2, barrels: 3, closet: true },
        { width: 13, height: 13, enemyBudget: 10, special: null,       loot: 2, barrels: 2, closet: false },
        { width: 17, height: 17, enemyBudget: 13, special: 'cavern',   loot: 3, barrels: 4, closet: true },
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
            floor: Object.assign({ vision: null }, cfg),
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

    // Walls and locked doors block movement.
    SV.isWalkable = function (map, x, y) {
        const t = SV.tileAt(map, x, y);
        return t !== WALL && t !== DOOR;
    };

    // Breadth-first search: steps from (sx, sy) to every tile; -1 = unreachable.
    // passDoors = treat locked doors as open (used by floor generation).
    SV.distanceMap = function (map, sx, sy, passDoors) {
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
                const passable = SV.isWalkable(map, nx, ny) || (passDoors && SV.tileAt(map, nx, ny) === DOOR);
                if (!passable || dist[n] !== -1) continue;
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
        const toXY = i => ({ x: i % w, y: Math.floor(i / w) });

        // Treasure closet first, so random walls can't spoil it.
        const reserved = new Set();
        const closet = cfg.closet ? carveCloset(map, holder, reserved) : null;

        // Wall clusters: short random walks of 1-3 tiles.
        if (withWalls) {
            let toPlace = Math.round(inner * (cfg.special === 'ambush' ? 0.08 : 0.16));
            while (toPlace > 0) {
                let x = SV.randInt(holder, 1, w - 2);
                let y = SV.randInt(holder, 1, h - 2);
                const length = SV.randInt(holder, 1, 3);
                for (let i = 0; i < length && toPlace > 0; i++) {
                    const index = y * w + x;
                    if (tiles[index] === FLOOR && !reserved.has(index)) {
                        tiles[index] = WALL;
                        toPlace--;
                    }
                    const [dx, dy] = SV.pick(holder, DIRS);
                    x = Math.min(w - 2, Math.max(1, x + dx));
                    y = Math.min(h - 2, Math.max(1, y + dy));
                }
            }
        }

        const inCloset = i => closet !== null && closet.interior.includes(i);
        const open = [];
        tiles.forEach((t, i) => { if (t === FLOOR && !inCloset(i)) open.push(i); });
        const startIndex = SV.pick(holder, open);
        const start = toXY(startIndex);

        // Pockets the player can't reach (even through the door) become walls.
        const reach = SV.distanceMap(map, start.x, start.y, true);
        tiles.forEach((t, i) => { if (t === FLOOR && reach[i] < 0) tiles[i] = WALL; });

        // The main area: everything reachable without opening the closet door.
        const dist = SV.distanceMap(map, start.x, start.y, false);
        const main = [];
        tiles.forEach((t, i) => { if (t === FLOOR && dist[i] >= 0) main.push(i); });
        if (withWalls && main.length < inner * 0.6) return null;
        if (closet && dist[closet.approach] < 0) return null;

        // Stairs far from the start.
        const maxDist = Math.max(...main.map(i => dist[i]));
        const stairsIndex = SV.pick(holder, main.filter(i => dist[i] >= maxDist * 0.7 && (!closet || i !== closet.approach)));
        tiles[stairsIndex] = STAIRS;

        // Everything else goes on distinct main-area tiles.
        const spots = SV.shuffle(holder, main.filter(i => i !== startIndex && i !== stairsIndex && (!closet || i !== closet.approach)));
        const used = new Set();
        const take = (minDist) => {
            const i = spots.find(s => !used.has(s) && dist[s] >= minDist);
            if (i === undefined) return null;
            used.add(i);
            return toXY(i);
        };

        const enemies = [];
        const minEnemyDist = cfg.special === 'ambush' ? 2 : 4;
        for (const type of SV.chooseEnemies(holder, cfg.enemyBudget, depth)) {
            const spot = take(minEnemyDist);
            if (!spot) break;
            enemies.push({ type, x: spot.x, y: spot.y });
        }

        const items = [];
        if (closet) {
            const key = take(2);
            if (!key) return null;
            items.push({ kind: 'key', x: key.x, y: key.y });
            items.push(Object.assign({ kind: SV.chooseTreasure(holder) }, toXY(closet.interior[0])));
            if (SV.random(holder) < 0.5) items.push(Object.assign({ kind: 'potion' }, toXY(closet.interior[1])));
        }
        for (const kind of SV.chooseLoot(holder, cfg.loot, depth)) {
            const spot = take(1);
            if (!spot) break;
            items.push({ kind, x: spot.x, y: spot.y });
        }

        const barrels = [];
        for (let k = 0; k < cfg.barrels; k++) {
            const spot = take(3);
            if (!spot) break;
            barrels.push(spot);
        }

        return { map, start, enemies, items, barrels };
    }

    // A 2-tile closet against a random outer wall, walled in, with one locked door facing inward.
    // u runs along the chosen wall, v is the distance from it (v = 1 touches the wall).
    function carveCloset(map, holder, reserved) {
        const w = map.width;
        const h = map.height;
        const side = SV.randInt(holder, 0, 3); // top, bottom, left, right
        const along = side < 2 ? w : h;
        const at = (u, v) => {
            if (side === 0) return v * w + u;
            if (side === 1) return (h - 1 - v) * w + u;
            if (side === 2) return u * w + v;
            return u * w + (w - 1 - v);
        };

        const u = SV.randInt(holder, 2, along - 4);
        const interior = [at(u, 1), at(u + 1, 1)];
        const ring = [at(u - 1, 1), at(u + 2, 1)];
        for (let k = u - 1; k <= u + 2; k++) ring.push(at(k, 2));
        const doorU = u + SV.randInt(holder, 0, 1);
        const door = at(doorU, 2);
        const approach = at(doorU, 3); // tile in front of the door, kept open

        ring.forEach(i => { map.tiles[i] = WALL; });
        map.tiles[door] = DOOR;
        interior.concat(ring, [approach]).forEach(i => reserved.add(i));
        return { interior, door, approach };
    }
})();
