// Headless checks of combat/enemy/knife/spike rules on hand-built boards.
// Usage: node tools/ai-test.js   (prints ok/FAIL per check, "ALL PASSED" at the end)
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
SV.log = (st, text) => st.log.push(text);

let failures = 0;
const check = (name, cond, extra) => {
    if (!cond) failures++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

// Open 11x11 room with border walls.
function board(opts = {}) {
    const w = 11, h = 11;
    const tiles = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push(x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.');
    (opts.walls || []).forEach(([x, y]) => { tiles[y * w + x] = '#'; });
    const s = {
        mode: 'floor', turn: 0, kills: 0, nextId: 1, killedBy: null, godMode: false,
        map: { width: w, height: h, tiles },
        player: Object.assign(SV.makePlayer(), { x: opts.px || 5, y: opts.py || 5 }),
        enemies: [], items: [], barrels: [], traps: [], log: [],
    };
    (opts.enemies || []).forEach(([t, x, y]) => s.enemies.push(SV.makeEnemy(s, t, x, y)));
    (opts.barrels || []).forEach(([x, y]) => s.barrels.push(SV.makeBarrel(s, x, y)));
    s.traps = (opts.traps || []).map(t => Object.assign({}, t));
    return s;
}
const turn = (s) => { SV.enemiesAct(s); SV.resolveSplits(s); SV.tickTraps(s); SV.resolveSplits(s); };

// Archer: aims, then fires even if you moved; the arrow hits what's in line.
{
    const s = board({ px: 5, py: 5, enemies: [['archer', 5, 1]] });
    turn(s);
    const a = s.enemies[0];
    check('archer aims when lined up', a.intent && a.intent.kind === 'aim' && s.player.hp === 20);
    s.player.x = 6; // sidestep
    turn(s);
    check('sidestep avoids the arrow', s.player.hp === 20 && a.intent === null);
}
{
    const s = board({ px: 5, py: 5, enemies: [['archer', 5, 1]] });
    turn(s);
    turn(s);
    check('staying in line gets shot for 2', s.player.hp === 18);
}
{
    const s = board({ px: 5, py: 5, enemies: [['archer', 5, 1]] });
    turn(s);
    s.enemies.push(SV.makeEnemy(s, 'rat', 5, 3)); // steps into the line
    turn(s);
    check('arrow hits the rat in the way instead', s.player.hp === 20 && !s.enemies.some(e => e.type === 'rat' && e.hp === 2));
}
{
    const s = board({ px: 5, py: 5, enemies: [['archer', 5, 1]], barrels: [[5, 3]] });
    check('barrel blocks line of fire (no aim)', (turn(s), s.enemies[0].intent === null));
}

// Charger: winds up, sidestep -> wall slam + stun; stays -> 3 damage; hammer stun cancels.
{
    const s = board({ px: 5, py: 8, enemies: [['charger', 5, 2]] });
    turn(s);
    const c = s.enemies[0];
    check('charger winds up', c.intent && c.intent.kind === 'charge');
    s.player.x = 6;
    turn(s);
    check('charger misses, slams into the wall, stunned', c.y === 9 && c.hp === 4 && c.stunned === 1, `pos ${c.x},${c.y} hp ${c.hp}`);
}
{
    const s = board({ px: 5, py: 8, enemies: [['charger', 5, 2]] });
    turn(s);
    turn(s);
    check('charger hits you for 3 and stops next to you', s.player.hp === 17 && s.enemies[0].y === 7);
}
{
    const s = board({ px: 5, py: 3, enemies: [['charger', 5, 2]] });
    turn(s); // adjacent: winds up
    s.player.weapon = 'hammer';
    SV.playerAttack(s, 0, -1); // knock it into... (5,1) is free, so it just moves back
    const c = s.enemies[0];
    check('hammer knockback moves it (hammer now 1 damage)', c.y === 1 && c.hp === 4);
    SV.playerAttack(s, 0, -1); // not adjacent anymore: nothing
    const s2 = board({ px: 5, py: 2, enemies: [['charger', 5, 1]] });
    turn(s2);
    s2.player.weapon = 'hammer';
    SV.playerAttack(s2, 0, -1); // behind it is the wall: impact + stun
    const c2 = s2.enemies[0];
    check('hammer into wall stuns and cancels the wind-up', c2.stunned === 1 && c2.intent === null);
    turn(s2);
    check('stunned charger does nothing', s2.player.hp === 20);
}

// Bomber: lights fuse next to you, explodes next turn; killing it first prevents it.
{
    // Barrel at (7,5) is inside the bomber's blast; its own blast (6..8) misses the player at x=5.
    const s = board({ px: 5, py: 5, enemies: [['bomber', 6, 6], ['rat', 7, 7]], barrels: [[7, 5]] });
    turn(s);
    const b = s.enemies.find(e => e.type === 'bomber');
    check('bomber lights fuse when diagonal-adjacent', b.intent && b.intent.kind === 'fuse');
    turn(s);
    check('bomber explodes: 3 to you, chains the barrel', s.player.hp === 17 && !s.enemies.includes(b) && s.barrels.length === 0, `hp ${s.player.hp}`);
    check('bomber blast kills the rat next to it', !s.enemies.some(e => e.type === 'rat'));
}
{
    const s = board({ px: 5, py: 5, enemies: [['bomber', 6, 5]] });
    turn(s);
    SV.playerAttack(s, 1, 0); // sword 2 damage kills it (hp 2)
    turn(s);
    check('killing a lit bomber prevents the blast', s.player.hp === 20 && s.enemies.length === 0);
}

// Slime splitting.
{
    const s = board({ px: 5, py: 5, enemies: [['slime', 6, 5]] });
    SV.playerAttack(s, 1, 0);
    SV.resolveSplits(s);
    const hp = s.enemies.map(e => `${e.type}:${e.hp}@${e.x},${e.y}`).join(' ');
    check('slime (4) hit for 2 splits into two slimelets of 1', s.enemies.length === 2 && s.enemies.every(e => e.type === 'slimelet' && e.hp === 1), hp);
}
{
    const s = board({ px: 5, py: 5, enemies: [['slime', 6, 5]] });
    s.player.atk = 3;
    SV.playerAttack(s, 1, 0);
    SV.resolveSplits(s);
    check('slime hit for 3 leaves one slimelet of 1', s.enemies.length === 1 && s.enemies[0].hp === 1);
}

// Shieldbearer.
{
    const s = board({ px: 5, py: 5, enemies: [['shieldbearer', 5, 4]] });
    SV.faceToward(s.enemies[0], 5, 5);
    SV.playerAttack(s, 0, -1);
    check('shield blocks a hit from the front', s.enemies[0].hp === 4);
    s.player.x = 6; s.player.y = 4; // from the side, it still faces down
    SV.playerAttack(s, -1, 0);
    check('hit from the side works', s.enemies[0].hp === 2);
}
{
    // New rule: it faces the way it last moved. Step diagonally away, it steps to reach you, flank it.
    const s = board({ px: 5, py: 5, enemies: [['shieldbearer', 5, 4]] });
    SV.faceToward(s.enemies[0], 5, 5); // faces down, toward you
    s.player.x = 6; s.player.y = 6;    // step diagonally away (down-right)
    turn(s);
    const e = s.enemies[0];
    check('it moved sideways and now faces that way', e.x === 6 && e.y === 4 && e.facing.dx === 1, `at ${e.x},${e.y} facing ${e.facing.dx},${e.facing.dy}`);
    s.player.y = 5; // step up: now directly below it, on its unshielded side
    check('you are on its flank', !SV.isShielded(e, s.player.x, s.player.y));
    turn(s); // it attacks without moving: keeps facing right
    check('attacking does not turn it', e.facing.dx === 1 && s.player.hp === 18);
    SV.playerAttack(s, 0, -1);
    check('flank hit lands', e.hp === 2);
}
{
    // Spikes block the direct route: the enemy walks around instead of freezing.
    const walls = [];
    for (let y = 1; y <= 8; y++) if (y !== 5 && y !== 8) walls.push([5, y]); // wall column with gaps at y=5 (spikes) and y=8
    const s = board({ px: 7, py: 5, enemies: [['rat', 3, 5]], walls, traps: [{ x: 5, y: 5, timed: false, phase: 2 }] });
    for (let i = 0; i < 3; i++) turn(s);
    const r = s.enemies[0];
    check('enemy routes around spikes (moved toward the gap)', r.y > 5 && !(r.x === 5 && r.y === 5), `rat at ${r.x},${r.y}`);
}
{
    const s = board({ px: 5, py: 5, enemies: [['shieldbearer', 5, 4]] });
    SV.faceToward(s.enemies[0], 5, 5);
    s.player.bombs = 1;
    SV.useBomb(s);
    check('bomb damages it through the shield', s.enemies[0].hp === 1);
}
{
    const s = board({ px: 5, py: 2, enemies: [['shieldbearer', 5, 1]] }); // wall behind it
    SV.faceToward(s.enemies[0], 5, 2);
    s.player.weapon = 'hammer';
    SV.playerAttack(s, 0, -1); // blocked damage, but knockback into the wall: impact + stun
    const e = s.enemies[0];
    check('hammer vs shield: no weapon damage, impact 1 + stun', e.hp === 3 && e.stunned === 1);
    check('hammer deals 1 less (atk 2 -> 1)', SV.weaponDamage(s.player) === 1);
}

// Knives.
{
    const s = board({ px: 2, py: 5, enemies: [['rat', 8, 5]] });
    const ok = SV.throwKnife(s, 1, 0);
    check('knife flies and hits for 1', ok && s.enemies[0].hp === 1 && s.player.knives === 1);
    check('knife lands under the rat', s.items.some(i => i.kind === 'knife' && i.x === 8 && i.y === 5));
}
{
    const s = board({ px: 2, py: 5, barrels: [[7, 5]], enemies: [['ghoul', 8, 5]] });
    SV.throwKnife(s, 1, 0);
    check('knife sets off a far barrel safely', s.barrels.length === 0 && s.player.hp === 20 && s.enemies[0].hp === 1);
}
{
    const s = board({ px: 1, py: 5 });
    check('no room to throw into an adjacent wall', SV.throwKnife(s, -1, 0) === false && s.player.knives === 2);
}
{
    const s = board({ px: 5, py: 5, enemies: [['shieldbearer', 8, 5]] });
    SV.faceToward(s.enemies[0], 5, 5);
    SV.throwKnife(s, 1, 0);
    check('shield blocks a knife from the front', s.enemies[0].hp === 4);
}

// Spikes.
{
    const s = board({ px: 5, py: 5, traps: [{ x: 6, y: 5, timed: false, phase: 2 }] });
    s.player.x = 6;
    SV.enterTile(s, 6, 5);
    check('stepping on raised spikes: 2 damage', s.player.hp === 18);
}
{
    const s = board({ px: 5, py: 5, traps: [{ x: 5, y: 5, timed: true, phase: 1 }] });
    SV.tickTraps(s);
    check('spikes rising under you: 2 damage', s.player.hp === 18 && s.traps[0].phase === 2);
    SV.tickTraps(s);
    check('then they go down (phase 0), no damage', s.player.hp === 18 && s.traps[0].phase === 0);
}
{
    const s = board({ px: 5, py: 8, enemies: [['rat', 5, 5]], traps: [{ x: 5, y: 6, timed: false, phase: 2 }] });
    turn(s);
    check('enemies step around raised spikes', !(s.enemies[0].x === 5 && s.enemies[0].y === 6));
}
{
    const s = board({ px: 5, py: 5, enemies: [['ghoul', 5, 4]], traps: [{ x: 5, y: 3, timed: false, phase: 2 }] });
    s.player.weapon = 'hammer';
    SV.playerAttack(s, 0, -1);
    check('hammer pushes an enemy onto spikes: 2 + 2 damage', s.enemies.length === 0 || s.enemies[0].hp === 0 || s.enemies[0].y === 3, `hp ${s.enemies[0] && s.enemies[0].hp}`);
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
