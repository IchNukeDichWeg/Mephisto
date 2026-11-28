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
    // cdpMove skips a tab that has stopped answering moves. Empty here: this tab answers, so the
    // path is drawn. Without the stub the whole oracle died on `moveStalled is not defined`.
    moveStalled: new Map(),
    lastDrawn: new Map(),     // where cdpMove reports it finished; the click section below reads it
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
    await ctx.cdpMove({tabId: 1}, 0, 0, dist, 0, travelMs);
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
const median = (a) => {
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
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

// --- THE CLICK ITSELF, not the path to it --------------------------------------------------------
// The path was the only thing measured here, and the click at the end of it was never looked at.
// Three numbers a page can read straight off a pointerdown, with no trajectory analysis at all:
//
//   dwell_ms   arrival at the square to the press. A hand lands and settles; measured human dwell
//              is tens of milliseconds, never zero.
//   hold_ms    press to release. A real click holds the button 60-120 ms. Zero is impossible.
//   press_dpx  how far the press is from where the path actually ended. Waypoints carry +-0.75px
//              of jitter and the press used the un-jittered nominal target, so a press that does
//              not sit on the last mousemove is a discontinuity no hand produces.
//   dt sd      spread of the gap between consecutive mousemoves. Pacing to an absolute deadline
//              with waypoints uniform in t makes every gap identical, which a real hand's is not.
//
// cdpClick is lifted whole, the same way cdpMove is, so these measure the shipped click.
const clickCtx = vm.createContext({
    Math, Date: {now: () => clock}, console,
    cdpDispatch: async (_t, e) => { events.push({t: clock, ...clickCtx.withForce(e)}); },
    cdpSleep: async (ms) => { clock += ms; },
    pacedCalls: 0, pacedTotalMs: 0,
    stepCostMs: () => 16,
    moveStalled: new Map(),
    lastDrawn: new Map(),
    cdpInputTabs: new Set(),
    lastPos: new Map(),
    cdpAttach: async () => ({tabId: 1}),
    setTimeout, clearTimeout, Promise,
});
let events = [];
// cdpClick reads two constants that live above the dispatcher, which cannot be lifted here (it
// talks to chrome.debugger). Take their VALUES from source rather than restating them, so a change
// to either one shows up in these numbers instead of being silently shadowed by a stale copy.
const constFromSource = (name) => {
    const src = fs.readFileSync(path.join(ROOT, 'src/scripts/background-script.js'), 'utf8');
    const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
    if (!m) throw new Error(`${name} is no longer a plain numeric const -- fix this oracle`);
    return Number(m[1]);
};
clickCtx.CDP_CLICK_GRACE_MS = constFromSource('CDP_CLICK_GRACE_MS');
// Only the force helper, stopping at the dispatcher: cdpDispatch itself talks to chrome.debugger
// and is replaced by the recording stub above. The stub routes through the REAL withForce, so the
// force column below is the value the page would actually receive.
vm.runInContext(slice('src/scripts/background-script.js', '// WHAT THE PAGE READS OFF THE BUTTON',
                      'const cdpDispatch ='), clickCtx);
// the path, exactly as the section above lifts it
vm.runInContext(slice('src/scripts/background-script.js', 'function pathSteps(travelMs)',
                      '// How long to let the page settle'), clickCtx);
vm.runInContext(slice('src/scripts/background-script.js', 'function cdpClick(tabId',
                      '// Press at the origin, travel with the button DOWN'), clickCtx);

async function click(fromX, fromY, x, y, travelMs) {
    events = []; clock = 0;
    clickCtx.lastPos.set(1, {x: fromX, y: fromY});
    await clickCtx.cdpClick(1, x, y, travelMs);
    return events.slice();
}

function clickShape(evs) {
    const moves = evs.filter(e => e.type === 'mouseMoved');
    const press = evs.find(e => e.type === 'mousePressed');
    const rel = evs.find(e => e.type === 'mouseReleased');
    const last = moves[moves.length - 1];
    const dts = [];
    for (let i = 1; i < moves.length; i++) dts.push(moves[i].t - moves[i - 1].t);
    return {
        dwell: press && last ? press.t - last.t : NaN,
        hold: press && rel ? rel.t - press.t : NaN,
        pressDpx: press && last ? Math.hypot(press.x - last.x, press.y - last.y) : NaN,
        dtMean: dts.length ? mean(dts) : NaN,
        dtSd: dts.length ? sd(dts) : NaN,
        dts,
        moves: moves.length,
        force: press ? press.force : undefined,
    };
}

// THE SHAPE OF THE GAP, which the mean and the sd between them cannot show. A uniform smear and a
// hard grid with dropped beats can carry the SAME sd while looking nothing alike in a histogram,
// and the histogram is what a detector reads. Pooled over the whole row: a single pathed click
// carries 3-30 gaps, far too few for a share.
//
// Measured on a real hand (test/record-cursor.html, 6,532 gaps, 27.11.2026): p50 8.2 ms, 87.1% of
// gaps inside 8.0-8.4, the core spread 0.30 ms = 3.7% of the mean, and the rest a sparse tail with
// a clear spike at 16.4 = exactly two polling quanta, one beat dropped. on_grid ~0.90, skip ~0.08.
function dtShape(all) {
    if (all.length < 2) return {p50: NaN, onGrid: NaN, skip: NaN};
    const srt = all.slice().sort((a, b) => a - b);
    const p50 = srt[Math.floor(srt.length / 2)] || 1;
    return {
        p50,
        onGrid: all.filter(d => Math.abs(d - p50) <= 0.10 * p50).length / all.length,
        skip: all.filter(d => d >= 1.7 * p50 && d <= 2.3 * p50).length / all.length,
    };
}

console.log('\nthe click at the end of the path (30 clicks per row)\n');
// dwell and hold are p50s because the hand line below quotes p50s. Both are drawn lognormal, so a
// mean sits above the median by exp(sd^2/2): hold read ~89-90 ms against HOLD_MED_MS 85 and the
// hand's 83, a ~6 ms gap that the p50 (84-87 ms over 1000 clicks per row) does not have.
console.log('  travel   moves  dwell_p50  hold_p50   press_dpx   dt_ms   dt_sd   on_grid   skip   force');
for (const travelMs of [8, 120, 300, 600]) {
    const runs = [];
    for (let i = 0; i < 30; i++) runs.push(clickShape(await click(0, 0, 300, 120, travelMs)));
    const col = (k, d = 2, stat = mean) => f(stat(runs.map(r => r[k]).filter(v => !Number.isNaN(v))) || 0, d);
    const g = dtShape(runs.flatMap(r => r.dts));
    console.log(`  ${String(travelMs).padStart(4)}ms  ${col('moves', 1).padStart(6)}   `
        + `${col('dwell', 1, median).padStart(7)}   ${col('hold', 1, median).padStart(7)}   ${col('pressDpx').padStart(8)}   `
        + `${col('dtMean', 1).padStart(5)}   ${col('dtSd', 2).padStart(5)}   `
        + `${f(g.onGrid).padStart(7)}   ${f(g.skip).padStart(4)}   ${runs[0].force}`);
}
console.log('\n  a hand: dwell p50 23 ms, hold p50 83 ms, press_dpx 0, on_grid ~0.90 with skip ~0.08,');
console.log('          force 0.5. on_grid near 1.00 with skip 0.00 is a perfect grid; on_grid low');
console.log('          with skip low is a smear, which is a different wrong shape, not a fix.');
