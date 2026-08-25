// Syzygy tablebase probing IN JAVASCRIPT -- a faithful port of python-chess's chess/syzygy.py
// (the exact code the native-host route runs), restricted to standard chess. Tables are plain
// ArrayBuffers (loaded from the extension's IndexedDB), so probing needs no filesystem, no
// native host and no network: the panel's tablebase feature works out of the box once the user
// has imported their .rtbw/.rtbz files.
//
// Port notes, for anyone diffing against the reference:
// - Constant tables (TRIANGLE .. MFACTOR) were EXTRACTED from the installed python-chess module
//   by script, never typed by hand.
// - Only decompress_pairs touches values wider than 2^53 (the 64-bit Huffman window), so `code`
//   and `d.base` are BigInt there and NOTHING else is -- every index/factor fits a double
//   exactly (6-man idx tops out around 2^39).
// - The board is chess.js (the copy this extension already ships) behind a tiny shim exposing
//   the same move categories the reference asks its bitboard Board for.
// - Variant branches (suicide/atomic/antichess) are dropped: local probing is standard chess
//   only, matching the .rtbw/.rtbz set a user would download.
// Verified move-for-move against python-chess on randomized 3-5 man positions (see the ladder).
'use strict';

(() => {

/* === constants extracted from chess.syzygy ==================================================== */
const TBPIECES = 7;
const TRIANGLE = [6, 0, 1, 2, 2, 1, 0, 6, 0, 7, 3, 4, 4, 3, 7, 0, 1, 3, 8, 5, 5, 8, 3, 1, 2, 4, 5, 9, 9, 5, 4, 2, 2, 4, 5, 9, 9, 5, 4, 2, 1, 3, 8, 5, 5, 8, 3, 1, 0, 7, 3, 4, 4, 3, 7, 0, 6, 0, 1, 2, 2, 1, 0, 6];
const INVTRIANGLE = [1, 2, 3, 10, 11, 19, 0, 9, 18, 27];
const LOWER = [28, 0, 1, 2, 3, 4, 5, 6, 0, 29, 7, 8, 9, 10, 11, 12, 1, 7, 30, 13, 14, 15, 16, 17, 2, 8, 13, 31, 18, 19, 20, 21, 3, 9, 14, 18, 32, 22, 23, 24, 4, 10, 15, 19, 22, 33, 25, 26, 5, 11, 16, 20, 23, 25, 34, 27, 6, 12, 17, 21, 24, 26, 27, 35];
const DIAG = [0, 0, 0, 0, 0, 0, 0, 8, 0, 1, 0, 0, 0, 0, 9, 0, 0, 0, 2, 0, 0, 10, 0, 0, 0, 0, 0, 3, 11, 0, 0, 0, 0, 0, 0, 12, 4, 0, 0, 0, 0, 0, 13, 0, 0, 5, 0, 0, 0, 14, 0, 0, 0, 0, 6, 0, 15, 0, 0, 0, 0, 0, 0, 7];
const FLAP = [0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 12, 18, 18, 12, 6, 0, 1, 7, 13, 19, 19, 13, 7, 1, 2, 8, 14, 20, 20, 14, 8, 2, 3, 9, 15, 21, 21, 15, 9, 3, 4, 10, 16, 22, 22, 16, 10, 4, 5, 11, 17, 23, 23, 17, 11, 5, 0, 0, 0, 0, 0, 0, 0, 0];
const PTWIST = [0, 0, 0, 0, 0, 0, 0, 0, 47, 35, 23, 11, 10, 22, 34, 46, 45, 33, 21, 9, 8, 20, 32, 44, 43, 31, 19, 7, 6, 18, 30, 42, 41, 29, 17, 5, 4, 16, 28, 40, 39, 27, 15, 3, 2, 14, 26, 38, 37, 25, 13, 1, 0, 12, 24, 36, 0, 0, 0, 0, 0, 0, 0, 0];
const INVFLAP = [8, 16, 24, 32, 40, 48, 9, 17, 25, 33, 41, 49, 10, 18, 26, 34, 42, 50, 11, 19, 27, 35, 43, 51];
const FILE_TO_FILE = [0, 1, 2, 3, 3, 2, 1, 0];
const KK_IDX = [[-1, -1, -1, 0, 1, 2, 3, 4, -1, -1, -1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57], [58, -1, -1, -1, 59, 60, 61, 62, 63, -1, -1, -1, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115], [116, 117, -1, -1, -1, 118, 119, 120, 121, 122, -1, -1, -1, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173], [174, -1, -1, -1, 175, 176, 177, 178, 179, -1, -1, -1, 180, 181, 182, 183, 184, -1, -1, -1, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228], [229, 230, -1, -1, -1, 231, 232, 233, 234, 235, -1, -1, -1, 236, 237, 238, 239, 240, -1, -1, -1, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283], [284, 285, 286, 287, 288, 289, 290, 291, 292, 293, -1, -1, -1, 294, 295, 296, 297, 298, -1, -1, -1, 299, 300, 301, 302, 303, -1, -1, -1, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 338], [-1, -1, 339, 340, 341, 342, 343, 344, -1, -1, 345, 346, 347, 348, 349, 350, -1, -1, 441, 351, 352, 353, 354, 355, -1, -1, -1, 442, 356, 357, 358, 359, -1, -1, -1, -1, 443, 360, 361, 362, -1, -1, -1, -1, -1, 444, 363, 364, -1, -1, -1, -1, -1, -1, 445, 365, -1, -1, -1, -1, -1, -1, -1, 446], [-1, -1, -1, 366, 367, 368, 369, 370, -1, -1, -1, 371, 372, 373, 374, 375, -1, -1, -1, 376, 377, 378, 379, 380, -1, -1, -1, 447, 381, 382, 383, 384, -1, -1, -1, -1, 448, 385, 386, 387, -1, -1, -1, -1, -1, 449, 388, 389, -1, -1, -1, -1, -1, -1, 450, 390, -1, -1, -1, -1, -1, -1, -1, 451], [452, 391, 392, 393, 394, 395, 396, 397, -1, -1, -1, -1, 398, 399, 400, 401, -1, -1, -1, -1, 402, 403, 404, 405, -1, -1, -1, -1, 406, 407, 408, 409, -1, -1, -1, -1, 453, 410, 411, 412, -1, -1, -1, -1, -1, 454, 413, 414, -1, -1, -1, -1, -1, -1, 455, 415, -1, -1, -1, -1, -1, -1, -1, 456], [457, 416, 417, 418, 419, 420, 421, 422, -1, 458, 423, 424, 425, 426, 427, 428, -1, -1, -1, -1, -1, 429, 430, 431, -1, -1, -1, -1, -1, 432, 433, 434, -1, -1, -1, -1, -1, 435, 436, 437, -1, -1, -1, -1, -1, 459, 438, 439, -1, -1, -1, -1, -1, -1, 460, 440, -1, -1, -1, -1, -1, -1, -1, 461]];
const PP_IDX = [[0, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, -1, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61], [62, -1, -1, 63, 64, 65, -1, 66, -1, 67, 68, 69, 70, 71, 72, -1, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, -1, 97, 98, 99, 100, 101, 102, 103, -1, 104, 105, 106, 107, 108, 109, -1, 110, -1, 111, 112, 113, 114, -1, 115], [116, -1, -1, -1, 117, -1, -1, 118, -1, 119, 120, 121, 122, 123, 124, -1, -1, 125, 126, 127, 128, 129, 130, -1, 131, 132, 133, 134, 135, 136, 137, 138, -1, 139, 140, 141, 142, 143, 144, 145, -1, 146, 147, 148, 149, 150, 151, -1, -1, 152, 153, 154, 155, 156, 157, -1, 158, -1, -1, 159, 160, -1, -1, 161], [162, -1, -1, -1, -1, -1, -1, 163, -1, 164, -1, 165, 166, 167, 168, -1, -1, 169, 170, 171, 172, 173, 174, -1, -1, 175, 176, 177, 178, 179, 180, -1, -1, 181, 182, 183, 184, 185, 186, -1, -1, -1, 187, 188, 189, 190, 191, -1, -1, 192, 193, 194, 195, 196, 197, -1, 198, -1, -1, -1, -1, -1, -1, 199], [200, -1, -1, -1, -1, -1, -1, 201, -1, 202, -1, -1, 203, -1, 204, -1, -1, -1, 205, 206, 207, 208, -1, -1, -1, 209, 210, 211, 212, 213, 214, -1, -1, -1, 215, 216, 217, 218, 219, -1, -1, -1, 220, 221, 222, 223, -1, -1, -1, 224, -1, 225, 226, -1, 227, -1, 228, -1, -1, -1, -1, -1, -1, 229], [230, -1, -1, -1, -1, -1, -1, 231, -1, 232, -1, -1, -1, -1, 233, -1, -1, -1, 234, -1, 235, 236, -1, -1, -1, -1, 237, 238, 239, 240, -1, -1, -1, -1, -1, 241, 242, 243, -1, -1, -1, -1, 244, 245, 246, 247, -1, -1, -1, 248, -1, -1, -1, -1, 249, -1, 250, -1, -1, -1, -1, -1, -1, 251], [-1, -1, -1, -1, -1, -1, -1, 259, -1, 252, -1, -1, -1, -1, 260, -1, -1, -1, 253, -1, -1, 261, -1, -1, -1, -1, -1, 254, 262, -1, -1, -1, -1, -1, -1, -1, 255, -1, -1, -1, -1, -1, -1, -1, -1, 256, -1, -1, -1, -1, -1, -1, -1, -1, 257, -1, -1, -1, -1, -1, -1, -1, -1, 258], [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 268, -1, -1, -1, 263, -1, -1, 269, -1, -1, -1, -1, -1, 264, 270, -1, -1, -1, -1, -1, -1, -1, 265, -1, -1, -1, -1, -1, -1, -1, -1, 266, -1, -1, -1, -1, -1, -1, -1, -1, 267, -1, -1, -1, -1, -1, -1, -1, -1, -1], [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 274, -1, -1, -1, -1, -1, 271, 275, -1, -1, -1, -1, -1, -1, -1, 272, -1, -1, -1, -1, -1, -1, -1, -1, 273, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1], [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 277, -1, -1, -1, -1, -1, -1, -1, 276, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]];
// TEST45: not present
const MTWIST = [15, 63, 55, 47, 40, 48, 56, 12, 62, 11, 39, 31, 24, 32, 8, 57, 54, 38, 7, 23, 16, 4, 33, 49, 46, 30, 22, 3, 0, 17, 25, 41, 45, 29, 21, 2, 1, 18, 26, 42, 53, 37, 6, 20, 19, 5, 34, 50, 61, 10, 36, 28, 27, 35, 9, 58, 14, 60, 52, 44, 43, 51, 59, 13];
// BINOMIAL: not present
const PAWNIDX = [[0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5], [0, 47, 92, 135, 176, 215, 0, 35, 68, 99, 128, 155, 0, 23, 44, 63, 80, 95, 0, 11, 20, 27, 32, 35], [0, 1081, 2071, 2974, 3794, 4535, 0, 595, 1123, 1588, 1994, 2345, 0, 253, 463, 634, 770, 875, 0, 55, 91, 112, 122, 125], [0, 16215, 30405, 42746, 53406, 62545, 0, 6545, 12001, 16496, 20150, 23075, 0, 1771, 3101, 4070, 4750, 5205, 0, 165, 249, 284, 294, 295], [0, 178365, 327360, 450770, 552040, 634291, 0, 52360, 93280, 124745, 148496, 166046, 0, 8855, 14840, 18716, 21096, 22461, 0, 330, 456, 491, 496, 496]];
const PFACTOR = [[6, 6, 6, 6], [252, 180, 108, 36], [5201, 2645, 953, 125], [70315, 25375, 5491, 295], [700336, 178696, 23176, 496]];
const WDL_TO_MAP = [1, 3, 0, 2, 0];
const PA_FLAGS = [8, 0, 0, 0, 4];
const WDL_TO_DTZ = [-1, -101, 0, 101, 1];
const PCHR = ["K", "Q", "R", "B", "N", "P"];
const TABLENAME_REGEX = /^[KQRBNP]+v[KQRBNP]+\Z/;
const MULTIDX = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [0, 63, 118, 165, 204, 235, 258, 273, 284, 291], [0, 1953, 3438, 4519, 5260, 5725, 5978, 6083, 6138, 6159], [0, 39711, 65946, 82161, 91300, 95795, 97566, 98021, 98186, 98221], [0, 595665, 936720, 1115085, 1197336, 1228801, 1237656, 1239021, 1239351, 1239386]];
const MFACTOR = [10, 294, 6162, 98222, 1239386];
const TBW_MAGIC = [113, 232, 35, 93];
const TBZ_MAGIC = [215, 102, 12, 165];


const PCHR_ORDER = {K: 0, Q: 1, R: 2, B: 3, N: 4, P: 5};

function offdiag(sq) { return (sq >> 3) - (sq & 7); }
function flipdiag(sq) { return ((sq >> 3) | (sq << 3)) & 63; }
// squares a5,a6,a7,b5,b6,c5 -- the reference tests a bitboard constant
const TEST45_SQUARES = new Set([32, 40, 48, 33, 41, 34]);
function test45(sq) { return TEST45_SQUARES.has(sq); }

function binom(x, y) {
    if (y < 0 || y > x) return 0;
    let r = 1;
    for (let i = 0; i < y; i++) r = r * (x - i) / (i + 1);
    return Math.round(r);
}

function subfactor(k, n) {
    let f = n, l = 1;
    for (let i = 1; i < k; i++) { f *= n - i; l *= i + 1; }
    return Math.round(f / l);
}

function dtzBeforeZeroing(wdl) {
    return ((wdl > 0 ? 1 : 0) - (wdl < 0 ? 1 : 0)) * (Math.abs(wdl) === 2 ? 1 : 101);
}

function normalizeTablename(name, mirror = false) {
    let [w, b] = name.split('v');
    const sortKey = (s) => [...s].sort((x, y) => PCHR_ORDER[x] - PCHR_ORDER[y]).join('');
    w = sortKey(w); b = sortKey(b);
    // the reference's comparison is deliberately CROSSED: (len(w), indices of b) < (len(b),
    // indices of w). Getting this wrong registers pawn tables under a mirrored orientation and
    // the probe then iterates zero pieces (found the hard way).
    const idx = (s) => [...s].map(c => PCHR_ORDER[c]);
    const lt = (a, c) => {
        for (let i = 0; i < Math.max(a.length, c.length); i++) {
            const x = a[i] ?? -1, y = c[i] ?? -1;
            if (x !== y) return x < y;
        }
        return false;
    };
    const swap = lt([w.length, ...idx(b)], [b.length, ...idx(w)]);
    return (mirror !== swap) ? b + 'v' + w : w + 'v' + b;
}

// Probing a position recurses into capture and promotion descendants, so those materials'
// tables must be LOADED alongside the root's -- this is the closure to fetch. Includes the
// root itself; ~10-80 names depending on pawns. Ported from the reference's _dependencies().
function tableDependencies(target) {
    const closed = new Set(['KvK']);
    const out = [];
    const stack = [normalizeTablename(target)];
    while (stack.length) {
        const name = stack.pop();
        if (closed.has(name) || name.length <= 2) continue;
        closed.add(name);
        out.push(name);
        const [w, b] = name.split('v');
        for (const p of 'QRBNP') {
            if (p !== 'P') {
                if (w.includes('P')) stack.push(normalizeTablename(w.replace('P', p) + 'v' + b));
                if (b.includes('P')) stack.push(normalizeTablename(w + 'v' + b.replace('P', p)));
            }
            if (w.includes(p) && w.length > 1) stack.push(normalizeTablename(w.replace(p, '') + 'v' + b));
            if (b.includes(p) && b.length > 1) stack.push(normalizeTablename(w + 'v' + b.replace(p, '')));
        }
    }
    return out;
}

function isTablename(name) {
    return name.length <= TBPIECES + 1 && /^[KQRBNP]+v[KQRBNP]+$/.test(name)
        && normalizeTablename(name) === name
        && name !== 'KvK' && name.startsWith('K') && name.includes('vK');
}

/* === the board shim over chess.js ============================================================= */
// python-chess piece types: PAWN=1 .. KING=6; colors WHITE=true/0-bit, BLACK adds bit 3.
const PT_LETTER = [null, 'p', 'n', 'b', 'r', 'q', 'k'];

class ShimBoard {
    constructor(ChessCtor, fen) {
        this.c = new ChessCtor();
        this.c.load(fen);
    }
    fen() { return this.c.fen(); }
    turnWhite() { return this.c.fen().split(' ')[1] === 'w'; }
    epSquare() { return this.c.fen().split(' ')[3] !== '-'; }
    castlingRights() { return this.c.fen().split(' ')[2] !== '-'; }
    halfmoveClock() { return parseInt(this.c.fen().split(' ')[4], 10) || 0; }
    isCheckmate() { return this.c.isCheckmate(); }
    push(mv) { this.c.move(mv); }
    pop() { this.c.undo(); }
    // ascending square indices (a1=0 .. h8=63) of one piece type of one color
    squaresOf(pieceType, white) {
        const want = PT_LETTER[pieceType], color = white ? 'w' : 'b';
        const out = [];
        const rows = this.c.board();
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const p = rows[r][f];
                if (p && p.type === want && p.color === color) out.push((7 - r) * 8 + f);
            }
        }
        return out;
    }
    menCount() {
        let n = 0;
        for (const row of this.c.board()) for (const p of row) if (p) n++;
        return n;
    }
    // occupied_co[turn] & ~pawns -- truthy iff the mover has ANY non-pawn piece (incl. the king)
    moverHasNonPawn() {
        const me = this.turnWhite() ? 'w' : 'b';
        for (const row of this.c.board()) {
            for (const p of row) if (p && p.color === me && p.type !== 'p') return true;
        }
        return false;
    }
    allMoves() { return this.c.moves({verbose: true}); }
    nonEpCaptures() { return this.allMoves().filter(m => m.flags.includes('c') && !m.flags.includes('e')); }
    epMoves() { return this.allMoves().filter(m => m.flags.includes('e')); }
    pawnQuiet() { return this.allMoves().filter(m => m.piece === 'p' && !m.flags.includes('c') && !m.flags.includes('e')); }
    nonPawnQuiet() { return this.allMoves().filter(m => m.piece !== 'p' && !m.flags.includes('c')); }
    isEp(m) { return m.flags.includes('e'); }
}

function calcKeyFromCounts(counts, mirror) {
    // counts = {wK,wQ,...,bP}; returns e.g. "KQvK"
    const side = (pref) => 'KQRBNP'.split('').map(t => t.repeat(counts[pref + t] || 0)).join('');
    return mirror ? side('b') + 'v' + side('w') : side('w') + 'v' + side('b');
}

function calcKey(board, mirror = false) {
    const counts = {};
    for (let pt = 1; pt <= 6; pt++) {
        counts['w' + 'PNBRQK'[pt - 1]] = board.squaresOf(pt, true).length;
        counts['b' + 'PNBRQK'[pt - 1]] = board.squaresOf(pt, false).length;
    }
    return calcKeyFromCounts(counts, mirror);
}

function recalcKey(pieces, mirror = false) {
    // pieces: list of 4-bit codes (type | color<<3)
    const w = mirror ? 8 : 0, b = mirror ? 0 : 8;
    const count = (v) => pieces.filter(p => p === v).length;
    const side = (base) => [6, 5, 4, 3, 2, 1].map((t, i) => 'KQRBNP'[i].repeat(count(t ^ base))).join('');
    return side(w) + 'v' + side(b);
}

class MissingTableError extends Error {}

/* === table files ============================================================================== */

class PairsData {}
class PawnFileData { constructor() { this.precomp = {}; this.factor = {}; this.pieces = {}; this.norm = {}; } }

class Table {
    constructor(name, buffer) {
        this.name = name;
        this.buf = new Uint8Array(buffer);
        this.view = new DataView(buffer);
        this.initialized = false;

        this.key = normalizeTablename(name);
        this.mirroredKey = normalizeTablename(name, true);
        this.symmetric = this.key === this.mirroredKey;
        this.num = name.length - 1;
        this.hasPawns = name.includes('P');

        const [blackPart, whitePart] = [name.split('v')[1], name.split('v')[0]];
        if (this.hasPawns) {
            this.pawns = [count(whitePart, 'P'), count(blackPart, 'P')];
            if (this.pawns[1] > 0 && (this.pawns[0] === 0 || this.pawns[1] < this.pawns[0])) {
                [this.pawns[0], this.pawns[1]] = [this.pawns[1], this.pawns[0]];
            }
        } else {
            let j = 0;
            for (const pt of 'KQRBNP') {
                if (count(blackPart, pt) === 1) j++;
                if (count(whitePart, pt) === 1) j++;
            }
            this.encType = j >= 3 ? 0 : 2;   // standard chess always has both kings -> 0 or 2
        }
    }

    checkMagic(magic) {
        if ((this.buf.length & 63) !== 16) throw new Error(`invalid file size: ${this.name}`);
        for (let i = 0; i < 4; i++) {
            if (this.buf[i] !== magic[i]) throw new Error(`invalid magic header: ${this.name}`);
        }
    }

    readU16(p) { return this.view.getUint16(p, true); }
    readU32(p) { return this.view.getUint32(p, true); }
    readU32BE(p) { return this.view.getUint32(p, false); }
    readU64BE(p) { return this.view.getBigUint64(p, false); }

    setupPairs(dataPtr, tbSize, sizeIdx, wdl) {
        const d = new PairsData();
        this._flags = this.buf[dataPtr];
        if (this.buf[dataPtr] & 0x80) {
            d.idxbits = 0;
            d.minLen = wdl ? this.buf[dataPtr + 1] : 0;   // captures_compulsory is suicide-only
            this._next = dataPtr + 2;
            this.size[sizeIdx + 0] = 0;
            this.size[sizeIdx + 1] = 0;
            this.size[sizeIdx + 2] = 0;
            return d;
        }

        d.blocksize = this.buf[dataPtr + 1];
        d.idxbits = this.buf[dataPtr + 2];

        const realNumBlocks = this.readU32(dataPtr + 4);
        const numBlocks = realNumBlocks + this.buf[dataPtr + 3];
        const maxLen = this.buf[dataPtr + 8];
        const minLen = this.buf[dataPtr + 9];
        const h = maxLen - minLen + 1;
        const numSyms = this.readU16(dataPtr + 10 + 2 * h);

        d.offset = dataPtr + 10;
        d.symlen = new Array(h * 8 + numSyms).fill(0);
        d.sympat = dataPtr + 12 + 2 * h;
        d.minLen = minLen;

        this._next = dataPtr + 12 + 2 * h + 3 * numSyms + (numSyms & 1);

        const numIndices = Math.floor((tbSize + (1 << d.idxbits) - 1) / (1 << d.idxbits));
        this.size[sizeIdx + 0] = 6 * numIndices;
        this.size[sizeIdx + 1] = 2 * numBlocks;
        this.size[sizeIdx + 2] = Math.pow(2, d.blocksize) * realNumBlocks;

        const tmp = new Array(numSyms).fill(0);
        for (let i = 0; i < numSyms; i++) {
            if (!tmp[i]) this.calcSymlen(d, i, tmp);
        }

        // the Huffman bases live in the top bits of a 64-bit window -> BigInt
        d.base = new Array(h).fill(0n);
        for (let i = h - 2; i >= 0; i--) {
            const v = (d.base[i + 1] + BigInt(this.readU16(d.offset + i * 2))
                       - BigInt(this.readU16(d.offset + i * 2 + 2))) / 2n;
            d.base[i] = v;
        }
        for (let i = 0; i < h; i++) d.base[i] <<= BigInt(64 - (minLen + i));

        d.offset -= 2 * d.minLen;
        return d;
    }

    setNormPiece(norm, pieces) {
        norm[0] = this.encType === 0 ? 3 : 2;
        let i = norm[0];
        while (i < this.num) {
            for (let j = i; j < this.num && pieces[j] === pieces[i]; j++) norm[i] += 1;
            i += norm[i];
        }
    }

    calcFactorsPiece(factor, order, norm) {
        const PIVFAC = [31332, 28056, 462];
        let n = 64 - norm[0];
        let f = 1, i = norm[0], k = 0;
        while (i < this.num || k === order) {
            if (k === order) {
                factor[0] = f;
                f *= PIVFAC[this.encType];
            } else {
                factor[i] = f;
                f *= subfactor(norm[i], n);
                n -= norm[i];
                i += norm[i];
            }
            k += 1;
        }
        return f;
    }

    calcFactorsPawn(factor, order, order2, norm, f) {
        let i = norm[0];
        if (order2 < 0x0f) i += norm[i];
        let n = 64 - i;
        let fac = 1, k = 0;
        while (i < this.num || k === order || k === order2) {
            if (k === order) {
                factor[0] = fac;
                fac *= PFACTOR[norm[0] - 1][f];
            } else if (k === order2) {
                factor[norm[0]] = fac;
                fac *= subfactor(norm[norm[0]], 48 - norm[0]);
            } else {
                factor[i] = fac;
                fac *= subfactor(norm[i], n);
                n -= norm[i];
                i += norm[i];
            }
            k += 1;
        }
        return fac;
    }

    setNormPawn(norm, pieces) {
        norm[0] = this.pawns[0];
        if (this.pawns[1]) norm[this.pawns[0]] = this.pawns[1];
        let i = this.pawns[0] + this.pawns[1];
        while (i < this.num) {
            for (let j = i; j < this.num && pieces[j] === pieces[i]; j++) norm[i] += 1;
            i += norm[i];
        }
    }

    calcSymlen(d, s, tmp) {
        const w = d.sympat + 3 * s;
        const s2 = (this.buf[w + 2] << 4) | (this.buf[w + 1] >> 4);
        if (s2 === 0x0fff) {
            d.symlen[s] = 0;
        } else {
            const s1 = ((this.buf[w + 1] & 0xf) << 8) | this.buf[w];
            if (!tmp[s1]) this.calcSymlen(d, s1, tmp);
            if (!tmp[s2]) this.calcSymlen(d, s2, tmp);
            d.symlen[s] = d.symlen[s1] + d.symlen[s2] + 1;
        }
        tmp[s] = 1;
    }

    pawnFile(pos) {
        for (let i = 1; i < this.pawns[0]; i++) {
            if (FLAP[pos[0]] > FLAP[pos[i]]) [pos[0], pos[i]] = [pos[i], pos[0]];
        }
        return FILE_TO_FILE[pos[0] & 0x07];
    }

    encodePiece(norm, pos, factor) {
        const n = this.num;
        let i, j, idx;

        if (this.encType < 3) {
            if (pos[0] & 0x04) for (i = 0; i < n; i++) pos[i] ^= 0x07;
            if (pos[0] & 0x20) for (i = 0; i < n; i++) pos[i] ^= 0x38;
            for (i = 0; i < n; i++) { if (offdiag(pos[i])) break; }
            if (i === n) i = n - 1;   // Python's loop variable survives with its last value
            if (i < (this.encType === 0 ? 3 : 2) && offdiag(pos[i]) > 0) {
                for (i = 0; i < n; i++) pos[i] = flipdiag(pos[i]);
            }
        }

        if (this.encType === 0) {   // 111
            i = pos[1] > pos[0] ? 1 : 0;
            j = (pos[2] > pos[0] ? 1 : 0) + (pos[2] > pos[1] ? 1 : 0);
            if (offdiag(pos[0])) {
                idx = TRIANGLE[pos[0]] * 63 * 62 + (pos[1] - i) * 62 + (pos[2] - j);
            } else if (offdiag(pos[1])) {
                idx = 6 * 63 * 62 + DIAG[pos[0]] * 28 * 62 + LOWER[pos[1]] * 62 + pos[2] - j;
            } else if (offdiag(pos[2])) {
                idx = 6 * 63 * 62 + 4 * 28 * 62 + DIAG[pos[0]] * 7 * 28 + (DIAG[pos[1]] - i) * 28 + LOWER[pos[2]];
            } else {
                idx = 6 * 63 * 62 + 4 * 28 * 62 + 4 * 7 * 28 + (DIAG[pos[0]] * 7 * 6) + (DIAG[pos[1]] - i) * 6 + (DIAG[pos[2]] - j);
            }
            i = 3;
        } else {                    // K2 (standard chess: KK_IDX)
            idx = KK_IDX[TRIANGLE[pos[0]]][pos[1]];
            i = 2;
        }

        idx *= factor[0];

        while (i < n) {
            const t = norm[i];
            for (j = i; j < i + t; j++) {
                for (let k = j + 1; k < i + t; k++) {
                    if (pos[j] > pos[k]) [pos[j], pos[k]] = [pos[k], pos[j]];
                }
            }
            let s = 0;
            for (let m = i; m < i + t; m++) {
                const p = pos[m];
                let jj = 0;
                for (let l = 0; l < i; l++) jj += p > pos[l] ? 1 : 0;
                s += binom(p - jj, m - i + 1);
            }
            idx += s * factor[i];
            i += t;
        }

        return idx;
    }

    encodePawn(norm, pos, factor) {
        const n = this.num;
        let i, j, idx;

        if (pos[0] & 0x04) for (i = 0; i < n; i++) pos[i] ^= 0x07;

        for (i = 1; i < this.pawns[0]; i++) {
            for (j = i + 1; j < this.pawns[0]; j++) {
                if (PTWIST[pos[i]] < PTWIST[pos[j]]) [pos[i], pos[j]] = [pos[j], pos[i]];
            }
        }

        let t = this.pawns[0] - 1;
        idx = PAWNIDX[t][FLAP[pos[0]]];
        for (i = t; i > 0; i--) idx += binom(PTWIST[pos[i]], t - i + 1);
        idx *= factor[0];

        // remaining pawns
        i = this.pawns[0];
        t = i + this.pawns[1];
        if (t > i) {
            for (j = i; j < t; j++) {
                for (let k = j + 1; k < t; k++) {
                    if (pos[j] > pos[k]) [pos[j], pos[k]] = [pos[k], pos[j]];
                }
            }
            let s = 0;
            for (let m = i; m < t; m++) {
                const p = pos[m];
                let jj = 0;
                for (let k = 0; k < i; k++) jj += p > pos[k] ? 1 : 0;
                s += binom(p - jj - 8, m - i + 1);
            }
            idx += s * factor[i];
            i = t;
        }

        while (i < n) {
            t = norm[i];
            for (j = i; j < i + t; j++) {
                for (let k = j + 1; k < i + t; k++) {
                    if (pos[j] > pos[k]) [pos[j], pos[k]] = [pos[k], pos[j]];
                }
            }
            let s = 0;
            for (let m = i; m < i + t; m++) {
                const p = pos[m];
                let jj = 0;
                for (let k = 0; k < i; k++) jj += p > pos[k] ? 1 : 0;
                s += binom(p - jj, m - i + 1);
            }
            idx += s * factor[i];
            i += t;
        }

        return idx;
    }

    decompressPairs(d, idx) {
        if (!d.idxbits) return d.minLen;

        const mainidx = Math.floor(idx / Math.pow(2, d.idxbits));
        let litidx = (idx % Math.pow(2, d.idxbits)) - Math.pow(2, d.idxbits - 1);
        let block = this.readU32(d.indextable + 6 * mainidx);

        litidx += this.readU16(d.indextable + 6 * mainidx + 4);

        if (litidx < 0) {
            while (litidx < 0) {
                block -= 1;
                litidx += this.readU16(d.sizetable + 2 * block) + 1;
            }
        } else {
            while (litidx > this.readU16(d.sizetable + 2 * block)) {
                litidx -= this.readU16(d.sizetable + 2 * block) + 1;
                block += 1;
            }
        }

        let ptr = d.data + block * Math.pow(2, d.blocksize);

        const m = d.minLen;
        let sym = 0;

        let code = this.readU64BE(ptr);   // the 64-bit Huffman window: BigInt
        ptr += 8;
        let bitcnt = 0;
        for (;;) {
            let l = m;
            while (code < d.base[l - m]) l += 1;
            sym = this.readU16(d.offset + l * 2);
            sym += Number((code - d.base[l - m]) >> BigInt(64 - l));
            if (litidx < d.symlen[sym] + 1) break;
            litidx -= d.symlen[sym] + 1;
            code = (code << BigInt(l)) & 0xffffffffffffffffn;
            bitcnt += l;
            if (bitcnt >= 32) {
                bitcnt -= 32;
                code |= BigInt(this.readU32BE(ptr)) << BigInt(bitcnt);
                ptr += 4;
                code &= 0xffffffffffffffffn;
            }
        }

        const sympat = d.sympat;
        while (d.symlen[sym]) {
            const w = sympat + 3 * sym;
            const s1 = ((this.buf[w + 1] & 0xf) << 8) | this.buf[w];
            if (litidx < d.symlen[s1] + 1) {
                sym = s1;
            } else {
                litidx -= d.symlen[s1] + 1;
                sym = (this.buf[w + 2] << 4) | (this.buf[w + 1] >> 4);
            }
        }

        const w = sympat + 3 * sym;
        if (this.isDtz) return ((this.buf[w + 1] & 0x0f) << 8) | this.buf[w];
        return this.buf[w];
    }
}

function count(s, ch) { let n = 0; for (const c of s) if (c === ch) n++; return n; }

class WdlTable extends Table {
    initTableWdl() {
        if (this.initialized) return;
        this.checkMagic(TBW_MAGIC);

        this.tbSize = new Array(8).fill(0);
        this.size = new Array(24).fill(0);
        this.precomp = {};
        this.pieces = {};
        this.factor = [new Array(TBPIECES).fill(0), new Array(TBPIECES).fill(0)];
        this.norm = [new Array(this.num).fill(0), new Array(this.num).fill(0)];
        this.files = [new PawnFileData(), new PawnFileData(), new PawnFileData(), new PawnFileData()];

        const split = this.buf[4] & 0x01;
        const files = (this.buf[4] & 0x02) ? 4 : 1;

        let dataPtr = 5;

        if (!this.hasPawns) {
            this.setupPiecesPiece(dataPtr);
            dataPtr += this.num + 1;
            dataPtr += dataPtr & 0x01;

            this.precomp[0] = this.setupPairs(dataPtr, this.tbSize[0], 0, true);
            dataPtr = this._next;
            if (split) {
                this.precomp[1] = this.setupPairs(dataPtr, this.tbSize[1], 3, true);
                dataPtr = this._next;
            }

            this.precomp[0].indextable = dataPtr;
            dataPtr += this.size[0];
            if (split) { this.precomp[1].indextable = dataPtr; dataPtr += this.size[3]; }

            this.precomp[0].sizetable = dataPtr;
            dataPtr += this.size[1];
            if (split) { this.precomp[1].sizetable = dataPtr; dataPtr += this.size[4]; }

            dataPtr = (dataPtr + 0x3f) & ~0x3f;
            this.precomp[0].data = dataPtr;
            dataPtr += this.size[2];
            if (split) {
                dataPtr = (dataPtr + 0x3f) & ~0x3f;
                this.precomp[1].data = dataPtr;
            }

            this.key = recalcKey(this.pieces[0]);
            this.mirroredKey = recalcKey(this.pieces[0], true);
        } else {
            const s = 1 + (this.pawns[1] > 0 ? 1 : 0);
            for (let f = 0; f < 4; f++) {
                this.setupPiecesPawn(dataPtr, 2 * f, f);
                dataPtr += this.num + s;
            }
            dataPtr += dataPtr & 0x01;

            for (let f = 0; f < files; f++) {
                this.files[f].precomp[0] = this.setupPairs(dataPtr, this.tbSize[2 * f], 6 * f, true);
                dataPtr = this._next;
                if (split) {
                    this.files[f].precomp[1] = this.setupPairs(dataPtr, this.tbSize[2 * f + 1], 6 * f + 3, true);
                    dataPtr = this._next;
                }
            }
            for (let f = 0; f < files; f++) {
                this.files[f].precomp[0].indextable = dataPtr;
                dataPtr += this.size[6 * f];
                if (split) { this.files[f].precomp[1].indextable = dataPtr; dataPtr += this.size[6 * f + 3]; }
            }
            for (let f = 0; f < files; f++) {
                this.files[f].precomp[0].sizetable = dataPtr;
                dataPtr += this.size[6 * f + 1];
                if (split) { this.files[f].precomp[1].sizetable = dataPtr; dataPtr += this.size[6 * f + 4]; }
            }
            for (let f = 0; f < files; f++) {
                dataPtr = (dataPtr + 0x3f) & ~0x3f;
                this.files[f].precomp[0].data = dataPtr;
                dataPtr += this.size[6 * f + 2];
                if (split) {
                    dataPtr = (dataPtr + 0x3f) & ~0x3f;
                    this.files[f].precomp[1].data = dataPtr;
                    dataPtr += this.size[6 * f + 5];
                }
            }
        }

        this.initialized = true;
    }

    setupPiecesPawn(pData, pTbSize, f) {
        const j = 1 + (this.pawns[1] > 0 ? 1 : 0);
        let order = this.buf[pData] & 0x0f;
        let order2 = this.pawns[1] ? (this.buf[pData + 1] & 0x0f) : 0x0f;
        this.files[f].pieces[0] = [];
        for (let i = 0; i < this.num; i++) this.files[f].pieces[0].push(this.buf[pData + i + j] & 0x0f);
        this.files[f].norm[0] = new Array(this.num).fill(0);
        this.setNormPawn(this.files[f].norm[0], this.files[f].pieces[0]);
        this.files[f].factor[0] = new Array(TBPIECES).fill(0);
        this.tbSize[pTbSize] = this.calcFactorsPawn(this.files[f].factor[0], order, order2, this.files[f].norm[0], f);

        order = this.buf[pData] >> 4;
        order2 = this.pawns[1] ? (this.buf[pData + 1] >> 4) : 0x0f;
        this.files[f].pieces[1] = [];
        for (let i = 0; i < this.num; i++) this.files[f].pieces[1].push(this.buf[pData + i + j] >> 4);
        this.files[f].norm[1] = new Array(this.num).fill(0);
        this.setNormPawn(this.files[f].norm[1], this.files[f].pieces[1]);
        this.files[f].factor[1] = new Array(TBPIECES).fill(0);
        this.tbSize[pTbSize + 1] = this.calcFactorsPawn(this.files[f].factor[1], order, order2, this.files[f].norm[1], f);
    }

    setupPiecesPiece(pData) {
        this.pieces[0] = [];
        for (let i = 0; i < this.num; i++) this.pieces[0].push(this.buf[pData + i + 1] & 0x0f);
        let order = this.buf[pData] & 0x0f;
        this.setNormPiece(this.norm[0], this.pieces[0]);
        this.tbSize[0] = this.calcFactorsPiece(this.factor[0], order, this.norm[0]);

        this.pieces[1] = [];
        for (let i = 0; i < this.num; i++) this.pieces[1].push(this.buf[pData + i + 1] >> 4);
        order = this.buf[pData] >> 4;
        this.setNormPiece(this.norm[1], this.pieces[1]);
        this.tbSize[1] = this.calcFactorsPiece(this.factor[1], order, this.norm[1]);
    }

    probeWdlTable(board) {
        this.initTableWdl();

        const key = calcKey(board);
        let cmirror, mirror, bside;
        if (!this.symmetric) {
            if (key !== this.key) {
                cmirror = 8; mirror = 0x38;
                bside = board.turnWhite() ? 1 : 0;
            } else {
                cmirror = mirror = 0;
                bside = board.turnWhite() ? 0 : 1;
            }
        } else {
            cmirror = board.turnWhite() ? 0 : 8;
            mirror = board.turnWhite() ? 0 : 0x38;
            bside = 0;
        }

        let res;
        if (!this.hasPawns) {
            const p = new Array(TBPIECES).fill(0);
            let i = 0;
            while (i < this.num) {
                const before = i;
                const pieceType = this.pieces[bside][i] & 0x07;
                const color = (this.pieces[bside][i] ^ cmirror) >> 3;
                for (const square of board.squaresOf(pieceType, color === 0)) {
                    p[i] = square;
                    i += 1;
                }
                if (i === before) throw new Error(`piece fill stalled: ${this.name} vs ${board.fen()}`);
            }
            const idx = this.encodePiece(this.norm[bside], p, this.factor[bside]);
            res = this.decompressPairs(this.precomp[bside], idx);
        } else {
            const p = new Array(TBPIECES).fill(0);
            let i = 0;
            const k = this.files[0].pieces[0][0] ^ cmirror;
            let color = k >> 3;
            let pieceType = k & 0x07;
            for (const square of board.squaresOf(pieceType, color === 0)) {
                p[i] = square ^ mirror;
                i += 1;
            }
            const f = this.pawnFile(p);
            const pc = this.files[f].pieces[bside];
            while (i < this.num) {
                const before = i;
                color = (pc[i] ^ cmirror) >> 3;
                pieceType = pc[i] & 0x07;
                for (const square of board.squaresOf(pieceType, color === 0)) {
                    p[i] = square ^ mirror;
                    i += 1;
                }
                if (i === before) throw new Error(`pawn fill stalled: ${this.name} vs ${board.fen()}`);
            }
            const idx = this.encodePawn(this.files[f].norm[bside], p, this.files[f].factor[bside]);
            res = this.decompressPairs(this.files[f].precomp[bside], idx);
        }

        return res - 2;
    }
}

class DtzTable extends Table {
    constructor(name, buffer) { super(name, buffer); this.isDtz = true; }

    initTableDtz() {
        if (this.initialized) return;
        this.checkMagic(TBZ_MAGIC);

        this.factor = new Array(TBPIECES).fill(0);
        this.norm = new Array(this.num).fill(0);
        this.tbSize = [0, 0, 0, 0];
        this.size = new Array(12).fill(0);
        this.files = [{}, {}, {}, {}];

        const files = (this.buf[4] & 0x02) ? 4 : 1;

        let pData = 5;

        if (!this.hasPawns) {
            this.mapIdx = [[0, 0, 0, 0]];

            this.setupPiecesPieceDtz(pData, 0);
            pData += this.num + 1;
            pData += pData & 0x01;

            this.precomp = this.setupPairs(pData, this.tbSize[0], 0, false);
            this.flags = this._flags;
            pData = this._next;
            this.pMap = pData;
            if (this.flags & 2) {
                if (!(this.flags & 16)) {
                    for (let i = 0; i < 4; i++) {
                        this.mapIdx[0][i] = pData + 1 - this.pMap;
                        pData += 1 + this.buf[pData];
                    }
                } else {
                    for (let i = 0; i < 4; i++) {
                        this.mapIdx[0][i] = (pData + 2 - this.pMap) / 2;
                        pData += 2 + 2 * this.readU16(pData);
                    }
                }
            }
            pData += pData & 0x01;

            this.precomp.indextable = pData;
            pData += this.size[0];
            this.precomp.sizetable = pData;
            pData += this.size[1];
            pData = (pData + 0x3f) & ~0x3f;
            this.precomp.data = pData;
            pData += this.size[2];

            this.key = recalcKey(this.pieces);
            this.mirroredKey = recalcKey(this.pieces, true);
        } else {
            const s = 1 + (this.pawns[1] > 0 ? 1 : 0);
            for (let f = 0; f < 4; f++) {
                this.setupPiecesPawnDtz(pData, f, f);
                pData += this.num + s;
            }
            pData += pData & 0x01;

            this.flags = [];
            for (let f = 0; f < files; f++) {
                this.files[f].precomp = this.setupPairs(pData, this.tbSize[f], 3 * f, false);
                pData = this._next;
                this.flags.push(this._flags);
            }

            this.mapIdx = [];
            this.pMap = pData;
            for (let f = 0; f < files; f++) {
                this.mapIdx.push([]);
                if (this.flags[f] & 2) {
                    if (!(this.flags[f] & 16)) {
                        for (let i = 0; i < 4; i++) {
                            this.mapIdx[this.mapIdx.length - 1].push(pData + 1 - this.pMap);
                            pData += 1 + this.buf[pData];
                        }
                    } else {
                        pData += pData & 0x01;
                        for (let i = 0; i < 4; i++) {
                            this.mapIdx[this.mapIdx.length - 1].push((pData + 2 - this.pMap) / 2);
                            pData += 2 + 2 * this.readU16(pData);
                        }
                    }
                }
            }
            pData += pData & 0x01;

            for (let f = 0; f < files; f++) {
                this.files[f].precomp.indextable = pData;
                pData += this.size[3 * f];
            }
            for (let f = 0; f < files; f++) {
                this.files[f].precomp.sizetable = pData;
                pData += this.size[3 * f + 1];
            }
            for (let f = 0; f < files; f++) {
                pData = (pData + 0x3f) & ~0x3f;
                this.files[f].precomp.data = pData;
                pData += this.size[3 * f + 2];
            }
        }

        this.initialized = true;
    }

    probeDtzTable(board, wdl) {
        this.initTableDtz();

        const key = calcKey(board);
        let cmirror, mirror, bside;
        if (!this.symmetric) {
            if (key !== this.key) {
                cmirror = 8; mirror = 0x38;
                bside = board.turnWhite() ? 1 : 0;
            } else {
                cmirror = mirror = 0;
                bside = board.turnWhite() ? 0 : 1;
            }
        } else {
            cmirror = board.turnWhite() ? 0 : 8;
            mirror = board.turnWhite() ? 0 : 0x38;
            bside = 0;
        }

        let res;
        if (!this.hasPawns) {
            if ((this.flags & 1) !== bside && !this.symmetric) return [0, -1];

            const pc = this.pieces;
            const p = new Array(TBPIECES).fill(0);
            let i = 0;
            while (i < this.num) {
                const before = i;
                const pieceType = pc[i] & 0x07;
                const color = (pc[i] ^ cmirror) >> 3;
                for (const square of board.squaresOf(pieceType, color === 0)) {
                    p[i] = square;
                    i += 1;
                }
                if (i === before) throw new Error(`dtz piece fill stalled: ${this.name} vs ${board.fen()}`);
            }
            const idx = this.encodePiece(this.norm, p, this.factor);
            res = this.decompressPairs(this.precomp, idx);

            if (this.flags & 2) {
                if (!(this.flags & 16)) {
                    res = this.buf[this.pMap + this.mapIdx[0][WDL_TO_MAP[wdl + 2]] + res];
                } else {
                    res = this.readU16(this.pMap + 2 * (this.mapIdx[0][WDL_TO_MAP[wdl + 2]] + res));
                }
            }
            if (!(this.flags & PA_FLAGS[wdl + 2]) || (wdl & 1)) res *= 2;
        } else {
            const k = this.files[0].pieces[0] ^ cmirror;
            let pieceType = k & 0x07;
            let color = k >> 3;

            let i = 0;
            const p = new Array(TBPIECES).fill(0);
            for (const square of board.squaresOf(pieceType, color === 0)) {
                p[i] = square ^ mirror;
                i += 1;
            }
            const f = this.pawnFile(p);
            if ((this.flags[f] & 1) !== bside) return [0, -1];

            const pc = this.files[f].pieces;
            while (i < this.num) {
                const before = i;
                pieceType = pc[i] & 0x07;
                color = (pc[i] ^ cmirror) >> 3;
                for (const square of board.squaresOf(pieceType, color === 0)) {
                    p[i] = square ^ mirror;
                    i += 1;
                }
                if (i === before) throw new Error(`dtz pawn fill stalled: ${this.name} vs ${board.fen()}`);
            }
            const idx = this.encodePawn(this.files[f].norm, p, this.files[f].factor);
            res = this.decompressPairs(this.files[f].precomp, idx);

            if (this.flags[f] & 2) {
                if (!(this.flags[f] & 16)) {
                    res = this.buf[this.pMap + this.mapIdx[f][WDL_TO_MAP[wdl + 2]] + res];
                } else {
                    res = this.readU16(this.pMap + 2 * (this.mapIdx[f][WDL_TO_MAP[wdl + 2]] + res));
                }
            }
            if (!(this.flags[f] & PA_FLAGS[wdl + 2]) || (wdl & 1)) res *= 2;
        }

        return [res, 1];
    }

    setupPiecesPieceDtz(pData, pTbSize) {
        this.pieces = [];
        for (let i = 0; i < this.num; i++) this.pieces.push(this.buf[pData + i + 1] & 0x0f);
        const order = this.buf[pData] & 0x0f;
        this.setNormPiece(this.norm, this.pieces);
        this.tbSize[pTbSize] = this.calcFactorsPiece(this.factor, order, this.norm);
    }

    setupPiecesPawnDtz(pData, pTbSize, f) {
        const j = 1 + (this.pawns[1] > 0 ? 1 : 0);
        const order = this.buf[pData] & 0x0f;
        const order2 = this.pawns[1] ? (this.buf[pData + 1] & 0x0f) : 0x0f;
        this.files[f].pieces = [];
        for (let i = 0; i < this.num; i++) this.files[f].pieces.push(this.buf[pData + i + j] & 0x0f);
        this.files[f].norm = new Array(this.num).fill(0);
        this.setNormPawn(this.files[f].norm, this.files[f].pieces);
        this.files[f].factor = new Array(TBPIECES).fill(0);
        this.tbSize[pTbSize] = this.calcFactorsPawn(this.files[f].factor, order, order2, this.files[f].norm, f);
    }
}

/* === the probing front-end ==================================================================== */

class Tablebase {
    constructor(ChessCtor) {
        this.Chess = ChessCtor;
        this.wdl = {};   // normalized name -> WdlTable (registered under key AND mirrored key)
        this.dtz = {};
    }

    // filename e.g. "KQvK.rtbw"; buffer is the whole file
    addBuffer(filename, buffer) {
        const dot = filename.lastIndexOf('.');
        const name = filename.slice(0, dot);
        const ext = filename.slice(dot + 1).toLowerCase();
        if (!isTablename(normalizeTablename(name)) && name !== normalizeTablename(name)) {
            throw new Error(`not a syzygy table name: ${filename}`);
        }
        if (ext === 'rtbw') {
            const table = new WdlTable(name, buffer);
            table.checkMagic(TBW_MAGIC);   // validate at the door, not mid-game
            this.wdl[table.key] = table;
            this.wdl[table.mirroredKey] = table;
        } else if (ext === 'rtbz') {
            const table = new DtzTable(name, buffer);
            table.checkMagic(TBZ_MAGIC);
            this.dtz[table.key] = table;
            this.dtz[table.mirroredKey] = table;
        } else {
            throw new Error(`not a syzygy table file: ${filename}`);
        }
    }

    largestWdl() {
        let n = 0;
        for (const k in this.wdl) n = Math.max(n, k.length - 1);
        return n;
    }

    probeWdlTable(board) {
        if (board.menCount() === 2) return 0;   // KvK

        const key = calcKey(board);
        const table = this.wdl[key];
        if (!table) {
            if (board.menCount() > TBPIECES) throw new Error(`too many pieces: ${board.fen()}`);
            throw new MissingTableError(`did not find wdl table ${key}`);
        }
        return table.probeWdlTable(board);
    }

    probeAb(board, alpha, beta, threats = false) {
        if (board.castlingRights()) throw new Error(`castling rights: ${board.fen()}`);
        if (board.menCount() > TBPIECES + 1) throw new Error(`too many pieces: ${board.fen()}`);

        // resolve non-ep captures
        for (const move of board.nonEpCaptures()) {
            board.push(move);
            let vPlus;
            try {
                [vPlus] = this.probeAb(board, -beta, -alpha);
            } finally {
                board.pop();
            }
            const v = -vPlus;
            if (v > alpha) {
                if (v >= beta) return [v, 2];
                alpha = v;
            }
        }

        const v = this.probeWdlTable(board);
        if (alpha >= v) return [alpha, 1 + (alpha > 0 ? 1 : 0)];
        return [v, 1];
    }

    probeWdl(board) {
        let [v] = this.probeAb(board, -2, 2);
        if (!board.epSquare()) return v;

        let v1 = -3;
        for (const move of board.epMoves()) {
            board.push(move);
            let v0Plus;
            try {
                [v0Plus] = this.probeAb(board, -2, 2);
            } finally {
                board.pop();
            }
            const v0 = -v0Plus;
            if (v0 > v1) v1 = v0;
        }

        if (v1 > -3) {
            if (v1 >= v) {
                v = v1;
            } else if (v === 0) {
                if (board.allMoves().every(m => board.isEp(m))) v = v1;
            }
        }
        return v;
    }

    probeDtzTable(board, wdl) {
        const key = calcKey(board);
        const table = this.dtz[key];
        if (!table) throw new MissingTableError(`did not find dtz table ${key}`);
        return table.probeDtzTable(board, wdl);
    }

    probeDtzNoEp(board) {
        let [wdl, success] = this.probeAb(board, -2, 2, true);

        if (wdl === 0) return 0;
        if (success === 2 || !board.moverHasNonPawn()) return dtzBeforeZeroing(wdl);

        if (wdl > 0) {
            // (threats only exist in captures-compulsory variants; success 3 cannot happen here)
            for (const move of board.pawnQuiet()) {
                board.push(move);
                let v;
                try {
                    v = -this.probeWdl(board);
                } finally {
                    board.pop();
                }
                if (v === wdl) return v === 2 ? 1 : 101;
            }
        }

        const [dtz, ok] = this.probeDtzTable(board, wdl);
        if (ok >= 0) return dtzBeforeZeroing(wdl) + (wdl > 0 ? dtz : -dtz);

        if (wdl > 0) {
            let best = 0xffff;
            for (const move of board.nonPawnQuiet()) {
                board.push(move);
                try {
                    const v = -this.probeDtz(board);
                    if (v === 1 && board.isCheckmate()) {
                        best = 1;
                    } else if (v > 0 && v + 1 < best) {
                        best = v + 1;
                    }
                } finally {
                    board.pop();
                }
            }
            return best;
        } else {
            let best = -1;
            for (const move of board.allMoves()) {
                board.push(move);
                let v;
                try {
                    if (board.halfmoveClock() === 0) {
                        if (wdl === -2) {
                            v = -1;
                        } else {
                            const [vv] = this.probeAb(board, 1, 2, true);
                            v = vv === 2 ? 0 : -101;
                        }
                    } else {
                        v = -this.probeDtz(board) - 1;
                    }
                } finally {
                    board.pop();
                }
                if (v < best) best = v;
            }
            return best;
        }
    }

    probeDtz(board) {
        let v = this.probeDtzNoEp(board);
        if (!board.epSquare()) return v;

        let v1 = -3;
        for (const move of board.epMoves()) {
            board.push(move);
            let v0Plus;
            try {
                [v0Plus] = this.probeAb(board, -2, 2);
            } finally {
                board.pop();
            }
            const v0 = -v0Plus;
            if (v0 > v1) v1 = v0;
        }

        if (v1 > -3) {
            v1 = WDL_TO_DTZ[v1 + 2];
            if (v < -100) {
                if (v1 >= 0) v = v1;
            } else if (v < 0) {
                if (v1 >= 0 || v1 < -100) v = v1;
            } else if (v > 100) {
                if (v1 > 0) v = v1;
            } else if (v > 0) {
                if (v1 === 1) v = v1;
            } else if (v1 >= 0) {
                v = v1;
            } else {
                if (board.allMoves().every(m => board.isEp(m))) v = v1;
            }
        }
        return v;
    }

    // The lichess-API-shaped answer the panel consumes: root verdict plus every legal move ranked
    // best-first, each move's category/dtz from the perspective of the side to move AFTER it (a
    // move to 'loss' loses for THEM). The ORDER replicates lila-tablebase's MoveInfo::sort_key:
    // category, then a mating move, then (for the winning side) ZEROING moves -- a clean capture
    // or pawn push resets the 50-move clock and makes irreversible progress -- then dtz. Sorting
    // by dtz alone repeated checks forever: after a capture the child dtz restarts counting the
    // NEXT phase, so the capture sorted behind the check that merely kept it available, and
    // autoplay shuffled a won game into a repetition draw (found live, 2026-08-25).
    probeResponse(fen) {
        const CATEGORY = {'2': 'win', '1': 'cursed-win', '0': 'draw', '-1': 'blessed-loss', '-2': 'loss'};
        const board = new ShimBoard(this.Chess, fen);
        if (board.castlingRights()) throw new Error('castling rights: syzygy cannot represent them');

        const wdl = this.probeWdl(board);
        const dtz = this.probeDtz(board);

        const moves = [];
        for (const mv of board.allMoves()) {
            board.push(mv);
            let childWdl, childDtz, mate, stale;
            try {
                childWdl = this.probeWdl(board);
                childDtz = this.probeDtz(board);
                mate = board.isCheckmate();
                stale = board.allMoves().length === 0 && !mate;
            } finally {
                board.pop();
            }
            moves.push({
                uci: mv.lan, san: mv.san,
                category: CATEGORY[String(childWdl)] || 'unknown', dtz: childDtz,
                checkmate: mate, stalemate: stale,
                zeroing: mv.flags.includes('c') || mv.flags.includes('e') || mv.piece === 'p',
            });
        }
        sortMovesLikeLichess(moves);
        return {category: CATEGORY[String(wdl)] || 'unknown', dtz, moves, source: 'local'};
    }
}

// lila-tablebase's MoveInfo::sort_key, translated. Each move's fields are from the perspective
// of the side to move AFTER it: a negative-for-them category ('loss'/'blessed-loss') is a move
// WE want. Terms, in order: category; a mating move; a stalemating move (the best a drawn
// position offers); dtm when EVERY move carries one (merged from the online answer -- Syzygy
// files hold no mate distances); zeroing preferred while winning and avoided while losing;
// then dtz, fastest win first / longest defense first.
function sortMovesLikeLichess(moves) {
    const rank = {loss: 0, 'blessed-loss': 1, draw: 2, 'cursed-win': 3, win: 4, unknown: 5};
    // lila: zeroing ^ !category.is_positive() -- positive means THEY win (win/cursed-win), so
    // zeroing is preferred for loss/blessed-loss/draw children and avoided when we are losing
    const preferZeroing = (m) => m.category !== 'win' && m.category !== 'cursed-win';
    const allDtm = moves.length > 0 && moves.every(m => typeof m.dtm === 'number');
    moves.sort((a, b) =>
        (rank[a.category] - rank[b.category])
        || ((b.checkmate ? 1 : 0) - (a.checkmate ? 1 : 0))
        || ((b.stalemate ? 1 : 0) - (a.stalemate ? 1 : 0))
        || (allDtm ? (b.dtm - a.dtm) : 0)
        || (((b.zeroing === preferZeroing(b)) ? 1 : 0) - ((a.zeroing === preferZeroing(a)) ? 1 : 0))
        || (b.dtz - a.dtz));
    return moves;
}

const api = {Tablebase, ShimBoard, MissingTableError, isTablename, normalizeTablename, tableDependencies, calcKey, sortMovesLikeLichess, TBW_MAGIC, TBZ_MAGIC};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else self.MephistoSyzygy = api;

})();
