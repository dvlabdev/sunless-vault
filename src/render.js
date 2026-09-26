// Drawing only: reads `state`, never changes it (except the UI-only SV.view layout).
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    // Everything drawable: glyph + colors now; Phase 4 adds `sprite` here.
    SV.APPEARANCE = {
        wall:   { glyph: '#', color: '#4a5163', bg: '#1b1e26' },
        floor:  { glyph: '·', color: '#2a2f3a', bg: '#0e0f13' },
        stairs: { glyph: '>', color: '#5dade2', bg: '#0e0f13' },
        door:   { glyph: '+', color: '#f1c40f', bg: '#1b1e26' },
        player: { glyph: '@', color: '#f1c40f' },
        rat:    { glyph: 'r', color: '#c9a27e' },
        ghoul:  { glyph: 'g', color: '#7fb77e' },
        brute:  { glyph: 'B', color: '#e67e22' },
        barrel: { glyph: 'O', color: '#d35400' },
        // items
        potion:    { glyph: '!', color: '#ff6b9d' },
        bomb:      { glyph: '*', color: '#e74c3c' },
        key:       { glyph: '⚷', color: '#f1c40f' },
        whetstone: { glyph: '≡', color: '#aeb6bf' },
        heart:     { glyph: '♥', color: '#e74c3c' },
        sword:     { glyph: '/', color: '#d6eaf8' },
        spear:     { glyph: '↑', color: '#d6eaf8' },
        axe:       { glyph: 'Y', color: '#d6eaf8' },
        hammer:    { glyph: 'T', color: '#d6eaf8' },
    };

    // Run-map icons for special floors.
    const SPECIALS = {
        ambush:   { icon: '!', label: 'ambush' },
        corridor: { icon: '=', label: 'corridor' },
        cavern:   { icon: '+', label: 'cavern' },
    };

    const COLORS = { text: '#e0e6f0', muted: '#78839b', dim: '#3a3f4b', gold: '#f1c40f', red: '#e74c3c', line: '#323745', panel: '#0d0e11' };
    const FONT = '"Courier New", Courier, monospace';
    const LOG_RESERVE = 76; // CSS px kept free at the bottom of the board for the hint + log overlay

    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const hud = {
        hp: document.getElementById('hp-value'),
        floor: document.getElementById('floor-value'),
        weapon: document.getElementById('weapon-value'),
        damage: document.getElementById('damage-value'),
        keys: document.getElementById('keys-value'),
        potions: document.getElementById('potions-value'),
        bombs: document.getElementById('bombs-value'),
        potionButton: document.getElementById('potion-button'),
        bombButton: document.getElementById('bomb-button'),
        turn: document.getElementById('turn-value'),
        debug: document.getElementById('debug-badge'),
    };
    const logEl = document.getElementById('combat-log');
    const hintEl = document.getElementById('hint');

    // Board layout in canvas pixels, shared with tap input (UI data, not game state).
    SV.view = { dpr: 1, tile: 32, ox: 0, oy: 0 };
    // UI preferences set by main.js (not game state): how controls are worded, hint line on/off.
    SV.inputMode = 'keys';
    SV.hintsOn = true;

    // Canvas backing store = CSS size x devicePixelRatio, so it's sharp on every screen.
    SV.resizeCanvas = function () {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        SV.view.dpr = dpr;
    };

    SV.render = function (state) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const analysis = state.mode === 'floor' ? analyzeThreat(state) : null;
        if (state.mode === 'floor' || (state.mode === 'dead' && state.map)) drawFloor(state, analysis);
        else drawRunMap(state);

        const tally = `${plural(state.turn, 'turn')} · ${plural(state.kills, 'kill')}`;
        if (state.mode === 'dead') {
            const depth = state.run.nodes[state.run.current].depth;
            drawOverlay('YOU DIED', COLORS.red, [
                `Slain by ${state.killedBy || 'the dark'} on floor ${depth}`,
                tally,
            ]);
        } else if (state.mode === 'won') {
            drawOverlay('THE VAULT IS OPEN', COLORS.gold, [
                `All ${SV.FLOOR_COUNT} floors cleared`,
                `${tally} · HP ${state.player.hp}/${state.player.maxHp}`,
            ]);
        }

        updateHud(state);
        updateLog(state);
        hintEl.hidden = !SV.hintsOn;
        hintEl.textContent = SV.hintsOn ? hintText(state, analysis) : '';
    };

    // ---- Floor view -------------------------------------------------------

    // Tile size = largest multiple of 16 that fits (keeps pixel art even), board centered.
    function layoutBoard(map) {
        const availH = Math.max(1, canvas.height - LOG_RESERVE * SV.view.dpr);
        const fit = Math.floor(Math.min(canvas.width / map.width, availH / map.height));
        const tile = fit >= 16 ? Math.floor(fit / 16) * 16 : Math.max(1, fit);
        SV.view.tile = tile;
        SV.view.ox = Math.floor((canvas.width - tile * map.width) / 2);
        SV.view.oy = Math.max(0, Math.floor((availH - tile * map.height) / 2));
    }

    function drawFloor(state, analysis) {
        const map = state.map;
        layoutBoard(map);
        const { tile, ox, oy } = SV.view;
        const A = SV.APPEARANCE;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        setFont(tile * 0.75, true);

        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                const t = map.tiles[y * map.width + x];
                const look = t === SV.TILE.WALL ? A.wall : t === SV.TILE.STAIRS ? A.stairs : t === SV.TILE.DOOR ? A.door : A.floor;
                const px = ox + x * tile;
                const py = oy + y * tile;
                ctx.fillStyle = look.bg;
                ctx.fillRect(px, py, tile, tile);
                drawGlyph(look.glyph, look.color, px, py, tile);
            }
        }

        if (analysis) drawThreat(state, analysis);
        const incoming = analysis ? analysis.incoming : new Map();

        // Items under everything else, then barrels, enemies (dimmed while stunned), player.
        for (const item of state.items) {
            drawGlyph(A[item.kind].glyph, A[item.kind].color, ox + item.x * tile, oy + item.y * tile, tile);
        }
        for (const b of state.barrels) {
            drawGlyph(A.barrel.glyph, A.barrel.color, ox + b.x * tile, oy + b.y * tile, tile);
        }
        for (const e of state.enemies) {
            const px = ox + e.x * tile;
            const py = oy + e.y * tile;
            drawGlyph(A[e.type].glyph, e.stunned > 0 ? COLORS.muted : A[e.type].color, px, py, tile);
            drawPips(e.hp, SV.ENEMY_TYPES[e.type].hp, px, py, tile, incoming.get(e) || 0);
        }

        const p = state.player;
        drawGlyph(A.player.glyph, A.player.color, ox + p.x * tile, oy + p.y * tile, tile);
    }

    function drawGlyph(glyph, color, px, py, tile) {
        ctx.fillStyle = color;
        ctx.fillText(glyph, px + tile / 2, py + tile / 2 + tile * 0.04);
    }

    // Small HP squares above an enemy, so fixed damage is easy to plan around.
    // incoming = damage your next attack would deal: those pips turn gold (all gold = lethal).
    function drawPips(hp, maxHp, px, py, tile, incoming) {
        const size = Math.max(2, Math.floor(tile / 10));
        const gap = Math.max(1, Math.floor(size / 2));
        let x = px + Math.floor((tile - (maxHp * size + (maxHp - 1) * gap)) / 2);
        const y = py + Math.max(1, Math.floor(tile * 0.05));
        for (let i = 0; i < maxHp; i++) {
            ctx.fillStyle = i >= hp ? COLORS.dim : i >= hp - incoming ? COLORS.gold : COLORS.red;
            ctx.fillRect(x, y, size, size);
            x += size + gap;
        }
    }

    // What your next key press could do, shared by the threat preview and the hint line.
    // reach  = every tile the weapon can reach from here (faint gold)
    // armed  = tiles an attack would hit right now (bright gold); incoming = enemy -> damage
    // bump / lunge = enemies you can attack by moving (spear lunges step first); spin = axe can swing
    // barrels = [{ barrel, kind: 'armed' | 'kick' | 'diagonal', dx, dy, stop, dangerous }]
    function analyzeThreat(state) {
        const p = state.player;
        const map = state.map;
        const weapon = SV.WEAPONS[p.weapon];
        const pattern = SV.PATTERNS[weapon.pattern];
        const damage = SV.weaponDamage(p);
        const key = (x, y) => y * map.width + x;
        const near = (x, y) => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1;
        const a = { reach: new Set(), armed: new Set(), incoming: new Map(), bump: [], lunge: [], spin: false, barrels: [] };
        const arm = (tiles) => {
            for (const t of tiles) {
                if (!SV.isWalkable(map, t.x, t.y) || a.armed.has(key(t.x, t.y))) continue;
                a.armed.add(key(t.x, t.y));
                const enemy = SV.enemyAt(state, t.x, t.y);
                if (enemy) a.incoming.set(enemy, damage);
            }
        };

        for (const [dx, dy] of SV.DIRS) {
            const tiles = pattern(p.x, p.y, dx, dy);
            tiles.forEach(t => { if (SV.isWalkable(map, t.x, t.y)) a.reach.add(key(t.x, t.y)); });
            const adjacent = SV.enemyAt(state, p.x + dx, p.y + dy);
            const far = SV.enemyAt(state, p.x + 2 * dx, p.y + 2 * dy);
            if (adjacent) {
                a.bump.push(adjacent);
                arm(tiles);
            } else if (weapon.lunge && far && !SV.isBlocked(state, p.x + dx, p.y + dy)) {
                a.lunge.push(far);
                arm(pattern(p.x + dx, p.y + dy, dx, dy));
            }
        }
        if (weapon.spin && SV.enemyAround(state)) {
            a.spin = true;
            arm(pattern(p.x, p.y, 0, 0));
        }

        for (const b of state.barrels) {
            const dx = b.x - p.x;
            const dy = b.y - p.y;
            if (a.armed.has(key(b.x, b.y)) && near(b.x, b.y)) {
                a.barrels.push({ barrel: b, kind: 'armed', dangerous: true }); // your attack would set it off
            } else if (Math.abs(dx) + Math.abs(dy) === 1) {
                const stop = SV.rollDestination(state, b, dx, dy);
                a.barrels.push({ barrel: b, kind: 'kick', dx, dy, stop, dangerous: near(stop.x, stop.y) });
            } else if (near(b.x, b.y)) {
                a.barrels.push({ barrel: b, kind: 'diagonal', dangerous: true }); // a bomb would catch you
            }
        }
        return a;
    }

    // Planning aids, drawn under the entities (see analyzeThreat).
    function drawThreat(state, a) {
        const map = state.map;
        a.reach.forEach(k => { if (!a.armed.has(k)) shadeTile(k % map.width, Math.floor(k / map.width), 'rgba(241, 196, 15, 0.07)'); });
        a.armed.forEach(k => shadeTile(k % map.width, Math.floor(k / map.width), 'rgba(241, 196, 15, 0.24)'));
        for (const info of a.barrels) {
            const b = info.barrel;
            if (info.kind === 'kick') {
                for (let i = 1; i <= info.stop.moved; i++) shadeTile(b.x + info.dx * i, b.y + info.dy * i, 'rgba(211, 84, 0, 0.18)');
                shadeBlast(map, info.stop.x, info.stop.y, info.dangerous);
            } else {
                shadeBlast(map, b.x, b.y, true);
            }
        }
    }

    // One line: the most useful thing you can do right now, worded for touch or keys.
    function hintText(state, a) {
        const touch = SV.inputMode === 'touch';
        if (state.mode === 'map') return touch ? 'Tap to descend' : 'Enter: descend';
        if (state.mode === 'dead' || state.mode === 'won') return touch ? 'Tap for a new run' : 'Enter: new run';

        const p = state.player;
        const name = e => SV.ENEMY_TYPES[e.type].name;
        const hints = [];
        if (a.bump.length > 0) hints.push(touch ? `Tap the ${name(a.bump[0])} to attack` : `Move into the ${name(a.bump[0])} to attack`);
        if (a.lunge.length > 0) hints.push(touch ? `Tap toward the ${name(a.lunge[0])}: step and strike` : `Move toward the ${name(a.lunge[0])}: step and strike`);
        if (a.spin) hints.push(touch ? 'Tap yourself to swing the axe' : 'Space: swing the axe');

        const kick = a.barrels.find(i => i.kind === 'kick');
        if (hints.length < 2 && kick) {
            hints.push((touch ? 'Tap the barrel to kick it' : 'Move into the barrel to kick it') + (kick.dangerous ? ' (it would blow up next to you!)' : ''));
        }
        if (hints.length < 2) {
            const door = SV.DIRS.some(([dx, dy]) => SV.tileAt(state.map, p.x + dx, p.y + dy) === SV.TILE.DOOR);
            if (door) hints.push(p.keys > 0 ? (touch ? 'Tap the door to unlock it' : 'Move into the door to unlock it') : 'Find the key ⚷ to open this door');
        }
        if (hints.length < 2 && p.potions > 0 && p.hp * 3 <= p.maxHp) hints.push(touch ? 'HP low: tap ! to drink' : 'HP low: press P to drink');
        if (hints.length === 0 && state.enemies.length === 0) hints.push('Floor clear: head for the stairs >');
        if (hints.length === 0) hints.push(touch ? 'Tap a tile to move · tap yourself to wait' : 'WASD/arrows to move · Space to wait');
        return hints.slice(0, 2).join(' · ');
    }

    // 3x3 explosion area; red when it includes the player.
    function shadeBlast(map, cx, cy, dangerous) {
        const color = dangerous ? 'rgba(231, 76, 60, 0.30)' : 'rgba(211, 84, 0, 0.16)';
        for (let y = cy - 1; y <= cy + 1; y++) {
            for (let x = cx - 1; x <= cx + 1; x++) {
                if (x > 0 && y > 0 && x < map.width - 1 && y < map.height - 1) shadeTile(x, y, color);
            }
        }
    }

    function shadeTile(x, y, color) {
        const { tile, ox, oy } = SV.view;
        ctx.fillStyle = color;
        ctx.fillRect(ox + x * tile, oy + y * tile, tile, tile);
    }

    // ---- Run map view -----------------------------------------------------

    function drawRunMap(state) {
        const W = canvas.width;
        const H = Math.max(1, canvas.height - LOG_RESERVE * SV.view.dpr);
        const u = Math.max(8, Math.min(W / 24, H / 22)); // base text unit
        const nodes = state.run.nodes;
        const current = state.run.current;

        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        setFont(u * 1.1, true);
        ctx.fillStyle = COLORS.gold;
        ctx.fillText('THE SUNLESS VAULT', W / 2, u * 1.5);

        // Vertical track: floor 1 at the bottom, the Vault at the top.
        const top = u * 3.2;
        const bottom = H - u * 4.2;
        const step = (bottom - top) / (nodes.length - 1);
        const box = Math.max(6, Math.min(step * 0.72, u * 1.5));
        const cx = Math.round(W * 0.3);

        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = Math.max(1, SV.view.dpr * 1.5);
        ctx.beginPath();
        ctx.moveTo(cx, top);
        ctx.lineTo(cx, bottom);
        ctx.stroke();

        nodes.forEach((node, i) => {
            const cy = bottom - i * step;
            const look = describeNode(node, i, current);
            ctx.fillStyle = COLORS.panel;
            ctx.fillRect(cx - box / 2, cy - box / 2, box, box);
            ctx.strokeStyle = look.border;
            ctx.lineWidth = Math.max(1, SV.view.dpr * (i === current ? 2 : 1));
            ctx.strokeRect(cx - box / 2, cy - box / 2, box, box);

            ctx.textAlign = 'center';
            setFont(box * 0.7, true);
            ctx.fillStyle = look.color;
            ctx.fillText(look.glyph, cx, cy + box * 0.04);

            ctx.textAlign = 'left';
            setFont(Math.min(u * 0.8, box * 0.85), i === current);
            ctx.fillStyle = look.labelColor;
            ctx.fillText(look.label, cx + box * 0.9, cy);
        });

        const p = state.player;
        ctx.textAlign = 'center';
        setFont(u * 0.85, true);
        ctx.fillStyle = COLORS.text;
        const weapon = p.weapon.charAt(0).toUpperCase() + p.weapon.slice(1);
        ctx.fillText(`HP ${p.hp}/${p.maxHp}  ATK ${p.atk}  ${weapon}  Kills ${state.kills}`, W / 2, H - u * 2.6);
        if (state.mode === 'map') {
            setFont(u * 0.75, false);
            ctx.fillStyle = COLORS.muted;
            ctx.fillText('[Enter / tap] descend', W / 2, H - u * 1.3);
        }
    }

    // Glyph, colors and label for one run-map node. Floors more than 2 ahead stay hidden.
    function describeNode(node, index, current) {
        if (node.type === 'vault') {
            return { glyph: 'V', color: COLORS.gold, border: index === current ? COLORS.gold : COLORS.line, label: 'The Sunless Vault', labelColor: COLORS.gold };
        }
        const f = node.floor;
        const special = SPECIALS[f.special];
        const details = `${f.width}×${f.height}${special ? ' ' + special.label : ''}`;
        if (index < current) {
            return { glyph: '×', color: COLORS.dim, border: COLORS.line, label: `Floor ${node.depth}`, labelColor: COLORS.dim };
        }
        if (index === current) {
            return { glyph: '@', color: COLORS.gold, border: COLORS.gold, label: `Floor ${node.depth} · ${details}`, labelColor: COLORS.gold };
        }
        if (index <= current + 2) {
            return { glyph: special ? special.icon : '·', color: COLORS.text, border: COLORS.line, label: `Floor ${node.depth} · ${details}`, labelColor: COLORS.muted };
        }
        return { glyph: '?', color: COLORS.muted, border: COLORS.line, label: `Floor ${node.depth}`, labelColor: COLORS.muted };
    }

    // ---- Overlays, HUD, log -----------------------------------------------

    function drawOverlay(title, color, lines) {
        const W = canvas.width;
        const H = canvas.height;
        const u = Math.max(8, Math.min(W / 24, H / 22));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        setFont(u * 1.4, true);
        ctx.fillStyle = color;
        ctx.fillText(title, W / 2, H / 2 - u * 2.5);
        setFont(u * 0.8, false);
        ctx.fillStyle = COLORS.text;
        lines.forEach((line, i) => ctx.fillText(line, W / 2, H / 2 + i * u * 1.3));
        ctx.fillStyle = COLORS.muted;
        ctx.fillText('[Enter / tap] new run', W / 2, H / 2 + (lines.length + 1) * u * 1.3);
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function setFont(size, bold) {
        ctx.font = `${bold ? 'bold ' : ''}${Math.max(1, Math.round(size))}px ${FONT}`;
    }

    function updateHud(state) {
        const p = state.player;
        const node = state.run.nodes[state.run.current];
        hud.hp.textContent = `${p.hp}/${p.maxHp}`;
        hud.floor.textContent = node.type === 'vault' ? 'V' : String(node.depth);
        hud.weapon.textContent = p.weapon.charAt(0).toUpperCase() + p.weapon.slice(1);
        hud.damage.textContent = String(SV.weaponDamage(p));
        hud.keys.textContent = String(p.keys);
        hud.potions.textContent = String(p.potions);
        hud.bombs.textContent = String(p.bombs);
        hud.potionButton.disabled = state.mode !== 'floor' || p.potions === 0;
        hud.bombButton.disabled = state.mode !== 'floor' || p.bombs === 0;
        hud.turn.textContent = String(state.turn);
        hud.debug.hidden = !state.debug;
        hud.debug.textContent = state.godMode ? 'DEBUG·GOD' : 'DEBUG';
    }

    // Last 3 messages; CSS fades the older ones. textContent only: no HTML injection.
    function updateLog(state) {
        logEl.textContent = '';
        for (const entry of state.log.slice(-3)) {
            const line = document.createElement('p');
            line.className = `log-entry ${entry.cls}`;
            line.textContent = entry.text;
            logEl.appendChild(line);
        }
    }
})();
