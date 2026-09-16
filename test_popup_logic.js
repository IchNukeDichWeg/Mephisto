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
// a reply that is the opponent's ONLY legal move is certified by the RULES, at any depth
{
    vm.runInContext(`premove_tracker.fen = '7k/8/8/8/8/8/6q1/7K w - - 0 1';`, ctx);   // Kxg2 forced
    // A MAIA-SHAPED LINE -- depth 1, a pred and NO reply -- must never certify: every consumer
    // assumes line.reply is playable, and the rules bypass would otherwise certify it whenever
    // the opponent happens to be forced. Found by executing exactly this shape (2026-08-14).
    const maiaShaped = premove_certified({pred: 'h1g2', depth: 1, pv: ['h1g2']});
    if (!maiaShaped) console.log('ok   a reply-less (Maia-shaped) line never certifies');
    else { fails++; console.log('FAIL a reply-less (Maia-shaped) line CERTIFIED'); }
    const forcedOk = premove_certified({pred: 'h1g2', reply: 'g2f2', depth: 1});
    const wrongPred = premove_certified({pred: 'h1h2', reply: 'x', depth: 1});
    vm.runInContext(`premove_tracker.fen = '';`, ctx);
    if (forcedOk && !wrongPred) console.log('ok   a rules-forced reply certifies at depth 1; a different prediction does not');
    else { fails++; console.log(`FAIL rules certification (forced=${forcedOk}, wrong=${wrongPred})`); }
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
            var maia2 = {pending: {fen: 'FEN_A', line: {pred: 'e7e5'}, timer: 0}};
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
            maia2 = {pending: {fen: 'FEN_OLD', line: {pred: 'e7e5'}, timer: 0}};
            maia2_on_line('bestmove g1f3');
        `, mctx);
        if (mctx.calls.length === 0) console.log('ok   maia2_on_line: a stale answer (position moved on) is dropped');
        else { fails++; console.log('FAIL maia2_on_line played a stale answer'); }
        vm.runInContext(`
            calls.length = 0;
            premove_tracker = {fen: 'FEN_A', premoved: false};
            maia2 = {pending: {fen: 'FEN_A', line: {pred: 'e7e5'}, timer: 0}};
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
        + pj.slice(pj.indexOf('// ---- CONTEMPT: the dial for a game you have to WIN'), pj.indexOf('function humanize_pick(best) {')), c);
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
        /const fought = contempt_pick\(best\);/.test(pj)
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
        + 'function humanize_thresholds() { return {}; }\n'
        + pj.slice(pj.indexOf('const HUMANIZE_DEEP_MULTIPV'), pj.indexOf('// Ordered worst-to')), m);
    const mpv = (cfg) => { m.config = cfg; return m.effective_multipv(); };
    eq('nothing switched on: the slider is the line count', mpv({multiple_lines: 1}), 1);
    eq('contempt cannot choose without a second line', mpv({multiple_lines: 1, contempt: true}), 2);
    eq('nor can the complexity clock measure a gap', mpv({multiple_lines: 1, complexity_clock: true}), 2);
    eq('...and a slider set higher still wins', mpv({multiple_lines: 5, contempt: true}), 5);
    eq('humanize keeps its own deeper list', mpv({multiple_lines: 1, humanize: true, contempt: true}), 6);
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

    const h = {console, Math, Number};
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
    ok(`...and the typical move is quicker than it, which is what a right tail IS (median ${median}ms)`,
       median < mean * 0.95 && median > WANT * 0.8);
    ok('...nothing is negative and nothing is instant', draws[0] > 0);
    ok('...the tail is long but not infinite', draws[N - 1] <= WANT * 4);
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
        + pj.slice(pj.indexOf('// ---- CONTEMPT: the dial for a game you have to WIN'), pj.indexOf('function humanize_pick(best) {'))
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
        + 'var STATS = {white: {accuracy: 90}, black: {accuracy: 10}};\nfunction live_stats() { return STATS; }\n'
        + 'var STORE = {};\n'
        + 'var MephistoConfig = {get: (k) => (k in STORE) ? STORE[k] : null, set: (k, v) => { STORE[k] = v; }};\n'
        + 'var eval_history = [0.5, 0.5]; var eval_history_game = "game-1";\n'
        + pj.slice(pj.indexOf('// ---- WHAT THIS SESSION HAS ACTUALLY DONE'), pj.indexOf('// ---- ENDING A GAME THAT IS OVER')), s2);
    vm.runInContext('session = session_fresh();', s2);
    eq('nothing has happened, so nothing is said', s2.session_stats_label(), '');
    s2.session_note_move(1000); s2.session_note_move(3000);
    ok('the average is over the MOVES', /0 games · 2 moves · 2\.0s avg/.test(s2.session_stats_label()));
    // THE GAME IN FRONT OF YOU. Accuracy used to need a FINISHED game, so a session spent on one long
    // game showed moves and seconds and no accuracy at all.
    ok('...and the unfinished game already carries its accuracy',
       /0 games · 2 moves · 2\.0s avg · 90% accuracy/.test(s2.session_stats_label()));
    s2.session_note_game([0.5, 0.5], 'game-1');
    ok('a finished game brings its accuracy', /1 games · 2 moves · 2\.0s avg · 90% accuracy/.test(s2.session_stats_label()));
    ok('...counted once, not twice while the history still holds it',
       vm.runInContext('session.acc.length', s2) === 1 && s2.session_live_accuracy() === null);
    vm.runInContext('eval_history_game = "game-2"; STATS.white.accuracy = 50;', s2);
    ok('...and the next game averages in alongside it',
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
    ok('only on-turn moves are counted, so a blind premove cannot drag the average',
        /if \(verify\) session_note_move/.test(pj));
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
                   pj.indexOf('function live_stats(history)')), c);
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
       /if \(site === 'chesscom' && !isPuzzlePage\(\)\) \{\s*\n\s*return 'w';/.test(fn));
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
        // Sam's position: best +2.10, then +0.94, then -7.32 (a 9.42 drop -- the old cutoff was 4).
        const sam = [{move: 'f3f1', score: 210}, {move: 'd3f1', score: 94}, {move: 'g1f2', score: -732}];
        const best = width('w', sam, 0), mid = width('w', sam, 1), lost = width('w', sam, 2);
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
