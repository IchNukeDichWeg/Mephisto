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
        if (frame.error) { pending.delete(frame.id); p.reject(new Error(errorText(frame))); return; }
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

// The host's error, with the move it broke at when it names one. A bad PGN4 comes back as
// {error, ply}, and the parser's words name only the token and the seat, so dropping `ply` left a
// repeated token (a king or rook shuffle) impossible to find (audit 3.1.331 REVIEW4PC-4). `ply` is
// the 0-based index of the token in the file, every seat's move (and any `#`/`S`/`R` token) counted.
function errorText(frame) {
    if (typeof frame.ply !== 'number') return frame.error;
    const vars = {error: frame.error, n: frame.ply + 1};
    const en = "{error} (move {n}, counting every player's move from the start)";
    const I = self.MephistoI18n;
    return I && I.t ? I.t('rv.4pc_error_at_ply', en, vars) : en.replace(/\{(\w+)\}/g, (m, k) => String(vars[k]));
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

// A line's score in centipawns, a mate encoded the way the two-player review's toWhiteCp does it
// (MATE_CP less the distance) so winPercent and isMateScore read it as one. Tetrarch prints
// `score mate N` (N in team moves, positive when the side to move's team mates) and the host relays
// it as `mate` with no `score`, so reading only `score`/`cp` left every position with a forced mate
// unscored and the moves that decide the game ungraded (audit 3.1.331 REVIEW4PC-1). `mate 0` is the
// mating move itself: score_string has no sign for a zero, and it is printed for the side about to
// deliver it, so it counts as a win for the side to move.
function lineCp(l, MATE_CP) {
    if (typeof l.score === 'number') return l.score;
    if (typeof l.cp === 'number') return l.cp;
    if (typeof l.mate === 'number') return l.mate >= 0 ? MATE_CP - l.mate : -(MATE_CP + l.mate);
    return null;
}

// The seat that actually moves out of frame `f`. When the file carries no `#`/`S` token for a seat
// left with no move (chess.com writes none), Tetrarch's replay takes that seat out WITHOUT a frame,
// so `f.turn` still names the stuck seat while the move that follows is the next live seat's -- and
// the engine, resolving the stuck seat on load, searches for that seat too. Taking `turn` as the
// mover credited the next move, its eval and its tally to a seat already out of the game (audit
// 3.1.331 REVIEW4PC-2). The mover is the first seat from `turn` on that is still alive after it.
function moverOf(f, next) {
    const alive = next && next.alive;
    let k = SEATS.indexOf(f.turn);
    if (!Array.isArray(alive) || k < 0) return f.turn;
    for (let n = 0; n < SEATS.length; n++, k = (k + 1) % SEATS.length) if (alive[k]) return SEATS[k];
    return f.turn;
}

// What the page prints for a score from this file: `#N` / `#-N` for a mate, pawns otherwise.
function scoreText(cp) {
    if (typeof cp !== 'number') return null;
    const C = self.MephistoClassify;
    if (C && C.isMateScore(cp)) return (cp > 0 ? '#' : '#-') + (C.MATE_CP - Math.abs(cp));
    return (cp / 100).toFixed(2);
}

// Walk the game: search every position, then grade each move with the SHARED classifier -- the
// same rules the two-player review and the panel's live strip use, so a blunder is a blunder on
// every screen. No human model and no strength estimate: Maia knows one game and it is not this
// one, and a rating fitted from four seats would be a number with nothing behind it.
//
// TWO GRADING METHODS, because the two modes have different score algebra:
//   Teams  -- zero-sum between the pairs, so the eval after a move CAN be flipped into the mover's
//             team's terms, and the before/after win swing grades the move (verified live).
//   FFA    -- NOT zero-sum (Tetrarch v8 searches it paranoid: every node in the ROOT seat's own
//             terms), so consecutive evals belong to different seats and no negation relates them.
//             A move is graded WITHIN one search instead: the engine's best line and the played
//             move's own line come from the same position at the same perspective, so their win%
//             gap is honest -- and a move outside the engine's lines is a null verdict, not a guess.
async function runReview(pgn4Text, {movetime = 1000, onProgress, isCancelled} = {}) {
    const C = self.MephistoClassify;
    if (!C) throw new Error('the classifier is not loaded');
    const {frames, terminations, tags, variant, mode, setup} = await replay(pgn4Text);
    if (frames.length < 2) throw new Error('that PGN4 has no moves to review');
    const isFfa = /ffa/i.test(String(variant)) || String(mode) === '0';
    // Mode selects the net (the engine's bundle ships one per mode since v8); MultiPV gives the
    // FFA grader the lines it compares within. Sent once, before the first search.
    // Setup too, because the bundle picks the net by (mode, setup) and `position fen4` never changes
    // the engine's setup: without it every game ran on the classic net, so a modern-setup game
    // (chess.com's default) was searched by a net the bundle measures ~22 Elo worse there (audit
    // 3.1.331 REVIEW4PC-3). Setup resets the engine's board, which is harmless: every search below
    // sends the whole position. An old host that names no setup leaves the engine's own.
    const options = {Mode: isFfa ? 'ffa' : 'teams', MultiPV: 5};
    if (typeof setup === 'string' && setup) options.Setup = setup;
    await send('configure', {options}).catch(() => {});

    const evals = new Array(frames.length).fill(null);
    for (let i = 0; i < frames.length; i++) {
        if (isCancelled && isCancelled()) throw new Error('stopped');
        if (onProgress) onProgress(i / frames.length, `position ${i + 1} of ${frames.length}`);
        const res = await analyse(frames[i].fen4, movetime);
        // `0000` is the engine's "no legal move", not a line: the seat to move is mated or stalemated
        const lines = (res.lines || []).map(l => ({
            move: l.move || (l.pv || [])[0] || null,
            cp: lineCp(l, C.MATE_CP),
        })).filter(l => l.move !== '0000');
        let cp = lines[0]?.cp ?? null;
        // A finished Teams position gets no score from the engine, so the move that ended the game
        // had nothing to be graded against. The rules say what it is worth, as the two-player
        // assemble fills it: the side to move mated loses (Teams: the first mate wins, RULES.md 7),
        // a stalemate is a draw. Only with the host's `check` flags; without them it stays unscored.
        const f = frames[i], seatIdx = SEATS.indexOf(f.turn);
        if (!isFfa && cp == null && !lines.length && (!res.bestmove || res.bestmove === '0000')
            && Array.isArray(f.check) && seatIdx >= 0) {
            cp = f.check[seatIdx] ? -C.MATE_CP : 0;
        }
        evals[i] = {
            // Teams: one fixed team's terms all game. FFA: the mover's own terms, unflipped.
            teamCp: isFfa ? cp : toTeamCp(cp, frames[i].turn),
            best: (res.bestmove && res.bestmove !== '0000' ? res.bestmove : null) || lines[0]?.move || null,
            lines,
            mover: moverOf(f, frames[i + 1]),   // whose search this is (REVIEW4PC-2)
        };
    }

    const moves = [];
    for (let i = 0; i + 1 < frames.length; i++) {
        const f = frames[i], next = frames[i + 1];
        if (!next.move) continue;                       // a terminator, not a move
        const seat = moverOf(f, next);
        const rank = evals[i]?.lines?.findIndex(l => l.move === next.move);
        let winBefore = null, winAfter = null;
        if (isFfa) {
            // within one search: the best line vs the line the played move sits on
            const s1 = evals[i]?.lines?.[0]?.cp;
            const sp = rank >= 0 ? evals[i].lines[rank].cp : null;
            winBefore = (typeof s1 === 'number') ? C.winPercent(s1) : null;
            winAfter = (typeof sp === 'number') ? C.winPercent(sp) : null;
        } else {
            // across two searches, both flipped into the mover's team's favour
            const before = evals[i]?.teamCp, after = evals[i + 1]?.teamCp;
            const sign = TEAM_OF[seat] === 0 ? 1 : -1;
            winBefore = (before == null) ? null : C.winPercent(before * sign);
            winAfter = (after == null) ? null : C.winPercent(after * sign);
        }
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
            ply: i, seat, seatName: SEAT_NAME[seat] || seat,
            group: isFfa ? SEATS.indexOf(seat) : TEAM_OF[seat],
            move: next.move, token: next.token, klass,
            winBefore, winAfter, best: evals[i]?.best || null,
            teamCpAfter: evals[i + 1]?.teamCp ?? null,
        });
    }

    // Accuracy per GROUP -- the two teams, or the four seats -- on the two-player report's curve.
    // In FFA the engine prices ONE line today (PROTOCOL.md: ranking every root move for one fixed
    // root needs a C entry), so a win-gap only exists for moves that MATCHED the engine -- and an
    // average over only-matched moves reads 100% for everyone. Honest instead: FFA reports how
    // often each seat played the engine's move, and the accuracy slot stays empty until the engine
    // can price more than one line, at which point this same code starts filling it.
    const groupNames = isFfa ? SEATS.map(x => SEAT_NAME[x]) : TEAM_NAME.slice();
    const sawChoice = moves.some(m => m.winAfter != null && m.winBefore !== m.winAfter);
    const accuracy = groupNames.map((_, g) => {
        if (isFfa && !sawChoice) return null;
        const mine = moves.filter(m => m.group === g && m.winBefore != null && m.winAfter != null);
        if (!mine.length) return null;
        const each = mine.map(m => C.moveAccuracy
            ? C.moveAccuracy(m.winBefore, m.winAfter)
            : Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, m.winBefore - m.winAfter)) - 3.1669 + 1)));
        return Math.round(each.reduce((a, b) => a + b, 0) / each.length * 10) / 10;
    });
    const matched = groupNames.map((_, g) => {
        const mine = moves.filter(m => m.group === g);
        return {hit: mine.filter(m => m.move === m.best).length, of: mine.length};
    });
    const counts = groupNames.map((_, g) => {
        const out = {};
        for (const m of moves) if (m.group === g && m.klass) out[m.klass] = (out[m.klass] || 0) + 1;
        return out;
    });

    if (onProgress) onProgress(1, 'done');
    return {frames, terminations, tags, variant, mode, isFfa, evals, moves, accuracy, counts,
            matched, groupNames, teamNames: TEAM_NAME, seatName: SEAT_NAME};
}

root.Mephisto4PC = {replay, analyse, runReview, disconnect, toTeamCp, scoreText,
                    SEATS, SEAT_NAME, TEAM_OF, TEAM_NAME};

})(typeof self !== 'undefined' ? self : globalThis);
