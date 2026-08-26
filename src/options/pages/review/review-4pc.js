// FOUR-PLAYER CHESS, REVIEWED. A bypass lane, deliberately -- the two-player review is built on
// chess.js positions, an 8x8 board and a human model, and none of those exist here. Three separate
// bugs in the live 4PC work came from sharing a two-player path, so this file shares the classifier
// and nothing else.
//
// WHERE THE RULES LIVE: not here. The extension has no 14x14 four-seat rules engine and is not
// getting one -- Tetrarch's own package parses chess.com's PGN4 and steps it, handing back a FEN4
// per ply (its pgn4.replay is written "for a viewer to render without knowing any rules"), so the
// host answers `pgn4` with the frames and this file draws them. Castling, promotion, elimination
// and the points are therefore the engine's answers, not a second implementation of them.
//
// SCORES: Tetrarch reports from the SIDE TO MOVE'S TEAM (PROTOCOL.md), and the seat rotates every
// ply, so a raw score flips sign every move. Everything here is normalised to the RED/YELLOW team
// once, at the source, so a graph, a verdict and an accuracy all mean the same thing all game.
(function (root) {
'use strict';

const SEATS = ['R', 'B', 'Y', 'G'];
const SEAT_NAME = {R: 'Red', B: 'Blue', Y: 'Yellow', G: 'Green'};
// standard pairing, RULES.md §2: red+yellow against blue+green
const TEAM_OF = {R: 0, Y: 0, B: 1, G: 1};
const TEAM_NAME = ['Red & Yellow', 'Blue & Green'];

// --- the native host, from an options page -----------------------------------------------------
// Same port the panel uses; the worker relays it to com.tetrarch.host. One port for the page's
// lifetime, ids matched per request, and a disconnect rejects everything in flight rather than
// leaving a run hanging on a promise that can never settle.
let port = null, seq = 0;
const pending = new Map();

function connect() {
    if (port) return port;
    port = chrome.runtime.connect({name: 'tetrarch-native'});
    port.onMessage.addListener((frame) => {
        if (frame && frame.fatal) {
            for (const p of pending.values()) p.reject(new Error(frame.fatal));
            pending.clear();
            return;
        }
        const p = frame && pending.get(frame.id);
        if (!p) return;
        if (frame.error) { pending.delete(frame.id); p.reject(new Error(frame.error)); return; }
        if (frame.info) { if (p.onInfo) p.onInfo(frame.info); return; }   // streamed depth update
        pending.delete(frame.id);
        p.resolve(frame);
    });
    port.onDisconnect.addListener(() => {
        port = null;
        for (const p of pending.values()) p.reject(new Error('Tetrarch host disconnected'));
        pending.clear();
    });
    return port;
}

function send(cmd, data, onInfo) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject, onInfo});
        try { connect().postMessage({id, cmd, ...data}); }
        catch (e) { pending.delete(id); reject(e); }
    });
}

function disconnect() {
    try { port?.disconnect(); } catch (e) { /* already gone */ }
    port = null;
    pending.clear();
}

// --- the review ---------------------------------------------------------------------------------

// A PGN4 in, frames out. Errors come back as the host's own message, including the ply that broke,
// because "invalid PGN4" with no position is not something a reader can act on.
async function replay(pgn4Text) {
    const r = await send('pgn4', {pgn4: pgn4Text});
    if (!r || !Array.isArray(r.frames)) throw new Error('the host returned no frames');
    return r;
}

// One position, searched. `movetime` is the same budget the two-player review calls a time limit.
async function analyse(fen4, movetime, onInfo) {
    const r = await send('analyse', {fen4, time: movetime}, onInfo);
    return r || {};
}

// Score in the RED/YELLOW team's favour, whoever is to move. `cp` arrives from the side-to-move's
// team, so a Blue or Green turn is the other team's view of the same number.
function toTeamCp(cp, turn) {
    if (typeof cp !== 'number') return null;
    return TEAM_OF[turn] === 0 ? cp : -cp;
}

// Walk the game: search every position, then grade each move with the SHARED classifier -- the
// same rules the two-player review and the panel's live strip use, so a blunder is a blunder on
// every screen. No human model and no strength estimate: Maia knows one game and it is not this
// one, and a rating fitted from four seats would be a number with nothing behind it.
async function runReview(pgn4Text, {movetime = 1000, onProgress, isCancelled} = {}) {
    const C = self.MephistoClassify;
    if (!C) throw new Error('the classifier is not loaded');
    const {frames, terminations, tags, variant} = await replay(pgn4Text);
    if (frames.length < 2) throw new Error('that PGN4 has no moves to review');

    const evals = new Array(frames.length).fill(null);
    for (let i = 0; i < frames.length; i++) {
        if (isCancelled && isCancelled()) throw new Error('stopped');
        if (onProgress) onProgress(i / frames.length, `position ${i + 1} of ${frames.length}`);
        const res = await analyse(frames[i].fen4, movetime);
        const line = (res.lines || [])[0] || {};
        const cp = typeof line.score === 'number' ? line.score
            : typeof line.cp === 'number' ? line.cp : null;
        evals[i] = {
            teamCp: toTeamCp(cp, frames[i].turn),
            best: res.bestmove || line.move || (line.pv || [])[0] || null,
            lines: res.lines || [],
        };
    }

    // Grade every move that has a measured position on both sides of it. The mover's own team is
    // the perspective -- charging Blue for a swing measured in Red's favour is the sign bug that
    // makes every other move look like a blunder.
    const moves = [];
    for (let i = 0; i + 1 < frames.length; i++) {
        const f = frames[i], next = frames[i + 1];
        if (!next.move) continue;                       // a terminator, not a move
        const before = evals[i]?.teamCp, after = evals[i + 1]?.teamCp;
        const seat = f.turn;
        const sign = TEAM_OF[seat] === 0 ? 1 : -1;      // into the MOVER's team's favour
        const winBefore = (before == null) ? null : C.winPercent(before * sign);
        const winAfter = (after == null) ? null : C.winPercent(after * sign);
        const rank = evals[i]?.lines?.findIndex(l => (l.move || (l.pv || [])[0]) === next.move);
        const klass = (winBefore == null || winAfter == null) ? null
            : C.classify({
                winBefore, winAfter,
                rank: rank >= 0 ? rank + 1 : null,
                onlyMove: false,     // the host does not report the legal-move count
                isBook: false,       // no 4-player opening book exists
                secondWin: null,
                sacrifice: false,    // the sacrifice probe is 8x8 chess.js; it cannot read this board
            });
        moves.push({
            ply: i, seat, seatName: SEAT_NAME[seat] || seat, team: TEAM_OF[seat],
            move: next.move, token: next.token, klass,
            winBefore, winAfter, best: evals[i]?.best || null,
            teamCpAfter: after,
        });
    }

    // Per-team accuracy, on the same curve the two-player report uses.
    const acc = [0, 1].map(t => {
        const mine = moves.filter(m => m.team === t && m.winBefore != null);
        if (!mine.length) return null;
        const each = mine.map(m => C.moveAccuracy
            ? C.moveAccuracy(m.winBefore, m.winAfter)
            : Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, m.winBefore - m.winAfter)) - 3.1669)));
        return Math.round(each.reduce((a, b) => a + b, 0) / each.length * 10) / 10;
    });
    const counts = [0, 1].map(t => {
        const out = {};
        for (const m of moves) if (m.team === t && m.klass) out[m.klass] = (out[m.klass] || 0) + 1;
        return out;
    });

    if (onProgress) onProgress(1, 'done');
    return {frames, terminations, tags, variant, evals, moves, accuracy: acc, counts,
            teamNames: TEAM_NAME, seatName: SEAT_NAME};
}

root.Mephisto4PC = {replay, analyse, runReview, disconnect, toTeamCp,
                    SEATS, SEAT_NAME, TEAM_OF, TEAM_NAME};

})(typeof self !== 'undefined' ? self : globalThis);
