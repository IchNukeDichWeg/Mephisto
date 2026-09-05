import { fetchModel } from '/src/offscreen/model-fetch.js';
// onnxruntime is a MODULE here, not a page global: every other adapter imports it and so must this
// one. Without these two lines `ort` is simply undefined and the engine never loads -- and the node
// verification could not catch it, because that harness hands the module an `ort` of its own.
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';
// the ort env (threads, wasm paths) is configured ONCE, shared by every session
import '/src/offscreen/ort-env.js';
// Maia-2: ONE model that takes BOTH ratings -- yours and your opponent's -- and answers the same
// position differently depending on who is playing it against whom. That is the gap between Maia-1
// (pick a band) and Maia-3 (one slider): here the opponent is part of the question.
//
// Everything below mirrors maia2's own inference (`maia2/inference.py`) rather than improving on it,
// because the reference IS the definition of what this net answers:
//   - black to move: the BOARD IS MIRRORED and the chosen move mirrored back. The net only ever
//     sees white to move, from white's side.
//   - the input is 18 planes: 12 piece planes, a turn plane, 4 castling planes, 1 en-passant plane.
//   - the legal mask MULTIPLIES the logits and the softmax is taken over the whole vocabulary. That
//     is not the same as masking with -inf, and copying it is deliberate: it is what the model's own
//     numbers mean.
//   - the value head is `(v / 2 + 0.5)` clamped to [0,1], and it is flipped for black.
const MOVE_PLANES = 18;
let TABLES = null;   // {moves: [...1880 uci], moveIdx: Map, buckets: [...]}

async function loadTables(note) {
    if (TABLES) return TABLES;
    const raw = JSON.parse(new TextDecoder().decode(
        await fetchModel('/lib/engine/maia2', 'maia2-tables.json', note)));
    TABLES = { moves: raw.moves, moveIdx: new Map(raw.moves.map((m, i) => [m, i])), eloDict: raw.elo_dict };
    return TABLES;
}

// maia2/utils.py map_to_category: <1100 is bucket 0, then hundreds, >=2000 is the last one.
export function eloBucket(elo) {
    const e = Number(elo);
    if (!Number.isFinite(e) || e < 1100) return 0;
    if (e >= 2000) return 10;
    return Math.floor((e - 1100) / 100) + 1;
}

// maia2/utils.py board_to_tensor, on a chess.js board that is ALREADY mirrored when needed.
export function boardTensor(chess) {
    const out = new Float32Array(MOVE_PLANES * 64);
    const PIECE = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
    const files = 'abcdefgh';
    for (let sq = 0; sq < 64; sq++) {
        const name = files[sq % 8] + (Math.floor(sq / 8) + 1);   // a1..h8, python-chess square order
        const pc = chess.get(name);
        if (!pc) continue;
        const plane = PIECE[pc.type] + (pc.color === 'w' ? 0 : 6);
        out[plane * 64 + sq] = 1;
    }
    const fen = chess.fen(), parts = fen.split(' ');
    if (parts[1] === 'w') out.fill(1, 12 * 64, 13 * 64);
    const rights = parts[2] || '-';
    ['K', 'Q', 'k', 'q'].forEach((r, i) => {
        if (rights.includes(r)) out.fill(1, (13 + i) * 64, (14 + i) * 64);
    });
    if (parts[3] && parts[3] !== '-') {
        const ep = (Number(parts[3][1]) - 1) * 8 + files.indexOf(parts[3][0]);
        out[17 * 64 + ep] = 1;
    }
    return out;
}

// a1<->a8: the same mirror python-chess applies, in UCI
export function mirrorUci(uci) {
    const flip = (sq) => sq[0] + (9 - Number(sq[1]));
    return flip(uci.slice(0, 2)) + flip(uci.slice(2, 4)) + (uci[4] || '');
}

export async function createMaia2Engine(listen, initialSelf, initialOppo) {
    const note = (msg) => { try { listen(`info string ${msg}`); } catch (e) { /* no listener yet */ } };
    const tables = await loadTables(note);
    const Chess = self.Chess;
    const bytes = new Uint8Array(await fetchModel('/lib/engine/maia2', 'maia2-rapid.onnx', note));
    const session = await ort.InferenceSession.create(bytes);
    console.log(`[Maia-2] rapid model loaded (${bytes.length} bytes), onnxruntime ready`);

    let fen = null, moves = '', selfElo = initialSelf || 1500, oppoElo = initialOppo || 1500, multipv = 1;

    function position(startFen, moveList) {
        const chess = new Chess('chess', startFen && startFen !== 'startpos' ? startFen : undefined);
        for (const uci of (moveList || '').trim().split(/\s+/).filter(Boolean)) {
            chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        }
        return chess;
    }

    async function go() {
        const board = position(fen, moves);
        const black = board.turn() === 'b';
        // the net only ever sees white to move: mirror the position, and mirror the answer back
        const view = black ? new Chess('chess', mirrorFen(board.fen())) : board;
        const legal = view.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
        if (!legal.length) { listen('bestmove (none)'); return; }
        const out = await session.run({
            boards: new ort.Tensor('float32', boardTensor(view), [1, MOVE_PLANES, 8, 8]),
            elo_self: new ort.Tensor('int64', BigInt64Array.from([BigInt(eloBucket(selfElo))]), [1]),
            elo_oppo: new ort.Tensor('int64', BigInt64Array.from([BigInt(eloBucket(oppoElo))]), [1]),
        });
        const logits = out.logits_maia.data;
        // the reference multiplies by the mask and softmaxes the WHOLE vocabulary -- see the note above
        const masked = new Float64Array(logits.length);
        for (const uci of legal) {
            const i = tables.moveIdx.get(uci);
            if (i !== undefined) masked[i] = logits[i];
        }
        let mx = -Infinity;
        for (let i = 0; i < masked.length; i++) if (masked[i] > mx) mx = masked[i];
        let sum = 0;
        const exp = new Float64Array(masked.length);
        for (let i = 0; i < masked.length; i++) { exp[i] = Math.exp(masked[i] - mx); sum += exp[i]; }
        const scored = [];
        for (const uci of legal) {
            const i = tables.moveIdx.get(uci);
            if (i !== undefined) scored.push([black ? mirrorUci(uci) : uci, exp[i] / sum]);
        }
        if (!scored.length) { listen(`bestmove ${legal[0]}`); return; }
        scored.sort((a, b) => b[1] - a[1]);
        // the value head is the net's own win probability for the side to move, in the reference's
        // scaling, flipped for black exactly as inference.py flips it
        let win = Math.min(1, Math.max(0, Number(out.logits_value.data[0]) / 2 + 0.5));
        if (black) win = 1 - win;
        const cp = Math.round(-Math.log10(1 / Math.min(0.9999, Math.max(0.0001, win)) - 1) * 400);
        const n = Math.min(multipv, scored.length);
        for (let i = 0; i < n; i++) {
            listen(`info depth 1 multipv ${i + 1} score cp ${cp} `
                + `maiaprob ${Math.round(scored[i][1] * 10000)} pv ${scored[i][0]}`);
        }
        listen(`bestmove ${scored[0][0]}`);
    }

    // python-chess's board.mirror() in FEN terms: flip the ranks, swap the colours, swap castling.
    function mirrorFen(f) {
        const [placement, stm, castle, ep, half, full] = f.split(' ');
        const swapped = placement.split('/').reverse().join('/')
            .replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
        const castleSwap = castle === '-' ? '-' : castle.split('')
            .map(c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).sort().join('');
        const epSwap = ep === '-' ? '-' : ep[0] + (9 - Number(ep[1]));
        return [swapped, stm === 'w' ? 'b' : 'w', castleSwap, epSwap, half, full].join(' ');
    }

    return {
        uci(line) {
            const s = (line || '').trim();
            if (s === 'uci') { listen('id name Mephisto Maia-2'); listen('uciok'); return; }
            if (s === 'isready') { listen('readyok'); return; }
            if (s.startsWith('setoption')) {
                const mv = /name MultiPV value (\d+)/.exec(s);
                if (mv) multipv = Math.max(1, Number(mv[1]));
                // SelfElo / OppoElo: the same option names Maia-3 already takes, so the panel has
                // one convention for "tell the net who is playing" rather than two.
                const es = /name SelfElo value (\d+)/.exec(s);
                if (es) selfElo = Number(es[1]);
                const eo = /name OppoElo value (\d+)/.exec(s);
                if (eo) oppoElo = Number(eo[1]);
                return;
            }
            if (s.startsWith('position')) {
                const m = /position (?:fen (.+?)|startpos)(?: moves (.*))?$/.exec(s);
                fen = m && m[1] ? m[1] : 'startpos';
                moves = (m && m[2]) || '';
                return;
            }
            // see maia.js: a failed pass still owes the panel a terminal frame, or the search never
            // closes and the watchdog stands down on the locally-answered `isready`. `${e}` rather
            // than `e.message`, matching its siblings: a non-Error throw read "failed: undefined".
            if (s.startsWith('go')) {
                go().catch((e) => { listen(`info string maia2 error ${e}`); listen('bestmove (none)'); });
                return;
            }
            if (s === 'stop' || s === 'quit') return;   // one forward pass: there is nothing to stop
        },
        // disposeClient/abandon in offscreen.js both call this behind `engine.terminate &&`, so its
        // absence here was a SILENT no-op: the ONNX session (and its wasm arena) leaked on every
        // switch away from Maia-2. Same body as maia.js/maia3.js.
        terminate() { try { session.release && session.release(); } catch (e) { /* */ } },
    };
}
