// The move classifier, shared by the Game Review and the panel. It lived inside review-core.js,
// which is 40KB and only ever loaded on the options pages; the panel needs the SAME rules for its
// live stats and its last-move badge, and two copies of a published scheme would drift the first
// time one of them was tuned. Classic script: importScripts-able, <script>-able, and loadable as
// a content script.
(function (root) {
'use strict';

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

const MATE_CP = 100000;   // a mate score, kept far outside any real eval so ordering still works
function isMateScore(cp) { return Math.abs(cp) > MATE_CP - 1000; }

function winPercent(cp) {
    if (isMateScore(cp)) return cp > 0 ? 100 : 0;
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -2000, 2000))) - 1);
}

// Lichess's per-move accuracy (lila, AccuracyPercent.scala), from the win% the move gave away.

const BLUNDER = 20, MISTAKE = 10, INACCURACY = 5, GOOD = 2;

// Piece values for the sacrifice test. Only relative size matters here.

const PIECE_VAL = {p: 1, n: 3, b: 3, r: 5, q: 9, k: 0};

// Did this move GIVE UP material -- the thing that separates a brilliancy from a good move?
// A swap-off on the destination square, cheapest attacker first, exactly as an exchange evaluation
// does: if the side to move comes out behind on that square, material was offered. Everything is
// read from the position, so no move list or engine line is needed.
//
// It answers "was material offered", NOT "was the sacrifice sound" -- soundness is the engine's
// job and is checked separately (the move must still be best-ish and must not lose).

function sacrificesMaterial(Chess, variant, fenBefore, uci) {
    try {
        const c = new Chess(variant || 'chess', fenBefore);
        const from = uci.slice(0, 2), to = uci.slice(2, 4);
        const mover = c.get(from);
        const captured = c.get(to);
        const mv = c.move({from, to, promotion: uci[4]});
        if (!mv) return false;
        // en passant and promotions confuse a naive swap; treat the promoted piece as what stands there
        const standing = c.get(to);
        if (!standing || !mover) return false;
        let gain = captured ? PIECE_VAL[captured.type] : 0;   // what the move won outright
        let onSquare = PIECE_VAL[standing.type];              // what is now exposed there
        // cheapest opponent capture of that square, then our cheapest recapture, alternating
        let side = 'them';
        const balance = [];
        for (let ply = 0; ply < 8; ply++) {
            const caps = c.moves({verbose: true}).filter(m => m.to === to && m.captured);
            if (!caps.length) break;
            caps.sort((a, b) => PIECE_VAL[a.piece] - PIECE_VAL[b.piece]);
            const cheapest = caps[0];
            balance.push({side, wins: onSquare, with: PIECE_VAL[cheapest.piece]});
            c.move({from: cheapest.from, to: cheapest.to, promotion: cheapest.promotion});
            onSquare = PIECE_VAL[cheapest.piece];
            side = side === 'them' ? 'us' : 'them';
        }
        if (!balance.length) return false;                    // nothing can take: nothing was offered
        // Walk the exchange from the back, the way a player does: at each point the side to move
        // takes only if taking leaves them better off.
        let value = 0;
        for (let i = balance.length - 1; i >= 0; i--) value = Math.max(0, balance[i].wins - value);
        // `value` is what the OPPONENT nets by starting the exchange; we paid `gain` less than that
        return value - gain > 0.5;
    } catch (e) {
        return false; // unparseable position or variant chess.js cannot read: never claim brilliance
    }
}

// Classify one played move.
//   rank        where it sat in the engine's list (1 = the engine's own move), or null
//   onlyMove    the position had exactly one legal move
//   isBook      still inside the opening book
//   secondWin   win% of the engine's SECOND choice, for "the only move that holds"
//   sacrifice   sacrificesMaterial() for this move, computed by the caller (it needs chess.js)
//   winBefore/winAfter are the mover's win% before and after, both already mover-relative.

function classify({winBefore, winAfter, rank, onlyMove, isBook, secondWin, sacrifice}) {
    const lost = Math.max(0, winBefore - winAfter);
    if (isBook) return 'book';
    if (onlyMove) return 'forced';                       // no credit and no blame for a forced move

    // BRILLIANT: material given up, the move is still (near) best, the position is not already
    // won, and it does not throw the game. A sacrifice in a position that was winning anyway is
    // just a good move played by someone who could afford it.
    if (sacrifice && lost < GOOD && winAfter >= 50 && winBefore < 90) return 'brilliant';

    // GREAT: the only move that holds the position. Measured against the engine's second choice --
    // if every other move loses a chunk of the game and this one does not, finding it was the move.
    if (rank === 1 && secondWin != null && (winAfter - secondWin) >= 10 && lost < GOOD) return 'great';

    // MISS: a winning position let go. Chess.com shows this instead of Mistake/Blunder when the
    // loss is specifically the win being dropped, which reads very differently from a slip.
    if (winBefore >= 75 && winAfter < 55 && lost >= INACCURACY) return 'miss';

    if (lost >= BLUNDER) return 'blunder';
    if (lost >= MISTAKE) return 'mistake';
    if (lost >= INACCURACY) return 'inaccuracy';
    if (rank === 1) return 'best';
    if (lost < GOOD) return 'excellent';
    return 'good';
}

// Best-to-worst, which is the order the report lists them in.
const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced',
                     'inaccuracy', 'mistake', 'miss', 'blunder'];

// ---- per-game statistics -----------------------------------------------------------------------
// `moves` is the analysed move list review.js builds: one entry per played move, each with
// {color, cpLoss, winBefore, winAfter, rank, klass, seconds, complexity, maiaMatch}.



// How each verdict is SHOWN. chess.com's own palette, so a class is the same colour wherever it
// appears, and a full word wherever there is room for one -- a strip of bare glyphs is unreadable
// unless you already know the scheme (reported: "i cant tell what is what").
const CLASS_LABEL = {brilliant: 'brilliant', great: 'great', best: 'best', excellent: 'excellent',
                     good: 'good', book: 'book', forced: 'forced', inaccuracy: 'inaccuracy',
                     mistake: 'mistake', miss: 'miss', blunder: 'blunder'};
const CLASS_GLYPH = {brilliant: '!!', great: '!', best: '\u2713', excellent: '\u2726', good: '\u00b7',
                     book: '\u25a4', forced: '=', inaccuracy: '?!', mistake: '?', miss: '\u2717',
                     blunder: '??'};
const CLASS_COLOR = {brilliant: '#26c2a3', great: '#5c8bb0', best: '#96bc4b', excellent: '#96bc4b',
                     good: '#96af8b', book: '#a88865', forced: '#8b8987', inaccuracy: '#f7c631',
                     mistake: '#e58f2a', miss: '#ff7769', blunder: '#fa412d'};
// worst first: what a player wants named is what went wrong, then what went unusually right
const CLASS_NOTABLE = ['blunder', 'miss', 'mistake', 'inaccuracy', 'brilliant', 'great'];

root.MephistoClassify = {CLASS_LABEL, CLASS_GLYPH, CLASS_COLOR, CLASS_NOTABLE,
                         winPercent, classify, sacrificesMaterial, CLASS_ORDER, isMateScore, MATE_CP, clamp,
                         BLUNDER, MISTAKE, INACCURACY, GOOD, PIECE_VAL};

})(typeof self !== 'undefined' ? self : globalThis);
