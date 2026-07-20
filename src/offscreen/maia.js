// Maia engine for the offscreen host: a UCI-speaking adapter that runs ONE onnxruntime-web forward
// pass of an lc0 Maia net (no lc0, no search). Same {uci, listen, onError, terminate} interface as
// the Stockfish engines, so popup.js drives it identically. Encoding/decoding verified against lc0
// itself at 99.6% move-match (see maia-prototype/STATUS.md). Loaded via dynamic import from
// offscreen.js. Uses the global `self.Chess` (repo chess.js, loaded in offscreen.html) for legal
// moves + history replay.
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';

// Single-threaded wasm on the offscreen thread: no worker (the CSP has no blob:/worker-src), and a
// Maia forward pass is a few ms anyway. Point ort at the locally-vendored wasm binary (no CDN).
ort.env.wasm.wasmPaths = '/lib/ort/';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// ---- lc0 canonical 1858 policy index (harvested from lc0; ships as JSON) -----------------------
let moveToIdx = null;
async function loadTable() {
    if (moveToIdx) return;
    const arr = await fetch('/lib/engine/maia/lc0_policy_index.json').then(r => r.json());
    moveToIdx = new Map(arr.map((m, i) => [m, i]).filter(([m]) => m));
}

// ---- input encoding: lc0 classic 112-plane (verified) ------------------------------------------
const PLANE = 64, HIST = 8, PER_POS = 13, AUX = 104, TOTAL = 112;
const PIECE_IDX = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

function parseFen(fen) {
    const [placement, stm, castle, , halfmove] = fen.trim().split(/\s+/);
    const board = new Array(64).fill(null);
    let r = 7, f = 0;
    for (const ch of placement) {
        if (ch === '/') { r--; f = 0; }
        else if (/\d/.test(ch)) f += +ch;
        else { board[r * 8 + f] = { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() }; f++; }
    }
    return {
        board, stm,
        castle: { K: castle.includes('K'), Q: castle.includes('Q'), k: castle.includes('k'), q: castle.includes('q') },
        rule50: parseInt(halfmove) || 0,
    };
}

function fillPlane(out, n, v) { const b = (AUX + n) * PLANE; for (let i = 0; i < PLANE; i++) out[b + i] = v; }

// positions: parsed FENs, MOST RECENT FIRST. Up to 8 used; older zero-filled. Rank-flip for black.
function encode(positions) {
    const out = new Float32Array(TOTAL * PLANE);
    const cur = positions[0];
    const black = cur.stm === 'b';
    const persp = (sqi) => { const f = sqi % 8; let rr = (sqi / 8) | 0; if (black) rr = 7 - rr; return rr * 8 + f; };
    for (let h = 0; h < HIST && h < positions.length; h++) {
        const pos = positions[h], base = h * PER_POS * PLANE;
        for (let sqi = 0; sqi < 64; sqi++) {
            const pc = pos.board[sqi];
            if (!pc) continue;
            const planeNo = (pc.color === cur.stm ? 0 : 6) + PIECE_IDX[pc.type];
            out[base + planeNo * PLANE + persp(sqi)] = 1.0;
        }
    }
    const usK = cur.stm === 'w' ? cur.castle.K : cur.castle.k;
    const usQ = cur.stm === 'w' ? cur.castle.Q : cur.castle.q;
    const themK = cur.stm === 'w' ? cur.castle.k : cur.castle.K;
    const themQ = cur.stm === 'w' ? cur.castle.q : cur.castle.Q;
    if (usQ) fillPlane(out, 0, 1); if (usK) fillPlane(out, 1, 1);
    if (themQ) fillPlane(out, 2, 1); if (themK) fillPlane(out, 3, 1);
    if (black) fillPlane(out, 4, 1);
    fillPlane(out, 5, cur.rule50);
    fillPlane(out, 7, 1);
    return out;
}

// ---- decoding (verified) -----------------------------------------------------------------------
const CASTLE = { e1g1: 'e1h1', e1c1: 'e1a1', e8g8: 'e8h8', e8c8: 'e8a8' }; // lc0 = king-to-rook
function toPerspUci(uci, black) {
    uci = CASTLE[uci] || uci;
    const flip = (s) => black ? s[0] + (9 - +s[1]) : s;
    return flip(uci.slice(0, 2)) + flip(uci.slice(2, 4)) + (uci[4] || '');
}
function pickMove(logits, legalUcis, black) {
    let best = null, bestLogit = -Infinity;
    for (const uci of legalUcis) {
        const idx = moveToIdx.get(toPerspUci(uci, black));
        if (idx === undefined) continue;
        if (logits[idx] > bestLogit) { bestLogit = logits[idx]; best = uci; }
    }
    return best || legalUcis[0];
}
function valueToCp(wdl) {
    let win = (Array.isArray(wdl) && wdl.length === 3) ? wdl[0] + wdl[1] / 2 : (wdl[0] + 1) / 2;
    win = Math.min(0.9999, Math.max(0.0001, win));
    return Math.round(-Math.log10(1 / win - 1) * 400);
}

// ---- the UCI adapter ---------------------------------------------------------------------------
export async function createMaiaEngine(level, listen) {
    await loadTable();
    const Chess = self.Chess;
    // fetch the net bytes ourselves (like fetchNnue) and hand ort the buffer -- more robust than
    // letting ort fetch a URL from inside the offscreen doc, and matches the rest of the host.
    const bytes = new Uint8Array(await fetch(`/lib/engine/maia/maia-${level}.onnx`).then(r => r.arrayBuffer()));
    const session = await ort.InferenceSession.create(bytes);
    console.log(`[Maia] net maia-${level} loaded (${bytes.length} bytes), onnxruntime ready`);

    let history = [], legalUcis = [], black = false;

    function setPosition(fen, moves) {
        const chess = new Chess('chess', fen || undefined);
        const fens = [chess.fen()];
        for (const uci of (moves || '').split(/\s+/).filter(Boolean)) {
            chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
            fens.push(chess.fen());
        }
        history = fens.reverse().map(parseFen);
        black = history[0].stm === 'b';
        legalUcis = chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    }

    async function go() {
        if (!legalUcis.length) { listen('bestmove (none)'); return; }
        const t0 = performance.now();
        const out = await session.run({ '/input/planes': new ort.Tensor('float32', encode(history.slice(0, 8)), [1, 112, 8, 8]) });
        const move = pickMove(out['/output/policy'].data, legalUcis, black);
        const cp = valueToCp(Array.from(out['/output/wdl'].data));
        console.log(`[Maia] level ${level} played ${move} (cp ${cp}) — net pass ${(performance.now() - t0).toFixed(1)}ms`);
        listen(`info depth 1 score cp ${cp} pv ${move}`);
        listen(`bestmove ${move}`);
    }

    return {
        uci(line) {
            line = line.trim();
            if (line === 'uci') { listen('id name Maia'); listen('uciok'); }
            else if (line === 'isready') listen('readyok');
            else if (line.startsWith('position')) {
                const fenM = /position\s+fen\s+(.+?)(?:\s+moves\s+(.*))?$/.exec(line);
                const startM = /position\s+startpos(?:\s+moves\s+(.*))?$/.exec(line);
                if (fenM) setPosition(fenM[1], fenM[2]);
                else if (startM) setPosition(null, startM[1]);
            }
            else if (line.startsWith('go')) go().catch(e => listen(`info string maia error ${e}`));
            // ucinewgame/setoption/stop/quit: no-ops (single pass, no search state)
        },
        terminate() { try { session.release && session.release(); } catch (e) { /* */ } },
    };
}
