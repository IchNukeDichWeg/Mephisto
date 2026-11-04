// Runs the REAL premove_certified / apply_ep_square (popup.js) and resumeIfDeferred
// (content-script.js), extracted by source slice rather than retyped, against the REAL lib/chess.js.
// Node, no browser.
//
// Puzzle Mode's pv-prefix tests are gone with the feature: it no longer auto-plays a line, it plays
// one searched move at a time, so there is no prefix logic left to pin.
const fs = require('fs');
const vm = require('vm');

// popup.js routes its user-facing text through i18n(key, english, vars). The slices under test do
// not load the locale layer, so every context gets the same passthrough the real one falls back to
// when a key is missing -- English with its placeholders filled in. Wrapped here once rather than
// added to thirty context objects by hand.
const _createContext = vm.createContext.bind(vm);
vm.createContext = (o) => {
    o = o || {};
    if (!('i18n' in o)) {
        o.i18n = (key, dflt, vars) => String(dflt ?? key)
            .replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars) ? String(vars[k]) : m);
    }
    return _createContext(o);
};

// Derived from this file's own location, never hardcoded: a machine path is wrong on any other
// checkout, and this is one `cp` away from a public repo. It also means the suite can be pointed at
// a different tree just by copying it there -- which is how the fork gets checked before a ship.
const ROOT = __dirname;
const ctx = {console};
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), ctx);

const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');

vm.runInContext('var config = {variant: "chess"};', ctx);

// slice 2: the premove certification gate (constants + premove_certified)
const cStart = src.indexOf('// Premove certification window.');
const cEnd = src.indexOf('function premove_reply_playable');
if (cStart < 0 || cEnd < 0 || cEnd < cStart) throw new Error('could not slice premove_certified');
vm.runInContext(src.slice(cStart, cEnd), ctx);
// top-level `const` lives in the context's lexical scope, not on the global object -- read it by
// evaluating the name rather than off `ctx` (function declarations DO land on ctx)
const premove_certified = ctx.premove_certified;
// The window is a SETTING now (premove_confidence, default 14) -- give the sliced context the
// config and tracker state premove_certified reads, then evaluate the accessors it derives from it.
vm.runInContext("var config = {premove_confidence: 14, variant: 'chess'}; var premove_tracker = {fen: '', lines: {}};", ctx);
const PREMOVE_DEPTH_PREV = vm.runInContext('premove_cert_prev()', ctx);
const PREMOVE_DEPTH_LAST = vm.runInContext('premove_cert_last()', ctx);

let fails = 0;
// The verdict: a summary line last and a non-zero exit on any failure, so a caller that reads the
// exit status or the tail sees a red suite. beforeExit fires once the async blocks have settled.
process.on('beforeExit', () => {
    console.log(fails ? `${fails} FAILED` : 'all passed');
    process.exitCode = fails ? 1 : 0;
});
function eq(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { fails++; console.log(`FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}

// ---- premove certification gate ---------------------------------------------------------------
console.log('\npremove_certified:');
function gate(name, line, expect) {
    const got = premove_certified(line);
    const ok = got === expect;
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (got ${got}, want ${expect})`);
}
const PAIR = 'e7e5 g1f3', OTHER = 'e7e5 b1c3';

if (PREMOVE_DEPTH_PREV === 13 && PREMOVE_DEPTH_LAST === 14) {
    console.log('ok   checkpoints default to depth 13 / 14');
} else {
    fails++;
    console.log(`FAIL checkpoints default to ${PREMOVE_DEPTH_PREV} / ${PREMOVE_DEPTH_LAST}, want 13 / 14`);
}
// the dial: the window follows the setting, clamped to depths a think actually reaches
{
    const at = (n) => { vm.runInContext(`config.premove_confidence = ${JSON.stringify(n)};`, ctx); const v = vm.runInContext('premove_cert_last()', ctx); vm.runInContext('config.premove_confidence = 14;', ctx); return v; };
    const okDial = at(10) === 10 && at(22) === 22 && at(5) === 8 && at(99) === 22 && at('x') === 14;
    if (okDial) console.log('ok   confidence is a dial: follows the setting, clamped [8,22], defaults 14');
    else { fails++; console.log('FAIL confidence dial (10->' + at(10) + ' 5->' + at(5) + ' 99->' + at(99) + ')'); }
}
// a PREDICTION that is the opponent's ONLY legal move is certified by the RULES, stable or not, but
// our reply on top of it still has to come from a real search
{
    vm.runInContext(`premove_tracker.fen = '7k/8/8/8/8/8/6q1/7K w - - 0 1';`, ctx);   // Kxg2 forced
    // A MAIA-SHAPED LINE -- depth 1, a pred and NO reply -- must never certify: every consumer
    // assumes line.reply is playable, and the rules bypass would otherwise certify it whenever
    // the opponent happens to be forced. Found by executing exactly this shape (2026-08-14).
    const maiaShaped = premove_certified({pred: 'h1g2', depth: 1, pv: ['h1g2']});
    if (!maiaShaped) console.log('ok   a reply-less (Maia-shaped) line never certifies');
    else { fails++; console.log('FAIL a reply-less (Maia-shaped) line CERTIFIED'); }
    const forcedOk = premove_certified({pred: 'h1g2', reply: 'g2f2', depth: PREMOVE_DEPTH_PREV});
    const forcedShallow = [1, 2, PREMOVE_DEPTH_PREV - 1].some(depth => premove_certified({pred: 'h1g2', reply: 'g2f2', depth}));
    const wrongPred = premove_certified({pred: 'h1h2', reply: 'g2f2', depth: PREMOVE_DEPTH_PREV});
    vm.runInContext(`premove_tracker.fen = '';`, ctx);
    if (forcedOk && !forcedShallow && !wrongPred) console.log('ok   a rules-forced prediction certifies at the first checkpoint, not below it; a different prediction does not');
    else { fails++; console.log(`FAIL rules certification (forced=${forcedOk}, shallow=${forcedShallow}, wrong=${wrongPred})`); }
}

// MAIA SECOND INFERENCE: a line whose reply came from asking the net again certifies at depth 1
// (there is no depth window at one node) -- but only WITH a reply. The flag alone must never


// maia2_on_line, executed: the live answer sets reply/flag/pvFull and hands the line to the
// premove rail; a stale answer (the game moved on) is dropped; info-line noise from the second
// client must not consume the pending slot before bestmove arrives.
{
    const s = src.indexOf('function maia2_on_line');
    const e = src.indexOf('\n}', s) + 2;
    if (s < 0) { fails++; console.log('FAIL could not slice maia2_on_line'); }
    else {
        const mctx = vm.createContext({clearTimeout: () => {}, calls: []});
        vm.runInContext(src.slice(s, e), mctx);
        vm.runInContext(`
            var premove_tracker = {fen: 'FEN_A', premoved: false};
            var maybe_premove_forced_reply = (l) => calls.push(l);
            var maia2 = {pending: {fen: 'FEN_A', line: {pred: 'e7e5'}, timer: 0, seq: 1}};
            maia2_on_line('info depth 1 multipv 1 score cp 12 pv g1f3'); // noise first
            maia2_on_line('bestmove g1f3');
        `, mctx);
        const line = mctx.calls[0];
        const okLive = mctx.calls.length === 1 && line && line.reply === 'g1f3'
            && line.maia2 === true && JSON.stringify(line.pvFull) === '["e7e5","g1f3"]';
        if (okLive) console.log('ok   maia2_on_line: bestmove sets reply+flag+pvFull and premoves (info noise ignored)');
        else { fails++; console.log('FAIL maia2_on_line live path: ' + JSON.stringify(mctx.calls)); }
        vm.runInContext(`
            calls.length = 0;
            premove_tracker = {fen: 'FEN_NEW', premoved: false};
            maia2 = {pending: {fen: 'FEN_OLD', line: {pred: 'e7e5'}, timer: 0, seq: 1}};
            maia2_on_line('bestmove g1f3');
        `, mctx);
        if (mctx.calls.length === 0) console.log('ok   maia2_on_line: a stale answer (position moved on) is dropped');
        else { fails++; console.log('FAIL maia2_on_line played a stale answer'); }
        vm.runInContext(`
            calls.length = 0;
            premove_tracker = {fen: 'FEN_A', premoved: false};
            maia2 = {pending: {fen: 'FEN_A', line: {pred: 'e7e5'}, timer: 0, seq: 1}};
            maia2_on_line('bestmove (none)');
        `, mctx);
        const freed = vm.runInContext('maia2.pending === null && calls.length === 0', mctx);
        if (freed) console.log('ok   maia2_on_line: "(none)" (mate/stalemate after pred) frees the slot, plays nothing');
        else { fails++; console.log('FAIL maia2_on_line "(none)" handling'); }
    }
}

// ---- pv_walk_moves: the whole-line walker, executed against real chess.js ------------------
// Sliced with pv_moves (its input normalizer) into a context that has Chess. The contract: every
// returned ply is legal in sequence from the given fen; the walk stops at the first ply chess.js
// rejects; the limit caps the count; junk input returns [].
{
    const ws = src.indexOf('function pv_walk_moves');
    const we = src.indexOf('\n}', ws) + 2;
    const ps = src.indexOf('function pv_moves');
    const pe = src.indexOf('\n}', ps) + 2;
    if (ws < 0 || ps < 0) { fails++; console.log('FAIL could not slice pv_walk_moves/pv_moves'); }
    else {
        const wobj = {};
        wobj.self = wobj; // chess.js exports onto `self`, same shim the main ctx uses
        const wctx = vm.createContext(wobj);
        vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), wctx);
        vm.runInContext("var config = {variant: 'chess'};", wctx);
        vm.runInContext(src.slice(ps, pe) + '\n' + src.slice(ws, we), wctx);
        const walk = (fen, pv, n) => vm.runInContext(
            `JSON.stringify(pv_walk_moves(${JSON.stringify(fen)}, ${JSON.stringify(pv)}, ${n}))`, wctx);
        const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        eq('pv_walk: a clean line comes back whole, plies numbered from 0',
            JSON.parse(walk(START, 'e2e4 e7e5 g1f3 b8c6', 10)),
            [{uci: 'e2e4', ply: 0}, {uci: 'e7e5', ply: 1}, {uci: 'g1f3', ply: 2}, {uci: 'b8c6', ply: 3}]);
        eq('pv_walk: the limit caps the walk',
            JSON.parse(walk(START, 'e2e4 e7e5 g1f3 b8c6', 2)),
            [{uci: 'e2e4', ply: 0}, {uci: 'e7e5', ply: 1}]);
        eq('pv_walk: an illegal ply ends the walk THERE, keeping what was legal',
            JSON.parse(walk(START, 'e2e4 e7e5 f3g5', 10)),   // f3g5: nothing on f3 yet
            [{uci: 'e2e4', ply: 0}, {uci: 'e7e5', ply: 1}]);
        eq('pv_walk: a garbled token ends the walk without throwing',
            JSON.parse(walk(START, 'e2e4 0000 e7e5', 10)), [{uci: 'e2e4', ply: 0}]);
        eq('pv_walk: zero/negative/absent limits return nothing', JSON.parse(walk(START, 'e2e4', 0)), []);
        eq('pv_walk: an unparseable fen returns nothing rather than throwing',
            JSON.parse(walk('not a fen', 'e2e4', 5)), []);
        // a promotion ply must survive the replay (chess.js needs the promotion field)
        eq('pv_walk: a promotion ply replays',
            JSON.parse(walk('8/P6k/8/8/8/8/7K/8 w - - 0 1', 'a7a8q', 5)), [{uci: 'a7a8q', ply: 0}]);
    }
}

// colour pins: the forced ramps and the walk grey must stay unique against the engine line
// colours -- the user call this encodes is "forced lines must not read as engine lines"
{
    const lc = /const LINE_COLORS = \[([^\]]+)\]/.exec(src);
    const fo = /const FORCED_COLORS_OURS\s*=\s*\[([^\]]+)\]/.exec(src);
    const ft = /const FORCED_COLORS_THEIRS\s*=\s*\[([^\]]+)\]/.exec(src);
    const pw = /const PV_WALK_COLOR = '([^']+)'/.exec(src);
    if (!lc || !fo || !ft || !pw) { fails++; console.log('FAIL colour constants missing'); }
    else {
        const parse = (s) => s.match(/#[0-9a-f]{6}/gi).map(x => x.toLowerCase());
        const line = new Set(parse(lc[1]));
        const all = [...parse(fo[1]), ...parse(ft[1]), pw[1].toLowerCase()];
        const clash = all.filter(c => line.has(c));
        if (!clash.length) console.log('ok   forced ramps + walk grey share no hex with LINE_COLORS');
        else { fails++; console.log('FAIL colour clash with LINE_COLORS: ' + clash.join(' ')); }
    }
}

// ---- premove_is_safe, executed: the misfire gate, including the EN PASSANT geometry ----------
// The ep premove is the purest "bound to the prediction" case: exd6 exists ONLY in the position
// where d7d5 just happened. Chess.js's ep handling is what premove_is_safe leans on, so run it.
{
    const ss = src.indexOf('function premove_is_safe');
    const se = src.indexOf('\n}', ss) + 2;
    if (ss < 0) { fails++; console.log('FAIL could not slice premove_is_safe'); }
    else {
        const sctx = vm.createContext({});
        sctx.self = sctx;
        vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), sctx);
        vm.runInContext("var config = {variant: 'chess'};", sctx);
        vm.runInContext(src.slice(ss, se), sctx);
        const safe = (fen, pred, reply) => vm.runInContext(
            `premove_is_safe(${JSON.stringify(fen)}, ${JSON.stringify(pred)}, ${JSON.stringify(reply)})`, sctx);
        // black is in check, d7d5 is the only legal move, and exd6 exists only via en passant
        const okEp = safe('k7/p2p4/8/4P3/8/8/7K/1R5B b - - 0 1', 'd7d5', 'e5d6') === true;
        if (okEp) console.log('ok   premove_is_safe: the en-passant reply to a forced double-step is safe');
        else { fails++; console.log('FAIL ep premove_is_safe'); }
        // same shape WITHOUT the check: d7d6 also enables exd6, so the premove could fire there too
        const okLoose = safe('4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1', 'd7d5', 'e5d6') === false;
        if (okLoose) console.log('ok   premove_is_safe: exd6 also legal after d6 -> NOT safe (could fire elsewhere)');
        else { fails++; console.log('FAIL loose premove_is_safe returned true'); }
    }
}

// From-Position start capture (content-script): the page's initialFen -- or, on vs-AI pages that
// ship no round JSON, the variant-link editor href (turn included!) -- must win over the piece
// scrape at move 0, because pieces cannot carry the TURN. A black-to-move custom start captured
// as white-to-move failed the en-prise validator on every scrape (found + fixed 2026-08-14).
{
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const pins = [
        ['editor-href FEN source exists', /\/editor\\\?fen=\(\[\^"&#\]\+\)/],
        ['underscores map back to spaces before validation', /replace\(\/_\/g, ' '\)/],
        ['move-0 capture prefers the embedded FEN over the piece scrape', /const atStart = readInitialFenFromPage\(\);/],
    ];
    for (const [name, re] of pins) {
        if (re.test(cs)) console.log('ok   ' + name);
        else { fails++; console.log('FAIL ' + name); }
    }
}

// A lichess board that starts with BLACK to move (content-script). Two halves, both real source:
// the tree renders `<index>4</index><move class="empty">...</move>` for White's skipped half-move,
// and the analysis URL is the only place the turn is written down. Before this, the placeholder was
// scraped as a move with an empty SAN -- the panel replayed "" ("Invalid move: ") and said the game
// was not detected on EVERY black-to-move analysis position, a case the suite did not cover.
// Verified live 2026-09-17: "Black to play, best move is Nf6" on
// /analysis/fromPosition/r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R_b_KQ_-_4_4.
{
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const slice = (name) => {
        const start = cs.indexOf('\nfunction ' + name + '(');
        const end = cs.indexOf('\n}', start);
        if (start < 0 || end < 0) throw new Error('could not slice ' + name);
        return cs.slice(start, end + 2);
    };
    const lctx = {console};
    vm.createContext(lctx);
    vm.runInContext(slice('hasSanText') + slice('lichessUrlFen'), lctx);
    const hasSanText = lctx.hasSanText;
    const urlFen = (href) => {
        const u = new URL(href);
        lctx.location = {pathname: u.pathname, search: u.search};
        lctx.URLSearchParams = URLSearchParams;
        return vm.runInContext('lichessUrlFen()', lctx);
    };

    eq('hasSanText: lichess empty-move placeholder is not a move', hasSanText({textContent: '...'}), false);
    eq('hasSanText: move-number index is not a move', hasSanText({textContent: '4'}), false);
    eq('hasSanText: a SAN is a move', hasSanText({textContent: 'Nf6'}), true);
    eq('hasSanText: castling is a move', hasSanText({textContent: 'O-O-O+'}), true);
    eq('hasSanText: the game-result line is not a move',
       hasSanText({textContent: '0-1 White resigned \u2022 Black is victorious'}), false);

    const FEN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R';
    eq('lichessUrlFen: analysis path states the turn',
       urlFen(`https://lichess.org/analysis/fromPosition/${FEN}_b_KQ_-_4_4`),
       `${FEN} b KQ - 4 4`);
    eq('lichessUrlFen: ?fen= query too',
       urlFen(`https://lichess.org/analysis?fen=${FEN}_w_KQ_-_4_4`), `${FEN} w KQ - 4 4`);
    eq('lichessUrlFen: a plain analysis board has no FEN', urlFen('https://lichess.org/analysis'), null);
    eq('lichessUrlFen: a real game URL has no FEN', urlFen('https://lichess.org/abcd1234/black'), null);

    // and the analysis move list actually goes through the filter (the call site, not just the helper)
    if (/querySelectorAll\('\.tview2 move'\)\)\.filter\(hasSanText\)/.test(cs))
        console.log('ok   the .tview2 analysis move list is SAN-filtered');
    else { fails++; console.log('FAIL the .tview2 analysis move list is not SAN-filtered'); }
}

// ---- EVERY setting carries a hover description (user call 2026-08-15) ------------------------
// A setting whose control has no tooltip in its row fails here, so a new row cannot ship mute.
// The control is matched by its FULL suffix (_select/_input/_checkbox/_range/_picker) -- matching
// the bare id also hit wrapper divs like id="compute_time_row" and produced false alarms.
{
    // the predicate itself, so it can be proven to FAIL on a muted row (a scan that only ever
    // reports "all good" is worth nothing -- this is the RED half, run every time)
    const rowHasTip = (html, key) => {
        const ctl = new RegExp(`id="${key}_(?:select|input|checkbox|range|picker)"`).exec(html);
        if (!ctl) return null;
        const start = Math.max(...['<div class="set-row', '<div class="section',
                                   '<div class="input-field', '<div class="row']
            .map(tok => html.lastIndexOf(tok, ctl.index)));
        return /data-tooltip|info-tooltip/.test(html.slice(start < 0 ? 0 : start, ctl.index));
    };
    const WITH = '<div class="set-row"><div class="set-lbl"><span class="tooltipped" data-tooltip="x">L</span></div><input id="demo_checkbox">';
    const WITHOUT = '<div class="set-row"><div class="set-lbl"><span>L</span></div><input id="demo_checkbox">';
    const OLD_SHAPE = '<div class="section"><label><span class="tooltipped" data-tooltip="x">L</span><input id="demo_input">';
    if (rowHasTip(WITH, 'demo') === true && rowHasTip(WITHOUT, 'demo') === false
        && rowHasTip(OLD_SHAPE, 'demo') === true && rowHasTip(WITH, 'nosuch') === null)
        console.log('ok   the tooltip check itself passes a tipped row, FAILS a mute one, reads both markups');
    else { fails++; console.log('FAIL the tooltip check does not discriminate -- the scan below proves nothing'); }

    let checked = 0, mute = [];
    // the Analysis page has settings of its own now, and they are held to the same rule
    for (const [page, dir] of [['general', `${ROOT}/src/options/pages/settings/general/`],
                               ['appearance', `${ROOT}/src/options/pages/settings/appearance/`],
                               ['analysis', `${ROOT}/src/options/pages/analysis/`]]) {
        const html = fs.readFileSync(dir + page + '.html', 'utf8');
        const js = fs.readFileSync(dir + page + '.js', 'utf8');
        const keys = [...js.matchAll(/registerFormElement\('([a-z0-9_]+)'/g)].map(m => m[1]);
        for (const k of keys) {
            // The window is the control's own ROW: nearest enclosing container start -> control.
            // Two shapes exist: the .set-row grid on both trees, and an older Materialize
            // .section/label form the fork still carries for a couple of rows.
            const tip = rowHasTip(html, k);
            if (tip === null) continue;               // registered but not on this page: FormElement warns
            checked++;
            if (!tip) mute.push(page + '/' + k);
        }
    }
    if (checked >= 55 && !mute.length) console.log(`ok   every setting control (${checked}) has a hover description`);
    else { fails++; console.log(`FAIL settings without a tooltip (${checked} checked): ${mute.join(', ')}`); }
}

// ---- Game Review move classification, executed against the real core -------------------------
// The published chess.com scheme (user call 2026-08-15): Brilliant, Great, Book, Best, Excellent,
// Good, Inaccuracy, Mistake, Miss, Blunder. Bands are win% LOST: <2 excellent, <5 good, <10
// inaccuracy, <20 mistake, 20+ blunder. Brilliant/Great/Miss are specifiers on top.
{
    const core = fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8');
    const cs = core.indexOf('function isMateScore');
    const ce = core.indexOf('// ---- per-game statistics');
    const rctx = {console: {log() {}}};
    rctx.self = rctx;
    vm.createContext(rctx);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), rctx);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), rctx);
    vm.runInContext('const {classify, sacrificesMaterial, winPercent, CLASS_ORDER} = self.MephistoClassify;'
                    + '\nconst MATE_CP = 100000;\n' + core.slice(cs, ce), rctx);
    const K = (o) => vm.runInContext(`classify(${JSON.stringify(o)})`, rctx);

    const cases = [
        ['a book move is Book before anything else', {winBefore: 50, winAfter: 45, isBook: true, rank: 3}, 'book'],
        ['one legal move is Forced, never praised or blamed', {winBefore: 60, winAfter: 20, onlyMove: true, rank: 1}, 'forced'],
        ['the engine move is Best', {winBefore: 55, winAfter: 55, rank: 1}, 'best'],
        ['under 2 points lost is Excellent', {winBefore: 55, winAfter: 53.5, rank: 3}, 'excellent'],
        ['2 to 5 is Good', {winBefore: 55, winAfter: 51, rank: 4}, 'good'],
        ['5 to 10 is an Inaccuracy', {winBefore: 55, winAfter: 48, rank: 5}, 'inaccuracy'],
        ['10 to 20 is a Mistake', {winBefore: 55, winAfter: 40, rank: 6}, 'mistake'],
        ['20 or more is a Blunder', {winBefore: 55, winAfter: 25, rank: 9}, 'blunder'],
        // specifiers
        ['a sound sacrifice from a level position is Brilliant',
            {winBefore: 60, winAfter: 59, rank: 1, sacrifice: true}, 'brilliant'],
        ['...but not when the position was already won',
            {winBefore: 95, winAfter: 94, rank: 1, sacrifice: true}, 'best'],
        ['...and not when it throws the game away',
            {winBefore: 60, winAfter: 30, rank: 8, sacrifice: true}, 'blunder'],
        ['the only move that holds is Great',
            {winBefore: 60, winAfter: 60, rank: 1, secondWin: 45}, 'great'],
        ['...a best move with a close second is just Best',
            {winBefore: 60, winAfter: 60, rank: 1, secondWin: 58}, 'best'],
        ['dropping a winning position is a Miss, not a Mistake',
            {winBefore: 85, winAfter: 50, rank: 7}, 'miss'],
        ['...and a small slip in a winning position is still an Inaccuracy',
            {winBefore: 85, winAfter: 78, rank: 4}, 'inaccuracy'],
    ];
    for (const [name, input, want] of cases) {
        const got = K(input);
        if (got === want) console.log('ok   classify: ' + name);
        else { fails++; console.log(`FAIL classify: ${name} (got ${got}, want ${want})`); }
    }

    // the sacrifice test itself, run on real positions
    const sac = (fen, uci) => vm.runInContext(
        `sacrificesMaterial(Chess, 'chess', ${JSON.stringify(fen)}, ${JSON.stringify(uci)})`, rctx);
    const sacCases = [
        // a queen walking onto a defended square, taken for nothing: material offered
        // Qxd7+ takes a pawn and the king takes the queen back: a pawn for a queen, offered
        ['a queen taken by the king for a pawn is a sacrifice', '4k3/3p4/8/8/8/8/8/3QK3 w - - 0 1', 'd1d7', true],
        // an ordinary developing move gives up nothing
        ['a quiet developing move is not a sacrifice', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'g1f3', false],
        // an even trade is not a sacrifice: we take a knight, they take our knight back
        ['an even trade is not a sacrifice', '4k3/8/4n3/8/8/4N3/8/4K3 w - - 0 1', 'e3d5', false],
        // en passant takes a pawn that never stood on d6; retaken by c7 it is pawn for pawn (F14)
        ['an en-passant pawn trade is not a sacrifice', '4k3/2p5/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6', false],
        ['junk input never claims brilliance', 'not a fen', 'e2e4', false],
    ];
    for (const [name, fen, uci, want] of sacCases) {
        const got = sac(fen, uci);
        if (got === want) console.log('ok   sacrifice: ' + name);
        else { fails++; console.log(`FAIL sacrifice: ${name} (got ${got}, want ${want})`); }
    }

    // the order the report lists them in must hold every class the classifier can return
    const order = vm.runInContext('JSON.stringify(CLASS_ORDER)', rctx);
    const produced = new Set(cases.map(c => c[2]));
    const missing = [...produced].filter(k => !JSON.parse(order).includes(k));
    if (!missing.length && JSON.parse(order).length === 11)
        console.log('ok   classify: every class the classifier returns is in CLASS_ORDER');
    else { fails++; console.log('FAIL CLASS_ORDER is missing ' + missing.join(', ') + ' (' + order + ')'); }
}

// ---- Forced means ONE LEGAL MOVE, not one engine line ------------------------------------------
// assemble() used to set onlyMove from before.lines.length === 1, so at Lines (rv_multipv) = 1 every
// non-book move was Forced (measured 2026-09-23, Immortal Game at depth 10: book 8 / forced 37, no
// other class). Runs the REAL assemble() from review.js against the real review-core + chess.js.
{
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const as = rj.indexOf('function assemble(game, positions, moves, book, opts) {');
    const ae = rj.indexOf('function countClasses(moves, color) {');
    const fs0 = rj.indexOf('const RV_FAIRY_ONLY =');
    const actx = {console: {log() {}}};
    actx.self = actx;
    vm.createContext(actx);
    if (as < 0 || ae < as || fs0 < 0) { fails++; console.log('FAIL could not slice assemble'); }
    else {
        vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), actx);
        vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), actx);
        vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), actx);
        vm.runInContext('const Core = self.MephistoReviewCore; function cfg() { return null; }\n'
            + 'function countClasses() { return {}; }\n'
            + rj.slice(fs0, rj.indexOf('\n', fs0)) + '\n' + rj.slice(as, ae), actx);
        // one move from `fen`, scored cp (white-positive) before and after, with `multipv` lines asked
        const run = (fen, uci, cp, multipv, variant) => vm.runInContext(`(() => {
            const b = new Chess(${JSON.stringify(variant || 'chess')}, ${JSON.stringify(fen)});
            const turn = b.turn();
            const mv = b.move({from: '${uci.slice(0, 2)}', to: '${uci.slice(2, 4)}'});
            const line = {cp: ${cp}, mate: null, pv: ['${uci}']};
            const positions = [{fen: ${JSON.stringify(fen)}, turn, lines: [line], depth: 10},
                               {fen: b.fen(), turn: b.turn(), lines: [{cp: ${cp}, mate: null, pv: []}], depth: 10}];
            const moves = [{san: mv.san, uci: '${uci}', color: turn, ply: 0}];
            assemble({tags: {}}, positions, moves, {plies: 0},
                     {variant: ${JSON.stringify(variant || 'chess')}, multipv: ${multipv}});
            return moves[0].klass;
        })()`, actx);
        const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const ONE = 'k7/8/8/8/8/8/1q6/K7 w - - 0 1';   // Ka1 in check from an undefended Qb2: Kxb2 only
        const legal = vm.runInContext(`new Chess('chess', ${JSON.stringify(ONE)}).moves().length`, actx);
        const cases = [
            ['the fixture really has one legal move', legal, 1],
            ['20 legal moves at MultiPV 1 is NOT forced', run(START, 'e2e4', 30, 1), 'best'],
            ['one legal move at MultiPV 1 IS forced', run(ONE, 'a1b2', 0, 1), 'forced'],
            ['one legal move at MultiPV 3 IS forced', run(ONE, 'a1b2', 0, 3), 'forced'],
            // chess.js cannot count Fairy moves, so one line at MultiPV 1 proves nothing there
            ['a Fairy variant at MultiPV 1 is not called forced from its line count',
                run(START, 'e2e4', 30, 1, 'atomic'), 'best'],
        ];
        for (const [name, got, want] of cases) {
            if (got === want) console.log('ok   forced: ' + name);
            else { fails++; console.log(`FAIL forced: ${name} (got ${got}, want ${want})`); }
        }
    }
}

// ---- the verdict badges and the numbered engine arrows ---------------------------------------
// The badge is the thing a review is read by, so every class the classifier can return must have
// one -- a class with no badge draws nothing on the board and looks like a missing verdict.
{
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const core = fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8');
    const cc = fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8');   // CLASS_ORDER lives here now
    const order = JSON.parse((/const CLASS_ORDER = (\[[^\]]+\])/.exec(cc) || [])[1]
        .replace(/'/g, '"').replace(/,\s*\]/, ']'));
    const badgeBlock = rj.slice(rj.indexOf('const CLASS_BADGE = {'), rj.indexOf('// One badge as an SVG'));
    const missing = order.filter(k => !new RegExp(`\\b${k}\\s*:`).test(badgeBlock));
    if (!missing.length) console.log(`ok   every one of the ${order.length} classes has a board badge`);
    else { fails++; console.log('FAIL classes with no badge: ' + missing.join(', ')); }

    const labelBlock = rj.slice(rj.indexOf('const CLASS_LABEL = {'), rj.indexOf('function renderReport'));
    const noLabel = order.filter(k => !new RegExp(`\\b${k}\\s*:`).test(labelBlock));
    if (!noLabel.length) console.log('ok   ...and a label to go with it');
    else { fails++; console.log('FAIL classes with no label: ' + noLabel.join(', ')); }

    // the badge geometry, executed: it must produce a circle and stay inside the board box
    const bctx = vm.createContext({Math});
    vm.runInContext(rj.slice(rj.indexOf('const CLASS_BADGE = {'), rj.indexOf('function renderDetail')), bctx);
    const svg = vm.runInContext("classBadge('brilliant', 4.3, 3.7, 0.26)", bctx);
    const okSvg = /<circle cx="4.3" cy="3.7" r="0.26"/.test(svg) && /#1aada6/.test(svg) && /!!/.test(svg);
    if (okSvg) console.log('ok   a badge draws its circle, its colour and its glyph at board coordinates');
    else { fails++; console.log('FAIL badge svg: ' + String(svg).slice(0, 120)); }
    const none = vm.runInContext("classBadge('nosuchclass', 1, 1, 0.2)", bctx);
    if (none === '') console.log('ok   an unknown class draws nothing rather than a blank circle');
    else { fails++; console.log('FAIL unknown class drew: ' + none); }

    // the rank tag: the engine's #1 must be numbered on its own arrow
    const rank = /function rankTag\(spec\)/.test(rj) && /html \+= specs\.filter\(s => s\.rank\)\.map/.test(rj);
    if (rank) console.log('ok   engine lines carry their rank number on the arrow');
    else { fails++; console.log('FAIL the rank tag is not drawn'); }
}

// ---- the Analysis page is registered and self-contained ---------------------------------------
{
    const html = fs.readFileSync(ROOT + '/src/options/options.html', 'utf8');
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const ah = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.html', 'utf8');
    const pins = [
        ['the nav offers Analysis', /id="analysis" href="#analysis"/.test(html)],
        ['the shared engine module is loaded before the pages', /util\/engines\.js/.test(html)],
        ['the page shows BOTH engines, not one', /an_human_lines/.test(ah) && /an_engine_lines/.test(ah)],
        // 3.1.255: ONE eval bar, with the number inside it, plus a win/draw/loss readout
        ['the eval bar shows its number, and wdl has a home', /an_evalfill/.test(ah) && /an_evallabel/.test(ah) && /an_wdl_line/.test(ah)],
        ['the rating bands have a home', /an_bands/.test(ah)],
        ['it reuses the shared drivers rather than copying them', /self\.MephistoEngines/.test(aj)],
        ['leaving the page disposes its engines', /location\.hash\.startsWith\('#analysis'\)/.test(aj)],
        // CONTRACT CHANGE 3.1.290: the budget has two units. Time keeps the 3.1.254 shape (page-side
        // stopwatch, last notch infinite); Depth caps the go command itself and stops there.
        ['the budget offers both units', /an_limit_kind_select/.test(ah) && /an_depth_range/.test(ah)],
        ['depth reaches the go command, not a stopwatch', /\{depth: wantDepth\}/.test(aj)],
    ];
    for (const [name, ok] of pins) {
        if (ok) console.log('ok   analysis page: ' + name);
        else { fails++; console.log('FAIL analysis page: ' + name); }
    }
    // Maia must be told how many lines to answer with, or the human column shows one move at 100%
    const eng = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const maiaMulti = /isMaia\(\)\)[\s\S]{0,900}?setoption name MultiPV value \$\{this\.opts\.multipv\}[\s\S]{0,900}?\}\s*else\s*\{[\s\S]{0,700}?setoption name MultiPV/.test(eng);
    if (maiaMulti) console.log('ok   the human model is told how many lines to answer with');
    else { fails++; console.log('FAIL Maia never receives MultiPV -- the human column will show one move'); }
}

// ---- analysis runs until you move on, and sweeps every rating band ---------------------------
{
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const eng = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const pins = [
        ['the driver can search without a budget, or to a depth',
            /startInfinite\(fen, turn, onUpdate, opts = \{\}\)/.test(eng)],
        ['...and uncapped really is `go infinite`, capped really is `go depth`',
            /this\.send\(this\.isMaia\(\) \? 'go' : \(capDepth \? `go depth \$\{capDepth\}` : 'go infinite'\)\);/.test(eng)],
        // 3.1.255: stop() now RESOLVES on bestmove -- a search told to stop keeps emitting until
        // then, and those lines describe the previous position
        ['...and stopping waits for the engine to really stop', /this\.send\('stop'\);\n\s+return done;/.test(eng)],
        // 3.1.290: a depth-capped search that already answered must not wait 8s for a second bestmove
        ['...unless the engine already answered', /this\.isMaia\(\) \|\| finished\)/.test(eng)],
        ['the depth setting has its own key, so switching units never reinterprets a number',
            /an_depth: 22/.test(aj) && /an_limit_kind: 'time'/.test(aj)],
        ['moving on waits for the old search before starting the new one',
            /function stopSearch\(\)/.test(aj) && /await stopSearch\(\);/.test(aj)],
        // the engine is fed engineFen(pos) -- the node's full state (crazyhouse pockets, 3check
        // counts) -- while the page keys its caches by the plain fen the board renders
        ['results stream in rather than arriving once', /startInfinite\(engineFen\(pos\), pos\.turn, \(res\) =>/.test(aj)],
        ['Maia 1 sweeps its own bands', /: MAIA_BANDS\.slice\(\);/.test(aj)],
        // The steps used to be spelled out here AND in the review page. They moved to engines.js
        // when Maia 2 was added, because the two nets do not take the same dial -- the values
        // themselves are pinned in the human-models section below.
        ['the dial models sweep the steps engines.js gives them',
            /takesRating\(kind\) \? ratingSteps\(kind\) : MAIA_BANDS\.slice\(\)/.test(aj)],
        ['the Maia 3 sweep reuses one net rather than loading twenty-one',
            /setoption name SelfElo value \$\{band\}/.test(aj) && /shared\?\.dispose/.test(aj)],
        ['a sweep whose position left the board is dropped', /run !== bandRun/.test(aj)],
    ];
    for (const [name, ok] of pins) {
        if (ok) console.log('ok   analysis: ' + name);
        else { fails++; console.log('FAIL analysis: ' + name); }
    }
}

// =================================================================================================
// REBUILT 2026-09-05. The suite this file used to be was damaged beyond repair while reconciling it
// with the 3.1.307 revert, and nothing had a copy of it: it was never in git, `release-zips.sh`
// excludes it from both archives, and the machine keeps no snapshots. What follows is written back
// from the code that actually ships, path by path, and every check below RUNS the real function
// rather than matching its source where that is possible at all.
//
// KEEP THIS FILE IN VERSION CONTROL. Everything else in this project is recoverable from a tag.
// =================================================================================================

// ---- the engine lineup: offered means loadable ---------------------------------------------------
{
    console.log('\nengine wiring:');
    const off = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const cs = fs.readFileSync(ROOT + '/src/scripts/config-store.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const map = {};
    const mStart = off.indexOf('const engineMap = {');
    for (const m of off.slice(mStart, off.indexOf('};', mStart)).matchAll(/'([\w-]+)':\s*'([^']+)'/g)) map[m[1]] = m[2];

    ok('the loader knows the engines this build ships', Object.keys(map).length >= 4, Object.keys(map));
    ok('...and every file it names is on disk',
        Object.entries(map).every(([, rel]) => fs.existsSync(`${ROOT}/lib/engine/${rel}`)),
        Object.entries(map).filter(([, r]) => !fs.existsSync(`${ROOT}/lib/engine/${r}`)));
    ok('...with its .wasm beside it',
        Object.entries(map).every(([, rel]) => fs.existsSync(`${ROOT}/lib/engine/${rel.replace(/\.js$/, '.wasm')}`)));
    // Stockfish 19 and its small build, which is what 3.1.308 is for
    ok('Stockfish 19 is one of them', 'stockfish-19-nnue' in map && 'stockfish-19-small-nnue' in map, Object.keys(map));
    ok('...and the small one carries the small net (a megabyte, not fifteen)',
        fs.statSync(`${ROOT}/lib/engine/stockfish-19-small/nn-61e7af4bb97d.nnue`).size < 2e6);
    // every bundled build the dropdowns offer must be one the loader can start
    const offered = (file) => {
        const html = fs.readFileSync(ROOT + file, 'utf8');
        const i = html.search(/<select[^>]*id="(qs_engine|engine_select)"/);
        return [...html.slice(i, html.indexOf('</select>', i)).matchAll(/<option value="([\w-]+)"/g)]
            .map(m => m[1]).filter(id => /^(stockfish|fairy)-/.test(id) && !/-native$/.test(id));
    };
    for (const f of ['/src/popup/popup.html', '/src/options/pages/settings/general/general.html']) {
        const bad = offered(f).filter(id => !(id in map));
        ok(`every bundled engine offered in ${f.split('/').pop()} can be loaded`, bad.length === 0, bad);
    }
    // a retired id must land on a live engine, not on nothing
    const csCtx = {console, self: {}, location: {protocol: 'chrome-extension:'}, navigator: {},
                   chrome: {storage: {local: {get: () => Promise.resolve({}), set() {}}, onChanged: {addListener() {}}}}};
    csCtx.self = csCtx;
    vm.createContext(csCtx);
    vm.runInContext(cs, csCtx);
    const live = (id) => csCtx.self.MephistoConfig.liveEngine(id);
    eq('a retired WASM engine is migrated', live('stockfish-dev-nnue'), 'stockfish-19-nnue');
    eq('...so is the small one it replaced', live('stockfish-18-small-nnue'), 'stockfish-19-small-nnue');
    {
        const retired = JSON.parse(JSON.stringify(csCtx.self.MephistoConfig.RETIRED_ENGINES));
        const offeredIds = new Set([...fs.readFileSync(ROOT + '/src/popup/popup.html', 'utf8')
            .matchAll(/<option value="([\w-]+)"/g)].map(m => m[1]));
        ok('every retired engine maps to one this build actually offers',
            Object.values(retired).every(id => offeredIds.has(id)), retired);
        ok('...and no retired id is still offered anywhere',
            Object.keys(retired).every(id => !offeredIds.has(id)), Object.keys(retired));
    }
    eq('a live engine is left alone', live('stockfish-18-nnue'), 'stockfish-18-nnue');
    eq('...and an unset value stays unset, so the caller default decides', live(undefined), undefined);
    ok('the panel names no retired WASM engine', !/stockfish-dev-nnue/.test(pj) && !/stockfish-dev-nnue/.test(off));
    // the native side: the host app name for every native engine the panel lists
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    {
        const hosts = {};
        const hStart = bg.indexOf('const NATIVE_HOSTS');
        for (const m of bg.slice(hStart, bg.indexOf('};', hStart)).matchAll(/'([\w-]+)': \{app: '([\w.]+)'/g)) hosts[m[1]] = m[2];
        const nativeOffered = [...fs.readFileSync(ROOT + '/src/popup/popup.html', 'utf8')
            .matchAll(/<option value="([\w-]+)"/g)].map(m => m[1]).filter(id => /-native$/.test(id));
        ok('every native engine the panel offers has a host app registered',
            nativeOffered.length > 0 && nativeOffered.every(id => id in hosts), nativeOffered.filter(id => !(id in hosts)));
        const tbApps = (/const TB_HOST_APPS = \[([^\]]*)\]/.exec(bg)?.[1] || '').match(/'[\w.]+'/g)?.map(x => x.slice(1, -1)) || [];
        ok('...and every app the tablebase probe lists is one of them',
            tbApps.length > 0 && tbApps.every(a => Object.values(hosts).includes(a)),
            tbApps.filter(a => !Object.values(hosts).includes(a)));
    }
    ok('...and a native host that does not answer is probed a SECOND time before it is hidden',
        /await new Promise\(r => setTimeout\(r, 1000\)\);\s*\n\s*return native_host_available/.test(pj));
}

// ---- the tablebase: whose side, and what is proved ------------------------------------------------
{
    console.log('\ntablebase:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext('var our = "white"; function our_side() { return our; }\n'
        + pj.slice(pj.indexOf('const TB_FLIP ='), pj.indexOf('function tablebase_label')), c);
    const seen = (cat, turn, side) => { c.our = side; return c.tablebase_category_for_us(cat, `8/8/8/8/8/8/8/8 ${turn} - - 0 1`); };
    eq('our move: the verdict is already ours', seen('win', 'w', 'white'), 'win');
    eq('THEIR move: the same position still reads as ours', seen('loss', 'b', 'white'), 'win');
    eq('...and a position we are losing says so on their move too', seen('win', 'b', 'white'), 'loss');
    eq('...playing black, the same rule', seen('loss', 'w', 'black'), 'win');
    eq('a draw is a draw from either side', seen('draw', 'b', 'white'), 'draw');
    eq('the 50-move pair flips together', seen('blessed-loss', 'b', 'white'), 'cursed-win');
    eq('...and back the other way', seen('cursed-win', 'b', 'white'), 'blessed-loss');
    eq('an unknown verdict is passed through, not invented', seen('nonsense', 'b', 'white'), 'nonsense');

    const c2 = {console};
    c2.self = c2;
    vm.createContext(c2);
    vm.runInContext(pj.slice(pj.indexOf('const TB_RESULT_VALUE ='), pj.indexOf('function classify_history')), c2);
    const held = (a, b) => c2.tb_held_the_result(a, b);
    ok('a win that stays a win held the result -- the Rxg5+ case', held('win', 'loss') === true);
    ok('a win given away for a draw did not', held('win', 'draw') === false);
    ok('...nor a win turned into a loss', held('win', 'win') === false);
    ok('a draw held is held', held('draw', 'draw') === true);
    ok('a draw given away is not', held('draw', 'win') === false);
    ok('a lost position cannot get worse', held('loss', 'win') === true);
    ok('...and with no tablebase answer, nothing is judged by one',
        held(null, 'loss') === false && held('win', undefined) === false);
    ok('the override only ever removes a bad grade',
        /const TB_OVERRIDABLE = new Set\(\['inaccuracy', 'mistake', 'blunder'\]\)/.test(pj));
    ok('...and the ply carries the verdict its position had', /ref, tb\};/.test(pj));
}

// ---- what analysed the game, in the copied PGN ----------------------------------------------------
{
    console.log('\npgn provenance:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext('var config = {engine: "stockfish-19-nnue", compute_time: 800, compute_depth: 16,\n'
        + '  multiple_lines: 2, threads: 1, search_mode: "time", autoplay: true, humanize: true};\n'
        + 'var engine_net_seen = "nn-1a298aa575a0.nnue";\n'
        + 'var PANEL_ROOT = {getElementById: () => ({options: [{value: "stockfish-19-nnue", textContent: "SF 19 WASM"}]})};\n'
        + 'var chrome = {runtime: {getManifest: () => ({version: "9.9.9"})}};\n'
        + 'function searching_by_depth() { return config.search_mode === "depth"; }\n'
        + pj.slice(pj.indexOf('function pgn_provenance_tags'), pj.indexOf('function current_pgn')), c);
    const tags = c.pgn_provenance_tags();
    console.log('   ' + tags.join('\n   '));
    ok('the annotator is named, with the version', tags.some(t => t === '[Annotator "Mephisto 9.9.9"]'), tags[0]);
    ok('...the engine, with the net that answered',
        tags.some(t => /^\[MephistoEngine "SF 19 WASM net nn-1a298aa575a0\.nnue"\]$/.test(t)));
    ok('...and the search it ran', tags.some(t => /^\[MephistoSearch "800ms, MultiPV 2, threads 1"\]$/.test(t)));
    ok('...and which modes were on', tags.some(t => /^\[MephistoModes "autoplay humanize"\]$/.test(t)));
    ok('a depth budget is written as a depth', (() => {
        c.config.search_mode = 'depth';
        return c.pgn_provenance_tags().some(t => /"depth 16, MultiPV 2/.test(t));
    })());
    ok('every tag is one line -- a newline in a tag is a broken PGN',
        c.pgn_provenance_tags().every(t => !/[\r\n]/.test(t)));
    ok('NOTHING is written into a standard tag a reader already has a meaning for',
        c.pgn_provenance_tags().every(t => /^\[(Annotator|Mephisto\w+) "/.test(t)));
}

// ---- contempt: refusing a draw, and only when there IS one ---------------------------------------
{
    console.log('\ncontempt:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext('var config = {variant: "chess"}; var last_eval = {}; var last_pos = {};\n'
        + 'function line_cp_ours(l) { return l.cp; }\n'
        + pj.slice(pj.indexOf('// ---- CONTEMPT: the dial for a game you have to WIN'), pj.indexOf('function humanize_pick(best')), c);
    const setup = (cfg, fen, moves, lines, startFen) => {
        c.config = {variant: 'chess', ...cfg};
        c.last_eval = {fen, lines};
        c.last_pos = {startFen: startFen || null, moves: moves || ''};
    };
    const stale = '7k/8/6K1/8/8/8/5Q2/8 w - - 0 1';          // Qf7 stalemates; Qb8 mates
    const lines = [{move: 'f2f7', cp: 0}, {move: 'f2b8', cp: -20}];
    setup({contempt: false, contempt_cp: 30}, stale, '', lines, stale);
    eq('off, the engine keeps its move', c.contempt_pick('f2f7'), 'f2f7');
    setup({contempt: true, contempt_cp: 30}, stale, '', lines, stale);
    eq('on, the stalemate is passed over', c.contempt_pick('f2f7'), 'f2b8');
    setup({contempt: true, contempt_cp: 10}, stale, '', lines, stale);
    eq('...but never past what the dial will pay', c.contempt_pick('f2f7'), 'f2f7');
    const shuffle = 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1';
    const rep = (() => { const b = new c.Chess('chess'); for (const u of shuffle.split(' ')) b.move({from: u.slice(0,2), to: u.slice(2,4)}); return b.fen(); })();
    setup({contempt: true, contempt_cp: 40}, rep, shuffle, [{move: 'f6g8', cp: 0}, {move: 'b8c6', cp: -25}], new c.Chess('chess').fen());
    eq('a threefold is a draw the score never showed', c.contempt_pick('f6g8'), 'b8c6');
    setup({contempt: true, contempt_cp: 40}, rep, '', [{move: 'f6g8', cp: 0}, {move: 'b8c6', cp: -25}], rep);
    eq('...and without the history it is just a move', c.contempt_pick('f6g8'), 'f6g8');
    const open = (() => { const b = new c.Chess('chess'); b.move({from:'e2',to:'e4'}); b.move({from:'e7',to:'e5'}); return b.fen(); })();
    setup({contempt: true, contempt_cp: 200}, open, 'e2e4 e7e5', [{move: 'g1f3', cp: 30}, {move: 'b1c3', cp: 20}]);
    eq('an ordinary position is untouched', c.contempt_pick('g1f3'), 'g1f3');
    setup({contempt: true, contempt_cp: 40}, stale, '', [{move: 'f2f7', cp: 0}, {move: 'f2b8', cp: -99999}], stale);
    eq('and it never walks into a mate to dodge a draw', c.contempt_pick('f2f7'), 'f2f7');
    // A DRAW THREE PLIES OUT. The one-ply check saw stalemates and the third repetition and missed
    // the commonest one: a level line whose own PV walks back into the same position. Five plies of
    // shuffling leaves the position twice-seen with black to move, and the engine's line repeats it.
    const five = 'g1f3 g8f6 f3g1 f6g8 g1f3';
    const mid = (() => { const b = new c.Chess('chess'); for (const u of five.split(' ')) b.move({from: u.slice(0,2), to: u.slice(2,4)}); return b.fen(); })();
    const repPv = [{move: 'g8f6', cp: 0, pv: 'g8f6 f3g1 f6g8'}, {move: 'b8c6', cp: -25}];
    setup({contempt: true, contempt_cp: 40}, mid, five, repPv, new c.Chess('chess').fen());
    eq('a repetition down the line is a draw too', c.contempt_pick('g8f6'), 'b8c6');
    const wonPv = [{move: 'g8f6', cp: 200, pv: 'g8f6 f3g1 f6g8'}, {move: 'b8c6', cp: 190}];
    setup({contempt: true, contempt_cp: 40}, mid, five, wonPv, new c.Chess('chess').fen());
    eq('...but only a line the engine itself calls level', c.contempt_pick('g8f6'), 'g8f6');
    const wrongPv = [{move: 'g8f6', cp: 0, pv: 'b8c6 f3g1 f6g8'}, {move: 'b8c6', cp: -25}];
    setup({contempt: true, contempt_cp: 40}, mid, five, wrongPv, new c.Chess('chess').fen());
    eq('...and a pv describing another move is not this move\'s draw', c.contempt_pick('g8f6'), 'g8f6');
    ok('the played move consults it above the playstyle',
        /const fought = config\.puzzle_mode \? best : contempt_pick\(best\);/.test(pj)
        && pj.indexOf(': fight_ok ? fought') < pj.indexOf(': style_ok ? styled : best;'));
}

// ---- the two pacing features ---------------------------------------------------------------------
{
    console.log('\npacing:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext('var config = {}; var last_eval = {};\nfunction line_cp_ours(l) { return l.cp; }\n'
        + pj.slice(pj.indexOf('// ---- THE COMPLEXITY CLOCK'), pj.indexOf('// per-move time budget in ms from the scraped clock')), c);
    const k = (cfg, lines) => { c.config = cfg; c.last_eval = {lines}; return c.complexity_k(); };
    const two = (a, b) => [{move: 'a2a3', cp: a}, {move: 'b2b3', cp: b}];
    eq('off, the settings are used exactly as they are', k({}, two(10, 10)), 1);
    eq('one line is no measure of complexity', k({complexity_clock: true}, two(10, 10).slice(0, 1)), 1);
    eq('two moves it cannot separate: sit on it', k({complexity_clock: true}, two(20, 10)), 1.6);
    eq('an ordinary gap changes nothing', k({complexity_clock: true}, two(100, 20)), 1);
    eq('an obvious move is quickest', k({complexity_clock: true}, two(900, 20)), 0.6);
    eq('a mate is a found position, not a hard one', k({complexity_clock: true}, two(99999, 10)), 1);

    // THE FEATURES THAT READ THE SECOND LINE. Both of them were silent at Multi Lines 1 -- which is
    // the default -- because there was no second line to read. The floor is on the ENGINE's line
    // count; what the panel LISTS is still config.multiple_lines.
    const m = {console, Math, Number, parseInt};
    m.self = m;
    vm.createContext(m);
    vm.runInContext('var config = {};\nfunction humanize_rates() { return {}; }\n'
        + 'function humanize_thresholds() { return {}; }\nvar flags = {};\nfunction humanize_flag(k, d) { return k in flags ? flags[k] : d; }\n'
        + pj.match(/const HZ_MATCH_DEFAULT = (true|false);/)[0].replace('const', 'var') + '\n'
        + pj.slice(pj.indexOf('const HUMANIZE_DEEP_MULTIPV'), pj.indexOf('// Ordered worst-to')), m);
    const mpv = (cfg) => { m.config = cfg; return m.effective_multipv(); };
    eq('nothing switched on: the slider is the line count', mpv({multiple_lines: 1}), 1);
    eq('contempt cannot choose without a second line', mpv({multiple_lines: 1, contempt: true}), 2);
    eq('nor can the complexity clock measure a gap', mpv({multiple_lines: 1, complexity_clock: true}), 2);
    eq('...and a slider set higher still wins', mpv({multiple_lines: 5, contempt: true}), 5);
    eq('Err Like Your Rating draws mistakes on every move, so Humanize, where it is on by default, asks for the wide list', mpv({multiple_lines: 1, humanize: true}), 20);
    m.flags = {humanize_match: false};
    eq('...and with it off, humanize keeps its own deeper list', mpv({multiple_lines: 1, humanize: true, contempt: true}), 6);
    m.flags = {};
    eq('Suggest a Human Error asks for the wide list on its own, so an inaccuracy has a rank to sit at', mpv({multiple_lines: 1, human_error: true}), 20);
    m.flags = {humanize_match: false};
    eq('...but not while Autoplay plays through Humanize: that search stays what it was without the option', mpv({multiple_lines: 1, humanize: true, autoplay: true, human_error: true}), mpv({multiple_lines: 1, humanize: true, autoplay: true}));
    eq('...and with Autoplay off, Humanize on, it does widen', mpv({multiple_lines: 1, humanize: true, autoplay: false, human_error: true}), 20);
    m.flags = {};
    // ...and NONE of that reaches the board: the arrows and the list follow the slider, so raising
    // the engine's line count for a feature cannot quietly put five more arrows on a board set to one.
    // The placeholder the engine sends for a second line it has not found yet ("multipv 2 ... pv" with
    // nothing after), and the depth-0 frame it sends in a position that is already over, both used to
    // reach pv.split and throw. Raising the line count made the first one common.
    ok('a frame carrying no line is dropped rather than parsed',
       /if \(!lineInfo\.pv \|\| !lineInfo\.rawScore\) return;/.test(pj));
    ok('what is drawn is what you asked to see, not what was searched',
       /const shown = Math\.max\(1, parseInt\(config\.multiple_lines\) \|\| 1\);\n\s*for \(let i = 0; i < Math\.min\(last_eval\.activeLines, shown\); i\+\+\)/.test(pj));
    ok('...on the 14x14 board too', !/effective_multipv\(\)\)\n?\s*\.map\(\(mv, i\)/.test(pj)
       && /\.slice\(0, Math\.max\(1, parseInt\(config\.multiple_lines\) \|\| 1\)\)/.test(pj));

    // seeded: the measured spread makes a 20,000-draw mean wobble ~0.8%, too close to the 2% band for Math.random
    let seed = 12345;
    const M = Object.create(Math);
    M.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const h = {console, Math: M, Number};
    h.self = h;
    vm.createContext(h);
    vm.runInContext(pj.slice(pj.indexOf('// ---- HOW LONG A PERSON ACTUALLY TAKES'), pj.indexOf('// ---- THE COMPLEXITY CLOCK')), h);
    // THE MEAN IS THE CONTRACT, not the median: the setting says how long a move takes ON AVERAGE,
    // and feeding it in as the median made every move ~13% slower than the slider said (a log-normal's
    // mean is exp(sigma^2/2) above its median). 20,000 draws, so the 1% band is well outside the noise.
    const N = 20000, WANT = 1000;
    const draws = Array.from({length: N}, () => h.lognormal_ms(WANT)).sort((a, b) => a - b);
    const median = draws[N >> 1], mean = draws.reduce((a, b) => a + b, 0) / N;
    ok(`the MEAN is the number the settings asked for (${Math.round(mean)}ms of ${WANT})`, Math.abs(mean - WANT) < WANT * 0.02);
    ok(`...and the typical move is quicker than it, which is what a right tail IS (median ${median}ms, 0.66 of it at a person's spread)`,
       median < mean * 0.75 && median > WANT * 0.6);
    ok('...nothing is negative and nothing is instant', draws[0] > 0);
    ok('...the tail is long but not infinite (6x the average, after the clamp correction)', draws[N - 1] <= WANT * 6 / 0.977 + 1);
    ok('...and the spread is the measured one: the slow tenth at about 2.2x the average (players: 2.4x in blitz)',
       draws[Math.floor(N * 0.9)] > WANT * 2.0 && draws[Math.floor(N * 0.9)] < WANT * 2.4, draws[Math.floor(N * 0.9)]);
    eq('an average of zero is zero, not NaN', h.lognormal_ms(0), 0);
    ok('humanize uses the same averages as the bands it replaces',
        /instant: 75, quick: 500, normal: 1300, long: 4250/.test(pj));
    ok('...and the configured path spends its variance rather than re-flattening the draw',
        /t\.think_time = lognormal_ms\(t\.think_time \+ t\.think_variance \/ 2\);\s*\n\s*t\.think_variance = 0;/.test(pj));
}

// ---- ending a game that is over -------------------------------------------------------------------
{
    console.log('\nauto resign / auto draw:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    // game_fullmove now asks the replayed board, so the replay comes along -- it lives in the
    // contempt block, which is where the board is built.
    vm.runInContext('var config = {variant: "chess"}; var last_eval = {}; var last_pos = {};\n'
        + 'function line_cp_ours(l) { return l.cp; }\nfunction send_to_active_tab() {}\n'
        + pj.slice(pj.indexOf('// ---- CONTEMPT: the dial for a game you have to WIN'), pj.indexOf('function humanize_pick(best'))
        + pj.slice(pj.indexOf('// ---- ENDING A GAME THAT IS OVER'), pj.indexOf("// ---- THE PLAYER BOOK: somebody's openings")), c);
    const run = (cfg, scores, fullmove = 40, proved = null) => {
        c.config = cfg;
        vm.runInContext('resign_streak = draw_streak = 0;', c);
        return scores.map((cp) => c.end_game_action(cp, fullmove, proved));
    };
    eq('off, a lost game is just a lost game', run({}, [-1200, -1200, -1200]), [null, null, null]);
    eq('on, it takes three turns of the same verdict', run({auto_resign: true}, [-1200, -1200, -1200, -1200]),
        [null, null, 'resign', 'resign']);
    eq('...and one good reading starts the count again',
        run({auto_resign: true}, [-1200, -1200, -100, -1200, -1200]), [null, null, null, null, null]);
    eq('...a bad position is not a lost one', run({auto_resign: true, auto_resign_cp: 900}, [-800, -800, -800]), [null, null, null]);
    eq('a dead level game is offered a draw', run({auto_draw: true}, [5, -5, 10]), [null, null, 'draw']);
    eq('...but never in the opening', run({auto_draw: true}, [5, -5, 10], 6), [null, null, null]);
    eq('being lost outranks being level', run({auto_resign: true, auto_draw: true}, [-1200, -1200, -1200]),
        [null, null, 'resign']);
    // A PROVED RESULT VETOES BOTH ACTIONS. The engine scores a fortress -900 and the tablebase knows
    // it is drawn; resigning that is the worst thing this feature can do.
    eq('a proved draw is never resigned', run({auto_resign: true}, [-1200, -1200, -1200, -1200], 40, 'draw'),
        [null, null, null, null]);
    eq('...nor is one the fifty-move rule saves', run({auto_resign: true}, [-1200, -1200, -1200], 40, 'blessed-loss'),
        [null, null, null]);
    eq('a proved loss still is', run({auto_resign: true}, [-1200, -1200, -1200], 40, 'loss'),
        [null, null, 'resign']);
    eq('and no draw is offered in a position we are proved to win',
        run({auto_draw: true}, [5, -5, 10], 40, 'win'), [null, null, null]);
    eq('an unsolved position is decided by the score, as before',
        run({auto_resign: true}, [-1200, -1200, -1200], 40, null), [null, null, 'resign']);

    // THE MOVE NUMBER, from whichever of the three sources knows most. None can over-count, so the
    // largest wins. NOTE what the second case does and does not prove: the replayed board only knows
    // the move number when the START position carried counters. On lichess it does not -- the content
    // script hands the panel a placement-and-turn string -- so there the ply count is what answers,
    // which is why all three are consulted rather than just the board.
    const fullmoveOf = (startFen, moves, fen) => {
        c.last_pos = {startFen, moves};
        c.last_eval = {fen};
        return c.game_fullmove();
    };
    const startPos = new c.Chess('chess').fen();
    const afterE4 = (() => { const b = new c.Chess('chess'); for (const u of ['e2e4','e7e5','g1f3']) b.move({from: u.slice(0,2), to: u.slice(2,4)}); return b.fen(); })();
    eq('the replayed board says what move it is', fullmoveOf(startPos, 'e2e4 e7e5 g1f3', afterE4.replace(/\d+ \d+$/, '0 1')), 2);
    const setup30 = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 30';
    const after30 = (() => { const b = new c.Chess('chess', setup30); b.move({from: 'e1', to: 'g1'}); return b.fen(); })();
    eq('...including a game joined from a set-up position', fullmoveOf(setup30, 'e1g1', after30.replace(/\d+ \d+$/, '0 1')), 30);
    eq('a position it cannot replay falls back to the ply count', fullmoveOf(null, 'e2e4 e7e5 g1f3', '8/8/8/8/8/8/8/8 b - - 0 1'), 2);
    // The live case the board CANNOT answer: a start position stripped to placement and turn. The
    // ply count has to carry it, and taking the board's answer alone reported move 2 in a game that
    // was really at move 41 (measured on lichess 2026-09-12).
    const stripped = new c.Chess('chess', setup30.split(' ').slice(0, 4).join(' ') + ' 0 1').fen();
    eq('...and a start position with its counters stripped still counts the plies',
       fullmoveOf(stripped, 'e1g1 e8g8', new c.Chess('chess', stripped).fen().replace(/\d+ \d+$/, '0 1')), 2);
    eq('a set-up FEN that DOES carry the number is not thrown away',
       fullmoveOf(null, '', 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 30'), 30);
    ok('a resignation takes the move away; a draw is offered alongside it',
        /const ending = maybe_end_game\(\);\s*\n\s*if \(ending === 'resign'\)/.test(pj) && !/if \(ending === 'draw'\)/.test(pj));
    ok('the page half presses the site control and then confirms it',
        /function doGameAction\(kind\)/.test(cs) && /pressControl\(yes\)/.test(cs));
    ok('...falling back to the element itself, because our own panel covers the site controls',
        /if \(!document\.contains\(el\)\) return;/.test(cs));
}

// ---- the player book and the session line ---------------------------------------------------------
{
    console.log('\nplayer book / session:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext('var config = {}; var last_eval = {fen: ""}; var detected_prefix = "li";\n'
        + 'var Math_random = 0; Math.random = () => Math_random;\n'
        + 'function our_side() { return "white"; }\nfunction notate(fen, uci) { return uci; }\n'
        + 'function update_best_move() {}\nvar FETCHES = 0;\n'
        + 'var chrome = {runtime: {sendMessage() { FETCHES++; }, lastError: null}};\n'
        + 'var STORE = {};\n'
        + 'var MephistoConfig = {get: (k) => (k in STORE) ? STORE[k] : null, set: (k, v) => { STORE[k] = v; }};\n'
        + pj.slice(pj.indexOf('const OPP_PREP_MIN_CLOCK_S'), pj.indexOf('// ---- TWO ENGINES AT ONCE')), c);
    const who = (v, prefix) => { c.config = {player_book_user: v}; c.detected_prefix = prefix; return c.parse_player_book_user(); };
    eq('a bare name means the site you are on', who('magnus', 'li'), {site: 'lichess', name: 'magnus'});
    eq('a prefix says which archive', who('chesscom:hikaru', 'li'), {site: 'chesscom', name: 'hikaru'});
    eq('an empty box is not a player', who('', 'li'), null);
    const games = [
        {white: 'me', black: 'x', result: '1-0', san: 'e4 c5 Nf3 d6'},
        {white: 'me', black: 'y', result: '0-1', san: 'd4 d5 c4 e6'},
        {white: 'z', black: 'me', result: '0-1', san: 'e4 c5 Nf3 Nc6'},
    ];
    const START = new c.Chess('chess').fen().split(' ').slice(0, 2).join(' ');
    const all = c.build_moves_book(games, 'me', {maxPly: 24, winsOnly: false});
    const wins = c.build_moves_book(games, 'me', {maxPly: 24, winsOnly: true});
    eq('every game the player is in is used', all.used, 3);
    eq('...and the book holds THEIR moves, not the opponent\'s', all.book.get(START), {e2e4: 1, d2d4: 1});
    eq('wins only drops the game they lost', wins.used, 2);
    eq('...so the opening they lost with is gone', wins.book.get(START), {e2e4: 1});
    const setBook = (obj) => vm.runInContext(`player_book = new Map(Object.entries(${JSON.stringify(obj)}));`, c);
    c.config = {player_book: true, player_book_user: 'me'};
    setBook({[START]: {e2e4: 3, d2d4: 1}});
    const fen = new c.Chess('chess').fen();
    const pick = (r) => { c.Math_random = r; return c.player_book_pick(fen); };
    eq('the move they played most is the likely one', pick(0.1), 'e2e4');
    eq('...but the rarer one is reachable', pick(0.9), 'd2d4');
    setBook({[START]: {e2e4: 1}});
    eq('a move played once is an accident, not a repertoire', pick(0.1), null);

    // THE ARCHIVE IS PULLED ONCE, NOT ONCE PER RELOAD. "One fetch per session" meant a fresh download
    // on every navigation of a single-page site, for a repertoire that had not moved.
    const built = {book: new Map([[START, {e2e4: 3}]]), used: 7};
    c.player_book_cache_write('lichess|me|all', built);
    const back = c.player_book_cache_read('lichess|me|all');
    ok('a built book is written down', !!back && back.used === 7 && back.book.get(START).e2e4 === 3);
    eq('...under its own key, so another player is a miss', c.player_book_cache_read('lichess|you|all'), null);
    vm.runInContext(`STORE.player_book_cache = JSON.stringify({key: 'lichess|me|all', at: Date.now() - PLAYER_BOOK_TTL_MS - 1, used: 7, book: {}});`, c);
    eq('...and a week-old book is fetched again', c.player_book_cache_read('lichess|me|all'), null);
    c.player_book_cache_write('big', {book: new Map([['x', {y: 'z'.repeat(500000)}]]), used: 1});
    eq('a book too big for the quota is simply not cached', c.player_book_cache_read('big'), null);
    c.player_book_cache_write('lichess|me|all', built);
    vm.runInContext('player_book = null; player_book_for = ""; player_book_games = 0; FETCHES = 0;', c);
    c.config = {player_book: true, player_book_user: 'me', player_book_wins: false};
    c.maybe_player_book();
    ok('a cached book loads with no request at all',
       vm.runInContext('FETCHES', c) === 0 && vm.runInContext('player_book_games', c) === 7);
    vm.runInContext('STORE = {}; player_book = null; player_book_for = ""; FETCHES = 0;', c);
    c.maybe_player_book();
    ok('...and an empty cache still asks', vm.runInContext('FETCHES', c) === 1);
    // NEITHER NEW KEY IS A SETTING. The settings export keeps every JSON string in the store, and a
    // file meant to be pasted into an issue must not carry a username, somebody's whole repertoire,
    // or this machine's running totals.
    const sp = fs.readFileSync(ROOT + '/src/options/util/SettingsPage.js', 'utf8');
    ok('the cached book is not exported with the settings', /delete all\.player_book_cache;/.test(sp));
    ok('...nor are the session totals', /delete all\.session_totals;/.test(sp));

    const s2 = {console, Date, JSON, Number, Array, Math};
    s2.self = s2;
    vm.createContext(s2);
    vm.runInContext('var config = {session_stats: true};\nfunction our_side() { return "white"; }\n'
        + 'var STATS = {white: {accuracy: 90}, black: {accuracy: 10}};\n'
        + 'function live_stats(h) { return (h && h.length) ? STATS : {white: {accuracy: null}, black: {accuracy: null}}; }\n'
        + 'var STORE = {};\n'
        + 'var MephistoConfig = {get: (k) => (k in STORE) ? STORE[k] : null, set: (k, v) => { STORE[k] = v; }};\n'
        + 'var eval_history = [0.5, 0.5]; var eval_history_game = "game-1";\n'
        + pj.slice(pj.indexOf('// ---- WHAT THIS SESSION HAS ACTUALLY DONE'), pj.indexOf('// ---- ENDING A GAME THAT IS OVER')), s2);
    vm.runInContext('session = session_fresh();', s2);
    eq('nothing has happened, so nothing is said', s2.session_stats_label(), '');
    s2.session_note_move(1000); s2.session_note_move(3000);
    // the game being played counts as a game (it used to read "0 games" until the panel saw the next one start)
    ok('the average is over the MOVES, and the game in progress is counted', /1 games · 2 moves · 2\.0s avg/.test(s2.session_stats_label()));
    // THE GAME IN FRONT OF YOU. Accuracy used to need a FINISHED game, so a session spent on one long
    // game showed moves and seconds and no accuracy at all.
    ok('...and the unfinished game already carries its accuracy',
       /1 games · 2 moves · 2\.0s avg · 90% accuracy/.test(s2.session_stats_label()));
    s2.session_note_game([0.5, 0.5], 'game-1');
    ok('a finished game brings its accuracy', /1 games · 2 moves · 2\.0s avg · 90% accuracy/.test(s2.session_stats_label()));
    // on_new_pos clears the history right after the fold (a new game from the SAME start FEN is
    // the normal case), so the finished game is counted once and the live reading starts empty
    vm.runInContext('eval_history = [];', s2);
    ok('...counted once, not twice: the history is cleared at the fold',
       vm.runInContext('session.acc.length', s2) === 1 && s2.session_live_accuracy() === null);
    vm.runInContext('eval_history = [0.5, 0.5]; STATS.white.accuracy = 50;', s2);   // same start FEN, "game-1"
    ok('...and the next game from the same start averages in alongside it',
       /1 games · 2 moves · 2\.0s avg · 70% accuracy/.test(s2.session_stats_label()));
    s2.session_note_move(undefined);
    ok('...and a delay nobody measured is not counted as zero', /3 moves/.test(s2.session_stats_label()) === false);
    // A RELOAD USED TO ZERO IT. It is written under today's date and read back on the next load.
    const stored = JSON.parse(vm.runInContext('STORE.session_totals', s2));
    ok('the totals are written down, with the day they belong to',
       stored.moves === 2 && stored.games === 1 && stored.acc.length === 1 && !!stored.day);
    vm.runInContext('session = session_fresh();', s2);
    eq('...so a fresh panel starts empty until it reads them', s2.session_stats_label(), '');
    vm.runInContext('session_restore();', s2);
    ok('...and reading them back restores the count', /1 games · 2 moves · 2\.0s avg/.test(s2.session_stats_label()));
    vm.runInContext('STORE.session_totals = JSON.stringify({day: "1999-1-1", games: 9, moves: 9, think_ms: 9, acc: [9]}); session = session_fresh(); session_restore();', s2);
    eq('...but yesterday\'s totals are not today\'s', s2.session_stats_label(), '');
    // LICHESS: every game is its own page and its own panel, so no ply-count drop is ever seen. The game is
    // remembered with the totals and folded when a move comes from a different one.
    vm.runInContext('session = session_fresh(); eval_history = [0.5, 0.5]; STATS.white.accuracy = 80; var location = {host: "lichess.org", pathname: "/AbCd1234/white"};', s2);
    s2.session_note_move(1000); s2.session_note_move(1000);
    vm.runInContext('location = {host: "lichess.org", pathname: "/AbCd1234"};', s2);
    s2.session_note_move(1000);
    ok('a lichess game is one game across its /white and /black addresses', /1 games · 3 moves/.test(s2.session_stats_label()), s2.session_stats_label());
    vm.runInContext('location = {host: "lichess.org", pathname: "/ZzYy9876"}; eval_history = [0.5, 0.5]; STATS.white.accuracy = 60;', s2);
    s2.session_note_move(1000);
    ok('...a move in the next game\'s page folds the last one with its accuracy, and both are counted',
       vm.runInContext('session.games', s2) === 1 && /2 games · 4 moves · 1\.0s avg · 70% accuracy/.test(s2.session_stats_label()), s2.session_stats_label());
    vm.runInContext('session_restore(); location = {host: "lichess.org", pathname: "/analysis"}; eval_history = [];', s2);
    ok('...and the game in progress survives a reload and is read back from the store on another page',
       /2 games · 4 moves · 1\.0s avg · 70% accuracy/.test(s2.session_stats_label()), s2.session_stats_label());
    ok('only on-turn moves are counted, so a blind premove cannot drag the average',
        /if \(verify && session_counted_fen !== last_eval\.fen\) \{\s*session_counted_fen = last_eval\.fen;\s*session_note_move\(/.test(pj));
    ok('...and switching Session Stats on records the history its accuracy needs',
        /!config\.eval_history && !config\.session_stats && !classifier_wanted\(\)/.test(pj));
}

// ---- the self-test names the features that are quietly doing nothing ------------------------------
{
    console.log('\nself-test rows:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext('var TABLEBASE_MAX_MEN = 7;\n'
        + pj.slice(pj.indexOf('// THE WAYS THE PANEL CAN BE WORKING AND STILL DOING NOTHING'),
                   pj.indexOf('function live_stats(')), c);
    const of = (st) => Object.fromEntries(c.feature_rows(st).map(r => [r.label, r.ok]));
    eq('nothing switched on is nothing to report',
       of({lines: 1, needsLines: [], playerBook: null, tablebase: null}),
       {'Engine lines': null, 'Player book': null, 'Tablebase': null});
    eq('contempt on one line is the failure it used to be silently',
       of({lines: 1, needsLines: ['contempt'], playerBook: null, tablebase: null})['Engine lines'], false);
    eq('...and two lines answers it', of({lines: 2, needsLines: ['contempt'], playerBook: null, tablebase: null})['Engine lines'], true);
    eq('a book that never loaded is a fault, not a silence',
       of({lines: 1, needsLines: [], playerBook: {who: {name: 'me'}, loaded: false, games: 0}, tablebase: null})['Player book'], false);
    eq('...and a loaded one passes',
       of({lines: 1, needsLines: [], playerBook: {who: {name: 'me'}, loaded: true, games: 12}, tablebase: null})['Player book'], true);
    eq('a tablebase with too many men on the board is not a fault',
       of({lines: 1, needsLines: [], playerBook: null, tablebase: {men: 20, inRange: false, answered: false}})['Tablebase'], null);
    eq('...but one in range that has not answered is',
       of({lines: 1, needsLines: [], playerBook: null, tablebase: {men: 5, inRange: true, answered: false}})['Tablebase'], false);
    const detail = c.feature_rows({lines: 1, needsLines: ['contempt', 'complexity_clock'], playerBook: null, tablebase: null})[0].detail;
    ok('the row says WHICH feature is waiting on a line it has not got', /contempt \+ complexity_clock/.test(detail), detail);
    ok('the diagnostics button reports them too', /return rows\.concat\(feature_rows\(st\)\);/.test(pj));
    ok('...and so does the one-tap self-test', /const feats = feature_rows\(health_state\(\)\)\.filter\(r => r\.ok !== null\);/.test(pj));
    // ...where it can still be read. The detection line is repainted on every engine frame, so the
    // result used to be correct and invisible during a live game.
    ok('the self-test result also lands where the panel does not paint over it',
       /el\.innerText = line;[\s\S]{0,600}?set_idle_reason\(line\);/.test(pj));
    // ...and stays there. During a live game the panel clears the idle line on every engine frame,
    // so without the hold the result was wiped within a frame of being written.
    ok('...and a clear cannot wipe it while the hold is up',
       /if \(!text && Date\.now\(\) < idle_hold_until\) return;/.test(pj)
       && /idle_hold_until = Date\.now\(\) \+ SELF_TEST_MS;/.test(pj));
}

// ---- the review can be run at the depths the other review uses ---------------------------------------
{
    console.log('\nreview depth ladder:');
    const rh = fs.readFileSync(ROOT + '/src/options/pages/review/review.html', 'utf8');
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // Chess.com's Game Review "Strength" is a DEPTH ladder: its own option values are 18/22/24/26 and
    // the seconds printed beside them are an estimate of the cost, not the budget (read out of its
    // settings dialog 2026-09-12). Matching the rungs is what makes two accuracy numbers comparable.
    const opts = [...rh.slice(rh.indexOf('id="rv_depth_preset"'), rh.indexOf('</select>', rh.indexOf('id="rv_depth_preset"')))
                    .matchAll(/<option value="(\d*)"/g)].map(m => m[1]);
    eq('the rungs are the ones that review uses', opts, ['', '18', '22', '24', '26']);
    ok('picking a rung switches the budget to depth', /\$\('rv_limit_kind'\)\.value = 'depth';/.test(rj));
    ok('...and fills the box, which stays the source of truth', /\$\('rv_limit_num'\)\.value = v;/.test(rj));
    ok('a typed depth reads back as its rung, anything else as Custom',
       /sel\.value = \[\.\.\.sel\.options\]\.some\(o => o\.value === now\) \? now : '';/.test(rj));
    ok('the ladder hides in Time mode, where a depth means nothing',
       /sel\.style\.display = depthMode \? '' : 'none';/.test(rj));
    // and the budget must still reach the engine as a real depth limit
    const ej = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    ok('a depth budget is sent as `go depth N`', /if \(limitKind === 'depth'\) return `go depth \$\{limitValue\}`;/.test(ej));
}

// ---- a game at move zero is White to play, on every site --------------------------------------------
{
    console.log('\nopening turn:');
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const fn = cs.slice(cs.indexOf('function turnFromContext()'), cs.indexOf('// Storm and Racer never need the guess'));
    // With no move list and no last-move highlight -- a game at its STARTING position -- the turn was
    // read off the board ORIENTATION, which is a PUZZLE rule: a puzzle is a set-up position drawn
    // from the solver's side, a game at move 0 is not. lichess was fixed for this once; chess.com was
    // left behind, and its Play Computer page ships no move list at all, so that branch decides the
    // opening turn there. Symptom, reported 2026-09-12: "it thought black has to play but white
    // starts and we are white -- it evaluated for black and never moved".
    ok('lichess says White at the start', /if \(site === 'lichess'\) \{\s*\n\s*return 'w';/.test(fn));
    ok('...and so does chess.com, outside a puzzle',
       /if \(site === 'chesscom' && !isPuzzlePage\(\)\) \{\s*\n\s*return chesscomUrlFenTurn\(\) \|\| 'w';/.test(fn));   // White, unless the page's ?fen= says otherwise
    ok('...and neither consults the orientation to decide it',
       fn.indexOf("site === 'chesscom' && !isPuzzlePage()") < fn.lastIndexOf('getOrientation()'));
    ok('a puzzle still reads its own orientation', /getOrientation\(\) === 'black'\) \? 'w' : 'b'/.test(fn));
}

// ---- a refused position says why it was refused ----------------------------------------------------
{
    console.log('\nillegal scrape:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const ctx = {console};
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext('var config = {variant: "chess"};\n'
        + pj.slice(pj.indexOf('// WHY a scraped position was refused'), pj.indexOf('function is_legal_position')), ctx);
    // Horde: 36 white pawns and no white king. Legal there, illegal by standard rules, and the panel
    // is deliberately NOT auto-switched into a variant on lichess -- so it refused the board and said
    // nothing, showing "Game detected" over a dead readout for ever (found sweeping the variants).
    const HORDE = 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1';
    ok('a variant board is named as a variant board', /variant game/.test(ctx.illegal_scrape_reason(HORDE)));
    ok('...and points at the control that fixes it', /Variant in the Engine tab/.test(ctx.illegal_scrape_reason(HORDE)));
    // a torn read of a standard board is a different cause and wants a different sentence
    const TORN = '8/8/8/8/8/8/8/K6k w - - 0 1';
    ok('a plain unreadable position is not blamed on the variant',
       !/variant game/.test(ctx.illegal_scrape_reason(TORN)) && /fixes itself/.test(ctx.illegal_scrape_reason(TORN)));
    ctx.config = {variant: 'horde'};
    ok('...and with the variant already set, the variant is not the suggestion',
       !/variant game/.test(ctx.illegal_scrape_reason(HORDE)));
    ok('the skip actually shows it', /set_idle_reason\(illegal_scrape_reason\(fen\)\);/.test(pj));
}

// ---- Time Trouble caps a budget the engine is actually given ----------------------------------------
{
    console.log('\ntime trouble:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // The cap is applied to `movetime`. In Depth search mode the engine is sent `go depth N` and no
    // movetime at all, so the cap landed on a number that branch never used: the feature promised
    // "your clock is nearly gone, move fast" and did nothing whenever the budget was set by depth.
    ok('depth mode gives way to the clock when the clock is nearly gone',
       /} else if \(searching_by_depth\(\) && !in_time_trouble\(\)\) \{/.test(pj));
    ok('...and that branch sends a movetime, which is the thing the cap applies to',
       pj.includes('send_engine_uci(`go movetime ${Math.min(movetime, TIME_TROUBLE_SEARCH_MS)}`)'));
    ok('...and the plain depth search still sends depth ALONE, never both',
       /send_engine_uci\(`go depth \$\{config\.compute_depth\}`\)/.test(pj)
       && !/go depth \$\{config\.compute_depth\} movetime/.test(pj));
}

// ---- the Maia reply fetch runs on the engines it was written for ------------------------------------
{
    console.log('\nmaia premove:');
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // maia2_kick asks the human net for OUR reply to its predicted move, because a one-pass net's pv
    // is one move long and carries no reply. Everything in it assumes the main engine is that net.
    // The guard said `if (is_one_pass()) return`, so it bailed on exactly those engines and Premove
    // was dead on all of them. Measured 2026-09-12 over a 24-move Maia-3 game: zero premove lines
    // before, sixteen after.
    const body = pj.slice(pj.indexOf('function maia2_kick(line) {'), pj.indexOf('function maia2_on_line'));
    ok('it runs only FOR a one-pass net, not only against one', /if \(!is_one_pass\(\)\) return;/.test(body), body.slice(0, 80));
    ok('...and it is still the first thing the function asks',
       body.indexOf('is_one_pass()') < body.indexOf('config.premove'));
    // the reason it can skip ensureOffscreen at all -- if this comment goes, the guard above matters
    ok('it still relies on the main engine being that net',
       /the MAIN engine is Maia right now/.test(body));
}

// ---- the diagnostics say what they mean ------------------------------------------------------------
{
    console.log('\ndiagnostics wording:');
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    // The line lists OPEN PORTS. Read as "what is installed" it says the opposite of the truth: a
    // machine with every host installed shows one entry if only one engine has been used.
    ok('the hosts line says it lists connections, not installations',
       /connected \(not a list of what is installed\)/.test(bg));
}

// ---- every engine is listed beside its own native twin ---------------------------------------------
{
    console.log('\nengine order:');
    const ph = fs.readFileSync(ROOT + '/src/popup/popup.html', 'utf8');
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const ej = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // WASM first, its native twin directly under it (user call 2026-09-12). The three lists used to
    // disagree: the panel and the settings page led with the native build, engines.js grouped all
    // the WASM ones and then all the native ones.
    //
    // BUILD-AWARE, because the two trees do not ship the same natives: one has a native per Stockfish
    // version, the other has a single generic one. So the rule is stated as a SHAPE -- a native sits
    // immediately after a WASM build -- rather than as a fixed table of pairs. A twin is a native of
    // an engine that also ships as WASM; the specials further down the list are not twins of
    // anything and are matched by family rather than by name, so this file names no engine a build
    // might keep to itself.
    const isWasm = (id) => /^(stockfish|fairy-stockfish)-/.test(id);
    const isTwin = (id) => id.endsWith('-native') && /^(sf|stockfish|fairy)/.test(id);
    const slice = (src, from, re) => [...src.slice(src.indexOf(from), src.indexOf('</select>', src.indexOf(from))).matchAll(re)].map(m => m[1]);
    const lists = {
        panel: slice(ph, '<select id="qs_engine"', /<option value="([^"]+)"/g),
        settings: slice(gh, 'id="engine_select"', /<option value="([^"]+)"/g),
        engines: [...ej.slice(ej.indexOf('const ENGINES = ['), ej.indexOf('\n];', ej.indexOf('const ENGINES = ['))).matchAll(/\{id: '([^']+)'/g)].map(m => m[1]),
    };
    for (const [where, ids] of Object.entries(lists)) {
        ok(`${where}: the big net leads`, ids[0] === 'stockfish-19-nnue', ids[0]);
        const twins = ids.filter(isTwin);
        ok(`${where}: it lists ${twins.length} native twin(s)`, twins.length >= 1, twins);
        for (const t of twins) {
            const at = ids.indexOf(t);
            ok(`${where}: ${t} follows a WASM build`, at > 0 && isWasm(ids[at - 1]),
               ids.slice(Math.max(0, at - 1), at + 1));
        }
    }
}

// ---- a board with no last move is still a board -----------------------------------------------------
{
    console.log('\nturn reader:');
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // getLastMoveHighlights was made defensive -- it returns [] for "no last move readable" instead
    // of throwing -- and getTurn was still only listening for the throw. `[][1]` is undefined, which
    // sailed past a catch that could no longer fire and into `toSquare.style`. On lichess that is
    // every board with no `.last-move` on it: THE START OF A GAME. Measured 2026-09-12 on a fresh
    // game at move 0 -- without the guard "No Chess Game Detected" and 12 scrape failures, with it
    // detected and none. It is why playing as black worked (White had moved) and white did not.
    ok('an empty highlight read is handled, not just a thrown one',
       /if \(!toSquare\) return turnFromContext\(\);/.test(cs));
    ok('...and the guard comes BEFORE anything reads the square',
       cs.indexOf('if (!toSquare) return turnFromContext();')
         < cs.indexOf('const hlPiece = document.querySelector(`.piece.${toSquare.classList[1]}`)'));
    ok('the reader it protects still says [] rather than throwing',
       /if \(!toSquare \|\| !fromSquare\) return \[\];/.test(cs));
}

// ---- every human model is offered wherever human models are offered --------------------------------
{
    console.log('\nhuman models:');
    const eng = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.html', 'utf8');
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // Maia-2 was wired everywhere EXCEPT the two dropdowns -- KNOWN_HUMAN already accepted it and the
    // offscreen adapter already took its ratings, so the only thing missing was being offerable.
    ok('the review page offers Maia 2', /<option value="maia2">/.test(rv));
    ok('...and so does the analysis page', /<option value="maia2">/.test(an));
    for (const kind of ['maia', 'maia2', 'maia3']) {
        ok(`${kind} is a known human model`, new RegExp(`KNOWN_HUMAN = \\[[^\\]]*'${kind}'`).test(eng));
    }
    const ctx = {console};
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(eng.slice(eng.indexOf('// WHICH HUMAN MODELS TAKE A RATING'),
                              eng.indexOf('const humanLabel =')), ctx);
    // top-level `const` lives in the context's lexical scope, not on the global object -- read it by
    // evaluating the name, the same way premove_certified's accessors are read above
    const takesRating = vm.runInContext('takesRating', ctx);
    eq('Maia 1 ships bands, not a dial', takesRating('maia'), false);
    eq('Maia 2 takes a rating', takesRating('maia2'), true);
    eq('...and so does Maia 3', takesRating('maia3'), true);
    // Maia-2 buckets: <1100 is one bucket and >=2000 is another (offscreen/maia2.js eloBucket), so a
    // dial that offered 600 or 2600 would report a rating the net cannot actually tell apart.
    eq('Maia 2 is asked only where its buckets differ', [ctx.ratingSteps('maia2')[0], ctx.ratingSteps('maia2').at(-1), ctx.ratingSteps('maia2').length], ['1000', '2000', 11]);
    eq('Maia 3 is asked across its whole range', [ctx.ratingSteps('maia3')[0], ctx.ratingSteps('maia3').at(-1)], ['600', '2600']);
    eq('a stored rating is clamped to what the net can tell apart', ctx.ratingFor('maia2', 2600), '2000');
    eq('...and kept when it is in range', ctx.ratingFor('maia3', 1700), '1700');
    // The proxy that caused it: `kind === 'maia3'` meant "takes a rating" in ~20 places.
    const proxies = [...an.matchAll(/=== 'maia3'/g)].length
                  + [...fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8').matchAll(/=== 'maia3'/g)].length;
    ok('no page still spells "takes a rating" as "is Maia 3"', proxies === 0, proxies);
}

// ---- a failed scrape names the line, not the extension id ------------------------------------------
{
    console.log('\nscrape failure label:');
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = cs.slice(cs.indexOf('function scrapeFailLabel'), cs.indexOf('\n}', cs.indexOf('function scrapeFailLabel')) + 2);
    const label = new Function(src + '; return scrapeFailLabel;')();
    // A MADE-UP ID ON PURPOSE. This file is in a public repo; the real unpacked id is a fingerprint
    // and is exactly what the code under test exists to strip, so it must not be the fixture.
    const err = {
        message: "Cannot read properties of undefined (reading 'textContent')",
        stack: "TypeError: Cannot read properties of undefined (reading 'textContent')\n"
             + "    at getMoveRecords (chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/scripts/content-script.js:3721:44)\n"
             + "    at scrapePositionFen (chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/scripts/content-script.js:2001:17)",
    };
    const out = label(err);
    // The old rule spent its whole budget on the origin: "... (rea @ at chrome-extension://<32 chars>".
    ok('the property being read survives the truncation', /reading 'textContent'/.test(out), out);
    ok('...and so do the function, the file and the line',
       /getMoveRecords/.test(out) && /content-script\.js:3721:44/.test(out), out);
    // This dump exists to be pasted into an issue. The id is a fingerprint and must not ride along.
    ok('the extension id is not in a report written to be pasted', !/[a-p]{32}/.test(out), out);
    ok('an error with no stack still reports its message', /^boom/.test(label({message: 'boom'})), label({message: 'boom'}));
    ok('the catch uses it', /lastScrapeFail = scrapeFailLabel\(e\);/.test(cs));
}

// ---- a row with a button is a row on ONE line ------------------------------------------------------
{
    console.log('\none-line rows:');
    const css = fs.readFileSync(ROOT + '/src/popup/popup.css', 'utf8');
    const html = fs.readFileSync(ROOT + '/src/popup/popup.html', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // The rule used to be tied to ONE button's id, so the three rows added after it wrapped into two
    // cramped lines exactly as that one had. A class cannot be outgrown the same way.
    ok('the one-line layout is a class, not one button\'s id',
       /#quick-settings \.qs-row\.qs-oneline \{/.test(css) && !/\.qs-row:has\(#qs_copydiag\) \{/.test(css));
    ok('...and the pill belongs to every button in such a row',
       /#quick-settings \.qs-oneline > button \{/.test(css) && !/#quick-settings #qs_copydiag \{/.test(css));
    ok('...in dark mode too', /body\.mephisto-dark #quick-settings \.qs-oneline > button \{/.test(css));
    ok('the value shrinks rather than the label, and shows it was cut',
       /#quick-settings \.qs-value \{[^}]*text-overflow: ellipsis;/.test(css)
       && /#quick-settings \.qs-value \{[^}]*min-width: 0;/.test(css));
    // THE REGRESSION GUARD: any row whose control is a bare button or a bare value must carry the
    // class, or it wraps. A row that gets one added later fails here rather than in a screenshot.
    const rows = html.split('<div class="qs-row').slice(1)
        .map(r => '<div class="qs-row' + r.slice(0, r.indexOf('</div>')));
    const wrappers = rows.filter(r => /<button/.test(r) || /class="qs-value"/.test(r))
        .filter(r => !/<select|<input/.test(r))              // a select row lays itself out
        .filter(r => !/qs-bot-actions/.test(r));             // the bot row stacks on purpose
    ok(`every bare-button / bare-value row is marked (${wrappers.length} of them)`,
       wrappers.length >= 4 && wrappers.every(r => r.includes('qs-oneline')),
       wrappers.filter(r => !r.includes('qs-oneline')).map(r => r.slice(0, 80)));
}

// ---- the notice strip does not sit on the answer ----------------------------------------------------
{
    console.log('\nnotice overlap:');
    const css = fs.readFileSync(ROOT + '/src/popup/popup.css', 'utf8');
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    for (const notice of ['#update-notice', '#calibrate-notice', '#engine-notice']) {
        ok(`${notice} yields to the set-up row`, css.includes(`${notice}:has(~ #setup-fen-row:not([style*="display: none"]))`));
        for (const block of ['#alt-lines', '#book-lines']) {
            ok(`${block} makes room while ${notice} is showing`, css.includes(`${notice}:not([hidden]) ~ ${block}`));
        }
    }
    ok('...and no notice paints a see-through strip over what is under it',
        !/rgba\(11, 114, 133, 0\.10\)/.test(css) && (css.match(/background: #e7f4f7/g) || []).length === 2);
    ok('the room made is less than the list takes on its own (measured at 56px)',
        /#engine-notice:not\(\[hidden\]\) ~ #alt-lines \{ max-height: 56px; \}/.test(css)
        && /#alt-lines \{[^}]*max-height: 122px;/.test(css));
}


// ---- strokeFunc, executed: EVERY listed line gets an arrow ------------------------------------
// The panel colour-matches each eval row to its own arrow, so a row the board omits points at
// nothing. A line far behind the best used to return 0 and vanish (reported 2026-09-14: three rows
// listed, two arrows drawn). It must now come back at MIN_STROKE -- thin, but drawn.
{
    console.log('\nstroke widths:');
    const ok = (name, cond, extra) => { if (cond) console.log('ok   ' + name);
        else { fails++; console.log('FAIL ' + name + (extra ? ' -- ' + extra : '')); } };
    const ss = src.indexOf('    function strokeFunc(line) {');
    const se = src.indexOf('\n    }', src.indexOf('return Math.min(MAX_STROKE, Math.max(MIN_STROKE, stroke))', ss)) + 6;
    if (ss < 0 || se < 6) { fails++; console.log('FAIL could not slice strokeFunc'); }
    else {
        const fctx = vm.createContext({});
        // strokeFunc closes over `turn` and `last_eval`; line 0 is the best move it compares against.
        const width = (turn, lines, i) => {
            vm.runInContext(`var turn = ${JSON.stringify(turn)}; var last_eval = {lines: ${JSON.stringify(lines)}};`, fctx);
            vm.runInContext(src.slice(ss, se), fctx);
            return vm.runInContext(`strokeFunc(last_eval.lines[${i}])`, fctx);
        };
        // The reported position: best +2.10, then +0.94, then -7.32 (a 9.42 drop -- the old cutoff was 4).
        const reported = [{move: 'f3f1', score: 210}, {move: 'd3f1', score: 94}, {move: 'g1f2', score: -732}];
        const best = width('w', reported, 0), mid = width('w', reported, 1), lost = width('w', reported, 2);
        ok('the best move is the thickest arrow', best > mid, `best ${best} vs ${mid}`);
        ok('a close second is thinner than the best', mid < best && mid > 0, `${mid}`);
        ok('a line 9.42 behind is still DRAWN (was 0 -- the reported bug)', lost > 0, `${lost}`);
        ok('...and is the thinnest of the three', lost < mid, `${lost} vs ${mid}`);
        // and from black's side, where the sign flips
        const blk = [{move: 'a1a2', score: -210}, {move: 'b1b2', score: 732}];
        ok('black: a line 9.42 behind is drawn too', width('b', blk, 1) > 0);
        // a move that gets us mated (score NaN) took the same vanishing path
        const mated = [{move: 'a1a2', score: 210}, {move: 'b1b2', score: NaN, mate: -1}];
        ok('a line that gets us mated is drawn, not dropped', width('w', mated, 1) > 0);
    }
}

// ==== AGENT PANEL CHECKS (material imbalance, square heatmap, Humanize target accuracy) ====
{
    console.log('\nmaterial balance / square heatmap / target accuracy:');
    const ok = (name, cond, extra) => { if (cond) console.log('ok   ' + name);
        else { fails++; console.log('FAIL ' + name + (extra ? ' -- ' + extra : '')); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // the board's own {e4: 'wP'} map, built from a FEN the way panel-board.js fenToObj does
    const posOf = (fen) => {
        const o = {};
        fen.split(' ')[0].split('/').forEach((row, r) => {
            let f = 0;
            for (const ch of row) {
                if (/\d/.test(ch)) f += +ch;
                else { o['abcdefgh'[f] + (8 - r)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase(); f++; }
            }
        });
        return o;
    };

    // ---- A + B: the pure half, executed against the real chess.js
    const ms = psrc.indexOf('const MATERIAL_VALUE');
    const me = psrc.indexOf('let heat_memo');
    const hs = psrc.indexOf('function panel_board_rendered(');
    const he = psrc.indexOf('\n}\n', hs) + 3;
    if (ms < 0 || me < ms || hs < 0 || he < 3) { fails++; console.log('FAIL could not slice the material/heatmap block'); }
    else {
        const mctx = vm.createContext({console});
        mctx.self = mctx;
        vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), mctx);
        vm.runInContext(psrc.slice(ms, me), mctx);
        const label = (fen) => vm.runInContext(`material_label(${JSON.stringify(Object.values(posOf(fen)))})`, mctx);
        const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        ok('material: the start position is level', label(START) === 'Material =', label(START));
        ok('material: B+P against N reads +1 with both sides named',
           label('4k3/8/8/3n4/8/8/3P4/2B1K3 w - - 0 1') === 'Material +1 (B+P vs N)',
           label('4k3/8/8/3n4/8/8/3P4/2B1K3 w - - 0 1'));
        ok('material: the exchange is +2 (R vs B)',
           label('2b1k3/8/8/8/8/8/8/R3K3 w - - 0 1') === 'Material +2 (R vs B)');
        ok('material: Black a queen up is -9, one-sided detail',
           label('3qk3/8/8/8/8/8/8/4K3 w - - 0 1') === 'Material -9 (Q)');
        ok('material: equal points, different pieces still says which',
           label('2n1k3/8/8/8/8/8/8/2B1K3 w - - 0 1') === 'Material = (B vs N)');
        ok('material: multiples are counted, not repeated',
           label('4k3/8/8/8/8/8/PP6/4K3 w - - 0 1') === 'Material +2 (2P)');

        const ctl = (fen) => vm.runInContext(`square_control(${JSON.stringify(posOf(fen))})`, mctx);
        const s = ctl(START);
        ok('heatmap: start position, e3 is White x2 and e6 Black x2', s.e3 === 2 && s.e6 === -2, JSON.stringify({e3: s.e3, e6: s.e6}));
        ok('heatmap: start position, e4/e5 are nobody\'s', !('e4' in s) && !('e5' in s));
        const r = ctl('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
        ok('heatmap: rook + king both count on d1, a king alone on d8',
           r.d1 === 2 && r.d8 === -1 && r.a8 === 1, JSON.stringify({d1: r.d1, d8: r.d8, a8: r.a8}));
        // e5 is hit by the d4 pawn and the f3 knight, and defended by the d6 pawn and c6 knight
        const c = ctl('4k3/8/2np4/8/3P4/5N2/8/4K3 w - - 0 1');
        ok('heatmap: an evenly contested square stays untinted', !('e5' in c), JSON.stringify(c.e5));
        const tint = (d) => vm.runInContext(`heat_tint(${d})`, mctx);
        ok('heatmap tint: none at 0, capped at 3, colour by side',
           tint(0) === null && tint(5) === tint(3) && tint(1) !== tint(3) && tint(2) !== tint(-2));

        // panel_board_rendered: fake DOM, and a counting square_control -- the memo is the claim
        // that a re-render of the SAME position (a click picking up a piece) costs no chess.js
        vm.runInContext(psrc.slice(me, he), mctx);
        vm.runInContext(`var calls = 0; const real_sc = square_control;
            square_control = (p) => { calls++; return real_sc(p); };
            var mat = {hidden: true, textContent: ''};
            var PANEL_ROOT = {getElementById: (id) => id === 'material' ? mat : null};
            var config = {material_balance: false, square_heatmap: false};
            function fakeBoard() {
                const sq = [];
                for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++)
                    sq.push({classList: ['square-55d63', 'white-1e1d7', 'square-' + f + r], style: {}, id: f + r});
                return {sq, querySelectorAll: () => sq};
            }`, mctx);
        const run = (code) => vm.runInContext(code, mctx);
        run(`var p1 = ${JSON.stringify(posOf(START))}; var b = fakeBoard(); panel_board_rendered(p1, b);`);
        ok('both off: row hidden, no tint, no chess.js',
           run('mat.hidden') === true && run('b.sq.every(s => !s.style.backgroundImage)') && run('calls') === 0);
        run(`config.material_balance = true; config.square_heatmap = true; b = fakeBoard(); panel_board_rendered(p1, b);`);
        ok('material on: row shown with the label', run('mat.hidden') === false && run('mat.textContent') === 'Material =');
        ok('heatmap on: e3 tinted, e4 left alone',
           /linear-gradient/.test(run(`b.sq.find(s => s.id === 'e3').style.backgroundImage`))
           && !run(`b.sq.find(s => s.id === 'e4').style.backgroundImage`));
        run(`b = fakeBoard(); panel_board_rendered(p1, b); b = fakeBoard(); panel_board_rendered(p1, b);`);
        ok('same position re-rendered: tint re-applied, square_control NOT re-run',
           run('calls') === 1 && /linear-gradient/.test(run(`b.sq.find(s => s.id === 'e3').style.backgroundImage`)),
           'calls ' + run('calls'));
        run(`panel_board_rendered(${JSON.stringify(posOf('4k3/8/8/8/8/8/8/R3K3 w - - 0 1'))}, fakeBoard());`);
        ok('a new position recomputes once', run('calls') === 2);
    }

    // ---- wiring: painted from the board's render hook, never from the per-frame path
    const dm = psrc.indexOf('function draw_moves()');
    const dmEnd = psrc.indexOf('\n}\n', dm);
    ok('draw_moves (every engine frame) never touches the heatmap or the material line',
       dm > 0 && !/panel_board_rendered|square_control|material_label/.test(psrc.slice(dm, dmEnd)));
    ok('the panel board is built with onRender: panel_board_rendered',
       /MephistoBoard\('board', \{[\s\S]*?onRender: panel_board_rendered[\s\S]*?\}\);/.test(psrc));
    const pb = fs.readFileSync(ROOT + '/src/scripts/panel-board.js', 'utf8');
    ok('panel-board.js calls onRender after the board is in the DOM (8x8 renderer)',
       /host\.appendChild\(board\);\s*\n\s*if \(onRender\) \{ try \{ onRender\(pos, board\)/.test(pb));
    ok('both toggles are live config keys and re-render the board on change',
       /'material_balance', 'square_heatmap',/.test(psrc)
       && /key === 'material_balance' \|\| key === 'square_heatmap'\) \{ try \{ board\.resize\(\)/.test(psrc));
    const css = fs.readFileSync(ROOT + '/src/popup/popup.css', 'utf8');
    ok('#material is one clipped line and costs no height while hidden',
       /#material \{[^}]*height: 20px;[^}]*white-space: nowrap;/.test(css)
       && /#material\[hidden\], body\.mephisto-compact #material \{ display: none; \}/.test(css)
       && /<div id="material" hidden><\/div>/.test(fs.readFileSync(ROOT + '/src/popup/popup.html', 'utf8')));

    // ---- C: the controller, executed
    const hs2 = psrc.indexOf('const HUMANIZE_ORDER');
    const he2 = psrc.indexOf("// Our side's running accuracy");
    const fnSrc = (name) => { const i = psrc.indexOf(`function ${name}(`); return i < 0 ? '' : psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    if (hs2 < 0 || he2 < hs2 || !fnSrc('win_percent') || !fnSrc('accuracy_from_drop')) {
        fails++; console.log('FAIL could not slice the humanize target block');
    } else {
        const hctx = vm.createContext({console});
        vm.runInContext('var store = {}; var MephistoConfig = {get: (k) => store[k]};', hctx);
        vm.runInContext(fnSrc('win_percent') + fnSrc('accuracy_from_drop') + psrc.slice(hs2, he2), hctx);
        const H = (code) => vm.runInContext(code, hctx);
        const set = (k, v) => H(`store[${JSON.stringify(k)}] = ${JSON.stringify(JSON.stringify(v))}`);
        const target = (v) => { set('humanize_target_acc', v); return H('humanize_target()'); };
        ok('target: 0 / 49 / 100 / junk are off, 50 and 99 are kept',
           target(0) === 0 && target(49) === 0 && target(100) === 0 && target('x') === 0
           && target(50) === 50 && target(99) === 99);
        const need = (acc, n, t) => H(`humanize_target_need({acc: ${acc}, n: ${n}}, ${t})`);
        ok('need: on target asks for the target; above it asks for less, more so the longer the game',
           need(85, 10, 85) === 85 && need(95, 10, 85) === 75 && need(95, 20, 85) === 65 && need(75, 10, 85) === 95);
        ok('need: clamped to 0..100', need(100, 40, 60) === 0 && need(50, 40, 99) === 100);
        // an equal position: best 0, then 30 / 100 / 200 / 350 / 550 cp worse
        const C = [0, -30, -100, -200, -350, -550].map((cp, i) => ({move: 'm' + i, cp}));
        const accOf = (cp, best = 0) => H(`accuracy_from_drop(win_percent(${best}) - win_percent(${cp}))`);
        const pick = (run, t, maxLoss = 600, cands = C, best = 0) =>
            H(`humanize_target_pick(${JSON.stringify(cands)}, ${best}, ${JSON.stringify(run)}, ${t}, ${maxLoss}, () => 0)`);
        ok('pick: no target or no reading -> null (the mix decides)',
           pick({acc: 95, n: 10}, 0) === null && pick(null, 85) === null);
        const p75 = pick({acc: 75, n: 10}, 75);
        const nearest = C.reduce((a, c) => Math.abs(accOf(c.cp) - 75) < Math.abs(accOf(a.cp) - 75) ? c : a);
        ok(`pick: plays the move whose OWN accuracy is nearest the need (75 -> ${p75?.move}, ${accOf(p75?.cp).toFixed(0)}%)`,
           p75 && Math.abs(accOf(p75.cp) - accOf(nearest.cp)) <= 3);
        ok('pick: well under target it plays the best move', pick({acc: 70, n: 20}, 90).cp === 0);
        ok('pick: never past the band cap -- a need of 0 with a 120cp cap takes the 100cp move',
           pick({acc: 100, n: 40}, 60, 120).cp === -100);
        ok('pick: never below the floor while the game is alive -- the 350/550 moves are out',
           pick({acc: 100, n: 40}, 50).cp >= H('HUMANIZE_TARGET_FLOOR_CP'));
        const lost = [-700, -800, -1000, -1300].map((cp, i) => ({move: 'l' + i, cp}));
        ok('pick: in a lost game (best <= -600) the floor lifts, the cap still holds',
           pick({acc: 100, n: 40}, 50, 377, lost, -700).cp === -1000);
        ok('max loss: the deepest band with a share; a decided game drops the blunder band; a band at 0 is out',
           H('humanize_max_loss(humanize_rates(), false)') === 600 && H('humanize_max_loss(humanize_rates(), true)') === 377
           && (set('humanize_mistake', 0), set('humanize_blunder', 0), H('humanize_max_loss(humanize_rates(), false)')) === 75
           && (set('humanize_second', 0), set('humanize_third', 0), H('humanize_max_loss(humanize_rates(), false)')) === 0);
        ok('band of a loss: 0 -> top, 20 -> second, 300 -> mistake, 900 -> blunder',
           H('humanize_band_of(0)') === 'top' && H('humanize_band_of(20)') === 'second'
           && H('humanize_band_of(300)') === 'mistake' && H('humanize_band_of(900)') === 'blunder');
    }
    ok('with a target reading the pick aims by accuracy; without one the roll uses the raw sliders',
       /humanize_target_pick\(all\.filter\(c => c\.line === bestLine \|\| \(safe\(c\.line\) && human\(c\)\)\),\s*bestCp, run, humanize_target\(\), maxLoss\)/.test(psrc)
       && /category_for_roll\(r, humanize_rates_now\(fen\)\)/.test(psrc)
       && /const rates = humanize_rates\(\);\s*if \(!humanize_flag\('humanize_tc_scale', false\)\) return rates;/.test(psrc) && !/humanize_mix|humanize_steer/.test(psrc));
    ok('the eval history records while a target is set (the controller reads it)',
       /!\(config\.humanize && humanize_target\(\)\)\)/.test(psrc));

    // ---- settings rows + every new key in all 14 locales
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    ok('settings: three rows, registered, default off',
       /id="material_balance_checkbox"/.test(gh) && /id="square_heatmap_checkbox"/.test(gh)
       && /id="humanize_target_acc_input"/.test(gh)
       && /registerFormElement\('material_balance', [^)]*'checkbox', false\)/.test(gj)
       && /registerFormElement\('square_heatmap', [^)]*'checkbox', false\)/.test(gj)
       && /registerFormElement\('humanize_target_acc', [^)]*'input', 0\)/.test(gj));
    const KEYS = ['panel.material', 'panel.material_vs', 'set.material_balance', 'set.tip.material_balance',
                  'set.square_heatmap', 'set.tip.square_heatmap', 'set.humanize_target_acc', 'set.tip.humanize_target_acc'];
    const locDir = ROOT + '/src/i18n/locales/';
    const missing = [];
    for (const f of fs.readdirSync(locDir).filter(f => f.endsWith('.json'))) {
        let o = {};
        try { o = JSON.parse(fs.readFileSync(locDir + f, 'utf8')); } catch (e) { missing.push(f + ': unparseable'); continue; }
        for (const k of KEYS) if (typeof o[k] !== 'string' || !o[k]) missing.push(f + ':' + k);
    }
    ok(`i18n: the ${KEYS.length} new keys are in all 14 locales`,
       fs.readdirSync(locDir).filter(f => f.endsWith('.json')).length === 14 && !missing.length, missing.join(', '));
}
// ==== END AGENT PANEL CHECKS ====

// ==== AGENT HOTKEY CHECKS (shortcut cheat sheet, hotkey macros) ====
// The REAL config-store.js (whole file, stubbed chrome.storage), the REAL content-script keydown
// listener and hotkeyString (sliced), and the REAL cheat-sheet functions and do_hotkey (sliced) run
// against a small fake DOM. Nothing here is retyped from the source.
{
    console.log('\nhotkeys: cheat sheet + macros:');
    const ok = (name, cond, extra) => { if (cond) console.log('ok   ' + name);
        else { fails++; console.log('FAIL ' + name + (extra ? ' -- ' + extra : '')); } };
    const hctx = {console, location: {protocol: 'https:'}, navigator: {},
        chrome: {storage: {local: {get: async () => ({}), set() {}, remove() {}},
                           onChanged: {addListener() {}}}}};
    hctx.self = hctx;
    vm.createContext(hctx);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/config-store.js', 'utf8'), hctx);
    const C = hctx.MephistoConfig;
    const reset = () => { C.remove('hotkeys'); C.remove('hotkey_macros'); };

    // --- config-store: defaults, labels, canonical key strings
    ok('the cheat sheet action defaults to ?', C.HOTKEY_DEFAULTS.shortcuts === '?');
    const unlabeled = Object.keys(C.HOTKEY_DEFAULTS).filter(a => !C.HOTKEY_LABELS[a]);
    ok('every default action has a label (settings rows + cheat sheet)', !unlabeled.length, unlabeled.join(','));
    const ks = (o) => C.hotkeyString({ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o});
    ok('? typed with Shift is stored and compared as "?"', ks({key: '?', shiftKey: true}) === '?', ks({key: '?', shiftKey: true}));
    ok('Shift still counts for letters', ks({key: 'A', shiftKey: true}) === 'Shift+a');
    ok('Shift still counts for Space', ks({key: ' ', shiftKey: true}) === 'Shift+ ');
    ok('Ctrl+Shift+? keeps Ctrl, drops the implied Shift', ks({key: '?', ctrlKey: true, shiftKey: true}) === 'Ctrl+?');
    reset();
    C.set('hotkeys', JSON.stringify({shortcuts: 'Shift+?', autoplay: 'Shift+a'}));
    ok('a saved "Shift+?" binding is read back canonical', C.hotkeys().shortcuts === '?' && C.hotkeys().autoplay === 'Shift+a');

    // --- config-store: macro sanitizing + clash owner
    reset();
    C.set('hotkey_macros', JSON.stringify([
        {key: 'Shift+!', steps: ['autoplay', 'macro:0', 'bogus', 'humanize', 'premove', 'premove', 'premove',
                                 'premove', 'premove', 'premove', 'premove']},
        null, {key: 'j'}, 'junk']));
    const ms = C.hotkeyMacros();
    ok('malformed macros are dropped on read', ms.length === 1, JSON.stringify(ms));
    ok('a macro step must be a real action (no macro inside a macro)',
        ms[0] && !ms[0].steps.includes('macro:0') && !ms[0].steps.includes('bogus'), JSON.stringify(ms[0]));
    ok('a macro holds at most 8 steps', ms[0] && ms[0].steps.length === 8, ms[0] && ms[0].steps.length);
    ok('a macro key is canonical too', ms[0] && ms[0].key === '!');
    C.set('hotkey_macros', 'not json');
    ok('corrupt macro storage reads as no macros', C.hotkeyMacros().length === 0);
    reset();
    C.set('hotkey_macros', JSON.stringify([{key: 'j', steps: ['autoplay']}]));
    ok('owner of a bound action key is that action', C.hotkeyOwner('a') === 'autoplay');
    ok('owner of a macro key is that macro', C.hotkeyOwner('j') === 'macro:0');
    ok('a macro re-pressing its own key is not a clash', C.hotkeyOwner('j', 0) === null);
    ok('a free key has no owner', C.hotkeyOwner('Alt+j') === null);

    // --- config-store: custom toggles (Custom 1/2 flip one on/off setting each)
    ok('the two custom toggles exist, unbound, and an empty key has no owner',
       C.HOTKEY_CUSTOM.length === 2 && C.HOTKEY_CUSTOM.every(a => C.HOTKEY_DEFAULTS[a] === '') && C.hotkeyOwner('') === null);
    C.remove('hotkey_custom');
    ok('no saved custom toggles read as two unassigned slots', JSON.stringify(C.hotkeyCustom().map(c => c.setting)) === '["",""]');
    C.set('hotkey_custom', JSON.stringify([{setting: 'background_play', label: 'Background Play', def: false},
                                           {setting: 'hotkeys', label: 'x'}, {setting: 'extra'}]));
    const cu = C.hotkeyCustom();
    ok('custom toggles are sanitized on read: a real setting kept, the hotkey stores themselves refused, extras dropped',
       cu.length === 2 && cu[0].setting === 'background_play' && cu[0].label === 'Background Play' && cu[0].def === false
       && cu[1].setting === '', JSON.stringify(cu));
    C.set('hotkey_custom', JSON.stringify([{setting: 'Bad Key!'}, {setting: 'humanize_guards', def: true}]));
    ok('...a malformed setting id is refused, a default of true is kept', C.hotkeyCustom()[0].setting === ''
       && C.hotkeyCustom()[1].def === true && C.hotkeyCustom()[1].label === 'humanize_guards');
    C.set('hotkey_custom', 'not json');
    ok('corrupt custom-toggle storage reads as unassigned', C.hotkeyCustom().every(c => c.setting === ''));
    C.remove('hotkey_custom');

    // --- the panel's custom_hotkey, executed against stubs
    {
        const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
        const fnSrc = (name) => { const i = psrc.indexOf(`function ${name}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
        const st = {}, said = [], reloads = [];
        const box = {checked: false, fired: 0, dispatchEvent() { this.fired++; }};
        const pc = vm.createContext({console: {log() {}}, Event: function () {}, said, reloads, st,
            MephistoConfig: {get: (k) => st[k] ?? null, set: (k, v) => { st[k] = v; }, hotkeyCustom: () => pc.slots},
            HOTKEY_TOGGLES: {autoplay: 'qs_autoplay'}, LIVE_CONFIG_KEYS: ['autoplay', 'background_play'],
            PANEL_ROOT: {getElementById: (id) => id === 'qs_autoplay' ? box : null},
            i18n: (k, d, v) => v ? d.replace('{name}', v.name).replace('{state}', v.state) : d,
            set_idle_reason: (t) => said.push(t), panel_reload: () => reloads.push(1), setTimeout: (f) => f()});
        vm.runInContext(fnSrc('custom_hotkey_live') + fnSrc('custom_hotkey'), pc);
        const run = (slots, i) => { pc.slots = slots; return vm.runInContext(`custom_hotkey(${i})`, pc); };
        ok('custom hotkey: an unassigned slot does nothing and leaves the key to the site', run([{setting: ''}], 0) === false);
        ok('...a setting with a quick-settings checkbox flips that checkbox through its change event',
           run([{setting: 'autoplay', label: 'Autoplay', def: false}], 0) === true && box.checked === true && box.fired === 1
           && !('autoplay' in st) && /Autoplay: On/.test(said.at(-1)));
        ok('...a live setting never saved flips from its default and is written, no reopen',
           run([{setting: 'background_play', label: 'Background Play', def: false}], 0) === true
           && st.background_play === 'true' && reloads.length === 0);
        ok('...a humanize_* flag defaulting on goes off on the first press (read fresh, no reopen)',
           run([{setting: 'humanize_guards', label: 'Guards', def: true}], 0) === true && st.humanize_guards === 'false' && reloads.length === 0);
        st.background_play = 'true';
        ok('...a saved value wins over the default', run([{setting: 'background_play', label: 'B', def: false}], 0) === true
           && st.background_play === 'false');
        ok('...a setting the panel only reads at open is written AND the panel reopens to apply it',
           run([{setting: 'coordinates', label: 'Coordinates', def: false}], 0) === true && st.coordinates === 'true'
           && reloads.length === 1 && /reopening/.test(said.at(-1)));
        ok('...wired: do_hotkey routes Custom 1/2 here, and the cheat sheet names the setting',
           /if \(MephistoConfig\.HOTKEY_CUSTOM\.includes\(action\)\) return custom_hotkey\(MephistoConfig\.HOTKEY_CUSTOM\.indexOf\(action\)\);/.test(psrc)
           && /labels\[MephistoConfig\.HOTKEY_CUSTOM\[i\]\] = i18n\('panel\.shortcuts_custom'/.test(psrc));
    }

    // --- content-script listener: macros through the same MephistoPanel.hotkey as single keys
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const hs = cs.indexOf('function hotkeyString(e) {');
    const ls = cs.indexOf("document.addEventListener('keydown', (e) => {\n    if (!self.MephistoPanel?.isBooted?.()) return;");
    const le = cs.indexOf('\n}, true);', ls) + 10;
    if (hs < 0 || ls < 0 || le < 10) { fails++; console.log('FAIL could not slice the content-script hotkey listener'); }
    else {
        let handler = null, calls = [], booted = true;
        hctx.document = {addEventListener: (t, f) => { if (t === 'keydown') handler = f; }};
        hctx.overlayHost = null; hctx.overlayRoot = null;
        hctx.MephistoPanel = {isBooted: () => booted, hotkey: (a) => {
            calls.push(a); if (a === 'panic') booted = false; return a !== 'manual_play'; }};
        vm.runInContext(cs.slice(hs, cs.indexOf('\n}\n', hs) + 3), hctx);
        vm.runInContext(cs.slice(ls, le), hctx);
        const press = (o) => {
            calls = []; booted = true;
            const e = {key: 'q', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
                target: {tagName: 'DIV'}, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...o};
            handler(e);
            return e;
        };
        reset();
        C.set('hotkey_macros', JSON.stringify([
            {key: 'q', steps: ['autoplay', 'humanize']},
            {key: 'j', steps: ['autoplay', 'panic', 'humanize']},
            {key: 'Alt+m', steps: ['manual_play']}]));
        let e = press({key: 'q'});
        ok('a macro key runs its steps in order', JSON.stringify(calls) === '["autoplay","humanize"]', JSON.stringify(calls));
        ok('...and the key is swallowed', e.prevented);
        press({key: 'j'});
        ok('a macro stops once a step takes the panel away (panic)', JSON.stringify(calls) === '["autoplay","panic"]', JSON.stringify(calls));
        e = press({key: 'm', altKey: true});
        ok('a macro whose steps all did nothing leaves the key to the site', calls.length === 1 && !e.prevented);
        press({key: 'q', target: {tagName: 'INPUT'}});
        ok('a macro key typed into a field does nothing', calls.length === 0);
        e = press({key: '?', shiftKey: true});
        ok('Shift+? on the page opens the cheat sheet action', JSON.stringify(calls) === '["shortcuts"]' && e.prevented, JSON.stringify(calls));
    }

    // --- popup.js: cheat sheet rows (live bindings) + the sheet itself + do_hotkey routing
    const pS = src.indexOf('function hotkey_pretty(k) {');
    const rS = src.indexOf('function shortcut_sheet_rows(');
    const dS = src.indexOf('function do_hotkey(action) {');
    if (pS < 0 || rS < 0 || dS < 0) { fails++; console.log('FAIL could not slice the cheat sheet'); }
    else {
        const byId = (n, id) => n.id === id ? n : n.children.reduce((f, c) => f || byId(c, id), null);
        let body;
        const mk = () => ({children: [], style: {}, parent: null, id: '',
            append(...c) { c.forEach(x => this.appendChild(x)); },
            appendChild(c) { c.parent = this; this.children.push(c); },
            addEventListener() {}, remove() { if (this.parent) { this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; } },
            get isConnected() { let p = this; while (p.parent) p = p.parent; return p === body; }});
        body = mk();
        const docL = new Set();
        hctx.document = {createElement: mk, addEventListener: (t, f) => docL.add(f), removeEventListener: (t, f) => docL.delete(f)};
        hctx.PANEL_ROOT = {getElementById: (id) => byId(body, id)};
        hctx.panel_body = () => body;
        vm.runInContext(src.slice(pS, src.indexOf('\n}\n', pS) + 3), hctx);
        vm.runInContext(src.slice(rS, dS), hctx);
        reset();
        C.set('hotkeys', JSON.stringify({autoplay: 'Alt+q', humanize: ''}));
        C.set('hotkey_macros', JSON.stringify([{key: 'j', steps: ['autoplay', 'humanize']}]));
        const rows = vm.runInContext('shortcut_sheet_rows(MephistoConfig.hotkeys(), MephistoConfig.hotkeyMacros(), MephistoConfig.HOTKEY_LABELS)', hctx);
        const row = (l) => rows.find(r => r[0] === l);
        ok('the sheet shows a REBOUND key, read live', row('Toggle Autoplay')?.[1] === 'Alt+Q', JSON.stringify(row('Toggle Autoplay')));
        ok('a cleared key shows as "-", the row stays', row('Toggle Humanize')?.[1] === '-');
        ok('the sheet lists its own key', row('Show shortcuts')?.[1] === '?');
        ok('every action has a row, plus one per macro', rows.length === Object.keys(C.HOTKEY_LABELS).length + 1, rows.length);
        ok('a macro row names its steps and key',
            rows.some(r => r[0] === 'Macro: Toggle Autoplay > Toggle Humanize' && r[1] === 'J'), JSON.stringify(rows.slice(-1)));
        const extra = vm.runInContext('shortcut_sheet_rows({zz_new: "k"}, [], {})', hctx);
        ok('an action with no label still shows under its id', extra[0]?.[0] === 'zz_new' && extra[0]?.[1] === 'K');

        const open = () => !!byId(body, 'mp-shortcuts');
        ok('the key opens the sheet', vm.runInContext('toggle_shortcut_sheet()', hctx) === true && open() && docL.size === 1);
        const sheet = byId(body, 'mp-shortcuts');
        ok('the sheet uses theme colours with light fallbacks (readable in both themes)',
            /background:var\(--mp-bg,#fff\)/.test(sheet.style.cssText) && /color:var\(--mp-text,#14171a\)/.test(sheet.style.cssText));
        const esc = [...docL][0];
        const ev = (key) => ({key, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}});
        const other = ev('a'); esc(other);
        ok('another key leaves it open and is not swallowed', open() && !other.prevented);
        const e1 = ev('Escape'); esc(e1);
        ok('Esc closes it, is swallowed, and its listener goes', !open() && e1.prevented && docL.size === 0);
        vm.runInContext('toggle_shortcut_sheet()', hctx);
        vm.runInContext('toggle_shortcut_sheet()', hctx);
        ok('the same key closes it again', !open() && docL.size === 0);
        vm.runInContext('toggle_shortcut_sheet()', hctx);
        byId(body, 'mp-shortcuts').remove(); // the panel torn down under it (panic)
        const stale = ev('Escape'); [...docL][0](stale);
        ok('a sheet removed with the panel lets its listener go without eating Esc', docL.size === 0 && !stale.prevented);

        // do_hotkey itself routes the action (sliced; everything else it could call is a stub)
        vm.runInContext('var panic = () => "panic"; var manual_play = () => "mp"; var HOTKEY_TOGGLES = {};', hctx);
        vm.runInContext(src.slice(dS, src.indexOf('\n}\n', dS) + 3), hctx);
        vm.runInContext('toggle_shortcut_sheet = () => "sheet";', hctx);
        ok('do_hotkey("shortcuts") opens the cheat sheet', vm.runInContext('do_hotkey("shortcuts")', hctx) === 'sheet');
    }

    // --- settings page: the macro UI exists, carries a tooltip, and every new string is in all 14 locales
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    ok('Hotkeys section has the macro list, add button, message line and a tooltip',
        ['id="hotkey_macros"', 'id="hotkey_macro_add_btn"', 'id="hotkey_macro_msg"', 'data-i18n-tip="set.tip.hotkey_macros"'].every(s => gh.includes(s)));
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    ok('Show shortcuts is a row in the Hotkeys settings list', /const ORDER = \[[^\]]*'shortcuts'/.test(gj));
    const NEW_KEYS = ['set.hotkey_macros', 'set.tip.hotkey_macros', 'set.add_macro', 'set.note.hotkey_macros', 'set.macro_n',
        'set.macro_add_step', 'set.macro_remove_step', 'set.macro_remove', 'set.macro_key_clash', 'set.macro_reset_cleared',
        'panel.shortcuts_title', 'panel.shortcuts_hint', 'panel.shortcuts_macro', 'panel.shortcuts_click'];
    const locDir = ROOT + '/src/i18n/locales/';
    const locs = fs.readdirSync(locDir).filter(f => f.endsWith('.json'));
    const en = JSON.parse(fs.readFileSync(locDir + 'en.json', 'utf8'));
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
    const bad = [];
    for (const f of locs) {
        const o = JSON.parse(fs.readFileSync(locDir + f, 'utf8'));
        for (const k of NEW_KEYS) if (!o[k] || ph(o[k]) !== ph(en[k])) bad.push(f + ':' + k);
    }
    ok(`hotkey strings present with matching placeholders in all ${locs.length} locales`, locs.length === 14 && !bad.length, bad.join(' '));
    reset();
}
// A macro step starts UNCHOSEN (lead's fix after headless testing): it used to default to ORDER[0],
// "Play move (Manual Mode)", so a half-configured macro played a move. An empty step must be dropped
// by the sanitizer, so it can never fire.
{
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const ok2 = (n, c) => { if (c) console.log('ok   ' + n); else { fails++; console.log('FAIL ' + n); } };
    ok2('new macro starts with an unchosen step', /macros\.push\(\{key: '', steps: \[''\]\}\)/.test(gj));
    ok2('"+ Step" adds an unchosen step', /m\.steps\.push\(''\)/.test(gj));
    ok2('no step defaults to ORDER[0] any more', !/steps: \[ORDER\[0\]\]|m\.steps\.push\(ORDER\[0\]\)/.test(gj));
    // same stubbed context the hotkey block above uses for the real config-store.js
    const sctx = {console, location: {protocol: 'https:'}, navigator: {},
        chrome: {storage: {local: {get: async () => ({}), set() {}, remove() {}}, onChanged: {addListener() {}}}}};
    sctx.self = sctx;
    vm.createContext(sctx);
    try {
        vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/config-store.js', 'utf8'), sctx);
        const MC = sctx.MephistoConfig;
        MC.set('hotkey_macros', JSON.stringify([{key: 'j', steps: ['', 'eval_bar', '']}]));
        const got = MC.hotkeyMacros();
        ok2('sanitizer drops unchosen steps, keeps the chosen one', got.length === 1 && got[0].steps.length === 1 && got[0].steps[0] === 'eval_bar');
    } catch (e) { fails++; console.log('FAIL sanitizer check could not run: ' + String(e).slice(0, 80)); }
}
// ==== END AGENT HOTKEY CHECKS ====

// ==== AGENT REVIEW CHECKS (coach grade shown, NAG export, lichess study export, share card) ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    // the WHOLE core, against the real chess.js: annotatedPgn writes, parsePgn (the extension's only
    // PGN reader -- lib/chess.js has none) reads it back, chess.js replays every move
    const c = {console: {log() {}}, URLSearchParams};   // the page has it; a bare vm context does not
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const Core = c.MephistoReviewCore, Chess = c.Chess, MATE = Core.MATE_CP;

    // a real opening with captures and both castles, graded with every one of the eleven classes
    const sans = ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'Nf6', 'Nf3', 'Bf5', 'Bc4', 'e6', 'O-O',
                  'Nbd7', 'Bd2', 'O-O-O', 'Qe2', 'Bxc2'];
    const klasses = ['book', 'book', 'best', 'excellent', 'good', 'inaccuracy', 'great', 'forced', 'mistake',
                     'miss', 'brilliant', 'blunder', 'best', 'good', 'excellent', 'best', 'mistake', 'blunder'];
    const cps = [30, 25, 40, -10, 20, 90, 95, 100, 60, 220, MATE - 3, -(MATE - 2), 0, 12, 7, -5, 80, -300];
    const chess = new Chess('chess');
    for (const s of sans) if (!chess.move(s)) throw new Error('bad fixture move ' + s);
    const moves = sans.map((san, i) => ({san, klass: klasses[i], cp: cps[i], clk: 180 - i * 2.5,
        commentary: i === 9 ? 'A {braced} note}' : i === 3 ? 'Takes back.' : ''}));
    const tags = {Event: 'Rated "blitz" \\ game', White: 'Alice', Black: 'Bob', Result: '0-1', Date: '2026.09.01'};
    const pgn = Core.annotatedPgn({tags, result: '0-1', moves});
    const back = Core.parsePgn(pgn);
    ok('annotated PGN: parsePgn reads exactly one game back', back.length === 1, back.length);
    const g = back[0] || {moves: [], tags: {}};
    ok('annotated PGN: every move survives, in order', JSON.stringify(g.moves.map(m => m.san)) === JSON.stringify(sans),
       g.moves.map(m => m.san));
    const replay = new Chess('chess');
    ok('annotated PGN: chess.js replays every move read back as legal', g.moves.every(m => !!replay.move(m.san)));
    ok('annotated PGN: tags round-trip, quote and backslash escaped',
       g.tags.Event === tags.Event && g.tags.White === 'Alice' && g.result === '0-1', g.tags.Event);
    const wantEval = cps.map(cp => Core.isMateScore(cp) ? (cp > 0 ? '#3' : '#-2') : (cp / 100).toFixed(2));
    ok('annotated PGN: [%eval] in lichess format on every move (pawns, #N, #-N)',
       JSON.stringify(g.moves.map(m => m.eval)) === JSON.stringify(wantEval), g.moves.map(m => m.eval));
    ok('annotated PGN: [%clk] round-trips', g.moves.every((m, i) => Math.abs(m.clk - moves[i].clk) < 0.05),
       g.moves.map(m => m.clk));
    ok('annotated PGN: coach sentence kept, a brace in it cannot end the comment early',
       g.moves[9].comment === 'A (braced) note)' && g.moves[3].comment === 'Takes back.' && g.moves[0].comment === '',
       [g.moves[9].comment, g.moves[3].comment]);
    // the glyphs, read straight off the movetext: SAN followed by its NAG
    const body = pgn.slice(pgn.indexOf('\n\n') + 2);
    const nagOf = (i) => { const m = new RegExp(`\\b${sans[i].replace(/[+]/g, '\\+')} (\\$\\d+)`).exec(body.split(/\{[^}]*\}/).join(' ')); return m ? m[1] : null; };
    const WANT = {brilliant: '$3', great: '$1', inaccuracy: '$6', mistake: '$2', miss: '$2', blunder: '$4'};
    ok('annotated PGN: NAG per class ($3 !!, $1 !, $6 ?!, $2 ?, $4 ??; none on best/excellent/good/book/forced)',
       klasses.every((k, i) => nagOf(i) === (WANT[k] || null)), klasses.map((k, i) => k + ':' + nagOf(i)));
    // strict grammar: every movetext token is a number, a SAN chess.js accepts, a NAG, a comment or the result
    const toks = body.replace(/\{[^}]*\}/g, ' {} ').trim().split(/\s+/);
    const g2 = new Chess('chess');
    const bad = toks.filter(t => !(/^\d+\.(\.\.)?$/.test(t) || /^\$\d+$/.test(t) || t === '{}' || t === '0-1'
                                   || g2.move(t)));
    ok('annotated PGN: movetext is only numbers, legal SAN, NAGs, comments and the result', !bad.length, bad);
    ok('annotated PGN: braces balance and no line runs past 80 columns',
       (pgn.match(/\{/g) || []).length === (pgn.match(/\}/g) || []).length && pgn.split('\n').every(l => l.length <= 80));
    ok('annotated PGN: black\'s move after a comment carries its own "N..." number', /\}\s+1\.\.\.\s+d5\s/.test(body) && /\}\s+2\.\.\.\s+Qxd5\s/.test(body), body.slice(0, 120));
    // a set-up position with black to move numbers from the FEN
    const fen = 'r3k3/8/8/8/8/8/8/4K2R b Kq - 0 30';
    const p2 = Core.annotatedPgn({tags: {SetUp: '1', FEN: fen}, startFen: fen, result: '*',
                                  moves: [{san: 'O-O-O', klass: 'best'}, {san: 'O-O', klass: 'good'}]});
    const r2 = Core.parsePgn(p2)[0];
    const c2 = new Chess('chess', fen);
    ok('annotated PGN: a FEN start with black to move opens "30... O-O-O" and replays',
       /\n30\.\.\. O-O-O 31\. O-O \*/.test(p2) && r2 && r2.moves.every(m => !!c2.move(m.san)), p2);
    ok('annotated PGN: mate-in-0 writes no eval rather than "#0"',
       !/%eval #-?0\b/.test(Core.annotatedPgn({tags: {}, moves: [{san: 'e4', klass: 'best', cp: MATE}]})));

    // the lichess requests, exactly as sent
    const imp = Core.lichessRequest('import', 'PGN', {token: 'lip_secret'});
    const impHeaders = JSON.stringify(imp.init.headers);
    ok('lichess: the anonymous import goes to /api/import and never carries the token',
       imp.url === 'https://lichess.org/api/import' && imp.init.method === 'POST' && !/Authorization|lip_secret/.test(impHeaders)
       && imp.init.body.get('pgn') === 'PGN' && !imp.init.body.has('token'), impHeaders);
    const st = Core.lichessRequest('study', 'PGN', {studyId: 'AbCd1234', token: 'lip_x', name: 'N'.repeat(140)});
    ok('lichess: the study import goes to /api/study/{id}/import-pgn with the Bearer token and a <=100-char name',
       st.url === 'https://lichess.org/api/study/AbCd1234/import-pgn' && st.init.headers.Authorization === 'Bearer lip_x'
       && st.init.body.get('pgn') === 'PGN' && st.init.body.get('name').length === 100, st.url);
    const ids = ['https://lichess.org/study/AbCd1234', 'lichess.org/study/AbCd1234/XyZw9876', 'AbCd1234',
                 'https://lichess.org/study/AbCd1234?x=1', 'https://evil.example/study/AbCd1234', 'https://lichess.org/study/short', ''];
    ok('lichess: a study URL or bare id gives the id; another host or a short id gives nothing',
       JSON.stringify(ids.map(Core.lichessStudyId)) === JSON.stringify(['AbCd1234', 'AbCd1234', 'AbCd1234', 'AbCd1234', null, null, null]),
       ids.map(Core.lichessStudyId));
    ok('lichess: only a lichess.org link from the answer is ever opened',
       Core.lichessResultUrl('import', {url: 'https://lichess.org/AbCdEfGh'}) === 'https://lichess.org/AbCdEfGh'
       && Core.lichessResultUrl('import', {url: 'https://evil.example/x'}) === null
       && Core.lichessResultUrl('import', {url: 'https://lichess.org.evil.example/x'}) === null
       && Core.lichessResultUrl('study', {chapters: [{id: 'Ch4pter1'}]}, 'AbCd1234') === 'https://lichess.org/study/AbCd1234/Ch4pter1');
    // the contract moved from an English sentence to a registry code the page translates; the sentences
    // themselves are pinned by their registry entries below
    const li = (st, kind, body) => Core.lichessFailure(st, kind, body);
    const liReg = vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8') + ';self.MephistoI18n.ERRORS', vm.createContext({self: {}}));
    ok('lichess: a 403 on the study path is the missing study:write scope, a 401 the token, a 429 the rate limit, anything else carries the status',
       li(403, 'study').code === 'MPH-R07' && /study:write/.test(liReg['MPH-R07'].en) && li(401, 'study').code === 'MPH-R06' && /token/.test(liReg['MPH-R06'].en)
       && li(429, 'import').code === 'MPH-R05' && li(404, 'study').code === 'MPH-R08' && li(403, 'import').code === 'MPH-R09'
       && li(500, 'import', {error: 'boom'}).vars.detail === '500: boom' && li(502, 'import').vars.detail === '502');

    // both grades: the real moveCell / coachGrade, run with and without Explain the moves
    const mctx = vm.createContext({Math});
    const cut = (from, to) => { const a = rj.indexOf(from), b = rj.indexOf(to, a); if (a < 0 || b < 0) throw new Error('slice ' + from); return rj.slice(a, b); };
    vm.runInContext(cut('const esc = ', 'function scoreText') + cut('const CLASS_LABEL = {', '// ---- FIT HUMANIZE')
                    + cut('const CLASS_BADGE = {', 'function renderDetail') + cut('// chess.com\'s coach grade for a move', 'function renderIndicators')
                    + '\nvar report = null;', mctx);
    const cell = (prose, m) => { mctx.__p = prose; mctx.__m = m; return vm.runInContext('report = {prose: __p}; moveCell(__m)', mctx); };
    const alt = {ply: 4, color: 'w', san: 'Nc3', klass: 'mistake', classAlt: 'inaccuracy', cpLoss: 80};
    const withP = cell({got: 3, of: 3, disagreed: 1}, alt);
    ok('both grades: a move the coach graded differently is marked, ours stays the class',
       /rv-c-mistake rv-alt/.test(withP) && /title="Mistake - chess.com&#39;s coach: Inaccuracy"/.test(withP), withP.slice(0, 160));
    ok('both grades: no marker when Explain the moves did not run, or failed',
       !/rv-alt/.test(cell(null, alt)) && !/rv-alt/.test(cell({error: 'x'}, alt)));
    ok('both grades: no marker when the two grades agree',
       !/rv-alt/.test(cell({got: 1}, {...alt, classAlt: 'mistake'})));
    ok('both grades: the move detail shows the coach grade beside ours',
       /const alt = coachGrade\(played\)/.test(rj) && /chess\.com's coach: <span class="rv-klass">\$\{CLASS_LABEL\[alt\]\}/.test(rj));

    // the share card, drawn on a recording context in both themes
    const W = 1200, H = 630;
    const recorder = () => {
        const calls = [];
        let size = 10;
        const r = {calls, textAlign: 'left', globalAlpha: 1, fillStyle: '', textBaseline: '',
            set font(f) { this._f = f; size = +(/(\d+)px/.exec(f) || [0, 10])[1]; }, get font() { return this._f; },
            // generous glyph width, so a pass here holds for real fonts too
            measureText: (s) => ({width: String(s).length * size * 0.62}),
            fillRect(x, y, w, h) { calls.push({op: 'rect', x, y, w, h, fill: this.fillStyle}); },
            fillText(s, x, y) { calls.push({op: 'text', s, x, y, size, align: this.textAlign, fill: this.fillStyle, w: String(s).length * size * 0.62}); },
            beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {}, fill() {}, stroke() {},
        };
        return r;
    };
    const sctx = vm.createContext({Math, String});
    vm.runInContext(cut('function drawShareCard', 'function shareCanvas'), sctx);
    const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced', 'inaccuracy', 'mistake', 'miss', 'blunder'];
    const all = Object.fromEntries(order.map((k, i) => [k, i + 1]));
    const data = {white: 'GM Maximilian Very-Long-Surname-For-Testing (2850)', black: 'Bob (1500)', result: '1/2-1/2',
                  opening: 'Sicilian Defense: Najdorf Variation, English Attack, Anti-English with a very long tail name',
                  date: '01.09.2026', event: '', acc: {w: 87.34, b: null}, counts: {w: all, b: {best: 3}},
                  order, labels: Object.fromEntries(order.map(k => [k, k[0].toUpperCase() + k.slice(1)])),
                  evals: [0, 30, -50, 400, MATE - 2, -200]};
    for (const [theme, pal] of [['light', {bg: '#ffffff', text: '#14171a', dim: '#4a5057', mute: '#8b9198', hair: '#eceef0', line: '#dcdfe3', cls: {}}],
                                ['dark', {bg: '#16171b', text: '#e8eaec', dim: '#b7bbc0', mute: '#6b7079', hair: '#26282d', line: '#34353d', cls: {}}]]) {
        const rec = recorder();
        sctx.__c = rec; sctx.__d = data; sctx.__p = pal;
        vm.runInContext('drawShareCard(__c, __d, __p)', sctx);
        const texts = rec.calls.filter(x => x.op === 'text');
        const first = rec.calls[0];
        ok(`share card (${theme}): painted on the page's own background`,
           first && first.op === 'rect' && first.w === W && first.h === H && first.fill === pal.bg);
        const outside = texts.filter(t => {
            const left = t.align === 'center' ? t.x - t.w / 2 : t.align === 'right' ? t.x - t.w : t.x;
            return left < 0 || left + t.w > W || t.y - t.size < 0 || t.y > H;
        });
        ok(`share card (${theme}): every string lands inside the 1200x630 card`, !outside.length, outside.map(t => t.s));
        const overlap = texts.filter(t => t.align === 'left' && t.x < 600 && t.x + t.w > 560 && t.y > 100 && t.y < 300);   // below the full-width top line
        ok(`share card (${theme}): a long name or opening is cut with an ellipsis, not run into the other column`,
           !overlap.length && texts.some(t => /Maximilian.*…$/.test(t.s)) && texts.some(t => /^Sicilian.*…$/.test(t.s)),
           overlap.map(t => t.s));
        const s = texts.map(t => t.s);
        ok(`share card (${theme}): players, result, both accuracies, counts and opening are on it`,
           s.includes('Bob (1500)') && s.includes('½-½') && s.includes('87.3%') && s.includes('n/a')
           && order.every(k => s.includes(data.labels[k])) && s.includes('11') && s.includes('3'), s);
        ok(`share card (${theme}): no text is drawn in the background colour, nothing under 18px`,
           texts.every(t => t.fill !== pal.bg && t.size >= 18));
    }

    // every string the share row uses exists in all 14 locales
    const html = fs.readFileSync(ROOT + '/src/options/pages/review/review.html', 'utf8');
    const block = html.slice(html.indexOf('id="rv_share"'), html.indexOf('id="rv_share_status"'));
    const keys = [...block.matchAll(/data-i18n(?:-tip|-ph)?="([^"]+)"/g)].map(m => m[1]);
    const locDir = ROOT + '/src/i18n/locales/';
    const missing = [];
    for (const f of fs.readdirSync(locDir).filter(f => f.endsWith('.json'))) {
        const d = JSON.parse(fs.readFileSync(locDir + f, 'utf8'));
        for (const k of keys) if (!d[k]) missing.push(f + ':' + k);
        if (!/study:write/.test(d['set.tip.lichess_token'] || '')) missing.push(f + ':set.tip.lichess_token scope advice');
    }
    ok(`share row: all ${keys.length} strings translated in all 14 locales, token tip names study:write`,
       keys.length >= 9 && fs.readdirSync(locDir).filter(f => f.endsWith('.json')).length === 14 && !missing.length, missing);
}
// ==== END AGENT REVIEW CHECKS ====
{
    // Game accuracy: the volatility window is over WHITE's win%, not the mover's. Plies 0-19 are a
    // steady +3 (white 78%) where white plays perfectly; plies 20-39 swing 90/10 from white's view
    // every ply (so each MOVER sits at a steady 90) and white plays at 40. Lichess weights the
    // swinging half heavily; the old mover-relative window saw the steady half as volatile (78/22)
    // and the swinging half as calm, and scored 72.9. Weighted toward the 40s it lands under the
    // harmonic mean (57.1): 52.9 measured.
    console.log('\ngame accuracy volatility window:');
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const moves = [];
    for (let i = 0; i < 40; i++) {
        const color = i % 2 ? 'b' : 'w';
        const white = i < 20 ? 78 : (i % 2 ? 10 : 90);
        moves.push({ply: i, color, winBefore: color === 'w' ? white : 100 - white,
                    acc: color === 'w' ? (i < 20 ? 100 : 40) : 90});
    }
    const acc = c.MephistoReviewCore.accuracyFor(moves, 'w');
    const okW = acc > 45 && acc < 57;
    if (!okW) fails++;
    console.log(`${okW ? 'ok  ' : 'FAIL'} accuracy weights the white-view swings, not the mover-view flips (got ${acc && acc.toFixed(1)})`);
    // an unanalysed move (winBefore undefined) still drops out of the window instead of NaN-ing it
    moves[25].winBefore = undefined;
    const acc2 = c.MephistoReviewCore.accuracyFor(moves, 'w');
    if (!Number.isFinite(acc2)) fails++;
    console.log(`${Number.isFinite(acc2) ? 'ok  ' : 'FAIL'} ...and an unanalysed position in the window is skipped, not NaN`);
}

{
    // Shogi / xiangqi board after a route change: the router re-injects the page HTML on every visit
    // but require.js caches the module, so a module-level `wired = true` left the second visit's
    // board with no click listeners. The REAL wire() runs against two fresh DOMs here.
    console.log('\nlarge board rewires a re-injected page:');
    const lj = fs.readFileSync(ROOT + '/src/options/pages/analysis/large-board.js', 'utf8');
    const w0 = lj.indexOf('function wire()'), w1 = lj.indexOf('// Show the large board');
    const dom = () => {
        const els = {};
        return {els, getElementById: (id) => els[id] || (els[id] = {n: 0, addEventListener() { this.n++; }})};
    };
    const wctx = vm.createContext({document: dom()});
    vm.runInContext('let wiredTo = null; const $ = (id) => document.getElementById(id);'
                    + 'function onBoardClick() {} function onHandClick() {}\n' + lj.slice(w0, w1), wctx);
    vm.runInContext('wire(); wire();', wctx);
    const first = wctx.document.els.an_lg_board.n;
    wctx.document = dom();                         // the route came back: a brand new copy of the page
    vm.runInContext('wire();', wctx);
    const second = wctx.document.els.an_lg_board?.n;
    const okW = w0 > 0 && w1 > w0 && first === 1 && second === 1;
    if (!okW) fails++;
    console.log(`${okW ? 'ok  ' : 'FAIL'} wire() attaches once per DOM and again to a re-injected one (got ${first}, ${second})`);
}

{
    // Stop during the chess.com-classifier run with their Stockfish: a cancelled sfSearch resolves
    // normally, so the run must check `cancel` itself before assemble / eeRun, or the half-searched
    // game is classified and shown as a complete report. Pinned from the source (DOM + sandbox).
    console.log('\nchess.com classifier run honours Stop:');
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const s0 = rj.indexOf('await sfSearch(sf, positions'), s1 = rj.indexOf('built = assemble(', s0);
    const okS = s0 > 0 && s1 > s0 && /if \(cancel\) throw new Error\('stopped'\);/.test(rj.slice(s0, s1))
        && /eeSay\(cancel \? 'Stopped\.'/.test(rj.slice(s1));
    if (!okS) fails++;
    console.log(`${okS ? 'ok  ' : 'FAIL'} a cancelled search throws before assemble, and the catch reports "Stopped."`);
}

{
    // A review page revisited mid-run: the router re-injects review.html (rv_stop disabled, rv_run
    // enabled) while the module keeps running, so onInit has to reflect the live run or it cannot
    // be stopped. Pinned from the source (onInit needs the whole page).
    console.log('\nreview page revisited mid-run:');
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const init = rj.slice(rj.indexOf('class ReviewPage'), rj.indexOf('function stopOnUnload'));
    const okR = /if \(running\) \{\s*\$\('rv_run'\)\.disabled = true;\s*\$\('rv_stop'\)\.disabled = false;/.test(init);
    if (!okR) fails++;
    console.log(`${okR ? 'ok  ' : 'FAIL'} onInit re-enables Stop and disables Analyse while a run is live`);
}

{
    // A chess.com online review (ccr) has no cp losses. buildCcrReport wrote cpLoss 0 on every move,
    // so Fit Humanize read the player as 100% best; and a route change re-drew the report through
    // renderReport, which re-enabled Export/Fit and emptied the PGN box. The REAL buildCcrReport,
    // fitHumanize and renderReport run here with the DOM stubbed.
    console.log('\nchess.com online review report:');
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const cut = (a, b) => { const i = rj.indexOf(a), j = rj.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return rj.slice(i, j); };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const els = {};
    c.els = els;
    vm.runInContext('const Core = self.MephistoReviewCore; const MephistoConfig = {get: () => null};'
        + 'let report = null; const calls = [];'
        + 'const $ = (id) => els[id] || (els[id] = {disabled: false, classList: {add() {}, remove() {}}, scrollIntoView() {}});'
        + 'const document = {querySelector: () => null};'
        + 'for (const f of ["renderHeader", "renderCards", "renderGraph", "renderTurning", "renderTimeCards", "renderMoves",'
        + ' "renderIndicators", "renderHumanReport", "renderStrength", "ensureBoard", "showPly"]) this[f] = () => calls.push(f);\n'
        + cut('const FIT_ORDER', 'function renderReport') + cut('function renderReport', '// "GM Carlsen')
        + cut('const CCR_CLASS', '// ---- chess.com\'s classifier, run locally') + cut('function renderCcrReport', 'function buildCcrGame'), c);
    const pgn = '[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 Nc6 *';
    const review = {moves: [{classification: 1, cp: 30}, {classification: 1, cp: 25}, {classification: 1, cp: 30}, {classification: 1, cp: 20}]};
    c.review = review; c.pgn = pgn;
    const r = vm.runInContext('report = buildCcrReport(review, pgn); report', c);
    const okA = r && r.moves.length === 4 && r.moves.every(m => m.cpLoss == null) && r.pgnText === pgn
        && vm.runInContext('fitHumanize(report.moves, "w")', c) === null;
    if (!okA) fails++;
    console.log(`${okA ? 'ok  ' : 'FAIL'} a ccr report carries no fake cp losses (Fit finds nothing to fit) and keeps its PGN`);
    vm.runInContext('renderReport()', c);
    const drawn = vm.runInContext('calls.slice()', c);
    const okB = els.rv_fit.disabled === true && els.rv_export.disabled === true
        && !drawn.includes('renderIndicators') && drawn.includes('renderMoves');
    if (!okB) fails++;
    console.log(`${okB ? 'ok  ' : 'FAIL'} re-rendering a ccr report keeps it a ccr report: Export and Fit stay disabled`);
    // and an engine report with real cp losses still gets Fit
    vm.runInContext('report = {moves: [{color: "w", cpLoss: 12}], opts: {}}; renderReport();', c);
    const okC = els.rv_fit.disabled === false && els.rv_export.disabled === false;
    if (!okC) fails++;
    console.log(`${okC ? 'ok  ' : 'FAIL'} ...while an engine report with cp losses still enables Fit and Export`);
}

{
    // Review PV list mate sign. WASM lines carry `mate` side-to-move relative, native-host lines
    // white-relative (python-chess .white()); both carry a white-relative cp with the distance in it.
    // The list flipped `mate` by turn, so a native "Black mates in 3" printed #3. Black to move and
    // mating in 3, through each engine's REAL line mapper, must print #-3 in the list.
    console.log('\nreview PV list mate sign:');
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const ej = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const t0 = ej.indexOf('    toLine(l, turn) {'), t1 = ej.indexOf('\n    }\n', t0);
    vm.runInContext('const Core = self.MephistoReviewCore;\n'
        + rj.slice(rj.indexOf('function scoreText'), rj.indexOf('// The same eight colours'))
        + 'function ' + ej.slice(t0, t1).trim() + '\n}', c);
    const wasmCp = vm.runInContext('Core.toWhiteCp(undefined, 3, "b")', c);             // UCI: score mate 3
    const nativeCp = vm.runInContext('toLine({mate: -3, pv: []}, "b").cp', c);           // host: .white() -> -3
    const lineCall = /rv-score">\$\{esc\(scoreText\(l\.cp\)\)\}/.test(rj);
    const got = [vm.runInContext(`scoreText(${wasmCp})`, c), vm.runInContext(`scoreText(${nativeCp})`, c)];
    const okM = t0 > 0 && lineCall && got[0] === '#-3' && got[1] === '#-3';
    if (!okM) fails++;
    console.log(`${okM ? 'ok  ' : 'FAIL'} a Black mate-in-3 prints #-3 from both WASM and native lines (got ${got}, list reads cp: ${lineCall})`);
}

{
    // Settings Import vs the hotkey / macro editor: initHotkeys read `bindings` and `macros` once,
    // Import refreshed the form elements only, so the next rebind saved the pre-import objects back
    // over the import. The REAL initHotkeys + pullConfigValues run here against a stub DOM and store.
    console.log('\nhotkey editor after a settings import:');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const g0 = gj.indexOf('    initHotkeys() {'), g1 = gj.indexOf('    initUiMode() {');
    const el = () => ({kids: [], on: {}, className: '', textContent: '', set innerHTML(v) { this.kids = []; },
        classList: {add() {}}, value: '',
        appendChild(c) { this.kids.push(c); }, append(...c) { this.kids.push(...c); },
        addEventListener(t, f) { this.on[t] = f; }, add() {}});
    const store = {hotkeys: JSON.stringify({autoplay: 'a'}), hotkey_macros: JSON.stringify([{key: 'x', steps: ['autoplay']}])};
    const els = {};
    const hc = vm.createContext({store, keydown: [], queueMicrotask,
        Option: function () {},
        MephistoI18n: {t: (k, d) => d},
        MephistoConfig: {HOTKEY_LABELS: {}, HOTKEY_MACRO_MAX_STEPS: 8, HOTKEY_CUSTOM: ['custom_1', 'custom_2'],
            hotkeyCustom: () => JSON.parse(store.hotkey_custom || '[{"setting":""},{"setting":""}]'),
            get: (k) => store[k], set: (k, v) => { store[k] = v; }, remove: (k) => { delete store[k]; },
            hotkeys: () => JSON.parse(store.hotkeys || '{}'), hotkeyMacros: () => JSON.parse(store.hotkey_macros || '[]'),
            hotkeyString: (e) => e.key, hotkeyOwner: () => null},
        document: {getElementById: (id) => els[id] || (els[id] = el()), createElement: el,
                   addEventListener(t, f) { if (t === 'keydown') hc.keydown.push(f); }}});
    vm.runInContext('class Base { formElements = [{name: "background_play", desc: "Background Play:", type: "checkbox", default: false, elem: {}},'
                    + ' {name: "humanize_guards", desc: "Guards:", type: "checkbox", default: true, elem: {}},'
                    + ' {name: "move_time", desc: "Move Time:", type: "input", default: 400, elem: {}}]; pullConfigValues() {} }\n'
                    + 'class Page extends Base {\n' + gj.slice(g0, g1) + '}\n'
                    + 'var page = new Page(); page.initHotkeys();', hc);
    // Import: the file's hotkeys land in storage, then the page re-reads the form
    store.hotkeys = JSON.stringify({autoplay: 'z', copy_fen: 'q'});
    store.hotkey_macros = JSON.stringify([{key: 'y', steps: ['copy_fen']}]);
    vm.runInContext('page.pullConfigValues()', hc);
    // then rebind the first action (manual_play) to "m"
    els.hotkey_rows.kids[0].kids[1].on.click();
    hc.keydown[0]({key: 'm', preventDefault() {}, stopPropagation() {}});
    const saved = JSON.parse(store.hotkeys);
    const okH = g0 > 0 && g1 > g0 && saved.autoplay === 'z' && saved.copy_fen === 'q' && saved.manual_play === 'm'
        && JSON.parse(store.hotkey_macros)[0].key === 'y';
    if (!okH) fails++;
    console.log(`${okH ? 'ok  ' : 'FAIL'} a rebind after Import keeps the imported hotkeys and macros (got ${store.hotkeys})`);
    // the custom toggles: their rows carry a setting picker (last child) that saves {setting, label, def}
    const rows = els.hotkey_rows.kids;
    const pickers = rows.map(r => r.kids[2]).filter(Boolean);
    let okC = pickers.length === 2;
    if (okC) {
        pickers[1].value = 'humanize_guards'; pickers[1].on.change();
        const sv = JSON.parse(store.hotkey_custom || '[]');
        okC = sv[1] && sv[1].setting === 'humanize_guards' && sv[1].label === 'Guards' && sv[1].def === true && sv[0].setting === '';
        pickers[0].value = 'move_time'; pickers[0].on.change();     // not a checkbox setting: never offered, so it clears
        okC = okC && JSON.parse(store.hotkey_custom)[0].setting === '';
    }
    if (!okC) fails++;
    console.log(`${okC ? 'ok  ' : 'FAIL'} Custom 1/2 rows pick an on/off setting and save it with its label and default, never an input setting (got ${store.hotkey_custom})`);
}

{
    // Leaving Analysis while its engine is still loading: teardown() only disposed `engine` if it was
    // already set, and the in-flight build assigned it afterwards (then analyseNow ran go infinite on
    // it). The REAL builders and teardown run here with a start() that finishes after the page left.
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (a, b) => { const i = aj.indexOf(a), j = aj.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return aj.slice(i, j); };
    const made = [];
    const ac = vm.createContext({made, Promise,
        makeEngine: () => { const e = {disposed: false, dispose() { this.disposed = true; }, send() {}};
                            e.start = () => new Promise(r => { e.finish = r; }); made.push(e); return e; },
        cfg: (k) => k === 'an_engine2' || k === 'an_human' ? 'x' : (k === 'an_wdl' ? false : 'y'),
        engineOpts: () => ({}), CFG: {an_band: 1500}, engineFor: (id) => id,
        hideLargeGame() {}, stopMatch() {}, stopSearch() {}, $: () => null});
    (async () => {
        vm.runInContext('let engine = null, human = null, humanKey = null, boardResizeObs = null, bandRun = 0, prefetchTimer = null;\n'
            + cut('let engineChain', '// Reload ONLY the analysis engine') + cut('// teardown() bumps this', '// Returns a promise'), ac);
        const got = vm.runInContext('[ensureEngine(), ensureEngine2(), ensureHuman()]', ac);
        await new Promise(r => setImmediate(r));                  // the builders are now awaiting start()
        vm.runInContext('teardown()', ac);                         // the route changed
        for (const e of made) e.finish();                          // ...and only now did the engines load
        const res = await Promise.all(got);
        const left = vm.runInContext('[engine, engine2, human]', ac);
        console.log('\nanalysis engine loaded after the page was left (async, prints late):');
        const okE = made.length === 3 && made.every(e => e.disposed) && res.every(r => r === null) && left.every(x => x === null);
        if (!okE) fails++;
        console.log(`${okE ? 'ok  ' : 'FAIL'} an engine, second engine or human model that finishes loading after teardown is disposed, not kept (${made.filter(e => e.disposed).length}/${made.length} disposed)`);
        // a build in the SAME generation still lands
        const p = vm.runInContext('ensureEngine()', ac);
        await new Promise(r => setImmediate(r));
        made[made.length - 1].finish();
        const e = await p;
        const okF = e && !e.disposed && vm.runInContext('engine', ac) === e;
        if (!okF) fails++;
        console.log(`${okF ? 'ok  ' : 'FAIL'} ...while a build that finishes on the live page is kept`);
    })().catch(e => { fails++; console.log('FAIL analysis engine teardown check threw: ' + (e && e.stack || e)); });
}

{
    // [%emt] is time SPENT on a move, [%clk] the clock LEFT. Both were read into `clk`, so an emt
    // game's think times came out as differences of spends (5s, 3s, 12s -> null, null, 0). The REAL
    // parser, buildPositions and fillThinkTime run here.
    console.log('\nPGN [%emt] vs [%clk]:');
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    vm.runInContext('const Core = self.MephistoReviewCore; const RV_FAIRY_ONLY = [];\n'
        + rj.slice(rj.indexOf('function buildPositions'), rj.indexOf('function incrementFromTimeControl')), c);
    const secs = (pgn) => vm.runInContext(`(() => { const {moves} = buildPositions(Core.parsePgn(${JSON.stringify(pgn)})[0]);
        fillThinkTime(moves, 0); return moves.map(m => [m.clk, m.seconds]); })()`, c);
    const emt = secs('1. e4 {[%emt 0:00:05]} e5 {[%emt 0:00:03]} 2. Nf3 {[%emt 0:00:12]} *');
    const clk = secs('1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} 2. Nf3 {[%clk 0:02:50]} *');
    eq('[%emt] is the think time itself, never a clock', emt, [[null, 5], [null, 3], [null, 12]]);
    eq('[%clk] keeps its meaning: the clock left, differenced per side', clk, [[180, null], [180, null], [170, 10]]);
}

{
    // Games that start with Black to move, or from a later move number: the move list put Black's
    // first move in the White column, labels / the illegal-move error / the PGN writers all counted
    // from "1." with White, and gameText wrote a `"` in a tag value raw. Everything numbers through
    // Core.plyMove now, the export's own logic; the REAL functions run here.
    console.log('\nmove numbering from a Black-to-move start:');
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return src.slice(i, j); };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const el = {innerHTML: '', dataset: {bound: '1'}};
    c.el = el;
    vm.runInContext('const Core = self.MephistoReviewCore; const RV_FAIRY_ONLY = []; let report = null;'
        + 'const $ = () => el; function moveCell(m) { return m ? `[${m.san}]` : "[]"; }\n'
        + cut(rj, 'function buildPositions', '// Seconds spent') + cut(rj, 'function moveLabel', '// chess.com\'s coach grade')
        + cut(rj, 'function gameText', '// The budget is a -/+ BOX'), c);
    const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 30';
    const pgn = `[White "A \\"Q\\" B"]\n[Black "C\\\\D"]\n[SetUp "1"]\n[FEN "${FEN}"]\n\n30... e5 31. Nf3 Nc6 *`;
    c.pgn = pgn;
    const r = vm.runInContext(`(() => { const g = Core.parsePgn(pgn)[0]; const b = buildPositions(g);
        report = {positions: b.positions, moves: b.moves}; renderMoves();
        return {labels: b.moves.map(moveLabel), rows: el.innerHTML, text: gameText(g), tags: g.tags}; })()`, c);
    eq('Core.plyMove: start position, a Black-to-move start, and the move after it',
       [c.MephistoReviewCore.plyMove('', 0), c.MephistoReviewCore.plyMove(FEN, 0), c.MephistoReviewCore.plyMove(FEN, 1)],
       [{num: 1, white: true}, {num: 30, white: false}, {num: 31, white: true}]);
    eq('move labels follow the start FEN', r.labels, ['30... e5', '31. Nf3', '31... Nc6']);
    const okRows = /^<div class="rv-mrow"><div class="rv-mnum">30<\/div>\[\]\[e5\]<\/div><div class="rv-mrow"><div class="rv-mnum">31<\/div>\[Nf3\]\[Nc6\]<\/div>$/.test(r.rows);
    if (!okRows) fails++;
    console.log(`${okRows ? 'ok  ' : 'FAIL'} the move list opens with an empty White cell on row 30 (got ${r.rows})`);
    const back = c.MephistoReviewCore.parsePgn(r.text)[0];
    const okText = /\n30\.\.\. e5 31\. Nf3 Nc6 \*/.test(r.text) && r.text.includes('[White "A \\"Q\\" B"]')
        && back.tags.White === 'A "Q" B' && back.tags.Black === 'C\\D' && back.moves.map(m => m.san).join(' ') === 'e5 Nf3 Nc6';
    if (!okText) fails++;
    console.log(`${okText ? 'ok  ' : 'FAIL'} gameText numbers from the FEN, escapes quotes and backslashes, and round-trips`);
    let err = '';
    try { vm.runInContext(`buildPositions(Core.parsePgn(${JSON.stringify(`[SetUp "1"]\n[FEN "${FEN}"]\n\n30... Ke7 *`)})[0])`, c); }
    catch (e) { err = String(e.message); }
    const okErr = /^Move 30\.\.\. Ke7 is not legal/.test(err);
    if (!okErr) fails++;
    console.log(`${okErr ? 'ok  ' : 'FAIL'} the illegal-move error names the real move number (got ${err.slice(0, 30)})`);
    // the analysis page's copy-PGN
    const a = vm.createContext({Core: c.MephistoReviewCore, anVariant: () => 'chess', AN_VARIANTS: [], fullFen: (p) => (p ? p.fen : ''),
        newChess: () => ({fen: () => 'startpos'}),
        positions: [{fen: FEN}, {san: 'e5'}, {san: 'Nf3'}, {san: 'Nc6'}]});
    vm.runInContext(cut(aj, 'function pgnText', 'async function copyOut'), a);
    eq('analysis pgnText numbers a Black-to-move line from the FEN', vm.runInContext('pgnText()', a).split('\n\n')[1], '30... e5 31. Nf3 Nc6');
}

// ==== AGENT ANALYSIS CHECKS (engine vs engine, shogi / xiangqi) ====
{
    // The match's rules, executed: the REAL block sliced out of analysis.js, the real chess.js, and
    // the real PGN parser for the round trip. The loop itself needs engines; this pins what decides
    // a game and what gets written down about it.
    console.log('\nengine vs engine match:');
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s0 = aj.indexOf('// ---- ENGINE VS ENGINE'), s1 = aj.indexOf('function matchStatus(');
    ok('the match block can be sliced', s0 > 0 && s1 > s0);
    const mctx = {console};
    mctx.self = mctx;
    vm.createContext(mctx);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), mctx);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), mctx);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), mctx);
    vm.runInContext(aj.slice(s0, s1), mctx);
    const run = (code) => vm.runInContext(code, mctx);
    const out = (fen, moves, plies = 0, v = 'chess') => run(`(() => { const c = new Chess('${v}'${fen ? `, '${fen}'` : ''});
        for (const m of ${JSON.stringify(moves)}) c.move(m); return matchOutcome(c, ${plies}); })()`);
    eq('match: checkmate ends it for the mating side', out('', ['f3', 'e5', 'g4', 'Qh4#']), {result: '0-1', reason: 'checkmate'});
    eq('match: stalemate', out('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', []), {result: '1/2-1/2', reason: 'stalemate'});
    eq('match: insufficient material', out('8/8/8/8/8/5k2/8/5K2 w - - 0 1', []), {result: '1/2-1/2', reason: 'insufficient material'});
    eq('match: threefold repetition', out('', ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']), {result: '1/2-1/2', reason: 'threefold repetition'});
    eq('match: the 50-move rule', out('7k/8/8/8/8/8/R7/K7 w - - 99 80', ['Ra3']), {result: '1/2-1/2', reason: '50-move rule'});
    eq('match: a mate on the hundredth quiet ply is a mate, not a draw', out('7k/8/6K1/8/8/8/8/R7 w - - 99 80', ['Ra8#']), {result: '1-0', reason: 'checkmate'});
    eq('match: the move cap adjudicates a draw', out('', [], run('MATCH_MAX_PLIES')), {result: '1/2-1/2', reason: 'move cap (200 moves)'});
    eq('match: a game still on is null', out('', ['e4']), null);
    const mv = (v, fen, uci) => run(`(() => { const m = matchMove(new Chess('${v}', '${fen}'), '${uci}'); return m ? m.san : null; })()`);
    const castle = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    eq('match: a standard castle plays', mv('chess', castle, 'e1g1'), 'O-O');
    eq('match: a Chess960 engine castles king-takes-rook, and it is translated', [mv('fischerandom', castle, 'e1h1'), mv('fischerandom', castle, 'e1a1')], ['O-O', 'O-O-O']);
    eq('match: a promotion keeps its piece', mv('chess', '8/P6k/8/8/8/8/8/K7 w - - 0 1', 'a7a8n'), 'a8=N');
    eq('match: an illegal engine move is refused, not played', mv('chess', castle, 'e1e3'), null);
    eq('match: the score is kept from engine A\'s side', run(`matchScore([{white: 'A', result: '1-0'}, {white: 'B', result: '1-0'},
        {white: 'A', result: '1/2-1/2'}, {white: 'B', result: '*'}])`), {a: 1.5, b: 1.5, w: 1, d: 1, l: 1});
    const ENG = JSON.stringify([{id: 'w1', kind: 'wasm'}, {id: 'n1', kind: 'native'}, {id: 'n2', kind: 'native'}]);
    ok('match: the same WASM engine may play itself (two client ids, two instances)', run(`matchRefusal('w1', 'w1', 'chess', ${ENG})`) === null);
    ok('match: ...a native engine against itself is refused with the reason', /one process/.test(run(`matchRefusal('n1', 'n1', 'chess', ${ENG})`) || ''));
    ok('match: ...two different native engines are fine', run(`matchRefusal('n1', 'n2', 'chess', ${ENG})`) === null);
    ok('match: a variant chess.js cannot end is refused', !!run(`matchRefusal('w1', 'w1', 'crazyhouse', ${ENG})`));
    ok('match: Chess960 on a native host is refused', !!run(`matchRefusal('w1', 'n1', 'fischerandom', ${ENG})`));
    ok('match: the two sides really get two client ids', /'analysis-match-a'/.test(aj) && /'analysis-match-b'/.test(aj));
    ok('match: one thread per engine', /multipv: 1, threads: 1, hash: MATCH_HASH/.test(aj));
    ok('match: the page\'s own analysis stands down while it plays',
       /async function analyseNow\(gen\) \{\n\s+if \(gen !== pageGen\) return;[^\n]*\n\s+if \(match\?\.running\) return;/.test(aj) && /if \(!pos \|\| match\?\.running\) return false;/.test(aj));
    // the PGN goes back through the page's own parser and replays to the same moves -- from a start
    // position with black to move, which is where move numbering goes wrong
    const rt = run(`(() => {
        const std = new Chess('chess').fen();
        const start = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        const c = new Chess('chess', start);
        const sans = ['e5', 'Nf3', 'Nc6', 'Bb5'].map(m => c.move(m).san);
        const g = {round: 3, white: 'B', startFen: start, sans, result: '*', reason: 'stopped'};
        const pgn = matchPgn(g, {A: 'SF "A"', B: 'SF B'}, 'ev', 'chess', std);
        const back = self.MephistoReviewCore.parsePgn(pgn)[0];
        const r = new Chess('chess', back.startFen);
        const ok = back.moves.every(m => r.move(typeof m === 'string' ? m : m.san));
        return {ok, n: r.history().length, fen: back.startFen === start, num: /\\n1\\.\\.\\. e5 2\\. Nf3/.test(pgn),
                white: /\\[White "SF B"\\]/.test(pgn), reason: /\\{stopped\\} \\*$/.test(pgn), quote: /\\[Black "SF 'A'"\\]/.test(pgn)};
    })()`);
    eq('match: a game\'s PGN round-trips through the page\'s parser', rt, {ok: true, n: 4, fen: true, num: true, white: true, reason: true, quote: true});
}
{
    // SHOGI / XIANGQI. The page knows no rules (the large Fairy build is the authority); what it DOES
    // own is the FEN gate in front of the engine, the move-notation reader and the click->move
    // mapping. The REAL pure block of large-board.js runs here; the wiring is pinned from the sources.
    console.log('\nshogi / xiangqi (large board):');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const lj = fs.readFileSync(ROOT + '/src/options/pages/analysis/large-board.js', 'utf8');
    const p0 = lj.indexOf('// ---- PURE'), p1 = lj.indexOf('// ---- END PURE');
    ok('large: the pure block can be sliced', p0 > 0 && p1 > p0);
    const lctx = {};
    vm.createContext(lctx);
    vm.runInContext(lj.slice(p0, p1) + ';this.P = {LARGE_GAMES, parseLargeFen, parseLargeMove, largeCandidates};', lctx);
    const P = lctx.P;
    const pieces = (v) => P.parseLargeFen(v, P.LARGE_GAMES[v].start).cells.flat().filter(Boolean).length;
    eq('large: both start positions parse, 40 shogi pieces and 32 xiangqi pieces, first player to move',
       [pieces('shogi'), pieces('xiangqi'), P.parseLargeFen('shogi', P.LARGE_GAMES.shogi.start).turn], [40, 32, 'w']);
    const s = P.parseLargeFen('shogi', 'lnsgkgsnl/1r5+B1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/7R1/LNSGKGSNL[Bbpp] b - - 0 2');
    eq('large: a promoted piece and both hands read as the engine printed them',
       [s.cells[7][7], s.hand, s.turn], ['+B', {w: {B: 1}, b: {b: 1, p: 2}}, 'b']);
    const why = (v, fen) => { try { P.parseLargeFen(v, fen); return 'accepted'; } catch (e) { return e.key; } };
    eq('large: the gate refuses what would crash or mislead the engine', [
        why('shogi', 'lnsg1gsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL[] w - - 0 1'),     // no gote king
        why('shogi', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/LNSGKGSNL[] w - - 0 1'),          // 8 ranks
        why('shogi', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSN[] w - - 0 1'),     // 8 files
        why('shogi', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5Q1/LNSGKGSNL[] w - - 0 1'),    // a queen
        why('shogi', 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5+G1/LNSGKGSNL[] w - - 0 1'),   // gold never promotes
        why('xiangqi', P.LARGE_GAMES.xiangqi.start.replace(' w ', '[P] w ')),                      // xiangqi has no hand
        why('xiangqi', P.LARGE_GAMES.xiangqi.start.replace(' w ', ' x ')),                         // side to move
    ], ['kings', 'shape', 'shape', 'piece', 'piece', 'hand', 'turn']);
    eq('large: Fairy move notation (promotion, drop, the xiangqi tenth rank, junk)',
       [P.parseLargeMove('b2h8+'), P.parseLargeMove('B@e5'), P.parseLargeMove('c10e8'), P.parseLargeMove('e2e4q'), P.parseLargeMove('')],
       [{from: [1, 1], to: [7, 7], promo: true}, {drop: 'B', to: [4, 4]}, {from: [2, 9], to: [4, 7], promo: false}, null, null]);
    const legal = ['b2g7', 'b2h8', 'b2h8+', 'B@h8', 'h2h3'];
    eq('large: a click can only mean moves on the engine\'s own list (optional promotion offers both)',
       [P.largeCandidates(legal, [1, 1], [7, 7]), P.largeCandidates(legal, 'B', [7, 7]), P.largeCandidates(legal, [1, 1], [0, 0])],
       [['b2h8', 'b2h8+'], ['B@h8'], []]);
    // wiring
    const oj = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    const mapped = /'fairy-stockfish-14-large-nnue': '([^']+)'/.exec(oj)?.[1];
    ok('large: the offscreen loader maps the engine to a shipped file', !!mapped && fs.existsSync(ROOT + '/lib/engine/' + mapped), mapped);
    ok('large: ...and runs Fairy\'s variant + per-variant net path for it',
       /engineName === 'fairy-stockfish-14-nnue' \|\| engineName === 'fairy-stockfish-14-large-nnue'/.test(oj));
    const netDir = ROOT + '/lib/engine/fairy-stockfish-14-large/nnue/';
    const nets = ['shogi', 'xiangqi'].map(v => new RegExp(`'${v}': '([^']+)'`).exec(oj)?.[1]);
    // A net over GitHub's 100 MB file limit lives in the repo as .part0.. pieces (the loader joins them),
    // so read it whole OR reassembled. The whole-file-only version crashed the suite in the public
    // repo, where the 160 MB shogi net is four parts -- and a crash reads as "fewer checks", not a FAIL.
    const netBytes = (n) => {
        if (fs.existsSync(netDir + n)) return fs.readFileSync(netDir + n);
        const parts = []; for (let i = 0; fs.existsSync(`${netDir}${n}.part${i}`); i++) parts.push(fs.readFileSync(`${netDir}${n}.part${i}`));
        return parts.length ? Buffer.concat(parts) : null;
    };
    ok('large: shogi and xiangqi each map to a net that is in the large build\'s nnue folder',
       nets.every(n => n && netBytes(n)), nets);
    const man = JSON.parse(fs.readFileSync(ROOT + '/src/offscreen/engine-assets.json', 'utf8')).files;
    const crypto = require('crypto');
    ok('large: both nets are in the assets manifest with their real size and sha256',
       nets.every(n => man[n] && man[n].dir === 'lib/engine/fairy-stockfish-14-large/nnue' && man[n].tag === 'engines-v1'
           && man[n].size === netBytes(n).length
           && man[n].sha256 === crypto.createHash('sha256').update(netBytes(n)).digest('hex')));
    // Fairy names its nets <variant>-<first 12 hex of sha256>, so the file name is its own checksum
    ok('large: ...and each net\'s bytes match the hash in its name', nets.every(n => man[n]?.sha256.startsWith(n.replace(/^.*-|\.nnue$/g, ''))));
    const ej = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    ok('large: Analysis page only -- not in the shared ENGINES list the panel/settings parity checks read',
       !/\{id: 'fairy-stockfish-14-large-nnue'/.test(ej) && /'fairy-stockfish-14-large-nnue'/.test(lj));
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    ok('large: the chess analysis stands down while a large game is shown',
       /if \(largeGame\(\)\) return;/.test(aj) && /hideLargeGame\(\);\n\s+stopMatch\(\);/.test(aj));
    ok('large: moves are played only off the engine\'s perft list, positions only off its `d`',
       /if \(!legal\.includes\(uci\)\) return;/.test(lj) && /'go perft 1'/.test(lj) && /\/\^Fen: \//.test(lj));
    // every string the large board shows, in all 14 locales, same placeholders as English
    const ah = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.html', 'utf8');
    const keys = [...new Set([...ah.matchAll(/data-i18n(?:-tip)?="(an\.(?:game[^"]*|tip\.game|lg_[^"]+))"/g), ...lj.matchAll(/'(an\.(?:game_|lg_)[^']+)'/g)].map(m => m[1]))];
    const locDir = ROOT + '/src/i18n/locales/';
    const en = JSON.parse(fs.readFileSync(locDir + 'en.json', 'utf8'));
    const ph = (s) => JSON.stringify((String(s).match(/\{\w+\}/g) || []).sort());
    const missing = [];
    for (const f of fs.readdirSync(locDir).filter(f => f.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(locDir + f, 'utf8'));
        for (const k of keys) if (!j[k] || ph(j[k]) !== ph(en[k])) missing.push(`${f}:${k}`);
    }
    ok(`large: all ${keys.length} strings translated in all 14 locales with matching placeholders`,
       keys.length >= 25 && fs.readdirSync(locDir).filter(f => f.endsWith('.json')).length === 14 && !missing.length, missing);
}
// ==== END AGENT ANALYSIS CHECKS ====

// ==== AGENT ENGINE CHECKS (Rodent IV) ====
{
    console.log('\nrodent iv:');
    const rd = (p) => fs.readFileSync(ROOT + p, 'utf8');
    const pj = rd('/src/popup/popup.js'), ph = rd('/src/popup/popup.html');
    const gh = rd('/src/options/pages/settings/general/general.html');
    const gj = rd('/src/options/pages/settings/general/general.js');
    const bg = rd('/src/scripts/background-script.js'), ej = rd('/src/options/util/engines.js');
    // The installer is install.sh in the local build and install-native.sh in the public repo (the one
    // deliberate difference between the two READMEs) -- read whichever this checkout has.
    const inst = rd(fs.existsSync(ROOT + '/native-host/install.sh') ? '/native-host/install.sh' : '/native-host/install-native.sh');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const lineOf = (src, re) => (src.match(re) || [''])[0];

    // every list a native engine has to be in, or it is offered and cannot start (or the reverse)
    ok('the panel offers it', /<option value="rodent-native">/.test(ph));
    ok('the settings page offers it', /<option value="rodent-native">/.test(gh));
    ok('the review/analysis list has it as a native', /\{id: 'rodent-native', [^}]*kind: 'native'\}/.test(ej));
    ok('the panel routes it over native messaging',
       /'rodent-native'/.test(lineOf(pj, /const NATIVE_ENGINES = \[[^\]]*\]/)));
    // host names allow no hyphens: the worker's app id and the installer's derived one must meet
    ok('the worker knows its host', /'rodent-native': \{app: 'com\.rodent_native\.host'/.test(bg));
    ok('the installer registers it, personalities/ copied beside the binary',
       // either installer's spelling: the 4th spec field (home dir) is the rodent-iv folder
       /"rodent-native\|[^\n]*\|\|[^\n]*(engines\/rodent-iv|\$RODENT_DIR)"/.test(inst)
           && /engines\/rodent-iv/.test(inst));

    // the two copies of "which engines have a Personality" agree
    const list = (src, re) => { const m = src.match(re); return m ? JSON.parse(m[1].replace(/'/g, '"')) : null; };
    const pr = list(pj, /const RODENT_ENGINES = (\[[^\]]*\])/), gr = list(gj, /const RODENT = (\[[^\]]*\])/);
    ok('panel and settings agree on which engines take a Personality',
       JSON.stringify(pr) === JSON.stringify(gr) && pr && pr.includes('rodent-native'), [pr, gr]);
    ok('the row starts hidden and is toggled on that list',
       /class="set-row section hidden" id="rodent_personality_section"/.test(gh)
       && /getElementById\('rodent_personality_section'\)\s*\?\.classList\.toggle\('hidden', !RODENT\.includes\(engine_select\.getValue\(\)\)\)/.test(gj));
    ok('the setting defaults to the engine\'s own default',
       /registerFormElement\('rodent_personality', [^)]*'select', '---'\)/.test(gj)
       && /rodent_personality: JSON\.parse\(MephistoConfig\.get\('rodent_personality'\)\) \|\| '---'/.test(pj));
    ok('a change on the settings page reaches an open panel',
       /'rodent_personality',/.test(pj) && /key === 'rodent_personality' && RODENT_ENGINES\.includes/.test(pj));

    // THE REAL configure object, executed: the Personality always travels for Rodent (the host keeps
    // the last value it was given), never for anything else, and the Elo cap stays in each engine's
    // own range with its removal SENT -- Rodent boots with UCI_LimitStrength on.
    const cut = (from, to) => { const a = pj.indexOf(from); const b = pj.indexOf(to, a); return a < 0 || b < 0 ? '' : pj.slice(a, b + to.length); };
    const eloSpread = cut('...(NO_ELO_ENGINES.includes(config.engine) ? {}', '{"UCI_LimitStrength": false}),');
    const persSpread = cut('...(RODENT_ENGINES.includes(config.engine) ? {"Personality"', ': {}),');
    const defs = [cut('const ONE_PASS_ENGINES', ';'), cut('const NO_ELO_ENGINES', ';'),
                  cut('const RODENT_ENGINES', ';'), cut('const ELO_RANGE = {', '\n};')].join('\n');
    ok('the configure spreads and their tables slice out', eloSpread && persSpread && defs.split('\n').length > 4);
    const cc = vm.createContext({});
    // the cap goes through engine_elo() (the stored value inside the engine's own range), which reads the global config
    const pjFn = (name) => { const i = pj.indexOf(`function ${name}(`); return pj.slice(i, pj.indexOf('\n}\n', i) + 3); };
    vm.runInContext(defs + '\nconst FULL_STRENGTH_ELO = 3200;\n' + pjFn('elo_stops') + pjFn('engine_elo')
        + '\nvar config; var build = (c) => { config = c; return ({' + eloSpread + '\n' + persSpread + '\n}); };', cc);
    const opts = (c) => JSON.parse(JSON.stringify(cc.build(c)));
    const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got);
    eq('rodent, default: the engine default personality and no cap',
       opts({engine: 'rodent-native', elo: 0, rodent_personality: '---'}),
       {UCI_LimitStrength: false, Personality: '---'});
    eq('rodent, Tal at 1500',
       opts({engine: 'rodent-native', elo: 1500, rodent_personality: 'Tal'}),
       {UCI_LimitStrength: true, UCI_Elo: 1500, Personality: 'Tal'});
    eq('rodent, 3000 is past its 2800 ceiling: uncapped, not a refused UCI_Elo',
       opts({engine: 'rodent-native', elo: 3000, rodent_personality: '---'}),
       {UCI_LimitStrength: false, Personality: '---'});
    eq('a Stockfish native never gets a Personality',
       opts({engine: 'sf18-native', elo: 0, rodent_personality: 'Tal'}), {UCI_LimitStrength: false});
    eq('an engine with no Elo option gets neither key', opts({engine: 'tetrarch-native', elo: 1500}), {});

    // the dropdown's values are what the ENGINE lists: basic.ini's first set, keeping only aliases
    // whose file exists (uci_options.cpp does exactly that). Only checkable where the build is staged.
    const pdir = ROOT + '/native-host/engines/rodent-iv/personalities';
    const opts2 = [...gh.slice(gh.indexOf('id="rodent_personality_select"'), gh.indexOf('</select>', gh.indexOf('id="rodent_personality_select"')))
        .matchAll(/<option[^>]*value="([^"]+)"/g)].map(m => m[1]);
    if (fs.existsSync(pdir + '/basic.ini')) {
        const ini = fs.readFileSync(pdir + '/basic.ini', 'utf8').split(/\r?\n/);
        const first = ini.findIndex(l => l.startsWith('PERSONALITY_SET='));
        const next = ini.findIndex((l, i) => i > first && l.startsWith('PERSONALITY_SET='));
        const engine = ini.slice(first + 1, next < 0 ? undefined : next)
            .filter(l => /^[^#;'/\s][^=]*=/.test(l))
            .filter(l => fs.existsSync(pdir + '/' + l.split('=')[1].trim()))
            .map(l => l.split('=')[0]);
        eq('the dropdown lists exactly the engine\'s personalities', opts2, ['---', ...engine]);
    } else {
        console.log('skip the dropdown vs basic.ini check (Rodent not built here: native-host/build-rodent.sh)');
    }

    for (const f of fs.readdirSync(ROOT + '/src/i18n/locales').filter(f => f.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + f, 'utf8'));
        ok(`${f}: the Personality row is translated`,
           ['set.rodent_personality', 'set.rodent_personality_default', 'set.tip.rodent_personality'].every(k => j[k]));
    }
}
// ==== END AGENT ENGINE CHECKS ====

// ==== AGENT INFRA CHECKS (engines asset release, changelog) ====
// The slim full zip drops every net listed in src/offscreen/engine-assets.json, and a fresh install
// fetches them from the assets release by that manifest's sha256. A manifest that has drifted from
// lib/engine is a slim install whose engines refuse their own download, so the manifest is checked
// byte for byte here, and the REAL fetchModel runs against a mocked network and Cache API.
(async () => {
    const crypto = require('crypto'), path = require('path');
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    console.log('\nengine assets manifest:');
    const man = JSON.parse(fs.readFileSync(ROOT + '/src/offscreen/engine-assets.json', 'utf8')).files || {};
    const disk = {};   // name -> {dir, whole?, parts[]}, the same grouping the manifest builder uses
    const walk = (d) => {
        for (const e of fs.readdirSync(d, {withFileTypes: true})) {
            if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
            const m = /^(.+\.(?:nnue|onnx))(?:\.part(\d+))?$/.exec(e.name);
            if (!m) continue;
            const f = disk[m[1]] ??= {dir: path.relative(ROOT, d).split(path.sep).join('/'), parts: []};
            if (m[2] === undefined) f.whole = path.join(d, e.name); else f.parts[+m[2]] = path.join(d, e.name);
        }
    };
    walk(ROOT + '/lib/engine');
    const notListed = Object.keys(disk).filter(n => !man[n]);
    ok('every net and model on disk is in the manifest (the slim zip drops exactly these)', notListed.length === 0, notListed);
    const gone = Object.keys(man).filter(n => !disk[n] || disk[n].dir !== man[n].dir);
    ok('...and every manifest entry is on disk, in the directory it names', gone.length === 0, gone);
    const drift = Object.keys(man).filter(n => disk[n]).filter(n => {
        const bytes = disk[n].whole ? fs.readFileSync(disk[n].whole) : Buffer.concat(disk[n].parts.map(p => fs.readFileSync(p)));
        return bytes.length !== man[n].size || sha(bytes) !== man[n].sha256;
    });
    ok('...byte for byte: size and sha256 match what is bundled', drift.length === 0, drift);
    ok('...each with a release tag the loader accepts', Object.values(man).every(e => /^[a-z]+-v\d+$/.test(e.tag)));
    const off = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    const vStart = off.indexOf('const variantNnueMap = {');
    const variantNets = [...off.slice(vStart, off.indexOf('};', vStart)).matchAll(/:\s*'([^']+\.nnue)'/g)].map(m => m[1]);
    ok('every Fairy net the loader can ask for is in the manifest', variantNets.length > 5 && variantNets.every(n => man[n]),
        variantNets.filter(n => !man[n]));
    const fnStart = off.indexOf('async function fetchNnue(');
    ok('the Stockfish/Fairy net loader goes through the shared model fetcher',
        fnStart > 0 && off.slice(fnStart, off.indexOf('\n}\n', fnStart)).includes("import('/src/offscreen/model-fetch.js')"));

    console.log('\nfetchModel (bundled -> cache -> release, sha256-checked):');
    const good = Buffer.from('the right net bytes. '.repeat(50));
    const tampered = Buffer.concat([Buffer.from('X'), good.subarray(1)]);   // same size, wrong bytes
    const entry = (tag) => ({dir: 'lib/engine/t', size: good.length, sha256: sha(good), tag});
    const files = {'a.nnue': entry('engines-v1'), 'bad.nnue': entry('engines-v1'), 'big.nnue': entry('engines-v1'),
                   'stale.nnue': entry('engines-v1'), 'local.nnue': entry('engines-v1'), 'm.onnx': entry('models-v1')};
    const served = {'a.nnue': good, 'bad.nnue': tampered, 'big.nnue': Buffer.concat([good, Buffer.from('more')]),
                    'stale.nnue': good, 'm.onnx': good};
    const requested = [], store = new Map();
    const fetchMock = async (url) => {
        requested.push(url);
        if (url === '/src/offscreen/engine-assets.json') return new Response(JSON.stringify({files}));
        if (url === '/lib/engine/t/local.nnue') return new Response(good);
        if (url.startsWith('/')) throw new TypeError('Failed to fetch');   // not in this archive
        const body = served[url.split('/').pop()];
        return body ? new Response(body) : new Response('', {status: 404});
    };
    const cachesMock = {open: async () => ({
        match: async (u) => store.has(u) ? new Response(store.get(u)) : undefined,
        put: async (u, r) => { store.set(u, Buffer.from(await r.arrayBuffer())); },
        delete: async (u) => store.delete(u),
    })};
    const mctx = vm.createContext({fetch: fetchMock, caches: cachesMock, crypto: globalThis.crypto, Response, console});
    vm.runInContext(fs.readFileSync(ROOT + '/src/offscreen/model-fetch.js', 'utf8').replace(/^export /gm, ''), mctx);
    const fetchModel = vm.runInContext('fetchModel', mctx), releaseUrl = vm.runInContext('releaseUrl', mctx);
    const same = (buf) => Buffer.from(buf).equals(good);
    const fails_with = async (p, re) => { try { await p; return 'resolved'; } catch (e) { return re.test(String(e)) || String(e); } };
    const REL = 'https://github.com/IchNukeDichWeg/Mephisto/releases/download/';

    ok('a bundled net is used as-is, with no network', same(await fetchModel('/lib/engine/t', 'local.nnue'))
        && !requested.some(u => u.startsWith('https:')), requested);
    const notes = [];
    ok('a missing net comes from the release its manifest entry names', same(await fetchModel('/lib/engine/t', 'a.nnue', n => notes.push(n)))
        && requested.includes(REL + 'engines-v1/a.nnue'), requested.filter(u => u.startsWith('https:')));
    ok('...with progress the panel can draw, ending at 100%', notes.includes('downloading a.nnue')
        && notes.includes(`mephisto-download a.nnue ${good.length} ${good.length}`), notes);
    ok('...and it is cached under that URL', store.has(REL + 'engines-v1/a.nnue'));
    const before = requested.length;
    ok('the second load comes from the cache, not the network', same(await fetchModel('/lib/engine/t', 'a.nnue'))
        && !requested.slice(before).some(u => u.startsWith('https:')), requested.slice(before));
    ok('a download with the wrong bytes is refused by sha256', await fails_with(fetchModel('/lib/engine/t', 'bad.nnue'), /SHA-256/));
    ok('...and not cached', !store.has(REL + 'engines-v1/bad.nnue'));
    ok('a download longer than the manifest size is cut off', await fails_with(fetchModel('/lib/engine/t', 'big.nnue'), /larger than/));
    store.set(REL + 'engines-v1/stale.nnue', tampered);
    ok('a corrupt cache entry is dropped and downloaded again', same(await fetchModel('/lib/engine/t', 'stale.nnue'))
        && Buffer.from(store.get(REL + 'engines-v1/stale.nnue')).equals(good));
    await fetchModel('/lib/engine/t', 'm.onnx');
    ok('a model keeps its own release tag (models-v1)', requested.includes(REL + 'models-v1/m.onnx'));
    ok('a file in no manifest is an error, not a guess', await fails_with(fetchModel('/lib/engine/t', 'nope.nnue'), /not in its engine manifest/));
    ok('releaseUrl takes a bare name and a <word>-vN tag only',
        releaseUrl('engines-v1', '../x.nnue') === null && releaseUrl('../v1', 'a.nnue') === null
        && releaseUrl('engines-v2', 'a.nnue') === REL + 'engines-v2/a.nnue');

    // the panel half: the move-line text for a download in progress
    const pj = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const dStart = pj.indexOf('function download_progress_text(');
    const dctx = vm.createContext({});
    vm.runInContext(pj.slice(dStart, pj.indexOf('\n}\n', dStart) + 2), dctx);
    const dl = (m) => vm.runInContext('download_progress_text', dctx)(m);
    ok('the panel turns a download note into a percentage of the size',
        dl('info string mephisto-download nn-1a298aa575a0.nnue 49255592 98511183')
            === 'Downloading nn-1a298aa575a0.nnue: 50% of 98.5 MB (first use only)',
        dl('info string mephisto-download nn-1a298aa575a0.nnue 49255592 98511183'));
    ok('...and leaves every other engine line alone', dl('info string NNUE evaluation using nn-1a298aa575a0.nnue') === null
        && dl('info depth 12 score cp 30') === null && dl({bestmove: 'e2e4'}) === null);

    console.log('\nchangelog (tools/changelog.mjs):');
    const cl = fs.readFileSync(ROOT + '/tools/changelog.mjs', 'utf8');
    const cctx = vm.createContext({});
    vm.runInContext(cl.slice(cl.indexOf('// ==== pure'), cl.indexOf('// ==== end pure ====')), cctx);
    const render = vm.runInContext('renderChangelog', cctx);
    const releases = [
        {tag_name: 'v3.1.2', name: 'v3.1.2 - two', body: '**two**\r\nChecks | 1\r\nHarness | 2', published_at: '2026-09-02T00:00:00Z'},
        {tag_name: 'models-v1', name: 'models', body: 'weights', published_at: '2026-09-01T00:00:00Z'},
        {tag_name: 'v3.1.10', name: 'v3.1.10 - ten', body: '# Big heading\nx', published_at: '2026-09-10T00:00:00Z'},
        {tag_name: 'v3.1.3', name: 'draft', draft: true, body: 'unreleased'},
    ];
    const archive = '# Archived release notes\n\nintro\n\n---\n\n## Mephisto 3.1.1 — old one\n\n*Tagged v3.1.1.*\n\n'
        + '## What\'s new since 3.1.0\n- a\n\n---\n\n## Second pass: releases nobody downloaded\n\nRemoved v3.1.0\n\n---\n\n'
        + '## v3.1.2 - archived copy\n\nstale text\n';
    const md = render(releases, archive);
    const heads = md.split('\n').filter(l => l.startsWith('## '));
    ok('newest first by version (10 before 2), live and archived merged',
        JSON.stringify(heads) === JSON.stringify(['## v3.1.10 - ten', '## v3.1.2 - two', '## Mephisto 3.1.1 — old one']), heads);
    ok('...a version on both sides is the live release, not the archive', !md.includes('stale text'));
    ok('...assets tags and drafts are not versions', !md.includes('weights') && !md.includes('unreleased'));
    ok('...an archived note\'s own "## What\'s new since 3.1.0" is demoted, not a second entry',
        md.includes("### What's new since 3.1.0"));
    ok('...release stats lines keep their line breaks', md.includes('Checks | 1  \nHarness | 2'));
    ok('with no archive (the local tree) it is the live releases alone',
        render(releases, '').split('\n').filter(l => l.startsWith('## ')).length === 2);
})().catch(e => { fails++; console.log('FAIL infra checks threw: ' + (e && e.stack || e)); });
// ==== END AGENT INFRA CHECKS ====

// ==== FIX CHECKS (3.1.318) ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ra = psrc.slice(psrc.indexOf('function request_automove('), psrc.indexOf('function request_automove(') + 1200);
    ok('a held position never sends a move to the page: request_automove returns on setup_fen before anything else',
       /\{\s*(\/\/[^\n]*\n\s*)*if \(setup_fen\) \{[^}]*return;\s*\}\s*if \(config\.puzzle_mode/.test(ra));
}
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = csrc.indexOf('function boardShowsBlack(');
    const c = vm.createContext({});
    vm.runInContext(csrc.slice(i, csrc.indexOf('\n}\n', i) + 3), c);
    // a fake chess.com board: pieces with square-FR classes at a screen y
    const board = (flipped, pieces) => ({classList: {contains: (k) => k === 'flipped' && flipped},
        querySelectorAll: () => pieces.map(([sq, top]) => ({className: `piece wp square-${sq}`, getBoundingClientRect: () => ({top})}))});
    const f = (b) => vm.runInContext('boardShowsBlack', c)(b);
    ok('coordinates hidden: White at the bottom reads white, Black at the bottom reads black, the flip class wins, one rank is unknown',
       f(board(false, [['52', 600], ['57', 100]])) === false && f(board(false, [['52', 100], ['57', 600]])) === true
       && f(board(true, [])) === true && f(board(false, [['11', 700], ['81', 700]])) === false && f(null) === false);
    ok('lichess without coordinates falls back to the board wrapper orientation-black class',
       /: !!getBoard\(\)\?\.querySelector\?\.\('\.cg-wrap'\)\?\.classList\.contains\('orientation-black'\)/.test(csrc));
}
(async () => {
    // THE OFFSCREEN HOST, executed on a simulated clock (the whole file, chrome stubbed): an engine
    // thrown away by the 5-minute abandon sweep comes back on its next command with its setoptions
    // replayed first; a client that pings keeps its search; one disposed on purpose stays gone.
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8').replace(/await import\(/g, 'await __imp(');
    let now = 0; const timers = [];
    const tick = () => new Promise(r => setImmediate(r));
    const mk = (fn, ms, iv) => { const t = {at: now + ms, fn, iv}; timers.push(t); return t; };
    const advance = async (ms) => { await tick(); const end = now + ms;
        for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break;
            now = t.at; if (t.iv) t.at += t.iv; else timers.shift(); t.fn(); await tick(); } now = end; };
    let listener, inits = 0; const got = [];
    const c = {console: {log() {}}, Date: {now: () => now},
        setTimeout: (f, ms) => mk(f, ms, 0), setInterval: (f, ms) => mk(f, ms, ms),
        clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        window: {close() {}},
        __imp: async () => ({default: async () => { inits++; const n = inits; const e = {uci: (l) => { got.push([n, l]); if (l === 'stop') e.listen('bestmove e2e4'); },
                                                         getRecommendedNnue: () => null, setNnueBuffer() {}}; return e; }}),
        chrome: {runtime: {sendMessage: () => {}, onMessage: {addListener: (f) => listener = f}}}};
    vm.createContext(c); vm.runInContext(src, c);
    const msg = (id, o) => listener({toOffscreen: true, clientId: id, ...o}, {}, () => {});
    msg('7', {cmd: 'init', engine: 'stockfish-11-hce'}); await advance(10);
    msg('7', {cmd: 'uci', line: 'setoption name MultiPV value 3'});
    msg('7', {cmd: 'uci', line: 'setoption name Threads value 2'});
    await advance(330000);                                    // silent for 5.5 minutes: abandoned
    msg('7', {cmd: 'uci', line: 'position startpos'}); msg('7', {cmd: 'uci', line: 'go depth 5'});
    await advance(50);
    const second = got.filter(([n]) => n === 2).map(([, l]) => l);
    ok('an abandoned engine respawns on its next command, setoptions replayed before the position',
       inits === 2 && second.join('|') === 'setoption name MultiPV value 3|setoption name Threads value 2|position startpos|go depth 5', second);
    // a pinging client keeps an infinite search past the 60 s lease
    msg('8', {cmd: 'init', engine: 'stockfish-11-hce'}); await advance(10);
    msg('8', {cmd: 'uci', line: 'go infinite'});
    for (let i = 0; i < 8; i++) { await advance(15000); msg('8', {cmd: 'ping'}); }
    ok('a client that pings keeps its search for 2 minutes (no stop from the host)',
       !got.some(([n, l]) => n === 3 && l === 'stop'));
    // disposed on purpose: a late command does not bring it back
    msg('7', {cmd: 'dispose'}); await advance(10);
    const before = inits;
    msg('7', {cmd: 'uci', line: 'go depth 5'}); await advance(50);
    ok('a client disposed on purpose is never respawned', inits === before);
    const esrc = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    ok('options-page engines ping for as long as they hold an engine, and stop on dispose',
       /this\.keepAlive = setInterval\([\s\S]{0,200}cmd: 'ping'/.test(esrc) && /dispose\(\) \{\s*clearInterval\(this\.keepAlive\)/.test(esrc));
})().catch(e => { fails++; console.log('FAIL offscreen lease checks threw: ' + (e && e.stack || e)); });
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('arrow layers: no innerHTML += (re-parses the layer) and no element-only clear loop (leaks text nodes)',
       !/\.innerHTML \+= /.test(psrc) && !/while \(\w+\??\.childElementCount\) \w+\.lastElementChild\.remove\(\)/.test(psrc)
       && /function clear_annotations\(\) \{\s*PANEL_ROOT\.getElementById\('move-annotations'\)\.replaceChildren\(\)/.test(psrc));
}
(async () => {
    // ensureOffscreen called twice while the document is still loading (the worker's own wake-up call
    // and the panel's request): the second caller must not resolve before the page has loaded.
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const bsrc = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const body = bsrc.slice(bsrc.indexOf('async function hasOffscreen()'), bsrc.indexOf('// Every cold start pays for this'));
    let doc = null;
    const chromeStub = {runtime: {getContexts: async () => (doc ? [{}] : [])},
        offscreen: {createDocument: async () => { if (doc) throw new Error('Only a single offscreen document may be created.');
            doc = 'loading'; await new Promise(r => setTimeout(r, 60)); doc = 'loaded'; }}};
    const ensure = new Function('chrome', 'console', body + '; return ensureOffscreen;')(chromeStub, {log() {}});
    const seen = [];
    const a = ensure().then(() => seen.push(doc));
    await new Promise(r => setTimeout(r, 10));
    const b = ensure().then(() => seen.push(doc));
    await Promise.all([a, b]);
    ok('two overlapping ensureOffscreen calls both resolve only once the document has loaded', seen.join(',') === 'loaded,loaded', seen);
})().catch(e => { fails++; console.log('FAIL ensureOffscreen race check threw: ' + (e && e.stack || e)); });
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const hp = psrc.slice(psrc.indexOf('function humanize_pick('), psrc.indexOf('\n}\n', psrc.indexOf('function humanize_pick(')));
    ok('Time Trouble zeroes Humanize\'s think (the override the page uses first), after every pacing rail',
       /if \(in_time_trouble\(\)\) think = 0;\s*return \{move, think: Math\.round\(think\)/.test(hp)
       && /function humanize_presearch_ms\(fen\) \{[\s\S]{0,200}in_time_trouble\(\)\) return null;/.test(psrc));
}
{
    // Auto Resign counts TURNS: the same position searched three times is one turn, not three.
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fnS = (n) => { const i = psrc.indexOf(`function ${n}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const i0 = psrc.indexOf('const END_GAME_STREAK'), i1 = psrc.indexOf('function auto_resign_cp()');
    const c = vm.createContext({console: {log() {}}, send_to_active_tab() {}, line_cp_ours: () => -950, game_fullmove: () => 30,
        tablebase_data: null, tablebase_category_for_us: () => null, TB_NOT_LOST: new Set()});
    vm.runInContext('var config = {auto_resign: true, auto_resign_cp: 900}; var last_eval = {}; var last_pos = {};'
        + psrc.slice(i0, i1).replace(/\blet (resign_streak|end_game_key)/g, 'var $1') + fnS('auto_resign_cp') + fnS('auto_draw_cp') + fnS('end_game_action') + fnS('maybe_end_game'), c);
    const at = (fen, moves) => { c.last_eval = {fen, lines: [{move: 'e2e4'}]}; c.last_pos = {moves}; return vm.runInContext('maybe_end_game()', c); };
    const same = [at('X w', 'e2e4 e7e5'), at('X w', 'e2e4 e7e5'), at('X w', 'e2e4 e7e5')];
    const turns = [at('Y w', 'a b c d'), at('Z w', 'a b c d e f')];
    ok('one position searched three times is one turn; the third DIFFERENT turn resigns', same.every(v => v === null) && turns[0] === null && turns[1] === 'resign', {same, turns});
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const w = psrc.slice(psrc.indexOf('function watch_config_changes()'), psrc.indexOf('function watch_config_changes()') + 12000);
    const br = (k) => { const i = w.indexOf(`if (key === '${k}'`); return i < 0 ? '' : w.slice(i, w.indexOf('resync_after_config_change = true;', i)); };
    const elo = br('elo'), m2 = w.slice(w.indexOf("if ((key === 'maia2_self_elo'"), w.indexOf("if ((key === 'maia2_self_elo'") + 600);
    { const c = vm.createContext({PANEL_BOOTED: true, reloads: 0, pending: [], clearTimeout: () => { c.pending.length = 0; }, setTimeout: (f) => c.pending.push(f), panel_reload: () => c.reloads++});
      vm.runInContext(psrc.slice(psrc.indexOf('const RESET_RELOAD_MS'), psrc.indexOf('function watch_config_changes()')), c);
      const burst = (n) => { c.reloads = 0; for (let i = 0; i < n; i++) vm.runInContext('reload_after_reset()', c); c.pending.splice(0).forEach(f => f()); return c.reloads; };
      const one = burst(40); c.PANEL_BOOTED = false; const shut = burst(1);
      ok('Restore Defaults reaches an open panel: a removed live key rebuilds it, once for a burst, never a closed one',
         one === 1 && shut === 0 && w.indexOf('reload_after_reset(); continue;') > 0 && w.indexOf('reload_after_reset(); continue;') < w.indexOf('JSON.parse(changes[key].newValue)')); }
    ok('an Elo change from the settings page reaches the open engine, stop sent BEFORE any setoption',
       elo && elo.indexOf('abandon_search()') >= 0 && elo.indexOf('abandon_search()') < elo.indexOf('setoption name UCI_LimitStrength')
       && /request_remote_configure\(cap/.test(elo)
       && m2.indexOf('abandon_search()') >= 0 && m2.indexOf('abandon_search()') < m2.indexOf('setoption name'));
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const r = psrc.slice(psrc.indexOf('function request_puzzle_solution('), psrc.indexOf('let puzzle_answered = null;'));
    ok('a puzzle-database hit for a deferred position re-enters on_new_pos, and never clears a newer deferral',
       /const ours = w && puzzle_key\(w\.fen\) === puzzle_key\(fen\);\s*if \(ours\) \{ puzzle_deferred = null;/.test(r)
       && /if \(ours\) \{ on_new_pos\(w\.fen, w\.startFen, w\.moves\); return; \}/.test(r)
       && !/\n\s*puzzle_deferred = null;\n\s*clearTimeout\(puzzle_defer_timer\);\n\s*puzzle_solutions/.test(r));
}
{
    // the Safety Net with mate lines: +0.5 on line 1, every other line gets us mated
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fnS = (n) => { const i = psrc.indexOf(`function ${n}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const c = vm.createContext({});
    vm.runInContext('var config = {safety_net: true, multiple_lines: 3, safety_net_drop: 10}; var turn = "w"; var net_last_full = null; var last_eval = {};'
        + fnS('win_percent') + fnS('line_cp_ours') + fnS('safety_net_set'), c);
    c.last_eval = {fen: 'F', lines: [{move: 'a1a2', score: 50}, {move: 'b1b2', mate: -3}, {move: 'c1c2', mate: -2}]};
    const set = vm.runInContext('safety_net_set()', c);
    ok('Safety Net: mated-in-N lines are counted, so one holding move among three is a real verdict, not "forced"',
       set && !set.forced && set.total === 3 && set.moves.join() === 'a1a2', set);
    c.last_eval = {fen: 'G', lines: [{move: 'd1d8', mate: 2}, {move: 'e1e2', score: 300}]};
    const win = vm.runInContext('safety_net_set()', c);
    ok('Safety Net: our own mating move is in the "holds" set', win && win.moves.includes('d1d8'), win);
}
{
    // a game whose first move is Black's: the blunder belongs to Black
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fnS = (n) => { const i = psrc.indexOf(`function ${n}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const c = vm.createContext({classify_history: () => []});
    vm.runInContext('var eval_history_game = null;' + fnS('accuracy_from_drop') + fnS('win_drop_label') + fnS('live_stats'), c);
    const blackFirst = vm.runInContext('live_stats([0.5, 0.9], "8/8/8/8/8/8/8/K1k5 b - - 0 1")', c);
    const whiteFirst = vm.runInContext('live_stats([0.5, 0.1], "startpos-ish w")', c);
    ok('live stats: Black moving first owns ply 0 (its blunder is Black\'s, White has no moves)',
       blackFirst.black.moves === 1 && blackFirst.black.blunder === 1 && blackFirst.white.moves === 0 && blackFirst.black.accuracy < 50, blackFirst.black);
    ok('live stats: a normal game is unchanged (White owns ply 0)', whiteFirst.white.moves === 1 && whiteFirst.white.blunder === 1, whiteFirst.white);
    ok('classify_history reads the mover from the board, not the ply parity', /const white = board\.turn\(\) === 'w';/.test(psrc));
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('session: the finished game is folded and its history cleared, and the live game always counts (no start-FEN "folded" check)',
       /session_note_game\(eval_history, eval_history_game, eval_history_side\);[\s\S]{0,400}eval_history = \[\];/.test(psrc) && !/session\.folded/.test(psrc));
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('four-player autoplay respects Manual Mode', /if \(ours && config\.autoplay && !config\.help_mode && !config\.manual_mode\) request_automove_4pc\(best\);/.test(psrc));
}
(async () => {
    // A tab our set believes attached (the post-restart reconciliation counts DevTools too) but Chrome
    // does not: the click attaches for real and goes through instead of failing for the session.
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const disp = b.slice(b.indexOf('const cdpDispatch = '), b.indexOf('\n});\n', b.indexOf('const cdpDispatch = ')) + 5);
    const att = b.slice(b.indexOf('function cdpAttach('), b.indexOf('\n}\n', b.indexOf('function cdpAttach(')) + 3);
    let really = false, sent = 0;
    const chromeStub = {runtime: {lastError: null}, debugger: {
        // lastError is scoped to each callback in Chrome, so the nested attach callback sees none
        attach: (t, v, cb) => { const prev = chromeStub.runtime.lastError; chromeStub.runtime.lastError = null; really = true; cb(); chromeStub.runtime.lastError = prev; },
        sendCommand: (t, m, p, cb) => { chromeStub.runtime.lastError = really ? null : {message: 'Debugger is not attached to the tab with id: 5.'}; if (really) sent++; cb(); chromeStub.runtime.lastError = null; }}};
    const run = new Function('chrome', 'setTimeout', 'clearTimeout',
        'let cdpPending = 0, cdpHung = 0, cdpCalls = 0, cdpTotalMs = 0, cdpWorstMs = 0, pacedCalls = 0, pacedTotalMs = 0;'
        + 'const CDP_HUNG_MS = 1e9, CDP_MOVE_ACK_MS = 1e9, ATTACH_SETTLE_MS = 0; const attached = new Set([5]), moveStalled = new Set();' + att + disp
        + 'return cdpDispatch({tabId: 5}, {type: "mousePressed"}).then(() => attached.has(5));');
    const stillAttached = await run(chromeStub, (f, ms) => setTimeout(f, ms), clearTimeout);
    ok('a stale "attached" tab re-attaches and the click goes through', really && sent === 1 && stillAttached, {really, sent});
})().catch(e => { fails++; console.log('FAIL cdp reattach check threw: ' + (e && e.stack || e)); });
(async () => {
    // A mouseMoved is only answered when the page paints a frame, so a tab that is not rendering (hidden,
    // minimised, covered) never answers one -- measured against a background tab on Chrome for Testing
    // 152, where mousePressed/mouseReleased on the same tab returned in 5-13 ms. Nothing rejected it, so
    // the click sequence parked until the window came back and then played the stale rest of itself.
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const region = b.slice(b.indexOf('const attached = new Set();'), b.indexOf('chrome.debugger.onDetach?.addListener'))
        .replace('CDP_MOVE_ACK_MS = 1000', 'CDP_MOVE_ACK_MS = ' + 'ACKMS')
        .replace('CDP_CLICK_GRACE_MS = 3000', 'CDP_CLICK_GRACE_MS = 40')
        .replace('ATTACH_SETTLE_MS = 450', 'ATTACH_SETTLE_MS = 0');
    ok('the sliced region really holds the click path (guards against the slice silently emptying)',
       /function cdpClick\(/.test(region) && /function cdpDrag\(/.test(region) && /function cdpMove\(/.test(region) && /CDP_MOVE_ACK_MS = ACKMS/.test(region));
    // A fake debugger. `hover` says how a mouseMoved behaves: 'never' (hidden tab: no reply),
    // 'slow' (answers after 150 ms), or 'fast'. Everything else answers at once. Late replies are real timers.
    function rig(hover, ackMs = 60) {
        const sent = [], chromeStub = {runtime: {lastError: null}, debugger: {
            attach: (t, v, cb) => cb(),
            sendCommand: (t, m, p, cb) => {
                sent.push(p.type + (p.type === 'mouseMoved' && p.buttons ? '*' : ''));
                if (p.type === 'mouseMoved' && hover === 'never') return;
                setTimeout(cb, p.type === 'mouseMoved' && hover === 'slow' ? 150 : 0);
            }}};
        const api = new Function('chrome', 'setTimeout', 'clearTimeout',
            'let cdpPending = 0, cdpHung = 0, cdpCalls = 0, cdpTotalMs = 0, cdpWorstMs = 0;'
            + 'const CDP_HUNG_MS = 1e9;' + region.replace('ACKMS', ackMs)
            + 'return {cdpClick, cdpDrag, moveStalled, pending: () => cdpPending};')(chromeStub, quiet, clearTimeout);
        return {sent, ...api};
    }
    // timers are unref'd: a never-answered command legitimately leaves its 1e9 ms "hung" timer behind
    const quiet = (f, ms) => { const t = setTimeout(f, ms); t.unref && t.unref(); return t; };
    const settle = (p) => Promise.race([p.then(() => 'resolved', e => 'rejected: ' + e.message), new Promise(r => setTimeout(() => r('HUNG'), 1500))]);

    let r = rig('never');
    const out1 = await settle(r.cdpClick(9, 100, 100, 200));
    ok('a click into a tab that never answers a mouseMoved still settles, and still presses and releases',
       out1 === 'resolved' && r.sent.includes('mousePressed') && r.sent.includes('mouseReleased'), {out1, sent: r.sent});
    ok('...only ONE hover went out (the path stopped at the first unanswered move)',
       r.sent.filter(t => t === 'mouseMoved').length === 1, r.sent);
    ok('...and the tab is remembered as not answering moves', r.moveStalled.has(9));
    r.sent.length = 0;
    const out2 = await settle(r.cdpClick(9, 120, 120, 200));
    ok('while a tab is not answering, the next click sends it NO hover at all (one unanswered command per tab, not one per retry)',
       out2 === 'resolved' && r.sent.join() === 'mousePressed,mouseReleased', {out2, sent: r.sent});
    r.sent.length = 0;
    await settle(r.cdpClick(9, 120, 120, 5));
    ok('...nor does the single-step snap click', r.sent.join() === 'mousePressed,mouseReleased', r.sent);

    r = rig('fast');
    await settle(r.cdpClick(4, 100, 100, 120));
    ok('a tab that is rendering keeps its full cursor path (the fix does not touch the visible case)',
       r.sent.filter(t => t === 'mouseMoved').length >= 3 && r.sent.slice(-2).join() === 'mousePressed,mouseReleased' && !r.moveStalled.has(4), r.sent);

    r = rig('slow', 5000);   // answers in 150 ms: inside the ack window, but past the click's 140 ms deadline
    const out3 = await settle(r.cdpClick(6, 100, 100, 100));
    ok('a click that was parked past its deadline is NOT pressed afterwards (no stale click on a board that moved on)',
       out3.startsWith('rejected') && /expired/.test(out3) && !r.sent.includes('mousePressed'), {out3, sent: r.sent});

    r = rig('never');
    const out4 = await settle(r.cdpDrag(8, 100, 100, 300, 300, 300));
    ok('a drag into a tab that never answers a move still settles and lets go of the button',
       out4 === 'resolved' && r.sent.includes('mousePressed') && r.sent[r.sent.length - 1] === 'mouseReleased', {out4, sent: r.sent});

    // a throw between press and release must not strand the held button
    const sent5 = [];
    let n = 0;
    const stub5 = {runtime: {lastError: null}, debugger: {attach: (t, v, cb) => cb(),
        sendCommand: (t, m, p, cb) => { sent5.push(p.type); n++;
            // the press succeeds, the next command fails
            stub5.runtime.lastError = n === 2 ? {message: 'Debugger is not attached to the tab with id: 3.'} : null;
            // report the failure only once: the re-attach retry in cdpDispatch must not mask it
            setTimeout(() => { cb(); stub5.runtime.lastError = null; }, 0); }}};
    const d5 = new Function('chrome', 'setTimeout', 'clearTimeout',
        'let cdpPending = 0, cdpHung = 0, cdpCalls = 0, cdpTotalMs = 0, cdpWorstMs = 0;'
        + 'const CDP_HUNG_MS = 1e9;' + region.replace('ACKMS', 60)
        + 'return cdpDrag;')(stub5, quiet, clearTimeout);
    // travel 0: press, (no moves), final land-move errors with a non-"not attached" failure
    stub5.debugger.sendCommand = (t, m, p, cb) => { sent5.push(p.type);
        stub5.runtime.lastError = p.type === 'mouseMoved' ? {message: 'Target closed.'} : null;
        setTimeout(() => { cb(); stub5.runtime.lastError = null; }, 0); };
    const out5 = await settle(d5(3, 100, 100, 300, 300, 0));
    await new Promise(r2 => setTimeout(r2, 30));
    ok('a drag that fails after the press sends a release (at the origin) before rejecting',
       out5.startsWith('rejected') && sent5.join() === 'mousePressed,mouseMoved,mouseReleased', {out5, sent5});

    ok('the unanswered-move bookkeeping is cleared when the debugger detaches',
       /moveStalled\.delete\(src\.tabId\)/.test(b.slice(b.indexOf('chrome.debugger.onDetach?.addListener'), b.indexOf('chrome.debugger.onDetach?.addListener') + 300)));
})().catch(e => { fails++; console.log('FAIL cdp hidden-tab check threw: ' + (e && e.stack || e)); });
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const u = fs.readFileSync(ROOT + '/src/scripts/updater.js', 'utf8');
    const inst = u.slice(u.indexOf('async function install('));
    const stagedLoop = inst.indexOf('await writeFile(staging, f.path, f.bytes);'), marker = inst.indexOf('await writeFile(staging, STAGED_MARKER');
    ok('updater: the staging marker is written after every staged file and before the backup',
       stagedLoop > 0 && marker > stagedLoop && marker < inst.indexOf('backupCurrent('));
    ok('updater: finishing and "interrupted update" both require the marker, and install exactly the files it lists',
       /pendingInstall\(\) \{[\s\S]{0,300}readFileAt\(staging, STAGED_MARKER\)/.test(u)
       && /finishStaged\([\s\S]{0,500}readFileAt\(staging, STAGED_MARKER\)[\s\S]{0,200}const \{version, paths\} = JSON\.parse/.test(u));
}
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = csrc.indexOf('function figurineSan(');
    const c = vm.createContext({}); vm.runInContext(csrc.slice(i, csrc.indexOf('\n}\n', i) + 3), c);
    const f = (a, b) => vm.runInContext('figurineSan', c)(a, b);
    const got = [f('N', 'f3'), f('Q', 'e8='), f('Q', 'e8=+'), f('N', 'exd8=#'), f('B', 'xe5+')];
    ok('figurine notation: the piece goes in front, except a promotion where it follows the "="',
       got.join(' ') === 'Nf3 e8=Q e8=Q+ exd8=N# Bxe5+', got);
}
{
    // the Python backend at 125% zoom: a CSS point scales by Chrome's zoom before the screen offset
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = csrc.indexOf('const BACKEND_RETRY_MS'), j = csrc.indexOf('\n}\n', csrc.indexOf('function toClickXY(')) + 3;
    const c = vm.createContext({window: {screenX: 100, screenY: 50, outerHeight: 1000, innerHeight: 720},
        config: {python_autoplay_backend: true}, page_zoom: 1.25, refreshPageZoom() {}, tabActive: () => true});
    vm.runInContext('var page_zoom = 1.25;' + csrc.slice(i, j), c);
    const got = vm.runInContext('toClickXY(400, 200)', c);
    // toolbar = 1000 - 720 * 1.25 = 100 screen px; x = 100 + 400*1.25, y = 50 + 100 + 200*1.25
    ok('Python backend: CSS coordinates scale by the page zoom before the window offset', got[0] === 600 && got[1] === 400, got);
    c.config.python_autoplay_backend = false;
    const cdp = vm.runInContext('toClickXY(400, 200)', c);
    ok('...and the CDP path stays in CSS pixels', cdp[0] === 400 && cdp[1] === 200, cdp);
}
{
    // the chess.js cache: same answers, one board per distinct input, a cached FALSE is still a hit
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const c = {console}; c.self = c; vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8') + ';self.LRU = LRU;', c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext('var config = {variant: "chess", move_notation: "san"}; var REAL = Chess; var BUILT = 0; Chess = function (v, f) { BUILT++; return new REAL(v, f); };'
        + psrc.slice(psrc.indexOf('// ONE REPLAY PER POSITION'), psrc.indexOf('let last_resync_at')), c);
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const a = [c.move_possible_here(START, 'e2e4'), c.move_possible_here(START, 'e2e5'), c.move_possible_here(START, 'e2e4'), c.move_possible_here(START, 'e2e5')];
    ok('chess cache: same answers (true, false), and a repeat of either builds no new board',
       a.join() === 'true,false,true,false' && vm.runInContext('BUILT', c) === 2, {a, built: vm.runInContext('BUILT', c)});
    vm.runInContext('config.variant = "atomic"', c);
    c.move_possible_here(START, 'e2e4');
    ok('...and the variant is part of the key (a new variant is a new board)', vm.runInContext('BUILT', c) === 3);
}
(async () => {
    // one Maia question per position in flight: ten frames asking the same thing send it once
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = psrc.indexOf('const human_inflight'), b = psrc.indexOf('async function threat_human_ask(');
    const c = vm.createContext({});
    vm.runInContext('var threat_human_cache = new Map(); var ASKED = 0; var release;'
        + 'function threat_human_ask(f) { ASKED++; return new Promise(r => { release = () => r({uci: "e7e5", prob: 0.5}); }); }'
        + psrc.slice(a, b), c);
    const ps = Array.from({length: 10}, () => c.threat_human_reply('F'));
    vm.runInContext('release()', c);
    const answers = await Promise.all(ps);
    ok('ten engine frames asking Maia about one position send ONE question and all get its answer',
       vm.runInContext('ASKED', c) === 1 && answers.every(x => x && x.uci === 'e7e5') && vm.runInContext('human_inflight.size', c) === 0,
       {asked: vm.runInContext('ASKED', c)});
})().catch(e => { fails++; console.log('FAIL human in-flight check threw: ' + (e && e.stack || e)); });
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function arrow_piece_src('), fn = psrc.slice(i, psrc.indexOf('\n}\n', i) + 3);
    const run = (inPage, assets) => { const c = vm.createContext({}); vm.runInContext(`var IS_CONTENT_SCRIPT = ${inPage}; var PANEL_ASSETS = ${JSON.stringify(assets)}; var config = {pieces: 'neo.png'};` + fn, c); return vm.runInContext('arrow_piece_src("wQ")', c); };
    const got = [run(true, {pieces: {wQ: 'data:image/png;base64,AA'}}), run(true, null), run(false, null)];
    ok('arrow piece images: in the page an inlined data URI or nothing, never a path the site would serve; the popup page keeps its path',
       got[0] === 'data:image/png;base64,AA' && got[1] === '' && got[2] === '/res/chesspieces/neo/wQ.png', got);
    ok('...and no drop/promotion arrow builds a /res/ path itself any more', !/const piecePath = `\/res\/chesspieces/.test(psrc));
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('a settings change on a held position re-drives that position instead of asking the page (which ignores it)',
       /if \(resync_after_config_change\) \{[\s\S]{0,700}if \(setup_fen\) on_new_pos\(setup_fen, setup_fen, ''\);\s*else request_fen\(\);/.test(psrc));
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const css = fs.readFileSync(ROOT + '/src/popup/popup.css', 'utf8');
    ok('set-up row: Flip board / Follow screen share the FEN box line, the message goes under them (no engine line hidden for it)',
       /#setup-fen-row \{\s*display: flex;/.test(css) && /#setup_fen_flip, #snap_follow \{\s*order: 1;/.test(css)
       && /#setup_fen_msg \{ order: 2; flex-basis: 100%; \}/.test(css) && !/#alt-lines:has\(~ #setup-fen-row/.test(css));
}
{
    // FormElement.setValue on a select writes ONLY Materialize's own display input, never a neighbour
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/util/FormElement.js', 'utf8').replace(/^export /m, '');
    const mk = (wrapper) => {
        const neighbour = {value: '61'}, shown = {value: ''};
        const parent = {classList: {contains: (k) => wrapper && k === 'select-wrapper'},
                        querySelector: (q) => q === 'input.select-dropdown' ? (wrapper ? shown : null) : neighbour};
        const sel = {options: [{value: 'time', innerText: 'Time per move'}], value: '', parentElement: parent, dispatchEvent() {}};
        const c = vm.createContext({console, Event: class {}, document: {getElementById: () => sel}});
        vm.runInContext(src + '; var fe = new FormElement("an_limit_kind", "", "select", "time"); fe.setValue("time");', c);
        return {neighbour: neighbour.value, shown: shown.value};
    };
    const bare = mk(false), styled = mk(true);
    ok('a browser-default select leaves the slider beside it alone; a styled one shows its option text',
       bare.neighbour === '61' && styled.shown === 'Time per move' && styled.neighbour === '61', {bare, styled});
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    ok('Settings: the tablebase mini selects are browser-default, so Materialize does not draw a second dropdown over them',
       /id="tb_download_men" class="set-mini-select browser-default"/.test(gh) && /id="tb_download_kind" class="set-mini-select browser-default"/.test(gh));
}
{
    const ok = (name, cond) => { if (cond) console.log('ok   ' + name); else { fails++; console.log('FAIL ' + name); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('an Elo change from the settings page moves the panel\'s own slider too', /if \(key === 'elo'\) sync_elo_slider\(\);/.test(psrc) && /function sync_elo_slider\(\) \{/.test(psrc));
}
{
    // issue 1: move 1 took over 5 s in 1+0 (Clock Mode budget + Humanize calling the start position tense)
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fnSrc = (name) => { const i = psrc.indexOf(`function ${name}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const c = vm.createContext({Date, Math});
    vm.runInContext(`var config = {clock_mode: true, mirror_mode: true}, opp_spend = null, premove_tracker = {moves: '', startFen: ''},
        last_eval = {fen: ''}, last_clocks = {mine: 60, theirs: 50, increment: 0, at: Date.now()};   // theirs lower: no catch-up cut
        const INITIAL_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', OPENING_MOVES = 8, OPENING_PACE_MS = 750;
        const MOVE_MARGIN = 150, FIRST_MOVE_SEARCH_MS = 100, FIRST_MOVE_PACE_MS = FIRST_MOVE_SEARCH_MS + MOVE_MARGIN;
        function mirror_ratio() { return 0.9; }
        ${['clock_aware', 'clock_budget_ms', 'clock_move_budget_ms', 'in_opening', 'first_move', 'paced_move_target_ms'].map(fnSrc).join('\n')}`, c);
    const run = (js) => vm.runInContext(js, c);
    const move1 = run(`paced_move_target_ms(${JSON.stringify(START)}).ms`);
    const AFTER_E4E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const move2 = run(`premove_tracker.moves = 'e2e4 e7e5'; premove_tracker.startFen = ${JSON.stringify(START)}; paced_move_target_ms(${JSON.stringify(AFTER_E4E5)}).ms`);
    const black1 = run(`premove_tracker.moves = 'e2e4'; premove_tracker.startFen = ${JSON.stringify(START)}; first_move('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')`);
    run(`premove_tracker.moves = ''; premove_tracker.startFen = ''`);
    const mid = run(`premove_tracker.moves = 'e2e4 e7e5'; premove_tracker.startFen = ${JSON.stringify(START)}; paced_move_target_ms('r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 4 12').ms`);
    const noList = run(`premove_tracker.moves = ''; in_opening('r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w - - 0 1')`);
    const fromPos = run(`premove_tracker.moves = 'e1e2'; premove_tracker.startFen = '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1'; in_opening('8/8/8/4k3/8/8/4K3/8 b - - 1 1')`);
    ok('the first moves of a From Position endgame are not an opening', fromPos === false);
    const mirrored = run(`opp_spend = 3; premove_tracker.moves = 'e2e4 e7e5'; premove_tracker.startFen = ${JSON.stringify(START)}; paced_move_target_ms(${JSON.stringify(AFTER_E4E5)}).ms`);
    const mirrored1 = run(`premove_tracker.moves = ''; paced_move_target_ms(${JSON.stringify(START)}).ms`);
    ok('1+0: move 1 is paced at FIRST_MOVE_PACE_MS, moves 2-7 at the opening pace, not the 2 s clock budget; move 12 still gets the budget',
       move1 === 250 && move2 === 750 && mid > 1900, {move1, move2, mid});
    ok('first_move: White\'s and Black\'s move 1 of a game from the start array, nothing else', black1 === true
       && run(`first_move(${JSON.stringify(START)})`) === true && run(`first_move('8/8/8/4k3/8/8/4P3/4K3 w - - 0 1')`) === false);
    ok('...and Mirror Time does not stretch move 1 to the opponent\'s spend', mirrored1 === 250, mirrored1);
    ok('a scrape with no move list is not "the opening" just because its FEN says move 1', noList === false);
    ok('a measured opponent spend still decides the pace in the opening after move 1 (Mirror Time)', mirrored === 2700, mirrored);
    ok('move 1 with Humanize or a clock mode: a FIRST_MOVE_SEARCH_MS search on our turn, no Humanize deviation, the reflex think',
       /if \(config\.autoplay && \(config\.humanize \|\| clock_aware\(\)\) && \(\(turn === 'w'\) \? 'white' : 'black'\) === our_side\(\)\s*&& first_move\(fen\)\) movetime = Math\.min\(movetime, FIRST_MOVE_SEARCH_MS\);/.test(psrc)
       && /const firstMove = !\(recapture \|\| forced\) && first_move\(fen\);\s*if \(config\.humanize && !recapture && !forced && !firstMove && /.test(psrc)
       && /if \(recapture \|\| forced \|\| firstMove\) kind = 'instant';/.test(psrc)
       && /if \(first_move\(fen\)\) return FIRST_MOVE_PACE_MS;/.test(psrc));
    ok('Humanize reels the opening off before it can call the start position tense',
       /const reelOff = !\(recapture \|\| forced\) && in_opening\(fen\);\s*if \(recapture \|\| forced \|\| firstMove\) kind = 'instant';\s*else if \(reelOff\) kind = 'quick';[\s\S]{0,400}kind = 'long'/.test(psrc));
    ok('Mirror Time marks the opponent clock on our turn too, so it does not need a scrape during theirs',
       /if \(turn === ourColor\) \{[\s\S]{0,1800}if \(last_clocks\?\.theirs != null\) opp_clock_mark = last_clocks\.theirs;\s*\} else \{\s*opp_turn_at = Date\.now\(\);\s*if \(opp_clock_mark == null/.test(psrc));
    {
        // the bookkeeping block itself, executed: a second pass over the same position keeps the spend
        const i = psrc.indexOf("const ourColor = (our_side() === 'white') ? 'w' : 'b';\n                if (last_eval.fen === fen)");
        const blk = psrc.slice(i, psrc.indexOf('// check BEFORE on_new_pos', i));
        const c2 = vm.createContext({});
        vm.runInContext(`var opp_spend = null, opp_clock_mark = 60, opp_turn_at = 0, last_clocks = {theirs: 50, increment: 0}, last_eval = {fen: 'A'}, turn = 'w';
            function our_side() { return 'white'; } function pass(fen) { ${blk} }`, c2);
        // increment unknown ("3 + 2" bot game): their 1.2 s think reads as 0 on the clock; the wall clock says 1.2
        const c4 = vm.createContext({Date: {now: () => c4.t}}); c4.t = 1000;
        vm.runInContext(`var opp_spend = null, opp_clock_mark = null, opp_turn_at = 0, last_clocks = {theirs: 180, increment: null}, last_eval = {fen: 'A'}, turn = 'b';
            function our_side() { return 'white'; } function pass(fen) { ${blk} }`, c4);
        vm.runInContext(`pass('B')`, c4);                                   // their turn starts
        c4.t = 2200; const wall = vm.runInContext(`turn = 'w'; last_clocks.theirs = 180.8; pass('C'); opp_spend`, c4);
        const known = vm.runInContext(`turn = 'b'; pass('D'); turn = 'w'; last_clocks = {theirs: 179.6, increment: 2}; pass('E'); opp_spend`, c4);
        ok('Mirror Time with an unknown increment measures their think on the wall clock (1.2 s, not 0); a known increment still uses the clock',
           Math.abs(wall - 1.2) < 1e-9 && Math.abs(known - 3.2) < 1e-9, {wall, known});
        const first = vm.runInContext(`pass('B'); opp_spend`, c2);
        const again = vm.runInContext(`last_eval.fen = 'B'; pass('B'); opp_spend`, c2);
        ok('Mirror Time: a resume of the same position keeps the measured spend (10 s stays 10 s, not 0)', first === 10 && again === 10, {first, again});
    }
    {
        // a cold engine: start-up chatter restarts the flush clock, so the owed stops still eat their zero-node bestmoves
        const i = psrc.indexOf('function on_engine_response(message) {');
        const head = psrc.slice(i, psrc.indexOf('last_info_at = Date.now();   // the panel is HEARING', i));
        const c3 = vm.createContext({console: {log() {}, warn() {}}, Date});
        vm.runInContext(`var pending_stops = 2, stop_charged_at = Date.now() - 5000, search_active = true, last_info_at = 0, passed = [];
            const STOP_FLUSH_MS = 1500; function is_remote() { return false; } function is_one_pass() { return false; } function note_unsupported_variant() {}
            function download_progress_text() { return null; } function update_best_move() {}
            ${head} passed.push(message); }`, c3);
        const got = vm.runInContext(`for (const m of ['info string nn.nnue downloaded', 'info depth 1 nodes 0', 'bestmove a2a3', 'info depth 1 nodes 0', 'bestmove a2a3', 'info depth 1 nodes 20', 'bestmove e2e4']) on_engine_response(m); passed`, c3);
        ok('a cold engine: the two zero-node bestmoves owed to abandoned searches are dropped, the real one gets through',
           JSON.stringify(got) === JSON.stringify(['info depth 1 nodes 20', 'bestmove e2e4']), got);
    }
}
{
    // 3.1.320: found by the fresh-install audit of the published zip
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const ids = (gh.match(/\bid="[^"]+"/g) || []), dup = ids.filter((v, i) => ids.indexOf(v) !== i);
    ok('Settings > General: no id appears twice (the page once shipped its last six sections two times)', dup.length === 0, dup.slice(0, 5));
    ok('Settings > General: each section heading appears once', (gh.match(/class="set-h"[^>]*>Puzzles</g) || gh.match(/>Puzzles<\/h3>/g) || []).length === 1);
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('async function request_remote_analysis('), fn = psrc.slice(i, psrc.indexOf('\n}\n', i) + 3);
    ok('the native analyse call declares everything it uses (nodes is a parameter; ourTurn is declared or absent)',
       /request_remote_analysis\(fen, time, moves = null, depth = null, nodes = null\)/.test(fn) && (!/\bourTurn\b/.test(fn) || /const ourTurn\b/.test(fn)));
    const css = fs.readFileSync(ROOT + '/src/popup/popup.css', 'utf8');
    ok('the panel palette is declared on :host too, so it exists inside the shadow root', /:root, :host \{\s*--mp-bg:/.test(css));
}
{
    // audit 3.1.319: chess.com positions with no last-move highlight
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const fnSrc = (name) => { const i = csrc.indexOf(`function ${name}(`); return csrc.slice(i, csrc.indexOf('\n}\n', i) + 3); };
    const at = (href) => { const u = new URL(href); const c = vm.createContext({URLSearchParams, location: {search: u.search, pathname: u.pathname}, site: 'chesscom'});
        vm.runInContext(fnSrc('chesscomUrlFenTurn') + fnSrc('isPuzzlePage'), c); return [vm.runInContext('chesscomUrlFenTurn()', c), vm.runInContext('isPuzzlePage()', c)]; };
    const b = at('https://www.chess.com/analysis?fen=r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R%20b%20KQkq%20-%203%203&tab=analysis');
    const none = at('https://www.chess.com/play/computer'), daily = at('https://www.chess.com/daily'), dg = at('https://www.chess.com/game/daily/123');
    ok('chess.com ?fen= with Black to move reads b; no fen reads null; /daily is a puzzle page and a daily GAME is not',
       b[0] === 'b' && none[0] === null && daily[1] === true && dg[1] === false && none[1] === false, {b, none, daily, dg});
    ok('the Daily Puzzle takes the side to move from the orientation, before the rated-puzzle rule',
       /\/\^\\\/daily\(-chess-puzzle\)\?\(\\\/\|\$\)\/\.test\(location\.pathname\)\) \{\s*return \(getOrientation\(\) === 'black'\) \? 'b' : 'w';/.test(csrc));
}
{
    // audit 3.1.319: lichess analysis tree with a sideline (real markup: <move p="..."> with two path characters per ply)
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const fnSrc = (name) => { const i = csrc.indexOf(`function ${name}(`); return csrc.slice(i, csrc.indexOf('\n}\n', i) + 3); };
    const run = (active, pathname = '/analysis') => {
        const mk = (san, p) => ({textContent: san, p, getAttribute: () => p});
        const nodes = [mk('e4', '/?'), mk('e5', '/?WG'), mk('1...c5', '/?UE'), mk('Nf3', '/?WG)8')];
        const tree = {querySelectorAll: () => nodes, querySelector: () => nodes.find(n => n.p === active) || null};
        const c = vm.createContext({document: {querySelector: () => tree}, location: {pathname}});
        vm.runInContext(fnSrc('hasSanText') + fnSrc('lichessTreePath'), c);
        const r = vm.runInContext('lichessTreePath()', c); return r && r.map(n => n.textContent).join(' ');
    };
    ok('lichess analysis: the moves scraped are the path to the active node (mainline, sideline, root), never document order',
       run('/?WG)8') === 'e4 e5 Nf3' && run('/?UE') === 'e4 1...c5' && run(null) === '' && run(null, '/training/123') === null,
       [run('/?WG)8'), run('/?UE'), run(null), run(null, '/training/123')]);
    ok('...and a sideline move is read from its <san>, not with its "1..." number', /const san = move\.querySelector\?\.\('san'\);/.test(csrc));
}
{
    // audit 3.1.319: lichess variants ran as standard chess; the Variant select left Stockfish loaded
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8'), psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const cfn = (name) => { const i = csrc.indexOf(`function ${name}(`); return csrc.slice(i, csrc.indexOf('\n}\n', i) + 3); };
    const pfn = (name) => { const i = psrc.indexOf(`function ${name}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const page = (metaHref, otherHref) => { const link = (h) => h ? {getAttribute: () => h} : null;
        const meta = metaHref === undefined ? null : {querySelector: () => link(metaHref)};
        const c = vm.createContext({site: 'lichess', location: {pathname: '/abc'}, document: {querySelector: (q) => q === '.game__meta' ? meta : link(otherHref)}});
        vm.runInContext(cfn('detectLichessVariant') + cfn('variantIsStated'), c);
        return [vm.runInContext('detectLichessVariant()', c), vm.runInContext('variantIsStated()', c)]; };
    ok('a lichess game header states its variant: Atomic, From Position and a plain standard game; a lobby link is only a guess',
       JSON.stringify([page('/variant/atomic'), page('/variant/fromPosition'), page(null), page(undefined, '/variant/horde')])
       === JSON.stringify([['atomic', true], ['chess', true], ['chess', true], ['horde', false]]),
       [page('/variant/atomic'), page('/variant/fromPosition'), page(null), page(undefined, '/variant/horde')]);
    // apply_detected_variant, executed: to a variant and back restores the engine that was loaded
    const c = vm.createContext({});
    vm.runInContext(`var store = {}, reloads = 0, config = {engine: 'stockfish-19-nnue'};
        const FAIRY_ENGINES = ['fairy-stockfish-14-nnue', 'fairy-native'];
        const MephistoConfig = {set: (k, v) => { store[k] = v; if (k === 'engine') config.engine = JSON.parse(v); }, get: (k) => store[k] ?? null};
        function panel_reload() { reloads++; } async function preferred_fairy_engine() { return 'fairy-stockfish-14-nnue'; }
        ${pfn('needs_fairy_engine')} ${psrc.slice(psrc.indexOf('async function apply_detected_variant('), psrc.indexOf('\n}\n', psrc.indexOf('async function apply_detected_variant(')) + 3)}`, c);
    vm.runInContext(`var out = []; (async () => { await apply_detected_variant('atomic'); out.push(config.engine); await apply_detected_variant('chess'); out.push(config.engine, JSON.parse(store.variant)); })()`, c);
    setTimeout(() => { const out = vm.runInContext('out', c);
        ok('choosing a variant loads the variant engine, and going back to standard chess restores the engine that was loaded',
           JSON.stringify(out) === JSON.stringify(['fairy-stockfish-14-nnue', 'stockfish-19-nnue', 'chess']), out); }, 20);
    ok('the Variant select goes through the same path as Detect', /if \(key === 'variant'\) return apply_detected_variant\(parse\(elem\.value\)\);/.test(psrc));
    ok('a drop the page cannot play is said on screen, not only in the console', /if \(\/\^\[PNBRQ\]@\/i\.test\(best\)\) \{\s*set_idle_reason\(/.test(psrc));
}
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('Manual Mode: neither premove path plays a move without the keypress',
       (psrc.match(/config\.help_mode \|\| config\.puzzle_mode \|\| config\.simon_says_mode \|\| config\.manual_mode\) return/g) || []).length === 2); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('Puzzle Mode: a resume (the move was never clicked) clears the sent-move record so it can be sent again',
       /if \(response\.resume\) puzzle_last_sent = \{key: null, at: 0\};\s*if \(last_eval\.fen !== fen/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('Puzzle Mode follows the page only from the visible tab', /if \(typeof document !== 'undefined' && document\.hidden\) return;\s*if \(onPuzzlePage === !!config\.puzzle_mode\)/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const live = psrc.slice(psrc.indexOf('const LIVE_CONFIG_KEYS = ['), psrc.indexOf('];', psrc.indexOf('const LIVE_CONFIG_KEYS = [')));
    const missing = ['grind_mode', 'grind_delay', 'accept_rematch', 'streamer_alert', 'puzzle_capture', 'puzzle_capture_cdp'].filter(k => !live.includes(`'${k}'`));
    ok('Grind Mode, its delay, Accept Rematch, the streaming notice and page-solution capture reach an open panel from the Settings page', missing.length === 0, missing);
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const rm = cs.slice(cs.indexOf('// --- ACCEPT A REMATCH'), cs.indexOf('setInterval(rematchTick, GRIND_POLL_MS);'));
    ok('Accept Rematch: only the opponent\'s glowing offer on lichess, only with the setting AND Autoplay on, re-checked after the pause',
       /const REMATCH_SITES = \{lichess: \(\) => document\.querySelector\('\.follow-up button\.rematch\.glowing'\)\};/.test(rm)
       && (rm.match(/!config\.accept_rematch \|\| !config\.autoplay/g) || []).length === 2
       && /const btn = rematchOffer\(\);\s*if \(!btn\) return;/.test(rm)
       && !/chesscom/.test(rm.slice(rm.indexOf('const REMATCH_SITES'))));
    ok('...the fallback click fires only while the offer still glows (a second click on an accepted rematch would be an offer of ours)',
       /if \(document\.contains\(btn\) && btn\.classList\.contains\('glowing'\)\) try \{ btn\.click\(\); \}/.test(rm));
    ok('...and Grind Mode stands down for an offered rematch', /if \(config\.accept_rematch && rematchOffer\(\)\) return;[^\n]*\n\s*const btn = grindNewGameButton\(\);/.test(cs)
       && /grindCancel\('the opponent offered a rematch'\);/.test(rm));
    ok('...off by default in the panel and on the Settings page',
       /accept_rematch: JSON\.parse\(MephistoConfig\.get\('accept_rematch'\)\) \|\| false,/.test(psrc)
       && /registerFormElement\('accept_rematch', 'Accept Rematch:', 'checkbox', false\)/.test(fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8'))); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const msrc = fs.readFileSync(ROOT + '/src/offscreen/maia.js', 'utf8');
    ok('Maia / Leela: a game that starts from a position gets its history filled with that position (lc0 fen fill), a normal game does not',
       /if \(fens\[0\]\.split\(' '\)\[0\] !== START\) while \(fens\.length < 8\) fens\.unshift\(fens\[0\]\);\s*history = fens\.reverse\(\)\.map\(parseFen\);/.test(msrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = psrc.indexOf('if (response.clocks) last_clocks = {...response.clocks, at: Date.now()};');
    const two = psrc.slice(i, psrc.indexOf('last_clocks = null;', i) + 19);
    const c = vm.createContext({Date: {now: () => c.t}}); c.t = 0;
    vm.runInContext(`var last_clocks = null; function push(response) { ${two} }`, c);
    const seq = (js) => vm.runInContext(js, c);
    seq('push({clocks: {mine: 60}})'); c.t = 1000; seq('push({})'); const brief = seq('!!last_clocks'); c.t = 5000; seq('push({})'); const gone = seq('last_clocks');
    ok('a clock that is gone stops pacing the next game: one clock-less push keeps it, a stale one drops it', brief === true && gone === null, {brief, gone}); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const bsrc = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    ok('the worker remembers which tabs have the panel open, and the page asks at boot and reopens it',
       /if \(msg\.panelState\) \{/.test(bsrc) && /if \(msg\.panelWasOpen\) \{/.test(bsrc)
       && /sendMessage\(\{panelWasOpen: true\}, \(r\) => \{\s*if \(chrome\.runtime\.lastError \|\| !r\?\.open \|\| overlayEl\(PANEL_OVERLAY_ID\)\) return;\s*toggleOverlay\(\);/.test(csrc));
    { // A CLOSED PANEL PRESSES NOTHING. The real ticks with every setting on: only the panel differs.
      const cut = (from, to) => csrc.slice(csrc.indexOf(from), csrc.indexOf(to));
      const c = vm.createContext({self: {MephistoPanel: {isBooted: () => c.panel}}, console: {debug() {}}, document: {contains: () => true}, bgLogAlways() {},
          chrome: {runtime: {sendMessage: () => c.pressed.push('rematch')}}, setTimeout: (f) => c.timers.push(f), clearTimeout() {},
          puzzleNextDelayMs: () => 0, puzzleNextButton: () => ({click: () => c.pressed.push('next'), getAttribute: () => ''}),
          grindNewGameButton: () => ({textContent: 'New'}), grindClick: () => c.pressed.push('grind'), grindCancel() {},
          rematchOffer: () => ({getBoundingClientRect: () => ({left: 0, top: 0, width: 1, height: 1}), classList: {contains: () => false}}),
          GRIND_SITES: {lichess: {box: () => ({})}}});
      vm.runInContext(`var site = 'lichess', config, grindSeenFollowUp, puzzleNextClicked, puzzleNextTimer, grindTimer, rematchTimer, REMATCH_PAUSE_MS = [0, 0], REMATCH_VERIFY_MS = 0;`
          + cut('function panelRunning() {', 'function schedulePush() {') + cut('function grindTick() {', 'setInterval(grindTick') + cut('function rematchTick() {', 'setInterval(rematchTick'), c);
      const pressedWith = (atStart, atFire) => {
          c.panel = atStart; c.pressed = []; c.timers = [];
          vm.runInContext(`grindSeenFollowUp = false; puzzleNextClicked = puzzleNextTimer = grindTimer = rematchTimer = null;
              config = {grind_mode: true, accept_rematch: false, autoplay: true, grind_delay: 0, puzzle_mode: true, puzzle_auto_next: true};
              maybeAdvancePuzzle(); grindTick(); config.accept_rematch = true; rematchTick(); config.accept_rematch = false;`, c);
          c.panel = atFire;
          const [puzzle, grind, rematch] = c.timers.splice(0);
          puzzle?.(); grind?.();
          vm.runInContext('config.accept_rematch = true;', c);   // on for Grind Mode it would stand aside for the offer
          rematch?.();
          return c.pressed.sort().join();
      };
      ok('with the panel open, Puzzle Next, Grind Mode and Accept Rematch press their buttons', pressedWith(true, true) === 'grind,next,rematch', pressedWith(true, true));
      ok('with the panel closed they press nothing', pressedWith(false, false) === '', pressedWith(false, false));
      ok('a panel closed during the wait calls the press off', pressedWith(true, false) === '', pressedWith(true, false)); }
    ok('closing the panel (toolbar, panic key or popup mode) is recorded, so it stays closed', (csrc.match(/notePanelState\('closed'\)/g) || []).length === 3);
    ok('the X in the title bar takes the same path: the count above passed while it only removed the panel',
       /querySelector\('\.mephisto-overlay-close'\)\.addEventListener\('click', \(\) => self\.MephistoContent\.closePanel\(\)\);/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ocss = fs.readFileSync(ROOT + '/src/options/options.css', 'utf8');
    ok('options pages: the pinned sidebar keeps its 210px inset at narrow widths', !/@media \(max-width: 992px\) \{\s*header, main, footer \{ padding-left: 0; \}/.test(ocss) && /header, main, footer \{ padding-left: 210px; \}/.test(ocss)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = psrc.indexOf("let mated = 'mate' in pvLine;"), blk = psrc.slice(i, psrc.indexOf('if (mated) {', i));
    const c = vm.createContext({}); c.self = c; vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    const run = (fen, pvLine) => { c.fen = fen; c.pvLine = pvLine; return vm.runInContext(`(() => { const config = {variant: 'chess'}, last_eval = {fen}; ${blk} return mated; })()`, c); };
    ok('a checkmate is a checkmate even when the engine sent no mate score; a stalemate is still a stalemate',
       run('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', {}) === true && run('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', {}) === false); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const c = vm.createContext({console}); c.self = c; c.window = c; c.globalThis = c;
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const sans = (pgn) => { const g = c.MephistoReviewCore.parsePgn(pgn); const one = Array.isArray(g) ? g[0] : (g.games ? g.games[0] : g); return one.moves.map(m => m.san).join(' '); };
    const z = sans('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0 Nf6 5. d3 0-0-0 *');
    const d = sans('[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1. ... e5 2. Nf3 1-0');
    ok('PGN reader: castling written with zeros and "1. ... e5" both load', z === 'e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 O-O-O' && d === 'e5 Nf3', {z, d}); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('Bot Move Delay, Draw Within and Contempt keep a value of 0 instead of falling back to the default',
       ['auto_draw_cp', 'bot_trick_delay', 'contempt_cp'].every(k => new RegExp(k + ": JSON\\.parse\\(MephistoConfig\\.get\\('" + k + "'\\)\\) \\?\\? ").test(psrc))); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ah = fs.readFileSync(ROOT + '/src/options/pages/settings/appearance/appearance.html', 'utf8');
    const themes = eval(psrc.match(/const BOARD_THEMES = (\[[^\]]*\]);/)[1]);
    const at = ah.indexOf('value="brown"'), sel = ah.slice(ah.lastIndexOf('<select', at), ah.indexOf('</select>', at));
    const offered = [...sel.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    ok('every board theme the Appearance page offers is one the panel applies', offered.length > 5 && offered.every(v => themes.includes(v)), offered.filter(v => !themes.includes(v))); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const src = fs.readFileSync(ROOT + '/src/options/util/FormElement.js', 'utf8').replace('export class', 'class');
    const el = {type: 'number', min: '100', max: '3190', step: '10', value: '', addEventListener() {}, dispatchEvent() {}};
    const c = vm.createContext({console, Event: class {}, document: {getElementById: () => el}});
    vm.runInContext(src + '; var fe = new FormElement("elo", "", "input", 1500);', c);
    const read = (v) => { el.value = v; return vm.runInContext('fe.getValue()', c); };
    ok('a typed number is read inside its field\'s min/max; empty reads as the default; a decimal step keeps decimals',
       read('4190') === '3190' && read('5') === '100' && read('') === '1500' && read('abc') === '1500' && read('1500.6') === '1501' && (el.step = '0.1', read('150.25') === '150.25'),
       [read('4190'), read('5'), read(''), read('1500.6')]); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const g = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const i = g.indexOf('    onResetConfigValues() {'), fn = g.slice(i, g.indexOf('\n    }\n', i));
    const missing = ['humanize_top', 'humanize_blunder', 'humanize_cp_second', 'humanize_cp_blunder', 'live_classify_which', 'hotkeys', 'hotkey_macros', 'ui_mode'].filter(k => !fn.includes(`'${k}'`));
    ok('Restore Defaults on General also clears what the page draws by hand: the Humanize mix and thresholds, chips, hotkeys, macros, Panel Style', i > 0 && missing.length === 0, missing); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const g = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    ok('Panel Style: the styled dropdown is rebuilt once the stored value has arrived', /sel\.value = ui_mode \|\| 'floating';[\s\S]{0,260}M\.FormSelect\.init\(sel\)/.test(g)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const src = fs.readFileSync(ROOT + '/src/options/util/SettingsPage.js', 'utf8').replace(/^import .*$/m, '').replace('export class', 'class');
    const run = async (file, have) => { const removed = [], set = {}, alerts = [];
        const c = vm.createContext({console, alert: (m) => alerts.push(m), chrome: {storage: {local: {get: async () => have}}},
            MephistoConfig: {set: (k, v) => { set[k] = v; }, remove: (k) => removed.push(k)}});
        c.self = c; vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8'), c);   // the registry the refusals are worded from
        vm.runInContext(src + '; class P extends SettingsPage { init() {} pullConfigValues() {} }; var page = new P();', c);
        c.file = {text: async () => JSON.stringify(file)}; await vm.runInContext('page.onImportConfigValues(file)', c);
        return {removed: removed.sort(), set: Object.keys(set).sort(), alerts: alerts.length, text: alerts[0]}; };
    (async () => {
        const a = await run({elo: '1800'}, {elo: '2000', help_mode: 'true', lichess_token: '"t"', session_totals: '{}', timings: [1, 2]});
        const b = await run({elo: 'abc'}, {help_mode: 'true'});
        ok('Import restores: a setting the file does not name goes back to default, records and the token stay; a value that is not JSON refuses the whole file',
           JSON.stringify({...a, text: 0}) === JSON.stringify({removed: ['help_mode'], set: ['elo'], alerts: 1, text: 0}) && b.set.length === 0 && b.removed.length === 0 && b.alerts === 1, {a, b});
        ok('...and the refusal is the coded one, naming the setting (MPH-S03)', /^MPH-S03: .*"elo"/.test(b.text), b.text);
    })(); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('changing Lines, Threads or Memory in the panel restarts the search so it applies now, stop first',
       /if \(!is_remote\(\) && \(key === 'threads' \|\| key === 'memory' \|\| key === 'multiple_lines'\)\) \{\s*abandon_search\(\);\s*search_same_position\(\);/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const pf = (name) => { const i = psrc.indexOf(`function ${name}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const c = vm.createContext({});
    vm.runInContext(`var config = {engine: 'stockfish-19-nnue', elo: 0}; const FULL_STRENGTH_ELO = 3200, ELO_RANGE = {'stockfish-19-nnue': [1320, 3190], 'old': [1350, 2850]}; ${pf('elo_stops')} ${pf('engine_elo')}`, c);
    const at = (engine, elo) => vm.runInContext(`config.engine = '${engine}'; config.elo = ${elo}; engine_elo()`, c);
    ok('the Elo sent to the engine is the stored cap inside that engine\'s own range: 1500 stays 1500, 100 becomes the floor, 3000 on a 2850 engine becomes 2850',
       at('stockfish-19-nnue', 1500) === 1500 && at('stockfish-19-nnue', 100) === 1320 && at('old', 3000) === 2850, [at('stockfish-19-nnue', 1500), at('stockfish-19-nnue', 100), at('old', 3000)]);
    ok('...and it is what every UCI_Elo send uses', !/UCI_Elo(": | value \$\{|: )config\.elo/.test(psrc) && (psrc.match(/engine_elo\(\)/g) || []).length >= 5); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('panel tooltips flip above the control, or are clamped, instead of running off the bottom', /const below = r\.bottom \+ 6;\s*tip\.style\.top = \(\(below \+ h > vh - 4 && r\.top - 6 - h >= 4\) \? r\.top - 6 - h/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const i = a.indexOf("if (['chess', 'fischerandom'].includes(anVariant())) {"), blk = a.slice(i, a.indexOf('const c = newChess(fenText);', i));
    const why = (fen) => { try { vm.runInNewContext(`const parts = ${JSON.stringify(fen.split(' '))}; const anVariant = () => 'chess'; ${blk}`); return ''; } catch (e) { return e.message; } };
    ok('Analysis: an impossible standard position is refused with a reason, a normal one loads',
       why('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') === '' && /king/.test(why('8/8/8/8/8/8/8/8 w - - 0 1'))
       && /pawn/.test(why('P3k3/8/8/8/8/8/8/4K3 w - - 0 1')) && /too many/.test(why('qqqqkqqq/qqqqqqqq/qq6/8/8/8/8/4K3 w - - 0 1'))); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const g = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    ok('a hotkey that already belongs to another action or macro is refused, and leaving the page ends a capture',
       /if \(owner && owner !== capturing\) \{\s*say\(/.test(g) && /addEventListener\?\.\('hashchange', \(\) => \{ capturing = null; \}\);/.test(g)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('Help Mode arrows are redrawn when the board moves, resizes or flips', /const key = JSON\.stringify\(\[arrows, region \|\| null, where\]\);/.test(csrc) && /where = \[Math\.round\(r\.left\), Math\.round\(r\.top\), Math\.round\(r\.width\), getOrientation\(\)\];/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ocss = fs.readFileSync(ROOT + '/src/options/options.css', 'utf8'), pcss = fs.readFileSync(ROOT + '/src/popup/popup.css', 'utf8');
    ok('keyboard focus is drawn on the options pages and the panel controls that had none',
       /main input:focus-visible,[\s\S]{0,200}outline: 2px solid var\(--mp-on\) !important;/.test(ocss) && /#quick-settings \.qs-tab:focus-visible,/.test(pcss)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('an Appearance change (pieces, board, coordinates, dark mode) rebuilds an open panel', /if \(\['pieces', 'board', 'coordinates', 'dark_mode'\]\.some\(k => k in changes[\s\S]{0,90}\{\s*return panel_reload\(\);/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const r = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    ok('Game Review: starting a run takes the previous game\'s report off the screen', /async function onRun\(\) \{[\s\S]{0,1500}?\['rv-report', 'rv-indicators',[^\]]*\]\) \$\(id\)\?\.classList\.add\('hidden'\);[\s\S]{0,1000}?if \(is4pcGame/.test(r)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = psrc.indexOf('function on_remote_error('), fn = psrc.slice(i, psrc.indexOf('\n}\n', i) + 3);
    // the real registry and the panel's real err_* helpers, so the line shown is the coded one
    const hs = psrc.indexOf('const err_line ='), helpers = psrc.slice(hs, psrc.indexOf('// Background-play tracing from the PANEL side', hs));
    const run = (err, native) => { const c = vm.createContext({console: {error() {}, warn() {}}, TypeError, String, Object, Error, RegExp}); c.self = c; c.err = err;
        vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8'), c);
        vm.runInContext(`var shown; function update_best_move(t) { shown = t; } function toggle_calculating() {} function uses_native() { return ${native}; } function uses_cloud() { return false; } function i18n(k, d) { return d; } ${helpers} ${fn}; on_remote_error(err)`, c); return c.shown; };
    ok('a Remote Engine that is not running says so, coded; any other error is shown as it is',
       /^MPH-E02: .*localhost:9090/.test(run(new TypeError('Failed to fetch'), false)) && run(new Error('boom'), false) === 'boom' && run(new TypeError('x'), true) === 'x'); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const lum = (h) => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bad = [];
    for (const f of ['/src/popup/popup.css', '/src/options/options.css']) { const css = fs.readFileSync(ROOT + f, 'utf8');
        const mutes = [...css.matchAll(/--mp-mute:\s*(#[0-9a-f]{6})/g)].map(m => m[1]);
        if (mutes.length !== 2 || ratio(mutes[0], '#ffffff') < 4.5 || ratio(mutes[1], '#16171b') < 4.5) bad.push(f + ' ' + mutes.join(',')); }
    ok('the muted text colour meets 4.5:1 on its background in both themes, in the panel and on the options pages', bad.length === 0, bad); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const rh = fs.readFileSync(ROOT + '/src/options/pages/review/review.html', 'utf8'), rc = fs.readFileSync(ROOT + '/src/options/pages/review/review.css', 'utf8');
    ok('Game Review: the study URL field is styled like its neighbours and "Review with" is as wide as its text',
       /id="rv_li_study" class="rv-input rv-study-url browser-default"/.test(rh) && /#rv_mode \{ width: 290px; max-width: none; \}/.test(rc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('the two title-bar hotkey hints are one size', /hk\.style\.cssText = HOTKEY_HINT_CSS;[\s\S]{0,260}hk\.style\.fontSize = '10\.5px';/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const dir = ROOT + '/src/i18n/locales/', bad = [];
    for (const f of fs.readdirSync(dir)) { const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'));
        for (const k of ['set.pieces', 'set.board', 'set.coordinates', 'set.dark_mode']) if (/[:：]\s*$/.test(j[k] || '')) bad.push(f + ' ' + k); }
    ok('Appearance labels carry no trailing colon in any language, like every other label', bad.length === 0, bad); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ocss = fs.readFileSync(ROOT + '/src/options/options.css', 'utf8');
    ok('Settings: the Local Tablebases label keeps its width and its controls wrap', /\.set-row:has\(#tb_choose\) > \.set-lbl \{ flex: 1 0 170px; \}/.test(ocss)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = psrc.indexOf('function set_move_countdown('), head = psrc.slice(i, psrc.indexOf('clearInterval(eta_timer);', i));
    const c = vm.createContext({});
    vm.runInContext(`var eta_target, eta_source, eta_category; function fresh_timing() { return {move_time: 400, move_variance: 400}; } ${head} }`, c);
    vm.runInContext('set_move_countdown(10000, "Clock Mode")', c);
    ok('the move countdown runs to when the move lands: the click time plus the average cursor travel (400 + 400/2 ms)', c.eta_target === 10600, c.eta_target); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const c = vm.createContext({console}); c.self = c; c.window = c; c.globalThis = c;
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c); vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const res = (pgn) => { const g = c.MephistoReviewCore.parsePgn(pgn); return (Array.isArray(g) ? g[0] : g).result; };
    ok('a PGN with no tags keeps the result written after its moves; a Result tag still wins', res('1. e4 e5 2. Nf3 1-0') === '1-0' && res('[Result "0-1"]\n\n1. e4 e5 1-0') === '0-1' && res('1. e4 e5') === '*',
       [res('1. e4 e5 2. Nf3 1-0'), res('1. e4 e5')]); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('a standard-only engine never keeps a variant: at boot, and when it is selected',
       /if \(NO_CHESS960_ENGINES\.includes\(config\.engine\) && config\.variant !== 'chess'\) \{\s*config\.variant = 'chess';/.test(psrc)
       && (/NO_CHESS960_ENGINES\.includes\(eng\)\) save\('variant', 'chess'\);/.test(psrc) || /const keeps960 = !FAIRY_ENGINES\.includes\(eng\) && !NO_CHESS960_ENGINES\.includes\(eng\);/.test(psrc))); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const osrc = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    ok('an open panel keeps its engine lease between moves',
       /setInterval\(\(\) => \{\s*if \(!PANEL_BOOTED\) return;\s*try \{ chrome\.runtime\.sendMessage\(\{toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'ping'\}\)/.test(psrc));
    // lines queued while the engine loads are the panel's own stops and gos: an init must NOT drop them,
    // or the bestmoves the panel is waiting to discard never come and it discards the real one instead
    ok('...and a client init keeps the lines queued for it', !/sticky\[clientId\] = \{\};[\s\S]{0,420}delete pending\[clientId\];\s*initEngine\(clientId/.test(osrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('the header turn switch follows every position, including one from the FEN box', /update_turn_badge\(fen\);\s*console\.log\("on_new_pos", fen, startFen, moves\);/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('a click on the panel title bar is not a drag: it neither moves nor undocks the panel', /if \(!dragMoved\) return;\s*\/\/ Dragging a docked panel is a request to undock it/.test(csrc) && /dragMoved = true;\s*wrap\.style\.left/.test(csrc));
    ok('a page restored from the back/forward cache rebuilds its panel', /addEventListener\('pageshow', \(e\) => \{\s*if \(!e\.persisted \|\| !overlayEl\(PANEL_OVERLAY_ID\)\) return;\s*removeOverlay\(\);\s*toggleOverlay\(\);/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('Maia-2 premove: the second client is initialised with the two ratings and rebuilt when either changes',
       /maiaLevel: level,\s*elos: \[config\.maia2_self_elo, config\.maia2_oppo_elo\]\}\); \} catch \(e\) \{ maia2 = null; return; \}/.test(psrc)
       && /\(config\.engine === 'maia2'\) \? `\$\{config\.maia2_self_elo\}\/\$\{config\.maia2_oppo_elo\}` : config\.maia_level/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // Human Reply and the Safety Net on their one shared client, executed: each gets the answer to ITS position
    const cut = (from, to) => { const a = psrc.indexOf(from); return psrc.slice(a, psrc.indexOf(to, a)); };
    const code = cut('let human_serial = Promise.resolve();', '// asked from the same branch that arms the threat arrow') + cut('async function safety_human_ask(fen) {', '// asked whenever the net is watching our turn');
    const c = vm.createContext({setTimeout, clearTimeout, Promise, Number});
    vm.runInContext(`var listeners = [], lastPos = '', threat_human_id = 'hr', threat_human_cache = new Map(), safety_human_cache = new Map();
        async function ensure_threat_human() {}
        const moveFor = {A: 'a2a3', B: 'b2b3'};
        const chrome = {runtime: {onMessage: {addListener: (f) => listeners.push(f), removeListener: (f) => { listeners = listeners.filter(x => x !== f); }},
            sendMessage: (m) => { if (m.line.startsWith('position fen ')) lastPos = m.line.slice(13);
                else { const pos = lastPos; setTimeout(() => { for (const l of [\`info depth 1 multipv 1 score cp 0 maiaprob 5000 pv \${moveFor[pos]}\`, \`bestmove \${moveFor[pos]}\`]) for (const f of [...listeners]) f({fromOffscreen: true, clientId: 'hr', kind: 'line', line: l}); }, 5); } }}};
        ${code}`, c);
    vm.runInContext('var got; Promise.all([threat_human_ask("A"), safety_human_ask("B")]).then(r => { got = r; })', c);
    // polled, not read once at 120 ms: the replies ride 5 ms timers that only start once the rest of the
    // suite's synchronous code is done, so a fixed wait failed whenever that took longer (a loaded box)
    const t0 = Date.now();
    const check = () => { const g = c.got;
        if (!g && Date.now() - t0 < 10000) { setTimeout(check, 20); return; }
        ok('Human Reply and the Safety Net each get the answer to their own position on the shared client',
           !!g && g[0] && g[0].uci === 'a2a3' && g[1].length === 1 && g[1][0].uci === 'b2b3', g); };
    setTimeout(check, 120); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const src = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const i = src.indexOf('    once(pred, timeoutMs, alive = null) {'), fn = src.slice(i, src.indexOf('\n    }\n', i) + 6).replace('    once(', 'function once(');
    let now = 0; const timers = []; const c = vm.createContext({Number, Promise, Math, Error,
        setTimeout: (f, ms) => { const t = {f, at: now + ms, on: true}; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; }});
    vm.runInContext(`var self = {waiters: new Set(), listeners: []}; ${fn}; var out = 'pending';
        once.call(self, m => m.kind === 'ready', 120000, m => /mephisto-download/.test(m.line || '')).then(() => { out = 'ready'; }, (e) => { out = e.message; });`, c);
    const tick = (to) => { now = to; for (const t of timers) if (t.on && t.at <= now) { t.on = false; t.f(); } };
    const say = (m) => { for (const f of c.self.listeners.slice()) f(m); };
    tick(100000); say({kind: 'line', line: 'info string mephisto-download nn.nnue 1 2'}); tick(200000); say({kind: 'line', line: 'info string mephisto-download nn.nnue 2 2'}); tick(250000); say({kind: 'ready'});
    setTimeout(() => ok('an options-page engine load times out on 120 s of silence, not 120 s of downloading', c.out === 'ready', c.out), 20);
    ok('a failed Human Reply load is forgotten so the next ask retries, and its timeout is reset by download progress',
       /mine\.catch\(\(\) => \{ if \(threat_human_ready === mine\) \{ threat_human_ready = null; threat_human_elo_loaded = null; \} \}\);/.test(psrc)
       && /mephisto-download\/\.test\(m\.line \|\| ''\)\) \{ clearTimeout\(timer\); timer = arm\(\); \}/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const u = fs.readFileSync(ROOT + '/src/scripts/updater.js', 'utf8');
    ok('Install finishes an interrupted update from its staged copy instead of starting over (which replaced the good backup)',
       /if \(staged && await readFileAt\(staged, STAGED_MARKER\)\) return finishStaged\(onStatus\);\s*const installed = await verifyFolder\(dir\);/.test(u)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    ok('Settings: the Engine dropdown is an ordinary row under an ordinary heading, in the wide column',
       /<h3 data-i18n="panel\.engine" class="set-h">Engine<\/h3>/.test(gh) && /<div class="set-ctl">\s*<select name="engine" id="engine_select">/.test(gh) && /<div class="col s12 m9 xl9">/.test(gh)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('the click path is warmed on the first position of a panel with Autoplay on, once', /if \(!clicker_warmed && config\.autoplay && !config\.help_mode && !config\.manual_mode && !config\.python_autoplay_backend\) \{\s*clicker_warmed = true;\s*try \{ chrome\.runtime\.sendMessage\(\{cdpWarm: true\}/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ocss = fs.readFileSync(ROOT + '/src/options/options.css', 'utf8');
    ok('the styled dropdowns on Settings show their arrow (in front of the filled box, and click-through)', /\.set-ctl \.select-wrapper \.caret \{ fill: var\(--mp-mute\); right: 8px; z-index: 1; pointer-events: none; \}/.test(ocss)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ocss = fs.readFileSync(ROOT + '/src/options/options.css', 'utf8');
    ok('Analysis number fields use the same monospace figures as the other stepper fields', /\.an-f input\[type=number\] \{ font-family: ui-monospace, Menlo, monospace !important; \}/.test(ocss)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const dir = ROOT + '/src/i18n/locales/', bad = [];
    const same = {'set.multiple_lines': 'panel.multi_lines', 'an.lines': 'panel.multi_lines', 'rv.lines': 'panel.multi_lines',
        'set.opening_explorer': 'panel.explorer', 'set.play_book_moves': 'panel.book_moves', 'set.endgame_tablebase': 'panel.tablebase'};
    for (const f of fs.readdirSync(dir)) { const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'));
        for (const k in same) if (j[k] !== j[same[k]]) bad.push(f + ' ' + k);
        for (const k of ['an.hash', 'rv.hash']) if (j[k] !== j['panel.memory'] + ' (MB)') bad.push(f + ' ' + k); }
    ok('the same setting has the same name in the panel, on Settings, on Analysis and in Game Review, in every language', bad.length === 0, bad.slice(0, 6)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // the two cached helpers, executed against the real chess.js: same answers as uncached, and computed once
    const fn = (name) => { const i = psrc.indexOf(`function ${name}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const c = vm.createContext({console}); c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8') + ';' + fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(`var config = {variant: 'chess'}, made = 0; const RealChess = Chess; Chess = function (...a) { made++; return new RealChess(...a); };
        const REASON_PIECE_CP = {p: 100, n: 320, b: 330, r: 500, q: 900, k: 0}, REASON_FORK_MIN = 320; const chess_memo = new LRU(512);
        ${fn('chess_memoized')} ${fn('pv_moves')} ${fn('biggest_hanging')} ${fn('biggest_hanging_now')} ${fn('forced_chain')} ${fn('forced_chain_now')}`, c);
    const cases = [['r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3', 'b'], ['rnb1kbnr/pppp1ppp/8/4p1q1/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', 'b'], ['8/8/8/4k3/8/8/4P3/4K3 w - - 0 1', 'w']];
    const same = cases.every(([fen, col]) => JSON.stringify(vm.runInContext(`biggest_hanging(${JSON.stringify(fen)}, '${col}')`, c)) === JSON.stringify(vm.runInContext(`biggest_hanging_now(${JSON.stringify(fen)}, '${col}')`, c)));
    const fcFen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', pv = 'a1a8 g8h7';
    const sameFc = JSON.stringify(vm.runInContext(`forced_chain(${JSON.stringify(fcFen)}, '${pv}', 3)`, c)) === JSON.stringify(vm.runInContext(`forced_chain_now(${JSON.stringify(fcFen)}, '${pv}', 3)`, c));
    const cost = vm.runInContext(`made = 0; for (let i = 0; i < 50; i++) { biggest_hanging(${JSON.stringify(cases[0][0])}, 'b'); biggest_hanging(${JSON.stringify(cases[2][0])}, 'w'); forced_chain(${JSON.stringify(fcFen)}, '${pv}', 3); } made`, c);
    ok('the hanging-piece and forced-line helpers give the same answers cached as uncached, and 150 repeat calls build no board at all', same && sameFc && cost === 0, {same, sameFc, cost}); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // the once-per-frame painter, executed on a fake clock: a burst paints once, a bestmove flushes first, a new position drops the stale paint
    const a = psrc.indexOf('const LINE_PAINT_MS = 16;'), code = psrc.slice(a, psrc.indexOf('// What the two branches of the', a));
    const timers = []; const c = vm.createContext({setTimeout: (f) => { const t = {f, on: true}; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; }});
    vm.runInContext(`var last_eval = {fen: 'A', lines: []}, paints = 0; function paint_lines() { paints++; } ${code}`, c);
    const fire = () => { for (const t of timers.splice(0)) if (t.on) { t.on = false; t.f(); } };
    const run = (js) => vm.runInContext(js, c);
    run('for (let i = 0; i < 245; i++) schedule_line_paint()'); const during = run('paints'); fire(); const burst = run('paints');
    run('schedule_line_paint(); flush_line_paint()'); const flushed = run('paints'); fire(); const noDouble = run('paints');
    run('schedule_line_paint(); last_eval.fen = "B"'); fire(); const stale = run('paints');
    ok('245 engine lines in one frame paint once; a bestmove paints what is pending first and only once; a paint for a position that is gone is dropped',
       during === 0 && burst === 1 && flushed === 2 && noDouble === 2 && stale === 2, {during, burst, flushed, noDouble, stale});
    ok('...and the bestmove branch flushes before deciding the move', /flush_line_paint\(\);[^\n]*\n\s*on_engine_best_move\(best, threat, true\);/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const man = JSON.parse(fs.readFileSync(ROOT + '/manifest.json', 'utf8'));
    const pages = ['about/about.html', 'getting-started/getting-started.html'].map(p => fs.readFileSync(ROOT + '/src/options/pages/' + p, 'utf8')).join('');
    ok('the extension\'s own links (toolbar menu, About, Getting Started) open this repository, not the one it was forked from',
       man.homepage_url === 'https://github.com/IchNukeDichWeg/Mephisto' && !/github\.com\/AlexPetrusca/.test(pages)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // Racing Kings as Black: lichess keeps that board White-side up, so our colour comes from the player's own (bottom) clock
    const a = csrc.indexOf('const CC_GAME_PATH ='), pc = csrc.slice(a, csrc.indexOf('function getOrientation()', a));
    const read = (site, cls) => { const c = vm.createContext({site, location: {pathname: '/analysis'}, isChesscomVariants: () => false, getMoveRecords: () => [], document: {querySelector: (q) => q === '.rclock-bottom' && cls ? {classList: {contains: (x) => cls.split(' ').includes(x)}} : null}}); vm.runInContext(pc, c); return vm.runInContext('playerColor()', c); };
    ok('the player colour is read off lichess\'s bottom clock, and is null off lichess or without a clock',
       read('lichess', 'rclock rclock-bottom rclock-black') === 'black' && read('lichess', 'rclock rclock-bottom rclock-white') === 'white' && read('lichess', null) === null && read('chesscom', 'rclock-black') === null);
    const b = psrc.indexOf('let page_side = null;'), os = psrc.slice(b, psrc.indexOf('\n}\n', b) + 3);
    const c = vm.createContext({}); vm.runInContext(`var setup_fen = null, turn = 'w', board = {orientation: () => 'white'}; ${os}`, c);
    const side = (ps, sf) => vm.runInContext(`page_side = ${JSON.stringify(ps)}; setup_fen = ${JSON.stringify(sf)}; our_side()`, c);
    ok('our_side() takes the page\'s colour over a board that is never turned round, falls back to the orientation, and a held position still answers for the side to move',
       side('black', null) === 'black' && side(null, null) === 'white' && side('black', 'x') === 'white');
    ok('...and every scrape the panel reads carries it', (csrc.match(/sendToPanel\(\{ dom: res, orient[^\n]*mine: playerColor\(\)/g) || []).length === 3 && /page_side = \(response\.mine === 'white'/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // three-check: Fairy wants "W+B" checks-left after the en-passant square; "+W+B" there shifted the move counters (start = mate in 6)
    for (const f of ['/src/options/pages/review/review.js', '/src/options/pages/analysis/analysis.js']) {
        const s = fs.readFileSync(ROOT + f, 'utf8'), a = s.indexOf('function threeCheckCounts(fen)');
        const c = vm.createContext({}); vm.runInContext(s.slice(a, s.indexOf('\n}\n', a) + 3), c);
        const t = (fen) => JSON.stringify(vm.runInContext(`threeCheckCounts(${JSON.stringify(fen)})`, c));
        const S = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
        ok(`${f.split('/').pop()}: three-check counters read as checks LEFT from both spellings, and stripped for chess.js`,
           t(S + ' 2+3 0 1') === JSON.stringify({left: {w: 2, b: 3}, fen: S + ' 0 1'}) && t(S + ' 0 1 +1+0') === JSON.stringify({left: {w: 2, b: 3}, fen: S + ' 0 1'})
           && t(S + ' 0 1') === JSON.stringify({left: {w: 3, b: 3}, fen: S + ' 0 1'}), [t(S + ' 2+3 0 1'), t(S + ' 0 1 +1+0')]);
        ok(`${f.split('/').pop()}: the engine FEN carries the counter without a leading plus`, /parts\.splice\(4, 0, `\$\{c?h?e?c?k?s?\.?w\}\+\$\{c?h?e?c?k?s?\.?b\}`\)/.test(s) && !/parts\.splice\(4, 0, `\+/.test(s));
    } }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // the move classifier is injected into the page and Read from Screen captures the tab: both need host access to the page itself,
    // which lichess never had (Refute + class badges dead there) and captureVisibleTab only accepts as <all_urls> or a fresh toolbar click
    const man = JSON.parse(fs.readFileSync(ROOT + '/manifest.json', 'utf8'));
    ok('host access covers every page the content script already runs on (<all_urls>), so injection and screen capture need no toolbar click',
       man.host_permissions.includes('<all_urls>') && man.content_scripts[0].matches.includes('<all_urls>')); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // a blunder into a mate in one is graded even though the engine reached the mate at depth 245 in one frame
    const a = psrc.indexOf('function classify_history()'), fnSrc = psrc.slice(a, psrc.indexOf('\n}\n', a) + 3);
    const c = vm.createContext({console: {log() {}}}); c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8') + ';' + fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(`var config = {variant: 'chess'}, premove_tracker = {startFen: '', moves: 'f2f3 e7e5 g2g4'}, move_class_key = '', move_classes = [], last_logged_class = [];
        const CLASSIFY_MIN_DEPTH = 10, CLASSIFY_DEPTH_SLACK = 4, TB_OVERRIDABLE = new Set(); function tb_held_the_result() { return false; } function ensure_classifier() {}
        var eval_seen = [true, true, true, true], eval_history = [0.52, 0.42, 0.44, 0.0];
        var ply_facts = [{fen: new Chess().fen(), lines: [{move: 'e2e4', score: 30}], depth: 25, ref: {frac: 0.52, depth: 25}},
                         {fen: 'x', lines: [{move: 'e7e5', score: -70}], depth: 25, ref: {frac: 0.42, depth: 25}},
                         {fen: 'x', lines: [{move: 'b1c3', score: -60}], depth: 26, ref: {frac: 0.44, depth: 26}},
                         {fen: 'x', lines: [{move: 'd8h4', score: -100000, mate: -1}], depth: 245, ref: {frac: 0.0, depth: 245}}];
        ${fnSrc}`, c);
    const cls = vm.runInContext('classify_history()', c);
    ok('2.g4?? into Qh4# is graded a blunder although the mate came in at depth 245 against 26 the ply before', cls[2] === 'blunder', cls);
    vm.runInContext("move_class_key = ''; ply_facts[3] = {fen: 'x', lines: [{move: 'd8h4', score: -900}], depth: 245, ref: {frac: 0.0, depth: 245}};", c);
    ok('...while two ordinary readings that far apart in depth stay ungraded, as before', vm.runInContext('classify_history()', c)[2] === null); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // ChessBase: squares start nMarginW inside the model's origin, the board ignores click-click, and a Puzzle Mode move (a one-move line) must not need a board ELEMENT
    const probe = fs.readFileSync(ROOT + '/src/scripts/cb-probe.js', 'utf8');
    const a = probe.indexOf('function curGeometry()'), geoSrc = probe.slice(a, probe.indexOf('\n    }\n', a) + 6);
    const c = vm.createContext({window: {V35s: {gameKernel: {boardWin: {x0: 34, y0: 94, nMarginW: 20, nSqPix: 82, blackIsBottom: false, singleClickDisabled: true},
        boardArea: {cbcanvas: {canvas: {width: 777, getBoundingClientRect: () => ({left: 1, top: 65, width: 777})}}}}}}});
    vm.runInContext(geoSrc, c);
    const g = vm.runInContext('curGeometry()', c);
    ok('the ChessBase board rectangle starts at the first square (origin + frame), and says the board takes drags only (measured live: x0 34, y0 94, frame 20)',
       g && g.x === 55 && g.y === 179 && g.size === 656 && g.dragOnly === true, g);
    ok('...a ChessBase move is dragged, and Puzzle Mode aims through the board geometry rather than a board element',
       /const mustDrag = isChesscomVariants\(\) \|\| \(site === 'chessbase' && !!cbGeometry\(\)\?\.dragOnly\);/.test(csrc)
       && /function simulatePvMoves\(pv, sessionGen = undefined\) \{[\s\S]{0,600}?if \(!clickableBoardBounds\(\)\)/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // Maia-2 never trained on the first 10 plies (upstream first_n_moves: 10, counted in plies): those go to Maia-3
    const m2 = fs.readFileSync(ROOT + '/src/offscreen/maia2.js', 'utf8');
    const a = m2.indexOf('export const MAIA2_FIRST_PLY'), code = m2.slice(a, m2.indexOf('\n}\n', a) + 3).replace(/export /g, '');
    const c = vm.createContext({}); vm.runInContext(code, c);
    const ply = (f) => vm.runInContext(`plyOfFen(${JSON.stringify(f)})`, c);
    ok('the ply of a position is read from its FEN: start 0, after 1.e4 1, white at move 6 = 10, black at move 5 = 9',
       ply('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') === 0 && ply('x b - - 0 1') === 1 && ply('x w - - 1 6') === 10 && ply('x b - - 0 5') === 9 && vm.runInContext('MAIA2_FIRST_PLY', c) === 10);
    ok('...and Maia-2 hands every ply below that to Maia-3 with both ratings, and frees it on terminate',
       /if \(plyOfFen\(board\.fen\(\)\) < MAIA2_FIRST_PLY\) \{[\s\S]*?createMaia3Engine\(listen, selfElo\)[\s\S]*?OppoElo value \$\{oppoElo\}[\s\S]*?net\.uci\('go'\);\s*return;/.test(m2) && /opening\?\.then\(net => net\.terminate\(\)\)/.test(m2)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    ok('an Analysis engine that fails to start stops saying "thinking…" in its column and its lines, and says why on the status line',
       /try \{ e = await ensureEngine\(\); \} catch \(err\) \{[\s\S]{0,500}?meta\.textContent = 'not running';[\s\S]{0,300}?an_engine_lines[\s\S]{0,300}?return status\(String\(err\.message \|\| err\), 'err'\);/.test(an)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // a set-up start keeps the PAGE's castling rights instead of every right the board could back (F7)
    const d0 = csrc.indexOf('const DEFAULT_POSITION ='), dEnd = csrc.indexOf(';', d0) + 1, f0 = csrc.indexOf('function fenToPuzString(fen)');
    const cc = vm.createContext({}); vm.runInContext(csrc.slice(d0, dEnd) + '\n' + csrc.slice(f0, csrc.indexOf('\n}\n', f0) + 3), cc);
    const puz = (fen) => vm.runInContext(`fenToPuzString(${JSON.stringify(fen)})`, cc);
    ok('the page\'s castling field rides along with a set-up start, and the standard start keeps its plain form',
       puz('4k3/8/8/8/8/8/8/R3K3 w - - 0 1').endsWith('cr--*****') && puz('r3k3/8/8/8/8/8/8/R3K3 w Qq - 0 1').endsWith('cr-Qq*****')
       && puz('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') === vm.runInContext('DEFAULT_POSITION', cc));
    const c = vm.createContext({console}); c.self = c; vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    const a = psrc.indexOf('function apply_page_rights('), b = psrc.indexOf('\n}\n', psrc.indexOf('function apply_castling_rights(')) + 3;
    vm.runInContext("var config = {variant: 'chess'};" + psrc.slice(a, b), c);
    const pr = (fen, rights) => vm.runInContext(`apply_page_rights(apply_castling_rights(${JSON.stringify(fen)}), ${JSON.stringify(rights)})`, c);
    ok('...and the panel narrows the board\'s guess to it: "R3K3 w - -" stays without Q, "Qq" keeps only what the page lists, no token keeps the guess',
       pr('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', '-').split(' ')[2] === '-' && pr('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1', 'Qq').split(' ')[2] === 'Qq'
       && pr('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', null).split(' ')[2] === 'Q', [pr('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', '-'), pr('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1', 'Qq')]);
    ok('...the piece parse reads the cr- token', /if \(token\.startsWith\('cr-'\)\) \{ pageRights = token\.slice\(3\); continue; \}/.test(psrc) && /apply_page_rights\(apply_castling_rights\(chess\.fen\(\)\), pageRights\)/.test(psrc));
}
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // a tablebase answer with no distance is not "DTZ 0" (F8)
    const t0 = psrc.indexOf('const TB_FLIP ='), t1 = psrc.indexOf('\n}\n', psrc.indexOf('function tablebase_label()')) + 3;
    const tc = vm.createContext({}); vm.runInContext(`var tablebase_data = null, last_eval = {fen: 'F w - - 0 1'}; function our_side() { return 'white'; } function i18n(k, d, v) { return String(d).replace(/\\{(\\w+)\\}/g, (m, x) => v && x in v ? v[x] : m); } ${psrc.slice(t0, t1)}`, tc);
    const lab = (o) => vm.runInContext(`tablebase_data = Object.assign({fen: 'F w - - 0 1'}, ${JSON.stringify(o)}); tablebase_label()`, tc);
    ok('a tablebase answer with no distance reads "winning" / "losing", never "DTZ 0"; a real DTZ still shows',
       lab({category: 'win', dtz: null, dtm: null}) === 'Tablebase: winning' && lab({category: 'loss', dtz: null}) === 'Tablebase: losing'
       && lab({category: 'win', dtz: 13}) === 'Tablebase: winning, DTZ 13' && lab({category: 'cursed-win', dtz: null}) === 'Tablebase: winning (50-move drawn)',
       [lab({category: 'win', dtz: null}), lab({category: 'cursed-win', dtz: null})]);
    const loc = (l) => JSON.parse(fs.readFileSync(ROOT + `/src/i18n/locales/${l}.json`, 'utf8'));
    ok('...in all 14 languages', fs.readdirSync(ROOT + '/src/i18n/locales').every(f => { const d = loc(f.replace('.json', '')); return ['panel.tb.win', 'panel.tb.loss', 'panel.tb.cursed_nodtz'].every(k => typeof d[k] === 'string' && !/DTZ|\{n\}/.test(d[k])); })); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('Session Stats times a move from the start of our turn, plus the delay still to come, not the configured think alone',
       /our_turn_at = Date\.now\(\);\s*\/\/ THEIR CLOCK IS FROZEN/.test(psrc) && /const searched = our_turn_at \? Math\.max\(0, Date\.now\(\) - our_turn_at\) : 0;[\s\S]{0,400}?session_note_move\(Number\.isFinite\(delay\) \? searched \+ delay : \(searched \|\| delay\)\);/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // PV walk: two steps forward from the page's own position, then back twice, must land on the position it started from
    const a = psrc.indexOf('let panel_line = [];'), code = psrc.slice(a, psrc.indexOf('\n}\n', psrc.indexOf('function pv_walk_forward()')) + 3);
    const c = vm.createContext({console}); c.self = c; vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    const START = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 8';
    vm.runInContext(`var config = {variant: 'chess'}, setup_fen = null, turn = 'w', prev_ply_count = 0, shown = [];
        var last_eval = {fen: ${JSON.stringify(START)}, lines: [{pv: 'd4c5'}]};
        var PANEL_ROOT = {getElementById: () => null}; var board = {position() {}};
        function i18n(k, d) { return d; } function setup_fen_msg() {} function abandon_search() {} function update_turn_badge() {} function render_panel_line() {}
        function pv_moves(pv) { return String(pv || '').split(' ').filter(Boolean); }
        function on_new_pos(fen) { shown.push(fen); last_eval = {fen, lines: [{pv: fen.includes(' b ') ? 'e7c5' : 'b2b4'}]}; }
        ${code}`, c);
    const r = vm.runInContext(`pv_walk_forward(); pv_walk_forward(); const b1 = pv_walk_back(); const b2 = pv_walk_back(); const b3 = pv_walk_back();
        JSON.stringify({b1, b2, b3, at: setup_fen, idx: panel_line_idx})`, c);
    const got = JSON.parse(r);
    ok('the PV walk steps back to the position it started from on the page, and a further step back is left to the site',
       got.b1 && got.b2 && got.b3 === false && got.idx === -1 && got.at === START, got); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // a set-up position keeps the page's move counters (F4)
    const d0 = csrc.indexOf('const DEFAULT_POSITION ='), dEnd = csrc.indexOf(';', d0) + 1, f0 = csrc.indexOf('function fenToPuzString(fen)');
    const cc = vm.createContext({}); vm.runInContext(csrc.slice(d0, dEnd) + '\n' + csrc.slice(f0, csrc.indexOf('\n}\n', f0) + 3), cc);
    const puz = (fen) => vm.runInContext(`fenToPuzString(${JSON.stringify(fen)})`, cc);
    ok('the page\'s move counters ride along with a set-up start; "0 1" and the standard start add nothing',
       puz('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 8').endsWith('mc-0-8*****')
       && !puz('4k3/8/8/8/8/8/8/R3K3 w - - 0 1').includes('mc-') && !puz('4k3/8/8/8/8/8/8/R3K3 w -').includes('mc-')
       && puz('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') === vm.runInContext('DEFAULT_POSITION', cc));
    const a = psrc.indexOf('function apply_page_counters('), b = psrc.indexOf('\n}\n', a) + 3;
    const c = vm.createContext({}); vm.runInContext(psrc.slice(a, b), c);
    const pc = (fen, mc) => vm.runInContext(`apply_page_counters(${JSON.stringify(fen)}, ${JSON.stringify(mc)})`, c);
    ok('...and the panel writes them back: "0 8" restored, ep square forces halfmove 0, no token or junk leaves the FEN alone',
       pc('8/8/8/4k3/8/8/8/4K2R w - - 0 1', ['12', '40']) === '8/8/8/4k3/8/8/8/4K2R w - - 12 40'
       && pc('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', ['5', '30']) === '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 30'
       && pc('8/8/8/4k3/8/8/8/4K2R w - - 0 1', null) === '8/8/8/4k3/8/8/8/4K2R w - - 0 1' && pc('8/8/8/4k3/8/8/8/4K2R w - - 0 1', ['x', '0']) === '8/8/8/4k3/8/8/8/4K2R w - - 0 1');
    ok('...the piece parse reads the mc- token last, after the ep square', /if \(token\.startsWith\('mc-'\)\) \{ pageCounters = token\.slice\(3\)\.split\('-'\); continue; \}/.test(psrc)
       && /apply_page_counters\(apply_ep_square\(apply_page_rights\(apply_castling_rights\(chess\.fen\(\)\), pageRights\), lastMove\), pageCounters\)/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // the 4PC engine follow switches OUTSIDE the caller's stack, once (F6)
    const a = psrc.indexOf('let fourpc_prev_engine = null;'), b = psrc.indexOf('\n}\n', psrc.indexOf('function sync_fourpc_engine_to_page(')) + 3;
    const timers = [], c = vm.createContext({console: {log() {}}, Event: class {}, setTimeout: (f) => timers.push(f)});
    vm.runInContext(`var FOURPC_ENGINES = ['tetrarch-native'], FOURPC_FALLBACK_ENGINE = 'stockfish-18-nnue', config = {engine: 'tetrarch-native'}, fired = 0;
        function is_fourpc_engine() { return FOURPC_ENGINES.includes(config.engine); }
        var sel = {value: 'tetrarch-native', dispatchEvent() { fired++; config.engine = sel.value; }};
        var PANEL_ROOT = {getElementById: () => sel}; ${psrc.slice(a, b)}`, c);
    vm.runInContext('sync_fourpc_engine_to_page(false); sync_fourpc_engine_to_page(false);', c);
    const sync = vm.runInContext('fired', c), queued = timers.length; timers.forEach(f => f());
    ok('leaving 4-player chess switches the engine after the caller returns, and two polls queue one switch',
       sync === 0 && queued === 1 && vm.runInContext('fired', c) === 1 && vm.runInContext('config.engine', c) === 'stockfish-18-nnue', {sync, queued, fired: vm.runInContext('fired', c)}); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // Compare nets asks Maia-1 only for a band it has (F15)
    const asrc = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8'), esrc = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const bands = esrc.match(/const MAIA_BANDS = (\[[^\]]*\]);/)[1];
    const a = asrc.indexOf('function nearestMaia1Band('), b = asrc.indexOf('\n}\n', a) + 3;
    const c = vm.createContext({}); vm.runInContext(`var MAIA_BANDS = ${bands}; ${asrc.slice(a, b)}`, c);
    const nb = (r) => vm.runInContext(`nearestMaia1Band(${JSON.stringify(r)})`, c);
    const got = [nb('2600'), nb('2000'), nb('2100'), nb('1500'), nb('600'), nb('x')];
    ok('Compare nets plays Maia-1 at its nearest shipped band: 2600->2200, 2000->1900, 2100->2200, a band stays itself, 600->1100',
       JSON.stringify(got) === JSON.stringify(['2200', '1900', '2200', '1500', '1100', '1100']), got);
    ok('...the Maia-2 column says when it is Maia-3\'s opening answer, on the same ply limit as offscreen/maia2.js',
       asrc.match(/const MAIA2_FIRST_PLY = (\d+);/)[1] === fs.readFileSync(ROOT + '/src/offscreen/maia2.js', 'utf8').match(/export const MAIA2_FIRST_PLY = (\d+);/)[1]
       && /net\.id === 'maia2' && fenPly\(pos\.fen\) < MAIA2_FIRST_PLY\) \? `\$\{net\.label\} \(Maia-3 in the opening\)`/.test(asrc));
    ok('...and the column is labelled with the band it actually played', /const netBand = net\.id === 'maia' \? nearestMaia1Band\(band\) : band;/.test(asrc) && /maiaLevel: netBand,\s*elos: \[netBand, netBand\]/.test(asrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // a finished position is never sent to a cloud engine (F5: chess-api.com errors on it)
    const a = psrc.indexOf('    if (uses_cloud()) {', psrc.indexOf('async function request_remote_analysis(')), seg = psrc.slice(a, psrc.indexOf('cloudAnalyse', a));
    ok('the cloud path answers a position with no legal move itself, as bestmove (none), before asking the provider',
       /if \(!new Chess\(config\.variant, target\)\.moves\(\)\.length\) return \{bestmove: '\(none\)', threat: '\(none\)', lines: \[\]\};/.test(seg)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // an engine that is not installed / not started is a warning, a real failure stays an error (F5)
    const a = psrc.indexOf('function on_remote_error(err) {'), b = psrc.indexOf('\n}\n', a) + 3;
    const log = [], c = vm.createContext({TypeError, String, console: {warn: (...x) => log.push('warn ' + x.join(' ')), error: (...x) => log.push('error ' + x.join(' '))}});
    vm.runInContext(`var native = false; function uses_native() { return native; } function uses_cloud() { return false; }
        function i18n(k, d) { return d; } function err_line(code) { return code; } function err_code_line() { return null; }
        function update_best_move() {} function toggle_calculating() {} ${psrc.slice(a, b)}`, c);
    vm.runInContext(`on_remote_error(new TypeError('Failed to fetch')); native = true;
        on_remote_error(new Error('Stockfish 19 (native) native host unavailable (Specified native messaging host not found.)'));
        on_remote_error(new Error('Native engine: engine process died'));
        on_remote_error(Object.assign(new Error('MPH-E01: x'), {code: 'MPH-E01'}));`, c);
    ok('a Remote Engine nobody started and an uninstalled native host (also when it arrives as MPH-E01) log warnings; a native engine that died logs an error',
       log.length === 4 && log[0].startsWith('warn') && log[1].startsWith('warn') && log[2].startsWith('error') && log[3].startsWith('warn'), log); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // nothing is searched on the old rules while a detected variant waits for its reload, and the reopen clears the hold
    const init = psrc.slice(psrc.indexOf('async function initPanel('), psrc.indexOf('await MephistoConfig.init();'));
    const onp = psrc.slice(psrc.indexOf('function on_new_pos('), psrc.indexOf('if (puzzle_db_enabled() && !puzzle_have', psrc.indexOf('function on_new_pos(')));
    ok('a detected variant holds the search until the panel reopens on the right engine, and the reopen releases it',
       /variant_switch_pending = true;\s*abandon_search\(\);\s*setTimeout\(\(\) => apply_detected_variant\(v\), 500\);/.test(psrc)
       && /if \(variant_switch_pending\) \{ abandon_search\(\); return; \}/.test(onp) && /variant_switch_pending = false;/.test(init)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // no search is sent into a WASM engine that is still loading; initialize_engine drives it after the preamble
    const init = psrc.slice(psrc.indexOf('async function initialize_engine('), psrc.indexOf('engine_ready = true;', psrc.indexOf('async function initialize_engine(')));
    ok('a position that arrives while the WASM engine loads is held, not searched, and the init drives it after ucinewgame/isready',
       /\} else if \(wasm_engine_loading\) \{[\s\S]{0,600}?wasm_search_held = true;\s*\} else \{/.test(psrc)
       && /wasm_engine_loading = true;\s*try \{ await ensure_offscreen_engine\(config\.engine\); \}\s*catch \(e\) \{ wasm_search_held = false; throw e; \}\s*finally \{ wasm_engine_loading = false; \}/.test(init)
       && /send_engine_uci\('isready'\);[\s\S]*const held = wasm_search_held;\s*wasm_search_held = false;\s*if \(\(search_was_live \|\| held\) && last_eval\.fen\)/.test(init)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // Auto-Next on lichess Training: Continue after the end, View the solution after a wrong move, nothing mid-puzzle or on Storm
    const a = csrc.indexOf('const LICHESS_TRAINING_RE'), b = csrc.indexOf('\n}\n', csrc.indexOf('function lichessTrainingButton()')) + 3;
    const btn = (id) => ({id, disabled: false, offsetWidth: 10, offsetHeight: 10});
    const run = (path, state) => { const c = vm.createContext({site: 'lichess', location: {pathname: path}, document: {
            querySelector: (sel) => state === 'after' && sel === '.puzzle__feedback.after button.continue' ? btn('continue') : null,
            querySelectorAll: (sel) => state === 'fail' && sel === '.puzzle__feedback.fail .view_solution button' ? [btn('hint'), btn('solution')] : []}});
        vm.runInContext(csrc.slice(a, b), c); return vm.runInContext('lichessTrainingButton()', c)?.id ?? null; };
    const got = [run('/training', 'after'), run('/training/mix', 'fail'), run('/training/aBc12', 'play'), run('/storm', 'after'), run('/training/', 'after')];
    ok('lichess Training: Continue once a puzzle is over, View the solution after a wrong move, nothing mid-puzzle, never on Storm',
       JSON.stringify(got) === JSON.stringify(['continue', 'solution', null, null, 'continue']), got);
    ok('...and puzzleNextButton routes lichess there', /if \(site === 'lichess'\) return lichessTrainingButton\(\);/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // Auto-Next on ChessBase Tactics Solve: Next Position (command id 2) once #tpiPosmsg is PosFinished, never on Sprint
    const sh = csrc.slice(csrc.indexOf('const shown = (el)'), csrc.indexOf('\n', csrc.indexOf('const shown = (el)')) + 1);
    const a = csrc.indexOf('const CHESSBASE_SOLVE_RE'), b = csrc.indexOf('\n}\n', csrc.indexOf('function chessbaseSolveButton()')) + 3;
    const next = {id: '2', disabled: false, offsetWidth: 80, offsetHeight: 30};
    const run = (path, finished) => { const c = vm.createContext({site: 'chessbase', location: {pathname: path}, document: {
            querySelector: (sel) => sel === '#tpiPosmsg.PosFinished' ? (finished ? {} : null) : sel === '.ribbonBtnTextR[id="2"]' ? next : null}});
        vm.runInContext(sh + csrc.slice(a, b), c); return vm.runInContext('chessbaseSolveButton()', c)?.id ?? null; };
    const got = [run('/en/Solve', true), run('/de/Solve/', true), run('/en/Solve', false), run('/en/Sprint', true)];
    ok('ChessBase Solve: Next Position once the status box is PosFinished, nothing mid-position, never on Sprint',
       JSON.stringify(got) === JSON.stringify(['2', '2', null, null]), got);
    ok('...and the same button is re-armed when the end state goes away (ChessBase keeps one button for every position)',
       /if \(site === 'chessbase'\) return chessbaseSolveButton\(\);/.test(csrc) && /if \(puzzleNextClicked && \(!document\.contains\(puzzleNextClicked\) \|\| site === 'chessbase'\)\) puzzleNextClicked = null;/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // crazyhouse drops: the panel passes a legal drop on our turn, the page carries it from the pocket
    const a = psrc.indexOf('function premove_reply_playable('), b = psrc.indexOf('\n}\n', a) + 3;
    const c = vm.createContext({console}); c.self = c; vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(`var config = {variant: 'crazyhouse'}, side = 'white'; function our_side() { return side; } ${psrc.slice(a, b)}`, c);
    const pl = (fen, uci, variant = 'crazyhouse', side = 'white') => vm.runInContext(`config.variant = ${JSON.stringify(variant)}; side = ${JSON.stringify(side)}; premove_reply_playable(${JSON.stringify(fen)}, ${JSON.stringify(uci)})`, c);
    const W = 'rnbqkb1r/ppppppp1/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 3', B = W.replace(' w ', ' b ');
    const got = [pl(W, 'N@d5'), pl(B, 'N@d4', 'crazyhouse', 'black'), pl(W, 'N@e2'), pl(W, 'P@h8'), pl(W, 'P@d1'), pl(B, 'N@d5'), pl(W, 'N@d5', 'chess')];
    ok('a drop is playable on our turn onto an empty square; never onto a piece, a pawn to the back rank, a premove, or outside crazyhouse',
       JSON.stringify(got) === JSON.stringify([true, true, false, false, false, false, false]), got);
    const p0 = csrc.indexOf('const DROP_RE'), p1 = csrc.indexOf('\n}\n', csrc.indexOf('function pocketPieceBounds(')) + 3;
    const run = (sitename, nb) => { const cc = vm.createContext({site: sitename, document: {querySelector: (sel) =>
            sel === '.pocket-bottom piece[data-role="knight"]' ? {dataset: {nb: String(nb)}, getBoundingClientRect: () => ({x: 5, y: 5, width: 40, height: 40})} : null}});
        vm.runInContext(csrc.slice(p0, p1), cc); return !!vm.runInContext("pocketPieceBounds('N')", cc); };
    ok('...the page finds the piece in its own pocket on lichess, and not when the pocket holds none or on another site',
       run('lichess', 1) && !run('lichess', 0) && !run('chesscom', 1));
    ok('...and the move path drags from the pocket with the drag floor, keeps Fitts out of it, and lets a verified drop through',
       /const pocket = pocketPieceBounds\(move\[0\]\);[\s\S]{0,700}const dragMs = Math\.max\(approachMs \+ travelMs, DRAG_MIN_MS\);\s*await simulateDragSquares\(pocket, getBoundsFromCoords\(move\.substring\(2, 4\)\)/.test(csrc)
       && /getMoveTime\(\) \* \(isDrop \? 1 : fittsScale/.test(csrc) && /if \(!DROP_RE\.test\(move \?\? ''\) && !UCI_RE\.test\(move \?\? ''\)\) \{\s*return simulateMove\(move, deselect\);/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // every board overlay sits below the panel; only the screen-select veil is above it
    const z = Number(csrc.match(/const BOARD_OVERLAY_Z = (\d+);/)[1]), panelZ = Number(csrc.match(/wrap\.style\.cssText = 'position: fixed; z-index: (\d+);/)[1]);
    const stray = csrc.split('\n').filter(l => /pointer-events: none/.test(l) && /z-index: 214748364\d/.test(l));
    ok('board overlays (arrows, eval bar, history, stats, badge, banner, your arrows\' evals) are drawn below the panel, none at a fixed top z-index',
       z < panelZ && stray.length === 0 && (csrc.match(/z-index: \$\{BOARD_OVERLAY_Z\}; pointer-events: none/g) || []).length === 7, {z, panelZ, stray}); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('picking the 4-player engine by hand remembers the engine it replaced, so the switch back restores it',
       /if \(key === 'engine' && FOURPC_ENGINES\.includes\(parse\(elem\.value\)\)\s*&& !FOURPC_ENGINES\.includes\(config\.engine\) && !fourpc_prev_engine\) \{\s*fourpc_prev_engine = config\.engine;\s*\}\s*if \(key === 'engine'\) stop_current_engine\(\);/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // a promotion choice is clicked only once it is on screen (BlitzTactics mounts its picker at 0x0)
    const a = csrc.indexOf('async function simulatePromotionClicks('), b = csrc.indexOf('\n}\n', a) + 3;
    const clicks = [], c = vm.createContext({site: 'blitztactics', PROMO_MIN_MS: 0, console: {warn() {}}});
    let polls = 0;
    c.getPromotionSelection = () => ({getBoundingClientRect: () => (++polls < 4 ? {x: 0, y: 0, width: 0, height: 0} : {x: 575, y: 57, width: 80, height: 80})});
    c.promiseTimeout = () => Promise.resolve(); c.simulateClickSquare = (r) => { clicks.push(r); return Promise.resolve(); };
    vm.runInContext(csrc.slice(a, b), c);
    vm.runInContext("simulatePromotionClicks('q', 0)", c).then(() => {
        ok('the promotion click waits for a picker with a size and never clicks a 0x0 one',
           clicks.length === 1 && clicks[0].width === 80 && polls >= 4, {clicks, polls}); });
    ok('...and BlitzTactics reads its pieces from the promotion modal, without throwing when there is none',
       /promotions = document\.querySelector\('\.piece-promotion-modal \.pieces'\)\?\.children;/.test(csrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // the Humanize guards: run the real block against the real chess.js
    const a = psrc.indexOf('// ==== HUMANIZE GUARDS ===='), b = psrc.indexOf('// ==== END HUMANIZE GUARDS ====');
    const g = vm.createContext({}); g.self = g;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), g);
    vm.runInContext(psrc.slice(a, b), g);
    const X = (fen, uci) => vm.runInContext(`hz_exposure(Chess, 'chess', ${JSON.stringify(fen)}, ${JSON.stringify(uci)})`, g);
    const H = (fen, cand, best) => vm.runInContext(`hz_hangs(Chess, 'chess', ${JSON.stringify(fen)}, ${JSON.stringify(cand)}, hz_exposure(Chess, 'chess', ${JSON.stringify(fen)}, ${JSON.stringify(best)}))`, g);
    const qd = '4k3/8/8/2p5/8/8/8/3QK3 w - - 0 1';
    ok('a queen moved onto a pawn-guarded square is vetoed, the safe queen move is not',
       H(qd, 'd1d4', 'd1a4') === true && H(qd, 'd1a4', 'd1a4') === false, X(qd, 'd1d4'));
    const qxp = '4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1';
    ok('a queen that grabs a defended pawn is vetoed (wins 1, loses 9)', H(qxp, 'd1d5', 'd1d2') === true, X(qxp, 'd1d5'));
    const trade = '4k3/8/4p3/3n4/8/2N5/8/4K3 w - - 0 1';
    ok('a fair knight trade is not a hang', H(trade, 'c3d5', 'c3e4') === false, X(trade, 'c3d5'));
    const pawn = '4k3/8/8/8/2b5/8/3P4/4K3 w - - 0 1';
    ok('leaving a pawn en prise is allowed (the error people make all the time)', H(pawn, 'e1f1', 'd2d3') === false, X(pawn, 'e1f1'));
    ok('a piece the engine move also leaves hanging is not held against the alternative',
       H('3rk3/8/8/8/3N4/8/8/4K2R w - - 0 1', 'h1g1', 'h1h2') === false
       && H('3rk3/8/8/8/3N4/8/8/4K2R w - - 0 1', 'h1g1', 'd4f5') === true);
    ok('the defended-twice square: a rook taking a pawn guarded by a knight hangs the exchange (net 4)',
       H('4k3/2n5/8/3p4/8/8/8/3RK3 w - - 0 1', 'd1d5', 'e1e2') === true, X('4k3/2n5/8/3p4/8/8/8/3RK3 w - - 0 1', 'd1d5'));
    const v = (e) => vm.runInContext(e, g);
    ok('natural hangs: a hang Maia gives at least HZ_NATURAL_HANG passes, a rarer one or no Maia read stays vetoed',
       v("hz_natural_hang(new Map([['d1d4', HZ_NATURAL_HANG]]), 'd1d4')") === true
       && v("hz_natural_hang(new Map([['d1d4', HZ_NATURAL_HANG / 2]]), 'd1d4')") === false
       && v("hz_natural_hang(new Map([['d1a4', 0.9]]), 'd1d4')") === false && v("hz_natural_hang(null, 'd1d4')") === false);
    ok('...wired into the hang guard, with the Maia read the Maia options already ask for (no download of its own)',
       /const hangs = \(l\) => !hz_natural_hang\(probs, l\.move\) && hz_hangs\(/.test(psrc)
       && /if \(!humanize_flag\('humanize_maia', HZ_MAIA_DEFAULT\) && !humanize_flag\('humanize_maia_where', false\)\) return;/.test(psrc));
    ok('winning floor: none below +3.00, +3.00 at +3.00, 60% of a +15 eval',
       v('hz_win_floor(299)') === -Infinity && v('hz_win_floor(300)') === 300 && v('hz_win_floor(1500)') === 900);
    ok('punish: full rate normally, a fifth after a 2-pawn gift the engine takes, a twentieth after a blatant one',
       v('hz_punish_keep(150, true)') === 1 && v('hz_punish_keep(250, true)') === 0.2
       && v('hz_punish_keep(600, true)') === 0.05 && v('hz_punish_keep(600, false)') === 1);
    ok('mate in N from an our-view score, null for an ordinary eval',
       v('hz_mate_in(97000)') === 3 && v('hz_mate_in(500)') === null && v('hz_mate_in(-97000)') === null);
    const T = (fen, uci) => v(`hz_simplifies(Chess, 'chess', ${JSON.stringify(fen)}, ${JSON.stringify(uci)})`);
    ok('simplify: an even knight trade the opponent can take back trades pieces off',
       T('4k3/8/4p3/3n4/8/2N5/8/4K3 w - - 0 1', 'c3d5') === true);
    ok('...a free knight (nothing takes back), a pawn capture, a queen into a pawn guard, a quiet or illegal move do not',
       T('4k3/8/8/3n4/8/2N5/8/4K3 w - - 0 1', 'c3d5') === false && T('4k3/8/4p3/3p4/8/2N5/8/4K3 w - - 0 1', 'c3d5') === false
       && T('4k3/8/4p3/3n4/8/8/8/3QK3 w - - 0 1', 'd1d5') === false && T('4k3/8/4p3/3n4/8/2N5/8/4K3 w - - 0 1', 'c3b5') === false
       && T('4k3/8/4p3/3n4/8/2N5/8/4K3 w - - 0 1', 'c3c8') === false);
    ok('simplify hold: winning by +3 to +10, the best trades and the roll is under HZ_SIMPLIFY_HOLD, nowhere else',
       v('hz_simplify_hold(500, () => true, 0.1)') === true && v('hz_simplify_hold(500, () => true, HZ_SIMPLIFY_HOLD)') === false
       && v('hz_simplify_hold(500, () => false, 0.1)') === false && v('hz_simplify_hold(299, () => true, 0.1)') === false
       && v('hz_simplify_hold(1001, () => true, 0.1)') === false);
    ok('...the exchange walk is never run outside the window or past the roll',
       v("hz_simplify_hold(250, () => { throw new Error('walked'); }, 0.1)") === false
       && v("hz_simplify_hold(500, () => { throw new Error('walked'); }, 0.9)") === false);
    ok('...wired: guards only, it stops the match pick and the slider pick from deviating',
       /const simplifyHold = guards && hz_simplify_hold\(bestCp, \(\) => hz_simplifies\(Chess, config\.variant, fen, best\), Math\.random\(\)\);/.test(psrc)
       && /const res = \(!simplifyHold && Math\.random\(\) < keep\) \? hz_match_pick\(/.test(psrc)
       && /if \(cat !== 'top' && !barred && !simplifyHold && Math\.random\(\) < keep\) \{/.test(psrc));
    { const hb = psrc.indexOf("humanize_flag('humanize_match', HZ_MATCH_DEFAULT) && is_one_pass() && !maiaWhich"), mb = psrc.indexOf("} else if (humanize_flag('humanize_match', HZ_MATCH_DEFAULT)) {", hb);
      ok('...a policy net with no Maia probabilities plays its own move, ahead of the pick that would be uniform over its list',
         hb > 0 && mb > hb && !/\bcand = /.test(psrc.slice(hb, mb)) && /is_one_pass = \(eng\) => ONE_PASS_ENGINES\.includes/.test(psrc)); }
    // wiring: both modes go through the guards, the target stands down for a policy-net engine
    ok('...the mix pool and the target candidates both pass safe(), the long mate needs a still-winning non-hanging line, and Maia/Leela skip the target',
       /const ok = pool\.filter\(l => safe\(l\) && \(keep === 1 \|\| takes\(l\)\)\);/.test(psrc)
       && /humanize_target_pick\(all\.filter\(c => c\.line === bestLine \|\| \(safe\(c\.line\) && human\(c\)\)\),/.test(psrc)
       && /alts\.filter\(l => line_cp_ours\(l\) >= HZ_LONG_MATE_KEEP_CP && !hangs\(l\)\)/.test(psrc)
       && /humanize_target\(\) && !ONE_PASS_ENGINES\.includes\(config\.engine\)\) \? humanize_game_run\(\)/.test(psrc)
       && /const guards = humanize_flag\('humanize_guards', true\);/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const locs = fs.readdirSync(ROOT + '/src/i18n/locales').map(f => JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + f, 'utf8')));
    ok('Humanize Guards: a settings row, registered ON by default, label and tip in all 14 locales',
       /id="humanize_guards_checkbox"/.test(gh) && /registerFormElement\('humanize_guards', 'Humanize Guards:', 'checkbox', true\)/.test(gj)
       && locs.length === 14 && locs.every(l => l['set.humanize_guards'] && l['set.tip.humanize_guards'])); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // Scale Errors to the Clock: the shipped Stage C tables and the scaling, run as they are
    const a = psrc.indexOf('// ==== HUMANIZE TIME CONTROL ===='), b = psrc.indexOf('// ==== END HUMANIZE TIME CONTROL ====');
    const t = vm.createContext({}); vm.runInContext(psrc.slice(a, b), t);
    const v = (e) => vm.runInContext(e, t);
    ok('TC class from base + 40 x increment, as the study keyed it: 15+0 ultra, 60+0 bullet, 180+2 blitz, 600+0 rapid, 1800+0 classical',
       v("[hz_tc_class(15,0), hz_tc_class(60,0), hz_tc_class(180,2), hz_tc_class(600,0), hz_tc_class(1800,0)].join()") === 'ultrabullet,bullet,blitz,rapid,classical');
    ok('clock bins on the study edges: 3% -> 0, 7% -> 1, 99% -> 6, full -> 7, over full (increment) -> 7',
       v("[hz_clock_bin(0.03), hz_clock_bin(0.07), hz_clock_bin(0.99), hz_clock_bin(1), hz_clock_bin(1.2)].join()") === '0,1,6,7,7');
    ok('rating bands: 500 -> 400, 1499 -> 1400, 1500 -> 1400, 2950 -> 2800', v("[hz_band(500), hz_band(1499), hz_band(1500), hz_band(2950)].join()") === '400,1400,1400,2800');
    ok('blitz with no clock or phase is the reference (x1); every table has 13 bands x 5 TCs, 5 x 8 clock bins, 5 x 3 phases',
       v("hz_tc_mult('mistake', 'blitz', NaN, null, 1500)") === 1
       && v("['inaccuracy','mistake','blunder'].every(k => Object.keys(HZ_TC_TABLES[k].level).length === 13 && Object.values(HZ_TC_TABLES[k].level).every(r => r.length === 5) && HZ_TCS.every(tc => HZ_TC_TABLES[k].clock[tc].length === 8 && HZ_TC_TABLES[k].phase[tc].length === 3))"));
    ok('the measured shape: blunders under 5% of the clock outnumber a full clock\'s, bullet over blitz at 2000, middlegame over opening',
       v("hz_tc_mult('blunder', 'blitz', 0.02, null, 1500)") > 1.5 && v("hz_tc_mult('blunder', 'blitz', 1, null, 1500)") < 0.5
       && v("hz_tc_mult('mistake', 'bullet', NaN, null, 2000)") > 1.3 && v("hz_tc_mult('inaccuracy', 'rapid', NaN, 'm', 1500)") > v("hz_tc_mult('inaccuracy', 'rapid', NaN, 'o', 1500)"));
    ok('never past the 3x cap', v("hz_tc_mult('blunder', 'ultrabullet', 0.01, 'm', 2400)") === 3);
    const r = JSON.parse(v("JSON.stringify(hz_scale_rates({top: 50, second: 40, third: 4, fourth: 0, inaccuracy: 0, mistake: 5, blunder: 1}, {inaccuracy: 2, mistake: 2, blunder: 3}))"));
    ok('scaling moves the error shares and takes the difference from the top move; the near-best lines and the total stay',
       Math.abs(r.mistake - 10) < 1e-9 && Math.abs(r.blunder - 3) < 1e-9 && Math.abs(r.top - 43) < 1e-9 && r.second === 40
       && Math.abs(Object.values(r).reduce((x, y) => x + y, 0) - 100) < 1e-9, r);
    // the page side: the base time from the time-control text
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const c0 = csrc.indexOf('function tcBaseSeconds('), c1 = csrc.indexOf('\n}\n', c0) + 3;
    const cc = vm.createContext({}); vm.runInContext(csrc.slice(c0, c1), cc);
    ok('base time read from lichess and chess.com time-control text: 5+3, ½+0, 1½+1, 3 | 2, 10 min, 30 sec, nothing',
       vm.runInContext("[tcBaseSeconds('5+3 • Rated • Blitz'), tcBaseSeconds('½+0'), tcBaseSeconds('1½+1'), tcBaseSeconds('3 | 2'), tcBaseSeconds('10 min'), tcBaseSeconds('30 sec'), tcBaseSeconds('')].join()", cc) === '300,30,90,180,600,30,'
       && /increment: inc \? parseInt\(inc\[1\]\) : null, base: tcBaseSeconds\(tcText\)/.test(csrc));
    ok('...and the panel falls back to the longest clock this game showed, and scales the mix only with the switch on',
       /const base = last_clocks\.base > 0 \? last_clocks\.base : game_max_clock_s;/.test(psrc)
       && /let rates = humanize_rates_now\(fen, true\); \/\/ the mix, scaled to the clock when that is on/.test(psrc));
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const locs = fs.readdirSync(ROOT + '/src/i18n/locales').map(f => JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + f, 'utf8')));
    ok('Scale Errors to the Clock: a settings row, registered OFF by default, label and tip in all 14 locales',
       /id="humanize_tc_scale_checkbox"/.test(gh) && /registerFormElement\('humanize_tc_scale', 'Scale Errors to the Clock:', 'checkbox', false\)/.test(gj)
       && locs.every(l => l['set.humanize_tc_scale'] && l['set.tip.humanize_tc_scale'])); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // ONE MAIA ENTRY: the one-time move of an old Maia-1 / Maia-2 selection onto the Play-like rating
    const cs = fs.readFileSync(ROOT + '/src/scripts/config-store.js', 'utf8');
    const migrate = async (stored) => {
        const writes = {};
        const c = vm.createContext({console, location: {protocol: 'https:'}, chrome: {storage: {local: {get: async () => ({...stored}), set: (o) => Object.assign(writes, o), remove() {}},
                                                       onChanged: {addListener() {}}}}});
        c.self = c; c.window = c;
        vm.runInContext(cs, c);
        await c.MephistoConfig.ready;
        return {engine: c.MephistoConfig.get('engine'), elo: c.MephistoConfig.get('maia3_elo'), marked: c.MephistoConfig.get('__maia_merged')};
    };
    Promise.all([migrate({engine: '"maia"', maia_level: '"1300"'}), migrate({engine: '"maia2"', maia2_self_elo: '1700', maia3_elo: '1500'}),
                 migrate({engine: '"maia"', maia_level: '"1300"', __maia_merged: '1'}), migrate({engine: '"stockfish-19-nnue"'})]).then(([m1, m2, done, sf]) => {
        ok('an old Maia-1 pick becomes the Maia entry at its band; a Maia-2 pick keeps its own rating as the shared one; once only',
           m1.engine === '"maia3"' && m1.elo === '1300' && m2.engine === '"maia2"' && m2.elo === '1700'
           && done.engine === '"maia"' && sf.engine === '"stockfish-19-nnue"' && sf.marked === '1', {m1, m2, done, sf}); });
    // ERR LIKE YOUR RATING BECAME THE DEFAULT: a tuned move mix keeps it off, once, never over a choice made
    const mm = async (stored) => {
        const c = vm.createContext({console, location: {protocol: 'https:'}, chrome: {storage: {local: {get: async () => ({...stored}), set() {}, remove() {}},
                                                       onChanged: {addListener() {}}}}});
        c.self = c; c.window = c;
        vm.runInContext(cs, c);
        await c.MephistoConfig.ready;
        return {match: c.MephistoConfig.get('humanize_match') ?? null, marked: c.MephistoConfig.get('__match_default')};
    };
    Promise.all([mm({}), mm({humanize_blunder: '3'}), mm({humanize_blunder: '3', humanize_match: 'true'}),
                 mm({humanize_top: '60', __match_default: '1'}), mm({humanize_cp_blunder: '500'})]).then(([fresh, tuned, chose, done, cpOnly]) => {
        ok('a tuned move mix keeps Err Like Your Rating off; a fresh install, a choice already made, a second run and tuned thresholds alone do not',
           fresh.match === null && fresh.marked === '1' && tuned.match === 'false' && chose.match === 'true'
           && done.match === null && cpOnly.match === null, {fresh, tuned, chose, done, cpOnly}); });
    const ph = fs.readFileSync(ROOT + '/src/popup/popup.html', 'utf8');
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const opts = (h) => (h.match(/<option value="maia[23]?"[^>]*>/g) || []).join(' ');
    ok('panel and settings list one pickable Maia entry; Maia-2 stays as a hidden option so a ticked box still shows its name',
       [ph, gh].every(h => opts(h) === '<option value="maia3"> <option value="maia2" hidden>'), [opts(ph), opts(gh)]);
    ok('...the panel has Play like, Use opponent\'s rating and the opponent box, and no Maia-1 level or Maia-2 your-Elo row',
       /id="qs_maia3_row"/.test(ph) && /id="qs_maia_opp_row"/.test(ph) && /id="qs_maia2_oppo_row"/.test(ph)
       && !/id="qs_maia_row"/.test(ph) && !/id="qs_maia2_row"/.test(ph));
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('ticking Use opponent\'s rating switches the entry between Maia-3 and Maia-2 with an engine reload; Maia-2\'s own side is the Play-like rating',
       /const want = maiaOpp\.checked \? 'maia2' : 'maia3';\s*if \(want === config\.engine\) return;\s*stop_current_engine\(\);[^\n]*\n\s*save\('engine', want\);\s*panel_reload\(\);/.test(psrc)
       && /maia2_self_elo: JSON\.parse\(MephistoConfig\.get\('maia3_elo'\)\) \|\| 1500,/.test(psrc));
    // the opponent's rating: read off the page only for Maia-2, rounded into the net's range
    const a = psrc.indexOf('function set_maia2_oppo('), b = psrc.indexOf('\n}\n', a) + 3;
    const sent = [], saved = {}, c = vm.createContext({config: {engine: 'maia2', maia2_oppo_elo: 1500}, PANEL_ROOT: null, last_eval: {fen: 'x'},
        MephistoConfig: {set: (k, v) => { saved[k] = v; }}, send_engine_uci: (l) => sent.push(l), abandon_search() {}, push_config() {}});
    vm.runInContext(psrc.slice(a, b), c);
    vm.runInContext('set_maia2_oppo(1523)', c); vm.runInContext('set_maia2_oppo(1510)', c); vm.runInContext('set_maia2_oppo(3200)', c);
    ok('the opponent rating is rounded to 50 and clamped to 600-2800, and an unchanged one sends nothing',
       JSON.stringify(sent) === JSON.stringify(['setoption name OppoElo value 1500', 'setoption name OppoElo value 2800']) || JSON.stringify(sent) === JSON.stringify(['setoption name OppoElo value 2800']), sent);
    ok('...and the new rating is stored through MephistoConfig, not the out-of-scope save (OPT-1)', saved.maia2_oppo_elo === '2800', saved);
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const r0 = csrc.indexOf('const OPP_RATING_SELECTORS'), r1 = csrc.indexOf('let streamerAsked');
    const dc = vm.createContext({oppBox: (s) => s, document: {querySelector: (sel) => sel === '.ruser-top rating' ? {textContent: '2893'} : null}});
    vm.runInContext(csrc.slice(r0, r1), dc);
    ok('...the page reads lichess\'s <rating> off the top player row, and only sends it while Maia-2 is the engine',
       vm.runInContext('opponentRating()', dc) === 2893
       && (csrc.match(/oppRating: config\??\.engine === 'maia2' \? opponentRating\(\) : null/g) || []).length === 2
       && /if \(config\.engine === 'maia2' && response\.oppRating > 0\) set_maia2_oppo\(response\.oppRating, false\);/.test(psrc));
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const locs = fs.readdirSync(ROOT + '/src/i18n/locales').map(f => JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + f, 'utf8')));
    ok('Play Like Rating is a settings row on the maia3_elo key, live in an open panel, worded in all 14 locales',
       /id="maia3_elo_input"/.test(gh) && /registerFormElement\('maia3_elo', 'Play Like Rating:', 'input', 1500\)/.test(gj)
       && /'maia2_self_elo', 'maia2_oppo_elo', 'maia3_elo',/.test(psrc)
       && locs.every(l => l['set.play_like_rating'] && l['panel.maia_use_opp'] && l['panel.tip.maia_use_opp'])); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // Stage B: Maia picks the deviation (B1) and where errors land (B2) -- the real guards block
    const a = psrc.indexOf('// ==== HUMANIZE GUARDS ===='), b = psrc.indexOf('// ==== END HUMANIZE GUARDS ====');
    const g = vm.createContext({}); vm.runInContext(psrc.slice(a, b), g);
    const v = (e) => vm.runInContext(e, g);
    v("var P = new Map([['a2a3', 0.60], ['b2b3', 0.30], ['c2c3', 0.005], ['d2d3', 0.095]]);");
    const draws = v("(() => { const pool = [{move:'b2b3'},{move:'c2c3'},{move:'d2d3'}]; const n = {b2b3:0, c2c3:0, d2d3:0}; for (let i = 0; i < 4000; i++) n[hz_maia_weighted(pool, P, () => (i + 0.5) / 4000).move]++; return n; })()");
    ok('B1: a deviation is drawn by Maia probability (b3 30 : d3 9.5) and a move under 1% never',
       draws.c2c3 === 0 && Math.abs(draws.b2b3 / (draws.b2b3 + draws.d2d3) - 0.30 / 0.395) < 0.01, draws);
    ok('B1: no candidate at 1% or more -> no pick (the best move stays)',
       v("hz_maia_weighted([{move:'c2c3'},{move:'h2h3'}], P, () => 0.5)") === null);
    ok('B2: P_err counts Maia mass only on engine lines losing more than tau',
       Math.abs(v("hz_p_err([{move:'a2a3',l:0},{move:'b2b3',l:150},{move:'d2d3',l:400},{move:'h2h3',l:900}], P, (x) => x.l, 110)") - 0.395) < 1e-9);
    const w = JSON.parse(v("JSON.stringify((() => { const s1 = hz_where_k(null, 0.44, 10); const s2 = hz_where_k(s1.state, 0.0, 11); const s3 = hz_where_k(s2.state, 0.9, 12); const r = hz_where_k(s3.state, 0.1, 1); const lo = (() => { let s = null; for (let i = 1; i < 200; i++) s = hz_where_k(s && s.state, 0, i); return s; })(); return {k1: s1.k, m1: s1.state.mean, k2: s2.k, k3: s3.k, kr: r.k, floor: lo.state.mean}; })())"));
    ok('B2: twice the running mean doubles the error shares, a dead-easy move gets none, capped at 3x, a new game restarts from 0.22, the mean never under 0.02',
       Math.abs(w.k1 - 2) < 1e-9 && Math.abs(w.m1 - (0.85 * 0.22 + 0.15 * 0.44)) < 1e-9 && w.k2 === 0 && w.k3 === 3
       && Math.abs(w.kr - 0.1 / 0.22) < 1e-9 && w.floor === 0.02, w);
    ok('...wired: Maia asked at search start on our turn, its rating and list width set per ask and put back, the pick weighted only with the switch on',
       /if \(our_turn && \(config\.autoplay \|\| config\.human_error\)\) request_humanize_maia\(fen\);/.test(psrc)
       && /send\('setoption name MultiPV value 256'\);/.test(psrc) && /send\('setoption name MultiPV value 5'\);/.test(psrc)
       && /const maiaWhich = !!probs && humanize_flag\('humanize_maia', HZ_MAIA_DEFAULT\);/.test(psrc)
       && /cand = maiaWhich \? hz_maia_weighted\(ok, probs\)/.test(psrc)
       && /if \(probs && humanize_flag\('humanize_maia_where', false\)\) \{/.test(psrc)
       && /rates = hz_scale_rates\(rates, \{inaccuracy: w\.k, mistake: w\.k, blunder: w\.k\}\);/.test(psrc));
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const locs = fs.readdirSync(ROOT + '/src/i18n/locales').map(f => JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + f, 'utf8')));
    ok('Human-Like Mistakes ON by default, Mistakes Where People Make Them OFF: settings rows, label and tip in all 14 locales',
       ['humanize_maia', 'humanize_maia_where'].every(k => new RegExp(`id="${k}_checkbox"`).test(gh)
           && new RegExp(`registerFormElement\\('${k}', '[^']+:', 'checkbox', ${k === 'humanize_maia'}\\)`).test(gj)
           && locs.every(l => l['set.' + k] && l['set.tip.' + k]))
       && /const HZ_MAIA_DEFAULT = true;/.test(psrc) && !/humanize_flag\('humanize_maia', false\)/.test(psrc)); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // Err Like Your Rating: the real HUMANIZE MATCH block (it calls hz_maia_weighted from the guards block)
    const sl = (a, b) => psrc.slice(psrc.indexOf(a), psrc.indexOf(b));
    const g = vm.createContext({});
    vm.runInContext(sl('// ==== HUMANIZE GUARDS ====', '// ==== END HUMANIZE GUARDS ====') + sl('// ==== HUMANIZE MATCH ====', '// ==== END HUMANIZE MATCH ===='), g);
    const v = (e) => JSON.parse(vm.runInContext(`JSON.stringify(${e})`, g));
    const s15 = v('hz_match_shares(1500)'), s16 = v('hz_match_shares(1600)'), h = v('HZ_HUMAN_DROP');
    const near = (a, b, t = 1e-9) => Math.abs(a - b) < t;
    ok('match shares: 1500 is the 1400-1599 band as measured, 1600 halfway to the next band, every set sums to 1',
       s15.every((x, i) => near(x, h[1400][i])) && s16.every((x, i) => near(x, (h[1400][i] + h[1600][i]) / 2))
       && [s15, s16, v('hz_match_shares(300)'), v('hz_match_shares(3200)')].every(a => near(a.reduce((x, y) => x + y, 0), 1)), {s15, s16});
    const b2 = v('hz_match_shares(1500, {blunder: 2})');
    ok('...multipliers act on the cumulative rates the tables are fitted on: doubling P(blunder) leaves P(mistake or worse) and the good moves alone',
       near(b2[4], 2 * h[1400][4]) && near(b2[3] + b2[4], h[1400][3] + h[1400][4]) && near(b2[0], h[1400][0]) && near(b2[2], h[1400][2]), b2);
    ok('drop classes on the Game Review edges: 1.99 good, 2 / 5 / 10 / 20 open the next class',
       v('[1.99, 2, 4.99, 5, 9.99, 10, 19.99, 20, 60].map(hz_drop_class)').join() === '0,1,1,2,2,3,3,4,4');
    v("(globalThis.C = [{move:'a', drop:0}, {move:'b', drop:3}, {move:'c', drop:7}, {move:'d', drop:30}], 0)");
    const sh = '[0.2, 0.2, 0.2, 0.2, 0.2]';
    ok('match pick: the roll picks the class, an empty class (no mistake in the list) falls to the next milder one',
       v(`hz_match_pick(C, ${sh}, 0.9, () => 0).cand.move`) === 'd' && v(`hz_match_pick(C, ${sh}, 0.5, () => 0).cand.move`) === 'c'
       && v(`hz_match_pick(C, ${sh}, 0.7, () => 0)`).played === 2 && v(`hz_match_pick(C, ${sh}, 0.7, () => 0)`).rolled === 3
       && v(`hz_match_pick(C, ${sh}, 0.1, () => 0).cand.move`) === 'a');
    { // what kind of error: the real guards + match + time-control blocks on the real chess.js
        const tg = vm.createContext({}); tg.self = tg;
        vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), tg);
        vm.runInContext(sl('// ==== HUMANIZE GUARDS ====', '// ==== END HUMANIZE GUARDS ====') + sl('// ==== HUMANIZE MATCH ====', '// ==== END HUMANIZE MATCH ====')
            + sl('// ==== HUMANIZE TIME CONTROL ====', '// ==== END HUMANIZE TIME CONTROL ===='), tg);
        const tv = (e) => JSON.parse(vm.runInContext(`JSON.stringify(${e})`, tg));
        const fen = '4k3/8/8/3p4/8/2b5/3P4/R3K3 w - - 0 1';   // d2xc3 wins a loose bishop
        const ty = (u) => tv(`hz_type_classifier(Chess, 'chess', ${JSON.stringify(fen)})(${JSON.stringify(u)})`);
        ok('error kind: taking the free bishop is quiet, a rook move that leaves it is missed free material',
           ty('d2c3') === 'quiet' && ty('a1a7') === 'mfree', {d2c3: ty('d2c3'), a1a7: ty('a1a7')});
        const hp = '4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 1';   // Bb4 hits d2, Ke1 guards it
        ok('...a king move that still guards the attacked pawn is quiet, one that walks away from it hangs it',
           tv(`hz_type_classifier(Chess, 'chess', ${JSON.stringify(hp)})('e1e2')`) === 'quiet'
           && tv(`hz_type_classifier(Chess, 'chess', ${JSON.stringify('4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 1')})('e1f1')`) === 'hung');
        const pool = "[{move:'h'},{move:'m'},{move:'q'},{move:'q2'}]", T = "(u) => ({h: 'hung', m: 'mfree', q: 'quiet', q2: 'quiet'})[u]";
        const draws = tv(`(() => { let a = 5; const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; const n = {hung: 0, mfree: 0, quiet: 0}; const t = ${T}; for (let i = 0; i < 20000; i++) n[t(hz_type_pick(${pool}, [0.3, 0.1, 0.6], t, rnd).move)]++; return n; })()`);
        ok('type pick: the kind is drawn by the players\' shares, not by how many moves of it the list has',
           Math.abs(draws.hung / 20000 - 0.3) < 0.015 && Math.abs(draws.mfree / 20000 - 0.1) < 0.01 && Math.abs(draws.quiet / 20000 - 0.6) < 0.015, draws);
        ok('...strict (the default): a pool without the drawn kind plays nothing; not strict, it plays the kind it has; the band table covers every rating as rows of three shares summing to 1',
           tv('HZ_TYPE_STRICT') === true
           && tv(`hz_type_pick([{move:'h'}], [0.3, 0.1, 0.6], ${T}, () => 0.99)`) === null
           && tv(`hz_type_pick([{move:'h'}], [0.3, 0.1, 0.6], ${T}, () => 0.1).move`) === 'h'
           && tv(`hz_type_pick([{move:'h'}], [0.3, 0.1, 0.6], ${T}, () => 0.99, false).move`) === 'h'
           && Object.values(tv('HZ_TYPE_MIX')).every(b => b.length === 3 && b.every(r => Math.abs(r[0] + r[1] + r[2] - 1) < 0.002))
           && tv('hz_type_mix(1500)')[2][2] === tv('HZ_TYPE_MIX')[1400][2][2] && tv('hz_type_mix(3000)')[0][0] === tv('HZ_TYPE_MIX')[2800][0][0]);
        ok('...hz_match_pick picks errors by kind when given a classifier and the mix; a class with none of the drawn kind falls to the next milder one (and is owed)',
           tv(`hz_match_pick([{move:'a', drop:0}, {move:'h', drop:7}, {move:'q', drop:7}], [0, 0, 1, 0, 0], 0.5, () => 0.5, null, ${T}, [[0.0, 0, 1], [0, 0, 1], [0, 0, 1]]).cand.move`) === 'q'
           && tv(`hz_match_pick([{move:'a', drop:0}, {move:'h', drop:7}, {move:'q', drop:7}], [0, 0, 1, 0, 0], 0.5, () => 0.5, null, ${T}, [[1, 0, 0], [0, 0, 1], [0, 0, 1]]).cand.move`) === 'h'
           && tv(`hz_match_pick([{move:'a', drop:0}, {move:'b', drop:3}, {move:'h', drop:7}], [0, 0, 1, 0, 0], 0.5, () => 0.5, null, ${T}, [[0, 0, 1], [0, 0, 1], [0, 0, 1]])`).played === 1);
        // hidden errors: the real blocks need win_percent from outside them
        vm.runInContext(psrc.slice(psrc.indexOf('function win_percent('), psrc.indexOf('\n}\n', psrc.indexOf('function win_percent(')) + 3), tg);
        const sh = "new Map([['a', 50], ['b', 30], ['c', -200]])";
        ok('hidden: a move within 2% win of the shallow best looked fine, one far below did not, one the shallow list lacks did not, no shallow read is unknown',
           tv(`hz_hidden_of(${sh}, 'b')`) === true && tv(`hz_hidden_of(${sh}, 'c')`) === false && tv(`hz_hidden_of(${sh}, 'z')`) === false
           && tv(`hz_hidden_of(new Map(), 'b')`) === null && tv(`hz_hidden_of(null, 'b')`) === null);
        const HO = "(u) => ({q: true, q2: false})[u] ?? false";
        ok('...inside the drawn kind a hidden error is preferred whenever there is one; no shallow read leaves the kind as it was',
           tv(`hz_type_pick([{move:'q'},{move:'q2'}], [0, 0, 1], (u) => 'quiet', () => 0.9, true, ${HO}).move`) === 'q'
           && tv(`hz_type_pick([{move:'q2'},{move:'q3'}], [0, 0, 1], (u) => 'quiet', () => 0.9, true, ${HO}).move`) === 'q3'
           && tv(`hz_type_pick([{move:'q'},{move:'q2'}], [0, 0, 1], (u) => 'quiet', () => 0.9, true, (u) => null).move`) === 'q2');
        ok('...both search paths record the depth-2 scores, and a new position starts an empty map',
           tv('HZ_SHALLOW_DEPTH') === 2
           && /if \(lineInfo\.depth === HZ_SHALLOW_DEPTH && last_eval\.shallow && lineInfo\.move\) last_eval\.shallow\.set\(lineInfo\.move, line_cp_ours\(lineInfo\)\);/.test(psrc)
           && /if \(info\.depth === HZ_SHALLOW_DEPTH && !info\.bound && last_eval\.shallow && info\.pv && info\.pv\[0\] != null\)/.test(psrc)
           && /last_eval = \{fen, activeLines: 0, lines: new Array\(config\.multiple_lines\), shallow: new Map\(\),/.test(psrc));
        ok('...wired: the match branch (strict, it owes) and the slider mix (not strict, it has no debt) both pick errors by kind, Maia\'s pick still wins when it is on',
           /hz_match_pick\(cands, shares, r \/ 100, Math\.random, maiaWhich \? probs : null,\s+typeOf, hz_type_mix\(elo\), \(u\) => hz_hidden_of\(shallow, u\)\)/.test(psrc)
           && /: \(row && ok\.length\) \? hz_type_pick\(ok, row, hz_type_classifier\(Chess, config\.variant, fen\), Math\.random, false\)/.test(psrc));
    }
    const d1 = v(`hz_match_settle(null, ${sh}, 2)`), d2 = v(`hz_match_settle(hz_match_settle(null, ${sh}, 0), ${sh}, 0)`);
    ok('debt: a played inaccuracy pays its class, unplayed errors accumulate their shares',
       near(d1[2], -0.8) && near(d1[3], 0.2) && near(d2[4], 0.4) && d1[0] === 0, {d1, d2});
    const w = v(`hz_match_with_debt([0.6, 0.2, 0.1, 0.06, 0.04], [0, 0, 0, 1, 10])`);
    ok('...owed errors raise their class (half the debt, at most 4x its share) and come out of the good moves',
       near(w[3], 0.06 + 0.5) === false && near(w[3], 0.06 + Math.min(0.24, 0.5)) && near(w[4], 0.04 + 0.16) && near(w[2], 0.1)
       && near(w.reduce((a, b) => a + b, 0), 1) && w[0] / w[1] - 3 < 1e-9, w);
    // Think Like People at This Time Control: the real HUMANIZE THINK block (+ the clock bins)
    const t = vm.createContext({});
    vm.runInContext(sl('const HZ_TCS', '// The multiplier on one class') + sl('// ==== HUMANIZE THINK ====', '// ==== END HUMANIZE THINK ===='), t);
    // seeded, and small enough not to hold up the timer-driven checks around it
    const mean = vm.runInContext("(() => { let a = 7; const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; let s = 0; const N = 6000; for (let i = 0; i < N; i++) s += hz_think_ms('blitz', 'm', 0.6, 180, 'normal', rnd); return s / N; })()", t);
    ok('think: a normal blitz middlegame move at 60% clock (the 50-75% bin) averages the measured 3.11% of the game (5.6 s of 3+0) over the kind mix, within 6%',
       Math.abs(mean * 1.163 / 5598 - 1) < 0.06, Math.round(mean));
    ok('...speeds up on a low clock, slows on a tense position, and has no table for an unknown time control',
       vm.runInContext("hz_think_ms('blitz', 'm', 0.03, 180, 'normal', () => 0.5) < hz_think_ms('blitz', 'm', 0.6, 180, 'normal', () => 0.5) / 3", t)
       && vm.runInContext("hz_think_ms('blitz', 'm', 0.6, 180, 'long', () => 0.5) > hz_think_ms('blitz', 'm', 0.6, 180, 'normal', () => 0.5) * 1.7", t)
       && vm.runInContext("hz_think_ms('correspondence', 'm', 0.6, 180, 'normal') === null", t));
    const th = (c) => vm.runInContext(`hz_think_ms('blitz', 'm', 0.6, 180, 'normal', () => 0.5, ${c})`, t);
    ok('...follows the move it is about to play: a blunder sits 1.41x, a good move 0.90x, an uncoupled call neither, ultrabullet reads bullet',
       Math.abs(th(4) / th('null') - 1.41) < 1e-9 && Math.abs(th(0) / th('null') - 0.90) < 1e-9
       && Math.abs(vm.runInContext("hz_think_ms('ultrabullet', 'm', 0.6, 30, 'normal', () => 0.5, 4) / hz_think_ms('ultrabullet', 'm', 0.6, 30, 'normal', () => 0.5)", t) - 1.37) < 1e-9);
    const chain = vm.runInContext("(() => { let a = 11; const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; const zs = []; let z = null; for (let i = 0; i < 20000; i++) zs.push(z = hz_think_z(z, 'blitz', rnd)); const m = zs.reduce((x, y) => x + y, 0) / zs.length; let v = 0, c = 0; for (let i = 0; i < zs.length; i++) { v += (zs[i] - m) ** 2; if (i) c += (zs[i] - m) * (zs[i - 1] - m); } return {r: c / v, v: v / zs.length}; })()", t);
    ok('rhythm: a blitz chain of thinks keeps the measured 0.17 of the last draw and stays standard normal; a fresh game starts with no memory',
       Math.abs(chain.r - 0.17) < 0.03 && Math.abs(chain.v - 1) < 0.05
       && vm.runInContext("hz_think_z(null, 'blitz', () => 0.5) === hz_think_z(null, 'classical', () => 0.5)", t), chain);
    ok('...wired: one residual per move, carried while the fullmove count climbs',
       /const prev = hz_think_rhythm && fullmove > hz_think_rhythm\.fullmove \? hz_think_rhythm\.z : null;/.test(psrc)
       && /hz_think_ms\(x\.tc, x\.phase, x\.frac, x\.est, reelOff \? 'normal' : kind, Math\.random, cls, z\)/.test(psrc));
    ok('...wired with the drop class of the move humanize_pick settled on',
       /const cls = played \? hz_drop_class\(Math\.max\(0, win_percent\(bestCp\) - win_percent\(line_cp_ours\(played\)\)\)\) : 0;/.test(psrc)
       && /hz_think_ms\(x\.tc, x\.phase, x\.frac, x\.est, reelOff \? 'normal' : kind, Math\.random, cls, z\)/.test(psrc));
    ok('...wired: the match branch sits ahead of the slider mix, owes and pays errors per game, and asks for the wide list; the think replaces the draw only with a clock read',
       /\} else if \(humanize_flag\('humanize_match', HZ_MATCH_DEFAULT\)\) \{/.test(psrc)
       && /hz_match_state = \{debt: hz_match_settle\(hz_match_state\.debt, base, res\.played\), fullmove\};/.test(psrc)
       && /humanize_flag\('humanize_match', HZ_MATCH_DEFAULT\);\n/.test(psrc.slice(psrc.indexOf('const wantsDeep')))
       && /if \(kind !== 'instant' && humanize_flag\('humanize_think_tc', false\)\) \{/.test(psrc)
       && /return \{tc: hz_tc_class\(base, inc\), frac, phase: hz_phase_of\(fen\), est: base \+ 40 \* inc, left: Math\.max\(0, mine\)\};/.test(psrc));
    ok('...a think never takes more than half the clock left (players\' p99 above 5% of the clock), and the panel caps the drawn think with it',
       vm.runInContext('hz_think_cap(2894, 3.6)', t) === 1800 && vm.runInContext('hz_think_cap(900, 3.6)', t) === 900
       && vm.runInContext('hz_think_cap(900, -2)', t) === 0 && vm.runInContext('hz_think_cap(900, undefined)', t) === 900
       && /const h = x \? hz_think_cap\(hz_think_ms\(x\.tc, x\.phase, x\.frac, x\.est, reelOff \? 'normal' : kind, Math\.random, cls, z\), x\.left\) : null;/.test(psrc));
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const locs = fs.readdirSync(ROOT + '/src/i18n/locales').map(f => JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + f, 'utf8')));
    ok('Err Like Your Rating ON by default (page and panel agree), Think Like Your Time Control OFF: settings rows, label and tip in all 14 locales',
       [['humanize_match', true], ['humanize_think_tc', false]].every(([k, d]) => new RegExp(`id="${k}_checkbox"`).test(gh)
           && new RegExp(`registerFormElement\\('${k}', '[^']+:', 'checkbox', ${d}\\)`).test(gj)
           && locs.every(l => l['set.' + k] && l['set.tip.' + k]))
       && /const HZ_MATCH_DEFAULT = true;/.test(psrc) && (psrc.match(/humanize_flag\('humanize_match', /g) || []).length === (psrc.match(/humanize_flag\('humanize_match', HZ_MATCH_DEFAULT\)/g) || []).length);
    ok('...the move-mix table says its shares are not played while it is on, in all 14 locales',
       /<p data-i18n="set\.note\.humanize_match_mix" id="humanize_match_mix_note" class="set-note" hidden>/.test(gh)
       && /const show = \(\) => \{ note\.hidden = !cb\.checked; \};\s*cb\.addEventListener\('change', show\);/.test(gj)
       && /this\.initMatchNote\(\);/.test(gj) && locs.every(l => l['set.note.humanize_match_mix'])); }
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // ---- ERROR CODES: the registry in i18n.js, its 14 locales, the README, and where each code is wired ----
    const i18nSrc = fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8');
    const load = () => { const c = vm.createContext({TypeError, Error, Object, String, RegExp}); c.self = c; vm.runInContext(i18nSrc, c); return c; };
    const I = load().MephistoI18n, reg = Object.values(I.ERRORS);
    const locDir = ROOT + '/src/i18n/locales/', langs = fs.readdirSync(locDir).map(f => f.replace(/\.json$/, '')).sort();
    const loc = Object.fromEntries(langs.map(l => [l, JSON.parse(fs.readFileSync(locDir + l + '.json', 'utf8'))]));
    const ph = (t) => (String(t).match(/\{\w+\}/g) || []).sort().join(',');
    // a code written twice in the registry would silently collapse in Object.fromEntries, so count the source
    const regSrc = i18nSrc.slice(i18nSrc.indexOf('const ERRORS = '), i18nSrc.indexOf('const ERROR_CODE_RE'));
    const literals = regSrc.match(/\['MPH-[A-Z]\d{2}'/g) || [];
    ok('error codes: every registry entry is written once, is MPH-<letter><2 digits>, and the registry and its entries are frozen',
       literals.length === reg.length && new Set(literals).size === literals.length && reg.length >= 50
       && reg.every(e => /^MPH-[A-Z]\d{2}$/.test(e.code) && Object.isFrozen(e)) && Object.isFrozen(I.ERRORS), {literals: literals.length, reg: reg.length});
    ok('...no two codes share a message key (two codes with one text tell the user nothing apart)', new Set(reg.map(e => e.key)).size === reg.length);
    const missing = [], phBad = [], same = [];
    for (const e of reg) for (const l of langs) {
        const t = loc[l][e.key];
        if (typeof t !== 'string' || !t) { missing.push(l + ' ' + e.key); continue; }
        if (ph(t) !== ph(e.en)) phBad.push(l + ' ' + e.key);
        if (l !== 'en' && t === loc.en[e.key]) same.push(l + ' ' + e.key);
    }
    ok('...every message key exists in all 14 locales with the same {placeholders} as the English default', langs.length === 14 && missing.length === 0 && phBad.length === 0, {missing: missing.slice(0, 5), phBad: phBad.slice(0, 5)});
    ok('...the English default in the registry is the text in en.json (one source, no drift), and no locale left the English in place', reg.every(e => loc.en[e.key] === e.en) && same.length === 0, same.slice(0, 5));
    ok('...the helper keys are in all 14 locales too (Nothing was changed, the README pointer)', langs.every(l => loc[l]['err.nothing_changed'] && /<a href="https:\/\/github\.com\/IchNukeDichWeg\/Mephisto#error-codes">/.test(loc[l]['err.see_readme'])));
    // every code token anywhere in the shipped source is a registered one, and every registered one is used outside the registry
    const walk = (d) => fs.readdirSync(d, {withFileTypes: true}).flatMap(f => f.isDirectory() ? walk(d + '/' + f.name) : [d + '/' + f.name]);
    const srcFiles = walk(ROOT + '/src').filter(f => /\.(js|html)$/.test(f) && !/i18n\.js$/.test(f));
    const used = new Set(), unknown = [];
    for (const f of srcFiles) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bMPH-[A-Z]\d{2}\b/g)) { used.add(m[0]); if (!I.ERRORS[m[0]]) unknown.push(f.slice(ROOT.length) + ' ' + m[0]); }
    ok('...every MPH code written in src/ is registered, and every registered code is wired to a failure path', unknown.length === 0 && reg.every(e => used.has(e.code)), {unknown, unwired: reg.filter(e => !used.has(e.code)).map(e => e.code)});
    const readme = fs.readFileSync(ROOT + '/README.md', 'utf8');
    ok('...the README lists every code with its own table row', reg.every(e => new RegExp('^\\| `' + e.code + '` \\|', 'm').test(readme)) && /^## Error codes$/m.test(readme));
    // the lookup itself: the code leads, the translation follows, a missing language falls back to English
    const c2 = load(); c2.MephistoI18n.setFallback(loc.en); c2.MephistoI18n.setStrings('de', loc.de);
    const de = c2.MephistoI18n.errText('MPH-U08', {status: 503});
    ok('...errText is "<code>: <translation>" with the placeholders filled, and an unknown code comes back bare', de === 'MPH-U08: ' + loc.de['err.U08'].replace('{status}', '503') && /503/.test(de) && I.errText('MPH-X99') === 'MPH-X99', de);
    ok('...fail() makes a throwable carrying code, vars and detail; errMsg shows the translation WITHOUT the detail, and also finds a code at the front of plain text',
       (() => { const e = c2.MephistoI18n.fail('MPH-U08', {status: 404}, 'secret-detail.zip'); const shown = c2.MephistoI18n.errMsg(e);
           return e.code === 'MPH-U08' && e.detail === 'secret-detail.zip' && /secret-detail\.zip/.test(e.message) && !/secret-detail/.test(shown) && shown.startsWith('MPH-U08: ')
               && c2.MephistoI18n.errMsg('Error: MPH-N03: maia3.onnx failed its SHA-256 check').startsWith('MPH-N03: ' + loc.de['err.N03'].slice(0, 10))
               && c2.MephistoI18n.errMsg(new Error('plain')) === 'plain'; })());
}
(async () => {
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // ---- the updater: run the REAL verifyFolder / zip reader against a fake directory handle ----
    const upSrc = fs.readFileSync(ROOT + '/src/scripts/updater.js', 'utf8');
    const c = vm.createContext({console, TextDecoder, TextEncoder, DataView, Uint8Array, Blob, Response, Set, JSON, Promise,
        chrome: {runtime: {getManifest: () => ({name: 'Mephisto Chess Extension', version: '1.0.0'})}, storage: {local: {get: async () => ({}), set: async () => {}}}}});
    c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8'), c);
    vm.runInContext(upSrc.replace('const MephistoUpdater =', 'var MephistoUpdater =').replace(/\nif \(typeof module[\s\S]*$/, ''), c);
    const U = vm.runInContext('MephistoUpdater', c), I = c.MephistoI18n;
    const dirWith = (manifestText) => ({getFileHandle: async (name) => {
        if (name !== 'manifest.json' || manifestText === null) throw new Error('NotFoundError');
        return {getFile: async () => ({text: async () => manifestText})}; }});
    const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
    const wrong = await caught(U.verifyFolder(dirWith(JSON.stringify({name: 'Some Other Extension', version: '9'}))));
    const empty = await caught(U.verifyFolder(dirWith(null)));
    const junk = await caught(U.verifyFolder(dirWith('not json')));
    const right = await U.verifyFolder(dirWith(JSON.stringify({name: 'Mephisto Chess Extension', version: '3.1.0'})));
    ok('updater: the folder of another extension is MPH-U02, a folder with no (or unreadable) manifest.json is MPH-U01, Mephisto\'s own folder passes',
       wrong && wrong.code === 'MPH-U02' && empty && empty.code === 'MPH-U01' && junk && junk.code === 'MPH-U01' && right.version === '3.1.0', [wrong && wrong.code, empty && empty.code, junk && junk.code]);
    const loc = (l) => JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + l + '.json', 'utf8'));
    ok('updater: what the user sees for a wrong folder is "MPH-U02: " plus the translated message, without the name of the other extension; the name stays in the log text',
       I.errMsg(wrong) === 'MPH-U02: ' + loc('en')['err.U02'] && /^MPH-U02: That isn't Mephisto's folder\./.test(I.errMsg(wrong)) && !/Some Other Extension/.test(I.errMsg(wrong)) && /Some Other Extension/.test(wrong.message),
       I.errMsg(wrong));
    I.setFallback(loc('en')); I.setStrings('ja', loc('ja'));
    ok('...and in another language it is the same code with that language\'s sentence', I.errMsg(wrong) === 'MPH-U02: ' + loc('ja')['err.U02']);
    let zipErr = null; try { U._readZip(new ArrayBuffer(64)); } catch (e) { zipErr = e; }
    ok('updater: a buffer that is not a zip is MPH-U10 (damaged), raised before anything is written', zipErr && zipErr.code === 'MPH-U10', zipErr && zipErr.message);
    let notFull = null; try { await U._readUpdateArchive(new ArrayBuffer(64), '1.0.0'); } catch (e) { notFull = e; }
    ok('updater: the update archive reader refuses a bad archive with a coded error', notFull && /^MPH-U\d\d$/.test(notFull.code || ''), notFull && notFull.message);
    ok('updater: no failure path throws a bare English Error any more (every throw carries a code)', !/new Error\(/.test(upSrc.replace(/\/\/.*$/gm, '')));
    ok('updater: the wiring that shows it: Settings uses errMsg for the coded error and keeps the console detail',
       (() => { const g = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
           return /const oops = \(e, fallback, changed\) => \{\s*console\.warn\('Mephisto updater:', e\);[\s\S]{0,300}MephistoI18n\.errMsg\(e\)/.test(g)
               && /say\(oops\(e, 'Update failed, and nothing was changed', true\)\)/.test(g) && /say\(oops\(e, 'Could not use that folder', false\)\)/.test(g); })());
    // ---- the panel: a coded engine message (a model download, MPH-N..) is shown as its registry line ----
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const hs = psrc.indexOf('const err_line ='), helpers = psrc.slice(hs, psrc.indexOf('// Background-play tracing from the PANEL side', hs));
    const ia = psrc.indexOf('function on_engine_error('), onErr = psrc.slice(ia, psrc.indexOf('\n}\n', ia) + 3);
    const pc = vm.createContext({console: {error() {}, warn() {}, log() {}}, String, Object, Error, RegExp, TypeError}); pc.self = pc;
    vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8'), pc);
    vm.runInContext(`var shown = null, engine_restarting = false, engine_ready = true, engine_restarts = 0, engine = {}, last_engine_crash_at = 0;
        function update_best_move(t) { shown = t; } function toggle_calculating() {} function i18n(k, d) { return d; }
        function initialize_engine() { return Promise.resolve(); } let last_eval = {}; ${helpers} ${onErr}`, pc);
    vm.runInContext(`on_engine_error('Error: MPH-N03: maia3-23m.onnx failed its SHA-256 check against the engine manifest - not used, not kept')`, pc);
    const coded = pc.shown;
    vm.runInContext(`on_engine_error('Error: something nobody coded')`, pc);
    ok('panel: a model download that failed shows its MPH-N line (no file name, no 120-character cut); an engine error nobody coded is MPH-E05 with the detail',
       coded === 'MPH-N03: ' + loc('en')['err.N03'] && /^MPH-E05: Engine error - Error: something nobody coded$/.test(pc.shown), [coded, pc.shown]);
    const mf = fs.readFileSync(ROOT + '/src/offscreen/model-fetch.js', 'utf8');
    ok('model downloads: every failure of fetchModel carries an N code at the front of its message (they cross to the panel as text)',
       !/new Error\(/.test(mf.replace(/const coded = [^\n]*/, '')) && (mf.match(/coded\('MPH-N0[1-4]'/g) || []).length === 6);
})().catch(e => { fails++; console.log('FAIL error-code checks threw: ' + (e && e.stack || e)); });
// ---- issue 2: a backend that does not answer moves play to the debugger clicker --------------
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = csrc.indexOf('const BACKEND_RETRY_MS'), b = csrc.indexOf('function getRandomSampledXY');
    const c = vm.createContext({console: {log() {}, warn() {}}, config: {python_autoplay_backend: true}, page_zoom: 1,
        window: {outerHeight: 900, innerHeight: 800, screenX: 10, screenY: 20}, refreshPageZoom() {}, tabActive: () => true});
    vm.runInContext(csrc.slice(a, b) + `; var now = Date.now; Date.now = () => now() + (globalThis.skew || 0);`, c);
    const xy = () => vm.runInContext('toClickXY(100, 50)', c);
    ok('backend up: screen pixels', JSON.stringify(xy()) === '[110,170]', xy());
    vm.runInContext(`try { backendRefused({backendFailed: true}); } catch (e) { globalThis.threw = true; }`, c);
    ok('a refused click rejects, so the move goes through the normal recovery', c.threw === true);
    ok('...and the retry aims in viewport pixels for the debugger', JSON.stringify(xy()) === '[100,50]', xy());
    vm.runInContext('skew = BACKEND_RETRY_MS + 1', c);
    ok('...and the backend is asked again after the window', vm.runInContext('useBackend()', c) === true);
    const d = psrc.indexOf('function backend_refused(e)'), e = psrc.indexOf('function resolve_click_tab');
    const pc = vm.createContext({console: {log() {}, warn() {}}, Date, Number, bgTrace() {}, idle: []});
    vm.runInContext(`let idle_hold_until = 0; function set_idle_reason(t) { idle.push(t); }
        async function request_backend_click() { throw new TypeError('Failed to fetch'); }
        async function request_debugger_click() { return {viaDebugger: true}; }
        async function resolve_click_tab() { return 1; }
        var chrome = {runtime: {sendMessage: async () => ({})}};` + psrc.slice(d, e), pc);
    (async () => {
        const r1 = await vm.runInContext('dispatch_click_event(1, 2, 3, 0, 0, true)', pc);
        const r2 = await vm.runInContext('dispatch_click_event(1, 2, 3, 0, 0, false)', pc);
        const r3 = await vm.runInContext('dispatch_drag_event(1, 2, 3, 4, 3, 0, true)', pc);
        ok('panel: a refused click answers backendFailed and says why', r1?.backendFailed === true && /localhost:8080/.test(pc.idle[0]), r1);
        ok('panel: the debugger path is unchanged', r2?.viaDebugger === true, r2);
        ok('panel: a refused drag answers the same way', r3?.backendFailed === true, r3);
    })();
}
// ---- ENG-2 / PAGE-11: a closed panel costs nothing, a reopen adds nothing ----------------------
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function watch_config_changes() {');
    const c = vm.createContext({n: 0, chrome: {storage: {onChanged: {addListener() { c.n++; }}}}});
    vm.runInContext('var config_watch_on = false;' + psrc.slice(i, psrc.indexOf('\n}\n', i) + 3) + 'watch_config_changes(); watch_config_changes();', c);
    ok('the config listener goes on once however often the panel opens', c.n === 1, c.n);
    ok('the fallback poll is cleared before a new one starts, and on close',
       /clearInterval\(fen_poll_timer\);\s*fen_poll_timer = setInterval\(/.test(psrc)
       && /suspend: \(\) => \{\s*clearInterval\(fen_poll_timer\); fen_poll_timer = null;/.test(psrc));
    ok('the page listeners go on once', /if \(!page_listeners_on\) \{\s*page_listeners_on = true;/.test(psrc));
    ok('closing the panel disconnects the board observer and drops a queued scrape',
       /function removeOverlay\(\) \{[\s\S]*?positionObserver\?\.disconnect\(\); positionObserver = null;\s*clearTimeout\(pushDebounce\); pushDebounce = null;\s*\}/.test(csrc));
}
// ---- PAGE-5: Autoplay off and the focus hold are asked again after the think -------------------
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = csrc.indexOf('function moveHeldBack()');
    const c = vm.createContext({});
    vm.runInContext('var site = \'lichess\', config = {autoplay: true, background_play: false}, pendingManual = false, active = true; const tabActive = () => active;' + csrc.slice(i, csrc.indexOf('\n}\n', i) + 3), c);
    const held = (o) => vm.runInContext(`config.autoplay = ${o.ap}; config.background_play = ${!!o.bg}; pendingManual = ${!!o.manual}; active = ${o.active !== false}; moveHeldBack()`, c);
    ok('a move still wanted plays', held({ap: true}) === null);
    ok('Autoplay switched off during the think stops it', held({ap: false}) === 'autoplay');
    ok('...but not a move asked for by hand', held({ap: false, manual: true}) === null);
    ok('tabbing away holds it, unless Background Play is on', held({ap: true, active: false}) === 'hidden' && held({ap: true, active: false, bg: true}) === null);
    ok('the click guard asks, after the board check', /boardStillMatchesAnalysis\(pendingForPush\)\) \{\s*dropMove\('The board moved on while it was thinking[\s\S]{0,700}const held = moveHeldBack\(\);/.test(csrc));
}
// ---- PAGE-16: a move that clicked nothing has nothing to verify ------------------------------
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = csrc.indexOf('async function simulateMoveVerified(');
    const c = vm.createContext({console: {warn() {}}, setTimeout});
    vm.runInContext(`var DROP_RE = /@/, UCI_RE = /^[a-h][1-8][a-h][1-8][qrbnk]?$/, polls = 0, clicks = 0, lastPushKey = 'k', lastDisplayKey = 'k', resumePush = false, answer;
        function getMoveRecords() { return []; } async function promiseTimeout() { polls++; } function schedulePush() {} function leftSelected() { return null; }
        async function simulateMove() { clicks++; return answer; }` + csrc.slice(i, csrc.indexOf('\n}\n', i) + 3), c);
    (async () => {
        await vm.runInContext(`answer = false; simulateMoveVerified('e2e4', null, true)`, c);
        ok('a dropped or superseded move is not polled or retried, and the panel\'s re-push is left alone',
           c.polls === 0 && c.clicks === 1 && c.lastPushKey === 'k', [c.polls, c.clicks]);
    })();
    ok('a dropped move skips the promotion picker, and a superseded session cannot click a newer one\'s',
       /if \(await performSimulatedMoveClicks\(total \* 0\.20, total \* 0\.55, total\) === false\) return false;\s*if \(sessionGen !== undefined && sessionGen !== moveGen\) return false;/.test(csrc));
}
// ---- PAGE-18: antichess promotes to a king --------------------------------------------------
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const re = vm.runInNewContext(csrc.match(/const UCI_RE = (.+);/)[1]);
    ok('a king promotion is a move, a seven-letter one is not', re.test('e7e8k') && re.test('e7e8q') && re.test('e2e4') && !re.test('e7e8x'));
    ok('every 8x8 move check shares the one pattern', !/\[a-h\]\[1-8\]\[a-h\]\[1-8\]\[qrbn\]/.test(csrc));
    ok('lichess finds the king as its fifth choice', /'q': 0, 'n': 1, 'r': 2, 'b': 3, 'k': 4/.test(csrc));
}
// ---- PAGE-8: promotion by piece -----------------------------------------------------------
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = csrc.indexOf('function getPromotionSelection('), j = csrc.indexOf('function isAnimating()');
    const pieces = ['wr', 'wn', 'wq', 'wb'].map(k => ({k, classList: {contains: (x) => x === k}}));
    const c = vm.createContext({pieces, site: 'chesscom', isChesscomVariants: () => false, is4PC: () => false,
        document: {querySelectorAll: () => pieces, querySelector: () => null}});
    vm.runInContext(csrc.slice(i, j).replace(/\n\s*\/\/[^\n]*/g, ''), c);
    ok('chess.com: the queen is found by her class in any picker order', vm.runInContext("getPromotionSelection('q')", c)?.k === 'wq', vm.runInContext("getPromotionSelection('q')", c)?.k);
    ok('chess.com variants: the piece comes from the sorted list, not the picker\'s raw children', /const r = found\.kids\[idx\];/.test(csrc) && !/found\.el\.children\[idx\]/.test(csrc));
}
// ---- PAGE-17: a half-click's selection ---------------------------------------------------------
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = csrc.indexOf('let halfClicked = null;'), b = csrc.indexOf('function moveHeldBack()');
    const d = vm.createContext({site: 'lichess', sel: {}, document: {querySelector: () => d.sel}});
    vm.runInContext(csrc.slice(a, b).replace('let halfClicked', 'var halfClicked'), d);
    const left = (half, mv) => { d.halfClicked = half; return vm.runInContext(`leftSelected('${mv}')`, d); };
    ok('a half-click on the real move\'s from-square earns a lead click', left('e2', 'e2e4') === 'e2');
    ok('...once', vm.runInContext("leftSelected('e2e4')", d) === null);
    ok('...another from-square does not', left('e2', 'd2d4') === null);
    d.sel = null; ok('...nor a board with nothing selected', left('e2', 'e2e4') === null);
    d.sel = {}; d.site = 'chesscom'; ok('...nor a site that does not show it', left('e2', 'e2e4') === null);
}
// ---- PLAY-3: a puzzle answer does not survive its pause into a new board ----------------------
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function request_automove(move, think'), j = psrc.indexOf('\n}\n', i) + 3;
    const c = vm.createContext({console: {log() {}}, sent: [], timers: [], setTimeout: (f) => { c.timers.push(f); return 1; }, clearTimeout() {}});
    vm.runInContext(`var setup_fen = null, config = {puzzle_mode: true}, last_eval = {fen: 'A b'}, puzzle_last_sent = {}, puzzle_move_timer = null, analysed_push_key = 'k', our_turn_at = 0, session_counted_fen = null;
        const puzzle_key = (f) => f; const puzzle_move_delay_ms = () => 300; const bgTrace = () => {}; const our_side = () => 'black';
        const safe_deselect_square = () => null; const fresh_timing = () => ({think_time: 0}); const move_situation = () => ''; const session_note_move = () => {};
        const send_to_active_tab = (m) => sent.push(m);` + psrc.slice(i, j), c);
    vm.runInContext(`request_automove('e7e5')`, c); c.timers.shift()();
    ok('the board unchanged: the answer goes after its pause', c.sent.length === 1 && c.sent[0].pv[0] === 'e7e5', c.sent);
    vm.runInContext(`last_eval.fen = 'C b'; request_automove('d7d5'); last_eval.fen = 'D b'`, c); c.timers.shift()();
    ok('the board moved on during the pause: nothing is sent', c.sent.length === 1, c.sent);
}
// ---- PLAY-4: Puzzle Mode plays the engine's move -------------------------------------------
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('book, playstyle and contempt all stand down in Puzzle Mode',
       /const book = config\.puzzle_mode \? null : book_pick\(last_eval\.fen\);/.test(psrc)
       && /const styled = config\.puzzle_mode \? best : playstyle_pick\(best\);/.test(psrc)
       && /const fought = config\.puzzle_mode \? best : contempt_pick\(best\);/.test(psrc));
}
// ---- PLAY-5: Play Book Moves has moves to choose from ----------------------------------------
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('const MULTIPV_FLOOR_MODES'), j = psrc.indexOf('\n}\n', psrc.indexOf('function multipv_floor()')) + 3;
    const e = psrc.indexOf('function explorer_enabled()'), ee = psrc.indexOf('\n}\n', e) + 3;
    const c = vm.createContext({});
    vm.runInContext(`var config = {}, explorer_out_of_book = false, explorer_error = null, document = {hidden: false};` + psrc.slice(e, ee) + psrc.slice(i, j), c);
    const f = (cfg, out) => vm.runInContext(`config = ${JSON.stringify(cfg)}; explorer_out_of_book = ${out}; multipv_floor()`, c);
    ok('in book with Autoplay: wide enough for a choice', f({book_play: true, autoplay: true}, false) === 4);
    ok('...normal width once out of book, or with it off', f({book_play: true, autoplay: true}, true) === 1 && f({autoplay: true}, false) === 1);
    ok('...and no wider without Autoplay, which is what plays it', f({book_play: true}, false) === 1);
}
// ---- PLAY-6: Suggest a Human Error never widens a search we play from ------------------------
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function human_error_lines()');
    const c = vm.createContext({});
    vm.runInContext(`const HUMANIZE_DEEP_MULTIPV = 20; var config = {};` + psrc.slice(i, psrc.indexOf('\n}\n', i) + 3), c);
    const f = (cfg) => vm.runInContext(`config = ${JSON.stringify(cfg)}; human_error_lines()`, c);
    ok('plain Autoplay keeps its search', f({human_error: true, autoplay: true}) === 1);
    ok('Help Mode and Manual Mode draw only, so they get the wide list', f({human_error: true, autoplay: true, help_mode: true}) === 20 && f({human_error: true, autoplay: true, manual_mode: true}) === 20);
    ok('no Autoplay gets it too', f({human_error: true}) === 20);
}
// ---- PLAY-8: a hazard of zero stays zero ------------------------------------------------------
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function hz_scale_rates(rates, mult)');
    const c = vm.createContext({});
    vm.runInContext(psrc.slice(i, psrc.indexOf('\n}\n', i) + 3), c);
    const r = vm.runInContext(`hz_scale_rates({top: 80, inaccuracy: 10, mistake: 6, blunder: 4}, {inaccuracy: 0, mistake: 1, blunder: 0})`, c);
    ok('a where-multiplier of 0 removes the class instead of keeping the full rate', r.inaccuracy === 0 && r.blunder === 0 && r.mistake > 0, r);
    ok('hz_match_shares treats 0 the same way', /\(mult\.inaccuracy \?\? 1\)[\s\S]{0,80}\(mult\.mistake \?\? 1\)[\s\S]{0,60}\(mult\.blunder \?\? 1\)/.test(psrc));
}
// ---- PLAY-7: a resign the page refused does not freeze the game ------------------------------
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = csrc.indexOf('const RESIGN_CHECK_MS'), j = csrc.indexOf('\n}\n', csrc.indexOf('function doGameAction(kind)')) + 3;
    const run = (button, gone) => {
        const later = [];
        const c = vm.createContext({sent: [], pushes: 0, later, setTimeout: (f) => { later.push(f); }, Date, console: {}});
        let presses = 0;
        c.rule = () => (presses && gone) ? null : button;
        vm.runInContext(`var site = 'x', endActionAt = 0, lastPushKey = 'k', lastDisplayKey = 'k', resumePush = false; const END_ACTION_GAP_MS = 0;
            const END_ACTION_SITES = {x: {resign: () => rule(), draw: () => rule(), confirm: () => null}};
            function sendToPanel(m) { sent.push(m); } function schedulePush() { pushes++; } function bgLogAlways() {}
            function pressControl() { globalThis.pressed = true; }` + csrc.slice(i, j), c);
        vm.runInContext(`doGameAction('resign')`, c);
        presses = 1; later.forEach(f => f());
        return {sent: c.sent.length, pushes: c.pushes, resume: c.resumePush};
    };
    ok('no resign control: the panel is told and the position is pushed again', JSON.stringify(run(null)) === '{"sent":1,"pushes":1,"resume":true}', run(null));
    ok('a button that stays after the press counts as refused', run({}, false).sent === 1);
    ok('a button that went away is a finished game, nothing to report', run({}, true).sent === 0);
    const a = psrc.indexOf('let resign_refused = false;');
    ok('the panel stops trying and clears what withheld the move', /function resign_gave_up\(\) \{\s*resign_refused = true;\s*end_game_sent = ''; end_game_key = ''; end_game_last = null;/.test(psrc)
       && /config\.puzzle_mode \|\| resign_refused\) return null;/.test(psrc) && a > 0);
    ok('...for this game only', /end_game_last = null;\s*resign_refused = false;/.test(psrc));
}
// ---- ENG-6: the lease counts searches ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const osrc = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    ok('a go counts up, a bestmove counts down, a stop waits for its bestmove',
       /searching\[clientId\] = \(searching\[clientId\] \|\| 0\) \+ 1;/.test(osrc) && /searching\[clientId\] = Math\.max\(0, \(searching\[clientId\] \|\| 0\) - 1\);/.test(osrc)
       && !/\(stop\|quit\)\\b\/\.test\(line\)\) searching/.test(osrc));
    const i = osrc.indexOf('function orphanedSearches'), c = vm.createContext({LEASE_MS: 100});
    vm.runInContext(`var searching = {a: 1}, lastSeen = {a: 0};` + osrc.slice(i, osrc.indexOf('\n}\n', i) + 3), c);
    vm.runInContext(`searching.a++; searching.a--;`, c);   // the superseded search's flush after the new go
    ok('after a position change the live search is still seen as an orphan', vm.runInContext('orphanedSearches(500)', c).join() === 'a');
}
// ---- ENG-8: a disposed engine says nothing ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const osrc = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    const i = osrc.indexOf('function disposeClient(clientId)'), c = vm.createContext({heard: []});
    vm.runInContext(`var epoch = {}, searching = {}, lastSeen = {}, engine = {uci() { this.listen('bestmove e2e4'); }, listen: (l) => heard.push(l)}, clients = {x: engine};
        function maybeGoIdle() {}` + osrc.slice(i, osrc.indexOf('\n}\n', i) + 3) + `disposeClient('x');`, c);
    ok('the old search\'s flush never reaches the panel', c.heard.length === 0, c.heard);
}
// ---- ENG-10: a failed load is not retried per UCI line ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const osrc = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    ok('every load goes through startEngine, and the respawn waits out the backoff',
       (osrc.match(/\.catch\(e => send\(clientId, \{kind: 'error'/g) || []).length === 0
       && /Date\.now\(\) - \(loadFailedAt\[clientId\] \|\| 0\) > RELOAD_BACKOFF_MS/.test(osrc)
       && /delete loadFailedAt\[clientId\];\s*startEngine\(clientId, msg\.engine/.test(osrc));
}
// ---- ENG-11: one Maia-3 session for Maia-2's openings ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const m = fs.readFileSync(ROOT + '/src/offscreen/maia2.js', 'utf8');
    ok('the session\'s promise is cached and terminate follows it', /opening = opening \|\| import\(/.test(m) && /opening\?\.then\(net => net\.terminate\(\)\)/.test(m));
}
// ---- ENG-5: a crash on a held position analyses it again ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('the crash path re-drives a held position', /force re-analysis on next fen poll[\s\S]{0,120}if \(setup_fen\) on_new_pos\(setup_fen, setup_fen, ''\);/.test(psrc));
}
// ---- ENG-7: a one-pass answer cannot be taken for the next position ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function on_engine_response(message) {');
    const head = psrc.slice(i, psrc.indexOf('last_info_at = Date.now();   // the panel is HEARING', i));
    const c = vm.createContext({console: {log() {}, warn() {}}});
    vm.runInContext(`var pending_stops = 0, stop_charged_at = 0, search_active = false, last_info_at = 0, one_pass_owed = 0, passed = [];
        const STOP_FLUSH_MS = 1500; function is_remote() { return false; } function is_one_pass() { return true; }
        function note_unsupported_variant() {} function download_progress_text() { return null; } function update_best_move() {}
        ${head} passed.push(message); }
        function abandon() { if (search_active) { pending_stops++; stop_charged_at = Date.now(); } search_active = false; }
        function go() { search_active = true; one_pass_owed++; }`, c);
    const got = vm.runInContext(`go(); abandon(); go();        // A, then B
        on_engine_response('bestmove aaaa');                    // A's pays B's stop while B is in flight
        const live = search_active;
        abandon(); go();                                        // C charges a stop for B
        on_engine_response('bestmove bbbb');                    // B's is eaten
        on_engine_response('bestmove cccc');                    // C's is the answer
        ({live, passed})`, c);
    ok('B stays live after A pays for it, so C charges a stop and B\'s answer is dropped',
       got.live === true && JSON.stringify(got.passed) === '["bestmove cccc"]', got);
}
// ---- ENG-9: a failed net pass is not a draw ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('a one-pass (none) with legal moves left says the net failed, before any game-over text',
       /if \(is_one_pass\(\) && !mated && end\.moves\(\)\.length\) \{\s*(\/\/[^\n]*\s*)*update_best_move\(i18n\('panel\.msg\.net_failed'/.test(psrc)
       && psrc.indexOf("'panel.msg.net_failed'") < psrc.indexOf("'panel.msg.stalemate'"));
}
// ---- ENG-3 / ENG-4: a superseded native frame is not an answer ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function search_same_position()'), j = psrc.indexOf('// The restart budget is for a build that traps REPEATEDLY');
    const c = vm.createContext({timers: [], setTimeout: (f) => { c.timers.push(f); }, answers: [], idle: [], Math});
    vm.runInContext(`var last_eval = {fen: 'P'}, fen_request_inflight = true, setup_fen = null, PANEL_BOOTED = true, asked = 0;
        function on_new_pos() {} function request_fen() { asked++; last_eval.fen = 'P'; }
        function on_engine_response(r) { answers.push(r); } function set_idle_reason(t) { idle.push(t); }` + psrc.slice(i, j), c);
    vm.runInContext(`on_remote_result({bestmove: 'e2e4'})`, c);
    ok('an ordinary answer goes through', c.answers.length === 1);
    vm.runInContext(`on_remote_result({bestmove: 'a2a3', superseded: true})`, c);
    ok('a superseded frame is not an answer', c.answers.length === 1);
    c.timers.shift()();
    ok('...the position is searched again', c.asked === 1 && vm.runInContext('fen_request_inflight', c) === false, c.asked);
    vm.runInContext(`on_remote_result({superseded: true}); last_eval.fen = 'Q';`, c); c.timers.shift()();
    ok('...unless the position moved on', c.asked === 1, c.asked);
    vm.runInContext(`last_eval.fen = 'P'; for (let i = 0; i < 4; i++) on_remote_result({superseded: true});`, c);
    ok('after five in a row it stops and says why', c.idle.length === 1 && /native engine/.test(c.idle[0]) && c.timers.length === 3, c.idle);
    const e = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    ok('Review asks again rather than scoring a short frame', /for \(let tries = 0; frame\.superseded && tries < 5; tries\+\+\)/.test(e));
}
// ---- SYS-4: arrow evals recover from a dead engine ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = psrc.indexOf('function ua_ask(after, replies, wanted)'), b = psrc.indexOf('// Called when the drawn arrows change and when the position does.');
    const c = vm.createContext({setTimeout, clearTimeout});
    vm.runInContext(`const UA_TIMEOUT_MS = 1, UA_MOVETIME_MS = 1; var ua_id = 'x', ua_ready = 1, ua_serial = Promise.resolve(), disposed = 0, fail = null;
        const ua_pending = new Set(), ua_cache = new Map(), ua_failed = new Map();
        const ua_engine = async () => { if (fail) throw fail; }; const ua_dispose = () => { disposed++; ua_id = null; ua_ready = null; };
        const ua_parse_info = () => null, ua_result = () => ({});
        const chrome = {runtime: {sendMessage() {}, onMessage: {addListener() {}, removeListener() {}}}};` + psrc.slice(a, b), c);
    (async () => {
        await vm.runInContext(`ua_ask({fenAfter: 'P'}, 0, () => true)`, c);
        ok('a question that timed out is marked and the client dropped, so the next one rebuilds it',
           vm.runInContext(`ua_failed.has('P|0') && disposed === 1 && ua_ready === null`, c));
        await vm.runInContext(`fail = new Error('no net'); ua_ask({fenAfter: 'Q'}, 0, () => true)`, c);
        ok('a failed load is marked rather than swallowed', vm.runInContext(`ua_failed.has('Q|0')`, c));
    })();
    ok('a recent failure shows ? and does not ask again', /< UA_RETRY_MS\) label = '\?';\s*else ua_ask\(/.test(psrc));
}
// ---- SYS-6: a new position or Re-detect ends the old panel line ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('Re-detect and a set FEN both reset the line',
       /stash_setup_state\(\);\s*panel_line_reset\(''\);/.test(psrc)
       && /setup_fen = parsed;\s*stash_setup_state\(\);\s*panel_line_reset\(parsed\);/.test(psrc));
}
// ---- SYS-9: the out-of-book latch ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const n = (psrc.match(/explorer_out_of_book = false; explorer_data = null; explorer_empty_streak = 0;/g) || []).length;
    ok('Re-detect and walking the line clear it too', n >= 5 && /panel\.fen\.walking_line[\s\S]{0,200}explorer_out_of_book = false;/.test(psrc), n);
}
// ---- SYS-8: holds out longest ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function tablebase_reason(fen, uci)');
    const c = vm.createContext({});
    vm.runInContext(`var tablebase_data = {fen: 'F', category: 'loss', moves: [{uci: 'a', category: 'win', dtm: 9}, {uci: 'b', category: 'win', dtm: 3}]};` + psrc.slice(i, psrc.indexOf('\n}\n', i) + 3), c);
    ok('the move that loses slowest gets the reason, the quick loss does not',
       vm.runInContext(`tablebase_reason('F', 'a')`, c) === 'holds out longest' && vm.runInContext(`tablebase_reason('F', 'b')`, c) === '');
}
// ---- OPT-2: a settings export imports ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/options/util/SettingsPage.js', 'utf8');
    ok('the raw keys leave the export, are skipped on import and are kept on this machine',
       /for \(const k of RAW_KEYS\) delete all\[k\];/.test(s) && /for \(const k of RAW_KEYS\) delete obj\[k\];/.test(s) && /\.\.\.RAW_KEYS\];/.test(s));
    ok('...skipped before the JSON check that refused them', s.indexOf('delete obj[k]') < s.indexOf('const broken = Object.entries(obj)'));
}
// ---- SYS-15: the tablebase path stays on this machine ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/options/util/SettingsPage.js', 'utf8');
    ok('not exported, not cleared by an import', /delete all\.tb_path;/.test(s) && /'player_book_cache', 'tb_path', \.\.\.RAW_KEYS\]/.test(s));
}
// ---- SYS-10 / SYS-11: finishing an update ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const u = fs.readFileSync(ROOT + '/src/scripts/updater.js', 'utf8');
    const i = u.indexOf('function manifestLast(files)'), c = vm.createContext({});
    vm.runInContext(u.slice(i, u.indexOf('\n    }\n', i) + 7), c);
    ok('manifest.json is written last', vm.runInContext(`manifestLast([{path: 'lib/a'}, {path: 'manifest.json'}, {path: 'src/b'}]).map(f => f.path).join()`, c) === 'lib/a,src/b,manifest.json');
    ok('both write loops use that order', (u.match(/for \(const f of manifestLast\(files\)\)/g) || []).length === 2);
    ok('finishing a staged update answers in install()\'s shape', /return \{installed: version, from, files: files\.length, backedUp:/.test(u));
}
// ---- SYS-7: a lapsed folder grant asks for a click ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const g = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    ok('the autostart checks the grant without prompting', /if \(await MephistoUpdater\.folder\(\)\) runInstall\(\);\s*else say\('One click needed/.test(g));
}
// ---- SYS-3: toolbar popup reaches its tab ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const w = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const i = w.indexOf('async function tabOfAsker(msg, sender)'), c = vm.createContext({chrome: {runtime: {id: 'me'}, tabs: {get: async (id) => ({id})}}});
    vm.runInContext(w.slice(i, w.indexOf('\n}\n', i) + 3), c);
    (async () => {
        const own = {id: 'me', url: 'chrome-extension://me/src/popup/popup.html'};
        const t1 = await vm.runInContext('tabOfAsker', c)({tabId: 5}, own);
        const t2 = await vm.runInContext('tabOfAsker', c)({tabId: 5}, {tab: {id: 9}});
        const t3 = await vm.runInContext('tabOfAsker', c)({tabId: 5}, {id: 'me', url: 'https://evil.example/'});
        ok('our own page may name a tab', t1?.id === 5, t1);
        ok('a content script always gets its own tab, whatever it names', t2?.id === 9, t2);
        ok('anything else gets none', t3 === undefined, t3);
    })();
    ok('Read Position and Bot Tricks both go through it', /tabOfAsker\(msg, sender\)\.then\(tab => botExploit/.test(w) && /const tab = await tabOfAsker\(msg, sender\);\s*if \(!tab \|\| tab\.id == null\)/.test(w));
}
// ---- SYS-13: the Analysis Board link keeps the side to move ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('whole FEN, and a variant missing from the map falls back', /analysis\/\$\{variant\}\/\$\{last_eval\.fen\.replace\(\/ \/g, '_'\)\}/.test(psrc) && /variantNameMap\[config\.variant\] \|\| 'standard'/.test(psrc));
}
// ---- SYS-14: the auto-flip notice keeps the fix chips ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('the notice is passed in, and nothing overwrites the chips afterwards',
       /render_unsure\(res\.low \|\| \[\], res\.unresolved \|\| \[\], auto_flipped \? i18n\('panel\.fen\.auto_flipped'/.test(psrc)
       && !/if \(auto_flipped\) setup_fen_msg/.test(psrc) && /el\.textContent = lead \|\|/.test(psrc));
}
// ---- OPT-3: Game Review keeps the chosen engine across a page open ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const body = src.slice(src.indexOf('function updateEngineOptions()'), src.indexOf('function bindNumber('));
    const run = (nativeAvailable, stored) => {
        const writes = [];
        const ENGINES = [{id: 'sf19', label: 'a', kind: 'wasm'}, {id: 'sf18', label: 'b', kind: 'wasm'}, {id: 'nat', label: 'c', kind: 'native'}];
        const sel = {value: '', innerHTML: '', get options() {
            return ENGINES.map(e => ({value: e.id, disabled: e.kind === 'native' && nativeAvailable && !nativeAvailable[e.id]})); }};
        vm.runInNewContext(body + '; updateEngineOptions();', {ENGINES, nativeAvailable, esc: s => s, $: () => sel,
            cfg: () => stored, setCfg: (k, v) => writes.push(v)});
        return {value: sel.value, writes};
    };
    let r = run(null, 'sf18');
    ok('an empty select takes the stored engine and writes nothing', r.value === 'sf18' && r.writes.length === 0, r);
    r = run({nat: false}, 'nat');
    ok('a stored native engine whose host is gone falls back, and only that writes', r.value === 'sf19' && r.writes.join() === 'sf19', r);
}
// ---- OPT-4: Fit Humanize turns off what would ignore it ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    ok('the fit switches Play-like matching off, and says so',
       /setCfg\('humanize_match', false\);\s*btn\.textContent = `Fitted from \$\{fit\.n\} moves - Play-like matching off`/.test(src));
}
// ---- OPT-5: analyses queued on a left page do not run ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    ok('a call keeps the generation it was queued under', /const gen = pageGen;\s*const run = \(\) => analyseNow\(gen\);/.test(src));
    ok('analyseNow leaves on a moved generation, on entry and after the stop',
       /async function analyseNow\(gen\) \{\s*if \(gen !== pageGen\) return;/.test(src)
       && /await stopSearch\(\);[^\n]*\n\s*if \(gen !== pageGen\) return;\s*let e;/.test(src));
}
// ---- OPT-6: a revisited page starts with no form elements ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/util/SettingsPage.js', 'utf8');
    ok('onInit resets the list before init() registers the page again',
       /async onInit\(\) \{[\s\S]*?this\.formElements = \[\];[\s\S]*?this\.init\(\);/.test(src));
}
// ---- OPT-7: the Analysis tablebase line reads like the panel ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const a = src.indexOf('function tbWords(tb)');
    const tbWords = vm.runInNewContext('(' + src.slice(a, src.indexOf('\n}\n', a) + 2) + ')');
    ok('dtm is plies: 17 is a mate in 9', tbWords({category: 'win', dtm: 17, dtz: 3}) === 'mate in 9');
    ok('...and from the losing side too', tbWords({category: 'loss', dtm: -16}) === 'mated in 8');
    ok('dtz alone is said as DTZ', tbWords({category: 'win', dtz: 27}) === 'winning, DTZ 27');
    ok('no count is no number', tbWords({category: 'win'}) === 'winning' && tbWords({category: 'cursed-win'}) === 'winning (50-move drawn)');
    ok('a draw stays a draw', tbWords({category: 'draw', dtz: 0}) === 'draw');
}
// ---- OPT-8: the classifier search times out on silence, not on a slow position ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/ee-host.js', 'utf8');
    ok('every engine line re-arms the timer', /if \(m\.type === 'line'\) \{[\s\S]{0,300}?bump\(\);\s*if \(onLine\) onLine\(String\(m\.line\)\);/.test(src));
}
// ---- OPT-9: Stop in a batch keeps the finished games ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    ok('a Stop inside a game ends the loop when a game is finished, and says how far it got',
       /catch \(e\) \{[\s\S]{0,200}?if \(cancel && done\.length\) break;[\s\S]{0,1200}?throw e;/.test(src)
       && /else if \(done\.length < list\.length\) note\(`Stopped after/.test(src));
}
// ---- OPT-10: Search Time has a floor everywhere ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const html = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const a = psrc.indexOf('function clamp_compute_time(');
    const clamp = vm.runInNewContext('(' + psrc.slice(a, psrc.indexOf('\n', a)) + ')');
    ok('0, nonsense and low values land on the floor; a real value is untouched',
       clamp(0) === 50 && clamp('x') === 50 && clamp(10) === 50 && clamp(300) === 300);
    ok('boot and the live path both clamp, and the field starts at 50',
       /compute_time: \(computeTime != null\) \? clamp_compute_time\(computeTime\) : 300/.test(psrc)
       && /if \(key === 'compute_time'\) config\.compute_time = clamp_compute_time\(value\);/.test(psrc)
       && /id="compute_time_input" type="number" min="50"/.test(html));
}
// ---- OPT-11: chess.com import is newest first ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = src.indexOf('async function fetchChesscom(user)');
    const fn = vm.runInNewContext('(' + src.slice(a, src.indexOf('\n}\n', a) + 2) + ')', {
        fetch: async (u) => ({ok: true, json: async () => /archives$/.test(u) ? {archives: ['m9', 'm10']}
            : u === 'm10' ? {games: [{pgn: 'new1'}, {pgn: 'new2'}]}
            : {games: Array.from({length: 45}, (_, i) => ({pgn: 'old' + i}))}})});
    fn('someone').then(s => {
        const list = s.split('\n\n');
        ok('this month leads, newest first, then last month from its end, capped at 40',
           list.length === 40 && list[0] === 'new2' && list[1] === 'new1' && list[2] === 'old44', list.slice(0, 3));
    }).catch(e => ok('fetchChesscom ran', false, String(e)));
}
// ---- OPT-12: a new run hides every section of the old report ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    ok('all five sections', /\['rv-report', 'rv-indicators', 'rv-human', 'rv-strength', 'rv-batch'\]\) \$\(id\)\?\.classList\.add\('hidden'\)/.test(src));
}
// ---- OPT-13: the Game type dropdown follows a 4-player switch ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = src.indexOf('function detectVariantFrom(game)');
    const body = src.slice(a, src.indexOf('\n}\n', a) + 3);
    const run = (variant, tag) => {
        let store = variant, syncs = 0;
        const ctx = {cfg: () => store, setCfg: (k, v) => { store = v; }, syncGameTypeUi: () => { syncs++; },
            RV_PGN_VARIANTS: {}, RV_PGN4_VARIANTS: {'4pc': true}, looks960: () => false};
        vm.runInNewContext('var is4pcGame = false;' + body + '; this.out = detectVariantFrom(game);',
            Object.assign(ctx, {game: {tags: tag ? {Variant: tag} : {}}}));
        return {store, syncs};
    };
    let r = run('chess', '4pc');
    ok('a PGN4 sets the type and re-syncs the page', r.store === '4pc' && r.syncs === 1, r);
    r = run('4pc', '');
    ok('a normal PGN after one does too', r.store === 'chess' && r.syncs === 1, r);
    r = run('4pc', '4pc');
    ok('no switch, no re-sync', r.store === '4pc' && r.syncs === 0, r);
}
// ---- OPT-14: a PGN with bare move numbers parses ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console: {log() {}}, URLSearchParams};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    const parse = (t) => c.MephistoReviewCore.parsePgn(t)[0];
    let g = parse('1 e4 e5 2 Nf3 Nc6 *');
    ok('bare numbers are skipped and every move survives', g.moves.map(m => m.san).join(' ') === 'e4 e5 Nf3 Nc6', g.moves);
    g = parse('1. e4 {first} e5 2 Nf3 {third} Nc6 1-0');
    ok('a real comment still lands on the move before it, past a bare number',
       g.moves[0].comment === 'first' && g.moves[1].comment === '' && g.moves[2].comment === 'third' && g.result === '1-0', g.moves);
}
// ---- OPT-15: a language change reaches an open panel ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('language is live, and the listener reloads the strings',
       /const LIVE_CONFIG_KEYS = \[\s*'language',/.test(psrc) && /if \(key === 'language'\) load_language\(value\)\.then\(apply_language\);/.test(psrc));
}
// ---- OPT-16: returning to Game Review keeps the batch and the run's rating ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    ok('the rating is stamped on the report and read back from it',
       /opts\.humanLevel = level;/.test(src) && /humanLevel: opts\.humanLevel,/.test(src) && /const band = report\.humanLevel \?\? /.test(src));
    ok('re-entry redraws the batch table', /parsePgnBox\(\);\s*renderReport\(\);\s*renderBatch\(\);\s*\}/.test(src));
}
// ---- OPT-17: Crazyhouse drop lines play and draw ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
    const calls = [];
    const c = {playMove: (...a) => calls.push(a), flipped: false, Core: {clamp: (v, a, b) => Math.min(b, Math.max(a, v))}};
    vm.runInNewContext(cut('function playUci(uci)', 'function playMove(from') + cut('function rankBadge(', '// ---- moves by rating')
        + ';this.playUci = playUci; this.arrow = arrow;', c);
    c.playUci('N@f3'); c.playUci('e7e8q');
    ok('a drop goes to playMove as a drop, a normal line as squares',
       JSON.stringify(calls[0]) === '[null,"f3",null,"N"]' && JSON.stringify(calls[1]) === '["e7","e8","q"]', calls);
    const svg = c.arrow('N@f3', '#111', 0.1, 0.8, 2);
    ok('a drop draws a ring on the target (f3 = 5.5, 5.5) with its rank', /<circle cx="5.5" cy="5.5" r="0.36"/.test(svg) && />2<\/text>/.test(svg), svg);
    ok('a normal move still draws an arrow with its badge', /<polygon/.test(c.arrow('e2e4', '#111', 0.1, 0.8, 1)) && />1<\/text>/.test(c.arrow('e2e4', '#111', 0.1, 0.8, 1)));
    ok('every line click and the space key go through playUci',
       /row\.addEventListener\('click', \(\) => playUci\(uci\)\)/.test(src) && /if \(uci\) \{ playUci\(uci\); e\.preventDefault\(\); \}/.test(src));
}
// ---- OPT-18: an export only carries this position's chart ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const a = src.indexOf('function bandsFor(pos)');
    const run = (last, human) => vm.runInNewContext(src.slice(a, src.indexOf('\n}\n', a) + 3) + '; bandsFor({fen: "A"})',
        {lastBands: last, cfg: () => human});
    const mine = {pos: {fen: 'A'}, kind: 'maia'};
    ok('same position, same model: the chart goes in', run(mine, 'maia') === mine);
    ok('another position, or another model, or none: it stays out',
       run({pos: {fen: 'B'}, kind: 'maia'}, 'maia') === null && run(mine, '') === null && run(null, 'maia') === null);
    ok('the export reads that, for the picture and the table',
       /const bands = bandsFor\(pos\);/.test(src) && /\$\{bands \? \$\('an_bands_wrap'\)/.test(src) && /exportBandTable\(bands\)/.test(src));
}
// ---- OPT-19: one bad move ends one book game ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    ok('the move is caught singly', /let mv = null;\s*try \{ mv = c\.move\(san\); \} catch \(e\) \{[^}]*\}\s*if \(!mv\) break;/.test(src));
}
// ---- OPT-20: the Analysis move list numbers from the start FEN ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const core = {console: {log() {}}, URLSearchParams};
    core.self = core;
    vm.createContext(core);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), core);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), core);
    const body = src.slice(src.indexOf('function moveNumberOf(node)'), src.indexOf('function highlightMove()'));
    const list = (fen, sans) => {
        const root = {fen, parent: null, children: []}; let n = root, id = 0;
        for (const san of sans) { const k = {san, id: ++id, parent: n, children: []}; n.children.push(k); n = k; }
        const alt = {san: 'alt', id: 99, parent: root.children[0], children: []};
        if (root.children[0].children[0]) root.children[0].children.push(alt);
        const el = {innerHTML: '', querySelectorAll: () => []};
        vm.runInNewContext(body + '; renderMoves();', {Core: core.MephistoReviewCore, treeRoot: root, nodeIndex: new Map(),
            $: () => el, esc: s => s});
        return el.innerHTML;
    };
    let h = list('4k3/8/8/8/8/8/8/4K3 b - - 0 30', ['Ke7', 'Ke2', 'Ke6']);
    ok('Black to move on move 30: White cell empty, row 30, reply on 31',
       /an-mnum">30<\/span><span class="an-mcell" >\.\.\.<\/span><span class="an-mcell" data-node="1">Ke7/.test(h)
       && /an-mnum">31<\/span><span class="an-mcell" data-node="2">Ke2<\/span><span class="an-mcell" data-node="3">Ke6/.test(h), h);
    ok('a variation on it is numbered from the FEN too', /31\. alt/.test(h), h);
    h = list('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['e4', 'e5', 'Nf3']);
    ok('a normal game is unchanged',
       /an-mnum">1<\/span><span class="an-mcell" data-node="1">e4<\/span><span class="an-mcell" data-node="2">e5/.test(h)
       && /an-mnum">2<\/span><span class="an-mcell" data-node="3">Nf3/.test(h), h);
}
// ---- PAGE-1/SYS-2: the puzzle probe exists only while Puzzle Capture is on ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const man = JSON.parse(fs.readFileSync(ROOT + '/manifest.json', 'utf8'));
    ok('no static entry', !JSON.stringify(man.content_scripts).includes('puz-probe') && man.permissions.includes('scripting'));
    const src = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const a = src.indexOf("const PUZ_PROBE_ID = 'pz';");
    const body = src.slice(a, src.indexOf('syncPuzProbe();\nchrome.runtime.onInstalled'));
    const world = (stored, registered) => {
        const log = []; let M = [];
        const chrome = {storage: {local: {get: async () => stored}}, scripting: {
            getRegisteredContentScripts: async () => registered ? [{id: 'pz', matches: M}] : [],
            registerContentScripts: async (l) => { log.push(['reg', l[0]]); },
            updateContentScripts: async (l) => { log.push(['update', l[0]]); },
            unregisterContentScripts: async () => { log.push(['unreg']); }}};
        const r = vm.runInNewContext(body + '; ({sync: syncPuzProbe, M: PUZ_PROBE_MATCHES})', {chrome, console, Promise});
        M = r.M;
        return {log, sync: r.sync};
    };
    (async () => {
        let w = world({}, false); await w.sync();
        ok('never enabled: nothing registers', w.log.length === 0, w.log);
        w = world({puzzle_capture: 'false'}, true); await w.sync();
        ok('switched off: unregisters', w.log.length === 1 && w.log[0][0] === 'unreg', w.log);
        w = world({puzzle_capture: 'true'}, false); await w.sync();
        ok('switched on: MAIN world at document_start on the two sites\' puzzle routes, never a whole site',
           w.log.length === 1 && w.log[0][1].world === 'MAIN' && w.log[0][1].runAt === 'document_start'
           && w.log[0][1].js[0] === 'src/scripts/puz-probe.js' && w.log[0][1].matches.length > 0
           && w.log[0][1].matches.every(m => !/\.(org|com)\/\*$/.test(m)), w.log);
        w = world({puzzle_capture: 'true'}, true); await w.sync();
        ok('already right: nothing to do', w.log.length === 0, w.log);
    })().catch(e => ok('syncPuzProbe ran', false, String(e)));
    ok('the worker reconciles at start, on install and on the setting',
       /\nsyncPuzProbe\(\);\nchrome\.runtime\.onInstalled\.addListener\(\(\) => \{ syncPuzProbe\(\); \}\);/.test(src)
       && /changes\.puzzle_capture\) syncPuzProbe\(\)/.test(src));
    const fails14 = fs.readdirSync(ROOT + '/src/i18n/locales').filter(f => {
        const d = JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/' + f, 'utf8'));
        return !d['set.tip.puzzle_capture'] || d['set.tip.puzzle_capture'] === d['set.tip.puzzle_capture_cdp']; });
    ok('the tip is present in all 14 locales', fails14.length === 0, fails14);
}
// ---- PAGE-4/SYS-1: the probe rendezvous listens only where a probe can exist ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf('function onProbeAnnounce(e)');
    const body = src.slice(a, src.indexOf('// --- captured puzzle solutions'));
    const run = (hostname, stored, detail) => {
        const added = [], fired = [];
        const document = {addEventListener: (n, f) => added.push([n, f]), dispatchEvent: (ev) => fired.push(ev.type)};
        const chrome = {storage: {local: {get: (k, cb) => cb(stored)}}};
        vm.runInNewContext(`let ttState, ttSid = null, cbState, cbSid = null, puzSid = null; ${body}`,
            {document, chrome, location: {hostname}, config: null, CustomEvent: class { constructor(t) { this.type = t; } }, acceptPuzzleCaptures() {}, schedulePush() {}});
        const rdv = added.find(x => x[0] === 'm9');
        if (rdv) for (const s of ['a', 'b']) rdv[1]({detail: JSON.stringify({t: 'puz', s})});
        return {listens: !!rdv, fired, added: added.length};
    };
    ok('an ordinary site does not listen at all', !run('example.com', {}).listens);
    ok('lichess and chess.com with the setting off do not listen', !run('lichess.org', {puzzle_capture: 'false'}).listens && !run('www.chess.com', {}).listens);
    const on = run('lichess.org', {puzzle_capture: 'true'});
    ok('with it on, the first channel is taken and a second is ignored', on.listens && on.fired.join() === 'ar' && on.added === 2, on);
    ok('the probe sites still listen', run('taketaketake.com', {}).listens && run('tactics.chessbase.com', {}).listens);
}
// ---- PAGE-9: a minimized panel stays hidden and restores at its Opacity ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
    const body = cut('function applyPanelStyle()', 'function readOverlayBox()') + cut('function restoreOverlay(wrap, badge)', '// Hotkey entry point');
    const wrap = {style: {opacity: '0'}, querySelector: () => null, getBoundingClientRect: () => ({width: 300})};
    let badge = {remove() { badge = null; }};
    const c = {panelOpacity: 60, panelDock: 'free', window: {innerWidth: 1000}, PANEL_OVERLAY_ID: 'p', RESTORE_BADGE_ID: 'b',
        overlayEl: (id) => id === 'p' ? wrap : badge};
    vm.runInNewContext(body + ';this.apply = applyPanelStyle; this.restore = restoreOverlay;', c);
    c.apply();
    ok('a resize while minimized leaves it at 0', wrap.style.opacity === '0', wrap.style.opacity);
    c.restore(wrap, badge);
    ok('restoring lands on the Opacity setting', wrap.style.opacity === '0.6', wrap.style.opacity);
}
// ---- PAGE-14: the 4PC en passant field survives a re-scrape ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf('// Only a real change advances this.');
    const body = src.slice(a, src.indexOf('const ep = fourPCEp;', a));
    const calls = [];
    const c = {fourPCPrev: null, fourPCPrevKey: null, fourPCEp: null, board: null, Object,
        fourPCEnPassant: (b, p) => { calls.push(p); return p ? 'e4' : null; }};
    const step = (b) => { c.board = b; vm.runInNewContext('{' + body + '}', c); return c.fourPCEp; };
    step({a1: {seat: 'R', type: 'P'}});
    ok('the push is read once', step({a2: {seat: 'R', type: 'P'}}) === 'e4' && calls.length === 2, calls.length);
    ok('a second scrape of the same board keeps it, in any key order',
       step({a2: {seat: 'R', type: 'P'}}) === 'e4' && calls.length === 2, calls.length);
    ok('resetting a page clears both', /fourPCPrev = fourPCPrevKey = fourPCEp = null;/.test(src));
}
// ---- PAGE-15: a click during a panel drag cannot leave the body click-through ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('a saved none never comes back', /s\.frame\.style\.pointerEvents = s\.framePE === 'none' \? 'auto' : s\.framePE \|\| ''/.test(src));
}
// ---- PAGE-20: the resize grip keeps a grown panel's height ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('the wrapper follows the frame', /wrap\.style\.height = `\$\{Math\.round\(24 \+ \(parseFloat\(frame\.style\.height\) \|\| panelH\(\)\) \* scale\)\}px`/.test(src));
}
// ---- PAGE-6: a lichess custom start survives the URL changing ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf('let analysisStartKey = null;');
    const c = {site: 'lichess', location: {pathname: '/abcd1234/white', search: '', href: 'https://lichess.org/abcd1234/white#3'}};
    vm.runInNewContext(src.slice(a, src.indexOf('function readStartPos(url)')) + ';this.key = startPosKey;', c);
    const k1 = c.key(); c.location.href = 'https://lichess.org/abcd1234/white#12';
    ok('stepping a game moves the hash, not the key', c.key() === k1, k1);
    c.location.pathname = '/analysis/standard/8_w_-_-'; const k2 = c.key();
    c.location.pathname = '/analysis/standard/8_b_-_-';
    ok('an analysis board keeps the key it started with', c.key() === k2, k2);
    c.site = 'chesscom';
    ok('other sites: no key on a page that does not name one game (audit 3.1.329 X2-2)', c.key() === null, c.key());
    c.location.pathname = '/game/live/123456'; c.location.href = 'https://www.chess.com/game/live/123456';
    ok('...and the href on one that does', c.key() === c.location.href, c.key());
    ok('no reader or writer is left on the href', !/StartPos\(location\.href|startPosCache\?\.get\?\.\(location\.href/.test(src));
}
// ---- PAGE-19: no light-DOM node carries the product name ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('neither id is left', !src.includes('mephisto-hide-opp') && !src.includes('mephisto-drag-select'));
    ok('the veil lives in the closed root', /veil\.appendChild\(box\); veil\.appendChild\(hint\);\s*getOverlayRoot\(\)\.appendChild\(veil\);/.test(src));
}
// ---- SYS-12: nothing of ours stays in the site's storage ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf("const SITE_KEYS = {box:");
    const body = src.slice(a, src.indexOf('const DEFAULT_POSITION', a));
    const world = (ls, stored) => {
        const writes = {}, removed = [];
        const c = {location: {hostname: 'lichess.org'}, Object, JSON, console,
            localStorage: {getItem: k => k in ls ? ls[k] : null, removeItem: k => { removed.push(k); delete ls[k]; }},
            chrome: {storage: {local: {get: async () => stored, set: async (o) => { Object.assign(writes, o); }}}}};
        vm.runInNewContext(body + ';this.load = loadSiteValues; this.save = saveSiteValue;', c);
        return {c, writes, removed, ls};
    };
    (async () => {
        let w = world({'ui.pnl.box': '{"width":400}', 'ui.sp.cache': '[1]'}, {});
        let v = await w.c.load();
        ok('old values move out of the page and into the extension',
           v.box.width === 400 && Array.isArray(v.cache) && Object.keys(w.ls).length === 0
           && w.writes['site.box.lichess.org'].width === 400, w);
        w = world({'ui.pnl.box': 'not json'}, {'site.cache.lichess.org': [2]});
        v = await w.c.load();
        ok('junk is dropped from the page, and a stored value is kept', v.box === null && v.cache[0] === 2 && !('ui.pnl.box' in w.ls), v);
        w.c.save('box', {width: 500});
        ok('a save reaches both the live copy and storage', w.c.load && (await w.c.load()).box.width === 500 && w.writes['site.box.lichess.org'].width === 500);
    })().catch(e => ok('site values ran', false, String(e)));
    ok('no localStorage read or write is left outside the move', src.split('localStorage.').length === 3, src.split('localStorage.').length);
    ok('the panel waits for them before reading its box',
       /await loadSiteValues\(\);\s*\/\/ Dismissed \(or reopened\)/.test(src) && /const box = siteValues\?\.box;/.test(src));
    ok('so does the start hunt', /async function determineStartPosition\(\) \{\s*await loadSiteValues\(\);/.test(src));
}
// ---- PAGE-12: a site with no move list verifies by the board ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf('async function simulateMoveVerified(');
    const body = src.slice(a, src.indexOf('// Double premove:', a));
    const run = async (boards) => {
        let clicks = 0, i = 0;
        const c = {UCI_RE: /^[a-h][1-8][a-h][1-8]/, DROP_RE: /^[A-Z]@/, leftSelected: () => false, console: {warn() {}},
            getMoveRecords: () => undefined, tryScrapePosition: () => boards[Math.min(i, boards.length - 1)],
            simulateMove: async () => { clicks++; i++; return true; }, promiseTimeout: () => new Promise(r => setTimeout(r, 1)),
            lastPushKey: 1, lastDisplayKey: 1, resumePush: false, schedulePush() { c.pushed = true; }, Date, setTimeout};
        await vm.runInNewContext(body + ';simulateMoveVerified("e2e4", false, true, null)', c);
        return {clicks, pushed: !!c.pushed};
    };
    run(['A', 'B']).then(r => ok('the board changing is success, on the first attempt', r.clicks === 1 && !r.pushed, r));
    ok('every list site still counts', /noList \? now !== 'no' && now !== before : now > before/.test(src));
}
// ---- PAGE-13: flipping the board does not swap our side ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf('const CC_GAME_PATH =');
    const body = src.slice(a, src.indexOf('function getOrientation()', a));
    const lichess = (start) => {
        const st = {bottom: start, plies: 10, path: '/abcd1234/white'};
        const c = {site: 'lichess', location: {get pathname() { return st.path; }}, isChesscomVariants: () => false, getOrientation: () => st.bottom,
            getMoveRecords: () => Array(st.plies), document: {querySelector: () => ({classList: {contains: k => k === 'rclock-' + st.bottom}})}};
        vm.runInNewContext(body + ';this.side = playerColor; this.flipped = boardFlippedFromSide;', c);
        return {st, c};
    };
    const {st, c} = lichess('white');
    ok('the first reading sticks', c.side() === 'white' && !c.flipped());
    st.bottom = 'black';
    ok('a mid-game flip keeps the side, and says the board is flipped', c.side() === 'white' && c.flipped());
    st.path = '/efgh5678/black';
    ok('a new game path reads again', c.side() === 'black' && !c.flipped());
    st.bottom = 'white'; st.plies = 0;
    ok('so does a list back at the start, on the same path', c.side() === 'white');
    c.site = 'chesscom'; st.path = '/analysis';
    ok('a chess.com analysis board stays on the orientation, as before', c.side() === null);
    ok('clocks and the opponent lookups follow it',
       /if \(boardFlippedFromSide\(\)\) \[mineTxt, theirsTxt\] = \[theirsTxt, mineTxt\];/.test(src)
       && (src.match(/document\.querySelector\(oppBox\(sel\)\)/g) || []).length === 2);
}
// ---- PAGE-10: board overlays follow the board with the engine idle ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf('const overlayPlaced =');
    const body = src.slice(a, src.indexOf('function dropPendingOverlay(kind)', a));
    let rect = {left: 10, top: 10, width: 400, height: 400}, tick = null, cleared = 0;
    const log = [];
    const c = {window: {scrollX: 0, scrollY: 0}, Math, clickableBoardBounds: () => rect, getOrientation: () => 'white',
        setInterval: (f) => { tick = f; return 1; }, clearInterval: () => { cleared++; tick = null; },
        drawHintArrows: (a, r) => log.push('hint:' + a), drawEvalBar: () => log.push('bar'), drawMoveClass: () => log.push('class')};
    vm.runInNewContext(body + ';this.follow = overlayFollow;', c);
    c.follow('hint', {arrows: 'A'}); c.follow('bar', {frac: 1});
    tick();
    ok('an unchanged board redraws nothing', log.length === 0, log);
    rect = {...rect, left: 60}; tick();
    ok('a moved board redraws what is on it', log.join() === 'hint:A,bar', log);
    tick();
    ok('...once', log.length === 2, log);
    c.follow('hint', null); c.follow('bar', null);
    ok('with nothing drawn, the timer stops', cleared === 1 && tick === null, cleared);
    ok('the badge key carries the place, and closing the panel forgets all three',
       /`\$\{sq\}\|\$\{msg\.glyph\}\|\$\{msg\.color\}\|\$\{boardPlace\(\)\}`/.test(src)
       && /for \(const kind of \['hint', 'bar', 'moveClass'\]\) overlayFollow\(kind, null\);/.test(src));
}
// ---- PAGE-7: a move waits while a live chess.com board shows history ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = src.indexOf('function chesscomViewingHistory()');
    const body = src.slice(a, src.indexOf('function moveHeldBack()', a));
    const run = (path, selIn, nodes = 5) => {
        const list = Array.from({length: nodes}, (_, i) => ({i, contains: (x) => x === 'sel' + i}));
        return vm.runInNewContext(body + ';chesscomViewingHistory()', {site: 'chesscom', isChesscomVariants: () => false,
            CC_GAME_PATH: /^\/(game|play)(\/|$)/, location: {pathname: path}, getMoveRecords: () => list, getSelectedMoveRecord: () => selIn === null ? null : 'sel' + selIn});
    };
    ok('the live move selected: not history', run('/game/live/1', 4) === false);
    ok('stepped back: history', run('/game/live/1', 2) === true);
    ok('no selection yet, or not a game page: not history', run('/game/live/1', null) === false && run('/analysis', 2) === false);
    ok('the wait is bounded and comes before the clicks',
       /await waitOutThink\(getThinkTime\(\)\);\s*await waitOutHistoryView\(\);/.test(src) && /Date\.now\(\) \+ HISTORY_HOLD_MS/.test(src));
}
// ---- audit 3.1.328 CLICK-1: local backends go through the worker, not a content-script fetch ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const bsrc = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const a = psrc.indexOf('async function call_backend('), b = psrc.indexOf('\n}\n', a) + 3;
    const c = vm.createContext({sent: [], answer: null, TypeError, Error});
    vm.runInContext(`var chrome = {runtime: {sendMessage: async m => { sent.push(m); return answer; }}};` + psrc.slice(a, b), c);
    const w = bsrc.indexOf('if (msg.backendFetch)'), we = bsrc.indexOf('return true;\n  }', w) + 16;
    const wc = vm.createContext({fetched: [], fetch: async (u, i) => { wc.fetched.push([u, i]); return {ok: true, status: 200, url: u, text: async () => '{"bestmove":"e2e4"}'}; }, AbortSignal, TypeError, String, JSON});
    vm.runInContext(`function handle(msg) { return new Promise(res => { const sendResponse = res; const r = (() => { ${bsrc.slice(w, we)} })(); }); }`, wc);
    (async () => {
        c.answer = {ok: true, status: 200, url: 'http://localhost:9090/analyse', text: '{"x":1}'};
        const r = await vm.runInContext(`call_backend('http://localhost:9090/analyse', {fen: 'f'})`, c);
        ok('panel: a backend call is a worker message, not a fetch from the page', c.sent.length === 1 && c.sent[0].backendFetch?.url === 'http://localhost:9090/analyse' && !/\bfetch\(/.test(psrc.slice(a, b)), c.sent);
        ok('panel: the answer reads like a Response (ok, status, url, text())', r.ok === true && r.status === 200 && (await r.text()) === '{"x":1}', r);
        c.answer = {error: 'Failed to fetch', unreachable: true};
        let t; try { await vm.runInContext(`call_backend('http://localhost:8080/performClick', {})`, c); } catch (e) { t = e; }
        ok('panel: nothing answering is still a TypeError (MPH-E02 and the click fallback key on it)', t instanceof TypeError, String(t));
        const good = await vm.runInContext(`handle({backendFetch: {url: 'http://localhost:8080/performMove', data: {x0: 1}}})`, wc);
        ok('worker: a known endpoint is fetched with a JSON body and answered with ok/status/text', good.ok === true && good.text === '{"bestmove":"e2e4"}' && wc.fetched[0][1].body === '{"x0":1}', good);
        const bad = await vm.runInContext(`handle({backendFetch: {url: 'http://localhost:22/x', data: {}}})`, wc);
        ok('worker: any other url is refused without a fetch', /not a backend endpoint/.test(bad.error) && wc.fetched.length === 1, bad);
    })().catch(e => { fails++; console.log('FAIL backend relay checks threw: ' + (e && e.stack || e)); });
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('content: the backend (real OS mouse) is only used while the tab is active', /const useBackend = \(\) => [^\n]*tabActive\(\)/.test(s));
}
// ---- audit 3.1.328 CLICK-4: a refused move resolves false so the verify chain stops ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = s.indexOf('function simulateMove(move, deselect'), b = s.indexOf('const orientation = getOrientation();', a);
    const body = s.slice(a, b);
    ok('simulateMove: the invalid-move, drop and no-board refusals all resolve false', (body.match(/return Promise\.resolve\(false\);/g) || []).length === 3 && !/return Promise\.resolve\(\);/.test(body));
}
// ---- audit 3.1.328 CLICK-3: the 4PC lane obeys Autoplay off and a hidden tab after its think ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = s.indexOf('const click = async (sq, travel) => {'), b = s.indexOf('await simulateClickSquare(r, 0.8, travel);', a);
    const body = s.slice(a, b);
    ok('4PC click: asks moveHeldBack before clicking and defers a hidden tab', /const held = moveHeldBack\(\);/.test(body) && /deferredWhileHidden = true/.test(body));
}
// ---- audit 3.1.328 CLICK-2: the half-click is recorded when the from-click lands ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = s.indexOf("await simulateClickSquare(getBoundsFromCoords(move.substring(0, 2)), 0.8, pathA);"), b = s.indexOf('const dueEnd = (approachMs + travelMs)', a);
    const body = s.slice(a, b);
    const set = body.indexOf('halfClicked = move.substring(0, 2);'), wait = body.indexOf('await promiseTimeout(dueSecond)');
    ok('click pair: halfClicked is set before the between-clicks wait and cleared after the to-click', set > 0 && set < wait && /halfClicked = null;\s*\/\/ both clicks landed/.test(body));
}
// ---- audit 3.1.328 CLICK-5: overlays follow the ChessBase canvas board too ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = s.indexOf('function boardPlace() {'), j = s.indexOf('\n}\n', i) + 3;
    const c = vm.createContext({window: {scrollX: 0, scrollY: 0}, Math, getOrientation: () => 'white',
        clickableBoardBounds: () => ({left: 10, top: 20, width: 400, height: 400}), getBoard: () => undefined});
    vm.runInContext(s.slice(i, j), c);
    ok('boardPlace measures through clickableBoardBounds (ChessBase has no board element)', vm.runInContext('boardPlace()', c) === '10,20,400,400white', vm.runInContext('boardPlace()', c));
    ok('the hint key measures the same way', /const r = region \? null : clickableBoardBounds\(\);/.test(s));
}
// ---- audit 3.1.328 SCRAPE-2: a chess.com game with Autoplay on is scraped to the latest move ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = s.indexOf('function scrapePositionFen('), j = s.indexOf('\n}\n', i) + 3;
    const node = (san, sel) => { const m = {innerText: san, lastElementChild: null, classList: {contains: () => false}}; return {m, w: {lastElementChild: m}}; };
    const n = ['e4', 'e5', 'Nf3'].map(x => node(x));
    const c = vm.createContext({site: 'chesscom', config: {autoplay: true, simon_says_mode: false}, location: {pathname: '/game/123'},
        CC_GAME_PATH: /^\/(game|play)(\/|$)/, isChesscomVariants: () => false, chesscomGameOver: () => false, getSelectedMoveRecord: () => n[0].m, getMoveRecords: () => n.map(x => x.w), figurineSan: (a, b) => b});
    vm.runInContext(s.slice(i, j), c);
    ok('chess.com game, Autoplay on, stepped back: the scrape reads to the latest move', vm.runInContext('scrapePositionFen()', c) === 'e4*****e5*****Nf3*****', vm.runInContext('scrapePositionFen()', c));
    c.config.autoplay = false;
    ok('...with Autoplay off it still follows the viewed move (history review)', vm.runInContext('scrapePositionFen()', c) === 'e4*****');
    c.config.autoplay = true; c.location.pathname = '/analysis';
    ok('...and on an analysis page too', vm.runInContext('scrapePositionFen()', c) === 'e4*****');
}
// ---- audit 3.1.328 SCRAPE-3: a lichess castle with a number, glyph or eval keeps its place ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = s.indexOf('function hasSanText(el) {'), j = s.indexOf('\n}\n', i) + 3;
    const c = vm.createContext({}); vm.runInContext(s.slice(i, j), c);
    const mv = (text, san) => ({textContent: text, querySelector: q => q === 'san' && san ? {textContent: san} : null});
    const f = el => vm.runInContext('hasSanText', c)(el);
    ok('castle with inline number, glyph or eval counts as a move', f(mv('12.O-O', 'O-O')) && f(mv('O-O?!', 'O-O')) && f(mv('O-O-O+0.4', 'O-O-O')));
    ok('a plain castle, a normal move and a result line are judged as before', f(mv('O-O')) && f(mv('Nf3')) && !f(mv('1-0')));
}
// ---- audit 3.1.328 SCRAPE-4: a lichess pieces-only scrape ships the last move for the ep right ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = s.indexOf('function scrapePositionPuz()'), j = s.indexOf('\nfunction boardShowsBlack', i);
    const sq = (f, r) => ({style: {transform: `translate(${(f - 1) * 50}px, ${(8 - r) * 50}px)`}});
    const pc = (c, t, f, r) => ({classList: Object.assign([c, t], {contains: () => false}), style: sq(f, r).style});
    let hl = [sq(4, 7), sq(4, 5)];
    const ctx = vm.createContext({site: 'lichess', isAnimating: () => false, animationStalled: () => false,
        getBoard: () => ({getBoundingClientRect: () => ({width: 400})}), getOrientation: () => 'white', getTurn: () => 'w',
        getPieces: () => [pc('white', 'king', 5, 1), pc('black', 'king', 5, 8), pc('black', 'pawn', 4, 5), pc('white', 'pawn', 5, 5)],
        getLastMoveHighlights: () => hl, document: {querySelector: () => null}, Math, Number, String});
    vm.runInContext(s.slice(i, j), ctx);
    const r1 = vm.runInContext('scrapePositionPuz()', ctx);
    ok('lichess Storm/Racer: d7-d5 just played ships lm-d7d5', /lm-d7d5\*{5}$/.test(r1), r1);
    hl = [sq(4, 5), sq(4, 4)];
    const r2 = vm.runInContext('scrapePositionPuz()', ctx);
    ok('...and a highlight whose destination is empty ships no last move', !/lm-/.test(r2), r2);
}
// ---- audit 3.1.328 PLAY-1: Humanize respects the clock with no pacing mode on ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = s.indexOf('const HZ_CLOCK_SHARE_MAX'), j = s.indexOf('\n}\n', s.indexOf('function hz_clock_rail', i)) + 3;
    const c = vm.createContext({Date, Math, last_clocks: null});
    vm.runInContext(s.slice(i, j), c);
    const at = (mine) => { c.last_clocks = {mine, at: Date.now()}; return vm.runInContext('hz_clock_rail(6500)', c); };
    c.last_clocks = null;
    ok('no clock read: the think is untouched', vm.runInContext('hz_clock_rail(6500)', c) === 6500);
    ok('a minute left: at most 4 s', Math.round(at(60)) === 4000, at(60));
    ok('15 s left: a quarter second; 5 s left: nothing', at(15) === 250 && at(5) === 0, [at(15), at(5)]);
    ok('humanize_pick rails the think when no pacing mode is on, and the presearch is railed too',
       /\} else \{\s*think = hz_clock_rail\(think\);/.test(s) && /if \(evalCp < 150\) return hz_clock_rail\(2500\);/.test(s));
}
// ---- audit 3.1.328 PLAY-2: the book width lifts wherever the explorer cannot answer ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('const MULTIPV_FLOOR_MODES'), j = psrc.indexOf('\n}\n', psrc.indexOf('function multipv_floor()')) + 3;
    const e = psrc.indexOf('function explorer_enabled()'), ee = psrc.indexOf('\n}\n', e) + 3;
    const c = vm.createContext({});
    vm.runInContext(`var config = {}, explorer_out_of_book = false, explorer_error = null, document = {hidden: false};` + psrc.slice(e, ee) + psrc.slice(i, j), c);
    const f = (cfg, extra = '') => vm.runInContext(`config = ${JSON.stringify(cfg)}; explorer_error = null; document.hidden = false; ${extra}; multipv_floor()`, c);
    const base = {book_play: true, autoplay: true};
    ok('Puzzle Mode and variants: normal width', f({...base, puzzle_mode: true}) === 1 && f({...base, variant: 'crazyhouse'}) === 1);
    ok('a failed lookup: normal width', f(base, `explorer_error = 'HTTP 429'`) === 1);
    ok('a hidden tab without Background Play: normal width; with it, still the book width',
       f(base, 'document.hidden = true') === 1 && f({...base, background_play: true}, 'document.hidden = true') === 4);
}
// ---- audit 3.1.328 PLAY-3: a style or contempt pick never replaces Humanize's error ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('Humanize: only book and tablebase override its pick; style and contempt only replace the engine move',
       /if \(tb_ok \|\| book_ok\) pick\.move = played;\s*else if \(pick\.move === best && played !== best\) pick\.move = played;/.test(s)
       && !/if \(tb_ok \|\| played !== best\) pick\.move = played;/.test(s));
}
// ---- audit 3.1.328 PLAY-4: a position answered by an instant premove reply is not played again ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const sent = s.indexOf('instant_reply_fen = fen;'), req = s.indexOf('request_automove(instant);');
    ok('the instant reply records its position before sending', sent > 0 && sent < req && req - sent < 80);
    ok('on_new_pos clears it, and the search path skips that position',
       /function on_new_pos\(fen, startFen, moves\) \{\s*instant_reply_fen = null;/.test(s)
       && /if \(isTerminal && config\.autoplay && instant_reply_fen && instant_reply_fen === last_eval\.fen\) \{/.test(s));
}
// ---- audit 3.1.328 PLAY-5: a finished game is scored for the side we played in it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = s.indexOf('function session_note_game('), j = s.indexOf('\n}\n', i) + 3;
    const c = vm.createContext({session: {day: 1, games: 0, acc: [], cur: 1}, session_day: () => 1, session_fresh: () => ({}), session_save() {},
        our_side: () => 'black', live_stats: () => ({white: {accuracy: 91}, black: {accuracy: 40}})});
    vm.runInContext(s.slice(i, j), c);
    vm.runInContext(`session_note_game([0.5], 'g', 'white')`, c);
    ok('the side the game was played with decides whose accuracy is folded', c.session.acc[0] === 91, c.session.acc);
    ok('the side is recorded as evals land', /eval_seen\[ply\] = true;\s*eval_history_side = our_side\(\);/.test(s));
}
// ---- audit 3.1.328 ENGINE-1: a loading engine is not revived, and init drops the old load's queue ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const o = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    const i = s.indexOf('let engine_loading_since = 0;'), j = s.indexOf('\nsetInterval(revive_if_engine_silent', i);
    const c = vm.createContext({Date, console: {warn() {}}, PANEL_BOOTED: true, search_active: true, last_info_at: Date.now() - 10000,
        last_revive_at: 0, engine_probe_at: 0, revive_attempts: 0, is_remote: () => false, probes: 0, send_engine_uci: () => c.probes++,
        ENGINE_SILENT_MS: 4000, REVIVE_GAP_MS: 8000, set_idle_reason() {}, i18n: (k, d) => d, abandon_search() {}, pending_stops: 0,
        last_eval: {}, initialize_engine() {}, setup_fen: null, on_new_pos() {}, fen_request_inflight: false, request_fen() {}});
    vm.runInContext(s.slice(i, j) + ';this.setLoading = v => { engine_loading_since = v; };', c);
    c.setLoading(Date.now() - 5000);
    vm.runInContext('revive_if_engine_silent()', c);
    ok('a silent engine still loading is left alone', c.probes === 0 && c.revive_attempts === 0);
    c.setLoading(Date.now() - 61000);
    vm.runInContext('revive_if_engine_silent()', c);
    ok('...until the load grace runs out', c.probes === 1);
    ok('ready ends the load and restarts the silence clock', /if \(msg\.kind === 'ready'\) \{ engine_loading_since = 0; last_info_at = Date\.now\(\); return; \}/.test(s));
    ok('offscreen: init drops lines queued for the load it replaces', /if \(cmd === 'init'\) \{[\s\S]{0,400}delete pending\[clientId\];[\s\S]{0,80}startEngine/.test(o));
}
// ---- audit 3.1.328 ENGINE-2: a disposed net engine is silenced too ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const o = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    const a = o.indexOf("const emit = (line) =>"), b = o.indexOf("if (superseded()) return abandon(engine);", a);
    const block = o.slice(a, b);
    ok('net adapters emit through an epoch-gated callback, all four', /if \(!superseded\(\)\) send\(clientId/.test(block) && (block.match(/\bemit\b/g) || []).length === 5 && !/\(line\) => send\(clientId/.test(block));
}
// ---- audit 3.1.328 ENGINE-3: Maia-2's opening net is not cached as a failure ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const m = fs.readFileSync(ROOT + '/src/offscreen/maia2.js', 'utf8');
    ok('a rejected opening load clears the cached promise', /createMaia3Engine\(listen, selfElo\)\)\s*\.catch\(e => \{ opening = null; throw e; \}\);/.test(m));
}
// ---- audit 3.1.328 ENGINE-4: a Maia premove answer is paired with the kick that asked it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = s.indexOf('function maia2_on_line(text) {'), j = s.indexOf('\n}\n', i) + 3;
    const fired = [];
    const c = vm.createContext({clearTimeout() {}, premove_tracker: {fen: 'F2', premoved: false}, maybe_premove_forced_reply: l => fired.push(l.reply),
        maia2: {sent: 2, answered: 0, pending: {fen: 'F2', seq: 2, line: {pred: 'e7e5'}, timer: 1}}});
    vm.runInContext(s.slice(i, j), c);
    vm.runInContext(`maia2_on_line('bestmove a2a3')`, c);
    ok('the answer to the older kick is not taken for the newest question', fired.length === 0 && c.maia2.pending);
    vm.runInContext(`maia2_on_line('bestmove g1f3')`, c);
    ok('the newest answer is', fired.join() === 'g1f3' && !c.maia2.pending, fired);
}
// ---- audit 3.1.328 ENGINE-5: a push that is not adopted leaves `turn` as it was ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = s.indexOf('const turn_before = turn;'), b = s.indexOf('// Manual turn override (header king switch)', a);
    const block = s.slice(a, b);
    ok('unparseable, empty, illegal and display-only pushes all restore turn', (block.match(/turn = turn_before;/g) || []).length === 4);
}
// ---- audit 3.1.328 SYS-1: diagnostics carry the route, never a game id or a username ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = s.indexOf('const DIAG_ROUTE_WORDS'), j = s.indexOf('\n}\n', s.indexOf('function diagnostics_path_shape', i)) + 3;
    const c = vm.createContext({}); vm.runInContext(s.slice(i, j), c);
    const f = p => vm.runInContext(`diagnostics_path_shape(${JSON.stringify(p)})`, c);
    ok('chess.com and lichess game ids become <id>; route words stay',
       f('/game/live/123456789') === '/game/live/<id>' && f('/AbCdEfGh1234') === '/<id>' && f('/analysis') === '/analysis' && f('/variants/chess960/game/42') === '/variants/chess960/game/<id>',
       [f('/game/live/123456789'), f('/AbCdEfGh1234')]);
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    ok('the streaming trace line names nobody', /bgLog\('opponent is streaming'\);/.test(cs));
}
// ---- audit 3.1.328 SYS-2: toolbar-popup mode never reopens a floating panel ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    ok('panelWasOpen answers false in popup mode, and switching to it clears panelTabs',
       /if \(msg\.panelWasOpen\) \{\s*chrome\.storage\.local\.get\('ui_mode', \(\{ui_mode\}\) => \{\s*if \(ui_mode === 'popup'\) return sendResponse\(\{open: false\}\);/.test(b)
       && /chrome\.storage\.session\.set\(\{panelTabs: \{\}\}\);/.test(b));
}
// ---- audit 3.1.328 SYS-3 / PAGE-5: switching the debugger capture off stops it on open tabs ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const i = b.indexOf('function puzzleNetStop(tabId) {'), j = b.indexOf('\n}\n', i) + 3;
    const cmds = [];
    const c = vm.createContext({puzzleNetTabs: new Set([7]), cdpInputTabs: new Set([7]), chrome: {runtime: {}, debugger: {sendCommand: (t, m) => cmds.push([t.tabId, m])}}});
    vm.runInContext(b.slice(i, j), c);
    vm.runInContext('puzzleNetStop(7)', c);
    ok('puzzleNetStop on a tab Autoplay clicked in: Network off and the tab out of the set, debugger kept', c.puzzleNetTabs.size === 0 && JSON.stringify(cmds) === '[[7,"Network.disable"]]', cmds);
    ok('a change to any of the three keys stops watched tabs when capture is no longer wanted; a reload does too',
       /changes\.puzzle_mode \|\| changes\.puzzle_capture \|\| changes\.puzzle_capture_cdp\)\) \{\s*puzzleNetWanted\(\)\.then\(want => \{ if \(!want\) for \(const id of \[\.\.\.puzzleNetTabs\]\) puzzleNetStop\(id\); \}\);/.test(b)
       && /if \(!\(await puzzleNetWanted\(\)\)\) \{ if \(puzzleNetTabs\.has\(tabId\)\) puzzleNetStop\(tabId\); return; \}/.test(b));
}
// ---- audit 3.1.328 SYS-4: an offscreen document with no client arms its idle close at load ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const o = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8');
    ok('offscreen.js arms the idle timer once at top level', /\nmaybeGoIdle\(\);\n$/.test(o));
}
// ---- audit 3.1.328 SYS-5: finishing a stopped update names the version it installed ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const g = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const a = g.indexOf('const res = await MephistoUpdater.finishStaged(say);'), b = g.indexOf('setTimeout(() => chrome.runtime.reload()', a);
    const block = g.slice(a, b);
    ok('resume reads res.installed and leaves the whats-new and installed-version notes',
       /v\$\{res\.installed\}/.test(block) && !/res\.version/.test(block) && /mephisto_whats_new/.test(block) && /mephisto_installed_version: res\.installed/.test(block));
}
// ---- audit 3.1.328 SYS-6: the chess.com archive cut keeps the newest games ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const a = bg.indexOf('async function fetchArchivePgn('), b = bg.indexOf('async function oppPrepLookup(', a);
    const month = (tag, n) => ({games: Array.from({length: n}, (_, i) => ({pgn: `${tag}${i}`}))});
    const files = {'arch': {archives: ['m1', 'm2', 'm3']}, 'm3': month('new', 10), 'm2': month('mid', 50), 'm1': month('old', 50)};
    const ctx = vm.createContext({
        archiveFetch: async (u) => { const k = u.includes('/games/archives') ? 'arch' : u; return {ok: true, json: async () => files[k]}; },
        lichess_blocked: () => false, lichess_note_response: () => {}, encodeURIComponent, Promise, Error, Math,
    });
    vm.runInContext(bg.slice(a, b), ctx);
    vm.runInContext(`fetchArchivePgn('chesscom', 'x', 40).then(t => { out = t.split('\\n\\n'); })`, ctx);
    setTimeout(() => {
        const out = ctx.out || [];
        ok('an opponent with 10 games this month keeps all 10, plus the latest 30 of last month, in play order',
           out.length === 40 && out[39] === 'new9' && out[30] === 'new0' && out[29] === 'mid49' && out[0] === 'mid20', out.slice(0, 2).concat(out.slice(-2)));
    }, 0);
}
// ---- audit 3.1.328 SYS-8: the streamer check honours the lichess budget and never caches a failure ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const a = bg.indexOf('async function streamerLookup('), b = bg.indexOf('\n}\n', a) + 3;
    const mk = (blocked, status) => {
        const c = vm.createContext({streamerCache: new Map(), STREAMER_TTL_MS: 600000, STREAMER_CACHE_MAX: 50, capMap: () => {},
            lichess_blocked: () => blocked, noted: [], lichess_note_response: (r) => c.noted.push(r.status),
            AbortSignal: {timeout: () => null}, encodeURIComponent, Date, String,
            calls: 0, fetch: async () => { c.calls++; return {ok: status === 200, status, json: async () => ({streaming: true, streamer: {twitch: {channel: 'x'}}, streamers: []})}; }});
        vm.runInContext(bg.slice(a, b), c);
        return c;
    };
    const runs = [[mk(true, 200), 'lichess'], [mk(false, 429), 'lichess'], [mk(false, 500), 'chesscom'], [mk(false, 200), 'lichess']];
    Promise.all(runs.map(([c, site]) => vm.runInContext(`streamerLookup({site: '${site}', username: 'someone'})`, c))).then(([r1, r2, r3, r4]) => {
        ok('a lichess cooldown answers an error without fetching', r1.error && runs[0][0].calls === 0 && runs[0][0].streamerCache.size === 0, r1);
        ok('a lichess 429 is noted for the shared budget and not cached as not-streaming',
           r2.error && runs[1][0].noted.includes(429) && runs[1][0].streamerCache.size === 0, r2);
        ok('a chess.com non-200 is an error, not a cached live:false', r3.error && runs[2][0].streamerCache.size === 0, r3);
        ok('a good lichess answer is still read and cached', r4.live === true && r4.channel === 'x' && runs[3][0].streamerCache.size === 1, r4);
    });
}
// ---- audit 3.1.328 PAGE-1: variant auto-detect leaves nothing in the site's sessionStorage ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf('function maybe_autodetect_variant()'), b = src.indexOf('let variant_switch_pending', a);
    const run = (inPage) => {
        const store = new Map(), applied = [];
        const c = vm.createContext({IS_CONTENT_SCRIPT: inPage, autodetected_urls: new Set(), config: {variant: 'chess', engine: 'stockfish'},
            needs_fairy_engine: () => false, FAIRY_ENGINES: [], console: {log() {}}, abandon_search() {}, variant_switch_pending: false,
            setTimeout: (f) => f(), apply_detected_variant: (v) => applied.push(v),
            sessionStorage: {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)},
            request_detect_variant: (cb) => cb('crazyhouse', 'https://lichess.org/abc', true)});
        vm.runInContext(src.slice(a, b), c);
        vm.runInContext('maybe_autodetect_variant(); maybe_autodetect_variant();', c);
        return {store, applied};
    };
    const page = run(true), pop = run(false);
    ok('in-page: applied once per URL with nothing written to the site sessionStorage', page.applied.length === 1 && page.store.size === 0, [page.applied, [...page.store.keys()]]);
    ok('toolbar popup: still guarded once per URL by its own sessionStorage', pop.applied.length === 1 && pop.store.size === 1, [pop.applied, [...pop.store.keys()]]);
}
// ---- audit 3.1.328 PAGE-2: keys typed into a panel input do not reach the site ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = cs.indexOf('function getOverlayRoot()'), b = cs.indexOf('// look up one of our overlay nodes', a);
    const handlers = {};
    const root = {activeElement: null, addEventListener: (t, f) => { (handlers[t] ||= []).push(f); }};
    const c = vm.createContext({overlayRoot: null, overlayHost: null,
        document: {createElement: () => ({isConnected: true, attachShadow: () => root}), body: {appendChild() {}}}});
    vm.runInContext(cs.slice(a, b) + '; getOverlayRoot();', c);
    const fire = (type, focused) => { root.activeElement = focused; let stopped = false; for (const f of handlers[type] || []) f({stopPropagation: () => { stopped = true; }}); return stopped; };
    ok('keydown/keyup/keypress in the FEN box stop at the panel root',
       ['keydown', 'keyup', 'keypress'].every(t => fire(t, {tagName: 'INPUT'})) && fire('keydown', {tagName: 'TEXTAREA'}));
    ok('a focused panel button, or nothing focused, lets the key through to the site',
       !fire('keydown', {tagName: 'BUTTON'}) && !fire('keydown', null));
}
// ---- audit 3.1.328 PAGE-4: Read Solutions From The Page answers in the toolbar popup ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf('let puzzle_capture_remote = null;'), b = src.indexOf('// Fire-and-forget, exactly like the tablebase probe', a);
    const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
    const mk = (answer) => {
        const c = vm.createContext({IS_CONTENT_SCRIPT: false, MY_TAB_ID: 7, puzzle_capture_enabled: () => true, puzzle_key: f => f.split(' ').slice(0, 4).join(' '),
            puzzle_expand: (f, line) => new Map([[f.split(' ').slice(0, 4).join(' '), line.split(' ')[0]]]),
            puzzle_deferred: null, puzzle_defer_timer: 0, clearTimeout() {}, console: {log() {}}, update_best_move_suffix() {},
            last_eval: {fen: FEN}, asked: [], reentered: [], puzzle_solutions: null, puzzle_rating: null, puzzle_from_page: false, puzzle_answered: null,
            chrome: {runtime: {lastError: null}, tabs: {sendMessage: (id, m, cb) => { c.asked.push([id, m.puzzleCaptureFor]); cb(answer); }}}});
        vm.runInContext(src.slice(a, b) + '; function request_puzzle_solution(f) { reentered.push(f); return try_puzzle_capture(f); }', c);
        return c;
    };
    const hit = mk({line: 'a1a8', rating: 1500});
    const first = vm.runInContext(`try_puzzle_capture(${JSON.stringify(FEN)})`, hit);
    ok('popup mode asks the tab for the capture, and the answer re-enters and takes the page solution',
       first === false && hit.asked.length === 1 && hit.asked[0][0] === 7 && hit.reentered.length === 1
       && hit.puzzle_from_page === true && hit.puzzle_rating === 1500, [first, hit.asked, hit.reentered.length, hit.puzzle_from_page]);
    const miss = mk(null);
    vm.runInContext(`try_puzzle_capture(${JSON.stringify(FEN)})`, miss);
    ok('a miss is not cached and does not re-enter', miss.reentered.length === 0 && vm.runInContext('puzzle_capture_remote', miss) === null && !miss.puzzle_from_page);
}
// ---- audit 3.1.328 PAGE-6: the m9 rendezvous takes only the host's own probe type ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = cs.indexOf('let ttState = null, ttSid = null;'), b = cs.indexOf('// --- captured puzzle solutions', a);
    const run = (host) => {
        const listening = [], sent = [];
        const c = vm.createContext({location: {hostname: host}, JSON, puzSid: null, config: null, schedulePush() {}, acceptPuzzleCaptures() {},
            CustomEvent: function (n) { this.type = n; }, chrome: {storage: {local: {get: (k, cb) => cb({puzzle_capture: 'true'})}}},
            document: {addEventListener: (n) => listening.push(n), dispatchEvent: (e) => sent.push(e.type)}});
        vm.runInContext(cs.slice(a, b), c);
        for (const t of ['puz', 'tt', 'cb']) vm.runInContext(`onProbeAnnounce({detail: JSON.stringify({t: '${t}', s: 'x${t}'})})`, c);
        return {listening, sent};
    };
    const tt = run('taketaketake.com'), cb = run('tactics.chessbase.com'), li = run('lichess.org');
    ok('TakeTakeTake wires only tt, and answers no puz replay', tt.listening.includes('xtts') && !tt.listening.some(n => /^x(puz|cb)/.test(n)) && tt.sent.length === 0, tt);
    ok('ChessBase wires only cb', cb.listening.includes('xcbs') && !cb.listening.some(n => /^x(puz|tt)/.test(n)) && cb.sent.length === 0, cb);
    ok('lichess still takes puz and replays on it, and nothing else', li.listening.includes('xpuzp') && li.sent.includes('xpuzr') && !li.listening.some(n => /^x(tt|cb)/.test(n)), li);
}
// ---- audit 3.1.328 PAGE-7: the review socket never borrows a tab with a game in it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const a = bg.indexOf('const CCR_BUSY_PATH'), b = bg.indexOf('// ONE REVIEW AT A TIME', a);
    const run = (urls) => {
        const created = [];
        const c = vm.createContext({URL, ccrWaitComplete: async () => {}, chrome: {tabs: {
            query: async () => urls.map((u, i) => ({id: i + 1, url: u})),
            create: async (o) => { created.push(o); return {id: 99}; }}}});
        vm.runInContext(bg.slice(a, b), c);
        return vm.runInContext('ccrEnsureTab()', c).then(r => ({r, created}));
    };
    Promise.all([
        run(['https://www.chess.com/game/live/123', 'https://www.chess.com/analysis']),
        run(['https://www.chess.com/game/live/123', 'https://www.chess.com/puzzles/rated']),
    ]).then(([mixed, busy]) => {
        ok('a calm chess.com tab is borrowed ahead of a live game', mixed.r.tab.id === 2 && !mixed.r.spawned && mixed.created.length === 0, mixed.r);
        ok('with only game or puzzle tabs open, a background tab is spawned', busy.r.spawned && busy.created.length === 1 && busy.created[0].active === false, busy.r);
    });
}
// ---- audit 3.1.328 REVIEW-1: the HTML export leaves hidden sections out ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf("wrap.innerHTML = `<div class=\"row\">"), b = rv.indexOf('// the board\'s pieces are extension URLs', a);
    const block = rv.slice(a, b);
    ok('the export removes hidden blocks from the clone instead of un-hiding them',
       /querySelectorAll\('\.hidden'\)\.forEach\(el => el\.remove\(\)\)/.test(block) && !/classList\.remove\('hidden'\)/.test(block));
}
// ---- audit 3.1.328 REVIEW-2: a native depth review is not capped at 8 s a position ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const en = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const cap = Number(/const NATIVE_DEPTH_CAP_MS = (\d+);/.exec(en)?.[1]);
    ok('the time sent beside a native depth is a backstop of minutes, not 8 s', cap >= 300000, cap);
    ok('the request backstop outlives that cap instead of multiplying it',
       /limitKind === 'depth' \? NATIVE_DEPTH_CAP_MS \+ 30000/.test(en));
}
// ---- audit 3.1.328 REVIEW-3: the WASM review backstop measures silence ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const en = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const a = en.indexOf('    once(pred, timeoutMs, alive = null) {'), b = en.indexOf('\n    }\n', a) + 7;
    const timers = [];
    const c = vm.createContext({Number, Error, Promise, setTimeout: (f, ms) => { timers.push({f, ms, live: true}); return timers.length; }, clearTimeout: (id) => { timers[id - 1].live = false; }});
    vm.runInContext('class E { constructor() { this.waiters = new Set(); this.listeners = []; }\n' + en.slice(a, b) + '\n}; e = new E();', c);
    let state = 'pending';
    vm.runInContext("p = e.once(m => /^bestmove/.test(m.line), 180000, m => /^info/.test(m.line))", c).then(() => { state = 'done'; }, () => { state = 'failed'; });
    for (let i = 0; i < 5; i++) c.e.listeners.forEach(f => f({kind: 'line', line: 'info depth ' + (20 + i)}));
    ok('each info line re-arms the timer, so only the newest one is live', timers.length === 6 && timers.filter(t => t.live).length === 1, timers.map(t => t.live));
    const src = en.slice(en.indexOf('this.listeners.push(collect);'), en.indexOf('this.send(`position fen ${fen}`);'));
    ok('analyse passes an info-line alive predicate to its bestmove wait', /searchTimeout\(\),\s*m => m\.kind === 'line' && \/\^info\\b\/\.test\(m\.line\)\)/.test(src), src);
}
// ---- audit 3.1.328 REVIEW-4: a batch skips a game that will not replay and keeps the rest ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('async function onRun() {'), b = rv.indexOf('// The PGN of one game as it was pasted', a);
    const el = () => ({disabled: false, value: '', classList: {add() {}, remove() {}}, scrollIntoView() {}});
    const run = (bad) => {
        const c = vm.createContext({notes: [], rendered: 0, String, Error, console,
            $: () => el(), note: (t, err) => c.notes.push([t, !!err]), progress() {}, startRig: async () => ({}), disposeRig() {},
            cfg: k => (k === 'rv_batch' ? true : k === 'rv_variant' ? 'chess' : false), gameText: g => g.id, eeCached: async () => null,
            renderReport: () => { c.rendered++; }, renderBatch() {}, selectedGame: () => null,
            runReview: async (g) => { if (bad.includes(g.id)) throw Object.assign(new Error('Move 3. Nf6 is not legal'), {replayFailed: true}); return {id: g.id}; }});
        vm.runInContext('var running = false, cancel = false, is4pcGame = false, batchReports = null, report = null; var games = [{id: 1}, {id: 2}, {id: 3}];\n' + rv.slice(a, b), c);
        return vm.runInContext('onRun()', c).then(() => c);
    };
    Promise.all([run([2]), run([1, 2, 3])]).then(([one, all]) => {
        ok('a batch with one unplayable game keeps the other two and names the skipped one',
           one.batchReports?.length === 2 && one.rendered === 1 && one.notes.some(([t, e]) => e && /Skipped 1 of 3: game 2 \(Move 3/.test(t)), [one.batchReports, one.notes]);
        ok('a batch where nothing replays says so, naming the games', all.rendered === 0 && all.notes.some(([t, e]) => e && /No game could be reviewed: game 1/.test(t)), all.notes);
    });
}
// ---- audit 3.1.328 REVIEW-5: an unclaimed repetition mid-game is not a terminal draw ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const c = {console}; c.self = c; vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    vm.runInContext('const Core = self.MephistoReviewCore; const RV_FAIRY_ONLY = [];\n'
        + rj.slice(rj.indexOf('function buildPositions'), rj.indexOf('function incrementFromTimeControl')), c);
    const overs = (pgn) => vm.runInContext(`buildPositions(Core.parsePgn(${JSON.stringify(pgn)})[0]).positions.map(p => p.over)`, c);
    // threefold after 4...Ng8 (start position a third time), then the game goes on
    const on = overs('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 5. e4 *');
    ok('a threefold the game played past is not terminal', on.every(o => o === null), on);
    const end = overs('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2');
    ok('a threefold that ends the game is still a draw', end[end.length - 1] === 'draw' && end.slice(0, -1).every(o => o === null), end);
    const mate = overs('1. f3 e5 2. g4 Qh4# 0-1');
    ok('a mate at the end is untouched', mate[mate.length - 1] === 'mate', mate);
}
// ---- audit 3.1.328 REVIEW-6: a 4-player run hides and drops the previous two-player report ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('async function onRun() {'), b = rv.indexOf('// The PGN of one game as it was pasted', a);
    const hidden = new Set();
    const c = vm.createContext({String, $: (id) => ({classList: {add: (k) => hidden.add(id)}}), cfg: () => 'chess', note() {}, ran4: 0});
    vm.runInContext('var running = false, cancel = false, is4pcGame = true, batchReports = [1], report = {old: 1}; var games = [{}];\n'
        + 'function run4pcReview() { ran4++; }\n' + rv.slice(a, b), c);
    vm.runInContext('onRun()', c);
    ok('the old report sections are hidden and the report dropped before the 4-player lane runs',
       c.ran4 === 1 && ['rv-report', 'rv-indicators', 'rv-human', 'rv-strength', 'rv-batch'].every(id => hidden.has(id))
       && vm.runInContext('report === null && batchReports === null', c), [...hidden]);
}
// ---- audit 3.1.328 REVIEW-7: typing a fractional budget is not rewritten mid-entry ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('function syncLimitUi('), b = rv.indexOf('// A native engine is disabled for ONE reason only', a);
    const els = {rv_limit_kind: {value: 'time'}, rv_limit_num: {value: ''}, rv_limit_value: {value: ''}};
    const saved = {};
    const c = vm.createContext({$: id => els[id], isFinite, parseFloat, Math, String, storedFor: () => 1000, DEPTH_DEFAULT: 20, TIME_DEFAULT_MS_UI: 1000,
        setCfg: (k, v) => { saved[k] = v; }, PER_KIND_KEY: {time: 'rv_limit_time', depth: 'rv_limit_depth'}, updateEngineOptions() {}});
    vm.runInContext(rv.slice(a, b), c);
    const type = (v) => { els.rv_limit_num.value = v; c.syncLimitUi(true, true); return els.rv_limit_num.value; };
    ok('typing 0 leaves the box at 0 (not 0.1) and stores the clamped 100 ms', type('0') === '0' && saved.rv_limit_value === 100, [els.rv_limit_num.value, saved.rv_limit_value]);
    ok('typing 1.5 stores 1500 ms with the box untouched', type('1.5') === '1.5' && saved.rv_limit_value === 1500, saved.rv_limit_value);
    saved.rv_limit_value = 'kept';
    ok('an unparseable partial stores nothing', type('') === '' && saved.rv_limit_value === 'kept');
    els.rv_limit_num.value = '0'; c.syncLimitUi(true);
    ok('change still clamps and writes back', els.rv_limit_num.value === '0.1' && saved.rv_limit_value === 100, els.rv_limit_num.value);
}
// ---- audit 3.1.328 REVIEW-8: Fit Humanize counts the engine's own move as top ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('function fitHumanize('), b = rv.indexOf('function renderReport()', a);
    const c = vm.createContext({MephistoConfig: {get: () => undefined}, Number, Math, parseFloat,
        FIT_ORDER: ['second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder']});
    vm.runInContext(rv.slice(a, b), c);
    const moves = [{color: 'w', cpLoss: 6, rank: 1}, {color: 'w', cpLoss: 0, rank: 1}, {color: 'w', cpLoss: 12, rank: 2}, {color: 'w', cpLoss: 3, rank: null}];
    const r = c.fitHumanize(moves, 'w');
    ok('a rank-1 move with a few cp of drift is top, a rank-2 move still lands in second', r.pct.top === 50 && r.pct.second === 50, r.pct);
}
// ---- audit 3.1.328 REVIEW-9: a failed or stopped engine pass keeps its own status line ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('    let engineFailed = false;'), b = rv.indexOf('    const book = cfg(\'rv_book\')', a);
    const block = rv.slice(a, b);
    let rejectHuman;
    const c = vm.createContext({notes: [], cancel: false, moves: [{uci: 'e2e4'}, {uci: 'e7e5'}], positions: [{fen: 'a', turn: 'w'}, {fen: 'b', turn: 'b'}],
        note: (t) => c.notes.push(t), Promise, Error,
        rig: {human: {analyse: () => new Promise((_, rej) => { rejectHuman = rej; })}},
        enginePass: Promise.reject(new Error('the engine stopped answering after 180s'))});
    c.enginePass.catch(() => {});
    vm.runInContext('result = (async () => {\n' + block + '\n})();', c);
    c.result.then(() => ok('engine failure rethrows', false), (e) => {
        rejectHuman(new Error('engine disposed'));   // what disposeRig does in onRun's finally
        setTimeout(() => ok('the human pass catch says nothing after the engine pass failed',
            /180s/.test(e.message) && c.notes.length === 0, c.notes), 0);
    });
}
// ---- audit 3.1.328 REVIEW-10: a fairy variant shows Fairy-Stockfish without saving it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('const rvModeSync = () => {'), b = rv.indexOf('const fourPc = variant === \'4pc\';', a);
    const body = rv.slice(a, b);
    const m = /const esel = \$\('rv_engine'\);[\s\S]*?\n            \}\n/.exec(body);
    ok('rvModeSync never writes rv_engine', !/setCfg\('rv_engine'/.test(body), body.length);
    if (m) {
        const sel = {value: 'stockfish-native'};
        let variant = 'crazyhouse';
        const run = () => vm.runInContext(m[0], vm.createContext({$: () => sel, RV_FAIRY_ONLY: ['crazyhouse'], RV_FAIRY_ENGINE: 'fairy-stockfish-14', rvChessVariant: () => variant, cfg: () => 'stockfish-native', String}));
        run(); const onFairy = sel.value;
        variant = 'chess'; run();
        ok('the select shows Fairy for crazyhouse and the stored engine again for chess', onFairy === 'fairy-stockfish-14' && sel.value === 'stockfish-native', [onFairy, sel.value]);
    } else ok('the shown-engine block is present', false);
}
// ---- audit 3.1.328 REVIEW-11: the exported Eval column is White's view on both sides' rows ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('function exportMoveTable() {'), b = rv.indexOf('\n}\n', a) + 3;
    const c = vm.createContext({esc: s => String(s), moveLabel: m => m.san, CLASS_LABEL: {}, scoreText: cp => (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2),
        uciToSan: () => '', Core: {phaseOf: () => ''}, String,
        report: {phases: {}, positions: [{lines: [{cp: 200}]}, {lines: [{cp: 200}]}],
                 moves: [{ply: 0, san: 'e4', color: 'w', evalBefore: 200}, {ply: 1, san: 'e5', color: 'b', evalBefore: -200}]}});
    vm.runInContext(rv.slice(a, b), c);
    const html = String(vm.runInContext('exportMoveTable()', c));
    ok('White +2 reads +2.00 on both rows', (html.match(/\+2\.00/g) || []).length === 2 && !/-2\.00/.test(html), html.slice(0, 300));
}
// ---- audit 3.1.328 REVIEW-12: Review's key and resize handlers stand down on other pages ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('function onKey(e) {'), b = rv.indexOf('\n}\n', a) + 3;
    let present = false, stepped = 0, prevented = 0;
    const c = vm.createContext({report: {positions: [1, 2, 3]}, cursor: 1, $: () => (present ? {} : null), showPly: () => { stepped++; }});
    vm.runInContext(rv.slice(a, b), c);
    const key = (k) => c.onKey({key: k, target: {matches: () => false}, preventDefault: () => { prevented++; }});
    key('Home'); key('End');
    ok('on another page Home/End are left to that page', stepped === 0 && prevented === 0, [stepped, prevented]);
    present = true; key('Home');
    ok('on the Review page Home still steps the board', stepped === 1 && prevented === 1);
    ok('the resize redraw checks the graph is on the page', /if \(report && \$\('rv_graph'\)\) \{ renderGraph\(\); setGraphCursor\(\); \}/.test(rv));
}
// ---- audit 3.1.328 REVIEW-13: a chess.com online review clears an earlier batch ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('const built = buildCcrReport(review, pgn);'), b = rv.indexOf('renderCcrReport($(\'rv_ccr_strength\').value);', a);
    ok('the online path drops batchReports and re-renders the batch section before drawing',
       /batchReports = null;\s*report = built;\s*renderBatch\(\);/.test(rv.slice(a, b)), rv.slice(a, b));
}
// ---- audit 3.1.328 REVIEW-14: the classifier fallback names the engine that searched ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const en = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const ee = /const EE_ENGINE = '([^']+)';/.exec(rv)?.[1];
    const label = new RegExp(`\\{id: '${ee}', label: '([^']+)'`).exec(en)?.[1];
    ok('no hard-coded engine name left in the classifier strings, and EE_ENGINE has a label to read',
       !/'[^']*\(Stockfish 18 Small\)'|fed our Stockfish 18 Small/.test(rv) && /our engine \(\$\{eeEngineLabel\(\)\}\)/.test(rv) && !!label, [ee, label]);
}
// ---- audit 3.1.328 REVIEW-15: revisiting after a batch restores the whole input ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const run = rv.slice(rv.indexOf('async function onRun() {'), rv.indexOf('// The PGN of one game as it was pasted'));
    ok('a batch run keeps the box text it started from', /if \(batch\) batchInputText = \$\('rv_pgn'\)\?\.value \|\| '';/.test(run));
    const line = /\$\('rv_pgn'\)\.value = (\(batchReports\?\.length && batchInputText\) \|\| report\.pgnText \|\| '');/.exec(rv)?.[1];
    const pick = (batchReports, batchInputText, report) => vm.runInNewContext(line, {batchReports, batchInputText, report});
    ok('re-entry refills the batch input after a batch, the one game otherwise',
       !!line && pick([{}, {}], 'g1\n\ng2', {pgnText: 'g2'}) === 'g1\n\ng2' && pick(null, 'g1\n\ng2', {pgnText: 'g3'}) === 'g3', line);
}
// ---- audit 3.1.328 REVIEW-16: a lichess "From Position" game is reviewable ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rv = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rv.indexOf('const RV_PGN_VARIANTS = {'), b = rv.indexOf('};', a) + 2;
    const map = vm.runInNewContext(rv.slice(a, b).replace('const RV_PGN_VARIANTS =', '(') .replace(/};$/, '})'));
    ok('"From Position" maps to standard chess', map['from position'] === 'chess', map['from position']);
}
// ---- audit 3.1.328 ANALYSIS-1: a disposed human net ends the band sweep ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const a = an.indexOf('let bandChain = Promise.resolve();'), b = an.indexOf('// SWEEP THE NEXT PLY', a);
    const c = vm.createContext({Promise, Math, bandRun: 1, calls: 0, built: 0, bandCache: new Map(), bandKey: (f, k) => f + k, cfg: () => 1500,
        bandSteps: () => [600, 700, 800, 900], takesRating: () => true, BAND_MULTIPV: 12, makeEngine: () => { c.built++; return {start: async () => {}}; }});
    c.human = {send() {}, analyse: async () => { c.calls++; if (c.calls === 1) c.human = null; return {lines: [{pv: ['e2e4'], prob: 1}]}; }};
    c.ensureHuman = async () => c.human;
    vm.runInContext(an.slice(a, b), c);
    vm.runInContext('sweepBands({fen: "x", turn: "w"}, "maia3", bandRun, null)', c).then(r => {
        ok('the sweep stops at the next band once its borrowed net is gone', r === null && c.calls === 1 && c.built === 0, [r, c.calls, c.built]);
        c.bandRun = 2;
        return vm.runInContext('sweepBands({fen: "y", turn: "w"}, "maia3", 1, null)', c);
    }).then(r => ok('a sweep queued under an older run builds nothing', r === null && c.built === 0, [r, c.built]));
    ok('teardown, reloadHuman and the large-game switch all bump bandRun',
       /function teardown\(\) \{\s*pageGen\+\+;\s*bandRun\+\+;/.test(an) && /async function reloadHuman\(\) \{\s*bandRun\+\+;/.test(an) && /bandRun\+\+;   \/\/ see reloadHuman\s*showLargeGame/.test(an));
}
// ---- audit 3.1.328 ANALYSIS-8: a human-model build asked for before leaving Analysis builds nothing after ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (x, y) => an.slice(an.indexOf(x), an.indexOf(y, an.indexOf(x)));
    const made = [];
    let band = 1500;
    const c = vm.createContext({Promise, made, cfg: (k) => (k === 'an_band' ? band : 'maia3'), CFG: {an_band: 1500}, engineOpts: () => ({}),
        makeEngine: () => { const e = {dispose() { e.disposed = true; }}; e.start = () => new Promise(r => { e.finish = r; }); made.push(e); return e; },
        hideLargeGame() {}, stopMatch() {}, stopSearch() {}, clearTimeout() {}});
    vm.runInContext('let human = null, humanKey = null, engine = null, engine2 = null, boardResizeObs = null, bandRun = 0, prefetchTimer = 7;\n'
        + cut('let humanChain = Promise.resolve();', '// Reload ONLY the analysis engine') + cut('// teardown() bumps this', '// Returns a promise'), c);
    (async () => {
        const first = vm.runInContext('ensureHuman()', c);
        await new Promise(r => setImmediate(r));
        band = 1900;                                            // a second build is queued behind the first
        const second = vm.runInContext('ensureHuman()', c);
        vm.runInContext('teardown()', c);                       // the page is left
        made[0].finish();
        const [a, b] = await Promise.all([first, second]);
        ok('the build queued before leaving loads nothing afterwards, and the prefetch timer is cleared',
           a === null && b === null && made.length === 1 && made[0].disposed && vm.runInContext('prefetchTimer', c) === null, [a, b, made.length]);
    })().catch(e => { fails++; console.log('FAIL ANALYSIS-8 check threw: ' + (e && e.stack || e)); });
}
// ---- audit 3.1.328 ANALYSIS-2: a finished position says so instead of "thinking…" ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const c = {console}; c.self = c; vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext('var Chess = self.Chess || Chess;', c);
    const els = {an_evalfill: {style: {}}, an_evallabel: {textContent: '', classList: {toggle() {}}}, an_engine_lines: {innerHTML: '', querySelectorAll: () => []}};
    Object.assign(c, {wireLineClicks() {}, $: id => els[id] || null, cfg: () => 3, anVariant: () => 'chess', Core: {MATE_CP: 100000, isMateScore: cp => Math.abs(cp) > 90000, clamp: (v, a, b) => Math.max(a, Math.min(b, v)), winPercent: () => 50}});
    vm.runInContext(an.slice(an.indexOf('function newChess('), an.indexOf('\n', an.indexOf('function newChess('))) + '\n'
        + an.slice(an.indexOf('// A FINISHED POSITION SAYS SO.'), an.indexOf('const RANK_COLOURS = ')) + '\n'
        + an.slice(an.indexOf('function legalHere('), an.indexOf('// the second engine\'s column')), c);
    const mate = {fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', turn: 'w'};
    vm.runInContext('renderEval', c)(mate, {lines: [], done: true});
    vm.runInContext('renderEngineLines', c)(mate, {lines: [], done: true});
    ok('Fool\'s mate: the bar fills to Black, and the column says Checkmate', els.an_evalfill.style.height === '0%' && /Checkmate/.test(els.an_engine_lines.innerHTML), [els.an_evalfill.style.height, els.an_engine_lines.innerHTML]);
    const stale = {fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', turn: 'b'};
    ok('stalemate is named, a finished search with no lines is "game over", a running one still "thinking…"',
       c.emptyColumnWord(stale, false) === 'Stalemate' && c.emptyColumnWord({fen: '8/8/8/8/8/8/8/K6k w - - 0 1', turn: 'w'}, true) === 'game over'
       && c.emptyColumnWord({fen: '8/8/8/8/8/8/8/K6k w - - 0 1', turn: 'w'}, false) === 'thinking…');
}
// ---- audit 3.1.328 ANALYSIS-3: Copy FEN, Export and Copy PGN keep pockets and check counts ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (x, y) => an.slice(an.indexOf(x), an.indexOf(y, an.indexOf(x)));
    let variant = 'crazyhouse';
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const c = vm.createContext({anVariant: () => variant, AN_VARIANTS: [['crazyhouse', 'Crazyhouse'], ['3check', 'Three-check']],
        newChess: () => ({fen: () => START}), Core: {plyMove: () => ({num: 1, white: true})}, positions: []});
    vm.runInContext(cut('function threeCheckCounts(', 'function newChess(') + cut('function engineFen(pos)', 'let engine = null;')
        + cut('// THE FULL FEN EVERYWHERE IT LEAVES THE PAGE.', 'async function copyOut('), c);
    const zh = {fen: 'rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 4', holdings: {w: 'n', b: 'n'}, checksLeft: {w: 3, b: 3}};
    ok('crazyhouse: the copied FEN carries both pockets', c.fullFen(zh) === 'rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB1R[Nn] w KQkq - 0 4', c.fullFen(zh));
    c.positions = [zh];
    ok('crazyhouse: the PGN [FEN] tag carries them too', /\[FEN "rnbqkb1r\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKB1R\[Nn\] w KQkq - 0 4"\]/.test(c.pgnText()), c.pgnText());
    c.positions = [{fen: START, holdings: {w: '', b: ''}, checksLeft: {w: 3, b: 3}}];
    ok('the plain start still writes no FEN tag', !/\[FEN/.test(c.pgnText()), c.pgnText());
    variant = '3check';
    const tc = {fen: START, holdings: {w: '', b: ''}, checksLeft: {w: 2, b: 3}};
    const out = c.fullFen(tc);
    ok('three-check: the copied FEN carries the counts and reads back to the same counts',
       out === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 2+3 0 1' && c.threeCheckCounts(out).left.w === 2 && c.threeCheckCounts(out).fen === START, out);
    ok('Copy FEN and the export use the full FEN, and the export picture includes the pockets',
       /copyOut\(fullFen\(positions\[cursor\]\), 'FEN'\)/.test(an) && /an-export-fen">\$\{esc\(fullFen\(pos\)\)\}/.test(an) && /\$\('an_pocket_top'\), document\.querySelector\('\.an-boardrow'\), \$\('an_pocket_bottom'\)/.test(an));
}
// ---- audit 3.1.328 ANALYSIS-4: a native engine on a Chess960 board runs as its WASM build ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const en = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    const ids = [...en.matchAll(/\{id: '([^']+)', label: '[^']*', kind: '(\w+)'/g)].map(m => ({id: m[1], kind: m[2]}));
    let v = 'fischerandom';
    const c = vm.createContext({anVariant: () => v, ENGINES: ids});
    vm.runInContext(an.slice(an.indexOf('const NATIVE_960_WASM'), an.indexOf('let engineChain = Promise.resolve();')), c);
    const wasm = new Set(ids.filter(x => x.kind === 'wasm').map(x => x.id));
    ok('Chess960: every native engine resolves to a WASM build that exists, WASM picks are kept',
       ids.filter(x => x.kind === 'native').every(x => wasm.has(c.engineFor(x.id))) && c.engineFor('fairy-native') === 'fairy-stockfish-14-nnue' && c.engineFor('stockfish-19-nnue') === 'stockfish-19-nnue');
    v = 'chess';
    ok('standard chess keeps the native pick, and nothing is saved', c.engineFor('sf19-native') === 'sf19-native' && !/setCfg\('an_engine', NATIVE_960_WASM|setCfg\('an_engine', engineFor/.test(an));
    ok('both builders resolve through engineFor', /makeEngine\(engineFor\(cfg\('an_engine'\)\)/.test(an) && /makeEngine\(engineFor\(cfg\('an_engine2'\)\)/.test(an));
}
// ---- audit 3.1.328 ANALYSIS-5: Polyglot castling is translated only for a king ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const c = {console}; c.self = c; vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/polyglot-random.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/util/polyglot.js', 'utf8'), c);
    const P = c.MephistoPolyglot;
    const enc = (from, to) => ((from.charCodeAt(1) - 49) << 9) | ((from.charCodeAt(0) - 97) << 6) | ((to.charCodeAt(1) - 49) << 3) | (to.charCodeAt(0) - 97);
    const book = (fen, raws) => {
        const buf = new ArrayBuffer(16 * raws.length), v = new DataView(buf);
        raws.forEach((r, i) => { v.setBigUint64(i * 16, P.polyglotKey(fen)); v.setUint16(i * 16 + 8, r); v.setUint16(i * 16 + 10, 1); });
        return buf;
    };
    const kingFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const rookFen = '4k3/8/8/8/8/8/8/4R1K1 w - - 0 1';   // Re1-h1 is a rook move
    const kingBuf = book(kingFen, [enc('e1', 'h1'), enc('e1', 'a1')]), rookBuf = book(rookFen, [enc('e1', 'h1')]);
    ok('a king on e1 taking its rook is castling, from the bytes and from the parsed book',
       P.bufferLookup(kingBuf, kingFen).map(e => e.uci).join() === 'e1g1,e1c1' && P.lookup(P.readBook(kingBuf), kingFen).map(e => e.uci).join() === 'e1g1,e1c1');
    ok('a rook going e1 to h1 stays Rh1, not Rg1', P.bufferLookup(rookBuf, rookFen)[0].uci === 'e1h1' && P.lookup(P.readBook(rookBuf), rookFen)[0].uci === 'e1h1',
       P.bufferLookup(rookBuf, rookFen));
}
// ---- audit 3.1.328 ANALYSIS-6: a failed tablebase lookup is asked again ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const a = an.indexOf('    if (tbEl) {'), b = an.indexOf('\n    }\n}\n', a) + 7;
    const POS = {fen: '8/8/8/8/8/8/k7/K6Q w - - 0 1'};
    let answer = {error: 'lichess cooling down'}, asked = 0;
    const c = vm.createContext({tbCache: new Map(), TB_MAX_MEN: 7, pieceCount: () => 3, positions: [POS], cursor: 0, sanOf: () => 'Qb7', tbWords: () => 'mate in 3',
        tbEl: {textContent: ''}, pos: POS, Promise,
        chrome: {runtime: {lastError: null, sendMessage: (m, cb) => { asked++; cb(answer); }}}});
    vm.runInContext('run = async () => {\n' + an.slice(a, b) + '\n};', c);
    c.run().then(() => {
        const first = c.tbCache.size;
        answer = {category: 'win', dtm: 5, moves: [{uci: 'h1b7'}]};
        return c.run().then(() => ok('an error answer is not cached, and the next visit asks and shows the verdict',
            first === 0 && asked === 2 && /Tablebase: mate in 3 - Qb7/.test(c.tbEl.textContent), [first, asked, c.tbEl.textContent]));
    });
}
// ---- audit 3.1.328 ANALYSIS-7: arrow keys and Space leave the hidden chess board alone ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const a = an.indexOf('function onKey(e) {'), b = an.indexOf('\n}\n', a) + 3;
    let large = 'shogi';
    const did = [];
    const c = vm.createContext({$: () => ({}), largeGame: () => large, cursor: 3, go: (i) => did.push('go' + i), playUci: (u) => did.push(u), topEngineUci: () => 'e2e4'});
    vm.runInContext(an.slice(a, b), c);
    const key = (k) => c.onKey({key: k, target: {tagName: 'BODY'}, preventDefault() {}});
    key('ArrowLeft'); key(' ');
    const onLarge = did.length;
    large = null; key('ArrowLeft');
    ok('on shogi/xiangqi the keys do nothing; on chess they still step', onLarge === 0 && did.join() === 'go2', did);
}
// ---- audit 3.1.328 ANALYSIS-9: a late explorer answer for an earlier position is dropped ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf('function request_explorer(fen) {'), b = src.indexOf('\n}\n', a) + 3;
    const pending = [];
    const c = vm.createContext({explorer_enabled: () => true, explorer_out_of_book: false, document: {hidden: false}, config: {}, console: {warn() {}},
        explorer_wanted: null, explorer_data: null, explorer_error: null, explorer_empty_streak: 0, renders: 0, render_explorer: () => { c.renders++; },
        chrome: {runtime: {lastError: null, sendMessage: (m, cb) => pending.push([m.explorerLookup.fen, cb])}}});
    vm.runInContext(src.slice(a, b), c);
    c.request_explorer('A'); c.request_explorer('B');
    pending[1][1]({moves: [{uci: 'e7e5'}]});           // B answers first (a worker cache hit)
    pending[0][1]({moves: [{uci: 'd2d4'}]});           // ...then A's slow network answer
    ok('the overlay keeps B\'s moves when A answers late', c.explorer_data?.fen === 'B' && c.explorer_data.moves[0].uci === 'e7e5' && c.renders === 1, c.explorer_data);
    c.request_explorer('C');
    pending[0][1]({moves: []});                        // a late EMPTY answer for A
    ok('a late empty answer does not count toward the out-of-book latch', c.explorer_empty_streak === 0, c.explorer_empty_streak);
}
// ---- audit 3.1.328 OPT-2: options-page native engines run on their own, neutral host process ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const a = bg.indexOf('function ensureNative(name) {'), b = bg.indexOf('// ===== IS THE OPPONENT STREAMING?', a);
    const hosts = [], listeners = [];
    const mkPort = (name, url) => { const p = {name, sender: {url}, sent: [], postMessage(m) { p.sent.push(m); }, onDisconnect: {addListener(f) { p.bye = f; }}, onMessage: {addListener(f) { p.hear = f; }}}; return p; };
    const c = vm.createContext({NATIVE_HOSTS: {'sf-native': {app: 'com.x.sf', label: 'Stockfish'}}, nativePorts: {}, popupPortsByName: {}, nativeRequestOwner: new Map(),
        nativeSeq: 0, nativeFramesIn: 0, nativeFramesRecent: [], nativeFramesOut: 0, sweepNativeOwners() {}, nativeTrace() {}, console, Date,
        chrome: {runtime: {lastError: null, onConnect: {addListener: (f) => listeners.push(f)},
            connectNative: (app) => { const h = {app, got: [], postMessage(m) { h.got.push(m); }, onMessage: {addListener() {}}, onDisconnect: {addListener() {}}, disconnect() {}}; hosts.push(h); return h; }}}});
    vm.runInContext(bg.slice(a, b), c);
    const panel = mkPort('sf-native', 'https://lichess.org/abc'), popup = mkPort('sf-native', 'chrome-extension://id/src/popup/popup.html'),
          review = mkPort('sf-native', 'chrome-extension://id/src/options/options.html#review');
    for (const p of [panel, popup, review]) { listeners[0](p); p.hear({id: 1, cmd: 'configure', options: {}}); }
    ok('the panel and the toolbar popup share one host; Review gets its own', hosts.length === 2 && hosts[0].got.length === 2 && hosts[1].got.length === 1
       && Object.keys(c.nativePorts).sort().join() === 'sf-native,sf-native#options1', Object.keys(c.nativePorts));
    const en = fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8');
    ok('an options-page native engine configures full strength, standard castling and no personality',
       /UCI_Variant: 'chess', UCI_Chess960: false, UCI_LimitStrength: false, Personality: '---',/.test(en));
}
// ---- audit 3.1.328 OPT-3: a Settings-page change shows in the open panel's own rows ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf('function sync_quick_settings() {'), b = src.indexOf('\n}\n', a) + 3;
    const els = {};
    for (const id of ['qs_playstyle', 'qs_tb_show', 'qs_fourpc_mode', 'qs_lines', 'qs_skill', 'qs_maia2_oppo']) els[id] = {value: 'old'};
    els.qs_skill_val = {textContent: 'old'};
    const c = vm.createContext({HOTKEY_TOGGLES: {}, PANEL_ROOT: {getElementById: id => els[id] || null}, String,
        config: {playstyle: 'aggressive', fourpc_mode: 'ffa', multiple_lines: 4, skill_level: 12, maia2_oppo_elo: 1800},
        tb_show: () => 'engine', skill_label: v => 'Skill ' + v, apply_search_mode_ui() {}, mark_autoplay_overridden() {}});
    vm.runInContext(src.slice(a, b), c);
    c.sync_quick_settings();
    const got = ['qs_playstyle', 'qs_tb_show', 'qs_fourpc_mode', 'qs_lines', 'qs_skill', 'qs_maia2_oppo'].map(id => String(els[id].value));
    ok('all six rows follow config, and the skill label with them',
       got.join() === 'aggressive,engine,ffa,4,12,1800' && els.qs_skill_val.textContent === 'Skill 12', [got, els.qs_skill_val.textContent]);
}
// ---- audit 3.1.328 OPT-4: the panel's Multi Lines stepper shows or hides the Playstyle row ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf("['qs_lines', 'multiple_lines', v => parseInt(v) || 1],"), b = src.indexOf('if (is_remote()) {', a);
    ok('the qs_lines change handler calls update_playstyle_row', /if \(key === 'multiple_lines'\) \{[\s\S]{0,300}?update_playstyle_row\(\);/.test(src.slice(a, b + 20)));
}
// ---- audit 3.1.328 OPT-5: the Tablebase Display row follows the Tablebase toggle ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf('function update_tb_show_row() {'), b = src.indexOf('\n}\n', a) + 3;
    const row = {style: {display: 'none'}};
    const c = vm.createContext({PANEL_ROOT: {getElementById: () => row}, config: {tablebase: true}});
    vm.runInContext(src.slice(a, b), c);
    c.update_tb_show_row(); const on = row.style.display;
    c.config.tablebase = false; c.update_tb_show_row();
    ok('the row shows with Tablebase on and hides with it off', on === '' && row.style.display === 'none', [on, row.style.display]);
    ok('the panel toggle and the storage listener both update it',
       /request_tablebase\(last_eval\.fen\);\s*update_tb_show_row\(\);/.test(src) && /if \(key === 'tablebase'\) \{ tablebase_data = null; update_tb_show_row\(\); \}/.test(src));
}
// ---- audit 3.1.328 OPT-6: the Elo label keeps the cap in a translated panel ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const html = fs.readFileSync(ROOT + '/src/popup/popup.html', 'utf8');
    const a = src.indexOf('function paint_elo_slider() {'), b = src.indexOf('\n}\n', a) + 3;
    const label = {textContent: ''}, slider = {value: '0'};
    const de = {'panel.off_full_strength': 'Aus / Volle Stärke', 'panel.full_strength': 'Volle Stärke'};
    const c = vm.createContext({PANEL_ROOT: {getElementById: id => (id === 'qs_elo' ? slider : label)}, config: {engine: 'sf'}, elo_stops: () => [0, 1500, 3190, 3200], FULL_STRENGTH_ELO: 3200,
        i18n: (k, d) => de[k] || d});
    vm.runInContext(src.slice(a, b), c);
    c.paint_elo_slider(); const off = label.textContent;
    slider.value = '3'; c.paint_elo_slider(); const full = label.textContent;
    slider.value = '1'; c.paint_elo_slider();
    ok('the label is translated in code: Off, the engine max, and a cap shows its number',
       off === 'Aus / Volle Stärke' && full === '3190+ / Volle Stärke' && String(label.textContent) === '1500', [off, full, label.textContent]);
    ok('the span carries no data-i18n for apply() to overwrite, and a language apply repaints it',
       /<span id="qs_elo_val">/.test(html) && /MephistoI18n\.apply\(PANEL_ROOT\);\s*sync_elo_slider\(\);/.test(src));
}
// ---- audit 3.1.328 OPT-7: a rebuilt English panel drops a translated table still in memory ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const m = /const wantLang = config\.language \|\| MephistoI18n\.DEFAULT_LANG;\s*if \((.*)\) \{\s*load_language\(wantLang\)/.exec(src);
    const cond = (language, lang) => vm.runInNewContext(`const wantLang = config.language || MephistoI18n.DEFAULT_LANG; ${m[1]}`,
        {config: {language}, MephistoI18n: {DEFAULT_LANG: 'en', lang}});
    ok('English config with a German table in memory reloads English; English over English does nothing; German loads',
       !!m && cond(undefined, 'de') === true && cond(undefined, 'en') === false && cond('de', 'en') === true, m && m[1]);
}
// ---- audit 3.1.328 OPT-8: clearing a hotkey removes its hint from the panel ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf('function annotate_hotkey_labels() {'), b = src.indexOf('\n}\n', a) + 3;
    const removed = [];
    const hk = {remove: () => removed.push('row')}, barHk = {remove: () => removed.push('bar')};
    const label = {querySelector: (s) => (s === '.qs-hk' ? hk : null)};
    const input = {closest: () => ({querySelector: () => label})};
    const btn = {dataset: {baseTitle: 'Minimise'}, title: 'Minimise (M)', querySelector: (s) => (s === '.mephisto-bar-hk' ? barHk : null)};
    const c = vm.createContext({MephistoConfig: {hotkeys: () => ({autoplay: '', compact: '', minimize: ''})}, HOTKEY_TOGGLES: {autoplay: 'qs_autoplay'},
        PANEL_ROOT: {getElementById: () => input, querySelector: (s) => (s === '.mephisto-overlay-min' ? btn : null)}, hotkey_pretty: k => k});
    vm.runInContext(src.slice(a, b), c);
    c.annotate_hotkey_labels();
    ok('the row hint and the title-bar hint go, and the button title loses its key', removed.join() === 'row,bar' && btn.title === 'Minimise', [removed, btn.title]);
}
// ---- audit 3.1.328 OPT-9: Restore Defaults on General keeps the lichess token and the tablebase folder ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const sp = fs.readFileSync(ROOT + '/src/options/util/SettingsPage.js', 'utf8');
    const g = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const a = sp.indexOf('    clearConfigValues(keep = []) {'), b = sp.indexOf('\n    }\n', a) + 6;
    const removed = [];
    const c = vm.createContext({MephistoConfig: {remove: k => removed.push(k)}});
    vm.runInContext('page = {formElements: [{name: "autoplay"}, {name: "lichess_token"}, {name: "tb_path"}, {name: "threads"}],\n' + sp.slice(a, b).trim() + '\n};', c);
    c.page.clearConfigValues(['lichess_token', 'tb_path']);
    ok('the kept names survive, the rest are cleared', removed.join() === 'autoplay,threads', removed);
    ok('General\'s reset keeps exactly the two names Import keeps', /onResetConfigValues\(\) \{[\s\S]{0,500}?this\.clearConfigValues\(\['lichess_token', 'tb_path'\]\);/.test(g));
}
// ---- OPT-10: settings rows show their own tooltip ----
// OPT-10: every settings row's tooltip key exists in every locale and matches its row (the Threads,
// Memory and Line 1-3 Arrow rows showed another setting's tip), and no tag carries two class
// attributes (the browser keeps the first, so the second class="tooltipped" never applied).
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const path = require('path');
    const locDir = path.join(ROOT, 'src/i18n/locales');
    const locs = fs.readdirSync(locDir).filter(f => f.endsWith('.json')).map(f => [f, JSON.parse(fs.readFileSync(path.join(locDir, f), 'utf8'))]);
    const htmls = ['src/popup/popup.html', ...fs.readdirSync(path.join(ROOT, 'src/options/pages/settings')).map(d => `src/options/pages/settings/${d}/${d}.html`)]
        .filter(p => fs.existsSync(path.join(ROOT, p)));
    const missing = [];
    for (const p of htmls) {
        const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
        for (const m of src.matchAll(/data-i18n-tip="([^"]+)"/g))
            for (const [f, d] of locs) if (!(m[1] in d)) missing.push(`${p}:${m[1]}:${f}`);
    }
    ok('OPT-10: every data-i18n-tip key exists in every locale', missing.length === 0, missing.slice(0, 5));
    const ap = fs.readFileSync(path.join(ROOT, 'src/options/pages/settings/appearance/appearance.html'), 'utf8');
    const gen = fs.readFileSync(path.join(ROOT, 'src/options/pages/settings/general/general.html'), 'utf8');
    const tipFor = (src, label) => (src.match(new RegExp(`data-i18n-tip="([^"]+)"[^>]*><span data-i18n="${label.replace(/\./g, '\\.')}"`)) || [])[1];
    ok('OPT-10: Line 1-3 Arrow rows use their own tips',
        [1, 2, 3].every(i => tipFor(ap, `set.arrow_color_line${i}`) === `set.tip.arrow_color_line${i}`),
        [1, 2, 3].map(i => tipFor(ap, `set.arrow_color_line${i}`)));
    ok('OPT-10: Threads and Memory rows use the threads and memory tips',
        tipFor(gen, 'panel.threads') === 'panel.tip.threads' && tipFor(gen, 'panel.memory') === 'panel.tip.memory',
        [tipFor(gen, 'panel.threads'), tipFor(gen, 'panel.memory')]);
    const dup = [];
    for (const p of htmls) {
        const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
        for (const m of src.matchAll(/<[a-zA-Z][^>]*>/g)) if ((m[0].match(/\sclass=/g) || []).length > 1) dup.push(`${p}: ${m[0].slice(0, 60)}`);
    }
    ok('OPT-10: no tag carries two class attributes', dup.length === 0, dup);
}
// ---- NATIVE-1: the suite reports its verdict ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const self = fs.readFileSync(__filename, 'utf8');
    ok('NATIVE-1: the suite sets a non-zero exit code and prints a summary when anything failed',
       /process\.on\('beforeExit', \(\) => \{[\s\S]{0,120}?FAILED[\s\S]{0,80}?process\.exitCode = fails \? 1 : 0;/.test(self));
}
// ---- NATIVE-3: the native analyse carries its MultiPV ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    ok('NATIVE-3: a native analyse sends the width its configure pushes',
       /native_send\('analyse', \{fen, time, moves, depth, nodes, multipv: remote_multipv_set \?\? undefined\}/.test(src));
    const host = fs.readFileSync(ROOT + '/native-host/uci-native-host.py', 'utf8');
    const ana = host.slice(host.indexOf('def do_analyse'), host.indexOf('def do_configure'));
    const conf = host.slice(host.indexOf('def do_configure'), host.indexOf('def do_configure') + 1500);
    ok('NATIVE-3: the host stores the request width under request_lock, where it numbers the search',
       /request_id = request_counter[\s\S]{0,700}?engine_options\['MultiPV'\] = data\['multipv'\][\s\S]{0,80}?# BEFORE the engine lock/.test(ana));
    ok('NATIVE-3: a configure marks only the search it stops, and an unchanged one stops nothing',
       !/request_counter \+= 1/.test(conf) && /configure_cut = stale/.test(conf)
       && /with request_lock:[\s\S]{0,200}?if all\(k in engine_options and engine_options\[k\] == v/.test(conf)
       && /configure_cut is analysis/.test(ana));
}
// ---- NATIVE-11: native Fairy refuses the four python-chess-less variants with its own line ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const helpers = src.slice(src.indexOf('const err_line = '), src.indexOf('// Background-play tracing from the PANEL side'));
    const a = src.indexOf('const NATIVE_BOARDLESS_VARIANTS');
    const fn = src.slice(a, src.indexOf('\n    if (uses_cloud()) {', a));
    const c = vm.createContext({console, sent: []});
    c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8'), c);
    c.MephistoI18n.setFallback(JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/en.json', 'utf8')));
    vm.runInContext(`var remote_multipv_set = null; var config = {engine: 'fairy-native', variant: 'duck'}, premove_tracker = {fen: ''}, turn = 'w', board = null;
        const i18n = (k, d) => MephistoI18n.t(k, d);
        function uses_native() { return true; } function our_side() { return 'white'; } function on_native_info() {}
        function native_send(cmd, data) { sent.push([cmd, data]); return Promise.resolve({ok: true}); }
        ${helpers}
        ${fn}
    }`, c);
    const run = async (variant) => {
        c.sent.length = 0;
        vm.runInContext(`config.variant = ${JSON.stringify(variant)}`, c);
        try { await vm.runInContext(`request_remote_analysis('8/8/8/8/8/8/8/8 w - - 0 1', 500)`, c); return null; }
        catch (e) { return e; }
    };
    (async () => {
        const duck = await run('duck'), sei = await run('seirawan');
        const line = vm.runInContext('err_code_line', c)(duck);
        ok('NATIVE-11: Duck on the native Fairy throws MPH-E08 before any request, naming the variant',
           duck && duck.code === 'MPH-E08' && c.sent.length === 0 && /^MPH-E08: The native Fairy-Stockfish cannot analyse Duck:/.test(line), [duck && duck.message, line]);
        ok('...Seirawan the same, by its dropdown label', sei && sei.code === 'MPH-E08' && /Seirawan/.test(sei.message), sei && sei.message);
        const atomic = await run('atomic');
        ok('...a variant python-chess has still goes to the host', atomic === null && c.sent.length === 1 && c.sent[0][0] === 'analyse', [atomic && atomic.message, c.sent.length]);
        vm.runInContext(`config.engine = 'sf-native'`, c);
        const sfDuck = await run('duck');
        ok('...and only the Fairy host is refused here', sfDuck === null && c.sent.length === 1, sfDuck && sfDuck.message);
        const en = JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/en.json', 'utf8'));
        ok('...the line is translated: err.E08 is in en.json with the {variant} slot', /\{variant\}/.test(en['err.E08'] || ''));
    })();
}
// ---- audit 3.1.329 ANALYSIS-1: a crazyhouse PGN's [FEN] tag keeps its pockets when it is read back ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (a, b) => { const i = aj.indexOf(a), j = aj.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return aj.slice(i, j); };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    c.box = {value: ''};
    let res = null;
    try {
        vm.runInContext(`const Core = self.MephistoReviewCore; let nodeSeq = 0, treeRoot = null, treeNode = null, cursor = 0;
            const anVariant = () => 'crazyhouse'; const $ = (id) => (id === 'an_pgn' ? box : null); function status() {}
            const evalCache = new Map(), evalCache2 = new Map(), humanCache = new Map(), bandCache = new Map();
            function relinkLine() {} function buildBoard() {} function renderMoves() {} function renderPockets() {} function go() {}
            function setCfg() {} function onVariantChange() {} const PGN_VARIANTS = {crazyhouse: 'crazyhouse'};
            ${cut('function threeCheckCounts', '// crazyhouse only')}
            ${cut('function mkNode', '// the flat view')}
            ${cut('function loadFromInput', '// The line as it stands')}`, c);
        const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R[Nq] w KQkq - 0 1';
        const load = (text) => { c.box.value = text; vm.runInContext('loadFromInput()', c); return vm.runInContext('treeRoot', c); };
        const pgnRoot = load(`[Variant "Crazyhouse"]\n[SetUp "1"]\n[FEN "${fen}"]\n\n1. N@d5 Q@h4 *`);
        res = {root: pgnRoot.holdings, afterDrop: pgnRoot.children[0]?.holdings, fen: pgnRoot.fen, fenBox: load(fen).holdings};
    } catch (e) { res = {err: String(e.message || e)}; }
    ok('ANALYSIS-1: the PGN branch lifts the [Nq] pocket out of the [FEN] tag onto the root, and a drop spends it',
       JSON.stringify(res) === JSON.stringify({root: {w: 'n', b: 'q'}, afterDrop: {w: '', b: 'q'},
           fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1', fenBox: {w: 'n', b: 'q'}}), res);
}
// ---- audit 3.1.329 ANALYSIS-2: an Antichess or Horde win is not read as "Stalemate" ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const c = {console, variant: 'chess'}; c.self = c; vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    Object.assign(c, {anVariant: () => c.variant, Core: {MATE_CP: 100000}});
    vm.runInContext(an.slice(an.indexOf('function newChess('), an.indexOf('\n', an.indexOf('function newChess('))) + '\n'
        + an.slice(an.indexOf('// A FINISHED POSITION SAYS SO.'), an.indexOf('function renderEval(')), c);
    const word = (variant, fen, turn) => { c.variant = variant; return [c.emptyColumnWord({fen, turn}, true), c.gameOverAt({fen, turn})?.cp ?? null]; };
    ok('ANALYSIS-2: Antichess, the side to move has no pieces: "game over", no 0.0',
       JSON.stringify(word('antichess', '8/8/8/8/8/8/8/7q w - - 0 1', 'w')) === '["game over",null]', word('antichess', '8/8/8/8/8/8/8/7q w - - 0 1', 'w'));
    ok('...Horde with White wiped out: the same', JSON.stringify(word('horde', 'rnbqkbnr/pppppppp/8/8/8/8/8/8 w kq - 0 1', 'w')) === '["game over",null]');
    ok('...standard stalemate and a Three-check mate still say so',
       word('chess', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'b')[0] === 'Stalemate'
       && JSON.stringify(word('3check', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 'w')) === '["Checkmate",-100000]');
}
// ---- audit 3.1.329 ANALYSIS-3: the engine swap note on a variant change survives the reload ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (a, b) => { const i = an.indexOf(a), j = an.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return an.slice(i, j); };
    const el = {textContent: '', className: ''};
    const conf = {};
    const c = vm.createContext({el, conf, loadLine: ['Position loaded.']});
    vm.runInContext(`const $ = (id) => (id === 'an_status' ? el : null);
        const cfg = (k) => conf[k]; const setCfg = (k, v) => { conf[k] = v; }; const anVariant = () => conf.an_variant;
        const ENGINES = [{id: 'sf18-native', label: 'Stockfish 18 (native)', kind: 'native'}, {id: 'stockfish-18-nnue', label: 'Stockfish 18', kind: 'wasm'},
                         {id: 'fairy-stockfish-14-nnue', label: 'Fairy-Stockfish', kind: 'wasm'}];
        const FAIRY_ONLY = ['crazyhouse']; const FAIRY_ENGINE = 'fairy-stockfish-14-nnue';
        function syncBandRow() {} function reloadEngine() {} function reloadEngine2() {}
        function loadFromInput() { status(...loadLine); }
        ${cut('function status(', '\n}\n')}
        }
        ${cut('const NATIVE_960_WASM', 'let engineChain')}
        ${cut('function onVariantChange(', '// One box takes either')}`, c);
    Object.assign(conf, {an_variant: 'fischerandom', an_engine: 'sf18-native', an_engine2: ''});
    c.onVariantChange(false);
    ok('ANALYSIS-3: native engine + Chess960: the swap note is on the status line after the reload, with the load line after it',
       el.textContent === 'Stockfish 18 (native) cannot castle in Chess960; using Stockfish 18 here. Position loaded.' && el.className === 'an-status', [el.textContent, el.className]);
    Object.assign(conf, {an_variant: 'crazyhouse', an_engine: 'stockfish-18-nnue'});
    c.loadLine = ['illegal move in the PGN: Qxx9', 'err'];
    c.onVariantChange(false);
    ok('...a Fairy switch note too, and a load error keeps its error colour',
       /^Engine switched to Fairy-Stockfish: only it plays crazyhouse\. illegal move/.test(el.textContent) && el.className === 'an-status an-err', [el.textContent, el.className]);
    Object.assign(conf, {an_variant: 'chess', an_engine: 'sf18-native'});
    c.loadLine = [''];
    c.onVariantChange(false);
    ok('...no swap, no note: the load line stands alone', el.textContent === '' && el.className === 'an-status', [el.textContent, el.className]);
}
// ---- audit 3.1.329 ANALYSIS-4: the tablebase line is cleared while a new position's lookup is out ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const a = an.indexOf('async function renderExtras('), b = an.indexOf('\n}\n', a) + 3;
    const tbEl = {textContent: 'Tablebase: mate in 7 - Kd6'};
    const pending = [];
    const c = vm.createContext({tbEl, pending, positions: [{fen: 'K7/8/8/8/8/8/8/k6q b - - 0 1'}], cursor: 0, tbCache: new Map(), TB_MAX_MEN: 7,
        chrome: {runtime: {sendMessage: (m, cb) => pending.push(cb), lastError: null}}});
    vm.runInContext(`const $ = (id) => (id === 'an_tb' ? tbEl : null); const anVariant = () => 'chess';
        const pieceCount = () => 3; const sanOf = () => 'Qh8'; const tbWords = () => 'win';
        ${an.slice(a, b)}`, c);
    const p = c.renderExtras(c.positions[0]);
    ok('ANALYSIS-4: a cache miss blanks the old verdict before the lookup answers', pending.length === 1 && tbEl.textContent === '', [pending.length, tbEl.textContent]);
    pending[0]({category: 'win', moves: [{uci: 'h1h8'}]});
    p.then(() => ok('...and the answer, when it lands, is written', tbEl.textContent === 'Tablebase: win - Qh8', tbEl.textContent));
}
// ---- audit 3.1.329 ANALYSIS-5: a sweep whose wait for the borrowed net outlived the page builds no private net ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const a = an.indexOf('let bandChain = Promise.resolve();'), b = an.indexOf('// SWEEP THE NEXT PLY', a);
    const c = vm.createContext({Promise, Math, bandRun: 1, built: 0, human: null, bandCache: new Map(), bandKey: (f, k) => f + k, cfg: () => 1500,
        bandSteps: () => [600, 700], takesRating: () => true, BAND_MULTIPV: 12,
        makeEngine: () => { c.built++; return {start: async () => {}, send() {}, dispose() {}, analyse: async () => ({lines: [{pv: ['e2e4'], prob: 1}]})}; }});
    // the page is left while the sweep waits on the human build: teardown bumps bandRun, the build hands back null
    c.ensureHuman = async () => { c.bandRun++; return null; };
    vm.runInContext(an.slice(a, b), c);
    vm.runInContext('sweepBands({fen: "x", turn: "w"}, "maia3", bandRun, null)', c).then(r => {
        ok('ANALYSIS-5: the sweep ends without building its own copy of the net', r === null && c.built === 0, [r, c.built]);
        // the same null with the run still current (no human column) still sweeps on a private net
        c.ensureHuman = async () => null;
        return vm.runInContext('sweepBands({fen: "y", turn: "w"}, "maia3", bandRun, null)', c);
    }).then(r => ok('...with the run still current, a null still means "no shared net": one private net sweeps', !!r && c.built === 1 && r[600]?.[0]?.uci === 'e2e4', [r, c.built]));
}
// ---- audit 3.1.329 ANALYSIS-6: no human net or ratings sweep under a saved Shogi / Xiangqi game ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const fn = (head) => { const a = an.indexOf(head), b = an.indexOf('\n}\n', a) + 3; if (a < 0) throw new Error('slice ' + head); return an.slice(a, b); };
    const c = vm.createContext({Promise, game: 'shogi', asked: 0, swept: 0, made: []});
    vm.runInContext(`let bandRun = 0, human = null, humanKey = null, engine = null, engine2 = null, analyseChain = Promise.resolve(), humanChain = Promise.resolve();
        const cursor = 0, positions = [{fen: 'start', turn: 'w'}], humanCache = new Map(), bandCache = new Map(), CFG = {an_band: 1500};
        const cfg = (k) => (k === 'an_human' ? 'maia3' : k === 'an_game' ? game : 1500);
        const $ = () => null; function syncBandRow() {} function stopMatch() {} async function stopSearch() {} function showLargeGame() {}
        function largeOpts() {} function hideLargeGame() {} function takesRating() { return true; } function ratingFor(k, b) { return b; }
        function renderHumanLines() {} function render() {} function status() {}
        function ensureHuman() { asked++; return Promise.resolve({}); } async function humanFor() {} function renderBands() { swept++; }
        ${fn('function largeGame()')}
        ${fn('function applyGame(')}
        ${fn('async function reloadHuman()')}`, c);
    (async () => {
        await vm.runInContext('reloadHuman()', c);
        ok('ANALYSIS-6: the human selects firing on a Shogi page load build no net and run no sweep', c.asked === 0 && c.swept === 0, [c.asked, c.swept]);
        c.game = 'chess';
        await vm.runInContext('reloadHuman()', c);
        ok('...on chess the same change still builds the model and draws the bands', c.asked === 1 && c.swept === 1, [c.asked, c.swept]);
        // a build already loading when the game switches to Xiangqi: it lands after applyGame's dispose ran

        vm.runInContext('humanChain = new Promise(r => { landHuman = () => { human = {dispose() { made.push("disposed"); }}; humanKey = "maia3|1500"; r(human); }; })', c);
        const land = vm.runInContext('landHuman', c);
        c.game = 'xiangqi';
        vm.runInContext('applyGame(true)', c);
        await vm.runInContext('analyseChain', c);
        land();
        await vm.runInContext('humanChain', c);
        ok('...a net still loading when Xiangqi is picked is disposed once it lands', c.made.join() === 'disposed' && vm.runInContext('human', c) === null, [c.made, vm.runInContext('human === null', c)]);
    })().catch(e => { fails++; console.log('FAIL ANALYSIS-6 check threw: ' + (e && e.stack || e)); });
}
// ---- audit 3.1.329 PLAY-1: a book or tablebase move leaves Err Like Your Rating's rolled error owed ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fnS = (n) => { const i = s.indexOf(`function ${n}(`); return s.slice(i, s.indexOf('\n}\n', i) + 3); };
    const c = vm.createContext({console: {log() {}, warn() {}}, Math, Date, Map, String, parseInt, Number, Infinity});
    // humanize_pick, real, with Err Like Your Rating's real debt arithmetic; the roll is stubbed to a
    // mistake (class 3) on the second line, which is what Humanize would have played
    vm.runInContext(`var config = {humanize: true, variant: 'chess', maia3_elo: 1500, engine: 'stockfish'};
        var turn = 'w', last_our_eval = null, humanize_roll = {r: 50}, hz_where_state = null, hz_match_state = null, hz_think_rhythm = null;
        var last_eval = {fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 12', lastMove: 'e7e6',
            lines: [{move: 'g1f3', pv: 'g1f3', score: 30}, {move: 'a2a3', pv: 'a2a3', score: -150}]};
        const HZ_WIN_CP = 300, HZ_PUNISH_CP = 200, HZ_MATCH_DEFAULT = true, ONE_PASS_ENGINES = [], HUMAN_TIME_MEAN = {};
        ${s.slice(s.indexOf('const HZ_MATCH_LABEL'), s.indexOf('\n', s.indexOf('const HZ_MATCH_LABEL')))}
        ${s.slice(s.indexOf('const HZ_DEBT_PAY'), s.indexOf('\n', s.indexOf('const HZ_DEBT_PAY')))}
        ${fnS('hz_match_with_debt')}${fnS('hz_match_settle')}
        function line_cp_ours(l) { return l.score; } function win_percent(cp) { return 50 + cp / 10; }
        function Chess() { return {moves: () => ['a', 'b']}; }
        function first_move() { return false; } function in_opening() { return false; } function hz_opening_ok() { return true; }
        function premove_reply_playable() { return true; } function humanize_rates_now() { return {}; } function hz_maia_probs() { return null; }
        function humanize_flag(k, d) { return d; } function humanize_thresholds() { return {blunder: 1000, inaccuracy: 50, fourth: 20}; }
        function hz_natural_hang() { return true; } function hz_hangs() { return false; } function hz_exposure() { return null; }
        function hz_win_floor() { return -Infinity; } function hz_mate_in() { return null; } function hz_simplify_hold() { return false; }
        function humanize_target() { return null; } function humanize_game_run() { return null; } function is_one_pass() { return false; }
        function humanize_tc_inputs() { return null; } function hz_match_shares() { return [0.5, 0.2, 0.15, 0.1, 0.05]; }
        function hz_punish_keep() { return 1; } function hz_type_classifier() { return null; } function hz_type_mix() { return null; }
        function hz_hidden_of() { return false; } function hz_drop_class() { return 3; } function complexity_k() { return 1; }
        function clock_budget_ms() { return null; } function hz_clock_rail(t) { return t; } function in_time_trouble() { return false; }
        function hz_match_pick(cands) { return {cand: cands[1], rolled: 3, played: 3}; }
        ${fnS('humanize_pick')}`, c);
    const run = (decided) => { vm.runInContext('hz_match_state = null', c); const p = vm.runInContext(`humanize_pick('g1f3', ${decided})`, c); return {p, debt: vm.runInContext('hz_match_state.debt', c)}; };
    const free = run(false), book = run(true);
    ok('PLAY-1 control: with no book move the rolled mistake is played and paid', free.p.move === 'a2a3' && free.p.category === 'mistake' && free.debt[3] < 0, [free.p.move, free.p.category, free.debt]);
    ok('PLAY-1: when a book or tablebase move will be played, the mistake is owed (debt up), not booked as played',
       Math.abs(book.debt[3] - 0.1) < 1e-9 && book.debt[2] > 0 && book.debt[4] > 0, book.debt);
    ok('...no deviation and no error label for that move', book.p.move === 'g1f3' && book.p.category === 'top engine', [book.p.move, book.p.category]);
    ok('...wired: on_engine_best_move tells humanize_pick when book or tablebase wins',
       /const pick = humanize_pick\(best, !!\(tb_ok \|\| book_ok\)\);\s*if \(tb_ok \|\| book_ok\) pick\.move = played;/.test(s));
}
// ---- audit 3.1.329 PLAY-3: a re-sent move is counted once in Session Stats ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = s.indexOf('function request_automove(move, think'), j = s.indexOf('\n}\n', i) + 3;
    const clr = s.indexOf('if (fen !== last_eval.fen) session_counted_fen = null;');
    const c = vm.createContext({console: {log() {}}, Date, Number, Math, counted: [], sent: []});
    vm.runInContext(`var setup_fen = null, config = {}, last_eval = {fen: 'P w'}, analysed_push_key = 'k', our_turn_at = 0, session_counted_fen = null;
        const bgTrace = () => {}; const our_side = () => 'white'; const safe_deselect_square = () => null;
        const fresh_timing = () => ({think_time: 500}); const move_situation = () => '';
        const session_note_move = (ms) => counted.push(ms); const send_to_active_tab = (m) => sent.push(m);
        function new_pos(fen) { ${clr > 0 ? s.slice(clr, s.indexOf('\n', clr)) : ''}
            last_eval = {fen}; }
        ${s.slice(i, j)}`, c);
    vm.runInContext(`request_automove('e2e4'); new_pos('P w'); request_automove('e2e4', 800); request_automove('e2e4')`, c);
    ok('PLAY-3: the same position\'s move sent three times (a resume, a re-push) is sent each time but counted once',
       c.sent.length === 3 && c.counted.length === 1 && c.counted[0] === 500, {sent: c.sent.length, counted: c.counted});
    vm.runInContext(`new_pos('Q b'); new_pos('R w'); request_automove('g1f3')`, c);
    ok('...the next position of ours counts again', c.counted.length === 2, c.counted);
    vm.runInContext(`new_pos('S b'); new_pos('P w'); request_automove('e2e4')`, c);
    ok('...and a position repeated after others (a new game from the same start) counts again', c.counted.length === 3, c.counted);
    ok('...wired: on_new_pos clears the key only for a different position, after the misread return',
       clr > s.indexOf("return;   // deliberately WITHOUT promoting incoming_push_key") && clr > s.indexOf('function on_new_pos(')
       && clr < s.indexOf('last_eval = {fen, activeLines: 0'));
}
// ---- audit 3.1.329 CLICK-3: a 4PC move held back is held before the from-click only ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = s.indexOf('function simulateMove4PC('), j = s.indexOf('\n}\n', i) + 3;
    const c = vm.createContext({console: {warn() {}}, Math, RegExp, Promise, clicks: [], asks: [],
        window: {innerHeight: 800}, DOMRect: function (x, y, w, h) { Object.assign(this, {x, y, width: w, height: h, left: x, top: y}); }});
    vm.runInContext(`var config = {think_time: 0, think_variance: 0, move_time: 0, move_variance: 0}, moveGen = 1, deferredWhileHidden = false, heldAt = [];
        function dropMove() {} function bgLogAlways() {} async function warmClicker() {} function promiseTimeout() { return Promise.resolve(); }
        function fourPCGeometry() { return {size: 10}; } function fourPCSquareXY(sq) { return {x: sq.charCodeAt(0), y: parseInt(sq.slice(1))}; }
        async function promote4PC() {}
        async function simulateClickSquare(r) { clicks.push(r.x); }
        function moveHeldBack() { asks.push(clicks.length); return heldAt.includes(clicks.length) ? 'hidden' : null; }
        ${s.slice(i, j)}`, c);
    (async () => {
        // the tab goes hidden after the from-click: the pair is finished, nothing is deferred
        vm.runInContext('heldAt = [1]', c);
        await vm.runInContext(`simulateMove4PC('d2d4', 0, 1)`, c);
        ok('CLICK-3: hidden between the clicks, the 4PC move still completes both clicks and is not deferred (no half-played move)',
           c.clicks.length === 2 && vm.runInContext('deferredWhileHidden', c) === false && c.asks.join() === '0', {clicks: c.clicks, asks: c.asks});
        // hidden before the from-click: nothing is clicked, and the move is deferred for the return
        c.clicks.length = 0; c.asks.length = 0;
        vm.runInContext('heldAt = [0]', c);
        await vm.runInContext(`simulateMove4PC('d2d4', 0, 1)`, c);
        ok('...hidden after the think, before the from-click: no click, deferred for resumeIfDeferred',
           c.clicks.length === 0 && vm.runInContext('deferredWhileHidden', c) === true, {clicks: c.clicks});
    })().catch(e => { fails++; console.log('FAIL CLICK-3 check threw: ' + (e && e.stack || e)); });
}
// ---- audit 3.1.329 OPT-1: a Settings-page Four-player Mode / Help Mode / Autoplay change re-analyses the 4PC board ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = s.indexOf('function watch_config_changes() {');
    const c = vm.createContext({JSON, console: {log() {}, warn() {}}, listener: null, pushed: 0, asked: 0,
        chrome: {storage: {onChanged: {addListener(f) { c.listener = f; }}}}});
    vm.runInContext(`var config_watch_on = false, PANEL_BOOTED = true, resync_after_config_change = false, fen_request_inflight = false, setup_fen = null;
        var config = {fourpc_mode: 'auto', help_mode: false, autoplay: true, manual_mode: false, clock_mode: false}, last_eval = {fen: 'X'}, fourpc_last = 'FEN4';
        const LIVE_CONFIG_KEYS = ['fourpc_mode', 'help_mode', 'autoplay', 'manual_mode', 'clock_mode'];
        function panel_reload() {} function reload_after_reset() {} function request_clear_hint() {} function abandon_search() {}
        function sync_quick_settings() {} function keep_alive() {} function keep_alive_wanted() { return false; }
        function push_config() { pushed++; } function request_fen() { asked++; } function on_new_pos() {}
        ${s.slice(i, s.indexOf('\n}\n', i) + 3)}
        watch_config_changes();`, c);
    const change = (key, v) => {
        vm.runInContext(`fourpc_last = 'FEN4'`, c);
        c.listener({[key]: {newValue: JSON.stringify(v), oldValue: JSON.stringify(vm.runInContext(`config.${key}`, c))}}, 'local');
        return vm.runInContext('fourpc_last', c);
    };
    const got = {mode: change('fourpc_mode', 'ffa'), help: change('help_mode', true), auto: change('autoplay', false)};
    ok('OPT-1: Four-player Mode, Help Mode and Autoplay changed on the Settings page clear the 4PC dedupe, so the board on screen is analysed again',
       got.mode === '' && got.help === '' && got.auto === '' && c.pushed === 3, {got, pushed: c.pushed});
    ok('...an unrelated live key leaves it alone', change('clock_mode', true) === 'FEN4');
}
// ---- audit 3.1.329 SCRAPE-2: only a real Chess960 start is captured off lichess (replaces the 3.1.328 SCRAPE-1 block) ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const d = s.indexOf('const DEFAULT_POSITION ='), de = s.indexOf(';', d) + 1;
    const i = s.indexOf('let seen960Start = null;'), j = s.indexOf('function readStartPos(url) {');
    const c = vm.createContext({Date, written: [], board: null, startPosKey: () => 'k', isChesscomVariants: () => false,
        writeStartPos: (k, v) => c.written.push([k, v.position]), scrapePositionPuz: () => { if (c.board === 'throw') throw new Error('x'); return c.board; }});
    try { vm.runInContext(s.slice(d, de) + s.slice(i, j) + ';this.seen = () => seen960Start;', c); } catch (e) { console.log('slice threw: ' + e.message); }
    // a chess.com scrape: h-file first, any turn, maybe a last-move token. `moves` edits the board.
    const scrape = (back, moves = {}, turn = 'b', extra = '') => {
        const b = {};
        for (let f = 0; f < 8; f++) {
            const F = 'abcdefgh'[f];
            b[F + '1'] = back[f]; b[F + '2'] = 'P'; b[F + '7'] = 'p'; b[F + '8'] = back[f].toLowerCase();
        }
        for (const [sq, pc] of Object.entries(moves)) { if (pc) b[sq] = pc; else delete b[sq]; }
        let out = turn + '*****';
        for (const sq of Object.keys(b).sort((x, y) => y[0].localeCompare(x[0]) || y[1] - x[1])) {
            const pc = b[sq];
            out += `${pc === pc.toUpperCase() ? 'w' : 'b'}-${pc.toLowerCase()}-${sq}*****`;
        }
        return out + extra;
    };
    const cap = (str) => { c.board = str; try { vm.runInContext('capture960Start()', c); } catch (e) { return 'threw ' + e.message; } return null; };
    const seen = () => { try { return c.seen(); } catch (e) { return 'threw'; } };
    const DP = vm.runInContext('DEFAULT_POSITION', c);
    cap(scrape('NRKBBQRN'));
    const first = seen();
    ok('960 at move 0: the board is kept, in DEFAULT_POSITION\'s order with White to move, written once',
       typeof first === 'string' && first.startsWith('w*****b-n-a8*****b-r-b8*****') && /w-n-h1\*\*\*\*\*$/.test(first) && c.written.length === 1, [first, c.written.length]);
    cap(scrape('NRKBBQRN'));
    ok('...the same start again is not rewritten', c.written.length === 1, c.written.length);
    cap(scrape('NRKBBQRN', {e7: null, e5: 'p'}, 'w'));
    ok('Black premoved e5 before White moved (list still empty): not a start, the capture is kept', seen() === first && c.written.length === 1, seen());
    cap(scrape('NRKBBQRN', {e2: null, e4: 'P'}, 'b', 'lm-e2e4*****'));
    ok('White\'s first move painted before the list has it: not a start', seen() === first && c.written.length === 1, seen());
    cap(scrape('NRKBBQRN', {h1: null, g3: 'N'}));
    ok('a knight out from the back rank: not a start', seen() === first);
    cap('throw');
    ok('a torn read keeps what was captured', seen() === first);
    cap(scrape('BNBRKNRQ'));   // bishops on a1 and c1: the same colour
    ok('bishops on one colour: not a 960 start', seen() === first);
    cap(scrape('KRNBBNRQ'));
    ok('king outside the rooks: not a 960 start', seen() === first);
    cap(scrape('RNBQKBNR'));
    ok('position 518 scraped h-file first is filed as exactly DEFAULT_POSITION, replacing the older start',
       seen() === DP && c.written.length === 2 && c.written[1][1] === DP, [seen(), c.written.length]);
    ok('the var scrape only uses a stored start off lichess when it is a 960 start',
       /\(\(site === 'lichess'\) \? stored : chess960Start\(puzBoard\(stored\)\)\)\s*\|\| \(site !== 'lichess' && seen960Start\) \|\| DEFAULT_POSITION/.test(s));
}
// ---- audit 3.1.329 SCRAPE-1: a /variants/chess960 start is read off the variants board ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const cut = (from, to) => { const a = s.indexOf(from), b = s.indexOf(to, a); return (a < 0 || b < 0) ? '' : s.slice(a, b); };
    const fn = (name) => { const a = s.indexOf(`function ${name}(`); return a < 0 ? '' : s.slice(a, s.indexOf('\n}\n', a) + 3); };
    const SQ = 50;
    let pieces = [];
    const sprite = (hex) => `url("data:image/svg+xml;base64,${Buffer.from(`<svg><path fill="${hex}"/></svg>`).toString('base64')}")`;
    const c = vm.createContext({Date, Math, String, parseFloat, written: [],
        atob: (x) => Buffer.from(x, 'base64').toString('binary'),
        getComputedStyle: (p) => ({backgroundImage: sprite(p.light ? '#f8f8f8' : '#202020')}),
        getBoard: () => ({getBoundingClientRect: () => ({width: 8 * SQ, height: 8 * SQ})}),
        isChesscomVariants: () => true, startPosKey: () => 'k', writeStartPos: (k, v) => c.written.push([k, v.position]),
        scrapePositionPuz: () => { throw new Error('the main-site reader was used'); },
        document: {querySelectorAll: (sel) => pieces.filter(p => !(/:not\(\[data-dead\]\)/.test(sel) && p.attrs['data-dead'] !== undefined))}});
    try {
        vm.runInContext(cut('const DEFAULT_POSITION =', '\n\n') + cut('const CC_VARIANTS_COLORS =', '\n') + fn('variants960Board')
            + fn('getChesscomVariantsOrientation') + fn('spriteLightness') + cut('let seen960Start = null;', 'function readStartPos(url) {')
            + ';this.seen = () => seen960Start;', c);
    } catch (e) { console.log('slice threw: ' + e.message); }
    // a variants 960 start: pieces positioned only by transform, per-game colour codes, plus a captured
    // piece and a bank piece that must be ignored
    const lay = (back, {black = false, codes = ['5', '6'], frac = 0} = {}) => {
        pieces = [];
        const put = (f, r, pc) => {
            const col = black ? 7 - f : f, row = black ? r - 1 : 8 - r;
            const w = pc === pc.toUpperCase();
            const attrs = {'data-piece': pc.toUpperCase(), 'data-color': w ? codes[0] : codes[1], style: `transform: translate(${col * SQ + frac}px, ${row * SQ}px);`};
            pieces.push({attrs, light: w, getAttribute: (n) => attrs[n]});
        };
        for (let f = 0; f < 8; f++) { put(f, 1, back[f]); put(f, 2, 'P'); put(f, 7, 'p'); put(f, 8, back[f].toLowerCase()); }
        const dead = {'data-piece': 'Q', 'data-color': codes[0], 'data-dead': '', style: `transform: translate(${3 * SQ}px, ${4 * SQ}px);`};
        const bank = {'data-piece': 'N', 'data-color': codes[1], style: `transform: translate(${-2 * SQ}px, ${3 * SQ}px);`};
        pieces.push({attrs: dead, getAttribute: (n) => dead[n]}, {attrs: bank, getAttribute: (n) => bank[n]});
    };
    const cap = () => { try { vm.runInContext('capture960Start()', c); } catch (e) { return e.message; } return null; };
    const seen = () => { try { return c.seen(); } catch (e) { return 'threw'; } };
    lay('NRKBBQRN', {frac: 17});
    cap();
    ok('pieces still sliding in: nothing captured, the next scrape retries', seen() === null, seen());
    lay('NRKBBQRN');
    const err = cap();
    const one = seen();
    ok('variants 960, White at the bottom (codes 5/6): the start is read off the transforms, not the main-site reader',
       err === null && typeof one === 'string' && one.startsWith('w*****b-n-a8*****b-r-b8*****b-k-c8*****') && one.includes('w-k-c1*****') && c.written.length === 1, [err, one]);
    lay('BQNRKRNB', {black: true, codes: ['7', '9']});
    cap();
    const two = seen();
    ok('...Black at the bottom with per-game colour codes: same files and ranks, colours by half',
       typeof two === 'string' && two.startsWith('w*****b-b-a8*****b-q-b8*****b-n-c8*****b-r-d8*****b-k-e8') && two.includes('w-b-h1*****') && c.written.length === 2, two);
    lay('NRKBBQRN');
    pieces = pieces.filter(p => !(p.attrs.style.includes(`${4 * SQ}px, ${6 * SQ}px`)));   // e2 gone
    pieces.push({attrs: {'data-piece': 'P', 'data-color': '5', style: `transform: translate(${4 * SQ}px, ${4 * SQ}px);`}, getAttribute(n) { return this.attrs[n]; }});
    cap();
    ok('...a board already a move in (e4) is not a start: the last capture stays', seen() === two && c.written.length === 2, seen());
}
// ---- audit 3.1.329 SCRAPE-3: a FINISHED chess.com game follows the viewed move even with Autoplay on ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const r = s.indexOf('const RESULT_IN_TEXT ='), i = s.indexOf('function scrapePositionFen('), j = s.indexOf('\n}\n', i) + 3;
    const node = (san) => { const m = {innerText: san, lastElementChild: null, classList: {contains: () => false}}; return {m, w: {lastElementChild: m}}; };
    const n = ['e4', 'e5', 'Nf3'].map(x => node(x));
    let modal = false, listText = '';
    const c = vm.createContext({site: 'chesscom', config: {autoplay: true, simon_says_mode: false}, location: {pathname: '/game/live/123'},
        CC_GAME_PATH: /^\/(game|play)(\/|$)/, isChesscomVariants: () => false, getSelectedMoveRecord: () => n[0].m, getMoveRecords: () => n.map(x => x.w), figurineSan: (a, b) => b,
        document: {querySelector: (sel) => (modal && /game-over-modal/.test(sel)) ? {} : null}, knownMoveContainer: () => ({textContent: listText})});
    try { vm.runInContext((r < 0 ? '' : s.slice(r, i)) + s.slice(i, j), c); } catch (e) { console.log('slice threw: ' + e.message); }
    const run = () => { try { return vm.runInContext('scrapePositionFen()', c); } catch (e) { return 'threw ' + e.message; } };
    listText = ' 1. e4 e5 2. Nf3 ';
    ok('live game, Autoplay on, stepped back: still read to the latest move', run() === 'e4*****e5*****Nf3*****', run());
    listText = ' 1. e4 e5 2. Nf3 1-0 ';
    ok('finished game (a result in the move list), Autoplay on: follows the viewed move', run() === 'e4*****', run());
    listText = ' 1. e4 e5 2. Nf3 ½-½ ';
    ok('...a draw result too', run() === 'e4*****', run());
    listText = ' 1. e4 e5 2. Nf3 '; modal = true;
    ok('...and while the game-over modal is up', run() === 'e4*****', run());
    modal = false; listText = ' 1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 c6 5. Nf3 Bf5 10. O-O-O ';
    ok('ordinary SANs and move numbers never read as a result', run() === 'e4*****e5*****Nf3*****', run());
    const fx = fs.readFileSync(ROOT + '/test/fixtures/chesscom-game.html', 'utf8');
    const live = fx.slice(fx.indexOf('<wc-simple-move-list'), fx.indexOf('</wc-simple-move-list>')).replace(/<[^>]*>/g, ' ');
    let rx = null; try { rx = vm.runInContext('RESULT_IN_TEXT', c); } catch (e) { /* old code: no such check */ }
    ok('the fixture\'s game in progress reads as live', !!rx && !rx.test(live));
}
// ---- audit 3.1.329 REVIEW-1 + ANALYSIS-7: two native engines on one options page get two host processes ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const a = bg.indexOf('function ensureNative(name) {'), b = bg.indexOf('// ===== IS THE OPPONENT STREAMING?', a);
    const hosts = [], listeners = [];
    const mkPort = (name, url) => { const p = {name, sender: {url}, sent: [], postMessage(m) { p.sent.push(m); }, onDisconnect: {addListener(f) { p.bye = f; }}, onMessage: {addListener(f) { p.hear = f; }}}; return p; };
    const c = vm.createContext({NATIVE_HOSTS: {'sf-native': {app: 'com.x.sf', label: 'Stockfish'}}, nativePorts: {}, popupPortsByName: {}, nativeRequestOwner: new Map(),
        nativeSeq: 0, nativeFramesIn: 0, nativeFramesRecent: [], nativeFramesOut: 0, sweepNativeOwners() {}, nativeTrace() {}, console, Date,
        chrome: {runtime: {lastError: null, onConnect: {addListener: (f) => listeners.push(f)},
            connectNative: (app) => { const h = {app, got: [], closed: false, postMessage(m) { h.got.push(m); }, onMessage: {addListener(f) { h.reply = f; }}, onDisconnect: {addListener() {}}, disconnect() { h.closed = true; }}; hosts.push(h); return h; }}}});
    vm.runInContext(bg.slice(a, b), c);
    const page = 'chrome-extension://id/src/options/options.html#review';
    const w0 = mkPort('sf-native', page), w1 = mkPort('sf-native', page);          // the review pool, Engines at once = 2
    const an1 = mkPort('sf-native', 'chrome-extension://id/src/options/options.html#analysis'),
          an2 = mkPort('sf-native', 'chrome-extension://id/src/options/options.html#analysis');   // Engine + Second engine
    const panel = mkPort('sf-native', 'https://lichess.org/abc'), popup = mkPort('sf-native', 'chrome-extension://id/src/popup/popup.html');
    for (const p of [w0, w1, an1, an2, panel, popup]) { listeners[0](p); p.hear({id: 1, cmd: 'analyse', fen: 'x', time: 1000}); }
    ok('REVIEW-1: each options-page engine gets its own host process; the panel and toolbar popup still share one',
       hosts.length === 5 && hosts.slice(0, 4).every(h => h.got.length === 1) && hosts[4].got.length === 2, hosts.map(h => h.got.length));
    // each host's answer goes back to the port that asked, under that port's own id
    hosts[1].reply({id: hosts[1].got[0].id, done: true, lines: []});
    ok('REVIEW-1: an answer reaches only the worker whose host searched it', w1.sent.length === 1 && w1.sent[0].id === 1 && w0.sent.length === 0, [w0.sent, w1.sent]);
    w0.bye();
    ok('REVIEW-1: closing one worker shuts its host only, and its key is dropped',
       hosts[0].closed && !hosts[1].closed && Object.keys(c.popupPortsByName).filter(k => k.startsWith('sf-native#options')).length === 3,
       [hosts.map(h => h.closed), Object.keys(c.popupPortsByName)]);
}
// ---- audit 3.1.329 REVIEW-2: a batch skips only a game that will not replay; an engine failure ends it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const fn = (head) => { const a = rj.indexOf(head), b = rj.indexOf('\n}\n', a) + 3; return rj.slice(a, b); };
    const el = () => ({disabled: false, value: '', classList: {add() {}, remove() {}, toggle() {}}, scrollIntoView() {}});
    const els = {};
    const mk = (extra, withRunReview = false) => {
        const c = vm.createContext({console, Promise, setTimeout, Error, String, Object, Math,
            $: (id) => (els[id] = els[id] || el()), cfg: (k) => ({rv_batch: true, rv_explain: false, rv_variant: 'chess', rv_book: false}[k]),
            note: (t, err) => { c.notes.push([t, !!err]); }, progress() {}, renderReport() {}, renderBatch() {}, disposeRig() {}, gameText: () => '',
            run4pcReview() {}, selectedGame: () => c.games[0], notes: [], ...extra});
        vm.runInContext('var running = false, cancel = false, report = null, batchReports = null, batchInputText = "", is4pcGame = false;\n'
            + fn('async function onRun() {') + (withRunReview ? '\n' + fn('async function runReview(game, rig, onProgress) {') : ''), c);
        return c;
    };
    (async () => {
        // the batch loop: game 2's engine fails; game 3 must never be asked
        const asked = [];
        const c = mk({games: [{n: 1}, {n: 2}, {n: 3}], startRig: async () => ({}),
            runReview: async (g) => { asked.push(g.n); if (g.n === 2) throw new Error('the native host did not answer this position'); return {n: g.n}; }});
        await c.onRun();
        ok('REVIEW-2: an engine failure ends the batch: the next game is not started', asked.join() === '1,2', asked);
        ok('...the finished game is kept as the report and the note names the failure',
           c.report && c.report.n === 1 && c.notes.some(([t, e]) => e && /engine failed in game 2 \(the native host did not answer/.test(t)), [c.report, c.notes]);
        // a replay failure is still skipped and the batch goes on
        asked.length = 0;
        const c2 = mk({games: [{n: 1}, {n: 2}, {n: 3}], startRig: async () => ({}),
            runReview: async (g) => { asked.push(g.n); if (g.n === 2) throw Object.assign(new Error('Invalid move: Nf9'), {replayFailed: true}); return {n: g.n}; }});
        await c2.onRun();
        ok('REVIEW-2: a game that will not replay is still skipped, and the batch goes on', asked.join() === '1,2,3' && c2.report.n === 3
           && c2.notes.some(([t]) => /Skipped 1 of 3: game 2 \(Invalid move: Nf9\)/.test(t)), [asked, c2.notes]);
        // the real runReview marks a replay failure, and only that
        const c3 = mk({buildPositions: () => { throw new Error('Invalid move: Nf9'); }}, true);
        let e3 = null; try { await c3.runReview({tags: {}}, {opts: {}}, () => {}); } catch (e) { e3 = e; }
        ok('REVIEW-2: runReview tags a replay failure as one', e3 && e3.replayFailed === true && /Nf9/.test(e3.message), e3 && e3.message);
        // the pool: one worker fails, the other takes no further position
        const calls = {a: 0, b: 0};
        const ea = {analyse: async () => { calls.a++; throw new Error('engine disposed'); }};
        const eb = {analyse: async () => { calls.b++; await new Promise(r => setTimeout(r, 5)); return {lines: [], depth: 1}; }};
        const positions = Array.from({length: 6}, () => ({fen: 'x', turn: 'w'}));
        const c4 = mk({buildPositions: () => ({positions, moves: []}), fillThinkTime() {}, incrementFromTimeControl: () => 0}, true);
        let e4 = null; try { await c4.runReview({tags: {}}, {opts: {}, engines: [ea, eb]}, () => {}); } catch (e) { e4 = e; }
        await new Promise(r => setTimeout(r, 60));
        ok('REVIEW-2: after one worker fails the other takes no further position', e4 && !e4.replayFailed && calls.a === 1 && calls.b === 1, [calls, e4 && e4.message]);
    })();
}
// ---- audit 3.1.329 REVIEW-3: a new run drops the old report, so Export and a revisit cannot show it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rj.indexOf('async function onRun() {'), b = rj.indexOf('\n}\n', a) + 3;
    const run = (batch, runReview) => {
        const els = {};
        const c = vm.createContext({console, Promise, Error, String, notes: [], seenDuringRun: null,
            $: (id) => (els[id] = els[id] || {disabled: false, value: 'B', classList: {add() {}, remove() {}}, scrollIntoView() {}}),
            cfg: (k) => (k === 'rv_batch' ? batch : k === 'rv_variant' ? 'chess' : false), note: (t, e) => c.notes.push([t, !!e]),
            progress() {}, renderReport() {}, renderBatch() {}, disposeRig() {}, gameText: () => 'B', run4pcReview() {}, startRig: async () => ({}),
            selectedGame: () => ({id: 'B'}), runReview: async (g) => { c.seenDuringRun = {report: vm.runInContext('report', c), exp: els.rv_export.disabled}; return runReview(g); }});
        els.rv_export = {disabled: false, classList: {add() {}, remove() {}}};   // game A's report is on screen: Export is live
        els.rv_fit = {disabled: false, classList: {add() {}, remove() {}}};
        vm.runInContext('var running = false, cancel = false, is4pcGame = false, batchInputText = "", report = {game: "A", pgnText: "A"}, batchReports = [{game: "A"}];\n'
            + 'var games = [{id: 1}, {id: 2}];\n' + rj.slice(a, b), c);
        return vm.runInContext('onRun()', c).then(() => ({c, els}));
    };
    Promise.all([
        run(false, async () => { throw new Error('Move 3. Nf6 is not legal'); }),
        run(true, async () => { throw Object.assign(new Error('Move 3. Nf6 is not legal'), {replayFailed: true}); }),
    ]).then(([single, batch]) => {
        ok('REVIEW-3: during the run game A is gone and Export and Fit are off',
           single.c.seenDuringRun.report === null && single.c.seenDuringRun.exp === true && single.els.rv_fit.disabled === true, single.c.seenDuringRun);
        ok('REVIEW-3: a failed single run leaves no report and Export off',
           vm.runInContext('report', single.c) === null && single.els.rv_export.disabled === true, [vm.runInContext('report', single.c), single.els.rv_export.disabled]);
        ok('REVIEW-3: a batch where every game was skipped leaves no report for a revisit to bring back',
           vm.runInContext('report === null && batchReports === null', batch.c) && batch.els.rv_export.disabled === true);
    });
}
// ---- audit 3.1.329 REVIEW-4: page load with a fairy Game type shows Fairy-Stockfish, without saving it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const fnOf = (head) => { const a = rj.indexOf(head), b = rj.indexOf('\n}\n', a) + 3; return rj.slice(a, b); };
    const ms = rj.indexOf('        const rvModeSync = () => {'), me = rj.indexOf('\n        };\n', ms) + 11;
    const is = rj.indexOf('        updateEngineOptions();\n', me), ie = rj.indexOf('        syncLimitUi();', is);
    // a select that behaves like the real one: a value it has no option for leaves it on ''
    const sel = {opts: [], _v: '', listeners: 0, innerHTML: '', classList: {toggle() {}}, addEventListener() { sel.listeners++; },
        get options() { return sel.opts; }, get value() { return sel._v; }, set value(v) { sel._v = sel.opts.some(o => o.value === v) ? v : ''; }};
    Object.defineProperty(sel, 'innerHTML', {set(h) { sel.opts = [...h.matchAll(/<option value="([^"]+)"( disabled)?/g)].map(m => ({value: m[1], disabled: !!m[2]})); sel._v = sel.opts[0]?.value || ''; }, get() { return ''; }});
    const store = {rv_variant: 'variant', rv_variant_which: 'crazyhouse', rv_mode: 'own', rv_engine: 'sf19-native'};
    const writes = [];
    const c = vm.createContext({console, String, Object,
        ENGINES: [{id: 'sf19-native', label: 'Stockfish 19 (native)', kind: 'native'}, {id: 'fairy-stockfish-14-nnue', label: 'Fairy-Stockfish 14 (WASM)', kind: 'wasm'}],
        nativeAvailable: null, esc: (s) => s, cfg: (k) => store[k], setCfg: (k, v) => { writes.push(k); store[k] = v; },
        $: (id) => (id === 'rv_engine' ? sel : null), document: {querySelectorAll: () => []},
        RV_FAIRY_ONLY: ['crazyhouse', '3check'], RV_FAIRY_ENGINE: 'fairy-stockfish-14-nnue', syncLimitUi() {}, nativeHostAvailable: async () => true});
    vm.runInContext(fnOf('function rvChessVariant() {') + fnOf('function updateEngineOptions() {')
        + rj.slice(ms, me) + '\n        rvModeSync();\n' + rj.slice(is, ie), c);
    ok('REVIEW-4: with crazyhouse saved, a fresh page shows Fairy-Stockfish in Review with', sel.value === 'fairy-stockfish-14-nnue', sel.value);
    ok('...and the stored engine is not overwritten', store.rv_engine === 'sf19-native' && !writes.includes('rv_engine'), [store.rv_engine, writes]);
    vm.runInContext("nativeAvailable = {'sf19-native': true}; updateEngineOptions();", c);   // the host probe lands
    ok('...the re-render after the host probe keeps it', sel.value === 'fairy-stockfish-14-nnue' && !writes.includes('rv_engine'), [sel.value, writes]);
    store.rv_variant = 'chess'; vm.runInContext('rvModeSync()', c);
    ok('...and back on Chess the stored engine shows again', sel.value === 'sf19-native', sel.value);
}
// ---- audit 3.1.329 SYS-1 / ENGINE-4: a screen read keeps the offscreen document open ----
(async () => {
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // The whole offscreen host on a simulated clock, with no engine client (a native/cloud/Remote
    // panel): a recognition that takes 45 s (a first-use model download) must not be closed under.
    const src = fs.readFileSync(ROOT + '/src/offscreen/offscreen.js', 'utf8').replace(/import\(/g, '__imp(');
    let now = 0; const timers = [];
    const tick = () => new Promise(r => setImmediate(r));
    const mk = (fn, ms, iv) => { const t = {at: now + ms, fn, iv}; timers.push(t); return t; };
    const advance = async (ms) => { await tick(); const end = now + ms;
        for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break;
            now = t.at; if (t.iv) t.at += t.iv; else timers.shift(); t.fn(); await tick(); } now = end; await tick(); };
    let listener, closedAt = null; const answers = [];
    const c = {console: {log() {}}, Date: {now: () => now},
        setTimeout: (f, ms) => mk(f, ms, 0), setInterval: (f, ms) => mk(f, ms, ms),
        clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        clearInterval: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        window: {close() { if (closedAt === null) closedAt = now; }},
        __imp: async () => ({recognize: (a) => new Promise(r => mk(() => r({fen: 'x', id: a.id}), a.ms, 0))}),
        chrome: {runtime: {sendMessage: () => {}, onMessage: {addListener: (f) => listener = f}}}};
    vm.createContext(c); vm.runInContext(src, c);
    await advance(10000);
    listener({recognizeBoard: {id: 1, ms: 45000}}, {}, (r) => answers.push(r));
    await advance(40000);                                  // 50 s after load, the read still going
    ok('SYS-1: no close while a screen read is in flight past the 30 s idle mark', closedAt === null, closedAt);
    await advance(10000);
    ok('...the read answers', answers.length === 1 && answers[0].id === 1, answers);
    // Follow Screen: a read every 500 ms for a minute keeps it open throughout
    for (let i = 0; i < 120; i++) { listener({recognizeBoard: {id: 2, ms: 200}}, {}, (r) => answers.push(r)); await advance(500); }
    ok('...a minute of back-to-back reads keeps it open', closedAt === null && answers.length === 121, [closedAt, answers.length]);
    const last = now;
    await advance(31000);
    ok('...and it still closes 30 s after the last read ends', closedAt !== null && closedAt - last >= 29000 && closedAt - last <= 30500, [closedAt, last]);
})().catch(e => { fails++; console.log('FAIL SYS-1 offscreen checks threw: ' + (e && e.stack || e)); });
// ---- audit 3.1.329 ENGINE-2: a stop charged during a load is not written off at readyok ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function on_engine_response(message) {');
    const head = psrc.slice(i, psrc.indexOf('last_info_at = Date.now();   // the panel is HEARING', i));
    const a = psrc.indexOf('chrome.runtime.onMessage.addListener((msg) => {\n    if (!PANEL_BOOTED || !msg || !msg.fromOffscreen) return;');
    const lsn = psrc.slice(a, psrc.indexOf('\n});\n', a) + 4);
    const run = (frames, opts) => {
        let now = 0;
        const c = vm.createContext({console: {log() {}, warn() {}}, Date: {now: () => now}, setNow: (t) => { now = t; }});
        vm.runInContext(`var pending_stops = 0, stop_charged_at = 0, search_active = false, last_info_at = 0, one_pass_owed = 0, passed = [];
            var engine_loading_since = 0, listener = null; const ENGINE_LOAD_GRACE_MS = 60000;
            const STOP_FLUSH_MS = 1500, PANEL_BOOTED = true, ENGINE_CLIENT = '7';
            function maia2_client() { return '7:m2'; } function bench_client() { return '7:bn'; }
            function is_remote() { return false; } function is_one_pass() { return ${!!opts.onePass}; } function note_unsupported_variant() {}
            function download_progress_text() { return null; } function update_best_move() {} function on_engine_error() {}
            const chrome = {runtime: {onMessage: {addListener: (f) => { listener = f; }}}};
            ${head} passed.push(message); }
            ${lsn}
            function abandon() { if (search_active) { pending_stops++; stop_charged_at = Date.now(); } search_active = false; }
            function go() { search_active = true; if (is_one_pass()) one_pass_owed++; }`, c);
        vm.runInContext(opts.load ? 'engine_loading_since = Date.now(); go();' : 'go();', c);   // (load starts,) go A
        c.setNow(200); vm.runInContext('abandon(); go();', c);                            // re-search: stop + go A2 queued
        for (const [t, f] of frames) { c.setNow(t); vm.runInContext('listener', c)(Object.assign({fromOffscreen: true, clientId: '7'}, f)); }
        return vm.runInContext('passed', c);
    };
    const L = (line) => ({kind: 'line', line});
    // a Maia adapter answers isready inside the flush, so readyok reaches the panel before 'ready'
    const sync = run([[3000, L('readyok')], [3001, {kind: 'ready'}], [3010, L('info depth 1 score cp 0 nodes 1 pv a2a3')],
                      [3011, L('bestmove a2a3')], [3200, L('info depth 1 score cp 30 nodes 1 pv e2e4')], [3201, L('bestmove e2e4')]],
                     {load: true, onePass: true});
    ok('ENGINE-2: readyok 2.8 s after a stop charged mid-load does not write the stop off; the stopped bestmove is eaten',
       JSON.stringify(sync) === JSON.stringify(['info depth 1 score cp 30 nodes 1 pv e2e4', 'bestmove e2e4']), sync);
    // a WASM Stockfish: 'ready' first, readyok only after a slow ucinewgame (hash clear)
    const slow = run([[3000, {kind: 'ready'}], [5000, L('readyok')], [5010, L('info depth 1 nodes 0')],
                      [5011, L('bestmove a2a3')], [5400, L('info depth 9 nodes 90000')], [5401, L('bestmove e2e4')]], {load: true});
    ok('...and a readyok that comes 2 s after ready does not either',
       JSON.stringify(slow) === JSON.stringify(['info depth 9 nodes 90000', 'bestmove e2e4']), slow);
    // no load: a stop that will never be flushed is still written off on time
    const dead = run([[2000, L('info depth 3 nodes 900')], [2001, L('bestmove d2d4')]], {load: false});
    ok('...while a stop owed with no load running is still written off after STOP_FLUSH_MS',
       JSON.stringify(dead) === JSON.stringify(['info depth 3 nodes 900', 'bestmove d2d4']), dead);
}
// ---- audit 3.1.329 ENGINE-3: a page-read Maia-2 opponent rating stays in its own panel ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = psrc.indexOf('function set_maia2_oppo('), b = psrc.indexOf('\n}\n', a) + 3;
    // Two panels sharing one config store. The other panel's live-config listener adopts a stored
    // maia2_oppo_elo, abandons and re-asks its page, whose push carries ITS opponent's rating.
    const store = {}, writes = [], panels = [];
    const mkPanel = (name, pageRating) => {
        const p = {name, pageRating, abandons: 0, sent: []};
        p.c = vm.createContext({config: {engine: 'maia2', maia2_oppo_elo: 1500}, PANEL_ROOT: null, last_eval: {fen: 'x'},
            MephistoConfig: {set: (k, v) => { if (store[k] === v) return; store[k] = v; writes.push([name, v]); queue.push([name, k, v]); }},
            send_engine_uci: (l) => p.sent.push(l), abandon_search: () => { p.abandons++; }, push_config() {}});
        vm.runInContext(psrc.slice(a, b), p.c);
        p.pagePush = () => vm.runInContext(`set_maia2_oppo(${pageRating}, false)`, p.c);
        panels.push(p); return p;
    };
    const queue = [];
    const A = mkPanel('A', 1600), B = mkPanel('B', 2000);
    A.pagePush(); B.pagePush();
    for (let i = 0; queue.length && i < 50; i++) {
        const [from, k, v] = queue.shift();
        for (const p of panels) if (p.name !== from) {
            vm.runInContext(`config.${k} = ${JSON.parse(v)}`, p.c); p.abandons++; p.pagePush();   // adopt, abandon, re-ask the page
        }
    }
    ok('ENGINE-3: two Maia-2 panels with different page ratings write nothing to the shared store and stop re-searching',
       writes.length === 0 && queue.length === 0 && A.abandons === 1 && B.abandons === 1, {writes: writes.length, A: A.abandons, B: B.abandons});
    ok('...each panel keeps its own opponent\'s rating and tells its net',
       vm.runInContext('config.maia2_oppo_elo', A.c) === 1600 && vm.runInContext('config.maia2_oppo_elo', B.c) === 2000
       && A.sent.join() === 'setoption name OppoElo value 1600' && B.sent.join() === 'setoption name OppoElo value 2000', [A.sent, B.sent]);
    vm.runInContext('set_maia2_oppo(1750)', A.c);   // typed into the box
    ok('...a rating typed into the box is still stored', store.maia2_oppo_elo === '1750', store);
    ok('...the page path passes store=false and the box path stores',
       /response\.oppRating > 0\) set_maia2_oppo\(response\.oppRating, false\);/.test(psrc)
       && /box\.addEventListener\('change', \(\) => set_maia2_oppo\(parseInt\(box\.value\) \|\| 1500\)\);/.test(psrc));
}
// ---- audit 3.1.329 PLAY-2 / ENGINE-5: Maia-2 answers in the order asked; a premove reply must be legal where it was meant ----
(async () => {
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // The adapter itself, run with its nets stubbed: the opening (Maia-3) net takes 60 ms to load,
    // the Maia-2 session answers at once.
    const m2 = fs.readFileSync(ROOT + '/src/offscreen/maia2.js', 'utf8')
        .replace(/^import .*$/gm, '').replace(/^export /gm, '').replace("import('/src/offscreen/maia3.js')", '__imp()');
    const files = 'abcdefgh', all = [];
    for (let a = 0; a < 64; a++) for (let b = 0; b < 64; b++) all.push(files[a % 8] + (a / 8 + 1 | 0) + files[b % 8] + (b / 8 + 1 | 0));
    const c = vm.createContext({console: {log() {}}, setTimeout, Promise, TextDecoder, Float32Array, Float64Array, BigInt64Array, BigInt,
        fetchModel: async (dir, file) => new TextEncoder().encode(file.endsWith('.json') ? JSON.stringify({moves: all, elo_dict: {}}) : 'x'),
        readyEnv: async () => {},
        ort: {Tensor: function () {}, InferenceSession: {create: async () => ({run: async () => ({logits_maia: {data: new Float32Array(all.length)}, logits_value: {data: [0]}})})}},
        __imp: () => new Promise(r => setTimeout(() => r({createMaia3Engine: async (listen) => ({
            uci: (l) => { if (l === 'go') setTimeout(() => listen('bestmove h7h6'), 5); }, terminate() {}})}), 60))});
    c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(m2, c);
    const heard = [];
    const eng = await vm.runInContext('createMaia2Engine', c)((l) => heard.push(l), 1500, 1500);
    eng.uci('position fen r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 5');   // ply 9: Maia-3's
    eng.uci('go');
    eng.uci('position fen r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 6 6');   // ply 10: Maia-2's
    eng.uci('go');
    await new Promise(r => setTimeout(r, 150));
    const best = heard.filter(l => /^bestmove/.test(l));
    ok('PLAY-2: an opening go still loading its net is answered before the ply-10 go asked after it',
       best.length === 2 && best[0] === 'bestmove h7h6' && best[1] !== 'bestmove h7h6', best);
    const legal10 = (u) => { try { vm.runInContext(`new Chess('chess', 'r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 6 6').move(${JSON.stringify(u)})`, c); return true; } catch (e) { return false; } };
    ok('...and the ply-10 answer is for the position set before ITS go', legal10((best[1] || '').split(' ')[1]), best);
    // premove_is_safe: a reply illegal after every opponent move is not "bound to the prediction"
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const ss = psrc.indexOf('function premove_is_safe'), se = psrc.indexOf('\n}', ss) + 2;
    const sc = vm.createContext({}); sc.self = sc;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), sc);
    vm.runInContext("var config = {variant: 'chess'};" + psrc.slice(ss, se), sc);
    const safe = (fen, pred, reply) => vm.runInContext(`premove_is_safe(${JSON.stringify(fen)}, ${JSON.stringify(pred)}, ${JSON.stringify(reply)})`, sc);
    ok('PLAY-2: a reply legal after no opponent move at all (another position\'s answer) is not safe',
       safe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'e7e5', 'g1g5') === false);
    ok('...a bound reply still is (the en-passant capture after a forced double step)',
       safe('k7/p2p4/8/4P3/8/8/7K/1R5B b - - 0 1', 'd7d5', 'e5d6') === true);
    ok('...a failed :m2 load drops the client, so the kick/answer count starts over',
       /if \(msg\.clientId === maia2_client\(\)\) \{ if \(msg\.kind === 'line'\) maia2_on_line\(msg\.line\); else if \(msg\.kind === 'error'\) maia2_dispose\(\); return; \}/.test(psrc));
})().catch(e => { fails++; console.log('FAIL PLAY-2 checks threw: ' + (e && e.stack || e)); });
// ---- audit 3.1.329 PAGE-1: switching the debugger capture off detaches a tab only the capture used ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const fn = (name) => { const i = b.indexOf(`function ${name}(tabId) {`); return b.slice(i, b.indexOf('\n}\n', i) + 3); };
    const cmds = [], detached = [];
    const c = vm.createContext({puzzleNetTabs: new Set([7, 8]), attached: new Set([7, 8]), cdpInputTabs: new Set([8]), lastPos: new Map(),
        chrome: {runtime: {}, debugger: {sendCommand: (t, m) => cmds.push([t.tabId, m]), detach: (t) => detached.push(t.tabId)}}});
    vm.runInContext(fn('puzzleNetStop') + fn('puzzleNetDetach'), c);
    vm.runInContext('puzzleNetStop(7); puzzleNetStop(8)', c);
    ok('PAGE-1: a tab only the capture attached is detached when the capture stops', detached.join() === '7' && !c.attached.has(7), detached);
    ok('PAGE-1: a tab Autoplay clicked in keeps its attachment with Network off', c.attached.has(8) && JSON.stringify(cmds) === '[[8,"Network.disable"]]' && c.puzzleNetTabs.size === 0, cmds);
    const click = b.slice(b.indexOf('function cdpClick('), b.indexOf('function cdpClick(') + 300);
    const drag = b.slice(b.indexOf('function cdpDrag('), b.indexOf('function cdpDrag(') + 300);
    ok('PAGE-1: cdpClick, cdpDrag and cdpWarm mark the tab as used by Autoplay; a detach clears the mark',
       /cdpInputTabs\.add\(tabId\)/.test(click) && /cdpInputTabs\.add\(tabId\)/.test(drag)
       && /if \(msg\.cdpWarm\) \{[\s\S]{0,600}?cdpInputTabs\.add\(tabId\);\s*cdpAttach\(tabId\)/.test(b)
       && /onDetach\?\.addListener\(\(src\) => \{\s*if \(src\.tabId\) \{[^\n]*cdpInputTabs\.delete\(src\.tabId\)/.test(b));
}
// ---- audit 3.1.329 SYS-4: a puzzle tab already in the set still gets Network.enable ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const i = b.indexOf('async function puzzleNetEnable(tabId) {'), j = b.indexOf('\n}\n', i) + 3;
    const cmds = [];
    const c = vm.createContext({puzzleNetTabs: new Set([7]), cdpAttach: async () => {},
        chrome: {runtime: {}, debugger: {sendCommand: (t, m, p, cb) => { cmds.push([t.tabId, m]); cb(); }}}});
    vm.runInContext(b.slice(i, j), c);
    vm.runInContext('puzzleNetEnable(7)', c).then(() => {
        ok('SYS-4: a tab the restart reconciliation adopted is sent Network.enable on the next puzzle load',
           JSON.stringify(cmds) === '[[7,"Network.enable"]]' && c.puzzleNetTabs.has(7), cmds);
    });
    ok('SYS-4: the restart reconciliation adopts puzzle tabs only while the capture is wanted',
       /getTargets\(async \(targets\) => \{[\s\S]{0,300}?if \(!\(await puzzleNetWanted\(\)\)\) return;\s*for \(const t of ours\) if \(PUZZLE_PAGE_URL\(t\.url \|\| ''\)\) puzzleNetTabs\.add\(t\.tabId\);/.test(b));
}
// ---- audit 3.1.329 PAGE-2: the puzzle probe is registered for the puzzle routes only ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = b.indexOf("const PUZ_PROBE_ID = 'pz';"), e = b.indexOf('\nsyncPuzProbe();\n', a);
    const calls = [];
    const mk = (existing) => {
        calls.length = 0;
        const c = vm.createContext({console, chrome: {
            storage: {local: {get: async () => ({puzzle_capture: 'true'})}},
            scripting: {getRegisteredContentScripts: async () => existing,
                registerContentScripts: async (x) => calls.push(['register', x[0].matches]),
                updateContentScripts: async (x) => calls.push(['update', x[0].matches]),
                unregisterContentScripts: async () => calls.push(['unregister'])}}});
        vm.runInContext(b.slice(a, e).replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), c);
        return c;
    };
    // Chrome match pattern -> RegExp: scheme *, exact host, path glob.
    const toRe = (p) => { const m = p.match(/^\*:\/\/([^/]+)(\/.*)$/); return new RegExp('^https?://' + m[1].replace(/\./g, '\\.') + m[2].replace(/[.?+]/g, '\\$&').replace(/\*/g, '.*') + '$'); };
    const i = cs.indexOf('function isPuzzlePage() {'), j = cs.indexOf('\n}\n', i) + 3;
    const isPuz = (url) => { const u = new URL(url); const c = vm.createContext({site: /lichess/.test(u.host) ? 'lichess' : 'chesscom', location: {pathname: u.pathname}}); vm.runInContext(cs.slice(i, j), c); return vm.runInContext('isPuzzlePage()', c); };
    const urls = ['https://lichess.org/training', 'https://lichess.org/training/mateIn2', 'https://lichess.org/storm', 'https://lichess.org/racer/abcd',
        'https://lichess.org/streak', 'https://www.chess.com/puzzles/rated', 'https://www.chess.com/puzzles/rush', 'https://chess.com/puzzles',
        'https://www.chess.com/lessons/practice/foo', 'https://www.chess.com/daily-chess-puzzle', 'https://www.chess.com/daily',
        'https://lichess.org/abcdEFGH', 'https://lichess.org/', 'https://lichess.org/tv', 'https://www.chess.com/game/live/123456789',
        'https://www.chess.com/game/daily/123', 'https://www.chess.com/play/online', 'https://www.chess.com/home'];
    (async () => {
        let c = mk([]);
        await vm.runInContext('syncPuzProbe()', c);
        const m = calls[0] && calls[0][1] || [];
        const res = (url) => m.some(p => toRe(p).test(url));
        const wrong = urls.filter(u => res(u) !== isPuz(u));
        ok('PAGE-2: a fresh registration matches exactly the pages isPuzzlePage() calls puzzle pages (no game page)',
           calls.length === 1 && calls[0][0] === 'register' && wrong.length === 0 && !res('https://www.chess.com/game/live/123456789'), wrong);
        c = mk([{id: 'pz', matches: ['*://lichess.org/*', '*://www.chess.com/*', '*://chess.com/*']}]);
        await vm.runInContext('syncPuzProbe()', c);
        ok('PAGE-2: an older whole-site registration is narrowed in place', calls.length === 1 && calls[0][0] === 'update' && calls[0][1].length === m.length, calls);
        c = mk([{id: 'pz', matches: [...m].reverse()}]);
        await vm.runInContext('syncPuzProbe()', c);
        ok('PAGE-2: an up-to-date registration is left alone', calls.length === 0, calls);
    })();
}
// ---- audit 3.1.329 PAGE-3: the scrape-storm trace line carries the route shape, never the game id ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const ps = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = cs.indexOf('function scrapeStorming() {'), j = cs.indexOf('\n}\n', i) + 3;
    const pa = ps.indexOf('const DIAG_ROUTE_WORDS'), pb = ps.indexOf('\n}\n', ps.indexOf('function diagnostics_path_shape(')) + 3;
    const logged = [];
    const c = vm.createContext({Date, location: {pathname: '/game/live/123456789'}, site: 'chesscom',
        bgLogAlways: (...a) => logged.push(a), scrapeThrottledUntil: 0, scrapeTimes: [], scrapeThrottleReported: false,
        SCRAPE_BURST_MAX: 2, SCRAPE_COOLDOWN_MS: 1000});
    vm.runInContext(ps.slice(pa, pb).replace(/^const /, 'var ') + cs.slice(i, j), c);
    for (let k = 0; k < 4; k++) vm.runInContext('scrapeStorming()', c);
    const line = JSON.stringify(logged);
    ok('PAGE-3: a scrape storm on a game page logs the route shape, not the game id',
       logged.length === 1 && logged[0][1].path === '/game/live/<id>' && !/123456789/.test(line), logged);
}
// ---- audit 3.1.329 PAGE-4: no trace line keeps the extension id ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const i = b.indexOf('function traceLineBody('), j = b.indexOf('\n}\n', i) + 3;
    const c = vm.createContext({});
    if (i >= 0) vm.runInContext(b.slice(i, j), c);
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    const line = i < 0 ? '' : c.traceLineBody('panel', ['PANEL THREW', {on: 'fen', error: 'x is undefined',
        at: `at on_new_pos (chrome-extension://${id}/src/popup/popup.js:5702:5) | at chrome-extension://${id}/src/popup/popup.js:13597:20`}]);
    ok('PAGE-4: a PANEL THREW stack keeps file, line and column but loses the extension id',
       line.startsWith('panel | PANEL THREW {') && !line.includes(id) && !line.includes('chrome-extension://') && line.includes('src/popup/popup.js:5702:5'), line);
    ok('PAGE-4: the bgTrace branch builds its ring line through traceLineBody',
       /if \(msg\.bgTrace\) \{[\s\S]{0,300}?const body = traceLineBody\(msg\.bgTrace\.from, msg\.bgTrace\.args\);/.test(b));
}
// ---- audit 3.1.329 PAGE-5: paste, input and composition events from a panel input stop at the panel root ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = cs.indexOf('function getOverlayRoot()'), b = cs.indexOf('// look up one of our overlay nodes', a);
    const handlers = {};
    const root = {activeElement: null, addEventListener: (t, f) => { (handlers[t] ||= []).push(f); }};
    const c = vm.createContext({overlayRoot: null, overlayHost: null,
        document: {createElement: () => ({isConnected: true, attachShadow: () => root}), body: {appendChild() {}}}});
    vm.runInContext(cs.slice(a, b) + '; getOverlayRoot();', c);
    const fire = (type, focused) => { root.activeElement = focused; let stopped = false; for (const f of handlers[type] || []) f({stopPropagation: () => { stopped = true; }}); return stopped; };
    const types = ['beforeinput', 'input', 'paste', 'cut', 'copy', 'compositionstart', 'compositionupdate', 'compositionend'];
    const leaked = types.filter(t => !fire(t, {tagName: 'INPUT'}));
    ok('PAGE-5: text, clipboard and composition events from a focused panel input stop at the root', leaked.length === 0, leaked);
    ok('PAGE-5: ...and pass when nothing editable in the panel has focus', types.every(t => !fire(t, {tagName: 'BUTTON'}) && !fire(t, null)));
}
// ---- audit 3.1.329 PAGE-6: the clipboard fallback never writes into the site's DOM ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const a = src.indexOf('async function copy_text(text) {'), b = src.indexOf('\n}\n', a) + 3;
    const run = async (inPage, panelOpen) => {
        const site = [], shadow = [];
        const mkHost = (log) => ({activeElement: null, appendChild: (n) => { log.push(n.value); n.remove = () => {}; }});
        const document = {createElement: () => ({style: {}, focus() {}, select() {}}), execCommand: () => true, activeElement: null};
        document.body = mkHost(site);
        const c = vm.createContext({document, navigator: {clipboard: {writeText: async () => { throw new Error('denied'); }}},
            IS_CONTENT_SCRIPT: inPage});
        c.PANEL_ROOT = panelOpen ? mkHost(shadow) : document;
        vm.runInContext(src.slice(a, b), c);
        const okd = await c.copy_text('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        return {okd, site, shadow};
    };
    (async () => {
        const inPage = await run(true, true), noRoot = await run(true, false), popup = await run(false, false);
        ok('PAGE-6: in-page the fallback textarea goes into the panel root, never the site body',
           inPage.okd === true && inPage.site.length === 0 && inPage.shadow.length === 1, inPage);
        ok('PAGE-6: in-page with no panel root the fallback is skipped', noRoot.okd === false && noRoot.site.length === 0, noRoot);
        ok('PAGE-6: the toolbar popup still falls back on its own document', popup.okd === true && popup.site.length === 1, popup);
    })();
}
// ---- audit 3.1.329 SYS-5: an extension page never reads back a key chrome.storage no longer has ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const mk = (getImpl) => {
        const ls = new Map([['search_mode_before_depth_only', '"time"'], ['search_mode', '"time"']]);
        const listeners = [];
        const c = {console, location: {protocol: 'chrome-extension:'}, navigator: {},
            localStorage: {getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k),
                get length() { return ls.size; }, key: i => [...ls.keys()][i]},
            chrome: {storage: {local: {get: getImpl, set: async () => {}, remove: async () => {}},
                onChanged: {addListener: f => listeners.push(f)}}}};
        c.self = c;
        vm.createContext(c);
        vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/config-store.js', 'utf8'), c);
        return {c, listeners};
    };
    (async () => {
        // The memo was in chrome.storage when this page loaded (and mirrored to localStorage); the
        // panel then removed it from chrome.storage only, and the user set Budget to Nodes.
        const {c, listeners} = mk(async () => ({__cfg_migrated: '1', search_mode: '"time"', search_mode_before_depth_only: '"time"'}));
        await c.MephistoConfig.ready;
        for (const f of listeners) f({search_mode_before_depth_only: {oldValue: '"time"'}, search_mode: {oldValue: '"time"', newValue: '"nodes"'}}, 'local');
        ok('SYS-5: a memo removed elsewhere is gone in the options page too', c.MephistoConfig.get('search_mode_before_depth_only') === null,
           c.MephistoConfig.get('search_mode_before_depth_only'));
        ok('SYS-5: an engine switch in Settings keeps Budget at Nodes', c.MephistoConfig.applyEngineBudgetRule('stockfish-19-nnue') === 'nodes'
           && c.MephistoConfig.get('search_mode') === '"nodes"');
        // chrome.storage unreadable: the old localStorage backend is still the fallback
        const bad = mk(async () => { throw new Error('no storage'); });
        await bad.c.MephistoConfig.ready;
        ok('SYS-5: with chrome.storage unreadable the localStorage fallback still answers', bad.c.MephistoConfig.get('search_mode') === '"time"');
    })();
}
// ---- audit 3.1.329 NATIVE-1 (= CLICK-1 = SYS-2): the HTTP Remote Engine never gets the hour-long rail, and nodes reach it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // the real budget lines of on_new_pos's remote branch, from the Analysis Limit read to the cap
    const a = psrc.indexOf('        const limit = open_ended ? analysis_limit_value('), b = psrc.indexOf('        const posKey = ', a);
    const lim = psrc.indexOf('const ANALYSIS_LIMIT_MAX'), lime = psrc.indexOf('\n}\n', psrc.indexOf('function analysis_limit_value(', lim)) + 3;
    const nm = (psrc.match(/const (NATIVE_MAX_RT|REMOTE_HTTP_MAX_RT) = \d+;/g) || []).join(' ');   // the caps the lines below read
    const c = vm.createContext({});
    vm.runInContext(`var config = {}; const NATIVE_ENGINES = ['sf18-native', 'rodent-native'];
        function uses_native() { return NATIVE_ENGINES.includes(config.engine); }
        ${nm} ${psrc.slice(lim, lime)}
        function budget(open_ended, movetime, want_multipv) { ${psrc.slice(a, b)} return {rt, limit_nodes, limit_depth}; }`, c);
    const run = (cfg, open_ended, movetime = 300, mpv = 1) => {
        c.config = Object.assign({analysis_limit_mode: 'time', analysis_limit: 61}, cfg);
        vm.runInContext('config = this.config', c);
        return vm.runInContext(`budget(${open_ended}, ${movetime}, ${mpv})`, c);
    };
    ok('HTTP remote, Autoplay off / Help / Manual (open-ended), no limit: searches the move budget, not 3600000',
       run({engine: 'remote'}, true).rt === 300, run({engine: 'remote'}, true));
    ok('...with an Analysis Limit in time, that limit', run({engine: 'remote', analysis_limit: 10}, true, 300).rt === 10000);
    const n = run({engine: 'remote', analysis_limit_mode: 'nodes', analysis_limit: 1}, true);
    ok('...with an Analysis Limit in nodes, the nodes are worked out for the request', n.limit_nodes === 1000000, n);
    ok('a native host on the same rail keeps its streamed, capped budget (NATIVE_MAX_RT)',
       run({engine: 'sf18-native'}, true).rt === vm.runInContext('NATIVE_MAX_RT', c));
    ok('the HTTP remote with Autoplay on our turn is unchanged: the move budget', run({engine: 'remote'}, false, 1200).rt === 1200);
    // the HTTP request itself carries `nodes` (remote-engine.py reads it: nodes > depth > time)
    const r = psrc.indexOf('async function request_remote_analysis('), re = psrc.indexOf('\n}\n', r) + 3;
    const rc = vm.createContext({posted: []});
    vm.runInContext(`var config = {engine: 'remote'};
        function uses_native() { return false; } function uses_cloud() { return false; }
        async function call_backend(url, data) { posted.push([url, data]); return {}; }
        function parse_backend_json(x) { return x; }
        ${psrc.slice(r, re)}`, rc);
    (async () => {
        await vm.runInContext(`request_remote_analysis('startfen', 25000, 'e2e4', null, 2000000)`, rc);
        const [url, body] = rc.posted[0] || [];
        ok('NATIVE-1: the Remote Engine /analyse request sends the Analysis Limit nodes',
           url === 'http://localhost:9090/analyse' && body.nodes === 2000000 && body.time === 25000 && body.moves === 'e2e4', body);
    })().catch(e => { fails++; console.log('FAIL NATIVE-1 request check threw: ' + (e && e.stack || e)); });
}
// ---- audit 3.1.329 ENGINE-1 (= CLICK-2): no Remote Engine fetch outlives Chrome's 30 s worker fetch limit ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const bsrc = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    // 1. the budget: the real lines of on_new_pos's remote branch
    const a = psrc.indexOf('        const limit = open_ended ? analysis_limit_value('), b = psrc.indexOf('        const posKey = ', a);
    const lim = psrc.indexOf('const ANALYSIS_LIMIT_MAX'), lime = psrc.indexOf('\n}\n', psrc.indexOf('function analysis_limit_value(', lim)) + 3;
    const consts = (psrc.match(/const (NATIVE_MAX_RT|REMOTE_HTTP_MAX_RT) = \d+;/g) || []).join(' ');
    const c = vm.createContext({});
    vm.runInContext(`var config = {}; const NATIVE_ENGINES = ['sf18-native'];
        function uses_native() { return NATIVE_ENGINES.includes(config.engine); }
        ${consts} ${psrc.slice(lim, lime)}
        function budget(open_ended, movetime, want_multipv) { ${psrc.slice(a, b)} return rt; }`, c);
    const rt = (cfg, open_ended, movetime = 300) => {
        c.config = Object.assign({analysis_limit_mode: 'time', analysis_limit: 61}, cfg);
        return vm.runInContext(`budget(${open_ended}, ${movetime}, 1)`, c);
    };
    const all = [rt({engine: 'remote', analysis_limit: 60}, true), rt({engine: 'remote', analysis_limit: 31}, true),
                 rt({engine: 'remote', analysis_limit_mode: 'nodes', analysis_limit: 30}, true),
                 rt({engine: 'remote', analysis_limit_mode: 'depth', analysis_limit: 40}, true),
                 rt({engine: 'remote'}, false, 45000), rt({engine: 'remote'}, true, 45000)];
    ok('HTTP remote: every request is asked for at most 25 s (time limit 60/31 s, nodes, depth, a 45 s paced think)',
       all.every(v => v === 25000), all);
    ok('...a short one is left alone', rt({engine: 'remote', analysis_limit: 10}, true) === 10000 && rt({engine: 'remote'}, false, 1200) === 1200);
    ok('...and a native host (which streams, over a Port) keeps its own minute for a typed limit',
       rt({engine: 'sf18-native', analysis_limit: 60}, true) === 60000);
    // 2. the worker relay times out on a server that holds the request, before Chrome would end the worker
    const w = bsrc.indexOf('if (msg.backendFetch)'), we = bsrc.indexOf('return true;\n  }', w) + 16;
    const body = bsrc.slice(w, we).replace(/const BACKEND_TIMEOUT_MS = \d+;/, 'const BACKEND_TIMEOUT_MS = 300;');
    const http = require('http');
    const held = [];
    const server = http.createServer((req, res) => { held.push(res); }).listen(0, '127.0.0.1');
    const panel = vm.createContext({sent: [], answer: null, TypeError, Error, console});
    panel.self = panel;
    vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8'), panel);
    panel.MephistoI18n.setFallback(JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/en.json', 'utf8')));
    const e1 = psrc.indexOf('const err_line = '), e2 = psrc.indexOf('\n};\n', psrc.indexOf('const err_fail = ', e1)) + 4;
    const cb = psrc.indexOf('async function call_backend('), cbe = psrc.indexOf('\n}\n', cb) + 3;
    vm.runInContext(`var chrome = {runtime: {sendMessage: async m => { sent.push(m); return answer; }}};` + psrc.slice(e1, e2) + psrc.slice(cb, cbe), panel);
    server.on('listening', () => (async () => {
        const port = server.address().port;
        // the relay only takes its four URLs: point the 9090 /analyse entry at the held server
        const wb = body.replace("'http://localhost:9090/analyse'", `'http://127.0.0.1:${port}/analyse'`);
        const wc = vm.createContext({fetch, AbortSignal, TypeError, String, JSON});
        vm.runInContext(`function handle(msg) { return new Promise(res => { const sendResponse = res; (() => { ${wb} })(); }); }`, wc);
        const t0 = Date.now();
        const r = await Promise.race([
            vm.runInContext(`handle({backendFetch: {url: 'http://127.0.0.1:${port}/analyse', data: {fen: 'f', time: 25000}}})`, wc),
            new Promise(res => setTimeout(() => res('no answer after 3 s'), 3000))]);
        ok('worker: a backend that holds the request is answered with timedOut, not left open', r && r.timedOut === true && r.unreachable === false && Date.now() - t0 < 2500, r);
        // 3. the panel turns that into a coded, translated line instead of Chrome's raw text
        panel.answer = r && typeof r === 'object' ? r : {timedOut: true, ms: 28000, error: 'x'};
        let err; try { await vm.runInContext(`call_backend('http://localhost:9090/analyse', {})`, panel); } catch (e) { err = e; }
        const line = err && vm.runInContext('err_code_line', panel)(err);
        ok('panel: a timed-out relay is MPH-E09 naming remote-engine.py',
           err && err.code === 'MPH-E09' && /^MPH-E09: remote-engine\.py did not answer within \d+ seconds/.test(line || ''), [err && err.message, line]);
    })().catch(e => { fails++; console.log('FAIL ENGINE-1 relay checks threw: ' + (e && e.stack || e)); })
        .finally(() => { held.forEach(res => res.destroy()); server.close(); server.closeAllConnections?.(); }));
}
// ---- NATIVE-3 (audit 3.1.329): an update zip is refused over an install with other engine glue ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const upSrc = fs.readFileSync(ROOT + '/src/scripts/updater.js', 'utf8');
    const c = vm.createContext({console, TextDecoder, TextEncoder, DataView, Uint8Array, Blob, Response, Set, JSON, Promise,
        chrome: {runtime: {getManifest: () => ({name: 'Mephisto Chess Extension', version: '1.0.0'})}, storage: {local: {get: async () => ({}), set: async () => {}}}}});
    c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/src/i18n/i18n.js', 'utf8'), c);
    vm.runInContext(upSrc.replace('const MephistoUpdater =', 'var MephistoUpdater =').replace(/\nif \(typeof module[\s\S]*$/, ''), c);
    const U = vm.runInContext('MephistoUpdater', c);
    const enc = (s) => new TextEncoder().encode(s);
    const glueFile = U._GLUE;
    const shipped = glueFile && fs.existsSync(ROOT + '/' + glueFile) ? fs.readFileSync(ROOT + '/' + glueFile, 'utf8').trim() : '';
    const files = (id) => [{path: 'manifest.json', bytes: enc('{}')}].concat(id === null ? [] : [{path: glueFile, bytes: enc(id + '\n')}]);
    const thrown = (f) => { try { f(); return null; } catch (e) { return e; } };
    ok('NATIVE-3: the glue id ships in src/ (both zips carry it, lib/engine is not in the update zip) and holds a 40-hex hash',
       /^src\//.test(glueFile || '') && /^[0-9a-f]{40}$/.test(shipped), [glueFile, shipped]);
    const skip = thrown(() => U._checkGlue(enc('aaaa\n'), files('bbbb')));
    ok('NATIVE-3: an update built for other glue than the installed one is MPH-U16, naming both ids in the console detail',
       skip && skip.code === 'MPH-U16' && /aaaa/.test(skip.message) && /bbbb/.test(skip.message), skip && skip.message);
    ok('...an update that carries no glue id over an install that has one is refused too',
       (thrown(() => U._checkGlue(enc('aaaa'), files(null))) || {}).code === 'MPH-U16');
    ok('...the same glue passes, whitespace aside', thrown(() => U._checkGlue(enc('aaaa\r\n'), files('aaaa'))) === null);
    ok('...an install from before the glue id has nothing to compare and is let through', thrown(() => U._checkGlue(null, files('bbbb'))) === null);
    const inst = upSrc.slice(upSrc.indexOf('async function install('), upSrc.indexOf('// 1. STAGE.'));
    ok('NATIVE-3: install() checks the glue against the installed folder after reading the archive and before staging anything',
       /const files = await readUpdateArchive\(buf, rel\.latest\);\s*checkGlue\(await readFileAt\(dir, GLUE\), files\);/.test(inst));
    const en = JSON.parse(fs.readFileSync(ROOT + '/src/i18n/locales/en.json', 'utf8'));
    ok('...MPH-U16 is registered and translated', c.MephistoI18n.ERRORS['MPH-U16'] && /full zip/.test(en['err.U16'] || ''));
    const rz = fs.readFileSync(ROOT + '/tools/release/release-zips.sh', 'utf8');
    ok('NATIVE-3: the release script recomputes the glue id from the tree, refuses a stale one, and checks both zips carry the file',
       /GLUE_FILE=src\/offscreen\/engine-glue\.txt/.test(rz) && /GLUE_ID="\$\(git ls-tree -r "\$REF" -- lib\/engine lib\/ort/.test(rz)
       && /git show "\$REF:\$GLUE_FILE"[\s\S]{0,80}= "\$GLUE_ID" \]/.test(rz) && /need=\([^)]*"\$GLUE_FILE"\)/.test(rz));
}
// ---- NATIVE-4 (audit 3.1.329): the native host relaunches a dead engine with the panel's options ----
// (run end to end by killing the engine under a live host; this pins the shape the run checked)
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const host = fs.readFileSync(ROOT + '/native-host/uci-native-host.py', 'utf8');
    const ge = host.slice(host.indexOf('def get_engine'), host.indexOf('def _apply_variant_net'));
    ok('NATIVE-4: get_engine reuses the cached engine only while its process is alive',
       /def _engine_dead\(e\):[\s\S]{0,80}?e\.protocol\.returncode\.done\(\)/.test(host)
       && /if engine is not None and not _engine_dead\(engine\):\s*return engine/.test(ge));
    ok('...a dead one is closed and reopened under the init lock, and gets the panel\'s options back (Threads/Hash first, no 2048 MB detour)',
       /with _engine_init_lock:[\s\S]*?relaunch = engine is not None and _engine_dead\(engine\)[\s\S]*?engine = None[\s\S]*?popen_uci/.test(ge)
       && /engine_options\.get\('Threads', FULL_THREADS\)/.test(ge) && /engine_options\.get\('Hash', FULL_HASH_MB\)/.test(ge)
       && /if relaunch:\s*for key, value in list\(engine_options\.items\(\)\):[\s\S]{0,80}?_apply_option\(key, value\)/.test(ge));
    ok('...and a configure applies its options through the same _apply_option',
       /engine_options\[key\] = value\s*_apply_option\(key, value\)/.test(host) && /def _apply_option\(key, value\):[\s\S]{0,300}?_apply_variant_net/.test(host));
}
// ---- NATIVE-7 (audit 3.1.329): the Fairy net fetch skips exactly the variants the panel refuses natively ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const src = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const decl = src.slice(src.indexOf('const NATIVE_BOARDLESS_VARIANTS'), src.indexOf('};', src.indexOf('const NATIVE_BOARDLESS_VARIANTS')) + 1);
    const panel = Object.keys(vm.runInNewContext('(' + decl.slice(decl.indexOf('{')) + ')')).sort();
    // the fetcher asks python-chess, as the host does; run it when this machine can (python3 + chess)
    const py = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('f', sys.argv[1]); f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
if f.chess is None: print('NOCHESS'); sys.exit(0)
m = json.load(open(sys.argv[2]))
print(json.dumps(sorted(n.split('-', 1)[0] for n, e in m['files'].items() if e['dir'] == f.FAIRY_DIR and not f.native_usable(n)), separators=(',', ':')))`;
    const r = require('child_process').spawnSync('python3', ['-I', '-B', '-c', py, ROOT + '/native-host/fetch-fairy-nets.py', ROOT + '/src/offscreen/engine-assets.json'], {encoding: 'utf8'});
    const out = (r.stdout || '').trim();
    if (r.error || out === 'NOCHESS') console.log('ok   NATIVE-7: skipped (no python3 with python-chess here)');
    else ok('NATIVE-7: the nets the fetcher skips are exactly the variants the panel refuses for the native Fairy (MPH-E08)',
            r.status === 0 && out === JSON.stringify(panel), [out, panel, (r.stderr || '').slice(-200)]);
    ok('...and the four are not empty (a renamed declaration would make this check vacuous)', panel.length === 4, panel);
}
// ---- NATIVE-8 (audit 3.1.329): the Fairy net fetch survives a Python with no CA certificates ----
// (run end to end against a local HTTPS server with an empty CA store; this pins the shape the run checked)
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const f = fs.readFileSync(ROOT + '/native-host/fetch-fairy-nets.py', 'utf8');
    ok('NATIVE-8: every download uses one TLS context that falls back to certifi only when the default store is empty',
       /urllib\.request\.urlopen\(url, timeout=60, context=ctx\)/.test(f) && /ctx, cert_hint = tls_context\(\)/.test(f)
       && /cert_store_stats\(\)\.get\('x509_ca', 0\)/.test(f) && /create_default_context\(cafile=certifi\.where\(\)\)/.test(f));
    ok('...a certificate failure names Install Certificates.command when the store is empty, and stops after the first net',
       /Install Certificates\.command/.test(f) && /if cert_failure\(ex\):[\s\S]{0,120}?print\(cert_hint\)[\s\S]{0,80}?break/.test(f));
}
// ---- NATIVE-6 (audit 3.1.329): the Windows recipe gives the native Fairy its nets ----
{
const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const readme = fs.readFileSync(ROOT + '/README.md', 'utf8');
    const win = readme.slice(readme.indexOf('**Windows** - native messaging'), readme.indexOf('The installer registers the host for every'));
    ok('NATIVE-6: the Windows recipe runs fetch-fairy-nets.py and names the folder in fairy-native.nnue-dir, the file the host reads',
       /fetch-fairy-nets\.py src\\offscreen\\engine-assets\.json/.test(win) && /fairy-native\.nnue-dir/.test(win)
       && /_read_sibling\(f'\{_SLUG\}\.nnue-dir'\)/.test(fs.readFileSync(ROOT + '/native-host/uci-native-host.py', 'utf8')));
    const f = fs.readFileSync(ROOT + '/native-host/fetch-fairy-nets.py', 'utf8');
    ok('...the fetcher creates a missing folder and refuses the extension\'s own net folder (it would prune the WASM Fairy\'s nets)',
       /os\.makedirs\(dest, exist_ok=True\)/.test(f) && /os\.path\.samefile\(dest, own\)[\s\S]{0,200}?return 1/.test(f)
       && f.indexOf('os.makedirs(dest, exist_ok=True)') < f.indexOf('os.listdir(dest)'));
}
// ---- audit 3.1.329 X2-1: the debugger capture and the probe use the puzzle routes isPuzzlePage() does ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const b = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const cs = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = b.indexOf("const PUZ_PROBE_ID = 'pz';"), e = b.indexOf('\nlet puzProbeChain', a);
    const c = vm.createContext({URL});
    try { vm.runInContext(b.slice(a, e) + ';this.page = PUZZLE_PAGE_URL; this.M = PUZ_PROBE_MATCHES;', c); } catch (err) { console.log('slice threw: ' + err.message); }
    const toRe = (p) => { const m = p.match(/^\*:\/\/([^/]+)(\/.*)$/); return new RegExp('^https?://' + m[1].replace(/\./g, '\\.') + m[2].replace(/[.?+]/g, '\\$&').replace(/\*/g, '.*') + '$'); };
    const i = cs.indexOf('function isPuzzlePage() {'), j = cs.indexOf('\n}\n', i) + 3;
    const isPuz = (url) => { const u = new URL(url); const x = vm.createContext({site: /lichess/.test(u.host) ? 'lichess' : 'chesscom', location: {pathname: u.pathname}}); vm.runInContext(cs.slice(i, j), x); return vm.runInContext('isPuzzlePage()', x); };
    const urls = ['https://lichess.org/training', 'https://lichess.org/training/mateIn2', 'https://lichess.org/storm', 'https://lichess.org/racer/abcd',
        'https://lichess.org/streak', 'https://lichess.org/streak?x=1', 'https://www.chess.com/puzzles/rated', 'https://www.chess.com/puzzles/rush', 'https://chess.com/puzzles',
        'https://www.chess.com/lessons/practice/foo', 'https://www.chess.com/daily-chess-puzzle', 'https://www.chess.com/daily', 'https://www.chess.com/daily/2026-11-04',
        'https://lichess.org/abcdEFGH', 'https://lichess.org/', 'https://lichess.org/tv', 'https://www.chess.com/game/live/123456789',
        'https://www.chess.com/game/daily/123', 'https://www.chess.com/play/online', 'https://www.chess.com/home',
        'https://www.chess.com/member/someone/puzzles', 'https://www.chess.com/stats/puzzles/someone', 'https://lichess.org/abcd?from=/training'];
    const page = (u) => { try { return c.page(u); } catch (err) { return 'threw'; } };
    const wrongPage = urls.filter(u => page(u) !== isPuz(u));
    ok('X2-1: the capture\'s puzzle-page test agrees with isPuzzlePage() (Puzzle Streak and the Daily Puzzle included, no game page)',
       wrongPage.length === 0 && page('https://lichess.org/streak') === true && page('https://www.chess.com/daily') === true, wrongPage);
    const M = c.M || [];
    const wrongProbe = urls.filter(u => M.some(p => toRe(p).test(u)) !== isPuz(u));
    ok('X2-1: ...and so does the probe registration, from the same table', M.length > 0 && wrongProbe.length === 0, wrongProbe);
    ok('X2-1: not a page URL is not a puzzle page', page('') === false && page('chrome://extensions') === false && page('https://lichess.org.evil.test/training') === false);
}
// ---- audit 3.1.329 X2-2: off lichess a Chess960 start is filed only under a page that names one game ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const cut = (from, to) => { const a = s.indexOf(from), b = s.indexOf(to, a); return (a < 0 || b < 0) ? '' : s.slice(a, b); };
    const lru = fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8');
    const back = 'NRKBBQRN';
    let board = 'b*****';   // a chess.com scrape of a 960 start, h-file first
    for (const F of 'hgfedcba') for (const r of [8, 7, 2, 1]) {
        const pc = r === 8 ? back['abcdefgh'.indexOf(F)].toLowerCase() : r === 7 ? 'p' : r === 2 ? 'P' : back['abcdefgh'.indexOf(F)];
        board += `${pc === pc.toUpperCase() ? 'w' : 'b'}-${pc.toLowerCase()}-${F}${r}*****`;
    }
    let saved = [];   // the site's stored cache, shared by every document
    // one document of the page at `path`: what the 960 var scrape would start from
    const doc = (path, capture) => {
        const c = vm.createContext({Date, site: 'chesscom', location: {pathname: path, search: '', href: 'https://www.chess.com' + path},
            siteValues: {cache: saved}, saveSiteValue: (k, v) => { saved = v; }, isChesscomVariants: () => false, scrapePositionPuz: () => board});
        try {
            vm.runInContext(lru + ';\n' + cut('const DEFAULT_POSITION =', '\n\n') + cut('function loadStartPosCache()', '// --- GRIND MODE')
                + ';startPosCache = loadStartPosCache();', c);
            if (capture) vm.runInContext('capture960Start()', c);
            return vm.runInContext('chess960Start(puzBoard(readStartPos(startPosKey())?.position)) || seen960Start || null', c);
        } catch (e) { return 'threw ' + e.message; }
    };
    const start = doc('/play/online', true);
    ok('X2-2: at move 0 on a page hosting many games the start is used in this document', typeof start === 'string' && start.startsWith('w*****b-n-a8'), start);
    ok('X2-2: ...but a later document there (the next game, joined after move 0) does not inherit it', doc('/play/online', false) === null, doc('/play/online', false));
    saved = [{key: 'https://www.chess.com/play/online', value: {position: start, timestamp: 1}}];
    ok('X2-2: ...nor a start an older version filed under that href', doc('/play/online', false) === null);
    saved = [];
    doc('/game/live/123456', true);
    ok('X2-2: a game page files its start and a reload of THAT game reads it back', doc('/game/live/123456', false) === start);
    ok('X2-2: ...another game page does not', doc('/game/live/987654', false) === null);
    ok('X2-2: variants game pages name one game too', doc('/variants/chess960/game/4567', true) === start && doc('/variants/chess960/game/4567', false) === start
       && doc('/variants/chess960', false) === null);
}
// ---- X1-1: a PGN's [Variant "Chess960"] tag (a quiet variant change) still names the engine swap ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const an = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (a, b) => { const i = an.indexOf(a), j = an.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return an.slice(i, j); };
    const el = {textContent: '', className: ''};
    const conf = {};
    const c = vm.createContext({el, conf, loadLine: ['Loaded 12 moves.']});
    vm.runInContext(`const $ = (id) => (id === 'an_status' ? el : null);
        const cfg = (k) => conf[k]; const setCfg = (k, v) => { conf[k] = v; }; const anVariant = () => conf.an_variant;
        const ENGINES = [{id: 'sf18-native', label: 'Stockfish 18 (native)', kind: 'native'}, {id: 'stockfish-18-nnue', label: 'Stockfish 18', kind: 'wasm'},
                         {id: 'fairy-stockfish-14-nnue', label: 'Fairy-Stockfish', kind: 'wasm'}];
        const FAIRY_ONLY = ['crazyhouse']; const FAIRY_ENGINE = 'fairy-stockfish-14-nnue';
        function syncBandRow() {} function reloadEngine() {} function reloadEngine2() {}
        function loadFromInput() { status(...loadLine); }
        ${cut('function status(', '\n}\n')}
        }
        ${cut('const NATIVE_960_WASM', 'let engineChain')}
        ${cut('function onVariantChange(', '// One box takes either')}`, c);
    Object.assign(conf, {an_variant: 'fischerandom', an_engine: 'sf18-native', an_engine2: ''});
    c.onVariantChange(true);
    ok('X1-1: a quiet change to Chess960 (PGN tag) with a native engine still shows the swap note before the load line',
       el.textContent === 'Stockfish 18 (native) cannot castle in Chess960; using Stockfish 18 here. Loaded 12 moves.', el.textContent);
    Object.assign(conf, {an_variant: 'crazyhouse', an_engine: 'stockfish-18-nnue'});
    c.onVariantChange(true);
    ok('...a quiet Fairy switch stays quiet (the Engine select itself shows Fairy-Stockfish)',
       el.textContent === 'Loaded 12 moves.' && conf.an_engine === 'fairy-stockfish-14-nnue', [el.textContent, conf.an_engine]);
}
// ---- X1-2: a crazyhouse FEN with a promoted-piece mark (Q~) loads as a FEN, and the mark is kept ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (a, b) => { const i = aj.indexOf(a), j = aj.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return aj.slice(i, j); };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    c.box = {value: ''};
    c.st = [];
    let res = null;
    try {
        vm.runInContext(`const Core = self.MephistoReviewCore; let nodeSeq = 0, treeRoot = null, treeNode = null, cursor = 0;
            const anVariant = () => 'crazyhouse'; const $ = (id) => (id === 'an_pgn' ? box : null); function status(t, k) { st.push([t, k]); }
            const evalCache = new Map(), evalCache2 = new Map(), humanCache = new Map(), bandCache = new Map();
            function relinkLine() {} function buildBoard() {} function renderMoves() {} function renderPockets() {} function go() {}
            function setCfg() {} function onVariantChange() {} const PGN_VARIANTS = {crazyhouse: 'crazyhouse'};
            ${cut('function threeCheckCounts', '// crazyhouse only')}
            ${cut('function mkNode', '// the flat view')}
            ${cut('function loadFromInput', '// The line as it stands')}`, c);
        const fen = 'r1bqkbnr/pppp1ppp/2n1p3/3Q~4/8/8/PPPP1PPP/RNB1KBNR[Nn] b KQkq - 0 1';
        const load = (text) => { c.st.length = 0; c.box.value = text; vm.runInContext('treeRoot = null; loadFromInput()', c); return vm.runInContext('treeRoot', c); };
        const fr = load(fen);
        const fenRes = {status: c.st[0]?.[0], fen: fr?.fen, promoted: fr?.promoted, holdings: fr?.holdings};
        const pr = load(`[Variant "Crazyhouse"]\n[SetUp "1"]\n[FEN "${fen}"]\n\n1... exd5 *`);
        res = {fenRes, pgnRoot: pr?.promoted, afterCapture: pr?.children[0]?.holdings};
    } catch (e) { res = {err: String(e.message || e)}; }
    ok('X1-2: the FEN box takes a crazyhouse FEN with "Q~": loaded as a position, the mark lifted onto the node, the placement intact',
       JSON.stringify(res?.fenRes) === JSON.stringify({status: 'Position loaded.', fen: 'r1bqkbnr/pppp1ppp/2n1p3/3Q4/8/8/PPPP1PPP/RNB1KBNR b KQkq - 0 1',
           promoted: 'd5', holdings: {w: 'n', b: 'n'}}), res);
    ok('...the same FEN in a PGN [FEN] tag keeps the mark, and capturing the promoted queen pockets a pawn',
       res?.pgnRoot === 'd5' && JSON.stringify(res?.afterCapture) === JSON.stringify({w: 'n', b: 'np'}), res);
}
// ---- X1-3: disposing a native engine settles the analyse in flight (rejects, as the WASM engine does) ----
(async () => {
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    // a port that, like Chrome's, does NOT fire its own onDisconnect when this end disconnects
    const port = {posted: [], onMessage: {addListener() {}}, onDisconnect: {addListener() {}},
                  postMessage(m) { this.posted.push(m); }, disconnect() {}};
    const c = {console, self: {MephistoReviewCore: {MATE_CP: 100000}}, chrome: {runtime: {connect: () => port}},
               setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 50)), clearTimeout, setInterval, clearInterval, Promise};
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/util/engines.js', 'utf8'), c);
    const eng = new c.self.MephistoEngines.NativeEngine('stockfish18-native#options', {multipv: 1, threads: 1, hash: 16, limitKind: 'time', limitValue: 300});
    eng.port = port;   // connected; start()'s configure is not under test
    const verdict = eng.analyse('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'w')
        .then(() => 'resolved', (e) => 'rejected: ' + e.message);
    eng.dispose();
    const got = await Promise.race([verdict, new Promise(r => setTimeout(() => r('still pending'), 300))]);
    ok('X1-3: NativeEngine.dispose rejects the analyse it was waiting on ("engine disposed"), instead of leaving it pending forever',
       got === 'rejected: engine disposed', got);
})().catch(e => { fails++; console.log('FAIL X1-3 check threw: ' + (e && e.stack || e)); });
// ---- X1-4: a four-player run turns Export and Fit off with the old report, as the two-player lane does ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const rj = fs.readFileSync(ROOT + '/src/options/pages/review/review.js', 'utf8');
    const a = rj.indexOf('async function onRun() {'), b = rj.indexOf('\n}\n', a) + 3;
    const els = {};
    const c = vm.createContext({console, Promise, Error, String, seen: null,
        $: (id) => (els[id] = els[id] || {disabled: false, value: '', classList: {add() {}, remove() {}}}),
        cfg: (k) => (k === 'rv_variant' ? '4pc' : false), note() {},
        run4pcReview: () => { c.seen = {report: vm.runInContext('report', c), exp: els.rv_export.disabled, fit: els.rv_fit.disabled}; }});
    els.rv_export = {disabled: false, classList: {add() {}, remove() {}}};   // a two-player report is on screen: Export is live
    els.rv_fit = {disabled: false, classList: {add() {}, remove() {}}};
    vm.runInContext('var running = false, cancel = false, is4pcGame = true, batchInputText = "", report = {game: "A"}, batchReports = null;\n'
        + 'var games = [{id: 1}];\n' + rj.slice(a, b), c);
    vm.runInContext('onRun()', c).then(() => {
        ok('X1-4: a four-player run starts with no report and Export and Fit off (a click there did nothing)',
           c.seen && c.seen.report === null && c.seen.exp === true && c.seen.fit === true, c.seen);
    });
}
// ---- X1-5: a Manual Mode change (panel switch or Settings page) clears the 4PC dedupe, so the held position is played ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    // the gate this depends on: Manual Mode holds the 4PC automove
    ok('X1-5: the 4PC automove is gated on Manual Mode', /if \(ours && config\.autoplay && !config\.help_mode && !config\.manual_mode\) request_automove_4pc\(best\);/.test(s));
    const i = s.indexOf('function watch_config_changes() {');
    const c = vm.createContext({JSON, console: {log() {}, warn() {}}, listener: null,
        chrome: {storage: {onChanged: {addListener(f) { c.listener = f; }}}}});
    vm.runInContext(`var config_watch_on = false, PANEL_BOOTED = true, resync_after_config_change = false, fen_request_inflight = false, setup_fen = null;
        var config = {manual_mode: true}, last_eval = {fen: 'X'}, fourpc_last = 'FEN4';
        const LIVE_CONFIG_KEYS = ['manual_mode'];
        function panel_reload() {} function reload_after_reset() {} function request_clear_hint() {} function abandon_search() {}
        function sync_quick_settings() {} function keep_alive() {} function keep_alive_wanted() { return false; }
        function push_config() {} function request_fen() {} function on_new_pos() {}
        ${s.slice(i, s.indexOf('\n}\n', i) + 3)}
        watch_config_changes();`, c);
    c.listener({manual_mode: {newValue: 'false', oldValue: 'true'}}, 'local');
    ok('X1-5: Manual Mode switched off on the Settings page clears the 4PC dedupe', vm.runInContext('fourpc_last', c) === '', vm.runInContext('fourpc_last', c));
    // the panel's own switch: the same key list in the quick-settings change handler
    ok('...and the panel\'s Manual Mode switch does too',
       /if \(key === 'autoplay' \|\| key === 'help_mode' \|\| key === 'manual_mode'\) fourpc_last = '';/.test(s));
}
// ---- audit 3.1.329 X2-3: the in-document Chess960 capture is dropped when the page moves to another game ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const cut = (from, to) => { const a = s.indexOf(from), b = s.indexOf(to, a); return (a < 0 || b < 0) ? '' : s.slice(a, b); };
    const lru = fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8');
    // the real var-scrape 960 branch, run as one scrape
    const branch = cut("if (config.variant === 'fischerandom') {", "\n        const moves = getMoveRecords();");
    const board = (back) => {
        let out = 'b*****';
        for (const F of 'hgfedcba') for (const r of [8, 7, 2, 1]) {
            const k = back['abcdefgh'.indexOf(F)];
            const pc = r === 8 ? k.toLowerCase() : r === 7 ? 'p' : r === 2 ? 'P' : k;
            out += `${pc === pc.toUpperCase() ? 'w' : 'b'}-${pc.toLowerCase()}-${F}${r}*****`;
        }
        return out;
    };
    const c = vm.createContext({Date, site: 'chesscom', config: {variant: 'fischerandom'}, location: {pathname: '/', search: '', href: ''},
        siteValues: {cache: []}, saveSiteValue: () => {}, isChesscomVariants: () => false, moves: [], cur: '',
        getMoveRecords: () => c.moves, scrapePositionPuz: () => c.cur});
    try {
        vm.runInContext(lru + ';\n' + cut('const DEFAULT_POSITION =', '\n\n') + cut('function loadStartPosCache()', '// --- GRIND MODE')
            + ';startPosCache = loadStartPosCache();\nthis.scrape = () => { let res; ' + branch + ' return res; };', c);
    } catch (e) { console.log('slice threw: ' + e.message); }
    const go = (path, moves, back) => {
        c.location.pathname = path; c.location.href = 'https://www.chess.com' + path;
        c.moves = moves ? ['m'] : []; if (back) c.cur = board(back);
        try { return c.scrape().split('&*****')[0]; } catch (e) { return 'threw ' + e.message; }
    };
    const DP = vm.runInContext('DEFAULT_POSITION', c);
    const A = go('/play/online', false, 'NRKBBQRN');
    ok('X2-3: a lobby capture at move 0 is the start', A.startsWith('w*****b-n-a8*****b-r-b8*****b-k-c8'), A);
    ok('X2-3: ...and survives the URL becoming the game page once the game begins', go('/game/live/111', true) === A);
    ok('X2-3: another game page joined mid-game does not inherit it (no start known: the standard array)', go('/game/live/222', true) === DP, go('/game/live/222', true));
    ok('X2-3: a game page that saw its own move 0 uses its own start', go('/game/live/333', false, 'BQNRKRNB') !== A && go('/game/live/333', true).startsWith('w*****b-b-a8*****b-q-b8'));
    go('/game/live/333/', true);
    ok('X2-3: a trailing slash is the same game', go('/game/live/333', true).startsWith('w*****b-b-a8*****b-q-b8'));
    ok('X2-3: leaving the game for the lobby drops it: a lobby game joined mid-game is not given it', go('/play/online', true) === DP);
    ok('X2-3: back on a game page that filed its start, that start is read again', go('/game/live/333', true).startsWith('w*****b-b-a8*****b-q-b8'));
}
// ---- X1-6: capturing the last promoted piece leaves no promoted square behind ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (a, b) => { const i = aj.indexOf(a), j = aj.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return aj.slice(i, j); };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    c.box = {value: ''};
    let res = null;
    try {
        vm.runInContext(`const Core = self.MephistoReviewCore; let nodeSeq = 0, treeRoot = null, treeNode = null, cursor = 0;
            const anVariant = () => 'crazyhouse'; const $ = (id) => (id === 'an_pgn' ? box : null); function status() {}
            const evalCache = new Map(), evalCache2 = new Map(), humanCache = new Map(), bandCache = new Map();
            function relinkLine() {} function buildBoard() {} function renderMoves() {} function renderPockets() {} function go() {}
            function setCfg() {} function onVariantChange() {} const PGN_VARIANTS = {crazyhouse: 'crazyhouse'};
            ${cut('function threeCheckCounts', '// crazyhouse only')}
            ${cut('function mkNode', '// the flat view')}
            ${cut('function loadFromInput', '// The line as it stands')}`, c);
        // a promoted queen on d5, taken by the e6 pawn; then the pawn that took it moves on to d4
        c.box.value = '[Variant "Crazyhouse"]\n[SetUp "1"]\n[FEN "r1bqkbnr/pppp1ppp/2n1p3/3Q~4/8/8/PPPP1PPP/RNB1KBNR[Nn] b KQkq - 0 1"]\n\n1... exd5 2. N@c3 d4 *';
        vm.runInContext('loadFromInput()', c);
        const r = vm.runInContext('treeRoot', c);
        res = {root: r.promoted, afterCapture: r.children[0]?.promoted, afterPawnMove: r.children[0]?.children[0]?.children[0]?.promoted};
    } catch (e) { res = {err: String(e.message || e)}; }
    ok('X1-6: once the only promoted piece is captured no square stays marked, and the capturing pawn does not carry a mark on',
       JSON.stringify(res) === JSON.stringify({root: 'd5', afterCapture: '', afterPawnMove: ''}), res);
}
// ---- X1-7: the crazyhouse engine FEN marks promoted pieces (Q~), as Fairy writes and reads them ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const aj = fs.readFileSync(ROOT + '/src/options/pages/analysis/analysis.js', 'utf8');
    const cut = (a, b) => { const i = aj.indexOf(a), j = aj.indexOf(b, i); if (i < 0 || j < 0) throw new Error('slice ' + a); return aj.slice(i, j); };
    const c = {console};
    c.self = c;
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/scripts/classify-core.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/src/options/pages/review/review-core.js', 'utf8'), c);
    c.box = {value: ''};
    let res = null;
    try {
        vm.runInContext(`const Core = self.MephistoReviewCore; let nodeSeq = 0, treeRoot = null, treeNode = null, cursor = 0;
            const anVariant = () => 'crazyhouse'; const $ = (id) => (id === 'an_pgn' ? box : null); function status() {}
            const evalCache = new Map(), evalCache2 = new Map(), humanCache = new Map(), bandCache = new Map();
            function relinkLine() {} function buildBoard() {} function renderMoves() {} function renderPockets() {} function go() {}
            function setCfg() {} function onVariantChange() {} const PGN_VARIANTS = {crazyhouse: 'crazyhouse'};
            ${cut('function threeCheckCounts', '// crazyhouse only')}
            ${cut('function mkNode', '// the flat view')}
            ${cut('function engineFen', 'let engine = null')}
            ${cut('function loadFromInput', '// The line as it stands')}`, c);
        // b7xa8=Q: Fairy-Stockfish 14.0.1 itself answers "Q~6k/8/8/8/8/8/8/K7[R] b - - 0 1" for this line
        c.box.value = '[Variant "Crazyhouse"]\n[SetUp "1"]\n[FEN "r6k/1P6/8/8/8/8/8/K7[] w - - 0 1"]\n\n1. bxa8=Q *';
        vm.runInContext('loadFromInput()', c);
        const promo = vm.runInContext('engineFen(treeRoot.children[0])', c);
        // and a loaded Q~ comes back out with its mark, so Copy FEN round-trips
        const fen = 'r1bqkbnr/pppp1ppp/2n1p3/3Q~4/8/8/PPPP1PPP/RNB1KBNR[Nn] b KQkq - 0 1';
        c.box.value = fen;
        vm.runInContext('loadFromInput()', c);
        res = {promo, roundTrip: vm.runInContext('engineFen(treeRoot)', c) === fen,
               plain: vm.runInContext(`engineFen({fen: '${'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'}', holdings: {w: '', b: ''}, promoted: ''})`, c)};
    } catch (e) { res = {err: String(e.message || e)}; }
    ok('X1-7: after b7xa8=Q the engine FEN is the one Fairy writes for that line, promoted queen marked',
       res?.promo === 'Q~6k/8/8/8/8/8/8/K7[R] b - - 0 1', res);
    ok('...a loaded Q~ FEN comes back out unchanged, and a position with no promoted piece carries no mark',
       res?.roundTrip === true && res?.plain === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1', res);
}
// ---- audit 3.1.329 X3-1: a page naming no game drops the Chess960 capture when the move list empties ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const cut = (from, to) => { const a = s.indexOf(from), b = s.indexOf(to, a); return (a < 0 || b < 0) ? '' : s.slice(a, b); };
    const lru = fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8');
    // the real var-scrape 960 branch, run as one scrape
    const branch = cut("if (config.variant === 'fischerandom') {", "\n        const moves = getMoveRecords();");
    // a chess.com scrape (h-file first) of the start `back`, with an optional [from, to] already moved
    const board = (back, mv) => {
        let out = 'b*****';
        for (const F of 'hgfedcba') for (const r of [8, 7, 2, 1]) {
            const k = back['abcdefgh'.indexOf(F)];
            const pc = r === 8 ? k.toLowerCase() : r === 7 ? 'p' : r === 2 ? 'P' : k;
            const sq = (mv && mv[0] === F + r) ? mv[1] : F + r;
            out += `${pc === pc.toUpperCase() ? 'w' : 'b'}-${pc.toLowerCase()}-${sq}*****`;
        }
        return out;
    };
    const c = vm.createContext({Date, site: 'chesscom', config: {variant: 'fischerandom'}, location: {pathname: '/', search: '', href: ''},
        siteValues: {cache: []}, saveSiteValue: () => {}, isChesscomVariants: () => false, moves: [], cur: '',
        getMoveRecords: () => c.moves, scrapePositionPuz: () => c.cur});
    try {
        vm.runInContext(lru + ';\n' + cut('const DEFAULT_POSITION =', '\n\n') + cut('function loadStartPosCache()', '// --- GRIND MODE')
            + ';startPosCache = loadStartPosCache();\nthis.scrape = () => { let res; ' + branch + ' return res; };', c);
    } catch (e) { console.log('slice threw: ' + e.message); }
    const go = (plies, cur) => {
        c.location.pathname = '/play/computer'; c.location.href = 'https://www.chess.com/play/computer';
        c.moves = Array(plies).fill('m'); if (cur) c.cur = cur;
        try { return c.scrape().split('&*****')[0]; } catch (e) { return 'threw ' + e.message; }
    };
    const DP = vm.runInContext('DEFAULT_POSITION', c);
    const A = go(0, board('NRKBBQRN'));
    ok('X3-1: game 1 on Play Computer: its move-0 board is the start', A.startsWith('w*****b-n-a8*****b-r-b8*****b-k-c8'), A);
    ok('X3-1: ...and stays it through the game', go(1, board('NRKBBQRN', ['e2', 'e4'])) === A && go(30) === A);
    ok('X3-1: a takeback is the same game: the start is kept', go(29) === A && go(27) === A);
    ok('X3-1: game 2 with a premove on its move-0 board: the list emptied, so game 1\'s start is not used',
       go(0, board('BQNRKRNB', ['d2', 'd4'])) === DP, go(0));
    ok('X3-1: ...nor later in game 2', go(1) === DP && go(6) === DP, go(6));
    go(9);
    ok('X3-1: game 3 whose list lags the board (empty while move 1 is on it) gets no borrowed start either',
       go(0, board('RKRNNQBB', ['f2', 'f3'])) === DP && go(2) === DP, go(2));
    ok('X3-1: game 4 seen at move 0 uses its own start, as before', go(0, board('QRKRBBNN')).startsWith('w*****b-q-a8*****b-r-b8')
       && go(4).startsWith('w*****b-q-a8*****b-r-b8'));
    ok('X3-1: a takeback to move 0 re-reads the same start', go(0, board('QRKRBBNN')).startsWith('w*****b-q-a8') && go(1).startsWith('w*****b-q-a8'));
}
// ---- audit 3.1.329 X3-2: a lobby Chess960 capture is filed under the game page the URL becomes ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const cut = (from, to) => { const a = s.indexOf(from), b = s.indexOf(to, a); return (a < 0 || b < 0) ? '' : s.slice(a, b); };
    const lru = fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8');
    // the real var-scrape 960 branch, run as one scrape
    const branch = cut("if (config.variant === 'fischerandom') {", "\n        const moves = getMoveRecords();");
    const board = (back) => {
        let out = 'b*****';
        for (const F of 'hgfedcba') for (const r of [8, 7, 2, 1]) {
            const k = back['abcdefgh'.indexOf(F)];
            const pc = r === 8 ? k.toLowerCase() : r === 7 ? 'p' : r === 2 ? 'P' : k;
            out += `${pc === pc.toUpperCase() ? 'w' : 'b'}-${pc.toLowerCase()}-${F}${r}*****`;
        }
        return out;
    };
    let saved = [];   // the site's stored cache, shared by every document
    // a new document (a page load); doc.go(path, plies, board) is one scrape in it
    const doc = () => {
        const c = vm.createContext({Date, site: 'chesscom', config: {variant: 'fischerandom'}, location: {pathname: '/', search: '', href: ''},
            siteValues: {cache: saved}, saveSiteValue: (k, v) => { saved = v; }, isChesscomVariants: () => false, moves: [], cur: '',
            getMoveRecords: () => c.moves, scrapePositionPuz: () => c.cur});
        try {
            vm.runInContext(lru + ';\n' + cut('const DEFAULT_POSITION =', '\n\n') + cut('function loadStartPosCache()', '// --- GRIND MODE')
                + ';startPosCache = loadStartPosCache();\nthis.scrape = () => { let res; ' + branch + ' return res; };', c);
        } catch (e) { console.log('slice threw: ' + e.message); }
        c.go = (path, plies, back) => {
            c.location.pathname = path; c.location.href = 'https://www.chess.com' + path;
            c.moves = Array(plies).fill('m'); if (back) c.cur = board(back);
            try { return c.scrape().split('&*****')[0]; } catch (e) { return 'threw ' + e.message; }
        };
        return c;
    };
    const d1 = doc();
    const DP = vm.runInContext('DEFAULT_POSITION', d1);
    const A = d1.go('/play/online', 0, 'NRKBBQRN');
    ok('X3-2: a lobby capture at move 0 is the start', A.startsWith('w*****b-n-a8*****b-r-b8*****b-k-c8'), A);
    ok('X3-2: ...and is used once the URL becomes the game page', d1.go('/game/live/123', 1) === A);
    ok('X3-2: a reload of that game reads the lobby capture back', doc().go('/game/live/123', 7) === A, doc().go('/game/live/123', 7));
    ok('X3-2: ...under that game only', doc().go('/game/live/124', 7) === DP);
    // a game page that already holds its own start keeps it
    const d2 = doc();
    const B = d2.go('/game/live/777', 0, 'BQNRKRNB');
    const d3 = doc();
    d3.go('/play/online', 0, 'NRKBBQRN');
    d3.go('/game/live/777', 3);
    ok('X3-2: a start already filed under the game page is not overwritten', doc().go('/game/live/777', 5) === B && B !== A, doc().go('/game/live/777', 5));
    // nothing held: nothing filed
    const d4 = doc();
    d4.go('/play/online', 12, 'NRKBBQRN');
    d4.go('/game/live/555', 13);
    ok('X3-2: a lobby with no capture files nothing', doc().go('/game/live/555', 13) === DP);
    // game page -> game page is not this case (X2-3 drops the capture there)
    const d5 = doc();
    d5.go('/game/live/601', 0, 'RKRNNQBB');
    d5.go('/game/live/602', 4);
    ok('X3-2: one game page to another files nothing', doc().go('/game/live/602', 4) === DP);
    // the lobby's last game ended and the next one opens its game page with its move 0 missed
    const d6 = doc();
    d6.go('/play/online', 0, 'QRKRBBNN');
    d6.go('/play/online', 40);
    d6.cur = board('NRKBBQRN').replace('w-p-e2', 'w-p-e4');   // a premove on the new game's move-0 board
    d6.go('/game/live/701', 0);
    ok('X3-2: a list that emptied with the URL change is a new game: the old game\'s start is not filed under it',
       doc().go('/game/live/701', 2) === DP, doc().go('/game/live/701', 2));
}
// ---- audit 3.1.330 SCRAPEB-1: a set-up start's en-passant square reaches the panel ----
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8'); const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    // the REAL fenToPuzString (content script) feeding the REAL parse_position_from_response (panel)
    const d0 = csrc.indexOf('const DEFAULT_POSITION ='), dEnd = csrc.indexOf(';', d0) + 1, f0 = csrc.indexOf('function fenToPuzString(fen)');
    const cc = vm.createContext({}); vm.runInContext(csrc.slice(d0, dEnd) + '\n' + csrc.slice(f0, csrc.indexOf('\n}\n', f0) + 3), cc);
    const puz = (fen) => vm.runInContext(`fenToPuzString(${JSON.stringify(fen)})`, cc);
    const c = vm.createContext({console}); c.self = c; vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8'), c);
    const a = psrc.indexOf('function apply_page_rights('), p0 = psrc.indexOf('function parse_position_from_response(');
    const i0 = psrc.indexOf('const INITIAL_PLACEMENT =');
    vm.runInContext(`var config = {variant: 'chess'}, fen_cache = new LRU(100), turn = 'w', detected_prefix = null;
        function i18n(k, d) { return d; } function set_detection_status() {}
        ${psrc.slice(i0, psrc.indexOf('\n', i0))}
        ${psrc.slice(a, psrc.indexOf('\n}\n', p0) + 3)}`, c);
    const parse = (start, sans) => { try { return vm.runInContext(`parse_position_from_response(${JSON.stringify('***livar***' + start + '&*****' + sans)}).fen`, c); } catch (e) { return 'threw ' + e.message; } };
    const EP = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
    ok('SCRAPEB-1: a start with an ep square (White to move) reaches the panel with it', parse(puz(EP), '?') === EP, parse(puz(EP), '?'));
    ok('SCRAPEB-1: ...and the ep capture played from it replays instead of failing every scrape',
       parse(puz(EP), 'exf6*****') === 'rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3', parse(puz(EP), 'exf6*****'));
    const EPB = 'rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 2';
    ok('SCRAPEB-1: Black to move with a rank-3 ep square too', parse(puz(EPB), '?') === EPB && /^rnbqkbnr\/pppp1ppp\/8\/8\/8\/3p4\//.test(parse(puz(EPB), 'exd3*****')), parse(puz(EPB), 'exd3*****'));
    ok('SCRAPEB-1: no ep field, or one that contradicts the turn, adds no lm- token',
       !puz('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3').includes('lm-')
       && !puz('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f3 0 3').includes('lm-'));
}
// ---- audit 3.1.330 SCRAPEB-2: move 0 of a lichess From Position game ships the page's stated start ----
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const cut = (from, to) => { const a = csrc.indexOf(from), b = csrc.indexOf(to, a); return (a < 0 || b < 0) ? '' : csrc.slice(a, b); };
    const c = vm.createContext({Date, site: 'lichess', location: {pathname: '/abcd1234', search: '', href: ''}, siteValues: {cache: []}, saveSiteValue: () => {}});
    vm.runInContext(fs.readFileSync(ROOT + '/lib/lru.min.js', 'utf8') + ';\n' + cut('const DEFAULT_POSITION =', '\n\n')
        + cut('function fenToPuzString(fen)', '\n}\n') + '\n}\n' + cut('function loadStartPosCache()', '// --- GRIND MODE') + ';startPosCache = loadStartPosCache();', c);
    const START = '4k3/8/8/8/8/8/4P3/R3K3 b Q - 3 40';
    const start = vm.runInContext(`fenToPuzString(${JSON.stringify(START)})`, c);
    // the piece scrape of that board: turn guessed 'w', pieces in DOM order, no rights or counters
    const scraped = 'w*****w-r-a1*****w-p-e2*****w-k-e1*****b-k-e8*****';
    const on = (s) => { try { return vm.runInContext(`statedStartOnBoard(${JSON.stringify(s)})`, c); } catch (e) { return 'threw ' + e.message; } };
    vm.runInContext(`writeStartPos(startPosKey(), {position: ${JSON.stringify(start)}, timestamp: 1, stated: true})`, c);
    ok('SCRAPEB-2: at move 0 the page-stated start (Black to move, its rights and counters) replaces the piece scrape',
       on(scraped) === start && start.startsWith('b*****') && start.includes('cr-Q*****') && start.includes('mc-3-40*****'), on(scraped));
    ok('SCRAPEB-2: once a piece has moved the piece scrape stands', on('w*****w-r-a1*****w-p-e4*****w-k-e1*****b-k-e8*****') === null
       && on('w*****w-r-a1*****w-p-e2*****w-k-e1*****') === null && on(null) === null);
    vm.runInContext(`writeStartPos(startPosKey(), {position: ${JSON.stringify(start)}, timestamp: 1})`, c);
    ok('SCRAPEB-2: a start filed from a piece scrape (a Storm board, an older entry) is never used', on(scraped) === null);
    ok('SCRAPEB-2: the no-move-list lichess scrape ships it as a var start with no moves, and the page-read starts are marked stated',
       /res = scrapePositionPuz\(\);\s*const stated = \(site === 'lichess'\) \? statedStartOnBoard\(res\) : null;\s*if \(stated\) \{[^}]*prefix \+= 'var\*\*\*';\s*res = stated \+ '&\*\*\*\*\*\?';/.test(csrc)
       && /\{position: fromPage, timestamp: Date\.now\(\), stated: true\}/.test(csrc) && /\{position: atStart, timestamp: Date\.now\(\), stated: true\}/.test(csrc));
}
// ---- audit 3.1.330 SCRAPEB-3: ChessBase Tactics is a puzzle page, so Puzzle Mode (and Auto-Next) stays on there ----
{ const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } }; const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = csrc.indexOf('function isPuzzlePage() {'), j = csrc.indexOf('\n}\n', i) + 3;
    const isPuz = (site, pathname) => { const x = vm.createContext({site, location: {pathname}}); vm.runInContext(csrc.slice(i, j), x); return vm.runInContext('isPuzzlePage()', x); };
    ok('SCRAPEB-3: tactics.chessbase.com is a puzzle page, like BlitzTactics', isPuz('chessbase', '/') === true && isPuz('blitztactics', '/') === true, isPuz('chessbase', '/'));
    ok('SCRAPEB-3: game pages still are not', isPuz('lichess', '/abcd1234') === false && isPuz('chesscom', '/game/live/1') === false && isPuz('taketaketake', '/') === false);
}
// ---- audit 3.1.330 SCRAPEB-4: a BlitzTactics pieces-only scrape ships the last move for the ep right too ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const i = s.indexOf('function scrapePositionPuz()'), j = s.indexOf('\nfunction boardShowsBlack', i);
    const sq = (f, r) => ({style: {transform: `translate(${(f - 1) * 50}px, ${(8 - r) * 50}px)`}});
    const pc = (c, t, f, r) => ({classList: Object.assign([c, t], {contains: () => false}), style: sq(f, r).style});
    let hl = [sq(4, 7), sq(4, 5)], orient = 'white';
    const ctx = vm.createContext({site: 'blitztactics', isAnimating: () => false, animationStalled: () => false,
        getBoard: () => ({getBoundingClientRect: () => ({width: 400})}), getOrientation: () => orient, getTurn: () => 'w',
        getPieces: () => [pc('white', 'king', 5, 1), pc('black', 'king', 5, 8), pc('black', 'pawn', 4, 5), pc('white', 'pawn', 5, 5)],
        getLastMoveHighlights: () => hl, document: {querySelector: () => null}, Math, Number, String});
    vm.runInContext(s.slice(i, j), ctx);
    const r1 = vm.runInContext('scrapePositionPuz()', ctx);
    ok('SCRAPEB-4: BlitzTactics, d7-d5 just played (.move-from/.move-to) ships lm-d7d5', /lm-d7d5\*{5}$/.test(r1), r1);
    hl = [sq(4, 5), sq(4, 4)];
    const r2 = vm.runInContext('scrapePositionPuz()', ctx);
    ok('SCRAPEB-4: ...a highlight whose destination is empty ships none', !/lm-/.test(r2), r2);
    // drawn from Black's side the same screen squares name the mirrored board squares (pieces too)
    orient = 'black'; hl = [sq(4, 7), sq(4, 5)];
    const r3 = vm.runInContext('scrapePositionPuz()', ctx);
    ok('SCRAPEB-4: ...and on a board drawn from Black\'s side the squares follow the orientation', /lm-e2e4\*{5}$/.test(r3) && /b-p-e4/.test(r3), r3);
}
// ---- audit 3.1.330 PLAYA-1: no blind premove in Crazyhouse, where chess.js lists no drops ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const cut = (a, b) => { const i = psrc.indexOf(a), j = psrc.indexOf(b, i); return i < 0 || j < 0 ? '' : psrc.slice(i, j); };
    const c = vm.createContext({}); c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext("var config = {variant: 'crazyhouse', premove_confidence: 14}; var premove_tracker = {fen: ''};"
        + cut('// Premove certification window.', 'function premove_reply_playable')
        + cut('function premove_is_safe', '\n// Don\'t wait for the opponent'), c);
    const run = (variant, expr) => vm.runInContext(`config.variant = ${JSON.stringify(variant)}; ${expr}`, c);
    // black is in check from a8 with one king step on the board, but a knight in hand could block on b8-g8
    const zh = 'R6k/6p1/8/8/8/8/8/K7[n] b - - 0 1', std = 'R6k/6p1/8/8/8/8/8/K7 b - - 0 1';
    ok('PLAYA-1: the check a drop could block is not "forced" for premove_is_safe in Crazyhouse',
       run('crazyhouse', `premove_is_safe(${JSON.stringify(zh)}, 'h8h7', 'a8a7')`) === false);
    ok('...the same board in standard chess still is', run('chess', `premove_is_safe(${JSON.stringify(std)}, 'h8h7', 'a8a7')`) === true);
    const line = JSON.stringify({pred: 'h8h7', reply: 'a8a7', depth: 13});
    ok('PLAYA-1: the only-legal-move bypass does not certify a shallow pair in Crazyhouse',
       run('crazyhouse', `premove_tracker.fen = ${JSON.stringify(zh)}; premove_certified(${line})`) === false);
    ok('...and still does in standard chess', run('chess', `premove_tracker.fen = ${JSON.stringify(std)}; premove_certified(${line})`) === true);
    // Qxb2+ (a capture) leaves Kxb2 as a true recapture; Qb2+ (no capture) leaves it as the lone board move
    const hr = (variant, fen) => run(variant, `premove_human_reflex(${JSON.stringify(fen)}, 'c2b2', 'a1b2')`);
    ok('PLAYA-1: a lone board reply is not a "forced" human reflex in Crazyhouse',
       hr('crazyhouse', '7k/8/8/8/8/8/2q5/K7 b - - 0 1') === false, hr('crazyhouse', '7k/8/8/8/8/8/2q5/K7 b - - 0 1'));
    ok('...it still is in standard chess', hr('chess', '7k/8/8/8/8/8/2q5/K7 b - - 0 1') === true);
    ok('...and a true recapture still is in Crazyhouse', hr('crazyhouse', '7k/8/8/8/8/8/1Pq5/K7 b - - 0 1') === true);
}
// ---- audit 3.1.330 PLAYA-2: a premove reply yields to the tablebase and the books ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fn = (name) => { const i = psrc.indexOf('function ' + name + '('); return i < 0 ? '' : psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const c = vm.createContext({console: {log() {}, warn() {}}}); c.self = c;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), c);
    vm.runInContext(`var config, premove_tracker, last_eval, premove_lines = 1, explorer_out_of_book = false, own_book = null,
        own_book_absent = false, player_book = null, detected_prefix = 'lc', sent = [];
        const PLAYER_BOOK_MIN = 2, TABLEBASE_MAX_MEN = 7, TABLEBASE_VARIANTS = ['chess', 'atomic', 'antichess'];
        var our_side = () => 'white', premove_certified = () => true, premove_is_safe = () => true,
            premove_human_reflex = () => true, request_automove = (m) => sent.push(m), request_double_premove = () => {},
            forced_premove_moves = () => [];`
        + ['premove_yields_to_book', 'premove_instant_reply', 'maybe_premove_forced_reply', 'tablebase_enabled',
           'piece_count', 'explorer_enabled', 'player_book_at'].map(fn).join('\n'), c);
    // white to reply after black's predicted Kg7: six men on the board
    const before = '6k1/8/8/8/8/8/5PPP/6K1 b - - 0 1', pred = 'g8g7', reply = 'h2h4';
    const set = (cfg, extra = '') => vm.runInContext(`config = Object.assign({premove: true, autoplay: true, variant: 'chess'}, ${JSON.stringify(cfg)});
        premove_tracker = {fen: ${JSON.stringify(before)}, moves: 'a b', lines: [{pred: '${pred}', reply: '${reply}'}], premoved: false};
        last_eval = {fen: ${JSON.stringify(before)}}; explorer_out_of_book = false; own_book = null; own_book_absent = false;
        player_book = null; sent = []; ${extra}`, c);
    const after = vm.runInContext(`(() => { const x = new Chess('chess', ${JSON.stringify(before)}); x.move('Kg7'); return x.fen(); })()`, c);
    const instant = () => vm.runInContext(`premove_instant_reply(${JSON.stringify(after)}, 'a b ${pred}')`, c);
    const queued = () => vm.runInContext(`maybe_premove_forced_reply(premove_tracker.lines[0]); sent.slice()`, c);
    set({tablebase: false});
    ok('PLAYA-2: with no book and no tablebase the certified reply still plays at once', instant() === reply, instant());
    set({tablebase: false});
    ok('...and is still queued as a site premove', JSON.stringify(queued()) === JSON.stringify([reply]), queued());
    set({tablebase: true});
    ok('PLAYA-2: Tablebase on at 7 men or fewer: no instant reply', instant() === null, instant());
    set({tablebase: true});
    ok('...and no site premove', queued().length === 0, queued());
    set({book_play: true});
    ok('PLAYA-2: the explorer book still in book holds the reply', instant() === null, instant());
    set({book_play: true}, 'explorer_out_of_book = true');
    ok('...and lets it through once the explorer latched out of book', instant() === reply, instant());
    set({book_play: true}, `explorer_out_of_book = true; own_book = {fen: 'x', moves: [{uci: 'e2e4', weight: 1}]}`);
    ok('PLAYA-2: an imported book that answered with moves holds the reply', instant() === null, instant());
    set({player_book: true}, `explorer_out_of_book = true; player_book = new Map([[${JSON.stringify(after.split(' ').slice(0, 2).join(' '))}, {h2h3: 3}]])`);
    ok('PLAYA-2: a Player Book hit for the position after the prediction holds the reply', instant() === null && queued().length === 0);
}
// ---- audit 3.1.330 PLAYA-5: explorer castling is stored as the engine writes it ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fn = (name) => { const i = psrc.indexOf('function ' + name + '('); return i < 0 ? '' : psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    let answer = null;
    const c = vm.createContext({explorer_enabled: () => true, explorer_out_of_book: false, document: {hidden: false}, console: {warn() {}},
        config: {book_play: true}, explorer_wanted: null, explorer_data: null, explorer_error: null, explorer_empty_streak: 0,
        render_explorer: () => {}, own_book: null, BOOK_MIN_GAMES: 20, BOOK_MAX_LOSS: 40, player_book_pick: () => null, Math,
        chrome: {runtime: {lastError: null, sendMessage: (m, cb) => cb(answer)}}});
    vm.runInContext(fn('request_explorer') + fn('book_pick'), c);
    // the engine's own lines (as engine_line_scores reports them): O-O is its best move
    c.engine_line_scores = () => ({e1g1: 30, d2d3: 20});
    answer = {moves: [{uci: 'e1h1', san: 'O-O', white: 500, draws: 300, black: 200},
                      {uci: 'd2d3', san: 'd3', white: 50, draws: 30, black: 20},
                      {uci: 'h2h1', san: 'Rh1', white: 30, draws: 0, black: 0}]};
    c.request_explorer('R');
    const ucis = (c.explorer_data?.moves || []).map(m => m.uci);
    ok('PLAYA-5: an explorer O-O sent as e1h1 is stored as e1g1', ucis[0] === 'e1g1', ucis);
    ok('...a non-castling move into the corner keeps its uci', ucis[2] === 'h2h1', ucis);
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(vm.runInContext("book_pick('R')", c));
    ok('PLAYA-5: castling now passes the engine veto and can be the book move', seen.has('e1g1'), [...seen]);
    answer = {moves: [{uci: 'e8g8', san: 'O-O', white: 50, draws: 0, black: 0}]};
    c.request_explorer('S');
    ok('...an explorer that already sends e8g8 is left alone', c.explorer_data?.moves?.[0]?.uci === 'e8g8', c.explorer_data);
}
// ---- audit 3.1.330 PLAYA-6: Manual Mode's key plays the tablebase move on a WASM engine too ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fn = (name) => { const i = psrc.indexOf('function ' + name + '('); return i < 0 ? '' : psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const fen = '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1';
    const c = vm.createContext({config: {manual_mode: true}, our_side: () => 'white', premove_reply_playable: () => true,
        tablebase_data: null, tablebase_enabled: () => true, sent: [], last_eval: null});
    c.request_automove = (m) => c.sent.push(m);
    vm.runInContext(fn('manual_play') + fn('tablebase_pick'), c);
    // a WASM Manual Mode search is `go infinite`: lines, no bestmove
    const press = (tb) => {
        c.sent = []; c.last_eval = {fen, lines: [{move: 'e1d2'}]};
        c.tablebase_data = tb ? {fen, moves: [{uci: tb}]} : null;
        c.manual_play(); return c.sent[0];
    };
    ok('PLAYA-6: with a tablebase answer the play-move key plays the tablebase move', press('e1f2') === 'e1f2', press('e1f2'));
    ok('...and without one it still plays the engine\'s top line', press(null) === 'e1d2', press(null));
}
// ---- one declaration per top-level function -------------------------------------------------------
// A port once left request_explorer in popup.js TWICE: the second, older copy won (a later function
// declaration replaces the earlier one), so the 3.1.328 ANALYSIS-9 stale-answer guard in the first
// copy never ran, and a fix patched into the dead copy passed review while the suite went red.
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const files = ['src/popup/popup.js', 'src/scripts/content-script.js', 'src/scripts/background-script.js',
        'src/offscreen/offscreen.js', 'src/options/pages/analysis/analysis.js', 'src/options/pages/review/review.js'];
    for (const f of files) {
        const names = (fs.readFileSync(require('path').join(__dirname, f), 'utf8').match(/^(?:async )?function [A-Za-z0-9_$]+/gm) || [])
            .map(d => d.replace(/^(?:async )?function /, ''));
        const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
        ok(`${f}: no top-level function is declared twice`, dup.length === 0, dup);
    }
}
// ---- audit 3.1.330 SCRAPEA-1: Autoplay never clicks onto a FINISHED chess.com game's board ----
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const s = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const r = s.indexOf('const RESULT_IN_TEXT ='), re = s.indexOf('\n}\n', r) + 3;
    const i = s.indexOf('function moveHeldBack()'), ie = s.indexOf('\n}\n', i) + 3;
    let modal = false;
    const c = vm.createContext({site: 'chesscom', location: {pathname: '/game/live/123'}, CC_GAME_PATH: /^\/(game|play)(\/|$)/,
        isChesscomVariants: () => false, tabActive: () => true, listText: ' 1. e4 e5 2. Nf3 ',
        document: {querySelector: (sel) => (modal && /game-over-modal/.test(sel)) ? {} : null}});
    c.knownMoveContainer = () => ({textContent: c.listText});
    try {
        vm.runInContext('var config = {autoplay: true, background_play: false}, pendingManual = false;'
            + s.slice(r, re) + s.slice(i, ie), c);
    } catch (e) { console.log('slice threw: ' + e.message); }
    const held = (manual = false) => { try { return vm.runInContext(`pendingManual = ${manual}; moveHeldBack()`, c); } catch (e) { return 'threw ' + e.message; } };
    ok('SCRAPEA-1: a live chess.com game with Autoplay on still plays', held() === null, held());
    c.listText = ' 1. e4 e5 2. Nf3 1-0 ';
    ok('SCRAPEA-1: a result in the move list holds the Autoplay click', held() === 'over', held());
    c.listText = ' 1. e4 e5 2. Nf3 '; modal = true;
    ok('SCRAPEA-1: ...and so does the game-over modal', held() === 'over', held());
    ok('SCRAPEA-1: a move asked for by hand still goes', held(true) === null, held(true));
    c.location.pathname = '/analysis/game/live/123';
    ok('SCRAPEA-1: only a /game or /play page is gated', held() === null, held());
    c.location.pathname = '/game/live/123'; c.isChesscomVariants = () => true;
    ok('SCRAPEA-1: ...not the variants boards', held() === null, held());
    c.isChesscomVariants = () => false; c.site = 'lichess';
    ok('SCRAPEA-1: ...nor another site', held() === null, held());
    ok('SCRAPEA-1: the not-clicked trace names a finished game', /held === 'over' \? 'the game is over'/.test(s));
}
// ==== END FIX CHECKS ====

// ==== SUGGEST A HUMAN ERROR ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const sl = (a, b) => psrc.slice(psrc.indexOf(a), psrc.indexOf(b));
    const blocks = sl('// ==== HUMANIZE GUARDS ====', '// ==== END HUMANIZE GUARDS ====') + sl('// ==== HUMANIZE MATCH ====', '// ==== END HUMANIZE MATCH ====')
        + sl('// ==== HUMAN ERROR ====', '// ==== END HUMAN ERROR ====');
    // ---- the chooser, pure
    const g = vm.createContext({}); g.self = g;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), g);
    vm.runInContext(blocks, g);
    const v = (e) => JSON.parse(vm.runInContext(`JSON.stringify(${e})`, g));
    vm.runInContext(`var C = [{move:'a', drop:6, cp:-60}, {move:'b', drop:8, cp:-80}, {move:'c', drop:12, cp:-120}, {move:'d', drop:3, cp:-30}, {move:'e', drop:90, cp:-99900}];
        var P = new Map([['a', 0.004], ['b', 0.3], ['c', 0.1], ['d', 0.9], ['e', 0.5]]);`, g);
    ok('a Maia-weighted error: only moves Maia gives 1%+, drawn by their probability (0.75 / 0.25 here), never the sub-edge d, the sub-1% a or the mate-losing e',
       v('hz_human_error_pick(C, {probs: P, rnd: () => 0}).move') === 'b' && v('hz_human_error_pick(C, {probs: P, rnd: () => 0.99}).move') === 'c'
       && v('hz_human_error_pick(C, {probs: P, rnd: () => 0}).source') === 'maia');
    const draws = v(`(() => { const r = hz_seeded('x'); const n = {}; for (let i = 0; i < 4000; i++) { const m = hz_human_error_pick(C, {probs: P, rnd: r}).move; n[m] = (n[m] || 0) + 1; } return n; })()`);
    ok('...over 4000 seeded draws only b and c come up, b three times as often', Object.keys(draws).sort().join() === 'b,c' && Math.abs(draws.b / 4000 - 0.75) < 0.03, draws);
    ok('...a position where Maia gives every candidate under 1% shows nothing',
       v(`hz_human_error_pick([{move:'a', drop:6, cp:-60}, {move:'x', drop:9, cp:-90}], {probs: new Map([['a', 0.002]])})`) === null);
    ok('...a Maia-natural hang (2%+) is allowed through, a hang Maia does not back is refused',
       v(`hz_human_error_pick([{move:'h', drop:9, cp:-90}], {probs: new Map([['h', 0.05]]), hangsOf: () => true, rnd: () => 0}).move`) === 'h'
       && v(`hz_human_error_pick([{move:'h', drop:9, cp:-90}], {probs: new Map([['h', 0.015]]), hangsOf: () => true, rnd: () => 0})`) === null);
    const kind = "(u) => ({a: 'quiet', b: 'hung', c: 'quiet', d: 'quiet'})[u]";
    ok('without Maia a quiet error beats a hung pawn even when the pawn gives away less; the smallest loss decides inside a kind',
       v(`hz_human_error_pick([{move:'b', drop:5.5, cp:-55}, {move:'c', drop:12, cp:-120}, {move:'a', drop:6, cp:-60}], {typeOf: ${kind}}).move`) === 'a'
       && v(`hz_human_error_pick([{move:'b', drop:5.5, cp:-55}, {move:'c', drop:12, cp:-120}], {typeOf: ${kind}}).move`) === 'c'
       && v(`hz_human_error_pick([{move:'b', drop:5.5, cp:-55}], {typeOf: ${kind}}).source`) === 'engine');
    ok('...a hidden error (looks fine at the shallow depth) comes before a quiet one, and the shallow read is optional',
       v(`hz_human_error_pick([{move:'a', drop:6, cp:-60}, {move:'c', drop:12, cp:-120}], {typeOf: ${kind}, hiddenOf: (u) => u === 'c'}).move`) === 'c'
       && v(`hz_human_error_pick([{move:'a', drop:6, cp:-60}, {move:'c', drop:12, cp:-120}], {typeOf: ${kind}, hiddenOf: null}).move`) === 'a');
    ok('nothing when no line gives away 5% win (4.99 is not an inaccuracy, 5 is), and never a line that loses to mate, with or without Maia',
       v(`hz_human_error_pick([{move:'a', drop:4.99, cp:-50}, {move:'d', drop:0, cp:0}])`) === null
       && v(`hz_human_error_pick([{move:'a', drop:5, cp:-50}]).cls`) === 2
       && v(`hz_human_error_pick([C[4]])`) === null && v(`hz_human_error_pick([C[4]], {probs: P})`) === null && v('hz_human_error_pick([])') === null);
    ok('...a hung minor piece is refused without Maia backing (the guards\' rule); the class and its glyph follow the win% given away',
       v(`hz_human_error_pick([{move:'h', drop:9, cp:-90}], {hangsOf: () => true})`) === null
       && v('[6, 12, 25].map(d => HZ_ERR_MARK[hz_human_error_pick([{move:"a", drop:d, cp:-60}]).cls]).join()') === '?!,?,??'
       && v('HZ_ERR_NAME.slice(2).join()') === 'inaccuracy,mistake,blunder');
    ok('the Maia draw is seeded from the position: the same position always draws the same, another may not',
       v(`(() => { const a = hz_seeded('p1'), b = hz_seeded('p1'), c = hz_seeded('p2'); return [a(), a(), a()].join() === [b(), b(), b()].join() && a() !== c(); })()`));
    { // the real classifier on the real chess.js: a king step that still guards the pawn is quiet, one that walks away hangs it
        const fen = '4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 1';
        ok('...with the real hz_type_classifier: the quiet king move is suggested over the hung pawn',
           v(`hz_human_error_pick([{move:'e1f1', drop:5.5, cp:-55}, {move:'e1e2', drop:6, cp:-60}], {typeOf: hz_type_classifier(Chess, 'chess', ${JSON.stringify(fen)})}).move`) === 'e1e2');
    }
    // ---- the panel half: once per position, waits for the search and for Maia, display only
    const FEN = '4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 1';
    const ec = vm.createContext({}); ec.self = ec;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), ec);
    const fnSrc = (name) => { const i = psrc.indexOf(`function ${name}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    vm.runInContext(`var config = {human_error: true, variant: 'chess', engine: 'sf'}; var turn = 'w'; var last_eval = {fen: '', lines: [], activeLines: 0};
        var ONE_PASS_ENGINES = ['maia']; function our_turn_now() { return true; } var maia = null; function hz_maia_probs() { return maia; }
        var flags = {humanize_maia: false}; function humanize_flag(k, d) { return k in flags ? flags[k] : d; } function effective_multipv() { return 20; }
        var updates = 0, draws = 0; function update_best_move() { updates++; } function draw_moves() { draws++; }
        function user_color(k, d) { return d; } function notate(f, u) { return u; }`, ec);
    vm.runInContext(fnSrc('win_percent') + fnSrc('line_cp_ours') + blocks
        + psrc.slice(psrc.indexOf('const HUMAN_ERROR_MIN_DEPTH'), psrc.indexOf('function human_reply_label()')), ec);
    const e = (x) => vm.runInContext(x, ec);
    const mk = (fen, depth, scores) => e(`last_eval = {fen: ${JSON.stringify(fen)}, activeLines: ${scores.length}, lines: ${JSON.stringify(['d2d4', 'e1e2', 'e1f1'].slice(0, scores.length).map((m, i) => ({move: m, pv: m, score: scores[i], depth})))}}`);
    mk(FEN, 8, [20, -60, -90]); e('refresh_human_error(false)');
    ok('a search still at depth 8 shows nothing and decides nothing', e('human_error_state.done') === false && e('human_error_shown()') === null);
    mk(FEN, 14, [20, -60]); e('last_eval.activeLines = 3'); e('refresh_human_error(false)');
    ok('...a depth-14 frame with fewer lines than the search is delivering does not decide on a partial list', e('human_error_state.done') === false);
    mk(FEN, 14, [20, -60, -90]); e('refresh_human_error(false)');
    ok('...the first complete depth-12+ frame decides: the quiet king move, repainted once',
       e('human_error_shown().move') === 'e1e2' && e('updates') === 1 && e('draws') === 1);
    ok('...labelled as an error with its cost: "Human error: e1e2?! -0.8 (inaccuracy)"',
       /Human error: e1e2\?! -0\.8 \(inaccuracy\)/.test(e('human_error_label()')) && /color:#a0522d/.test(e('human_error_label()')));
    mk(FEN, 20, [20, 10, -60]); e('refresh_human_error(false)'); e('refresh_human_error(true)');
    ok('...and it stays: later frames and the bestmove of the same position do not swap it or repaint', e('human_error_shown().move') === 'e1e2' && e('updates') === 1);
    e('config.human_error = false');
    ok('...switched off it is gone from the label and the board', e('human_error_shown()') === null && e('human_error_label()') === '');
    e('config.human_error = true; last_eval.fen = "4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 2"; flags.humanize_maia = true');
    mk('4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 2', 16, [20, -60, -90]); e('refresh_human_error(false)');
    ok('with a Maia option on, a settled search waits for the net rather than locking an engine-only pick', e('human_error_state.done') === false);
    e('refresh_human_error(true)');
    ok('...the bestmove decides with what there is (engine only)', e('human_error_state.basis') === 'engine' && e('human_error_shown().move') === 'e1e2');
    e("maia = new Map([['e1f1', 0.2], ['e1e2', 0.004]])"); e('refresh_human_error(false)');
    ok('...and when Maia answers late the pick is replaced once by the Maia one, then kept',
       e('human_error_state.basis') === 'maia' && e('human_error_shown().move') === 'e1f1' && e('human_error_shown().source') === 'maia');
    e('refresh_human_error(false)'); e('refresh_human_error(true)');
    ok('...kept', e('human_error_shown().move') === 'e1f1');
    e('maia = null; flags = {humanize_maia: false}; function hz_hidden_of(sh, u) { return sh.get(u) === true; }');
    mk('4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 3', 16, [20, -60, -90]); e("last_eval.shallow = new Map([['e1f1', true]])"); e('refresh_human_error(false)');
    ok('where the build has the shallow read, a hidden error is preferred without Maia', e('human_error_shown().move') === 'e1f1');
    mk('4k3/8/8/8/1b6/8/3P4/4K3 w - - 0 4', 16, [20, 15]); e('refresh_human_error(false)');
    ok('a position whose alternatives lose nothing shows nothing', e('human_error_state.done') === true && e('human_error_shown()') === null);

    // ---- wiring
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const ah = fs.readFileSync(ROOT + '/src/options/pages/settings/appearance/appearance.html', 'utf8');
    const aj = fs.readFileSync(ROOT + '/src/options/pages/settings/appearance/appearance.js', 'utf8');
    const live = psrc.slice(psrc.indexOf('const LIVE_CONFIG_KEYS = ['), psrc.indexOf('];', psrc.indexOf('const LIVE_CONFIG_KEYS = [')));
    ok('Suggest a Human Error is OFF by default (page and panel), has its settings row, and applies live to an open panel',
       /registerFormElement\('human_error', '[^']+:', 'checkbox', false\)/.test(gj) && /id="human_error_checkbox"/.test(gh)
       && /data-i18n-tip="set\.tip\.human_error"/.test(gh) && /data-i18n="set\.human_error"/.test(gh)
       && /human_error: JSON\.parse\(MephistoConfig\.get\('human_error'\)\) \|\| false,/.test(psrc) && /'human_error'/.test(live));
    ok('...its arrow colour is a real family: in ARROW_COLOR_KEYS, with a picker and a default on the Appearance page',
       /ARROW_COLOR_KEYS = \[[^\]]*'arrow_color_human_error'/.test(psrc) && /id="arrow_color_human_error_picker"/.test(ah)
       && /\['arrow_color_human_error', '#a0522d'\]/.test(aj) && /HUMAN_ERROR_COLOR = '#a0522d'/.test(psrc));
    const keys = ['set.human_error', 'set.tip.human_error', 'panel.msg.human_error', 'panel.human_error.inaccuracy', 'panel.human_error.mistake',
                  'panel.human_error.blunder', 'set.arrow_color_human_error', 'set.tip.arrow_color_human_error'];
    const dir = ROOT + '/src/i18n/locales/', files = fs.readdirSync(dir);
    const loc = Object.fromEntries(files.map(f => [f.replace('.json', ''), JSON.parse(fs.readFileSync(dir + f, 'utf8'))]));
    const ph = (x) => (String(x).match(/\{\w+\}/g) || []).sort().join();
    const bad = [];
    for (const [l, d] of Object.entries(loc)) for (const k of keys) {
        if (typeof d[k] !== 'string' || !d[k].trim()) bad.push(`${l}:${k} missing`);
        else if (l !== 'en' && d[k] === loc.en[k] && !/^panel\.human_error\.blunder$/.test(k) || ph(d[k]) !== ph(loc.en[k])) bad.push(`${l}:${k}`);
    }
    ok(`...${keys.length} strings in all ${files.length} locales, translated, placeholders identical to English`, files.length === 14 && !bad.length, bad.join(' '));
    const bodyOf = (name) => { const i = psrc.indexOf(`function ${name}(`); return i < 0 ? null : psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const DISPLAY = /human_error|HZ_ERR_|hz_human_error|hz_seeded/;
    const readers = ['on_engine_best_move', 'humanize_pick', 'request_automove', 'maybe_premove_forced_reply', 'premove_certified', 'premove_reply_playable',
                     'premove_instant_reply', 'playstyle_pick', 'contempt_pick', 'draw_safety_net', 'humanize_target_pick'];
    ok('DISPLAY ONLY: the move paths (autoplay decision, humanize pick, premove, playstyle, contempt, safety net) never mention the suggestion',
       readers.every(n => bodyOf(n) !== null && !DISPLAY.test(bodyOf(n))), readers.filter(n => bodyOf(n) === null || DISPLAY.test(bodyOf(n))));
    const users = new Set();
    for (const m of psrc.matchAll(/human_error_(?:state|shown|compute|label|hidden_of)|refresh_human_error|hz_human_error_pick/g)) {
        const at = psrc.lastIndexOf('\nfunction ', m.index);
        const top = psrc.lastIndexOf('\n}\n', m.index);
        if (at > top) users.add(/function ([\w$]+)/.exec(psrc.slice(at + 1, at + 80))[1]);
        else users.add('<top level>');
    }
    const USERS = '<top level>,draw_moves,human_error_compute,human_error_hidden_of,human_error_label,human_error_shown,hz_human_error_pick,on_engine_response,on_native_info,paint_lines,readout_extras,refresh_human_error,request_humanize_maia';
    ok('...the only code that touches it is the chooser, its panel half (and its state), the repaint hooks, the arrow and the label',
       [...users].sort().join() === USERS, [...users].sort().join());
    ok('...the bestmove hooks run AFTER the move decision, never before it',
       /on_engine_best_move\(last_eval\.bestmove, last_eval\.threat, true\);\n\s*refresh_human_error\(true\);/.test(psrc)
       && /on_engine_best_move\(best, threat, true\);\n\s*refresh_human_error\(true\);/.test(psrc));
    const rq = bodyOf('request_humanize_maia');
    ok('...and it never fetches the Maia net by itself: the request still needs a Maia option already on',
       rq.indexOf("if (!humanize_flag('humanize_maia', HZ_MAIA_DEFAULT) && !humanize_flag('humanize_maia_where', false)) return;") > 0
       && rq.indexOf("if (!humanize_flag('humanize_maia', HZ_MAIA_DEFAULT)") < rq.indexOf('human_once('));
}
// ==== END SUGGEST A HUMAN ERROR ====

// ==== THINK WAKES ON A MOVED BOARD ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = csrc.indexOf('let wakeThink = null;'), b = csrc.indexOf('\n}\n', csrc.indexOf('function thinkWait(')) + 3;
    const c = vm.createContext({setTimeout, clearTimeout});
    vm.runInContext(csrc.slice(a, b).replace('let wakeThink', 'var wakeThink'), c);
    const t0 = Date.now();
    const woken = vm.runInContext('thinkWait(5000)', c);
    vm.runInContext('wakeThink()', c);
    Promise.all([woken, vm.runInContext('thinkWait(5)', c)]).then(([w, run]) => {
        ok('the think wait ends at once when woken (true) and runs out by itself otherwise (false)',
           w === true && run === false && Date.now() - t0 < 1000 && vm.runInContext('wakeThink', c) === null, {w, run, ms: Date.now() - t0});
    });
    ok('...a push during a move wakes the think, and the woken think re-asks the click guard and sleeps on when the board still matches',
       /if \(moving\) \{\s*if \(wakeThink\) wakeThink\(\);/.test(csrc)
       && /while \(await thinkWait\(until - Date\.now\(\)\)\) \{\s*if \(sessionGen !== undefined && sessionGen !== moveGen\) return;[^\n]*\n\s*if \(!is4PC\(\) && pendingForPush && !boardStillMatchesAnalysis\(pendingForPush\)\) return;/.test(csrc)
       && /async function performSimulatedMoveSequence\(\) \{\s*await waitOutThink\(getThinkTime\(\)\);/.test(csrc));
}
// ==== END THINK WAKES ON A MOVED BOARD ====

// ==== PANEL CLICK-THROUGH ONLY UNDER THE PANEL ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const a = csrc.indexOf('function panelCoversPoint('), b = csrc.indexOf('\n}\n', csrc.indexOf('function withPanelClickThrough(')) + 3;
    const el = () => ({style: {pointerEvents: ''}, querySelector() { return this.frame; },
                       getBoundingClientRect: () => ({left: 1000, right: 1400, top: 0, bottom: 500})});
    const run = (body) => {
        const c = vm.createContext({PANEL_OVERLAY_ID: 'p', RESTORE_BADGE_ID: 'b', config: {python_autoplay_backend: false}, badge: null});
        vm.runInContext('var useBackend = () => config.python_autoplay_backend;' + csrc.slice(a, b).replace('let clickThroughDepth', 'var clickThroughDepth'), c);
        c.wrap = el(); c.wrap.frame = {style: {pointerEvents: ''}};
        c.overlayEl = (id) => id === 'p' ? c.wrap : (id === 'b' ? c.badge : null);
        return vm.runInContext(body, c);
    };
    // a click far from the panel never touches it; one under it does, for exactly the click
    run(`const seen = []; withPanelClickThrough(() => seen.push(wrap.style.pointerEvents), [[200, 300]]);
         withPanelClickThrough(() => seen.push(wrap.style.pointerEvents, wrap.frame.style.pointerEvents), [[1200, 300]])
             .then(() => { seen.push(wrap.style.pointerEvents, wrap.frame.style.pointerEvents); return seen.join(','); })`)
        .then(v => ok('a click the panel does not cover leaves it clickable; one under it goes click-through only while in flight', v === ',none,none,,', v));
    // two clicks in flight together, finishing in order: the panel must end clickable
    ok('...two overlapping clicks restore the panel once both are done (no click-through left behind)',
       run(`let r1, r2; const p1 = withPanelClickThrough(() => new Promise(r => r1 = r), [[1200, 50]]);
            const p2 = withPanelClickThrough(() => new Promise(r => r2 = r), [[1300, 60]]);
            r1(); p1.then(() => { const mid = wrap.style.pointerEvents; r2();
                return p2.then(() => [mid, wrap.style.pointerEvents, wrap.frame.style.pointerEvents].join(',')); })`)
           .then(v => ok('...overlap result', v === 'none,,', v)));
    ok('...the python backend (screen pixels) keeps the blanket click-through',
       run(`config.python_autoplay_backend = true; let got; withPanelClickThrough(() => got = wrap.style.pointerEvents, [[5, 5]]); got`) === 'none');
    run(`let r; const pr = withPanelClickThrough(() => new Promise(x => r = x), [[1200, 50]]); badge = {}; r(); pr.then(() => wrap.style.pointerEvents)`)
        .then(v => ok('...a panel minimised mid-click stays click-through', v === 'none', v));
    ok('...the autoplay click passes its own point',
       /return withPanelClickThrough\(\(\) => dispatchSimulateClickInner\(x, y, travelMs\), \[\[x, y\]\]\);/.test(csrc));
    ok('...and an autoplay drag passes both its squares',
       /return withPanelClickThrough\(\(\) => dispatchSimulateDragInner\(x1, y1, x2, y2, travelMs\), \[\[x1, y1\], \[x2, y2\]\]\);/.test(csrc));
}
// ==== END PANEL CLICK-THROUGH ONLY UNDER THE PANEL ====

// ==== EVALS ON YOUR ARROWS ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const csrc = fs.readFileSync(ROOT + '/src/scripts/content-script.js', 'utf8');
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fnOf = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };
    const cc = vm.createContext({});
    vm.runInContext("const USER_ARROW_BRUSHES = new Set(['green', 'red', 'blue', 'yellow']);" + fnOf(csrc, 'parseCgHash'), cc);
    const h = (x) => vm.runInContext(`parseCgHash(${JSON.stringify(x)})`, cc);
    ok('a lichess user arrow (cgHash "696,696,1,e2,e4,green") reads as e2e4, in every user brush',
       h('696,696,1,e2,e4,green') === 'e2e4' && h('696,696,0,g8,f6,red') === 'g8f6' && h('696,696,1,a7,a8,yellow') === 'a7a8' && h('696,696,1,h1,h8,blue') === 'h1h8');
    ok('...a circle, the site\'s own pale shapes and junk are not arrows',
       h('696,696,1,e4,green') === null && h('696,696,1,e2,e4,paleBlue') === null && h('') === null && h(null) === null);

    const ec = vm.createContext({}); ec.self = ec;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), ec);
    vm.runInContext(['ua_move_after', 'ua_result', 'ua_parse_info', 'ua_label'].map(n => fnOf(psrc, n)).join(''), ec);
    const e = (x) => vm.runInContext(x, ec);
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const a = e(`ua_move_after(${JSON.stringify(START)}, 'e2e4', 'chess')`);
    ok('a drawn legal move gives the position after it, Black to move',
       a && a.uci === 'e2e4' && a.sideAfter === 'b' && /^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b KQkq/.test(a.fenAfter) && !a.mated && !a.stalemate, a);
    ok('...an arrow that is not a legal move here (an idea, the other side\'s piece, junk) is nothing',
       e(`ua_move_after(${JSON.stringify(START)}, 'e2e5', 'chess')`) === null && e(`ua_move_after(${JSON.stringify(START)}, 'e7e5', 'chess')`) === null
       && e(`ua_move_after(${JSON.stringify(START)}, 'x', 'chess')`) === null);
    const promo = e(`ua_move_after('8/4P3/8/8/8/8/k7/4K3 w - - 0 1', 'e7e8', 'chess')`);
    ok('...a pawn drawn to its last rank is the queen promotion', promo && promo.uci === 'e7e8q', promo);
    const mate = e(`ua_move_after('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8', 'chess')`);
    ok('...a mating arrow says so without a search', mate && mate.mated === true, mate);

    ok('info lines parse: multipv, cp or mate, the first pv move; bounds and pv-less lines do not count',
       JSON.stringify(e(`ua_parse_info('info depth 12 seldepth 18 multipv 2 score cp -35 nodes 9 nps 9 pv e7e5 g1f3')`)) === '{"k":2,"cp":-35,"pv":"e7e5"}'
       && JSON.stringify(e(`ua_parse_info('info depth 9 multipv 1 score mate -2 nodes 9 pv d8h4')`)) === '{"k":1,"mate":-2,"pv":"d8h4"}'
       && e(`ua_parse_info('info depth 12 multipv 1 score cp 40 lowerbound nodes 9 pv e7e5')`) === null
       && e(`ua_parse_info('info depth 12 multipv 1 score cp 40 nodes 9')`) === null && e(`ua_parse_info('bestmove e7e5')`) === null);
    const r = e(`ua_result([{k: 1, cp: -35, pv: 'e7e5'}, {k: 2, mate: 3, pv: 'd8h4'}], 'b')`);
    ok('the search is from the OPPONENT\'s side; the result is White\'s view, line 1 is the arrow\'s eval and the lines are the replies',
       JSON.stringify(r) === '{"white":{"cp":35},"replies":[{"uci":"e7e5","white":{"cp":35}},{"uci":"d8h4","white":{"mate":-3}}]}', r);
    ok('...with White to move after the arrow the sign stays, and no lines is no result',
       e(`ua_result([{k: 1, cp: 120, pv: 'e2e4'}], 'w').white.cp`) === 120 && e(`ua_result([], 'w')`) === null);
    ok('labels: +0.35, -1.20, 0.00, #3 (White mates), #-3 (Black mates), # (mate on the board)',
       ['{cp: 35}', '{cp: -120}', '{cp: 0}', '{mate: 3}', '{mate: -3}', '{mate: 0}'].map(x => e(`ua_label(${x})`)).join() === '+0.35,-1.20,0.00,#3,#-3,#');

    // ---- wiring
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const bg = fs.readFileSync(ROOT + '/src/scripts/background-script.js', 'utf8');
    const live = psrc.slice(psrc.indexOf('const LIVE_CONFIG_KEYS = ['), psrc.indexOf('];', psrc.indexOf('const LIVE_CONFIG_KEYS = [')));
    ok('OFF by default (page and panel), replies 0, both rows on the page, both live in an open panel',
       /registerFormElement\('user_arrow_evals', '[^']+:', 'checkbox', false\)/.test(gj) && /registerFormElement\('user_arrow_replies', '[^']+:', 'input', 0\)/.test(gj)
       && /id="user_arrow_evals_checkbox"/.test(gh) && /id="user_arrow_replies_input"/.test(gh)
       && /user_arrow_evals: JSON\.parse\(MephistoConfig\.get\('user_arrow_evals'\)\) \|\| false,/.test(psrc)
       && /'user_arrow_evals'/.test(live) && /'user_arrow_replies'/.test(live));
    ok('...its own engine client (<tab>:ua, never the main search) is freed with the tab and with the panel',
       /ua_id = ENGINE_CLIENT \+ ':ua'/.test(psrc) && /clientId: String\(tabId\) \+ ':ua', cmd: 'dispose'/.test(bg) && /ua_dispose\(\); user_arrows = \[\];/.test(psrc));
    const MOVE_PATHS = ['on_engine_best_move', 'humanize_pick', 'request_automove', 'premove_certified', 'premove_reply_playable'];
    ok('DISPLAY ONLY: no move path reads the arrows or their evals',
       MOVE_PATHS.every(n => psrc.indexOf(`function ${n}(`) >= 0 && !/user_arrow|ua_/.test(fnOf(psrc, n))));
    ok('...the board only reads the user brushes and polls only while the setting is on',
       /const on = !!config\?\.user_arrow_evals && \(site === 'lichess' \|\| site === 'chesscom'\);/.test(csrc));
    const keys = ['set.user_arrow_evals', 'set.tip.user_arrow_evals', 'set.user_arrow_replies', 'set.tip.user_arrow_replies'];
    const dir = ROOT + '/src/i18n/locales/', files = fs.readdirSync(dir);
    const loc = Object.fromEntries(files.map(f => [f.replace('.json', ''), JSON.parse(fs.readFileSync(dir + f, 'utf8'))]));
    const bad = [];
    for (const [l, d] of Object.entries(loc)) for (const k of keys) {
        if (typeof d[k] !== 'string' || !d[k].trim()) bad.push(`${l}:${k} missing`);
        else if (l !== 'en' && d[k] === loc.en[k]) bad.push(`${l}:${k}`);
    }
    ok(`...${keys.length} strings in all ${files.length} locales, translated`, files.length === 14 && !bad.length, bad.join(' '));
}
// ==== END EVALS ON YOUR ARROWS ====

// ==== EVALS ON ARROWS ARE WHITE'S VIEW (OR THE SIDE YOU PICK) ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const fnOf = (name) => { const i = psrc.indexOf(`function ${name}(`); return psrc.slice(i, psrc.indexOf('\n}\n', i) + 3); };
    const fn = ['arrow_eval_side_of', 'arrow_pov_sign', 'arrow_pov', 'arrow_label'].map(fnOf).join('');
    const c = vm.createContext({});
    vm.runInContext(`var config = {arrow_labels: true, arrow_eval_side: 'white'}, turn = 'w', side = 'white'; function our_side() { return side; }` + fn, c);
    const lbl = (t, line) => vm.runInContext(`turn = ${JSON.stringify(t)}; arrow_label(${JSON.stringify(line)})`, c);
    // the stored score is White-relative: +35 is White better whoever is to move
    ok('a stored +0.35 (White better) reads +0.35 with White AND with Black to move, like the panel score',
       lbl('w', {score: 35}) === '+0.35' && lbl('b', {score: 35}) === '+0.35' && lbl('b', {score: -120}) === '-1.20', [lbl('w', {score: 35}), lbl('b', {score: 35})]);
    ok('...mates keep their sign: #3 White mates, #-3 Black mates, on either side\'s turn',
       lbl('w', {mate: 3}) === '#3' && lbl('b', {mate: -3}) === '#-3' && lbl('b', {mate: 3}) === '#3', [lbl('b', {mate: -3}), lbl('b', {mate: 3})]);
    ok('...the score really is stored White-relative (the one flip at parse time this label relies on)',
       /lineInfo\[scoreType\] = \(turn === 'w' \? 1 : -1\) \* scoreNumber;/.test(psrc));

    // ---- Arrow Evals From: white | mine | mover, one switch for the engine's arrows and yours
    const at = (mode, t, me, line) => vm.runInContext(`config.arrow_eval_side = ${JSON.stringify(mode)}; turn = ${JSON.stringify(t)}; side = ${JSON.stringify(me)}; arrow_label(${JSON.stringify(line)})`, c);
    const g = [at('mine', 'w', 'black', {score: 35}), at('mine', 'b', 'black', {score: 35}), at('mine', 'w', 'white', {score: 35}),
               at('mover', 'b', 'white', {score: 35}), at('mover', 'w', 'white', {score: 35}), at('mine', 'b', 'black', {mate: -2}), at('mover', 'b', 'white', {mate: 4})];
    ok('Your side: White +0.35 reads -0.35 for a Black player on either turn, +0.35 for a White one; a mate for you reads #2',
       g[0] === '-0.35' && g[1] === '-0.35' && g[2] === '+0.35' && g[5] === '#2', g);
    ok('...Side to move: + is good for whoever plays the arrow (Black to move: White +0.35 reads -0.35, a White mate reads #-4)',
       g[3] === '-0.35' && g[4] === '+0.35' && g[6] === '#-4', g);
    ok('...an unknown or missing value is White, the panel convention',
       vm.runInContext(`[arrow_eval_side_of('mine'), arrow_eval_side_of('mover'), arrow_eval_side_of('x'), arrow_eval_side_of(null)].join()`, c) === 'mine,mover,white,white');
    ok('...the drawn arrows go through the same switch: {cp}/{mate} flipped, White kept',
       vm.runInContext(`config.arrow_eval_side = 'mover'; JSON.stringify([arrow_pov({cp: 40}, 'b'), arrow_pov({mate: 3}, 'b'), arrow_pov({cp: 40}, 'w')])`, c) === '[{"cp":-40},{"mate":-3},{"cp":40}]');
    const gh = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.html', 'utf8');
    const gj = fs.readFileSync(ROOT + '/src/options/pages/settings/general/general.js', 'utf8');
    const live = psrc.slice(psrc.indexOf('const LIVE_CONFIG_KEYS = ['), psrc.indexOf('];', psrc.indexOf('const LIVE_CONFIG_KEYS = [')));
    ok('...wired: White by default (page and panel), its select with the three values, live in an open panel, and the drawn-arrow label uses it',
       /registerFormElement\('arrow_eval_side', '[^']+:', 'select', 'white'\)/.test(gj)
       && /<select name="arrow_eval_side" id="arrow_eval_side_select">[\s\S]*?value="white"[\s\S]*?value="mine"[\s\S]*?value="mover"[\s\S]*?<\/select>/.test(gh)
       && /arrow_eval_side: arrow_eval_side_of\(JSON\.parse\(MephistoConfig\.get\('arrow_eval_side'\)\)\),/.test(psrc) && /'arrow_eval_side'/.test(live)
       && /label = ua_label\(arrow_pov\(hit\.white, fen\.split\(' '\)\[1\]\)\)/.test(psrc));
    const keys = ['set.arrow_eval_side', 'set.tip.arrow_eval_side', 'set.arrow_eval_side.white', 'set.arrow_eval_side.mine', 'set.arrow_eval_side.mover'];
    const dir = ROOT + '/src/i18n/locales/', files = fs.readdirSync(dir);
    const bad = [];
    const en = JSON.parse(fs.readFileSync(dir + 'en.json', 'utf8'));
    for (const f of files) { const d = JSON.parse(fs.readFileSync(dir + f, 'utf8'));
        for (const k of keys) if (typeof d[k] !== 'string' || !d[k].trim() || (f !== 'en.json' && d[k] === en[k])) bad.push(`${f}:${k}`); }
    ok(`...${keys.length} strings in all ${files.length} locales, translated`, files.length === 14 && !bad.length, bad.join(' '));
}
// ==== END EVALS ON ARROWS ARE WHITE'S VIEW ====

// ==== MAIA-2 SCORE IS FROM THE SIDE TO MOVE ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const m2 = fs.readFileSync(ROOT + '/src/offscreen/maia2.js', 'utf8');
    const go = m2.slice(m2.indexOf('const win = '), m2.indexOf('listen(`bestmove ${scored[0][0]}`)'));
    // UCI score is side-to-move and on_engine_response flips it for Black, so the adapter must not
    ok('Maia-2 emits the value head as it is (side to move): no flip for Black in the adapter',
       go.length > 0 && !/\bblack\b/.test(go) && !/1 - win/.test(m2), go.slice(0, 120));
}
// ==== END MAIA-2 SCORE IS FROM THE SIDE TO MOVE ====

// ==== OPENING REPERTOIRE ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const g = vm.createContext({}); g.self = g;
    vm.runInContext(fs.readFileSync(ROOT + '/lib/chess.js', 'utf8'), g);
    vm.runInContext(psrc.slice(psrc.indexOf('// ==== HUMANIZE GUARDS ===='), psrc.indexOf('// ==== END HUMANIZE GUARDS ====')), g);
    const v = (e) => vm.runInContext(e, g);
    ok('opening: a deviation needs Maia at HZ_OPENING_MAIA_MIN or more; without a Maia read none passes; after the opening anything does',
       v("hz_opening_ok(true, new Map([['g1f3', HZ_OPENING_MAIA_MIN]]), 'g1f3')") === true
       && v("hz_opening_ok(true, new Map([['a2a4', HZ_OPENING_MAIA_MIN / 10]]), 'a2a4')") === false
       && v("hz_opening_ok(true, new Map([['g1f3', 0.4]]), 'a2a4')") === false
       && v("hz_opening_ok(true, null, 'g1f3')") === false
       && v("hz_opening_ok(false, null, 'a2a4')") === true && v('HZ_OPENING_MAIA_MIN') === 0.05);
    ok('...applied to every deviation path: the alternatives list itself is filtered, with the opening read from in_opening',
       /const probs = hz_maia_probs\(fen\);\s*const opening = in_opening\(fen\);\s*const alts = lines\.filter\(l => l !== bestLine && line_cp_ours\(l\) > -90000[^\n]*\n\s*&& hz_opening_ok\(opening, probs, l\.move\)\);/.test(psrc)
       && (psrc.match(/const alts = /g) || []).length === 1);
}
// ==== END OPENING REPERTOIRE ====

// ==== STALE BESTMOVE KEEPS THE NEW SEARCH LIVE ====
{
    const ok = (name, cond, got) => { if (cond) console.log('ok   ' + name); else { fails++; console.log(`FAIL ${name}${got === undefined ? '' : '  (got ' + JSON.stringify(got) + ')'}`); } };
    const psrc = fs.readFileSync(ROOT + '/src/popup/popup.js', 'utf8');
    const i = psrc.indexOf('function on_engine_response(message) {');
    const head = psrc.slice(i, psrc.indexOf('last_info_at = Date.now();   // the panel is HEARING', i));
    const run = (onePass) => {
        const c = vm.createContext({console: {log() {}, warn() {}}, Date});
        vm.runInContext(`var pending_stops = 0, stop_charged_at = 0, search_active = false, last_info_at = 0, one_pass_owed = 0, passed = [];
            const STOP_FLUSH_MS = 1500; function is_remote() { return false; } function is_one_pass() { return ${onePass}; }
            function note_unsupported_variant() {} function download_progress_text() { return null; } function update_best_move() {}
            ${head} passed.push(message); }
            function abandon() { if (search_active) { pending_stops++; stop_charged_at = Date.now(); } search_active = false; }
            function go() { search_active = true; }`, c);
        // P1 searching; P2 arrives (abandon + go); P1's bestmove lands after P2's go; P3 arrives the same way
        return vm.runInContext(`go(); abandon(); go(); on_engine_response('bestmove e2e4'); const live = search_active;
            abandon(); go(); on_engine_response('info depth 9 pv e7e5'); on_engine_response('bestmove e7e5');
            on_engine_response('info depth 3 pv g1f3'); on_engine_response('bestmove g1f3'); ({live, passed, owed: pending_stops})`, c);
    };
    const sf = run(false), maia = run(true);
    ok('a searching engine: the abandoned search\'s bestmove leaves the new one live, so the NEXT position drops its output too',
       sf.live === true && JSON.stringify(sf.passed) === JSON.stringify(['info depth 3 pv g1f3', 'bestmove g1f3']) && sf.owed === 0, sf);
    ok('...a one-pass engine (which can answer nothing) still clears the flag, as before', maia.live === false, maia);
}
// ==== END STALE BESTMOVE KEEPS THE NEW SEARCH LIVE ====
