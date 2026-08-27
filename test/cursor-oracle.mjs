// WHAT THE CURSOR ACTUALLY EMITS. The path is only worth anything if the stream of mousemoves it
// produces does not read as a tween, so this measures that stream rather than the code that makes
// it: the REAL cdpMove out of background-script.js and the REAL fittsScale out of content-script.js
// are lifted from source and run here with the dispatch and the clock stubbed. Nothing is
// reimplemented; a rewrite of the path that kept the old shape would still be caught.
//
// The four numbers, and what a HAND does:
//   tPeak   fraction of the move at which speed peaks     -- ballistic, ~0.3, not 0.5
//   d@half  fraction of the distance covered by half time -- past half, ~0.75-0.85, not 0.5
//   dev     how far the path bows off the straight chord, and how much WHERE it peaks varies --
//           a symmetric bow peaks at 0.5 on every single move, so the spread is the asymmetry
//   ratio   a long move's budget over a short one's       -- Fitts's law, > 1
//
// Run:  node test/cursor-oracle.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const slice = (file, from, to) => {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const a = s.indexOf(from), b = s.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`${file}: cannot find ${a < 0 ? from : to} -- has the path moved?`);
    return s.slice(a, b);
};

// --- the emitted stream -------------------------------------------------------------------------
const points = [];
let clock = 0;
const ctx = vm.createContext({
    Math, Date: {now: () => clock}, console,
    cdpDispatch: async (_t, e) => { points.push({t: clock, x: e.x, y: e.y}); },
    cdpSleep: async (ms) => { clock += ms; },
    pacedCalls: 0, pacedTotalMs: 0,
    stepCostMs: () => 16,             // the idle-Mac average the worker itself falls back to
});
vm.runInContext(slice('src/scripts/background-script.js', 'function pathSteps(travelMs)',
                      '// How long to let the page settle'), ctx);
// ...and the move's own budget, which is where Fitts lives
vm.runInContext(slice('src/scripts/content-script.js', 'const FITTS_REF_ID',
                      '    function fittsScale'), ctx);
vm.runInContext(slice('src/scripts/content-script.js', '    function fittsScale',
                      '    // move_time (+ variance)')
    .replace('getBoundsFromCoords(fromSq)', 'B(fromSq)').replace('getBoundsFromCoords(toSq)', 'B(toSq)')
    .replace('boardBounds.width', 'BOARD'), ctx);
// an 8x8 board of 60px squares, so a square's width is the width the law is measured against
ctx.BOARD = 480;
ctx.B = (sq) => ({x: (sq.charCodeAt(0) - 97) * 60 + 30, y: (8 - Number(sq[1])) * 60 + 30});

async function move(dist, travelMs) {
    points.length = 0; clock = 0;
    await ctx.cdpMove(null, 0, 0, dist, 0, travelMs);
    return points.slice();
}

function shape(pts, dist) {
    const T = pts[pts.length - 1].t || 1;
    let peakV = -1, tPeak = 0, dev = 0, devAt = 0;
    for (let i = 1; i < pts.length; i++) {
        const dt = Math.max(1, pts[i].t - pts[i - 1].t);
        const v = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / dt;
        if (v > peakV) { peakV = v; tPeak = (pts[i].t + pts[i - 1].t) / 2 / T; }
        const off = Math.abs(pts[i].y);                       // the chord is the x axis here
        if (off > dev) { dev = off; devAt = pts[i].x / dist; }
    }
    const half = pts.reduce((best, p) => Math.abs(p.t - T / 2) < Math.abs(best.t - T / 2) ? p : best, pts[0]);
    return {n: pts.length, T, rate: pts.length / (T / 1000), tPeak, dHalf: half.x / dist, dev, devAt};
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2)));
const f = (x, d = 2) => x.toFixed(d);
// The clock is stubbed at the worker's own idle-Mac step cost (16ms), so `rate` here is the shape
// the code asks for, not what a loaded browser delivers -- the browser figure is measured live.
console.log('the emitted mousemove stream (30 moves per distance, 1 thread, no browser)\n');
console.log('  dist   budget    n    rate/s   tPeak   d@half   dev px   dev at +- spread');
for (const [dist, travelMs] of [[80, 200], [240, 400], [520, 700]]) {
    const runs = [];
    for (let i = 0; i < 30; i++) runs.push(shape(await move(dist, travelMs), dist));
    console.log(`  ${String(dist).padStart(4)}px  ${String(travelMs).padStart(4)}ms  `
        + `${f(mean(runs.map(r => r.n)), 1).padStart(4)}  ${f(mean(runs.map(r => r.rate)), 1).padStart(6)}   `
        + `${f(mean(runs.map(r => r.tPeak)))}    ${f(mean(runs.map(r => r.dHalf)))}    `
        + `${f(mean(runs.map(r => r.dev)), 1).padStart(5)}    ${f(mean(runs.map(r => r.devAt)))} +- ${f(sd(runs.map(r => r.devAt)))}`);
}

// --- Fitts: the same move time, priced by the move's own difficulty ------------------------------
console.log('\nFitts scaling of the move budget (a 60px square, so the index is log2(d/w + 1))');
for (const [a, b] of [['e2', 'e3'], ['e2', 'e4'], ['a1', 'd4'], ['a1', 'h8']]) {
    console.log(`  ${a}->${b}  x${f(ctx.fittsScale(a, b))}`);
}
const lo = ctx.fittsScale('e2', 'e3'), hi = ctx.fittsScale('a1', 'h8');
console.log(`  spread: x${f(hi / lo)}  (a tween is x1.00)`);

// --- overshoot: how often the path sails past and corrects ---------------------------------------
let over = 0;
const N = 400;
for (let i = 0; i < N; i++) {
    const pts = await move(300, 500);
    if (pts.some(p => p.x > 300 + 3)) over++;        // past the target, beyond the +-0.75px jitter
}
console.log(`\novershoot-and-correct on ${f(over / N * 100, 1)}% of long moves (aimed at ~30%)`);
