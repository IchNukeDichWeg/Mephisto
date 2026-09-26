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
        + 'var STATS = {white: {accuracy: 90}, black: {accuracy: 10}};\n'
        + 'function live_stats(h) { return (h && h.length) ? STATS : {white: {accuracy: null}, black: {accuracy: null}}; }\n'
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
       /humanize_target_pick\(cands, bestCp, run, humanize_target\(\)/.test(psrc)
       && /category_for_roll\(r, humanize_rates\(\)\)/.test(psrc) && !/humanize_mix|humanize_steer/.test(psrc));
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
    ok('lichess: a 403 on the study path names the missing study:write scope, a 401 the token',
       /study:write/.test(Core.lichessError(403, 'study')) && /token/.test(Core.lichessError(401, 'study'))
       && /429|rate/.test(Core.lichessError(429, 'import')));

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
       /async function analyseNow\(\) \{\n\s+if \(match\?\.running\) return;/.test(aj) && /if \(!pos \|\| match\?\.running\) return false;/.test(aj));
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
    vm.runInContext(defs + '\nvar build = (config) => ({' + eloSpread + '\n' + persSpread + '\n});', cc);
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
       /session_note_game\(eval_history, eval_history_game\);[\s\S]{0,400}eval_history = \[\];/.test(psrc) && !/session\.folded/.test(psrc));
}
// ==== END FIX CHECKS ====
