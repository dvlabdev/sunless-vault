// Seeded random number generator (mulberry32).
// The generator's current value lives in a plain object's `.rng` field (a "holder":
// usually `state`, or a temporary `{ rng: seed }`), so it is saved with the game
// and a restored run continues exactly as it would have.
(function () {
    'use strict';
    const SV = window.SV = window.SV || {};

    // Float in [0, 1). Advances holder.rng.
    SV.random = function (holder) {
        let t = holder.rng = (holder.rng + 0x6D2B79F5) | 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Integer in [min, max], both inclusive.
    SV.randInt = function (holder, min, max) {
        return min + Math.floor(SV.random(holder) * (max - min + 1));
    };

    SV.pick = function (holder, list) {
        return list[Math.floor(SV.random(holder) * list.length)];
    };

    // Fisher-Yates shuffle, in place.
    SV.shuffle = function (holder, list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(SV.random(holder) * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    };

    // Seed for a brand-new run: the only place Math.random() is allowed.
    SV.newSeed = function () {
        return Math.floor(Math.random() * 4294967296);
    };
})();
