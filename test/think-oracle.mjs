// WHAT THE THINK CLOCK ACTUALLY EMITS. "Think Like People at This Time Control" starts from a table
// of MEASURED human move times, but between that table and the click sit a log-normal draw, an AR(1)
// rhythm, a kind and a class multiplier, a cap at half the clock left, a subtracted cursor travel and
// two hard rails -- so what the panel waits is not what the study measured. This draws it and counts.
// The REAL hz_think_ms, hz_think_z, hz_think_cap, hz_clock_rail, humanize_tc_inputs, clock_budget_ms,
// lognormal_ms and the pacing tail of humanize_pick are lifted out of src/popup/popup.js with
// node:vm, the way test/cursor-oracle.mjs lifts the real cdpMove. Nothing is reimplemented: a rewrite
// of the think code that kept the old shape is still caught, and a slice whose anchor moved throws
// instead of quietly measuring half the pipeline.
//
// The columns, and what a HUMAN does:
//   mean/med  the average and the typical think. A person's mean sits well ABOVE their median,
//             because move times are log-normal: med/mean near 0.6 is that shape, 1.0 is a flat band.
//   p10/p90   p90 about 2.4x the mean is what blitz players do (the study note on HZ_THINK_SD).
//   log_sd    spread in log space over the POSITIVE thinks, which is how the study reports it.
//   lag1      lag-1 autocorrelation of consecutive log thinks. Players: 0.20 bullet, 0.17 blitz,
//             0.23 rapid, 0.33 classical, and HZ_THINK_RHO is set to exactly those, so this column
//             should come back AT rho and not above it.
//   =0 =250   the share landing on EXACTLY 0 ms and EXACTLY 250 ms. No human clock produces a spike
//   =rail     on one value; hz_clock_rail does (under 8 s nothing, under 20 s a quarter second,
//             above that a fifteenth of what is left) and so do its duplicates in the pacing tail.
//             `rail` is the active rail in ms and `=rail` the share sitting exactly on it. These
//             columns are the reason this instrument exists.
//   <50       share under 50 ms: a move played with no pause a watcher could see.
//   tbl_mean  the study's own mean for that cell (HZ_THINK_MEAN x the estimated game length) and its
//   tbl_sd    log-sd (HZ_THINK_SD): the numbers the draw is supposed to be reproducing.
//   uncap     the draw's mean BEFORE the clock cap and the rails, so a short mean can be told apart
//             from a table that reads wrong.
//
// Inputs the oracle supplies rather than lifts (see the report at the bottom of this header): the
// game phase, the kind mix, the move class, and the Simulated Move Time slider. Everything that
// turns those into milliseconds is lifted.
//
// Run:    node test/think-oracle.mjs          (single-threaded, a few seconds, no network)
// Reseed: edit SEED below. Two runs at the same seed agree exactly.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const slice = (file, from, to) => {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const a = s.indexOf(from), b = s.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`${file}: cannot find ${a < 0 ? from : to} -- has the code moved?`);
    return s.slice(a, b);
};

// mulberry32: one add-xorshift-multiply step. Not a cryptographic generator and does not need to be
// -- what it has to do is give the same 1.2M draws on every run, so a number that moves means the
// think code moved.
const SEED = 20261128;
function rngFrom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let rnd = rngFrom(SEED);

// --- the panel state the lifted code reads ------------------------------------------------------
// Math's methods are non-enumerable own properties, so inherit the whole object and shadow the one
// call that has to be reproducible. Everything inside the vm keeps using Math.log, Math.exp and so on.
const sandboxMath = Object.create(Math);
sandboxMath.random = () => rnd();

// The scrape is "a moment old" everywhere in popup.js (mine - (now - at)/1000). Freezing the clock
// at last_clocks.at makes that age exactly zero, so a cell's clock-left is the number we set and not
// the number minus however long the oracle took.
const NOW = 1700000000000;

let PHASE = 'm';              // the phase row hz_phase_of would return; an INPUT here, see the report
let TRAVEL_SLIDER = 0;        // Simulated Move Time in ms: 0 isolates the think, 400 is the shipped default

const ctx = vm.createContext({
    Math: sandboxMath, Number, Object, String, JSON, console, parseInt, Infinity,
    Date: {now: () => NOW},
    // Shipped defaults, with every pacing toggle off: that is the configuration the think tables were
    // added for, and the one where hz_clock_rail rather than the pacing tail bounds the think.
    config: {time_trouble: false, time_trouble_at: 30, clock_mode: false, mirror_mode: false,
             complexity_clock: false, humanize: true, human_times: false},
    last_clocks: null,
    game_max_clock_s: 0,
    opp_spend: null,                 // no measured opponent spend, so Mirror Time's branch is dead
    mirror_ratio: () => 0.9,         // unreachable while mirror_mode is off; present so the lift links
    hz_phase_of: () => PHASE,
    // The real one reads the sliders through MephistoConfig and then paces them to the clock. Here it
    // hands back the slider as set, which is what fresh_timing returns with no pacing mode on.
    fresh_timing: () => ({move_time: TRAVEL_SLIDER, move_variance: TRAVEL_SLIDER}),
});

const POPUP = 'src/popup/popup.js';
// the clock-left bins and the lichess Speed classes the think tables are keyed by
vm.runInContext(slice(POPUP, 'const HZ_CLOCK_EDGES = [0.05', '// 200-point bands as the study cut them'), ctx);
// the think block whole: the measured tables, the AR(1) rhythm, the log-normal draw, the clock cap
vm.runInContext(slice(POPUP, '// ==== HUMANIZE THINK ====', '// ==== END HUMANIZE THINK ===='), ctx);
// where the time control, the clock fraction and the estimated game length come from
vm.runInContext(slice(POPUP, 'function humanize_tc_inputs(fen) {', '// The phase of the position the move'), ctx);
// the rails that bound the think with no pacing mode on
vm.runInContext(slice(POPUP, 'const HZ_CLOCK_SHARE_MAX = 1 / 15;', '// {move, think}: which move'), ctx);
// ...and the budget the pacing tail's own duplicate rails sit under, plus its gate
vm.runInContext(slice(POPUP, 'function clock_aware() {', 'function mirror_ratio()'), ctx);
vm.runInContext(slice(POPUP, 'function clock_budget_ms() {', '// --- Clock-paced move timing'), ctx);
vm.runInContext(slice(POPUP, 'function time_trouble_at() {', '// ---- HOW LONG A PERSON ACTUALLY TAKES'), ctx);
// the other think path: Human Move Times, which replaces humanize's flat bands with one log-normal
vm.runInContext(slice(POPUP, 'const HUMAN_TIME_SIGMA = 0.94;', '// ---- THE COMPLEXITY CLOCK'), ctx);

// The cursor travel is subtracted from the think inside humanize_pick ("a person's clock time
// includes moving the piece"), which is a second road to exactly 0 ms and had to come from source
// rather than be re-derived here. `h` is the capped draw.
vm.runInContext('function hz_travel_think(h) { let think = 0;\n'
    + slice(POPUP, 'let travel = 0;\n            try { const tm = fresh_timing();', 'console.log(`Humanize think:')
    + '\nreturn think; }', ctx);
// The pacing tail of humanize_pick verbatim: the Clock Mode budget cap, the DUPLICATE rails
// (T < 20 -> 250, T < 8 -> 0) and the time-trouble zero. think and kind are its two live inputs.
vm.runInContext('function hz_pacing_tail(think, kind) { let source = \'Humanize\';\n'
    + slice(POPUP, 'const budget = clock_budget_ms();', '    return {move, think: Math.round(think), source,')
    + '\nreturn {think, source}; }', ctx);

// const declarations do not become properties of the vm's global object, so the study's own tables
// have to be read out of its lexical scope. They are what the draw is compared against.
const TBL = vm.runInContext('({mean: HZ_THINK_MEAN, sd: HZ_THINK_SD, rho: HZ_THINK_RHO,'
    + ' kind: HZ_THINK_KIND, kindMean: HZ_THINK_KIND_MEAN, cls: HZ_THINK_CLASS,'
    + ' humanMean: HUMAN_TIME_MEAN, sigma: HUMAN_TIME_SIGMA})', ctx);

// --- what we draw -------------------------------------------------------------------------------
// base seconds + increment as a page reports them. est = base + 40 x increment is the study's own
// yardstick, and hz_tc_class turns it back into the row the tables are keyed by, so these five land
// one per class by construction rather than by assertion.
const TCS = [['ultrabullet', 15, 0], ['bullet', 60, 0], ['blitz', 180, 0],
             ['rapid', 600, 0], ['classical', 1800, 0]];
// Four of the eight clock bins: the scramble, the squeeze, the middle, and a clock nobody has touched.
const FRACS = [0.03, 0.15, 0.45, 1.0];
const DRAWS = 20000;
// Over a game the kinds come out quick 8.6%, normal 66.3%, long 25.2% (the shipped comment's own
// sim-human.mjs measurement at 1500 over 3,196 moves). Drawing one kind only would measure a corner:
// hz_think_ms divides the kind factor back out by HZ_THINK_KIND_MEAN, so ONLY this mix is supposed to
// come back at the table mean, and a single-kind draw is 14% off it by design.
const KIND_MIX = [['quick', 0.086], ['normal', 0.663], ['long', 0.252]];
const pickKind = () => {
    let u = rnd();
    for (const [k, p] of KIND_MIX) if ((u -= p) <= 0) return k;
    return 'normal';
};

function setClock(base, inc, frac) {
    ctx.last_clocks = {mine: frac * base, at: NOW, base, increment: inc, theirs: null};
    return ctx.humanize_tc_inputs('');
}

// One cell: DRAWS consecutive thinks through the whole shipped chain, in humanize_pick's order --
// hz_think_z, hz_think_ms, hz_think_cap, the travel subtraction, then the rails in the pacing tail.
function drawCell(base, inc, frac, cls = null) {
    const x = setClock(base, inc, frac);
    const out = [], raw = [];
    let prev = null;
    for (let i = 0; i < DRAWS; i++) {
        const kind = pickKind();
        const z = ctx.hz_think_z(prev, x.tc);
        prev = z;                       // the rhythm carries over, as hz_think_rhythm does in the panel
        const r = ctx.hz_think_ms(x.tc, x.phase, x.frac, x.est, kind, ctx.Math.random, cls, z);
        raw.push(r);
        const h = ctx.hz_think_cap(r, x.left);
        out.push(Math.round(ctx.hz_pacing_tail(ctx.hz_travel_think(h), kind).think));  // popup.js rounds at the return
    }
    // Feeding the rail an unreachable think reports the rail itself, so the spike's position comes
    // from hz_clock_rail rather than from a second copy of HZ_CLOCK_SHARE_MAX living here.
    return {x, out, raw, rail: Math.round(ctx.hz_clock_rail(Number.MAX_VALUE))};
}

// --- statistics ---------------------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const q = (a, p) => {
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const logsd = (a) => {
    const l = a.filter(v => v > 0).map(Math.log);
    if (l.length < 2) return NaN;
    const m = mean(l);
    return Math.sqrt(mean(l.map(v => (v - m) ** 2)));
};
// Pearson on consecutive log thinks. A zero has no log, so a pair containing one is skipped, and a
// cell the rails flattened to a single value has no variance and reports nothing rather than 0.
const lag1 = (a) => {
    const xs = [], ys = [];
    for (let i = 1; i < a.length; i++) if (a[i] > 0 && a[i - 1] > 0) { xs.push(Math.log(a[i - 1])); ys.push(Math.log(a[i])); }
    if (xs.length < 2) return NaN;
    const mx = mean(xs), my = mean(ys);
    let c = 0, vx = 0, vy = 0;
    for (let i = 0; i < xs.length; i++) { c += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
    return (vx > 0 && vy > 0) ? c / Math.sqrt(vx * vy) : NaN;
};
const share = (a, f) => a.filter(f).length / a.length;
const tableMean = (x) => {
    const key = x.tc === 'ultrabullet' ? 'bullet' : x.tc;
    return x.est * 1000 * TBL.mean[key][x.phase][ctx.hz_clock_bin(x.frac)] / 100;
};
const n0 = (v, d = 0, w = 0) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(w);
const pct = (v, w = 6) => n0(v, 3, w);
const clk = (f) => `${(f * 100).toFixed(0)}%`.padStart(4);

// --- 1. the emitted think, shipped defaults -----------------------------------------------------
console.log(`seed ${SEED}, ${DRAWS} thinks per cell, phase ${PHASE}, kind mix`
    + ` ${KIND_MIX.map(([k, p]) => `${k} ${(p * 100).toFixed(1)}%`).join('/')}, move class uncoupled,`
    + ' Simulated Move Time 0 ms');
console.log('no pacing mode on (the shipped default), so hz_clock_rail is what bounds the think\n');
const HEAD = '  tc           clk      n    mean    med    p10     p90 log_sd   lag1     =0   =250    <50   rail  =rail  tbl_mean tbl_sd    uncap';
console.log(HEAD);
const fixedCell = {};
for (const [name, base, inc] of TCS) {
    for (const frac of FRACS) {
        const {x, out, raw, rail} = drawCell(base, inc, frac);
        if (frac === 1.0) fixedCell[name] = {out, raw};
        console.log(`  ${name.padEnd(11)} ${clk(frac)} ${String(out.length).padStart(6)}`
            + ` ${n0(mean(out), 0, 7)} ${n0(q(out, 0.5), 0, 6)} ${n0(q(out, 0.1), 0, 6)} ${n0(q(out, 0.9), 0, 7)}`
            + ` ${n0(logsd(out), 2, 6)} ${n0(lag1(out), 2, 6)}`
            + ` ${pct(share(out, v => v === 0))} ${pct(share(out, v => v === 250))} ${pct(share(out, v => v < 50))}`
            + ` ${String(rail).padStart(6)} ${pct(share(out, v => v === rail))}`
            + ` ${n0(tableMean(x), 0, 9)} ${n0(TBL.sd[x.tc], 2, 6)} ${n0(mean(raw), 0, 8)}`);
    }
}
console.log('\n  tc check: ' + TCS.map(([n, b, i]) => `${b}+${i} -> ${ctx.hz_tc_class(b, i)}`).join(', '));

// --- 2. the same cells with the shipped Simulated Move Time -------------------------------------
// The travel subtraction is not a rounding detail: the default slider is 400 ms and the variance was
// folded into it, so humanize_pick takes move_time + move_variance/2 = 600 ms off every think before
// the rails see it. That is a third road to exactly 0, on top of the two rails.
TRAVEL_SLIDER = 400;
console.log(`\nthe same draw with the shipped Simulated Move Time (${TRAVEL_SLIDER} ms slider ->`
    + ` ${TRAVEL_SLIDER * 1.5} ms taken off each think)\n`);
console.log('  tc           clk     mean    med     =0   =250    <50  tbl_mean');
for (const [name, base, inc] of TCS) {
    for (const frac of FRACS) {
        const {x, out} = drawCell(base, inc, frac);
        console.log(`  ${name.padEnd(11)} ${clk(frac)} ${n0(mean(out), 0, 7)} ${n0(q(out, 0.5), 0, 6)}`
            + ` ${pct(share(out, v => v === 0))} ${pct(share(out, v => v === 250))} ${pct(share(out, v => v < 50))}`
            + ` ${n0(tableMean(x), 0, 9)}`);
    }
}
TRAVEL_SLIDER = 0;

// --- 3. Clock Mode on: the duplicate rails ------------------------------------------------------
// With a pacing mode on, hz_clock_rail is never reached -- the pacing tail caps the think against the
// T/30 budget and then applies its OWN copy of the two rails. Same spikes, a different code path, so
// a fix to one of them leaves the other standing.
ctx.config.clock_mode = true;
console.log('\nClock Mode on: the pacing tail\'s duplicate rails instead of hz_clock_rail\n');
console.log('  tc           clk     mean    med     =0   =250    <50');
for (const [name, base, inc] of TCS.filter(t => t[0] === 'blitz' || t[0] === 'rapid')) {
    for (const frac of FRACS) {
        const {out} = drawCell(base, inc, frac);
        console.log(`  ${name.padEnd(11)} ${clk(frac)} ${n0(mean(out), 0, 7)} ${n0(q(out, 0.5), 0, 6)}`
            + ` ${pct(share(out, v => v === 0))} ${pct(share(out, v => v === 250))} ${pct(share(out, v => v < 50))}`);
    }
}
ctx.config.clock_mode = false;

// --- 4. the rhythm -------------------------------------------------------------------------------
// HZ_THINK_RHO is set to the players' own lag-1 figures, so a fixed cell must come back AT rho: the
// mean is constant there and the only thing moving is the residual. A GAME is not a fixed cell -- the
// clock walks down through the bins and the phase advances, so the mean itself drifts, and a drifting
// mean reads as a correlated draw whether or not the residual is. That is the suspected doubling, so
// both are measured: raw = the draw out of hz_think_ms, emitted = after the cap and the rails.
const GAMES = 200, MOVES = 60;
function walkGame(base, inc) {
    const raw = [], out = [];
    let prev = null;
    for (let i = 0; i < MOVES; i++) {
        // a clock that empties over the game, and the study's own phase order
        PHASE = i < 10 ? 'o' : i < 40 ? 'm' : 'e';
        const x = setClock(base, inc, Math.max(0.01, 1 - (i / MOVES) * 0.98));
        const kind = pickKind();
        const z = ctx.hz_think_z(prev, x.tc);
        prev = z;
        const r = ctx.hz_think_ms(x.tc, x.phase, x.frac, x.est, kind, ctx.Math.random, null, z);
        raw.push(r);
        out.push(Math.round(ctx.hz_pacing_tail(ctx.hz_travel_think(ctx.hz_think_cap(r, x.left)), kind).think));
    }
    PHASE = 'm';
    return {raw, out};
}
const PLAYER_RHO = {ultrabullet: TBL.rho.bullet, bullet: 0.20, blitz: 0.17, rapid: 0.23, classical: 0.33};
console.log(`\nthe AR(1) rhythm: lag-1 autocorrelation of one player's consecutive log thinks`);
console.log(`fixed cell = a full clock, ${DRAWS} draws; walking clock = ${GAMES} games of ${MOVES} moves, per-game lag1 averaged\n`);
console.log('  tc          rho set  fixed raw  fixed emitted  walk raw  walk emitted  players');
for (const [name, base, inc] of TCS) {
    const fixed = fixedCell[name];
    const wr = [], wo = [];
    for (let g = 0; g < GAMES; g++) {
        const {raw, out} = walkGame(base, inc);
        const a = lag1(raw), b = lag1(out);
        if (Number.isFinite(a)) wr.push(a);
        if (Number.isFinite(b)) wo.push(b);
    }
    console.log(`  ${name.padEnd(11)} ${n0(TBL.rho[name === 'ultrabullet' ? 'bullet' : name], 2, 7)}`
        + ` ${n0(lag1(fixed.raw), 2, 10)} ${n0(lag1(fixed.out), 2, 14)}`
        + ` ${n0(wr.length ? mean(wr) : NaN, 2, 9)} ${n0(wo.length ? mean(wo) : NaN, 2, 13)}`
        + ` ${n0(PLAYER_RHO[name], 2, 8)}`);
}
console.log('  ultrabullet has no measured rho of its own (a 1-second clock cannot be read); it borrows'
    + ' bullet\'s, as the tables do');

// --- 5. the move-class multiplier ----------------------------------------------------------------
// HZ_THINK_CLASS is a flat multiplier on the cell mean, so it only leaves the game's average move at
// the table value if the real class mix averages to 1. Blitz starts at 0.90 for a good move, which is
// most moves: this prints what each class actually costs against the table.
console.log('\nthe move-class multiplier (blitz, full clock, kind mix, no rail bite)\n');
console.log('  class         factor     mean    x tbl');
{
    const [, base, inc] = TCS.find(t => t[0] === 'blitz');
    const names = ['good', '2-5%', 'inaccuracy', 'mistake', 'blunder'];
    for (let cls = 0; cls < 5; cls++) {
        const {x, out} = drawCell(base, inc, 1.0, cls);
        console.log(`  ${names[cls].padEnd(12)} ${n0(TBL.cls.blitz[cls], 2, 6)} ${n0(mean(out), 0, 8)}`
            + ` ${n0(mean(out) / tableMean(x), 3, 8)}`);
    }
}

// --- 6. the other think path: Human Move Times ---------------------------------------------------
// With Think Like People off, humanize's four flat bands are replaced by lognormal_ms at the band's
// own midpoint. Same question asked of it: does the mean come back where it was set, and is the
// median well under it the way a person's is?
console.log('\nHuman Move Times (lognormal_ms, the path when Think Like People is off)\n');
console.log('  kind      target     mean    med    p90  p90/mean  log_sd  tbl_sd');
for (const kind of ['instant', 'quick', 'normal', 'long']) {
    const target = TBL.humanMean[kind];
    const a = [];
    for (let i = 0; i < DRAWS; i++) a.push(ctx.lognormal_ms(target));
    console.log(`  ${kind.padEnd(9)} ${n0(target, 0, 6)} ${n0(mean(a), 0, 8)} ${n0(q(a, 0.5), 0, 6)}`
        + ` ${n0(q(a, 0.9), 0, 6)} ${n0(q(a, 0.9) / mean(a), 2, 9)} ${n0(logsd(a), 2, 7)} ${n0(TBL.sigma, 2, 7)}`);
}
