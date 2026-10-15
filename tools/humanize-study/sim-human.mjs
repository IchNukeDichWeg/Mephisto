// HUMANIZE vs HUMANS. Plays games with our side picking through the real Humanize functions sliced
// out of popup.js, and grades every move of ours the way the Stage C study graded people: the win%
// it gives away between the evals before and after it, in the Game Review's bands. The output sits
// next to the measured human spread for the same rating (HZ_HUMAN_DROP), so a mode is calibrated
// when the two columns agree.
//
//   node tools/humanize-study/sim-human.mjs --mode match --elo 1500 --games 40 [--guards off] [--depth 12] [--workers 0]
//
// --mode mix   the sliders at their shipped defaults (or --mix top,second,third,fourth,inacc,mistake,blunder)
// --mode match Err Like Your Rating at --elo
// The opponent is Stockfish UCI_LimitStrength at the same Elo (min 1320). Our lines come from
// native Stockfish, MultiPV 20 at --depth, which is the panel's wide humanize search. No clock:
// the comparison is against the blitz spread, the tables' baseline. Fixed depth, so --workers 0
// (every core) cannot move the result.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const A = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map(s => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || 'true']; }));
const ROOT = A.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODE = A.mode || 'match';
const ELO = +(A.elo || 1500);
const GAMES = +(A.games || 40);
const DEPTH = +(A.depth || 12);
const GUARDS = A.guards !== 'off';
const NO_DEBT = A.debt === 'off';
const NO_CAP = A.cap === 'off';     // match mode without the blunder-threshold ceiling, for comparison   // match mode without the owed-error carry, for comparison
const WORKERS = +(A.workers || 0) || os.cpus().length;
const MAX_OUR_MOVES = +(A['max-moves'] || 60);
const SF = A.sf || 'stockfish';
const SEARCH_CAP_MS = 20000;

// ---- the real code, sliced -------------------------------------------------------------------
const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
const block = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const fn = (name) => { const i = src.indexOf(`function ${name}(`); if (i < 0) throw new Error('no ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 3); };
const constLine = (name) => { const i = src.indexOf(`const ${name} =`); return src.slice(i, src.indexOf(';\n', i) + 2); };
const mixKeys = (A.mix || '').split(',').filter(Boolean).map(Number);
const MIX_NAMES = ['humanize_top', 'humanize_second', 'humanize_third', 'humanize_fourth', 'humanize_inaccuracy', 'humanize_mistake', 'humanize_blunder'];
const store = mixKeys.length === 7 ? Object.fromEntries(MIX_NAMES.map((k, i) => [k, JSON.stringify(mixKeys[i])])) : {};
const ctx = {console, Math, MephistoConfig: {get: (k) => store[k] ?? null}};
ctx.self = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), ctx);
vm.runInContext([
    constLine('HUMANIZE_ORDER'), constLine('HUMANIZE_LABEL'),
    block('// ==== HUMANIZE GUARDS ====', '// ==== END HUMANIZE GUARDS ===='),
    block('// ==== HUMANIZE MATCH ====', '// ==== END HUMANIZE MATCH ===='),
    src.includes('// ==== HUMANIZE THINK ====') ? block('// ==== HUMANIZE THINK ====', '// ==== END HUMANIZE THINK ====') : '',
    ...['win_percent', 'humanize_get', 'humanize_rates', 'humanize_thresholds', 'humanize_band_bounds', 'category_for_roll'].map(fn),
].join('\n').replace(/^const /gm, 'var '), ctx);
const H = ctx;
if (A.natural) vm.runInContext(`HZ_NATURAL_HANG = ${+A.natural}`, ctx);   // calibration only

// ---- Maia-3 (optional, --maia): the real encoder from src/offscreen/maia3.js on onnxruntime-node,
// so the natural-hang rule sees the probabilities the panel would. Needs onnxruntime-node on NODE_PATH.
let maia = null;
if (A.maia) {
    const ort = createRequire(import.meta.url)('onnxruntime-node');
    const m3 = fs.readFileSync(ROOT + '/src/offscreen/maia3.js', 'utf8');
    const enc = m3.slice(m3.indexOf('// ---- encoding'), m3.indexOf('// ---- adapter'));
    const mctx = {Math}; vm.createContext(mctx);
    vm.runInContext(enc.replace(/^const /gm, 'var ').replace(/^function /gm, 'function '), mctx);
    const model = A.maia === 'true' ? ROOT + '/lib/engine/maia3/maia3-23m.onnx' : A.maia;
    const session = await ort.InferenceSession.create(model, {intraOpNumThreads: 1});
    maia = async (fen, elo) => {
        const c = new H.Chess(undefined, fen);
        const black = c.turn() === 'b';
        const legal = c.moves({verbose: true}).map(mv => mv.from + mv.to + (mv.promotion || ''));
        const out = await session.run({
            tokens: new ort.Tensor('float32', Float32Array.from(mctx.encode(fen)), [1, 64, mctx.TOKEN_DIM]),
            self_elo: new ort.Tensor('int64', BigInt64Array.from([BigInt(elo)]), [1]),
            oppo_elo: new ort.Tensor('int64', BigInt64Array.from([BigInt(elo)]), [1]),
        });
        const logits = out.move_logits.data, sc = [];
        for (const u of legal) { const i = mctx.MOVE_TO_IDX.get(black ? mctx.mirrorMove(u) : u); if (i !== undefined) sc.push([u, logits[i]]); }
        const mx = Math.max(...sc.map(x => x[1])); let sum = 0;
        for (const x of sc) { x[2] = Math.exp(x[1] - mx); sum += x[2]; }
        return new Map(sc.map(x => [x[0], x[2] / sum]));
    };
}

// ---- a tiny UCI client -----------------------------------------------------------------------
class Engine {
    constructor(opts = {}) {
        this.p = spawn(SF); this.buf = ''; this.wait = null;
        this.p.stdout.on('data', d => { this.buf += d; let i;
            while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.wait?.(l); } });
        this.send('uci'); this.send('setoption name Threads value 1'); this.send('setoption name Hash value 16');
        for (const [k, v] of Object.entries(opts)) this.send(`setoption name ${k} value ${v}`);
    }
    send(c) { this.p.stdin.write(c + '\n'); }
    run(cmd, done) { return new Promise(res => { const lines = []; this.wait = (l) => { lines.push(l); if (done(l)) { this.wait = null; res(lines); } }; this.send(cmd); }); }
    async ready() { await this.run('isready', l => l === 'readyok'); }
    async analyse(fen, depth, multipv) {
        this.send(`setoption name MultiPV value ${multipv}`); this.send(`position fen ${fen}`);
        // capped: one search in a few hundred thousand ran away (8 min at depth 12); the deepest
        // completed depth stands in then
        const out = await this.run(`go depth ${depth} movetime ${SEARCH_CAP_MS}`, l => l.startsWith('bestmove'));
        const by = {}, at = {};
        for (const l of out) {
            const m = l.match(/ depth (\d+) .*?multipv (\d+) score (cp|mate) (-?\d+).*? pv (\S+)/);
            if (m && +m[1] <= depth && +m[1] >= (at[m[2]] || 0) && !/ (lower|upper)bound /.test(l)) {
                at[m[2]] = +m[1]; by[m[2]] = {move: m[5], [m[3] === 'cp' ? 'cp' : 'mate']: +m[4]};
            }
        }
        return Object.keys(by).sort((a, b) => a - b).map(k => by[k]);
    }
    async best(fen, ms) { this.send(`position fen ${fen}`);
        const out = await this.run(`go movetime ${ms}`, l => l.startsWith('bestmove')); return out.at(-1).split(' ')[1]; }
    quit() { try { this.send('quit'); } catch (e) { /* gone */ } }
}

// our-view cp the way line_cp_ours does it (a mate is a huge cp, closer = bigger)
const ours = (l) => l.mate != null ? (l.mate > 0 ? 1 : -1) * (100000 - 1000 * Math.abs(l.mate)) : l.cp;
const wp = (cp) => H.win_percent(cp);

function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// One of our moves, as humanize_pick decides it (minus timing, reflexes handled by the caller).
function pick(fen, lines, swing, rnd, st, probs = null) {
    const bestLine = lines[0], best = bestLine.move, bestCp = ours(bestLine);
    const alts = lines.slice(1).filter(l => ours(l) > -90000);
    const loss = (l) => bestCp - ours(l);
    let bestX;
    const bestExposure = () => (bestX !== undefined) ? bestX : (bestX = H.hz_exposure(H.Chess, 'chess', fen, best));
    const hangs = (l) => !H.hz_natural_hang(probs, l.move) && H.hz_hangs(H.Chess, 'chess', fen, l.move, bestExposure());
    const winning = GUARDS && bestCp >= H.HZ_WIN_CP && bestCp < 90000;
    const winFloor = GUARDS ? H.hz_win_floor(bestCp) : -Infinity;
    const safe = (l) => !GUARDS || (ours(l) >= winFloor && !hangs(l));
    const r = rnd() * 100;
    if (bestCp >= 90000) return best;
    const bx = GUARDS && swing >= H.HZ_PUNISH_CP ? bestExposure() : null;
    const bestTakes = !!bx && bx.gain > 0 && bx.gain > bx.risk;
    const keep = GUARDS ? H.hz_punish_keep(swing, bestTakes) : 1;
    const takes = (l) => { const x = H.hz_exposure(H.Chess, 'chess', fen, l.move); return !!x && x.gain > x.risk; };
    if (MODE === 'match') {
        const base = H.hz_match_shares(ELO, {});
        const shares = NO_DEBT ? base : H.hz_match_with_debt(base, st.debt);
        const cap = NO_CAP ? Infinity : H.humanize_thresholds().blunder;
        const allowed = alts.filter(l => loss(l) <= cap && safe(l) && (keep === 1 || takes(l)));
        const cands = [bestLine, ...allowed].map(l => ({move: l.move, drop: Math.max(0, wp(bestCp) - wp(ours(l)))}));
        const res = (rnd() < keep) ? H.hz_match_pick(cands, shares, r / 100, rnd, null) : {cand: null, played: 0};
        if (!NO_DEBT) st.debt = H.hz_match_settle(st.debt, base, res.played);
        return res.cand ? res.cand.move : best;
    }
    const rates = H.humanize_rates();
    const bands = H.humanize_band_bounds();
    const cat = H.category_for_roll(r, rates);
    const barred = (cat === 'blunder' && Math.abs(bestCp) >= 600) || (winning && (cat === 'mistake' || cat === 'blunder'));
    if (cat === 'top' || barred || !(rnd() < keep)) return best;
    const pool = alts.filter(l => loss(l) > bands[cat][0] && loss(l) <= bands[cat][1]);
    const ok = pool.filter(l => safe(l) && (keep === 1 || takes(l)));
    return ok.length ? ok[Math.floor(rnd() * ok.length)].move : best;
}

async function playGame(idx) {
    const rnd = mulberry(7000 + idx);
    const ourColor = idx % 2 ? 'b' : 'w';
    const us = new Engine(), opp = new Engine({UCI_LimitStrength: 'true', UCI_Elo: Math.max(1320, ELO)});
    await us.ready(); await opp.ready();
    const chess = new H.Chess(undefined);
    const evals = [], mineAt = [], forcedAt = [], ucis = [];
    let lastOurEval = null;
    const st = {debt: null};   // match mode's owed errors, one game
    try {
        for (let ply = 0; ply < 2 * MAX_OUR_MOVES + 1 && !chess.isGameOver(); ply++) {
            const fen = chess.fen(), mine = chess.turn() === ourColor;
            let move;
            if (ply < 4) {                       // opening variety: a random pick among the top 4
                const ls = await us.analyse(fen, 8, 4);
                move = ls[Math.floor(rnd() * ls.length)].move;
                evals.push((await us.analyse(fen, DEPTH, 1))[0]);
            } else if (mine) {
                const lines = await us.analyse(fen, DEPTH, 20);
                evals.push(lines[0]);
                const bestCp = ours(lines[0]);
                const last = chess.history({verbose: true}).at(-1);
                const recapture = last && last.captured && lines[0].move.slice(2, 4) === last.to;
                const forced = chess.moves().length === 1;
                forcedAt[ply] = forced;
                const swing = lastOurEval != null ? bestCp - lastOurEval : 0;
                // humanize_pick's think kind, for the think-time factors (the opening reel-off counts as normal)
                if (!recapture && !forced) {
                    const gap = lines.length > 1 ? bestCp - ours(lines[1]) : Infinity;
                    const full = +fen.split(' ')[5];
                    KINDS[full < 8 ? 'normal' : (gap < 35 && Math.abs(bestCp) < 150) || swing < -120 ? 'long' : gap > 250 ? 'quick' : 'normal']++;
                }
                move = (recapture || forced || lines.length < 2) ? lines[0].move : pick(fen, lines, swing, rnd, st, maia ? await maia(fen, Math.max(600, Math.min(2600, ELO))) : null);
                lastOurEval = bestCp;
            } else {
                evals.push((await us.analyse(fen, DEPTH, 1))[0]);
                move = await opp.best(fen, 100);
            }
            if (!move || move === '(none)') break;
            mineAt[ply] = mine;
            ucis.push(move);
            if (!chess.move({from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4]})) throw new Error(`illegal ${move} in ${fen}`);
        }
        const fen = chess.fen();
        evals.push(chess.isCheckmate() ? {mate: 0} : chess.isGameOver() ? {cp: 0} : (await us.analyse(fen, DEPTH, 1))[0]);
        const drops = [];
        for (let i = 4; i + 1 < evals.length; i++) {
            if (!mineAt[i] || forcedAt[i]) continue;
            const before = ours(evals[i]);
            const after = evals[i + 1].mate === 0 ? 100000 : -ours(evals[i + 1]);
            drops.push(Math.max(0, wp(before) - wp(after)));
        }
        const result = chess.isCheckmate() ? (chess.turn() === ourColor ? 'L' : 'W') : chess.isGameOver() ? 'D' : 'cap';
        // white-view evals per position on the study's mate scale (MATE_CP - plies), for sim_types.py
        const evw = evals.map((l, i) => { const v = l.mate != null ? (l.mate === 0 ? -100000 : Math.sign(l.mate) * (100000 - Math.abs(l.mate))) : l.cp;
                                          return i % 2 === 0 ? v : -v; });
        return {idx, drops, result, ourColor, moves: ucis, evw, graded: mineAt.map((m, i) => !!m && i >= 4 && !forcedAt[i])};
    } finally { us.quit(); opp.quit(); }
}

// ---- run, with progress -------------------------------------------------------------------------
const KINDS = {quick: 0, normal: 0, long: 0};
const results = []; let next = 0, done = 0; const t0 = Date.now(); const TTY = process.stdout.isTTY;
const fmt = (s) => s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
const tick = () => { const el = (Date.now() - t0) / 1000, rate = done / Math.max(el, 1e-3);
    const msg = `games ${done}/${GAMES} ${(100 * done / GAMES).toFixed(0)}%  ${(rate * 60).toFixed(1)}/min  elapsed ${fmt(el)}  ETA ${done ? fmt((GAMES - done) / rate) : '?'}`;
    if (TTY) process.stdout.write('\r' + msg); else if (done % 5 === 0 || done === GAMES) console.log(msg); };
console.log(`mode ${MODE}${mixKeys.length ? ' ' + mixKeys.join('/') : ''} at ${ELO}, guards ${GUARDS ? 'on' : 'off'}${maia ? `, Maia natural hangs at ${vm.runInContext('HZ_NATURAL_HANG', ctx)}` : ''}${MODE === 'match' && NO_DEBT ? ', no debt' : ''}${MODE === 'match' && NO_CAP ? ', no ceiling' : ''}, ${GAMES} games vs SF ${Math.max(1320, ELO)}, depth ${DEPTH}, ${WORKERS} workers`);
await Promise.all(Array.from({length: Math.min(WORKERS, GAMES)}, async () => {
    while (next < GAMES) { const g = next++;
        try { results.push(await playGame(g)); } catch (e) { console.log(`\ngame ${g} failed: ${e.message}`); }
        done++; tick(); }
}));
if (TTY) process.stdout.write('\n');
const all = results.flatMap(r => r.drops);
const n = all.length;
const cls = [0, 0, 0, 0, 0];
for (const d of all) cls[H.hz_drop_class(d)]++;
const human = H.hz_match_shares(ELO, {});
const names = ['under 2%', '2-5%', 'inaccuracy', 'mistake', 'blunder'];
console.log(`\n${n} graded moves of ours (forced and the 4 opening plies excluded)`);
console.log('class       ours (+/- 2 SE)        humans at ' + ELO + ' (blitz)');
cls.forEach((k, i) => { const p = k / n, se = Math.sqrt(p * (1 - p) / n);
    console.log(`${names[i].padEnd(11)} ${(100 * p).toFixed(1).padStart(5)}% (+/- ${(200 * se).toFixed(1)})      ${(100 * human[i]).toFixed(1).padStart(5)}%`); });
const c = (k) => results.filter(x => x.result === k).length;
const kn = KINDS.quick + KINDS.normal + KINDS.long;
const kf = vm.runInContext('typeof HZ_THINK_KIND === "undefined" ? null : HZ_THINK_KIND', ctx);
console.log(`think kinds: quick ${(100 * KINDS.quick / kn).toFixed(1)}%, normal ${(100 * KINDS.normal / kn).toFixed(1)}%, long ${(100 * KINDS.long / kn).toFixed(1)}%`
    + (kf ? `; mean think factor ${((KINDS.quick * kf.quick + KINDS.normal * kf.normal + KINDS.long * kf.long) / kn).toFixed(3)}` : ''));
console.log(`results W/D/L/cap ${c('W')}/${c('D')}/${c('L')}/${c('cap')}`);
if (A.out) fs.writeFileSync(A.out, JSON.stringify({mode: MODE, elo: ELO, guards: GUARDS, depth: DEPTH, mix: mixKeys, results}));
