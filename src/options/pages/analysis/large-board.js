// Shogi and xiangqi on the Analysis page: their own board, analysed by the large-board Fairy-Stockfish
// build (lib/engine/fairy-stockfish-14-large). The 8x8 build cannot play them at all: it does not
// declare either variant and answers `UCI_Variant shogi` by staying on chess (measured: e2e4).
//
// WHAT THIS PAGE KNOWS ABOUT THE RULES: NOTHING. chess.js cannot represent a 9x9 or 9x10 board, and a
// second rules engine written here would be a second source of truth that drifts from the one doing
// the analysis. So the engine is the authority for everything that is a rule:
//   - legal moves       = the engine's `go perft 1` list (a click can only play a move on it)
//   - the next position = the engine's own `d` output (its "Fen:" line), never computed here
//   - game over         = an empty perft list (in both games the side with no move has lost)
// What IS checked here is only what keeps garbage away from the engine, which does no FEN validation
// of its own (Fairy's uci.cpp position() hands the string straight to Position::set): the board shape,
// the piece letters, one king per side, the side to move. A FEN that passes that is sent as-is and may
// still be an illegal position; the engine's lines are then what the engine makes of it.
//
// ponytail: no move tree, no PGN/KIF/PXF import, no clocks. A move played off the middle of the line
// truncates it. Add a tree when someone studies variations here.

const LARGE_ENGINE = 'fairy-stockfish-14-large-nnue';

// ---- PURE (sliced into test_popup_logic.js; no DOM, no engine) ------------------------------------
// The start positions exactly as the engine's own `d` prints them for `position startpos`.
const LARGE_GAMES = {
    shogi: {files: 9, ranks: 9, pieces: 'plnsgbrk', promotable: 'plnsbr', hand: true,
            start: 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL[] w - - 0 1'},
    xiangqi: {files: 9, ranks: 10, pieces: 'rnbakcp', promotable: '', hand: false,
              start: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'},
};

// fen -> {cells: [rank][file] = 'P' | '+p' | '', hand: {w: {P: n}, b: {p: n}}, turn}. rank 0 is the
// engine's rank 1, the first player's back rank. Throws {key, vars} so the caller can translate.
function parseLargeFen(game, fen) {
    const g = LARGE_GAMES[game];
    const bad = (key, vars) => { const e = new Error(key); e.key = key; e.vars = vars || {}; throw e; };
    const fields = String(fen || '').trim().split(/\s+/);
    const m = /^([^[\]]+)(?:\[([^\]]*)\])?$/.exec(fields[0] || '');
    if (!m) bad('shape', {files: g.files, ranks: g.ranks});
    if (m[2] !== undefined && !g.hand && m[2] !== '') bad('hand');
    const rows = m[1].split('/');
    if (rows.length !== g.ranks) bad('shape', {files: g.files, ranks: g.ranks});
    const cells = [];
    const kings = {K: 0, k: 0};
    rows.forEach((row, i) => {
        const out = [];
        for (const t of row.match(/\d+|\+?[a-zA-Z]|./g) || []) {
            if (/^\d+$/.test(t)) { for (let n = +t; n > 0; n--) out.push(''); continue; }
            const letter = t.replace('+', '');
            if (!/^[a-zA-Z]$/.test(letter) || !g.pieces.includes(letter.toLowerCase())
                || (t[0] === '+' && !g.promotable.includes(letter.toLowerCase()))) bad('piece', {c: t});
            if (letter === 'K' || letter === 'k') kings[letter]++;
            out.push(t);
        }
        if (out.length !== g.files) bad('shape', {files: g.files, ranks: g.ranks});
        cells[g.ranks - 1 - i] = out;
    });
    if (kings.K !== 1 || kings.k !== 1) bad('kings');
    const hand = {w: {}, b: {}};
    for (const c of m[2] || '') {
        if (c === '-') continue;
        if (!/[a-zA-Z]/.test(c) || !g.pieces.includes(c.toLowerCase()) || c.toLowerCase() === 'k') bad('piece', {c});
        const side = c === c.toUpperCase() ? 'w' : 'b';
        hand[side][c] = (hand[side][c] || 0) + 1;
    }
    const turn = fields[1];
    if (turn !== 'w' && turn !== 'b') bad('turn');
    return {cells, hand, turn};
}

// Fairy's move notation: "h2c2", "b2h8+" (promotes), "B@e5" (a drop; the letter is uppercase for
// both sides), xiangqi ranks run to 10 ("c10e8"). null for anything else.
function parseLargeMove(uci) {
    const drop = /^([A-Z])@([a-i])(10|[1-9])$/.exec(uci || '');
    if (drop) return {drop: drop[1], to: [drop[2].charCodeAt(0) - 97, +drop[3] - 1]};
    const mv = /^([a-i])(10|[1-9])([a-i])(10|[1-9])([+=]?)$/.exec(uci || '');
    if (!mv) return null;
    return {from: [mv[1].charCodeAt(0) - 97, +mv[2] - 1], to: [mv[3].charCodeAt(0) - 97, +mv[4] - 1],
            promo: mv[5] === '+'};
}
const sqName = ([f, r]) => String.fromCharCode(97 + f) + (r + 1);

// The engine's moves that a click from `from` (a square [f, r] or a drop letter) to `to` could mean.
// Two of them only in shogi, when promoting is optional: "x+" and "x".
function largeCandidates(legal, from, to) {
    const dst = sqName(to);
    return legal.filter(u => typeof from === 'string'
        ? u === `${from}@${dst}`
        : u.replace(/[+=]$/, '') === sqName(from) + dst);
}
// ---- END PURE -------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const t = (key, dflt, vars) => (self.MephistoI18n?.t ? self.MephistoI18n.t(key, dflt, vars)
    : String(dflt).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// Traditional characters. Shogi: the first player's king is 玉, the second's 王; promoted pieces in red.
const SHOGI_KANJI = {p: '歩', l: '香', n: '桂', s: '銀', g: '金', b: '角', r: '飛', k: '玉',
                     '+p': 'と', '+l': '杏', '+n': '圭', '+s': '全', '+b': '馬', '+r': '龍'};
const XIANGQI_HAN = {w: {k: '帥', a: '仕', b: '相', n: '傌', r: '俥', c: '炮', p: '兵'},
                     b: {k: '將', a: '士', b: '象', n: '馬', r: '車', c: '砲', p: '卒'}};
const HAND_ORDER = 'rbgsnlp';

const gameName = () => game === 'shogi' ? t('an.game_shogi', 'Shogi') : t('an.game_xiangqi', 'Xiangqi');

const FEN_ERRORS = {
    shape: ['an.lg_err_shape', 'the board must be {files} x {ranks} squares'],
    piece: ['an.lg_err_piece', 'unknown piece letter {c}'],
    kings: ['an.lg_err_kings', 'each side needs exactly one king'],
    turn: ['an.lg_err_turn', 'the side to move must be w or b'],
    hand: ['an.lg_err_hand', 'pieces in hand are only for shogi'],
};

let game = null;        // 'shogi' | 'xiangqi' while shown, null while the chess board is up
let getOpts = () => ({multipv: 3, threads: 1, hash: 64, depth: 0, secs: 0});
let startFen = '';
let moves = [];         // the line, in Fairy notation
let ply = 0;            // how many of `moves` are on the board
let view = null;        // parseLargeFen of the position on the board
let curFen = '';
let legal = [];
let selected = null;    // a square [f, r] or a drop letter
let flipped = false;
let lastLines = [];
let engine = null, engineGame = null, live = null, budgetTimer = null;
let chain = Promise.resolve();
let wired = false;

function status(text, kind) {
    const el = $('an_lg_status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'an-status' + (kind ? ` an-${kind}` : '');
}

// ---- engine ---------------------------------------------------------------------------------------

async function ensureEngine() {
    if (engine && engineGame === game) return engine;
    disposeEngine();
    const o = getOpts();
    const E = self.MephistoEngines;
    // its own client id: the chess engines keep theirs, and the offscreen host disposes on id reuse
    const e = new E.WasmEngine(LARGE_ENGINE,
        {variant: game, multipv: o.multipv, threads: o.threads, hash: o.hash}, 'analysis-large');
    let unsupported = false;
    e.listeners.push((m) => {
        if (m.kind !== 'line') return;
        if (/^info string mephisto-unsupported-variant/.test(m.line)) unsupported = true;
        const dl = /^info string mephisto-download (\S+) (\d+) (\d+)/.exec(m.line);
        if (dl) status(`${t('an.lg_loading', 'Loading the large-board engine…')} ${Math.round(100 * dl[2] / dl[3])}%`);
    });
    status(t('an.lg_loading', 'Loading the large-board engine…'));
    engine = e; engineGame = game;
    // a failed start must not be cached as the engine, or every later refresh reuses a dead one
    try { await e.start(); } catch (err) { disposeEngine(); throw err; }
    if (unsupported) {
        disposeEngine();
        throw new Error(t('an.lg_unsupported', 'This engine build does not have {game}. Its answer would be about a different game, so none is shown.', {game: gameName()}));
    }
    status('');
    return e;
}

function disposeEngine() {
    if (!engine) return;
    try { engine.dispose(); } catch (e) { /* the offscreen document is already gone */ }
    engine = null; engineGame = null;
}

// Collect every line up to one matching `end`, after sending `cmds`. The engine is idle when this
// runs (the chain stops the search first), so nothing else is talking on this client id.
async function ask(e, cmds, end, timeoutMs = 20000) {
    const got = [];
    const collect = (m) => { if (m.kind === 'line') got.push(m.line); };
    e.listeners.push(collect);
    const done = e.once(m => m.kind === 'line' && end.test(m.line), timeoutMs);
    try {
        for (const c of cmds) e.send(c);
        await done;
    } finally {
        const i = e.listeners.indexOf(collect);
        if (i >= 0) e.listeners.splice(i, 1);
    }
    return got;
}

const positionCmd = () => `position fen ${startFen}${ply ? ' moves ' + moves.slice(0, ply).join(' ') : ''}`;

async function stopSearch() {
    if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
    const s = live; live = null;
    if (s) { try { await s.stop(); } catch (e) { /* engine gone */ } }
}

// One position change = stop, ask the engine for the position and its legal moves, draw, search.
// Serialised: a second click while the first is still asking must not interleave its commands.
function refresh() {
    const want = game;
    chain = chain.then(() => refreshNow(want)).catch(e => status(String(e.message || e), 'err'));
    return chain;
}

async function refreshNow(want) {
    if (!game || game !== want) return;
    await stopSearch();
    lastLines = [];
    renderLines(null);
    const e = await ensureEngine();
    if (game !== want) return;
    // The engine's own board, not ours: `d` prints the FEN it now holds after the moves.
    const d = await ask(e, [positionCmd(), 'd'], /^Checkers:/);
    curFen = (d.find(l => /^Fen: /.test(l)) || '').slice(5).trim() || startFen;
    view = parseLargeFen(game, curFen);
    const perft = await ask(e, [positionCmd(), 'go perft 1'], /^Nodes searched/);
    legal = perft.map(l => /^(\S+): \d+$/.exec(l)?.[1]).filter(Boolean);
    const fenBox = $('an_lg_fen');
    if (fenBox && document.activeElement !== fenBox) fenBox.value = curFen;
    render();
    renderMoves();
    if (!legal.length) return status(t('an.lg_no_moves', 'No legal moves: the side to move has lost.'));
    const o = getOpts();
    const at = curFen, turn = view.turn;
    live = e.startInfinite(positionCmd().replace(/^position fen /, ''), turn, (res) => {
        if (curFen !== at) return;
        lastLines = (res.lines || []).filter(l => legal.includes(l.pv?.[0]));
        renderLines(res);
        drawArrow();
    }, {depth: o.depth});
    if (!o.depth && o.secs) budgetTimer = setTimeout(() => { stopSearch(); }, o.secs * 1000);
}

// ---- board ----------------------------------------------------------------------------------------

function xy(f, r) {
    const g = LARGE_GAMES[game];
    return flipped ? [g.files - 1 - f + 0.5, r + 0.5] : [f + 0.5, g.ranks - 1 - r + 0.5];
}

function shogiPiece(p, cx, cy, extra = '') {
    const first = p.replace('+', '') === p.replace('+', '').toUpperCase();
    const up = first !== flipped;   // a piece points at the opponent
    const key = p.startsWith('+') ? '+' + p[1].toLowerCase() : p.toLowerCase();
    const ch = (key === 'k' && !first) ? '王' : SHOGI_KANJI[key];
    return `<g transform="translate(${cx} ${cy}) rotate(${up ? 0 : 180})" ${extra}>
        <polygon points="0,-0.43 0.3,-0.3 0.37,0.42 -0.37,0.42 -0.3,-0.3" class="an-lg-koma"/>
        <text y="0.1" class="an-lg-kanji${p.startsWith('+') ? ' an-lg-promoted' : ''}">${ch}</text></g>`;
}

function xiangqiPiece(p, cx, cy) {
    const side = p === p.toUpperCase() ? 'w' : 'b';
    return `<g transform="translate(${cx} ${cy})"><circle r="0.42" class="an-lg-disc an-lg-${side}"/>
        <circle r="0.34" class="an-lg-ring an-lg-${side}"/>
        <text y="0.03" class="an-lg-han an-lg-${side}">${XIANGQI_HAN[side][p.toLowerCase()]}</text></g>`;
}

function render() {
    const host = $('an_lg_board');
    if (!host || !game || !view) return;
    const g = LARGE_GAMES[game];
    const W = g.files, H = g.ranks, parts = [];
    parts.push(`<defs><marker id="an-lg-head" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3" markerHeight="3" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="an-lg-arrowhead"/></marker></defs>`);
    parts.push(`<rect x="-0.3" y="-0.3" width="${W + 0.6}" height="${H + 0.6}" class="an-lg-wood"/>`);
    if (game === 'shogi') {
        for (let i = 0; i <= W; i++) parts.push(`<line x1="${i}" y1="0" x2="${i}" y2="${H}" class="an-lg-grid"/>`);
        for (let i = 0; i <= H; i++) parts.push(`<line x1="0" y1="${i}" x2="${W}" y2="${i}" class="an-lg-grid"/>`);
        for (const [x, y] of [[3, 3], [6, 3], [3, 6], [6, 6]]) parts.push(`<circle cx="${x}" cy="${y}" r="0.07" class="an-lg-star"/>`);
    } else {
        // lines run through the points; the inner files stop at the river (between ranks 5 and 6)
        for (let f = 0; f < W; f++) {
            const x = f + 0.5;
            if (f === 0 || f === W - 1) parts.push(`<line x1="${x}" y1="0.5" x2="${x}" y2="${H - 0.5}" class="an-lg-grid"/>`);
            else parts.push(`<line x1="${x}" y1="0.5" x2="${x}" y2="4.5" class="an-lg-grid"/><line x1="${x}" y1="5.5" x2="${x}" y2="${H - 0.5}" class="an-lg-grid"/>`);
        }
        for (let r = 0; r < H; r++) parts.push(`<line x1="0.5" y1="${r + 0.5}" x2="${W - 0.5}" y2="${r + 0.5}" class="an-lg-grid"/>`);
        // the two palaces: d1-f3 and d8-f10, crossed
        for (const [y0, y1] of [[0.5, 2.5], [7.5, 9.5]]) {
            parts.push(`<line x1="3.5" y1="${y0}" x2="5.5" y2="${y1}" class="an-lg-grid"/><line x1="5.5" y1="${y0}" x2="3.5" y2="${y1}" class="an-lg-grid"/>`);
        }
        parts.push(`<text x="2.5" y="5.12" class="an-lg-river">楚 河</text><text x="6.5" y="5.12" class="an-lg-river">漢 界</text>`);
    }
    // coordinates in Fairy's notation, the same letters and numbers the engine lines use
    for (let f = 0; f < W; f++) { const [x] = xy(f, 0); parts.push(`<text x="${x}" y="${H + 0.24}" class="an-lg-coord">${String.fromCharCode(97 + f)}</text>`); }
    for (let r = 0; r < H; r++) { const [, y] = xy(0, r); parts.push(`<text x="-0.17" y="${y + 0.06}" class="an-lg-coord">${r + 1}</text>`); }
    // what a click would select, and where it could go -- straight off the engine's perft list
    const targets = selected ? legal.map(parseLargeMove).filter(m => m && (typeof selected === 'string'
        ? m.drop === selected : m.from && m.from[0] === selected[0] && m.from[1] === selected[1])).map(m => m.to) : [];
    if (Array.isArray(selected)) { const [x, y] = xy(...selected); parts.push(`<rect x="${x - 0.5}" y="${y - 0.5}" width="1" height="1" class="an-lg-sel"/>`); }
    for (let r = 0; r < H; r++) for (let f = 0; f < W; f++) {
        const p = view.cells[r][f];
        if (!p) continue;
        const [x, y] = xy(f, r);
        parts.push(game === 'shogi' ? shogiPiece(p, x, y) : xiangqiPiece(p, x, y));
    }
    for (const to of targets) { const [x, y] = xy(...to); parts.push(`<circle cx="${x}" cy="${y}" r="0.13" class="an-lg-dot"/>`); }
    parts.push('<g id="an_lg_arrow"></g>');
    // an invisible hit layer, one cell per square, so a click needs no geometry
    for (let r = 0; r < H; r++) for (let f = 0; f < W; f++) {
        const [x, y] = xy(f, r);
        parts.push(`<rect x="${x - 0.5}" y="${y - 0.5}" width="1" height="1" class="an-lg-hit" data-f="${f}" data-r="${r}"/>`);
    }
    host.setAttribute('viewBox', `-0.45 -0.35 ${W + 0.8} ${H + 0.75}`);
    host.innerHTML = parts.join('');
    renderHands();
    const side = game === 'shogi' ? (view.turn === 'w' ? t('an.lg_sente', 'Sente') : t('an.lg_gote', 'Gote'))
        : (view.turn === 'w' ? t('an.lg_red', 'Red') : t('an.lg_black', 'Black'));
    const tm = $('an_lg_turn');
    if (tm) tm.textContent = t('an.lg_to_move', '{side} to move', {side});
    drawArrow();
}

function renderHands() {
    for (const [id, side] of [['an_lg_hand_top', flipped ? 'w' : 'b'], ['an_lg_hand_bottom', flipped ? 'b' : 'w']]) {
        const el = $(id);
        if (!el) continue;
        el.classList.toggle('hidden', game !== 'shogi');
        if (game !== 'shogi') { el.innerHTML = ''; continue; }
        const held = view.hand[side];
        const items = HAND_ORDER.split('').map(c => side === 'w' ? c.toUpperCase() : c).filter(c => held[c]);
        el.innerHTML = `<span class="an-lg-hand-label">${esc(side === 'w' ? t('an.lg_sente', 'Sente') : t('an.lg_gote', 'Gote'))} · ${esc(t('an.lg_hand', 'In hand'))}</span>`
            + (items.length ? items.map(c => `<button type="button" class="an-lg-handpc${selected === c.toUpperCase() && side === view.turn ? ' an-lg-on' : ''}" data-drop="${c.toUpperCase()}" data-side="${side}">
                <svg viewBox="-0.5 -0.5 1 1">${shogiPiece(c, 0, 0)}</svg><span>${held[c] > 1 ? '×' + held[c] : ''}</span></button>`).join('')
                : '<span class="an-lg-hand-empty">-</span>');
    }
}

function drawArrow() {
    const g = $('an_lg_arrow');
    if (!g) return;
    const best = parseLargeMove(lastLines[0]?.pv?.[0]);
    if (!best) { g.innerHTML = ''; return; }
    const [tx, ty] = xy(...best.to);
    if (best.drop) {
        g.innerHTML = `<circle cx="${tx}" cy="${ty}" r="0.46" class="an-lg-best-drop"/>`;
        return;
    }
    const [fx, fy] = xy(...best.from);
    const len = Math.hypot(tx - fx, ty - fy) || 1, k = (len - 0.3) / len;
    g.innerHTML = `<line x1="${fx}" y1="${fy}" x2="${fx + (tx - fx) * k}" y2="${fy + (ty - fy) * k}" class="an-lg-best" marker-end="url(#an-lg-head)"/>`;
}

function renderLines(res) {
    const host = $('an_lg_lines'), meta = $('an_lg_meta');
    if (meta) meta.textContent = res ? `depth ${res.depth}${res.nodes ? ` · ${(res.nodes / 1000).toFixed(0)}k` : ''}${res.done ? ' · done' : ''}` : '';
    const h = $('an_lg_lines_h');
    if (h && game) h.textContent = t('an.lg_lines', 'Engine lines, scored for {side}',
        {side: game === 'shogi' ? t('an.lg_sente', 'Sente') : t('an.lg_red', 'Red')});
    if (!host) return;
    const Core = self.MephistoReviewCore;
    host.innerHTML = lastLines.length ? lastLines.map((l, i) => {
        const val = Core.isMateScore(l.cp) ? (l.cp > 0 ? `#${Math.abs(l.mate ?? 0) || ''}` : `-#${Math.abs(l.mate ?? 0) || ''}`)
            : (l.cp > 0 ? '+' : '') + (l.cp / 100).toFixed(2);
        return `<div class="an-lrow${i === 0 ? ' an-top' : ''}" data-move="${esc(l.pv[0])}">
            <span class="an-lrank">${i + 1}</span>
            <span class="an-lmove">${esc(l.pv[0])} <span class="an-lpv">${esc(l.pv.slice(1, 10).join(' '))}</span></span>
            <span class="an-lval">${esc(val)}</span></div>`;
    }).join('') : '<div class="an-lrow"><span></span><span class="an-lval">thinking…</span><span></span></div>';
}

function renderMoves() {
    const el = $('an_lg_moves');
    if (!el) return;
    el.innerHTML = moves.map((m, i) => `<span class="an-lg-mv${i === ply - 1 ? ' an-lg-cur' : ''}" data-ply="${i + 1}">${i % 2 ? '' : `<b>${i / 2 + 1}.</b> `}${esc(m)}</span>`).join(' ');
}

function play(uci) {
    if (!legal.includes(uci)) return;       // the engine's list is the only authority
    moves = moves.slice(0, ply).concat(uci);
    ply = moves.length;
    selected = null;
    refresh();
}

function onBoardClick(ev) {
    const hit = ev.target.closest?.('.an-lg-hit');
    if (!hit || !view) return;
    const sq = [+hit.dataset.f, +hit.dataset.r];
    if (selected) {
        const cands = largeCandidates(legal, selected, sq);
        if (cands.length) {
            // promotion is optional in shogi when both moves are legal; ask rather than guess
            const pick = cands.length > 1
                ? (window.confirm(t('an.lg_promote', 'Promote this piece?')) ? cands.find(u => u.endsWith('+')) : cands.find(u => !u.endsWith('+')))
                : cands[0];
            return play(pick || cands[0]);
        }
    }
    const p = view.cells[sq[1]][sq[0]];
    const mine = p && ((p.replace('+', '') === p.replace('+', '').toUpperCase()) === (view.turn === 'w'));
    selected = mine && !(Array.isArray(selected) && selected[0] === sq[0] && selected[1] === sq[1]) ? sq : null;
    render();
}

function onHandClick(ev) {
    const b = ev.target.closest?.('.an-lg-handpc');
    if (!b || !view || b.dataset.side !== view.turn) return;
    selected = selected === b.dataset.drop ? null : b.dataset.drop;
    render();
}

function loadFen(text) {
    const fen = String(text || '').trim() || LARGE_GAMES[game].start;
    try {
        parseLargeFen(game, fen);
    } catch (e) {
        const [key, dflt] = FEN_ERRORS[e.key] || ['', String(e.message || e)];
        const why = key ? t(key, dflt, e.vars) : dflt;
        return status(t('an.lg_bad_fen', 'Not a {game} FEN: {why}', {game: gameName(), why}), 'err');
    }
    startFen = fen; moves = []; ply = 0; selected = null;
    status('');
    refresh();
}

function wire() {
    if (wired) return;
    wired = true;
    $('an_lg_board')?.addEventListener('click', onBoardClick);
    $('an_lg_hand_top')?.addEventListener('click', onHandClick);
    $('an_lg_hand_bottom')?.addEventListener('click', onHandClick);
    $('an_lg_load')?.addEventListener('click', () => loadFen($('an_lg_fen')?.value));
    $('an_lg_start')?.addEventListener('click', () => loadFen(''));
    $('an_lg_flip')?.addEventListener('click', () => { flipped = !flipped; render(); });
    $('an_lg_prev')?.addEventListener('click', () => { if (ply > 0) { ply--; selected = null; refresh(); } });
    $('an_lg_next')?.addEventListener('click', () => { if (ply < moves.length) { ply++; selected = null; refresh(); } });
    $('an_lg_moves')?.addEventListener('click', (ev) => {
        const s = ev.target.closest?.('[data-ply]');
        if (s) { ply = +s.dataset.ply; selected = null; refresh(); }
    });
    $('an_lg_lines')?.addEventListener('click', (ev) => {
        const row = ev.target.closest?.('[data-move]');
        if (row) play(row.dataset.move);
    });
    // Lines / Threads / Hash / budget are the page's shared controls: a new MultiPV or thread count
    // needs a fresh engine, a new budget only a fresh search
    for (const id of ['an_lines_input', 'an_threads_input', 'an_hash_input'])
        $(id)?.addEventListener('change', () => { if (game) { chain = chain.then(stopSearch).then(disposeEngine); refresh(); } });
    for (const id of ['an_time_range', 'an_depth_range', 'an_limit_kind_select'])
        $(id)?.addEventListener('change', () => { if (game) refresh(); });
}

// Show the large board for `g`. `opts()` returns the page's shared engine settings.
function showLargeGame(g, opts) {
    if (!LARGE_GAMES[g]) return;
    if (opts) getOpts = opts;
    wire();
    if (game !== g) {
        game = g;
        const box = $('an_lg_fen');
        if (box) box.value = '';
        loadFen('');
    }
}

// Stop searching and free the engine; the chess board is taking over (or the page is closing).
function hideLargeGame() {
    game = null;
    chain = chain.then(stopSearch).then(disposeEngine).catch(() => {});
    return chain;
}

export {LARGE_ENGINE, LARGE_GAMES, parseLargeFen, parseLargeMove, largeCandidates, showLargeGame, hideLargeGame};
