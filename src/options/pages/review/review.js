import {define} from "../../framework/require.js";
import {wirePgnDrop} from "../../util/dragdrop.js";
import {refreshLimitWarnings} from "../../util/limits.js";
import {EE_VERSION, EE_CLASS, eeCached, eeDownload, eeForget, eeRun, eeCommands, eeVersion, eeNewer, eeCheckUpdate, eeUpdate, SF_BUILD, SF16_BUILD, EE_TIERS, eeTier, sfCached, sfDownload, sfForget, sfSearch} from "./ee-host.js";

// Game Review: analyse a finished game on THIS page, in the background, with the extension's own
// engines. Nothing is uploaded -- the PGN stays in the tab, the engine runs in the offscreen
// document (or a native host on this machine), and the report is built here.
//
// The arithmetic lives in review-core.js so it can be run under node (test_popup_logic.js drives it
// directly). This file is the page: engine plumbing, rendering, and the export.
//
// HOW A REVIEW IS COMPUTED. Every position of the game is analysed once, from the start position to
// the final one -- N+1 searches for N moves, not 2N. The score BEFORE a move is that position's own
// evaluation; the score AFTER it is the NEXT position's evaluation, which is already being computed
// for the next move anyway. That is also what makes the played move comparable with the engine's:
// both are measured by the same search at the same budget, rather than one of them by a search that
// happened to be looking for it.

const Core = self.MephistoReviewCore;

// The engines, the human-model bands and both drivers now live in src/options/util/engines.js,
// because the Analysis page needs the same ones. Pulled onto locals here so the rest of this file
// reads exactly as it did.
const {ENGINES, MAIA_BANDS, WasmEngine, NativeEngine, makeEngine, nativeHostAvailable,
       LIMIT_INFINITE} = self.MephistoEngines;

// ---- config -----------------------------------------------------------------------------------
// Its own keys rather than the panel's: a review runs at a depth and a thread count that would be
// absurd for live play, and inheriting the panel's numbers would silently make one of them wrong.

function cfg(key) {
    const raw = MephistoConfig.get(key);
    if (raw == null || raw === '') return CFG_DEFAULTS[key];
    try {
        const v = JSON.parse(raw);
        return (v === null || v === undefined) ? CFG_DEFAULTS[key] : v;
    } catch (e) {
        return CFG_DEFAULTS[key];
    }
}

function setCfg(key, value) { MephistoConfig.set(key, JSON.stringify(value)); }

// ---- the game type ----------------------------------------------------------------------------
// One dropdown at the top decides the rules everything below plays by. `rv_variant` is the coarse
// pick (chess | chess960 | variant | 4pc); `rvChessVariant()` resolves it to the id this chess.js
// and the engines speak. The chess.com paths (classifier, Game Review) are standard chess only, so
// any other game type forces the own-engine review.
const RV_FAIRY_ONLY = ['crazyhouse', '3check', 'kingofthehill', 'antichess', 'atomic', 'horde', 'racingkings'];
const RV_FAIRY_ENGINE = 'fairy-stockfish-14-nnue';
// lichess/PGN variant names -> this chess.js's ids (the analysis page's map, same spellings)
const RV_PGN_VARIANTS = {
    'standard': 'chess', 'chess960': 'fischerandom', 'fischerandom': 'fischerandom',
    'fischerrandom': 'fischerandom', 'crazyhouse': 'crazyhouse', 'three-check': '3check',
    'threecheck': '3check', 'three check': '3check', 'king of the hill': 'kingofthehill',
    'kingofthehill': 'kingofthehill', 'antichess': 'antichess', 'giveaway': 'antichess',
    'atomic': 'atomic', 'horde': 'horde', 'racing kings': 'racingkings', 'racingkings': 'racingkings',
};

// chess.com's 4-player games carry their MODE in the Variant tag ("Teams", "FFA"), not the words
// "4-player" -- so a real PGN4 was refused with "which this page cannot review" while the 4-player
// review sat right there. Free-for-all is recognised too, and refused for the honest reason:
// Tetrarch searches Teams only (PROTOCOL.md).
const RV_PGN4_VARIANTS = {'teams': 'teams', 'ffa': 'ffa', 'free-for-all': 'ffa', 'solo': 'ffa'};
let is4pcGame = false;   // set by the parse when the pasted game is four-player Teams

function rvChessVariant() {
    const v = String(cfg('rv_variant') || 'chess');
    if (v === 'chess960') return 'fischerandom';
    if (v === 'variant') {
        const w = String(cfg('rv_variant_which') || 'crazyhouse');
        return RV_FAIRY_ONLY.includes(w) ? w : 'crazyhouse';
    }
    return 'chess';   // 'chess' and '4pc' (which never reaches a replay) both land here
}

// A rendered report keeps ITS OWN rules: flipping the dropdown after a run must not re-read the
// finished report's moves under different rules.
function reportVariant() { return report?.opts?.variant || 'chess'; }

// init() owns the real sync (it closes over the DOM wiring); parsePgnBox needs to call it when a
// pasted PGN decides the game type, so it is parked here for both to reach.
let syncGameTypeUi = () => {};

// A start position that IS a Chess960 start: full home ranks both sides, full pawn ranks, castling
// rights present, and a back-rank arrangement that is not standard chess. Deliberately tight -- a
// from-position standard game must never trip it, and a tagged 960 PGN never needs it.
function looks960(fen) {
    const parts = String(fen || '').split(/\s+/);
    if ((parts[2] || '-') === '-') return false;
    const ranks = (parts[0] || '').split('/');
    if (ranks.length !== 8 || ranks[1] !== 'pppppppp' || ranks[6] !== 'PPPPPPPP') return false;
    const black = ranks[0], white = (ranks[7] || '').toLowerCase();
    const sorted = (s) => s.split('').sort().join('');
    if (black.length !== 8 || white.length !== 8) return false;
    if (sorted(black) !== 'bbknnqrr' || sorted(white) !== 'bbknnqrr') return false;
    return black !== 'rnbqkbnr';
}

// What a pasted game says about its own rules. Returns a sentence for the parse note when it
// changed (or could not honour) the Game type, or '' when there is nothing to say.
function detectVariantFrom(game) {
    if (!game) return '';
    const current = String(cfg('rv_variant') || 'chess');
    const rawTag = game.tags?.Variant ? String(game.tags.Variant).trim() : '';
    const mapped = rawTag ? RV_PGN_VARIANTS[rawTag.toLowerCase()] : null;
    const fourpc = rawTag ? RV_PGN4_VARIANTS[rawTag.toLowerCase()] : null;
    if (fourpc) {
        // The PARSE decides the lane. Reading it back from the config at click time depended on a
        // cache write landing first, which it did not reliably do -- and a PGN4 then went down the
        // two-player path and sat there with the button greyed out.
        // Teams AND free-for-all both review since Tetrarch v8, which searches FFA paranoid with
        // its own net; the lane reads the mode off the game and grades accordingly.
        is4pcGame = true;
        if (current !== '4pc') setCfg('rv_variant', '4pc');
        return ' Four-player game - switched Game type to 4-player chess.';
    }
    is4pcGame = false;
    // Leaving 4-player is as automatic as entering it. The other game types are legitimate rules
    // choices for a tagless PGN, so they only get the reminder below -- but a game the two-player
    // parser read is not a PGN4, and running it down the 4-player lane fails with "no moves to
    // review". Found by the audit sweep: the previous 4PC run left the type set, and every later
    // standard paste died in the wrong lane.
    if (current === '4pc') {
        setCfg('rv_variant', 'chess');
        return ' Standard PGN - switched Game type back from 4-player chess.';
    }
    if (rawTag && !mapped) {
        return ` The PGN says Variant "${rawTag}", which this page cannot review.`;
    }
    let want = null, which = null;
    if (mapped === 'chess') want = 'chess';
    else if (mapped === 'fischerandom') want = 'chess960';
    else if (mapped) { want = 'variant'; which = mapped; }
    else if (!rawTag && game.startFen && looks960(game.startFen)) want = 'chess960';
    if (!want) {
        // nothing decisive in the PGN: remind when a non-chess type is in force, so a run under
        // unusual rules is never a surprise
        return current !== 'chess' && current !== '4pc'
            ? ` Reviewing under the ${current === 'chess960' ? 'Chess960' : String(cfg('rv_variant_which'))} rules set above.`
            : '';
    }
    if (current === want && (!which || String(cfg('rv_variant_which')) === which)) return '';
    setCfg('rv_variant', want);
    if (which) setCfg('rv_variant_which', which);
    syncGameTypeUi();
    const label = want === 'chess' ? 'Chess' : want === 'chess960' ? 'Chess960' : which;
    return ` Game type set to ${label} from the PGN.`;
}

// ---- the run ----------------------------------------------------------------------------------

// Replay the game once to get every position, and reject the PGN here rather than half-way through
// a five-minute analysis -- saying which move failed, and under WHICH rules it was read.
// `uci` is chess.js's `lan`: for standard moves it is from+to+promotion exactly as before, for a
// Chess960 castle it is king-takes-rook (what a UCI_Chess960 engine speaks), and for a crazyhouse
// drop it is the drop SAN ('N@f3', Fairy's own spelling) -- so the played move always compares
// equal to the engine's pv when they are the same move.
// Crazyhouse pockets and three-check counts are tracked here (mirroring the analysis page's
// nodeExtras) because this chess.js replays drops but keeps neither; `efen` is the position as the
// ENGINE must see it -- holdings in brackets, checks as a +W+B field -- while `fen` stays the plain
// board every cache, display and chess.js reconstruction reads.
function buildPositions(game, variant = 'chess') {
    let startFen = game.startFen || undefined;
    let hold = {w: '', b: ''};
    const checks = {w: 3, b: 3};
    let promoted = [];
    if (startFen && variant === 'crazyhouse') {
        const held = /\[([a-zA-Z]*)\]/.exec(startFen);
        if (held) {
            hold = {w: (held[1].match(/[A-Z]/g) || []).join('').toLowerCase(),
                    b: (held[1].match(/[a-z]/g) || []).join('')};
            startFen = startFen.replace(/\[[a-zA-Z]*\]/, '');
        }
    }
    if (startFen && variant === '3check') {
        const c = /\s\+(\d)\+(\d)/.exec(startFen);
        if (c) { checks.w = +c[1]; checks.b = +c[2]; startFen = startFen.replace(/\s\+\d\+\d/, ''); }
    }
    const chess = new Chess(variant, startFen);
    const fairy = RV_FAIRY_ONLY.includes(variant);
    const efenOf = () => {
        if (variant === 'crazyhouse') {
            const parts = chess.fen().split(' ');
            parts[0] += `[${hold.w.toUpperCase()}${hold.b}]`;
            return parts.join(' ');
        }
        if (variant === '3check') {
            const parts = chess.fen().split(' ');
            parts.splice(4, 0, `+${checks.w}+${checks.b}`);
            return parts.join(' ');
        }
        return undefined;
    };
    const positions = [{fen: chess.fen(), turn: chess.turn(), over: null, efen: efenOf()}];
    const moves = [];
    for (let i = 0; i < game.moves.length; i++) {
        const san = game.moves[i].san;
        let mv;
        try {
            mv = chess.move(san);
        } catch (e) {
            mv = null;
        }
        if (!mv) {
            const num = Math.floor(i / 2) + 1;
            const rules = variant === 'chess' ? 'standard chess' : variant;
            throw new Error(`Move ${num}${i % 2 ? '...' : '.'} ${san} is not legal in this position `
                + `(ply ${i + 1}) under ${rules}. Check the Game type at the top of Analysis.`);
        }
        if (variant === 'crazyhouse') {
            // captures feed the capturer's pocket (a captured promoted piece reverts to a pawn),
            // drops spend one -- the same accounting the analysis page verified live
            if (mv.san.includes('@')) {
                const type = mv.san[1] === '@' ? mv.san[0].toLowerCase() : 'p';
                if (mv.color === 'w') hold.w = hold.w.replace(type, '');
                else hold.b = hold.b.replace(type, '');
            } else {
                if (mv.captured) {
                    const capSq = String(mv.flags || '').includes('e')
                        ? mv.to[0] + (mv.color === 'w' ? '5' : '4') : mv.to;
                    const wasPromoted = promoted.includes(capSq);
                    const type = wasPromoted ? 'p' : mv.captured;
                    if (mv.color === 'w') hold.w += type; else hold.b += type;
                    if (wasPromoted) promoted = promoted.filter(s => s !== capSq);
                }
                const at = promoted.indexOf(mv.from);
                if (at >= 0) { promoted.splice(at, 1); promoted.push(mv.to); }
                if (mv.promotion) promoted.push(mv.to);
            }
        }
        if (variant === '3check' && /[+#]$/.test(mv.san)) {
            if (mv.color === 'w') checks.w = Math.max(0, checks.w - 1);
            else checks.b = Math.max(0, checks.b - 1);
        }
        moves.push({
            san: mv.san,
            uci: mv.lan || (mv.from + mv.to + (mv.promotion || '')),
            color: mv.color,
            ply: i,
            clk: game.moves[i].clk,
            to: mv.to,
            // A recapture on the square the opponent just took on. Excluded from the engine-match
            // numbers: finding it is not a result, and counting it is what makes a naive match rate
            // read 80% for everyone.
            isRecapture: !!(mv.captured && i > 0 && moves[i - 1] && moves[i - 1].to === mv.to
                && moves[i - 1].captured),
            captured: mv.captured || null,
        });
        // A finished position gets NO info lines from any engine -- there is nothing to search -- so
        // the score has to come from the rules. Without this the last move of every decisive game
        // was left unclassified, which is the one move a review is most often opened to look at.
        // The Fairy variants END by rules this chess.js does not know (a third check, the hill, a
        // king exploded), so no terminal claim is made for them -- the engine is asked instead, and
        // a truly finished final position may stay unclassified rather than be scored by rules that
        // are not this game's.
        positions.push({
            fen: chess.fen(), turn: chess.turn(),
            over: fairy ? null : (chess.isCheckmate() ? 'mate' : (chess.isGameOver() ? 'draw' : null)),
            efen: efenOf(),
        });
    }
    return {positions, moves};
}

// Seconds spent on each move, from the clock left after it. The first move of each side has no
// previous clock to subtract from, so it is unknown rather than guessed; an increment is added back
// because the clock shown after a move already includes it.
function fillThinkTime(moves, incrementSec) {
    const prev = {w: null, b: null};
    for (const m of moves) {
        if (m.clk == null) { m.seconds = null; continue; }
        const before = prev[m.color];
        m.seconds = (before == null) ? null : Math.max(0, before - m.clk + (incrementSec || 0));
        prev[m.color] = m.clk;
    }
}

function incrementFromTimeControl(tc) {
    const m = /^(\d+)(?:\+(\d+))?/.exec(String(tc || ''));
    return m && m[2] ? +m[2] : 0;
}

// Analyse one game. `rig` holds engines that are ALREADY started; a batch run starts them once and
// hands the same pair to every game, which is most of what makes a batch cheaper than N single runs.
async function runReview(game, rig, onProgress) {
    const opts = rig.opts;
    const {positions, moves} = buildPositions(game, opts.variant || 'chess');
    fillThinkTime(moves, incrementFromTimeControl(game.tags.TimeControl));

    let total = positions.length + (rig.human ? moves.length : 0);
    let done = 0;
    const tick = (what) => { done++; onProgress(done / total, what); };

    // The two passes are INDEPENDENT: both read `positions`, which is built before either starts,
    // and neither looks at the other's answers. They are also two separate engines with two separate
    // offscreen clients, so they can run at the same time -- which is the whole reason the human
    // model is started alongside the analysis engine rather than after it. Measured on a 25-position
    // game at 400ms per position, Maia 1500, one thread: 25.4s serial -> 12.8s overlapped, and the
    // reports are identical.
    // N engines, one queue. Each worker takes the next unsearched position, so a slow position
    // holds up nothing but its own worker, and the pass finishes in about 1/N of the time.
    // The count reported is COMPLETED positions, not an index: with workers running out of order
    // "position 7 of 103" would jump around and read like a bug.
    const pool = (rig.engines && rig.engines.length) ? rig.engines : [rig.engine];
    let nextPos = 0;
    const enginePass = (async () => {
        let searched = 0;
        const worker = async (e) => {
            for (;;) {
                const i = nextPos++;
                if (i >= positions.length) return;
                if (cancel) throw new Error('stopped');
                const p = positions[i];
                // Say something BEFORE the first search returns: with the unbounded notch the run
                // would otherwise sit on "starting the engine" for the whole of it.
                onProgress(done / total, `position ${searched + 1} of ${positions.length}`);
                // efen: the engine's dialect of the position (crazyhouse pockets, 3check counts)
                const r = await e.analyse(p.efen || p.fen, p.turn);
                p.lines = r.lines;
                p.depth = r.depth;
                searched++;
                tick(`position ${searched} of ${positions.length}`);
            }
        };
        await Promise.all(pool.map(worker));
    })();

    const humanPass = (async () => {
        if (!rig.human) return;
        try {
            for (let i = 0; i < moves.length; i++) {
                if (cancel) break;
                const r = await rig.human.analyse(positions[i].fen, positions[i].turn);
                const order = r.lines.map(l => l.pv?.[0]).filter(Boolean);
                moves[i].maiaMove = order[0] || null;
                moves[i].maiaOrder = order;
                const at = order.indexOf(moves[i].uci);
                // Outside the list is not "unknown", it is "further down than we looked". Recorded
                // as one past the end so it counts against the match rate rather than vanishing.
                moves[i].maiaRank = order.length ? (at >= 0 ? at + 1 : order.length + 1) : null;
                moves[i].maiaMatch = moves[i].maiaRank === 1;
            }
        } catch (e) {
            // A missing Maia net must not throw the whole review away: the engine pass is the report.
            note(`Human model unavailable (${e.message}) -- the rest of the report is unaffected.`, true);
        }
    })();

    // The engine pass owns the verdict: if it throws (or is stopped), the review is over. The human
    // pass is already swallowed above, and is awaited so a half-filled `moves` never reaches assemble.
    await Promise.all([enginePass.catch(e => { throw e; }), humanPass]);

    const book = cfg('rv_book') ? await lookupOpening(positions) : {name: null, plies: 0};
    // AFTER assemble, not before: the estimate skips book and forced moves, and those flags are set
    // BY assemble. Run earlier and `!m.isBook` reads `!undefined` -- true for everything -- so the
    // exclusions silently did nothing and every move counted, which is a different measurement than
    // the one the page describes.
    const built = assemble(game, positions, moves, book, opts);
    built.strength = await strengthPass(positions, moves, {
        plan: (n) => { total += n; },
        tick: (what) => { done++; onProgress(done / total, what); },
    }, rig);
    return built;
}

// ---- strength estimate ------------------------------------------------------------------------
// WHICH RATING BEST EXPLAINS THIS GAME. The human model gives, for every legal move, the chance a
// player of a given rating plays it. Run that at each rating over the moves someone actually played
// and one rating fits better than the others: the one whose predictions were least surprised. That
// is a maximum-likelihood estimate, and it is cheap for a reason worth writing down -- Maia costs ONE
// forward pass whatever MultiPV is set to, so asking for the whole distribution costs nothing over
// asking for five lines. The bill is bands x positions passes, and nothing else -- run on the human
// pass's own engine when it is Maia 3, so the estimate loads no net of its own either.
//
// What it is NOT: a fair-play measurement. A player using an engine reads as STRONGER here, which is
// the opposite of an accusation, and one game is a small sample however it is counted. Both are said
// on the page rather than left for the reader to work out.

const STRENGTH_MULTIPV = 64;   // every legal move, near enough; one forward pass either way

function strengthBands(kind) {
    // Maia 3 is one net on a dial, so it can be asked anywhere. Walked in 100s (user call
    // 2026-08-24, was 200s): 21 bands instead of 11 doubles this pass, but the estimate is the point
    // of the pass and a 100-point grid is the resolution people read it at.
    return kind === 'maia3' ? Array.from({length: 21}, (_, i) => String(600 + i * 100))
                            : MAIA_BANDS.slice();
}

// A move only says something about strength if there was a choice to make. Book moves are memory,
// forced moves are arithmetic, and both are played the same way by everyone.
function strengthUsable(m) { return !m.isBook && !m.onlyMove && m.uci; }

async function strengthPass(positions, moves, prog, rig) {
    // The chess.com-classifier mode has no human pass and no strength estimate: neither is part of
    // their verdict, and this reads the SETTING rather than the rig, so without this guard it would
    // start a Maia of its own and then look for a human engine that was never created.
    if (rig?.noStrength) return null;
    // Maia knows one game: no strength estimate for any other rules
    if ((rig?.opts?.variant || 'chess') !== 'chess') return null;
    const kind = cfg('rv_human');
    if (!cfg('rv_strength') || !kind) return null;
    const usable = moves.map((m, i) => ({m, i})).filter(({m}) => strengthUsable(m));
    if (usable.length < 6) return null;   // too few decisions to say anything at all
    const bands = strengthBands(kind);
    prog.plan(bands.length * usable.length);   // so the bar keeps climbing instead of restarting
    // One record per usable move. The three read-outs below (per-phase rating, the moves behind the
    // number, comparing two ratings) are all arithmetic over THIS -- the played move's probability
    // under each band, and each band's own most-likely move -- so none of them costs a second pass.
    const rec = usable.map(({m, i}) => ({
        ply: m.ply, color: m.color === 'w' ? 'w' : 'b', san: m.san, uci: m.uci,
        prob: {}, top: {}, rank: {},   // band -> played-move probability ; band -> {uci, prob} the
                                       // band would play ; band -> where the played move sat in the
                                       // band's own ordering (1 = it played it), null if not listed
    }));
    let shared = null;
    let borrowed = false;
    try {
        if (kind === 'maia3') {
            // The human pass's engine is the SAME 92MB net this sweep was loading a second copy of,
            // and by the time this runs that pass is finished (both passes are awaited before
            // assemble). Borrow it and sweep it across its rating dial instead: the second net load
            // -- most of the estimate's wait, and all of its extra memory -- disappears.
            if (rig?.human) {
                shared = rig.human;
                borrowed = true;
                shared.send(`setoption name MultiPV value ${STRENGTH_MULTIPV}`);
            } else {
                shared = makeEngine('maia3', {variant: 'chess', multipv: STRENGTH_MULTIPV, maiaLevel: bands[0],
                                              limitKind: 'depth', limitValue: 1, threads: 1, hash: 16}, 'review-strength');
                await shared.start();
            }
        }
        for (let bi = 0; bi < bands.length; bi++) {
            if (cancel) return null;
            const band = bands[bi];
            let e = shared;
            if (!e) {
                e = makeEngine('maia', {variant: 'chess', multipv: STRENGTH_MULTIPV, maiaLevel: band,
                                        limitKind: 'depth', limitValue: 1, threads: 1, hash: 16},
                               `review-strength-${band}`);
                await e.start();
            } else {
                e.send(`setoption name SelfElo value ${band}`);   // NOT UCI_Elo -- see maia3.js
                e.send(`setoption name OppoElo value ${band}`);
            }
            for (let k = 0; k < usable.length; k++) {
                if (cancel) { if (!shared) e.dispose?.(); return null; }
                const {m, i} = usable[k];
                prog.tick(`rating ${band}: move ${k + 1} of ${usable.length}`);
                let lines = [];
                try { lines = (await e.analyse(positions[i].fen, positions[i].turn)).lines || []; }
                catch (err) { lines = []; }
                rec[k].prob[band] = lines.find(l => l.pv?.[0] === m.uci)?.prob ?? 0;
                const top = lines.reduce((a, l) => ((l.prob ?? 0) > (a?.prob ?? -1) ? l : a), null);
                rec[k].top[band] = top?.pv?.[0] ? {uci: top.pv[0], prob: top.prob ?? 0} : null;
                // MultiPV is 64 -- every legal move -- so this rank is exact, and "was it in the
                // band's top 2 / top 3" costs a sort we were already paying for in effect.
                const order = lines.slice().sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0));
                const at = order.findIndex(l => l.pv?.[0] === m.uci);
                rec[k].rank[band] = at >= 0 ? at + 1 : null;
            }
            if (!shared) e.dispose?.();
        }
    } catch (e) {
        return null;   // the estimate is an extra; it never costs the report
    } finally {
        if (borrowed) {
            // Hand the engine back exactly as the human pass runs it: a batch review reuses this rig
            // for the next game, and its human pass assumes five lines at the configured rating.
            shared.send('setoption name MultiPV value 5');
            shared.send(`setoption name SelfElo value ${cfg('rv_maia3_elo')}`);
            shared.send(`setoption name OppoElo value ${cfg('rv_maia3_elo')}`);
        } else { shared?.dispose?.(); }
    }

    const phases = Core.gamePhases(positions.map(p => p.fen));
    const w = strengthForSide(rec, 'w', bands, phases);
    const b = strengthForSide(rec, 'b', bands, phases);
    if (!w && !b) return null;
    // `moves` (the per-move matrix) and `bands` ride along so the compare-two-ratings view can be
    // recomputed for any pair the reader picks without touching the engine again.
    return {kind, bands: bands.map(Number), phases, moves: rec, w, b};
}

// A maximum-likelihood rating over a SET of decisions: sum log P(played | band) for each band, and
// the band that was least surprised wins. Reused as-is for the whole game and for one phase of it.
function strengthEstimateOver(records, bands) {
    if (!records.length) return null;
    // A move the model gives no weight at all would be -Infinity and erase the band. Floored: "this
    // rating essentially never plays that" is information, not a disqualification.
    const curve = bands.map(band => {
        let ll = 0;
        for (const r of records) ll += Math.log(Math.max(r.prob[band] ?? 0, 1e-6));
        return {band: +band, ll};
    });
    // How often the band would have played the move that was actually played. The sweep already
    // recorded each band's own first choice per position, so this is arithmetic over data we have --
    // no second pass, no extra engine work. It is the reading most people mean by "which rating
    // plays like this", and it sits beside the likelihood rather than replacing it: likelihood uses
    // the whole distribution, match uses only the top move, and they can disagree.
    for (const r of curve) {
        let h1 = 0, h2 = 0, h3 = 0;
        for (const rec of records) {
            const at = rec.rank?.[r.band];
            if (at == null) continue;
            if (at <= 1) h1++;
            if (at <= 2) h2++;
            if (at <= 3) h3++;
        }
        const n = records.length || 1;
        r.hit = h1;  r.match = h1 / n;    // the band played the same move
        r.hit2 = h2; r.match2 = h2 / n;   // ...or had it second
        r.hit3 = h3; r.match3 = h3 / n;   // ...or third
    }
    const best = curve.reduce((a, c) => (c.ll > a.ll ? c : a));
    // Everything within 2 log-likelihood units of the peak is the standard support interval: the
    // ratings this game cannot tell apart. The peak alone claims a precision the moves cannot carry.
    const near = curve.filter(r => best.ll - r.ll <= 2).map(r => r.band);
    // The three closest bands, ranked three ways: by how often the band would have played the move,
    // how often it had it in its top two, and its top three. A player who is never the engine's
    // first choice but is usually in its top three is a different reading from one who is neither,
    // and the single list could not show that. Ties break toward the better likelihood.
    const rank = (key) => curve.slice().sort((a, b) => (b[key] - a[key]) || (b.ll - a.ll)).slice(0, 3);
    const top3 = rank('match');
    return {best: best.band, n: records.length, low: Math.min(...near), high: Math.max(...near),
            curve, top3, top3in2: rank('match2'), top3in3: rank('match3'),
            bestMatch: top3[0]?.band ?? best.band};
}

function strengthForSide(rec, side, bands, phases) {
    const mine = rec.filter(r => r.color === side);
    if (mine.length < 3) return null;
    const overall = strengthEstimateOver(mine, bands);
    if (!overall) return null;

    // (1) Same estimate over each phase separately -- the dividers already exist, so "opens like 1800,
    //     finishes like 1300" is free. A phase with too few real choices to say anything stays null.
    const phase = {};
    for (const key of ['opening', 'middlegame', 'endgame']) {
        const set = mine.filter(r => Core.phaseOf(r.ply, phases) === key);
        phase[key] = set.length >= 3 ? strengthEstimateOver(set, bands) : null;
    }

    // (2) The evidence for the number: the moves that pushed the winning band past its nearest rival.
    //     Contribution is log P(move | winner) - log P(move | rival); the biggest ones are the moves
    //     the field explained worst and the winner explained best -- the ones that MOVED the estimate.
    const winner = overall.best;
    const others = overall.curve.filter(r => r.band !== winner);
    const rival = others.length ? others.reduce((a, c) => (c.ll > a.ll ? c : a)).band : winner;
    const evidence = mine.map(r => {
        const pW = r.prob[winner] ?? 0, pR = r.prob[rival] ?? 0;
        return {ply: r.ply, color: r.color, san: r.san, uci: r.uci,
                contrib: Math.log(Math.max(pW, 1e-6)) - Math.log(Math.max(pR, 1e-6)),
                pWin: pW, pRival: pR, top: r.top[winner]};
    }).filter(e => e.contrib > 0.05).sort((a, b) => b.contrib - a.contrib).slice(0, 6);

    return {...overall, phases: phase, winner, rival, evidence};
}

// Start whatever the settings ask for, once. The caller owns the teardown, which is what lets a
// batch of forty games pay for one engine load instead of forty.
// `override` exists for the chess.com-classifier mode, which reproduces THEIR search rather than
// the one configured on this page -- their explanation engine is fed the evals it is given, so
// agreeing with their verdict means agreeing with their evals. That is the engine, the depth, the
// line count AND the thread count: they run four single-threaded workers, one position each, so a
// position is searched by one thread. Ours searches positions serially, and a multi-threaded search
// is not bit-reproducible, so one thread is both closer to theirs and steadier run to run. Hash
// stays the user's: it changes how fast the same search runs, not what it finds. No human pass
// either -- not part of their verdict, and it would double the wait for nothing.
async function startRig(override) {
    // the classifier override is chess-only by construction; everything else follows the dropdown
    const variant = override ? 'chess' : rvChessVariant();
    const opts = {
        variant,
        limitKind: override?.depth ? 'depth' : cfg('rv_limit_kind'),
        limitValue: override?.depth || +cfg('rv_limit_value'),
        multipv: override?.multipv || Math.max(1, +cfg('rv_multipv')),
        threads: override?.threads || Math.max(1, +cfg('rv_threads')),
        hash: Math.max(16, +cfg('rv_hash')),
    };
    // WHICH ENGINE CAN PLAY THESE RULES. The Fairy variants run on Fairy-Stockfish (the one bundled
    // engine that declares them); Chess960 runs on any WASM Stockfish via UCI_Chess960, but the
    // native hosts have no 960 plumbing, so a native pick falls back to the WASM default. Said in
    // the run status rather than done silently.
    let engineId = override?.engineId || cfg('rv_engine');
    if (!override && RV_FAIRY_ONLY.includes(variant) && engineId !== RV_FAIRY_ENGINE) {
        note(`Engine switched to Fairy-Stockfish for this run: only it plays ${variant}.`);
        engineId = RV_FAIRY_ENGINE;
    }
    if (!override && variant === 'fischerandom'
        && (ENGINES.find(e => e.id === engineId)?.kind === 'native')) {
        note('Chess960 runs on the WASM Stockfish for this run: the native hosts have no 960 support.');
        engineId = 'stockfish-18-nnue';
    }
    opts.engineId = engineId;   // the engine that actually ran, for the report header
    // A POOL, not one engine: the positions of a game are independent, so the pass runs them N at
    // a time (chess.com's review does the same). The configured threads are SPLIT across the pool
    // -- two engines on all cores each would just fight over them and search shallower for it.
    const wantWorkers = Math.max(1, Math.min(4, override?.workers || +cfg('rv_workers') || 1));
    const per = Math.max(1, Math.floor(opts.threads / wantWorkers));
    const engines = [];
    for (let w = 0; w < wantWorkers; w++) {
        const e = makeEngine(engineId, {...opts, threads: per}, w ? `review-${w}` : 'review');
        // one failing to start is not fatal while another runs: the pass just goes that much slower
        try { await e.start(); engines.push(e); } catch (err) {
            if (!engines.length) throw err;
            note(`Engine ${w + 1} of ${wantWorkers} did not start (${err.message}) - running with ${engines.length}.`, true);
            break;
        }
    }
    const engine = engines[0];
    opts.workers = engines.length;
    activeEngine = engine;
    let human = null;
    // the Maia nets know one game: any other rules run without a human pass
    const humanKind = (override || variant !== 'chess') ? '' : cfg('rv_human');
    if (humanKind) {
        const level = humanKind === 'maia3' ? String(cfg('rv_maia3_elo')) : String(cfg('rv_maia_band'));
        // Five of Maia's own choices: its RANK of the played move says far more than a yes/no.
        // Its own client id: it runs ALONGSIDE the analysis engine now, not after it.
        human = makeEngine(humanKind, {...opts, multipv: 5, maiaLevel: level}, 'review-human');
        try {
            await human.start();
        } catch (e) {
            note(`Human model unavailable (${e.message}) -- the rest of the report is unaffected.`, true);
            try { human.dispose(); } catch (e2) { /* */ }
            human = null;
        }
    }
    return {opts, engine, engines, human, noStrength: !!override};
}

// The 4-player review, end to end: the PGN4 goes to the host (which replays it with the engine's
// own rules), every position is searched, and the moves are graded with the SHARED classifier so a
// blunder here is a blunder in the two-player report and in the panel's live strip.
let fourpcReport = null, fourpcPly = 0;

async function run4pcReview() {
    const M = self.Mephisto4PC;
    if (!M) return note('The 4-player module did not load.', true);
    const text = ($('rv_pgn')?.value || '').trim();
    if (!text) return note('Paste a chess.com PGN4 first.', true);
    running = true; cancel = false;
    $('rv_run').disabled = true;
    if ($('rv_stop')) $('rv_stop').disabled = false;
    $('rv_progress_wrap')?.classList.remove('hidden');
    note('');
    // Show the section the moment the run starts, not when it finishes: a four-player review
    // searches every position over a native host, and a page that looks inert for a minute is
    // indistinguishable from one that ignored the button.
    $('rv-4pc')?.classList.remove('hidden');
    if ($('rv4_head')) $('rv4_head').textContent = 'Replaying the game with the Tetrarch engine\u2026';
    try {
        // The budget the page already offers. Tetrarch takes a movetime; a depth limit means
        // something different in its search, so the time row is what is honoured here.
        const movetime = cfg('rv_limit_kind') === 'depth' ? 1000 : Math.max(50, +cfg('rv_limit_value') || 1000);
        fourpcReport = await M.runReview(text, {
            movetime,
            isCancelled: () => cancel,
            onProgress: (frac, what) => progress(frac, what),
        });
        fourpcPly = fourpcReport.frames.length - 1;
        render4pc();
        $('rv-4pc')?.scrollIntoView({behavior: 'smooth', block: 'start'});
    } catch (e) {
        note(cancel ? 'Stopped.' : String(e.message || e), !cancel);
    } finally {
        running = false; cancel = false;
        $('rv_run').disabled = false;
        if ($('rv_stop')) $('rv_stop').disabled = true;
        $('rv_progress_wrap')?.classList.add('hidden');
        M.disconnect();   // the host is single-threaded and idle now; do not hold its port open
    }
}

let board4pc = null;

function render4pc() {
    const r = fourpcReport;
    if (!r) return;
    $('rv-4pc')?.classList.remove('hidden');
    const C = self.MephistoClassify || {};
    const tags = r.tags || {};
    const who = ['Red', 'Blue', 'Yellow', 'Green'].map(s => tags[s]).filter(Boolean).join(' · ');
    $('rv4_head').textContent = `${r.variant || 'Teams'} · ${r.frames.length - 1} plies`
        + (who ? ` · ${who}` : '')
        + (r.terminations?.length ? ` · ${r.terminations.map(t => `${t.seat} ${t.reason}`).join(', ')}` : '');

    // the groups -- two teams, or in free-for-all the four seats -- with the accuracy each
    // played to and what the classifier counted
    $('rv4_teams').innerHTML = (r.groupNames || r.teamNames).map((name, t) => {
        const counts = r.counts[t] || {};
        const named = (C.CLASS_NOTABLE || []).filter(k => counts[k])
            .map(k => `<span style="color:${(C.CLASS_COLOR || {})[k]}">${counts[k]} ${k}</span>`).join(' · ');
        // FFA has no per-move accuracy while the engine prices one line -- the honest number
        // there is how often the seat played the engine's move
        const m = r.matched?.[t];
        const headline = r.accuracy[t] != null ? r.accuracy[t] + '%'
            : (m && r.isFfa ? `${m.hit}/${m.of}` : ' - ');
        const subword = r.accuracy[t] != null ? 'accuracy'
            : (m && r.isFfa ? "engine's move" : 'accuracy');
        return `<div class="rv4-team"><h4>${esc(name)}</h4>`
             + `<div class="rv4-acc">${headline}</div>`
             + `<div class="rv4-sub">${subword} · ${named || 'clean'}</div></div>`;
    }).join('');

    $('rv4_moves').innerHTML = r.moves.map(m => {
        const col = (C.CLASS_COLOR || {})[m.klass];
        const badge = m.klass ? `<span class="rv4-klass" style="background:${col}">${m.klass}</span>` : '';
        const cp = m.teamCpAfter == null ? '' : (m.teamCpAfter / 100).toFixed(2);
        return `<div class="rv4-mv" data-ply="${m.ply + 1}">`
             + `<span class="rv4-seat">${esc(m.seatName)}</span>`
             + `<span class="rv4-tok">${esc(m.token || m.move || '')}</span>${badge}`
             + `<span class="rv4-cp">${cp}</span></div>`;
    }).join('');
    $('rv4_moves').querySelectorAll('.rv4-mv').forEach(el =>
        el.addEventListener('click', () => show4pcPly(+el.dataset.ply)));

    show4pcPly(fourpcPly);
}

function show4pcPly(ply) {
    const r = fourpcReport;
    if (!r) return;
    fourpcPly = Math.max(0, Math.min(r.frames.length - 1, ply));
    const f = r.frames[fourpcPly];
    // The panel's own 14x14 renderer -- the one the live lane draws with, so a review board and a
    // live board are the same board. Seated at Red: a review has no "our seat" to rotate to.
    if (!board4pc && self.MephistoBoard4PC) board4pc = new self.MephistoBoard4PC('rv4_board', {seat: 'r'});
    board4pc?.position(f.fen4);
    const ev = r.evals[fourpcPly] || {};
    const cp = ev.teamCp == null ? null : (ev.teamCp / 100).toFixed(2);
    $('rv4_ply').textContent = `ply ${fourpcPly} of ${r.frames.length - 1}`;
    // FFA scores are the mover's own outlook (paranoid search, not zero-sum); Teams scores are
    // normalised to one fixed team, so the label says which reading applies
    $('rv4_evalline').textContent = `${r.seatName[f.turn] || f.turn} to move`
        + (cp == null ? '' : (r.isFfa ? ` · ${cp} for ${r.seatName[f.turn] || f.turn}`
                                      : ` · ${cp} for ${r.teamNames[0]}`))
        + (ev.best ? ` · best ${ev.best}` : '');
    $('rv4_moves').querySelectorAll('.rv4-mv').forEach(el =>
        el.classList.toggle('rv4-sel', +el.dataset.ply === fourpcPly));
}

function disposeRig(rig) {
    for (const e of (rig?.engines || [])) { try { e.dispose(); } catch (err) { /* */ } }
    try { rig?.engine?.dispose(); } catch (e) { /* */ }
    try { rig?.human?.dispose(); } catch (e) { /* */ }
    activeEngine = null;
}

// The opening, from a table that ships WITH the extension. It used to ask the Lichess opening
// explorer through the service worker; that endpoint now answers 401 at its proxy, before the
// application sees the request, and whether that is an auth requirement or a network block is not
// something this code can find out or fix. Naming an opening never needed a server anyway: the
// answer is a property of the position.
//
// The table is lichess-org/chess-openings (CC0, a collection of facts in the public domain), 3,810
// named lines replayed once at build time and keyed on the position rather than the move order --
// so a transposition is named correctly, which a move-list lookup cannot do.
let openingBook = null;

async function loadOpeningBook() {
    if (openingBook) return openingBook;
    try {
        const r = await fetch(chrome.runtime.getURL('src/options/pages/review/openings.json'));
        openingBook = r.ok ? await r.json() : {};
    } catch (e) {
        openingBook = {};
    }
    return openingBook;
}

// The last named position the game passed through, and the ply it stopped being theory at. Both
// come out of the same walk: a game is "in book" up to the last position the table knows.
async function lookupOpening(positions) {
    const book = await loadOpeningBook();
    let name = null, plies = 0;
    for (let i = 0; i < positions.length; i++) {
        // the FEN without its move counters, which is how the table is keyed
        const key = positions[i].fen.split(' ').slice(0, 4).join(' ');
        const hit = book[key];
        if (hit) { name = hit; plies = i; }
    }
    return {name, plies};
}

// Fold the raw searches into the move table the whole report is drawn from.
function assemble(game, positions, moves, book, opts) {
    // A finished position gets no engine line -- there is nothing to search -- so the eval bar and
    // the score readout sat empty on the very last position of every decisive game, which is the
    // one a review is most often opened to look at. The rules already say what it is worth, and
    // chess.com's own review reports it the same way (mate 0 on the mating move). No `mate` field:
    // scoreText reads the distance out of the cp, so the sign survives and a black mate prints #-0.
    for (const p of positions) {
        if (p.lines?.length) continue;
        if (p.over === 'mate') p.lines = [{cp: p.turn === 'w' ? -Core.MATE_CP : Core.MATE_CP, mate: null, pv: []}];
        else if (p.over === 'draw') p.lines = [{cp: 0, mate: null, pv: []}];
    }
    for (const m of moves) {
        const before = positions[m.ply];
        const after = positions[m.ply + 1];
        const bestCp = before.lines?.[0]?.cp;
        // `after` is terminal: checkmate is a win for whoever just moved, anything else is a draw.
        const afterCp = after.over === 'mate' ? (m.color === 'w' ? Core.MATE_CP : -Core.MATE_CP)
            : after.over === 'draw' ? 0
            : after.lines?.[0]?.cp;
        if (bestCp == null || afterCp == null) continue;

        // Everything from the MOVER's point of view: a white-positive score is good for white, so
        // black's numbers are the negation. Getting this backwards makes every black move look like
        // a blunder, which is at least a loud failure.
        const sign = m.color === 'w' ? 1 : -1;
        m.evalBefore = bestCp * sign;
        m.evalAfter = afterCp * sign;
        m.winBefore = Core.winPercent(bestCp * sign);
        m.winAfter = Core.winPercent(afterCp * sign);
        m.cpLoss = Math.max(0, Math.min(1000, m.evalBefore - m.evalAfter));
        m.acc = Core.moveAccuracy(m.winBefore, m.winAfter);
        m.best = before.lines[0].pv[0];
        m.bestLines = before.lines;
        m.depth = before.depth;

        const idx = before.lines.findIndex(l => l.pv[0] === m.uci);
        m.rank = idx >= 0 ? idx + 1 : null;
        // How much better the engine's move was than its second choice. A big gap is a position
        // where being right is a real achievement, which is the only kind worth counting as evidence.
        m.complexity = before.lines.length > 1
            ? Math.abs(before.lines[0].cp - before.lines[1].cp) : null;
        m.onlyMove = before.lines.length === 1;
        m.isBook = m.ply < book.plies;
        // The engine's SECOND choice, mover-relative: what the position was worth if this move had
        // not been found. That gap is what makes a move Great rather than merely best.
        m.secondWin = before.lines.length > 1 ? Core.winPercent(before.lines[1].cp * sign) : null;
        // Only ask the sacrifice question when the answer can matter -- it replays an exchange on
        // the board, and most moves cannot be brilliant anyway.
        m.sacrifice = (!m.isBook && !m.onlyMove && m.winAfter >= 50 && m.winBefore < 90
                       && Math.max(0, m.winBefore - m.winAfter) < 2)
            ? Core.sacrificesMaterial(Chess, opts.variant, before.fen, m.uci) : false;
        m.klass = Core.classify({
            winBefore: m.winBefore, winAfter: m.winAfter, rank: m.rank,
            onlyMove: m.onlyMove, isBook: m.isBook, secondWin: m.secondWin, sacrifice: m.sacrifice,
        });
    }
    const phases = Core.gamePhases(positions.map(p => p.fen));
    return {
        game, positions, moves, book, opts, phases,
        accuracy: {w: Core.accuracyFor(moves, 'w'), b: Core.accuracyFor(moves, 'b')},
        indicators: {
            w: Core.indicators(moves, 'w', opts.multipv, phases, game.tags),
            b: Core.indicators(moves, 'b', opts.multipv, phases, game.tags),
        },
        counts: {w: countClasses(moves, 'w'), b: countClasses(moves, 'b')},
        engineId: opts.engineId || cfg('rv_engine'),
        humanKind: cfg('rv_human'),
        at: new Date().toISOString(),
    };
}

function countClasses(moves, color) {
    const out = {};
    for (const k of Core.CLASS_ORDER) out[k] = 0;
    for (const m of moves) if (m.color === color && m.klass) out[m.klass]++;
    return out;
}

// ---- rendering --------------------------------------------------------------------------------

// The ETA is derived, not measured twice: the bar already knows how much is done and when it
// started, so the remaining time is elapsed * (1-frac)/frac. Held back until 3% is done (the first
// positions are dominated by the engine load and would promise nonsense), and re-based when the
// fraction falls a long way -- that is a NEW run, not this one going backwards. The strength pass
// growing the total mid-run only dents the fraction slightly, below the re-base threshold.
let ccrJson = '';           // the chess.com review's last raw answer
let ccrLastError = '';      // the last chess.com error text, for the "copy error & open ticket" button

// A one-time caution gate before the FIRST chess.com review: the game leaves the machine on the user's
// own chess.com session, so this spells out the risk and forces a 10s wait before Accept goes live.
// Accepting is REMEMBERED (ccr_consent); declining is not, so a declined attempt is asked again next time.
function ccrConsent() {
    return new Promise((resolve) => {
        if (cfg('ccr_consent')) return resolve(true);
        const modal = $('rv_ccr_consent'), accept = $('rv_ccr_accept'), decline = $('rv_ccr_decline');
        if (!modal || !accept || !decline) return resolve(true);   // no gate in the DOM -> do not block
        let n = 10;
        accept.disabled = true;
        accept.textContent = `Got it (${n})`;
        modal.classList.remove('hidden');
        const tick = setInterval(() => {
            n -= 1;
            if (n <= 0) { clearInterval(tick); accept.disabled = false; accept.textContent = 'Got it'; }
            else accept.textContent = `Got it (${n})`;
        }, 1000);
        const done = (val) => { clearInterval(tick); modal.classList.add('hidden'); accept.onclick = null; decline.onclick = null; resolve(val); };
        accept.onclick = () => { setCfg('ccr_consent', true); done(true); };
        decline.onclick = () => done(false);
    });
}

const eta = {t0: 0, last: 1};
function etaText(frac) {
    if (frac < eta.last - 0.15 || !eta.t0) eta.t0 = Date.now();
    eta.last = frac;
    if (frac < 0.03 || frac >= 1) return '';
    const s = Math.round((Date.now() - eta.t0) / 1000 * (1 - frac) / frac);
    if (s < 1) return '';
    return s < 60 ? ` · ~${s}s left` : ` · ~${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s left`;
}

function progress(frac, text) {
    $('rv_progress_wrap')?.classList.remove('hidden');
    const bar = $('rv_progress_bar');
    if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    const t = $('rv_progress_text');
    if (t) t.textContent = text ? `${Math.round(frac * 100)}% - ${text}${etaText(frac)}` : '';
}

function note(text, bad) {
    const el = $('rv_pgn_status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('rv-bad', !!bad);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

function scoreText(cp, mate) {
    // >= 0, not > 0: chess.com reports mate 0 on the mating move itself, and `mate > 0` sent that
    // through the losing branch as "#-0".
    if (mate != null) return (mate >= 0 ? '#' : '#-') + Math.abs(mate);
    // No mate field to hand (the move table keeps one number per move): the distance is still in
    // there, because that is exactly how toWhiteCp encodes it. `#` with no number reads as a bug.
    if (Core.isMateScore(cp)) {
        return (cp > 0 ? '#' : '#-') + (Core.MATE_CP - Math.abs(cp));
    }
    return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
}

// The same eight colours review.css declares, as literals -- the export carries no stylesheet of
// ours, and a second list that drifts is worse than one list read from two places.
const CLASS_COLOUR = {
    best: '#2f7d41', excellent: '#4c9a5e', good: '#7d8a91', book: '#8a6d3b', forced: '#5b6b8a',
    inaccuracy: '#b8860b', mistake: '#cc7722', blunder: '#b03030',
};

const CLASS_LABEL = {
    brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent', good: 'Good',
    book: 'Book', forced: 'Forced', inaccuracy: 'Inaccuracy', mistake: 'Mistake', miss: 'Miss',
    blunder: 'Blunder',
};

// ---- FIT HUMANIZE TO A REAL PLAYER --------------------------------------------------------------
// The Humanize move mix is seven percentages, and until now they were guessed at: you moved sliders
// until the panel "felt" right. This measures them instead. Every move the chosen player made in
// this review already has its centipawn loss against the engine's best, and the mix's own bands are
// defined in exactly those units -- so counting the moves that fall in each band IS the mix that
// reproduces this player.
//
// Deliberately NOT a strength estimate and not a rating: it describes how often this player found
// the best move and how badly they missed when they did not. Book and forced moves are excluded --
// everybody plays those the same way, and leaving them in inflates the top share for free.
const FIT_ORDER = ['second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder'];
function fitHumanize(moves, colour) {
    // The SAME band edges the panel uses (humanize_thresholds defaults), so a fitted mix means the
    // same thing to the code that will play it. Read from storage where the user has changed them.
    const num = (k, d) => { const v = parseFloat(MephistoConfig.get(k)); return Number.isFinite(v) ? v : d; };
    const edges = {second: num('humanize_cp_second', 40), third: num('humanize_cp_third', 75),
                   fourth: num('humanize_cp_fourth', 110), inaccuracy: num('humanize_cp_inaccuracy', 230),
                   mistake: num('humanize_cp_mistake', 377), blunder: num('humanize_cp_blunder', 600)};
    const counts = {top: 0, second: 0, third: 0, fourth: 0, inaccuracy: 0, mistake: 0, blunder: 0};
    let n = 0;
    for (const m of moves) {
        if (m.color !== colour) continue;
        if (m.klass === 'book' || m.klass === 'forced') continue;
        if (m.cpLoss == null) continue;
        n++;
        if (m.cpLoss <= 0) { counts.top++; continue; }
        let placed = false;
        let lo = 0;
        for (const k of FIT_ORDER) {
            if (m.cpLoss > lo && m.cpLoss <= edges[k]) { counts[k]++; placed = true; break; }
            lo = edges[k];
        }
        // Worse than the blunder band is still a blunder -- the mix has nowhere else to put it, and
        // dropping it would quietly make the player look better than they played.
        if (!placed) counts.blunder++;
    }
    if (!n) return null;
    const pct = {};
    for (const k in counts) pct[k] = Math.round(counts[k] * 1000 / n) / 10;
    return {pct, n};
}

function renderReport() {
    if (!report) return;
    $('rv-report').classList.remove('hidden');
    $('rv-indicators').classList.remove('hidden');
    // a preceding chess.com review hides these engine-only blocks; restore them for an engine run.
    document.querySelector('.rv-graph-wrap')?.classList.remove('hidden');
    $('rv_export').disabled = false;
    $('rv_fit').disabled = false;
    renderHeader();
    renderCards();
    renderGraph();
    renderTurning();
    renderTimeCards();
    renderMoves();
    renderIndicators();
    renderHumanReport();
    renderStrength();
    ensureBoard();
    showPly(report.moves.length);
}

// "GM Carlsen (2839)". The title comes from the PGN's own tag, which chess.com and lichess both
// write; a game without one just renders the name.
function playerName(color) {
    const t = report.game.tags;
    const title = color === 'w' ? t.WhiteTitle : t.BlackTitle;
    const name = (color === 'w' ? t.White : t.Black) || (color === 'w' ? 'White' : 'Black');
    return (title && title !== '-' ? `${title} ` : '') + name;
}

function playerLine(color) {
    const t = report.game.tags;
    const elo = color === 'w' ? t.WhiteElo : t.BlackElo;
    return playerName(color) + (elo ? ` (${elo})` : '');
}

function renderHeader() {
    const t = report.game.tags;
    const bits = [];
    if (t.Event) bits.push(esc(t.Event));
    if (t.Date) bits.push(esc(Core.formatDate(t.Date)));
    if (t.TimeControl) bits.push(esc(t.TimeControl));
    if (report.book.name) bits.push(esc(report.book.name));
    if (report.ccr) {
        bits.push(`chess.com Game Review${report.ccrStrength ? ` - ${esc(report.ccrStrength)}` : ''}`);
    } else {
        // engineName is set when something OTHER than the configured engine did the searching --
        // chess.com's own Stockfish on the classifier path. Without it the header named our engine
        // for a search theirs had run, which is the one line a reader would take at face value.
        const eng = ENGINES.find(e => e.id === report.engineId);
        const budget = report.opts.limitKind === 'depth'
            ? `depth ${report.opts.limitValue}` : `${report.opts.limitValue}ms/move`;
        const name = report.opts.engineName || (eng ? eng.label : report.engineId);
        const pool = report.opts.workers > 1 ? `, ${report.opts.workers} engines` : '';
        bits.push(`${esc(name)}, ${budget}, ${report.opts.multipv} line(s)${pool}`);
    }
    // the classifier's one-sentence verdict on the GAME reads as part of the header, right under
    // the names it is about (it used to trail the run's status line, where it scrolled away)
    const summary = report.ee?.summary || report.ccrSummary || '';
    $('rv_header').innerHTML =
        `<div class="rv-vs">${esc(playerLine('w'))} &ndash; ${esc(playerLine('b'))}`
        + ` &nbsp;${esc(report.game.result)}</div>`
        + `<div class="rv-meta">${bits.join(' · ')}</div>`
        + (summary ? `<div class="rv-gamenote">\u201c${esc(summary)}\u201d</div>` : '');
}

function renderCards() {
    const t = report.game.tags;
    const card = (color) => {
        const name = playerLine(color);
        const acc = report.accuracy[color];
        const ind = report.indicators[color];
        const counts = report.counts[color];
        const rows = Core.CLASS_ORDER
            .filter(k => counts[k])
            .map(k => `<div class="rv-kv rv-c-${k}"><span>${classIcon(k)}<b>${CLASS_LABEL[k]}</b></span><span>${counts[k]}</span></div>`)
            .join('');
        return `<div class="rv-card">
            <h4>${esc(name)}</h4>
            <div class="rv-big">${acc == null ? ' - ' : acc.toFixed(1) + '%'}</div>
            <div class="rv-sub">accuracy over ${ind.moves} moves</div>
            <div style="margin-top:10px">${rows}</div>
            <div class="rv-kv" style="margin-top:8px"><span>Avg. centipawn loss</span><span>${ind.acpl ?? ' - '}</span></div>
            ${ind.top1 == null ? '' : `<div class="rv-kv"><span>Engine's first choice</span><span>${(ind.top1 * 100).toFixed(0)}%</span></div>`}
            ${ind.secMedian == null ? '' : `<div class="rv-kv"><span>Median think time</span><span>${ind.secMedian.toFixed(1)}s</span></div>`}
        </div>`;
    };
    $('rv_cards').innerHTML = card('w') + card('b');
}

// THE MOMENT THE GAME TURNED, named instead of left for the reader to find on the graph. The move
// with the biggest single swing in win percentage -- preferring one that moved the advantage across
// the 50% line, because "it was equal and then it was lost" is what "turned" means; when nothing
// crossed, the biggest swing stands in. A quiet game has no turning point and this says nothing:
// below a 15-point swing there is no story to tell. Clicking the line jumps the board there.
function renderTurning() {
    const el = $('rv_turning');
    if (!el) return;
    // white-view win% both sides of every move, so "crossed 50" means what it says on the graph
    const swings = report.moves
        .filter(m => m.winBefore != null && m.winAfter != null)
        .map(m => {
            const wBefore = m.color === 'w' ? m.winBefore : 100 - m.winBefore;
            const wAfter = m.color === 'w' ? m.winAfter : 100 - m.winAfter;
            return {m, wBefore, wAfter, drop: Math.abs(wBefore - wAfter),
                    crossed: (wBefore - 50) * (wAfter - 50) < 0};
        });
    const crossers = swings.filter(x => x.crossed && x.drop >= 15);
    const pick = (crossers.length ? crossers : swings.filter(x => x.drop >= 15))
        .sort((a, b) => b.drop - a.drop)[0];
    // one line of why, because "no turning point" and "the data never arrived" look identical
    console.log(`[review] turning: ${swings.length} swings, max drop ${swings.length
        ? Math.round(Math.max(...swings.map(x => x.drop))) : 0}, crossers ${crossers.length}`);
    el.classList.toggle('hidden', !pick);
    if (!pick) return;
    el.innerHTML = `The game turned on <span class="rv-turn-move rv-c-${pick.m.klass}">${esc(moveLabel(pick.m))}</span>`
        + ` - White ${Math.round(pick.wBefore)}% → ${Math.round(pick.wAfter)}%`;
    el.querySelector('.rv-turn-move')?.addEventListener('click', () => showPly(pick.m.ply + 1));
}

// HOW THE CLOCK WAS SPENT, per player, when the PGN carried clocks at all. The shape is the point:
// steady, spiky, or the same two seconds every move say very different things about a game, and the
// median already on the summary card cannot show any of them. Same bars the strength curve uses.
// TEN buckets, not five. Five was coarse enough that most blitz games piled into the first two and
// the card read as two bars and three empty ones (reported: the width was doing nothing). The
// boundaries are roughly logarithmic, because that is how think time actually distributes: a lot of
// moves under a second, a long tail past a minute.
const TIME_BUCKETS = [[1, '≤1s'], [2, '1–2s'], [3, '2–3s'], [5, '3–5s'], [8, '5–8s'],
                      [15, '8–15s'], [30, '15–30s'], [60, '30–60s'], [120, '1–2m'], [Infinity, '>2m']];
function renderTimeCards() {
    const wrap = $('rv_time_wrap'), host = $('rv_time_cards');
    if (!wrap || !host) return;
    const timed = report.moves.filter(m => m.seconds != null);
    wrap.classList.toggle('hidden', timed.length < 6);   // a handful of clocks is not a shape
    if (timed.length < 6) return;
    const card = (color) => {
        const secs = timed.filter(m => m.color === color).map(m => m.seconds);
        if (!secs.length) return '';
        const counts = TIME_BUCKETS.map(() => 0);
        for (const sec of secs) counts[TIME_BUCKETS.findIndex(([cap]) => sec <= cap)]++;
        const top = Math.max(...counts) || 1;
        const bars = counts.map((n, i) => `<span class="rv-str-bar" title="${TIME_BUCKETS[i][1]}: ${n} move${n === 1 ? '' : 's'}">`
            + `<i style="height:${Math.max(3, Math.round(n / top * 100))}%"></i></span>`).join('');
        // ten labels do not fit under a card: label alternate buckets and let the hover title
        // (already on every bar) carry the rest
        const labels = TIME_BUCKETS.map(([, lab], i) =>
            `<span>${i % 2 === 0 ? lab : ''}</span>`).join('');
        const longest = Math.max(...secs);
        return `<div class="rv-card">
            <h4>${esc(playerName(color))} - clock</h4>
            <div class="rv-str-curve">${bars}</div>
            <div class="rv-time-labels">${labels}</div>
            <div class="rv-kv" style="margin-top:8px"><span>Longest think</span><span>${longest.toFixed(0)}s</span></div>
        </div>`;
    };
    host.innerHTML = card('w') + card('b');
}

// The eval graph: white's advantage over the game, clamped so one mate score cannot flatten
// everything else into a straight line. Clicking it jumps the board to that move.
function renderGraph() {
    const host = $('rv_graph');
    const r = host.getBoundingClientRect();
    const svg = buildGraphSvg(true, {w: r.width, h: r.height});
    if (!svg) return;
    host.innerHTML = svg;
    const el = host.querySelector('svg');
    // The viewBox tracks the panel, so a resize has to rebuild it or the picture distorts again.
    if (!renderGraph.onResize) {
        let t;
        renderGraph.onResize = () => { clearTimeout(t); t = setTimeout(() => { if (report) { renderGraph(); setGraphCursor(); } }, 150); };
        addEventListener('resize', renderGraph.onResize);
    }
    el.addEventListener('click', (e) => {
        const r = el.getBoundingClientRect();
        showPly(Math.round(((e.clientX - r.left) / r.width) * (report.positions.length - 1)));
    });
    }

// The eval graph. `live` uses the page's CSS variables (so it follows dark mode and the cursor line
// is there to move); the export needs the same picture with literal colours and no cursor, since it
// carries no stylesheet of ours and runs no script.
function buildGraphSvg(live, box) {
    // Sized 1:1 with its panel on the live page. preserveAspectRatio="none" means every mismatch
    // between the viewBox and the box IS a distortion: a fixed 1000x150 viewBox squeezed into the
    // 510x210 summary panel crushed the x axis to half its width and stretched y by 1.4.
    // The export has no panel and keeps the old fixed canvas.
    const W = Math.round(box?.w) || 1000, H = Math.round(box?.h) || 150, MID = H / 2;
    const pts = report.positions.map(p => p.lines?.[0]?.cp ?? 0);
    if (!pts.length) return '';
    const col = live
        ? {up: 'var(--mp-hair)', down: 'var(--mp-line)', ink: 'var(--mp-text)', mid: 'var(--mp-mute)', bg: 'var(--mp-bg)'}
        : {up: '#eceef0', down: '#dcdfe3', ink: '#14171a', mid: '#8b9198', bg: '#ffffff'};
    // A logistic squash rather than a linear scale: the difference between +1 and +2 pawns matters
    // and the difference between +8 and +9 does not, and a linear axis spends all its room on the
    // second one.
    const y = (cp) => MID - MID * 0.94 * Math.tanh(Core.clamp(cp, -2500, 2500) / 400);
    const x = (i) => (pts.length === 1) ? 0 : (i / (pts.length - 1)) * W;
    const line = pts.map((cp, i) => `${x(i).toFixed(1)},${y(cp).toFixed(1)}`).join(' ');
    const area = `0,${MID} ` + line + ` ${W},${MID}`;
    const blunderMarks = report.moves
        .filter(m => m.klass === 'blunder' || m.klass === 'mistake')
        .map(m => `<circle cx="${x(m.ply + 1).toFixed(1)}" cy="${y(report.positions[m.ply + 1].lines?.[0]?.cp ?? 0).toFixed(1)}"
                    r="5" fill="${live ? 'var(--rv-c)' : CLASS_COLOUR[m.klass]}" stroke="${col.bg}" stroke-width="1.5"
                    ${live ? `class="rv-c-${m.klass}"` : ''}><title>${esc(moveLabel(m))} ${CLASS_LABEL[m.klass]}</title></circle>`)
        .join('');
    // Opening / middlegame / endgame, on lichess's own divider so the boundaries land where a
    // lichess user expects them. Drawn as a line and a label rather than a tinted band: the graph
    // already uses fill to mean "who is better", and a second meaning for fill would fight it.
    const ph = report.phases || {};
    const marks = [];
    if (ph.mid != null) marks.push([ph.mid, 'middlegame']);
    if (ph.end != null) marks.push([ph.end, 'endgame']);
    const phaseSvg = marks.map(([ply, label]) => {
        const px = x(Math.min(ply, pts.length - 1));
        return `<line x1="${px.toFixed(1)}" y1="0" x2="${px.toFixed(1)}" y2="${H}" `
            + `stroke="${col.mid}" stroke-width="1" stroke-dasharray="4 4" opacity="0.85"/>`
            + `<text x="${(px + 6).toFixed(1)}" y="13" fill="${col.mid}" font-size="11" `
            + `font-family="-apple-system, system-ui, sans-serif">${label}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <rect x="0" y="0" width="${W}" height="${MID}" fill="${col.up}"/>
        <rect x="0" y="${MID}" width="${W}" height="${MID}" fill="${col.down}"/>
        <polygon points="${area}" fill="${col.ink}" opacity="0.72"/>
        <polyline points="${line}" fill="none" stroke="${col.ink}" stroke-width="1.5" opacity="0.9"/>
        <line x1="0" y1="${MID}" x2="${W}" y2="${MID}" stroke="${col.mid}" stroke-width="1" opacity="0.5"/>
        ${phaseSvg}
        ${live ? `<line id="rv_graph_cursor" x1="0" y1="0" x2="0" y2="${H}" stroke="var(--mp-on)" stroke-width="2"/>` : ''}
        ${blunderMarks}
    </svg>`;
}

// Read the width back off the viewBox: it is the panel's pixel width now, not a fixed 1000.
function setGraphCursor() {
    const line = $('rv_graph_cursor');
    if (!line || !report) return;
    const W = +(line.ownerSVGElement?.getAttribute('viewBox') || '0 0 1000 150').split(' ')[2];
    const x = (cursor / Math.max(1, report.positions.length - 1)) * W;
    line.setAttribute('x1', x); line.setAttribute('x2', x);
}

function moveLabel(m) {
    return `${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '...'} ${m.san}`;
}

function renderMoves() {
    const rows = [];
    for (let i = 0; i < report.moves.length; i += 2) {
        const num = i / 2 + 1;
        rows.push(`<div class="rv-mrow"><div class="rv-mnum">${num}</div>`
            + moveCell(report.moves[i]) + moveCell(report.moves[i + 1]) + '</div>');
    }
    const el = $('rv_moves');
    el.innerHTML = rows.join('');
    // Delegated, and bound ONCE per page render: innerHTML replaces the rows but not the container,
    // so a listener added here on every re-render would fire N times per click.
    if (!el.dataset.bound) {
        el.dataset.bound = '1';
        el.addEventListener('click', (e) => {
            const cell = e.target.closest('.rv-mcell[data-ply]');
            if (cell) showPly(+cell.dataset.ply + 1);
        });
    }
}

function moveCell(m) {
    if (!m) return '<div class="rv-mcell"></div>';
    const k = m.klass || 'good';
    // White's perspective, like every other number on the page: cpLoss is stored as a magnitude for
    // whoever moved, so a black mistake is white GAINING and reads +N. It used to print -N for both
    // colours, which said "someone lost something" without saying who.
    const swing = (m.cpLoss == null || m.cpLoss < 1) ? null : Math.round(m.cpLoss) * (m.color === 'w' ? -1 : 1);
    const loss = swing == null ? '' : (swing > 0 ? `+${swing}` : `−${Math.abs(swing)}`);
    return `<div class="rv-mcell rv-c-${k}" data-ply="${m.ply}" title="${esc(CLASS_LABEL[k])}">
        ${classIcon(k)}<span class="rv-san">${esc(m.san)}</span>
        <span class="rv-loss">${loss}</span></div>`;
}

function renderIndicators() {
    // The key. Printed from the same list the levels are assigned from, so a caption that disagrees
    // with the labels underneath it is not possible.
    $('rv_levels').innerHTML = Core.LEVELS.map(l =>
        `<div class="rv-lvl"><span class="rv-ev-flag rv-ev-${l.key}">${esc(l.label)}</span>`
        + `<span>${esc(l.what)}</span></div>`).join('');
    const col = (color) => {
        const name = playerName(color);
        const ind = report.indicators[color];
        const evid = Core.evidence(ind, {});
        const est = Core.estimate(evid, ind);
        const items = evid.map(e => `<div class="rv-ev">
            <span class="rv-ev-flag rv-ev-${e.level}">${e.level}</span>${esc(e.text)}
            <span class="rv-ev-note">${esc(e.note)}</span></div>`).join('');
        // The estimate first, because a column of eleven numbers with no summary is not more honest
        // than a summary -- it just moves the summarising to someone with less information.
        const head = `<div class="rv-est rv-ev-${est.level}">
            <span class="rv-ev-flag rv-ev-${est.level}">${esc(est.level)}</span>
            <b>Overall estimate</b>
            <span class="rv-est-text">${esc(est.text)}</span></div>`;
        return `<div class="rv-ind-col"><h4>${esc(name)}</h4>${head}`
            + `${items || '<div class="rv-ev">Not enough data.</div>'}</div>`;
    };
    $('rv_indicators').innerHTML = col('w') + col('b');
}


// ---- the human-likeness report (opt-in) ---------------------------------------------------------
// A second reading of the same game, by a different judge. The engine asks "how good was this move";
// Maia asks "how expected was it from a player of this rating". They disagree constantly, and that
// is the point -- a move can be excellent and completely out of character, or awful and exactly what
// you would expect. Off by default: it costs a whole second pass.
// The rating that best explains what was played, with the range this game cannot see past and the
// number of decisions it is drawn from. A peak on its own would claim a precision that twenty-odd
// moves do not carry, so the support interval is shown as the headline's equal, not as a footnote.
function renderStrength() {
    const sec = $('rv-strength');
    if (!sec) return;
    const st = report?.strength;
    const on = !!(st && (st.w || st.b));
    sec.classList.toggle('hidden', !on);
    if (!on) return;

    const model = st.kind === 'maia3' ? 'Maia 3' : 'Maia 1';
    $('rv_strength_note').innerHTML =
        `Each rating the ${esc(model)} model has was asked what it would play in every position where there `
      + `was a real choice - book moves and forced moves are left out, because everyone plays those the same `
      + `way. The rating shown is the one that was least surprised by what actually happened. `
      + `<b>This is a strength estimate, not a fair-play measurement</b>: a player using an engine reads as `
      + `STRONGER here, not as suspicious, and one game is a small sample however it is counted.`;

    const PHASE_LBL = {opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame'};
    const card = (color, s) => {
        if (!s) return '';
        const spread = s.low === s.high ? `${s.low}` : `${s.low}–${s.high}`;
        // the curve, so the shape behind the number is visible: a sharp peak and a flat line are very
        // different claims and the headline number looks identical either way
        const max = Math.max(...s.curve.map(r => r.ll));
        const min = Math.min(...s.curve.map(r => r.ll));
        const bars = s.curve.map(r => {
            const h = max === min ? 100 : Math.round(((r.ll - min) / (max - min)) * 100);
            return `<span class="rv-str-bar" title="${r.band}: ${r.ll.toFixed(1)}">`
                 + `<i style="height:${Math.max(3, h)}%"></i></span>`;
        }).join('');
        // per-phase read-out: the same estimate over each phase's own decisions
        const ph = ['opening', 'middlegame', 'endgame']
            .filter(k => s.phases[k])
            .map(k => `<span><b>${PHASE_LBL[k]}</b> ${s.phases[k].best}</span>`).join('');
        const phase = ph ? `<div class="rv-str-phase">${ph}</div>` : '';
        return `<div class="rv-card">
            <h4>${esc(playerName(color))}</h4>
            <div class="rv-big">${s.best}</div>
            <div class="rv-kv"><span>Ratings this game cannot tell apart</span><span>${spread}</span></div>
            <div class="rv-kv"><span>Decisions it is drawn from</span><span>${s.n}</span></div>
            ${[['top3', 'match', 'hit', 'played the same move'],
                ['top3in2', 'match2', 'hit2', 'had it in its top 2'],
                ['top3in3', 'match3', 'hit3', 'had it in its top 3']]
                .filter(([key]) => s[key]?.length)
                .map(([key, pct, cnt, what]) => `<div class="rv-str-top3">
                    <span class="rv-str-top3-h">Closest ratings &mdash; ${what}</span>${
                    s[key].map((r, i) => `<div class="rv-kv"><span>${i + 1}. ${r.band}</span>`
                        + `<span>${r[cnt]}/${s.n} &middot; ${(r[pct] * 100).toFixed(0)}%</span></div>`).join('')
                }</div>`).join('')}
            <div class="rv-str-curve">${bars}</div>
            <div class="rv-sub">${st.bands[0]} to ${st.bands[st.bands.length - 1]}, taller is a better fit</div>
            ${phase}
        </div>`;
    };
    $('rv_strength_cards').innerHTML = card('w', st.w) + card('b', st.b);

    // the moves the number is built on: for each side, the handful that pushed the winning band past
    // its nearest rival, so the estimate can be argued with instead of just read
    const evidence = (color, s) => {
        if (!s || !s.evidence.length) return '';
        const rows = s.evidence.map(e => {
            const alt = e.top && e.top.uci !== e.uci
                ? ` <span class="rv-str-alt">${esc(s.winner)} would play ${esc(uciToSan(report.positions[e.ply].fen, e.top.uci))}</span>`
                : '';
            return `<li><a href="#" data-ply="${e.ply}">${esc(moveLabel(e))}</a> `
                 + `<span class="rv-str-pct">${s.winner}: ${(e.pWin * 100).toFixed(0)}%</span> `
                 + `<span class="rv-str-pct rv-str-dim">${s.rival}: ${(e.pRival * 100).toFixed(0)}%</span>`
                 + `${alt}</li>`;
        }).join('');
        return `<div class="rv-str-ev">
            <h4>${esc(playerName(color))} reads as ${s.best}, not ${s.rival} — because of these</h4>
            <ol>${rows}</ol></div>`;
    };
    $('rv_strength_evidence').innerHTML = evidence('w', st.w) + evidence('b', st.b);

    // compare-two-ratings control: the sweep already holds every band's answer for every position, so
    // picking two and listing where they disagree most is arithmetic over data that is already here
    const opt = (sel) => st.bands.map(b => `<option value="${b}"${b === sel ? ' selected' : ''}>${b}</option>`).join('');
    const a0 = st.bands[0], b0 = st.bands[st.bands.length - 1];
    $('rv_strength_compare').innerHTML = `
        <h4>Compare two ratings</h4>
        <div class="rv-str-cmp-ctl">
            <select id="rv_cmp_a" class="browser-default">${opt(a0)}</select>
            <span>vs</span>
            <select id="rv_cmp_b" class="browser-default">${opt(b0)}</select>
        </div>
        <div id="rv_cmp_out" class="rv-str-cmp-out"></div>`;
    const reRun = () => renderStrengthCompare(+$('rv_cmp_a').value, +$('rv_cmp_b').value);
    $('rv_cmp_a').addEventListener('change', reRun);
    $('rv_cmp_b').addEventListener('change', reRun);
    reRun();

    // one delegated jump-to-board for every move link the section draws (evidence + compare)
    if (!sec.dataset.plyBound) {
        sec.dataset.plyBound = '1';
        sec.addEventListener('click', (e) => {
            const a = e.target.closest('a[data-ply]');
            if (!a) return;
            e.preventDefault();
            showPly(+a.dataset.ply + 1);
        });
    }
}

// The two picked ratings, side by side, over the positions where they most disagree about what to
// play. Pure arithmetic over the stored sweep -- no engine, so it is instant on every dropdown change.
function renderStrengthCompare(a, b) {
    const out = $('rv_cmp_out');
    const st = report?.strength;
    if (!out || !st) return;
    if (a === b) { out.innerHTML = `<p class="rv-sub">Pick two different ratings.</p>`; return; }
    const rows = st.moves.map(r => {
        const ta = r.top[a], tb = r.top[b];
        if (!ta || !tb) return null;
        // rank disagreements: a different top move first (weighted by how sure each side is), then by
        // how far apart the two ratings are on the move that was actually played
        const differ = ta.uci !== tb.uci;
        const score = (differ ? 100 : 0) + ta.prob + tb.prob
                    + Math.abs(Math.log(Math.max(r.prob[a] ?? 0, 1e-6)) - Math.log(Math.max(r.prob[b] ?? 0, 1e-6)));
        return {r, ta, tb, differ, score};
    }).filter(Boolean).sort((x, y) => y.score - x.score).slice(0, 8);
    if (!rows.every(x => x.differ) || !rows.length) { /* still show what we have */ }
    const pick = (fen, t) => `${esc(uciToSan(fen, t.uci))} <span class="rv-str-pct">${(t.prob * 100).toFixed(0)}%</span>`;
    const body = rows.map(({r, ta, tb}) => {
        const fen = report.positions[r.ply].fen;
        return `<tr><td><a href="#" data-ply="${r.ply}">${esc(moveLabel(r))}</a></td>`
             + `<td>${pick(fen, ta)}</td><td>${pick(fen, tb)}</td></tr>`;
    }).join('');
    out.innerHTML = body
        ? `<table class="rv-str-cmp-tbl"><thead><tr><th>Position</th><th>${a} plays</th><th>${b} plays</th></tr></thead><tbody>${body}</tbody></table>`
        : `<p class="rv-sub">These two ratings played this game the same way.</p>`;
}

// The same four buckets as a bar per player, in the width the cards were leaving empty. The
// buckets are ORDERED (its first choice -> outside its list entirely), so the colour job is
// SEQUENTIAL: one hue, light to dark, never a categorical rainbow. The ramp was checked with the
// palette validator on this page's dark surface -- adjacent steps separate at ΔE 15.5 normal /
// 14.1 protan and every step clears 3:1 against the surface. (Its categorical lightness-band and
// chroma checks fail by design here: a sequential ramp is meant to span lightness and to end near
// neutral.) Every segment is also direct-labelled and legended, so identity is never colour alone.
const HUMAN_RAMP = ['#f2fae6', '#a9d977', '#5fae4a', '#2f7d41'];
const HUMAN_LABEL = ['Its first choice', 'Its next two', 'Further down', 'Outside its list'];

function renderHumanChart() {
    const el = $('rv_human_chart');
    if (!el) return;
    const rows = ['w', 'b'].map(color => {
        const mine = report.moves.filter(m => m.color === color && m.maiaRank != null);
        if (!mine.length) return '';
        const buckets = [0, 0, 0, 0];
        for (const m of mine) {
            const r = m.maiaRank;
            buckets[r === 1 ? 0 : r <= 3 ? 1 : r <= 5 ? 2 : 3]++;
        }
        // The HEADLINE is the share the model played itself -- that is the number people compare.
        // It goes in text, at full size; the bar underneath is thin and quiet, and carries the
        // shape. Numbers inside the segments made every bar shout and the sliver ones illegible.
        const matched = Math.round(buckets[0] / mine.length * 100);
        const segs = buckets.map((n, i) => n
            ? `<div class="rv-hseg" style="flex: 0 0 ${n / mine.length * 100}%; background: ${HUMAN_RAMP[i]}"`
              + ` title="${esc(HUMAN_LABEL[i])}: ${n} of ${mine.length} (${Math.round(n / mine.length * 100)}%)"></div>`
            : '').join('');
        return `<div class="rv-hrow">
            <div class="rv-hhead"><b>${esc(playerName(color))}</b>
                <span class="rv-hnum">${matched}%</span>
                <span class="rv-hsub">played the model's own move &middot; ${mine.length} moves</span></div>
            <div class="rv-hbar">${segs}</div>
        </div>`;
    }).join('');
    if (!rows) { el.innerHTML = ''; return; }
    const legend = HUMAN_LABEL.map((t, i) =>
        `<span><i style="background:${HUMAN_RAMP[i]}"></i>${esc(t)}</span>`).join('');
    el.innerHTML = rows + `<div class="rv-hlegend">${legend}</div>`;
}

function renderHumanReport() {
    const sec = $('rv-human');
    if (!sec) return;
    const on = cfg('rv_human_report') && report.moves.some(m => m.maiaRank != null);
    sec.classList.toggle('hidden', !on);
    if (!on) return;
    const band = report.humanKind === 'maia3' ? cfg('rv_maia3_elo') : cfg('rv_maia_band');
    const col = (color) => {
        const mine = report.moves.filter(m => m.color === color && m.maiaRank != null);
        if (!mine.length) return '';
        const buckets = [0, 0, 0, 0];  // its 1st, 2nd-3rd, 4th-5th, outside its list
        for (const m of mine) {
            const r = m.maiaRank;
            buckets[r === 1 ? 0 : r <= 3 ? 1 : r <= 5 ? 2 : 3]++;
        }
        const LABEL = ['Exactly what it expected', 'Among its next two', 'Further down its list',
                       'Outside its list entirely'];
        const rows = buckets.map((n, i) => `<div class="rv-kv"><span>${LABEL[i]}</span>`
            + `<span>${n} (${Math.round(n / mine.length * 100)}%)</span></div>`).join('');
        // The moves worth looking at: the engine's first choice, and nowhere near the human model's.
        const odd = report.moves.filter(m => m.color === color && m.rank === 1 && m.maiaRank > 3
            && !m.isBook && !m.onlyMove).slice(0, 8);
        const oddList = odd.length
            ? `<div class="rv-sub" style="margin-top:10px">Engine's move, not the human model's: `
              + odd.map(m => `<a href="#" data-ply="${m.ply}">${esc(moveLabel(m))}</a>`).join(', ') + '</div>'
            : '';
        return `<div class="rv-card"><h4>${esc(playerName(color))}</h4>${rows}${oddList}</div>`;
    };
    $('rv_human_cards').innerHTML = col('w') + col('b');
    renderHumanChart();
    $('rv_human_note').textContent =
        `Judged against Maia at ${band}. This says nothing about whether a move was GOOD -- it is`
        + ` how expected the move was from a human at that rating.`;
    $('rv_human_cards').onclick = (e) => {
        const a = e.target.closest('a[data-ply]');
        if (!a) return;
        e.preventDefault();
        showPly(+a.dataset.ply + 1);
        $('rv-report').scrollIntoView({behavior: 'smooth', block: 'start'});
    };
}

// ---- the batch summary --------------------------------------------------------------------------
// One game cannot answer a fair-play question, which is the whole reason this exists: the same
// player's numbers ACROSS games is the only version of the question with an answer worth having.
function renderBatch() {
    const sec = $('rv-batch');
    if (!sec) return;
    sec.classList.toggle('hidden', !batchReports || batchReports.length < 2);
    if (!batchReports || batchReports.length < 2) return;

    // Per player name, pooled over every game they appear in. Pooled, not averaged: a 20-move game
    // and a 90-move game are not one vote each.
    const players = new Map();
    for (const r of batchReports) {
        for (const c of ['w', 'b']) {
            const key = (c === 'w' ? r.game.tags.White : r.game.tags.Black) || '?';
            const p = players.get(key) || {name: key, games: 0, moves: [], accs: []};
            p.games++;
            p.moves.push(...r.moves.filter(m => m.color === c));
            if (r.accuracy[c] != null) p.accs.push(r.accuracy[c]);
            players.set(key, p);
        }
    }
    const pooled = [...players.values()].map(p => {
        const ind = Core.indicators(p.moves.map((m, i) => ({...m, ply: i, color: 'w'})), 'w',
                                    report.opts.multipv, null, {});
        const ev = Core.evidence(ind, {});
        return {...p, ind, ev, est: Core.estimate(ev, ind),
                acc: p.accs.length ? p.accs.reduce((a, b) => a + b, 0) / p.accs.length : null};
    }).sort((a, b) => b.games - a.games);

    $('rv_batch_players').innerHTML = pooled.map(p => `<div class="rv-card">
        <h4>${esc(p.name)}</h4>
        <div class="rv-big">${p.acc == null ? ' - ' : p.acc.toFixed(1) + '%'}</div>
        <div class="rv-sub">mean accuracy over ${p.games} game${p.games === 1 ? '' : 's'},
            ${p.ind.moves} moves</div>
        <div style="margin-top:10px">
          <div class="rv-kv"><span>Engine's first choice, real choices</span>
            <span>${p.ind.realTop1 == null ? ' - ' : Math.round(p.ind.realTop1 * 100) + '%'}</span></div>
          <div class="rv-kv"><span>...in sharp positions</span>
            <span>${p.ind.sharpTop1 == null ? ' - ' : Math.round(p.ind.sharpTop1 * 100) + '%'}</span></div>
          <div class="rv-kv"><span>Avg. centipawn loss</span><span>${p.ind.acpl ?? ' - '}</span></div>
        </div>
        <div class="rv-ev" style="margin-top:10px">
          <span class="rv-ev-flag rv-ev-${p.est.level}">${esc(p.est.level)}</span>${esc(p.est.text)}
        </div>
    </div>`).join('');

    $('rv_batch_games').innerHTML = `<table class="rv-table"><thead><tr>
        <th>#</th><th>White</th><th>Black</th><th>Result</th><th>Date</th>
        <th class="n">Acc. W</th><th class="n">Acc. B</th><th>Opening</th></tr></thead><tbody>`
        + batchReports.map((r, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(r.game.tags.White || '?')}</td>
            <td>${esc(r.game.tags.Black || '?')}</td>
            <td>${esc(r.game.result)}</td>
            <td>${esc(Core.formatDate(r.game.tags.Date))}</td>
            <td class="n">${r.accuracy.w == null ? '' : r.accuracy.w.toFixed(1)}</td>
            <td class="n">${r.accuracy.b == null ? '' : r.accuracy.b.toFixed(1)}</td>
            <td>${esc(r.book.name || '')}</td></tr>`).join('')
        + '</tbody></table>';
}

// ---- board ------------------------------------------------------------------------------------

function ensureBoard() {
    const host = $('rv_board');
    if (!host) return;
    const [set, ext] = String(cfg('pieces') || 'wikipedia.svg').split('.');
    board = MephistoBoard(host, {
        position: 'start',
        pieceTheme: `/res/chesspieces/${set}/{piece}.${ext}`,
        showNotation: true,
        orientation: flipped ? 'black' : 'white',
    });
}

// Black on top, white at the bottom -- unless the board is flipped, in which case they swap with it.
// Title, name and rating, which playerName/playerLine already assemble from the PGN tags.
function renderPlayers() {
    const top = $('rv_player_top'), bottom = $('rv_player_bottom');
    if (!top || !bottom) return;
    const flipped = board && board.orientation && board.orientation() === 'black';
    const strip = (color) => {
        const t = report.game.tags;
        const title = color === 'w' ? t.WhiteTitle : t.BlackTitle;
        const elo = color === 'w' ? t.WhiteElo : t.BlackElo;
        const name = (color === 'w' ? t.White : t.Black) || (color === 'w' ? 'White' : 'Black');
        return `<span class="rv-p-dot"></span>`
            + (title && title !== '-' ? `<span class="rv-p-title">${esc(title)}</span>` : '')
            + `<span class="rv-p-name">${esc(name)}</span>`
            + (elo ? `<span class="rv-p-elo">${esc(String(elo))}</span>` : '');
    };
    // The strip above the board belongs to whoever is playing from the far side.
    const topColor = flipped ? 'w' : 'b';
    top.className = 'rv-player rv-p-' + (topColor === 'w' ? 'white' : 'black');
    bottom.className = 'rv-player rv-p-' + (topColor === 'w' ? 'black' : 'white');
    top.innerHTML = strip(topColor);
    bottom.innerHTML = strip(topColor === 'w' ? 'b' : 'w');
}

function showPly(ply) {
    renderPlayers();
    if (!report) return;
    cursor = Core.clamp(ply, 0, report.positions.length - 1);
    const pos = report.positions[cursor];
    board?.position(pos.fen);
    const played = cursor > 0 ? report.moves[cursor - 1] : null;
    drawArrows(pos, played);
    renderEvalBar(pos);
    renderDetail(pos, played);
    setGraphCursor();
    document.querySelectorAll('.rv-mcell.rv-sel').forEach(el => el.classList.remove('rv-sel'));
    const sel = document.querySelector(`.rv-mcell[data-ply="${cursor - 1}"]`);
    if (sel) {
        sel.classList.add('rv-sel');
        sel.scrollIntoView({block: 'nearest'});
    }
}

// The eval beside the board, on the same white-relative centipawns the graph is drawn from and the
// same logistic squash, so the bar and the graph can never disagree about who is better.
function renderEvalBar(pos) {
    const fill = $('rv_evalfill'), label = $('rv_evallabel');
    if (!fill && !label) return;
    // chess.com's reviews DO carry a centipawn eval -- it is a zigzag varint in the protobuf, which
    // read as an unsigned magnitude and so looked like nonsense. Decoded, the bar works on this path
    // too; it only hides when a position genuinely has no line.
    const cp = pos?.lines?.[0]?.cp;
    const bar = (fill || label)?.closest('.rv-bar');
    if (bar) bar.classList.remove('hidden');
    const mated = cp != null && Core.isMateScore(cp);
    // A mate fills the bar OUTRIGHT. The 2..98 clamp exists so a huge but finite eval still shows a
    // sliver of the losing side; a mate is not huge-but-finite, and leaving 2% for the mated player
    // reads as "still something there".
    const pct = cp == null ? 50 : mated ? (cp > 0 ? 100 : 0)
        : Core.clamp(50 + 50 * Math.tanh(cp / 400), 2, 98);
    if (fill) fill.style.height = `${pct}%`;
    if (label) {
        label.textContent = cp == null ? '' : (mated ? (cp > 0 ? 'M' : '-M') + (Core.MATE_CP - Math.abs(cp)) : (cp / 100).toFixed(1));
        label.classList.toggle('rv-num-top', pct < 50);   // the number rides the filled side
    }
}

// The move that was played, in its classification colour, plus the engine's alternatives for the
// position now on the board. Drawn back to front so the best line sits on top of the rest.
function drawArrows(pos, played) {
    const svg = $('rv_arrows');
    if (!svg) return;
    // The renderer floors the square size and draws a 2px border, so the board is never exactly the
    // wrapper's box. Take the overlay's geometry from the board element itself rather than from the
    // wrapper, or every arrow lands a few pixels off its square.
    const inner = $('rv_board')?.querySelector('.board-b72b1');
    if (inner && inner.clientWidth) {
        // Measured against the WRAPPER, not via offsetTop. offsetTop resolves against the nearest
        // POSITIONED ancestor, and on a return visit the page's stylesheet has not been applied yet
        // -- .rv-board-wrap is still `static`, so the offset came back in document coordinates
        // (7847px) and the overlay parked itself two screens below the board. That stale box also
        // set the document height, which is the "long empty page with a floating arrow" bug.
        const wb = svg.parentElement.getBoundingClientRect(), ib = inner.getBoundingClientRect();
        svg.style.left = `${ib.left - wb.left + 2}px`;
        svg.style.top = `${ib.top - wb.top + 2}px`;
        svg.style.width = `${inner.clientWidth}px`;
        svg.style.height = `${inner.clientHeight}px`;
    }
    const specs = [];
    // The engine's lines first, thinning and fading down the list, so #1 reads as the recommendation
    // and the rest as context.
    (pos.lines || []).slice(0, report.opts.multipv).forEach((l, i) => {
        if (!l.pv?.[0]) return;
        specs.push({
            uci: l.pv[0],
            color: ENGINE_ARROW,
            width: Math.max(0.085, 0.15 - i * 0.022),
            opacity: Math.max(0.3, 0.82 - i * 0.15),
            rank: i + 1,
        });
    });
    // The played move last, so it is drawn on top of everything: it is the thing being judged.
    if (played) {
        specs.push({
            uci: played.uci,
            color: CLASS_COLOUR[played.klass] || CLASS_COLOUR.good,
            width: 0.17,
            opacity: 0.95,
            played: true,
        });
    }
    let html = specs.map(arrow).filter(Boolean).join('');
    // The engine's rank sits ON its arrow -- "1" over the move it actually likes, which is the
    // whole point of drawing more than one line. Numbers go above the arrows, badge above those.
    html += specs.filter(s => s.rank).map(s => rankTag(s)).join('');
    // The verdict badge on the destination square, the way a review is read everywhere else.
    if (played && played.klass) {
        const to = played.uci.slice(2, 4);
        const f = to.charCodeAt(0) - 97, r = +to[1];
        const x = flipped ? 7.5 - f : f + 0.5;
        const y = flipped ? r - 0.5 : 8.5 - r;
        html += classBadge(played.klass, x + 0.32, y - 0.32, 0.20);
    }
    svg.innerHTML = html;
}

const ENGINE_ARROW = '#2f7d41';

// The engine's rank, drawn at the END of its arrow -- by the arrowhead, offset to the side. Placing
// it there (not partway along the shaft) keeps the numbers apart even when several lines run up the
// same file: each number sits at its own destination square. Only the engine lines carry one; the
// played move is identified by its badge.
function rankTag(spec) {
    const m = /^([a-h][1-8])([a-h][1-8])/.exec(spec.uci || '');
    if (!m) return '';
    const sq = (t) => {
        const f = t.charCodeAt(0) - 97, r = +t[1];
        return flipped ? {x: 7.5 - f, y: r - 0.5} : {x: f + 0.5, y: 8.5 - r};
    };
    const a = sq(m[1]), b = sq(m[2]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // pulled back a touch from the arrowhead and offset to the side, so the number rides beside the
    // tip rather than under it -- at the line's end, where two colinear arrows no longer collide.
    const px = b.x - dx / len * 0.24 - dy / len * 0.26;
    const py = b.y - dy / len * 0.24 + dx / len * 0.26;
    return `<g opacity="${Math.max(0.55, spec.opacity)}">`
        + `<circle cx="${px}" cy="${py}" r="0.135" fill="${spec.color}" stroke="#00000040" stroke-width="0.012"/>`
        + `<text x="${px}" y="${py + 0.050}" font-size="0.17" font-weight="700" text-anchor="middle" `
        + `fill="#fff" font-family="system-ui,sans-serif">${spec.rank}</text></g>`;
}

// ---- classification badges ---------------------------------------------------------------------
// The little circle that sits on the move's destination square, the way every review UI shows a
// verdict: colour carries the judgement, the glyph carries the name. DRAWN HERE rather than
// imported: the well-known set belongs to chess.com, and shipping their artwork in a public repo
// would be copying it. These are our own glyphs in the same visual language, so the meaning reads
// instantly to anyone who has seen a review before without lifting a single file.
//
// Each entry is {fill, glyph} where glyph is SVG drawn in a 24x24 box centred on the circle.
const CLASS_BADGE = {
    brilliant: {fill: '#1aada6', text: '!!'},
    great:     {fill: '#5c8bb0', text: '!'},
    best:      {fill: '#3fa45b', star: true},
    excellent: {fill: '#5aab61', check: true},
    good:      {fill: '#8fa45a', thumb: true},
    book:      {fill: '#a88865', book: true},
    forced:    {fill: '#7f8b95', text: '='},
    inaccuracy:{fill: '#e0a53f', text: '?!'},
    mistake:   {fill: '#e08b3c', text: '?'},
    miss:      {fill: '#d05c5c', cross: true},
    blunder:   {fill: '#c34141', text: '??'},
};

// One badge as an SVG group at board coordinates (cx, cy in squares, r in squares).
function classBadge(klass, cx, cy, r) {
    const b = CLASS_BADGE[klass];
    if (!b) return '';
    const s = r / 12; // the glyphs below are drawn in a 24-wide box, so 12 = r
    const at = (x, y) => `${cx + (x - 12) * s},${cy + (y - 12) * s}`;
    let glyph = '';
    if (b.text) {
        // the text sizes itself down for the two-character verdicts so both fit the circle
        const fs = (b.text.length > 1 ? 13 : 16) * s;
        glyph = `<text x="${cx}" y="${cy + fs * 0.35}" font-size="${fs}" font-weight="700" `
              + `text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">${b.text}</text>`;
    } else if (b.check) {
        glyph = `<path d="M ${at(6.5, 12.5)} L ${at(10.5, 16.5)} L ${at(17.5, 8)}" fill="none" `
              + `stroke="#fff" stroke-width="${2.6 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (b.star) {
        const pts = [];
        for (let i = 0; i < 10; i++) {
            const rad = (i % 2 ? 3.4 : 7.6) * s;
            const a = -Math.PI / 2 + i * Math.PI / 5;
            pts.push(`${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`);
        }
        glyph = `<polygon points="${pts.join(' ')}" fill="#fff"/>`;
    } else if (b.thumb) {
        // a thumbs-up reduced to its two readable parts: the fist and the raised thumb
        glyph = `<path d="M ${at(8, 11)} L ${at(8, 17.5)} L ${at(15.5, 17.5)} `
              + `C ${at(16.8, 17.5)} ${at(17.4, 16.6)} ${at(17.4, 15.6)} `
              + `L ${at(17.4, 12.6)} C ${at(17.4, 11.7)} ${at(16.7, 11)} ${at(15.8, 11)} `
              + `L ${at(12.8, 11)} L ${at(13.4, 8.2)} C ${at(13.6, 7)} ${at(12.7, 6)} `
              + `${at(11.6, 6.2)} C ${at(11, 6.3)} ${at(10.7, 6.8)} ${at(10.5, 7.4)} `
              + `L ${at(9.2, 10.4)} Z" fill="#fff"/>`
              + `<rect x="${cx - 8.6 * s}" y="${cy - 1.4 * s}" width="${3.2 * s}" height="${7 * s}" rx="${0.8 * s}" fill="#fff"/>`;
    } else if (b.cross) {
        glyph = `<path d="M ${at(8, 8)} L ${at(16, 16)} M ${at(16, 8)} L ${at(8, 16)}" fill="none" `
              + `stroke="#fff" stroke-width="${2.8 * s}" stroke-linecap="round"/>`;
    } else if (b.book) {
        glyph = `<path d="M ${at(6, 7)} L ${at(11.4, 7)} C ${at(11.9, 7)} ${at(12, 7.6)} ${at(12, 8)} `
              + `L ${at(12, 17)} C ${at(11.6, 16.4)} ${at(11, 16.2)} ${at(10.4, 16.2)} `
              + `L ${at(6, 16.2)} Z" fill="#fff"/>`
              + `<path d="M ${at(18, 7)} L ${at(12.6, 7)} C ${at(12.1, 7)} ${at(12, 7.6)} ${at(12, 8)} `
              + `L ${at(12, 17)} C ${at(12.4, 16.4)} ${at(13, 16.2)} ${at(13.6, 16.2)} `
              + `L ${at(18, 16.2)} Z" fill="#fff" opacity="0.86"/>`;
    }
    return `<g class="rv-badge"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${b.fill}" `
         + `stroke="#00000033" stroke-width="${r * 0.08}"/>${glyph}</g>`;
}

// The same classification badge as an inline icon (a self-contained 24x24 SVG), for the move list and
// the summary cards -- the coloured dot said "there is a verdict"; the icon says which.
function classIcon(klass) {
    const g = classBadge(klass, 12, 12, 11);
    return g ? `<svg class="rv-mic" viewBox="0 0 24 24" aria-hidden="true">${g}</svg>` : '';
}



// One arrow in board coordinates (0..8 on both axes). A rounded shaft that stops short of the head
// so the two never overlap into a blob, a head with slightly concave wings so it reads as an arrow
// rather than a triangle stuck on a stick, and a soft outline underneath so a light arrow is still
// visible on a light square. The played move gets a dashed centre line, which is what distinguishes
// it from an engine arrow of the same colour when the two agree.
function arrow(spec) {
    const m = /^([a-h][1-8])([a-h][1-8])/.exec(spec.uci || '');
    if (!m) return '';
    const sq = (t) => {
        const f = t.charCodeAt(0) - 97, r = +t[1] - 1;
        return flipped ? {x: 7 - f + 0.5, y: r + 0.5} : {x: f + 0.5, y: 7 - r + 0.5};
    };
    const a = sq(m[1]), b = sq(m[2]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!len) return '';
    const ux = dx / len, uy = dy / len;
    const w = spec.width;
    const head = Math.min(0.34, len * 0.45);      // never longer than the move itself
    // start a little off the origin square's centre, so the piece under it stays readable
    const sx = a.x + ux * 0.16, sy = a.y + uy * 0.16;
    const ex = b.x - ux * head, ey = b.y - uy * head;
    const wing = head * 0.52;
    const nx = -uy, ny = ux;
    // concave back edge: the wings pull slightly toward the tip
    const notch = head * 0.22;
    const pts = [
        `${b.x},${b.y}`,
        `${ex + nx * wing},${ey + ny * wing}`,
        `${ex + ux * notch},${ey + uy * notch}`,
        `${ex - nx * wing},${ey - ny * wing}`,
    ].join(' ');
    // The outline is a STROKE on the same two shapes rather than a scaled copy underneath: a scaled
    // polygon drifts off its own tip, which is exactly where an arrow is read.
    const edge = 0.022;
    return `<g opacity="${spec.opacity}" stroke-linejoin="round">`
        + `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="#0000004d" `
        + `stroke-width="${w + edge * 2}" stroke-linecap="round"/>`
        + `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${spec.color}" `
        + `stroke-width="${w}" stroke-linecap="round"/>`
        + `<polygon points="${pts}" fill="${spec.color}" stroke="#0000004d" stroke-width="${edge * 2}"/>`
        + `</g>`;
}

function renderDetail(pos, played) {
    const el = $('rv_move_detail');
    if (!el) return;
    if (!played) {
        el.innerHTML = `<span class="rv-meta">Start position${report.book.name ? ` - ${esc(report.book.name)}` : ''}.</span>`;
    } else {
        const k = played.klass || 'good';
        const bits = [`<span class="rv-c-${k}"><span class="rv-klass">${CLASS_LABEL[k]}</span></span>`,
            `<b>${esc(moveLabel(played))}</b>`];
        if (played.cpLoss > 0) bits.push(`gave up ${Math.round(played.cpLoss)}cp`);
        if (played.rank) bits.push(`engine's #${played.rank}`);
        else if (played.best) bits.push(`engine played ${esc(uciToSan(report.positions[played.ply].fen, played.best))}`);
        if (played.seconds != null) bits.push(`${played.seconds.toFixed(1)}s on the clock`);
        if (played.maiaMove) {
            bits.push(played.maiaMatch
                ? 'the human model expected this'
                : `the human model expected ${esc(uciToSan(report.positions[played.ply].fen, played.maiaMove))}`);
        }
        // chess.com's coach line, when this is a chess.com review (engine reviews have none).
        if (played.commentary) bits.push(`<span class="rv-ccr-say">${esc(played.commentary)}</span>`);
        el.innerHTML = bits.join(' · ');
    }
    const lines = (pos.lines || []).slice(0, report.opts.multipv);
    $('rv_lines').innerHTML = lines.map((l, i) => {
        // White's perspective, always (user call 2026-08-24), matching the eval bar and the graph.
        // It used to flip to the side to move "like every engine UI", which meant the same position
        // read +0.4 on the bar and -0.39 in the line list. `mate` still arrives raw from UCI, so it
        // needs the flip that cp already had applied when engines.js parsed it.
        const mate = l.mate == null ? null : (pos.turn === 'w' ? l.mate : -l.mate);
        return `<div class="rv-line"><span class="rv-score">${esc(scoreText(l.cp, mate))}</span>
            <span class="rv-pv">${esc(pvToSan(pos.fen, l.pv).join(' '))}</span></div>`;
    }).join('');
}

// UCI -> SAN for display, under the RENDERED REPORT's rules. A pv that goes illegal (it can, at
// the tail of a truncated line) stops there rather than throwing the whole panel away.
// Two variant spellings need translating: a drop ('N@f3') is its own SAN, and a Chess960 castle
// arrives king-takes-rook -- when the target square holds the mover's own rook, that is O-O or
// O-O-O by which side of the king the rook stands.
function pvToSan(fen, pv) {
    const out = [];
    const variant = reportVariant();
    try {
        const chess = new Chess(variant, fen);
        for (const uci of (pv || []).slice(0, 12)) {
            let mv = null;
            try {
                if (uci.includes('@')) mv = chess.move(uci);
                else mv = chess.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
            } catch (e) { mv = null; }
            if (!mv && variant === 'fischerandom' && uci.length >= 4) {
                const target = chess.get?.(uci.slice(2, 4));
                if (target && target.type === 'r' && target.color === chess.turn()) {
                    const side = uci.charCodeAt(2) > uci.charCodeAt(0) ? 'O-O' : 'O-O-O';
                    try { mv = chess.move(side); } catch (e) { mv = null; }
                }
            }
            if (!mv) break;
            out.push(mv.san);
        }
    } catch (e) { /* stop at the last legal move */ }
    return out;
}

function uciToSan(fen, uci) {
    return pvToSan(fen, [uci])[0] || uci;
}

// ---- export -----------------------------------------------------------------------------------
// The report exactly as it looks on this page, minus the page: same markup, same stylesheets, same
// board. Rebuilding it as a second, simpler document was the first version and it drifted from the
// real one within a day -- two renderers for one report is one too many. This clones what is on
// screen instead, so the file cannot disagree with the page it came from.
//
// Everything it needs is inlined, because the file has to still open in five years on a machine
// that has never heard of this extension: the three stylesheets, the twelve piece images, and no
// script at all.

const EXPORT_CSS = ['/src/options/options.css', '/src/options/pages/review/review.css',
                    '/lib/chessboard/chessboard.min.css'];

// options.css styles the whole options SHELL, so the parts that assume a sidebar have to be undone.
// Kept as an explicit override block rather than by editing that sheet: it is the shell's stylesheet
// and it is right about the shell.
const EXPORT_RESET = `
  html, body { margin: 0; padding: 0; }
  body { padding: 28px 22px 40px; }
  header, main, footer { padding-left: 0 !important; }
  main > .container { width: 100% !important; max-width: 1180px; margin: 0 auto; }
  .set-sec:first-child { margin-top: 0; }
  .rv-nav, .rv-arrows text { display: none; }
  /* The board carries its own pixel size from the page it was cloned from, so the 1:1 wrapper must
     shrink to it. Left at a 1:1 ratio on a full-width column it became a 900px-tall box with a
     350px board sitting at the top of it. */
  .rv-board-wrap { width: max-content; aspect-ratio: auto; }
  .rv-board { width: auto; height: auto; }
  #rv_graph svg, .rv-mcell { cursor: default; }
  .rv-mcell:hover { background: none; }
  .rv-moves { max-height: none; }
  /* the page follows a toggle; a file follows whoever opens it */
  @media (prefers-color-scheme: dark) {
    :root {
      --mp-bg: #16171b; --mp-raised: #1c1e22; --mp-hair: #26282d; --mp-line: #34353d;
      --mp-text: #e8eaec; --mp-dim: #b7bbc0; --mp-mute: #6b7079; --mp-on: #3f9d54;
      --mp-on-soft: #16311e; --mp-track: #3a3a42;
    }
    .rv-c-best { --rv-c: #4bb265; } .rv-c-excellent { --rv-c: #63b478; }
    .rv-c-good { --rv-c: #98a3aa; } .rv-c-book { --rv-c: #b08d55; }
    .rv-c-forced { --rv-c: #8095c0; } .rv-c-inaccuracy { --rv-c: #d8a628; }
    .rv-c-mistake { --rv-c: #e08a3c; } .rv-c-blunder { --rv-c: #d15050; }
    .rv-ev-notable { color: #d8a628; } .rv-ev-high { color: #e08a3c; }
    .rv-ev-strong { color: #d15050; }
  }
`;

async function inlineText(path) {
    try {
        const r = await fetch(chrome.runtime.getURL(path.replace(/^\//, '')));
        return r.ok ? await r.text() : '';
    } catch (e) {
        return '';
    }
}

async function inlineImage(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const type = r.headers.get('content-type') || 'image/png';
        return `data:${type};base64,${btoa(bin)}`;
    } catch (e) {
        return null;
    }
}

// The full move table, which the page does not show: on screen the detail is a click away, in a
// file there is nothing to click.
function exportMoveTable() {
    const rows = report.moves.map(m => `<tr>
        <td>${esc(moveLabel(m))}</td>
        <td class="rv-c-${m.klass || 'good'}"><b>${esc(CLASS_LABEL[m.klass] || '')}</b></td>
        <td class="n">${m.evalBefore == null ? '' : esc(scoreText(m.evalBefore, null))}</td>
        <td class="n">${m.cpLoss == null ? '' : Math.round(m.cpLoss)}</td>
        <td class="n">${m.rank ?? ''}</td>
        <td class="n">${m.seconds == null ? '' : m.seconds.toFixed(1)}</td>
        <td>${m.best ? esc(uciToSan(report.positions[m.ply].fen, m.best)) : ''}</td>
        <td>${m.maiaMove ? esc(uciToSan(report.positions[m.ply].fen, m.maiaMove))
              + (m.maiaRank ? ` (#${m.maiaRank})` : '') : ''}</td>
        <td>${esc(Core.phaseOf(m.ply, report.phases || {}))}</td>
    </tr>`).join('\n');
    return `<section class="set-sec"><h3 class="set-h">Every move</h3>
      <table class="rv-table"><thead><tr>
        <th>Move</th><th>Quality</th><th>Eval</th><th>Lost</th><th>Rank</th><th>Time</th>
        <th>Engine</th><th>Human model</th><th>Phase</th>
      </tr></thead><tbody>${rows}</tbody></table></section>`;
}

async function exportHtml(btn) {
    if (!report) return;
    const label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
    try {
        // Show the start position, so the exported board is the game's own opening rather than
        // whatever move happened to be selected when the button was pressed.
        const wasAt = cursor;
        showPly(0);

        const css = (await Promise.all(EXPORT_CSS.map(inlineText))).join('\n') + EXPORT_RESET;

        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class="row"><div class="col s12"><div class="big-section">`
            + $('rv-report').outerHTML + ($('rv-strength')?.outerHTML || '') + $('rv-indicators').outerHTML
            + `</div></div></div>`;
        wrap.querySelectorAll('.hidden').forEach(el => el.classList.remove('hidden'));
        wrap.querySelectorAll('.rv-nav, .tooltipped .info-tooltip').forEach(el => el.remove());
        wrap.querySelector('#rv_graph_cursor')?.remove();
        wrap.querySelector('#rv_move_detail')?.remove();

        // the board's pieces are extension URLs, which mean nothing outside this browser
        const imgs = [...wrap.querySelectorAll('img[src]')];
        const seen = new Map();
        for (const img of imgs) {
            if (!seen.has(img.src)) seen.set(img.src, await inlineImage(img.src));
            const data = seen.get(img.src);
            if (data) img.src = data; else img.remove();
        }

        const t = report.game.tags;
        const title = `${playerName('w')} vs ${playerName('b')}`;
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Game review - ${esc(title)}</title>
<style>${css}</style>
</head><body><main><div class="container">
${wrap.innerHTML}
${exportMoveTable()}
<section class="set-sec"><h3 class="set-h">PGN</h3>
  <pre class="rv-pgn-out">${esc(report.pgnText || '')}</pre></section>
<p class="rv-status">Generated ${esc(Core.formatDate(new Date().toISOString().slice(0, 10).replace(/-/g, '.')))}
 by the Mephisto Chess Extension. The analysis in this file was produced on the machine that wrote it;
 nothing was uploaded.</p>
</div></main></body></html>`;

        showPly(wasAt);
        const name = `review-${(t.White || 'white').replace(/\W+/g, '_')}`
            + `-vs-${(t.Black || 'black').replace(/\W+/g, '_')}.html`;
        const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

// ---- chess.com import -------------------------------------------------------------------------
// The public archive API: no key, no login, public games only. Reachable from here because an
// EXTENSION PAGE is not subject to the page CORS rules a content script would be -- and doing it
// here rather than in the game tab means chess.com never sees the request alongside a live game.

async function fetchChesscom(user) {
    const clean = String(user || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!clean) throw new Error('Type a chess.com username first.');
    const arch = await fetch(`https://api.chess.com/pub/player/${clean}/games/archives`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`chess.com answered ${r.status}`)));
    const urls = (arch.archives || []).slice(-2).reverse(); // this month and last
    if (!urls.length) throw new Error(`No public games found for "${clean}".`);
    const out = [];
    for (const u of urls) {
        const month = await fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
        for (const g of (month?.games || [])) if (g.pgn) out.push(g.pgn);
        if (out.length >= 40) break;
    }
    if (!out.length) throw new Error(`No games with a PGN in "${clean}"'s last two months.`);
    return out.reverse().slice(0, 40).join('\n\n');
}

// Lichess, same shape: the export API is public, takes a username, and answers PGN directly -- with
// the same [%clk] comments the think-time cards already read. Standard chess only (perfType): the
// review's board, openings and phases are all standard, so a crazyhouse game would only come back as
// a broken review with no hint of why.
async function fetchLichess(user) {
    const clean = String(user || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!clean) throw new Error('Type a Lichess username first.');
    const r = await fetch(`https://lichess.org/api/games/user/${clean}?max=40&clocks=true`
                          + '&perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence',
                          {headers: {Accept: 'application/x-chess-pgn'}});
    if (r.status === 404) throw new Error(`No Lichess player called "${clean}".`);
    if (r.status === 429) throw new Error('Lichess is rate-limiting; wait a minute and try again.');
    if (!r.ok) throw new Error(`Lichess answered ${r.status}`);
    const text = (await r.text()).trim();
    if (!text) throw new Error(`No games found for "${clean}".`);
    return text;
}

// ---- page wiring ------------------------------------------------------------------------------

function loadPgnText(text) {
    const el = $('rv_pgn');
    if (el) el.value = text;
    parsePgnBox();
}

function parsePgnBox() {
    const text = $('rv_pgn')?.value || '';
    games = text.trim() ? Core.parsePgn(text) : [];
    const sel = $('rv_game_select');
    const row = $('rv_games_row');
    if (games.length > 1) {
        sel.innerHTML = games.map((g, i) => {
            const t = g.tags;
            return `<option value="${i}">${esc(`${i + 1}. ${t.White || '?'} - ${t.Black || '?'}`
                + `  ${g.result}  ${t.Date || ''}`)}</option>`;
        }).join('');
        row.classList.remove('hidden');
    } else {
        row.classList.add('hidden');
    }
    if (!text.trim()) note('');
    else if (!games.length) note('No games found in that text. A PGN needs at least one move.', true);
    else note(`${games.length} game${games.length > 1 ? 's' : ''} read`
        + (games.length === 1 ? ` - ${games[0].moves.length} moves` : '') + '.'
        + detectVariantFrom(selectedGame()));
}

function selectedGame() {
    if (!games.length) return null;
    const i = games.length > 1 ? +($('rv_game_select')?.value || 0) : 0;
    return games[i] || games[0];
}

async function onRun() {
    if (running) return;
    if (!games.length) return note('Paste a PGN first.', true);
    // FOUR-PLAYER TAKES ITS OWN LANE. Not a widening of this function: the two-player path builds
    // chess.js positions, an 8x8 board and a human pass, none of which exist for a 14x14 four-seat
    // game. review-4pc.js drives Tetrarch's host instead and renders its own report.
    // The GAME decides, not just the stored type: setCfg writes through the config cache, and a
    // click landing in the same tick as the parse note still read the pre-switch value -- so a
    // PGN4 went down the two-player path and silently sat there.
    if (is4pcGame || String(cfg('rv_variant')) === '4pc') return run4pcReview();
    const batch = cfg('rv_batch') && games.length > 1;
    const list = batch ? games : [selectedGame()];
    running = true;
    cancel = false;
    $('rv_run').disabled = true;
    $('rv_stop').disabled = false;
    note('');
    let rig = null;
    try {
        progress(0, 'starting the engine');
        rig = await startRig();
        const done = [];
        for (let g = 0; g < list.length; g++) {
            if (cancel) break;
            const label = batch ? `game ${g + 1} of ${list.length} - ` : '';
            // Each game gets its own slice of the bar, so a batch of forty does not sit at 2%.
            const base = g / list.length, span = 1 / list.length;
            const built = await runReview(list[g], rig,
                (frac, what) => progress(base + frac * span, label + what));
            built.pgnText = gameText(list[g]);
            done.push(built);
        }
        if (!done.length) throw new Error('stopped');
        batchReports = batch ? done : null;
        report = done[done.length - 1];
        report.pgnText = report.pgnText || ($('rv_pgn')?.value || '');
        renderReport();
        renderBatch();
        progress(1, batch ? `${done.length} games analysed` : 'done');
        $('rv-report').scrollIntoView({behavior: 'smooth', block: 'start'});
    } catch (e) {
        if (cancel) note('Stopped.');
        else note(String(e.message || e), true);
        progress(0, '');
        $('rv_progress_wrap')?.classList.add('hidden');
    } finally {
        disposeRig(rig);
        running = false;
        cancel = false;
        // The page is re-injected on every route change, so these can be gone by the time a long
        // run ends -- the run itself is module state and outlives the DOM it started from.
        if ($('rv_run')) $('rv_run').disabled = false;
        if ($('rv_stop')) $('rv_stop').disabled = true;
    }
}

// The PGN of one game as it was pasted, so the export can carry it. Rebuilt from the parse rather
// than re-split from the textarea: a batch needs one game's text, not all forty.
// Build the struct chess.com's v2 review wants, from a PGN. The MOVES are the load-bearing part --
// from/to squares chess.js gives us, converted to chess.com's 1-based index (a1=1..h8=64); the rest
// is metadata off the PGN tags. Player UUIDs are not in a PGN and are omitted (the worker notes the
// consequence). Castling/promotion move encoding is unverified upstream, so this refuses a game with
// one rather than send a guess that reads as a wrong move.
// The decoded review as readable text (the pane is a <pre>). SAN is merged in from the PGN we sent,
// since the response gives from/to squares, not SAN. The classification enum was mapped from a full
// capture (futzmutz111 vs dgango66): all 76 moves + the site's per-side counts + ten named moves
// (Qf2=brilliant .. Qb7=blunder) agree. 11=forced is the only-legal-move tier the collapsed panel folds away.
// chess.com's own Strength select -> the ordinal their request carries. Measured, not guessed.
const CCR_TIER = {Fast: 1, Standard: 2, Deep: 3, Maximum: 4};

const CCR_CLASS = {
    1: 'book', 2: 'brilliant', 3: 'great', 4: 'best', 5: 'excellent', 6: 'good',
    7: 'inaccuracy', 8: 'mistake', 9: 'blunder', 10: 'miss', 11: 'forced',
};
function renderCcrReview(r, pgnText) {
    const lines = [];
    if (r.opening?.name) lines.push(`${r.opening.name}${r.opening.eco ? ` (${r.opening.eco})` : ''}`);
    if (r.accuracy) lines.push(`Accuracy   White ${(+r.accuracy.white).toFixed(1)}   Black ${(+r.accuracy.black).toFixed(1)}`);
    // chess.com only returns a game rating when the PGN header carried one; hide the row otherwise.
    if (r.ratings && r.ratings.white != null && r.ratings.black != null)
        lines.push(`Rating     White ${r.ratings.white}   Black ${r.ratings.black}`);
    if (r.summaryLine) lines.push(r.summaryLine);
    lines.push('');
    let sans = [];
    try { sans = (Core.parsePgn(pgnText)[0]?.moves || []).map(m => typeof m === 'string' ? m : m.san); } catch (e) { /* */ }
    r.moves.forEach((m, i) => {
        const num = Math.floor(i / 2) + 1;
        const label = `${num}.${i % 2 ? '..' : ''} ${sans[i] || (m.from + m.to) || '?'}`.padEnd(9);
        const cls = (CCR_CLASS[m.classification] || `#${m.classification}`).padEnd(9);
        lines.push(`${label} ${cls} ${m.commentary || ''}`.trimEnd());
    });
    return lines.join('\n');
}

// Turn a decoded chess.com review into the SAME report shape the engine path builds, so the normal
// board + move list + badges render it. No engine data (no evals/lines), so the eval bar, graph and
// indicators sit out; what chess.com DOES give -- per-move classification, coach commentary, accuracy,
// opening -- lands on exactly the widgets the engine review uses for those same things. Positions come
// from replaying the PGN (chess.com sends from/to squares, not FENs), zipped by ply with the review.
// One line per position, in the shape the bar, the graph and the PV list already read. Mate is
// re-encoded the way toWhiteCp does it so isMateScore/scoreText print "M3" rather than a raw number.
function ccrLines(rm) {
    if (!rm) return [];
    if (rm.mateIn != null) {
        const cp = rm.mateIn >= 0 ? Core.MATE_CP - rm.mateIn : -(Core.MATE_CP + rm.mateIn);
        return [{cp, mate: rm.mateIn, pv: []}];
    }
    return rm.cp == null ? [] : [{cp: rm.cp, mate: null, pv: []}];
}

function buildCcrReport(review, pgnText) {
    const parsed = Core.parsePgn(pgnText)[0];
    if (!parsed || !parsed.moves.length) return null;
    const t = parsed.tags || {};
    let chess;
    try { chess = new Chess('chess', parsed.startFen || undefined); } catch (e) { return null; }
    const positions = [{fen: chess.fen(), lines: ccrLines(review.moves[0])}];
    const moves = [];
    parsed.moves.forEach((rec, i) => {
        const san = typeof rec === 'string' ? rec : rec.san;
        let mv;
        try { mv = chess.move(san); } catch (e) { mv = null; }
        if (!mv) return;
        const rm = review.moves[i] || {};
        moves.push({
            ply: i,
            color: mv.color === 'w' ? 'w' : 'b',
            san: mv.san,
            uci: mv.from + mv.to + (mv.promotion || ''),
            klass: CCR_CLASS[rm.classification] || 'good',
            commentary: rm.commentary || '',
            cpLoss: 0,
        });
        // chess.com's score for the move it just played IS the evaluation of the position that move
        // leads to, white-relative, so it lands on the position we are about to push. That gives the
        // eval bar and the graph real numbers on this path instead of a flat line.
        positions.push({fen: chess.fen(), lines: ccrLines(rm)});
    });
    if (!moves.length) return null;
    const counts = (color) => {
        const o = {};
        for (const k of Core.CLASS_ORDER) o[k] = 0;
        for (const m of moves) if (m.color === color) o[m.klass] = (o[m.klass] || 0) + 1;
        return o;
    };
    const stub = (color) => ({moves: moves.filter(m => m.color === color).length, acpl: null, top1: null, secMedian: null});
    return {
        game: {tags: t, result: parsed.result || t.Result || '*', moves},
        positions, moves,
        book: {plies: 0, name: review.opening?.name || ''},
        opts: {multipv: 1, variant: 'chess'},
        phases: {},
        accuracy: {w: review.accuracy ? +review.accuracy.white : null,
                   b: review.accuracy ? +review.accuracy.black : null},
        counts: {w: counts('w'), b: counts('b')},
        indicators: {w: stub('w'), b: stub('b')},
        ccr: true, ccrStrength: null,
        at: new Date().toISOString(),
    };
}

// ---- chess.com's classifier, run locally --------------------------------------------------------
// The THIRD way to review a game, and the only one that is both offline and chess.com's own verdict:
// our engine produces the evals, their explanation engine turns them into the classifications. See
// ee-host.js for what it is and why it is downloaded rather than shipped.
//
// This keeps the full report -- eval graph, arrows, indicators -- because unlike the `ccr` path we
// still have every line we searched. Only the judgements are theirs.
const EE_DEPTH = 10;      // chess.com's own budget, measured: `go depth 10`
const EE_MULTIPV = 2;     // ...with MultiPV 2, which is what the classifier is fed
const EE_THREADS = 1;     // ...on one thread, as their four single-threaded workers each do

// WHICH ENGINE DOES THE FALLBACK SEARCH -- and first, what "matching" even means here.
//
// THERE IS A CEILING, and it is not ours. chess.com's four Stockfish workers pull positions off a
// shared queue as they finish, so which positions share a transposition table changes with the
// timing of the run. Their own review is therefore not reproducible: reviewing the same game twice
// on chess.com agrees with itself only 94.1% of the time.
//
// MEASURED over TEN games against their bots, 16 moves each side, 320 scored plies. Every game was
// reviewed by chess.com TWICE (for the ceiling) and by this mode once, with their engine:
//
//     ours vs chess.com        308/320 = 96.2%
//     chess.com vs ITSELF      301/320 = 94.1%   <- the ceiling
//     accuracy (CAPS) apart    mean 0.32 points, median 0.17, worst 1.94
//
// We agree with them MORE than they agree with themselves, which is not a boast: our run is
// deterministic (one worker, positions in order) so it has no race to lose, while two of their runs
// each land somewhere slightly different. There is nothing left to chase here.
//
// The fallback engine, for when their Stockfish has not been downloaded, is Stockfish dev: over
// three earlier captured games it totalled 91/104 against Stockfish 18 Small's 88/104 -- despite
// Small being the same net class as their Lite build, which is the intuition that measurement
// overrides. With their engine present the question is moot.
const EE_ENGINE = 'stockfish-dev-nnue';

function eeElo(tags, color) {
    const raw = Number(tags?.[color === 'w' ? 'WhiteElo' : 'BlackElo']);
    // Their default when a game carries no rating. A wrong Elo is not cosmetic: the engine is
    // Elo-sensitive and the same game classifies differently at 600 and at 2000.
    return Number.isFinite(raw) && raw > 0 ? raw : 1500;
}

// Overwrite our own judgements with theirs. The engine numbers stay exactly as searched -- this
// replaces the verdicts, not the analysis.
function applyEeVerdict(built, verdict) {
    const pos = verdict.positions || [];
    built.moves.forEach((m, i) => {
        const p = pos[i + 1] || pos[i];               // their array is offset by the start position
        if (!p) return;
        m.klass = EE_CLASS[p.classificationName] || 'good';
        if (typeof p.caps2 === 'number') m.acc = p.caps2;
        const say = p.playedMove && p.playedMove.speech;
        if (say && (say.personal || say.impersonal)) m.commentary = say.personal || say.impersonal;
    });
    const caps = verdict.CAPS || {};
    built.accuracy = {w: caps.white ? caps.white.all : null, b: caps.black ? caps.black.all : null};
    built.counts = {w: countClasses(built.moves, 'w'), b: countClasses(built.moves, 'b')};
    if (verdict.book && verdict.book.name) built.book = {...built.book, name: verdict.book.name};
    built.ee = {version: EE_VERSION, summary: verdict.gameSummary || '',
                elo: {w: verdict.whiteElo, b: verdict.blackElo},
                effectiveElo: {w: verdict.reportCard?.white?.effectiveElo ?? null,
                               b: verdict.reportCard?.black?.effectiveElo ?? null}};
    return built;
}

// Render a chess.com report through the shared board/move-list, hiding the engine-only blocks.
function renderCcrReport(strengthLabel) {
    if (!report) return;
    report.ccrStrength = strengthLabel || null;
    $('rv-report').classList.remove('hidden');
    $('rv_export').disabled = true;                                    // no engine export
    $('rv-indicators')?.classList.add('hidden');                       // engine-only readings
    $('rv-strength')?.classList.add('hidden');
    $('rv-human')?.classList.add('hidden');
    $('rv_turning')?.classList.add('hidden');
    $('rv_time_wrap')?.classList.add('hidden');
    renderHeader();
    renderCards();
    renderGraph();
    renderMoves();
    ensureBoard();
    showPly(report.moves.length);
    $('rv-report').scrollIntoView({behavior: 'smooth', block: 'start'});
}

function buildCcrGame(pgnText) {
    const parsed = Core.parsePgn(pgnText)[0];
    if (!parsed || !parsed.moves.length) return {error: 'no game in that text'};
    const t = parsed.tags || {};
    const idx = (sq) => (sq.charCodeAt(0) - 96) + (Number(sq[1]) - 1) * 8;
    const PROMO = {n: 1, b: 2, r: 3, q: 4};   // n, r, q each verified from a capture; b bracketed between
    const chess = new Chess('chess', parsed.startFen || undefined);
    const moves = [];
    for (const rec of parsed.moves) {
        const san = typeof rec === 'string' ? rec : rec.san;
        let mv;
        try { mv = chess.move(san); } catch (e) { mv = null; }
        if (!mv) return {error: `could not replay "${san}" - is this legal, standard chess?`};
        const clk = (rec && rec.clk != null) ? Math.round(rec.clk * 1000) : 0;
        const m = {from: idx(mv.from), to: idx(mv.to), clockMs: clk};
        if (mv.promotion) m.promo = PROMO[mv.promotion] || PROMO.q;
        // castling: king from/to are mv.from/mv.to; the rook slides h->f (kingside) or a->d (queenside)
        if (mv.flags && (mv.flags.includes('k') || mv.flags.includes('q'))) {
            const rank = mv.from[1];
            const king = mv.flags.includes('k');
            m.castle = {rookFrom: idx((king ? 'h' : 'a') + rank), rookTo: idx((king ? 'f' : 'd') + rank)};
        }
        moves.push(m);
    }
    const gameId = (() => { const m = /chess\.com\/game\/live\/(\d+)/.exec(t.Link || ''); return m ? Number(m[1]) : 0; })();
    const tcBase = (() => { const m = /^(\d+)/.exec(t.TimeControl || ''); return m ? Number(m[1]) * 1000 : 0; })();
    const winner = t.Result === '1-0' ? 1 : t.Result === '0-1' ? 2 : 0;
    const now = Date.now();
    return {
        moves,
        white: {elo: Number(t.WhiteElo) || 0, name: t.White || 'White'},
        black: {elo: Number(t.BlackElo) || 0, name: t.Black || 'Black'},
        tcMs: tcBase,
        gameId,
        winner,
        reqUuid: (crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random()}`),
        ts: Math.floor(now / 1000),
        ns: (now % 1000) * 1e6,
        // f3 in the wire format; a constant in every capture of theirs, tier or not.
        strength: 10,
        // The real strength tier, an ordinal 1-4 -- see ccrEncodeGameReview for how it was mapped.
        tier: CCR_TIER[document.getElementById('rv_ccr_strength')?.value] || 2,
        coach: 'Botez_coach',
        locale: 'en-US',
    };
}

function gameText(game) {
    const tags = Object.entries(game.tags).map(([k, v]) => `[${k} "${v}"]`).join('\n');
    const body = [];
    for (let i = 0; i < game.moves.length; i++) {
        if (i % 2 === 0) body.push(`${i / 2 + 1}.`);
        body.push(game.moves[i].san);
        if (game.moves[i].clk != null) {
            const t = game.moves[i].clk;
            const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = (t % 60).toFixed(1);
            body.push(`{[%clk ${h}:${String(m).padStart(2, '0')}:${sec.padStart(4, '0')}]}`);
        }
    }
    body.push(game.result);
    return `${tags}\n\n${body.join(' ')}`;
}

// The budget is a -/+ BOX (user call 2026-08-16: the slider "is done terrible"). The box shows the
// number in each mode's natural units -- plies in Depth, seconds in Time -- and the -/+ buttons step
// by the input's own step (1 ply, 0.5s); any value can be typed. Time defaults to 0.5s. There is no
// infinite option any more: it was a slider notch with nowhere to live on a plain number box.

// EACH MODE REMEMBERS ITS OWN NUMBER (user report 2026-08-15: "budget for time and depth is weird").
// `rv_limit_value` stays the ACTIVE budget the run reads -- plies in Depth, MS in Time -- so nothing
// downstream changes; the box just edits it in friendlier units.
const PER_KIND_KEY = {depth: 'rv_limit_depth', time: 'rv_limit_time'};
const TIME_DEFAULT_MS_UI = 500;      // 0.5s, the review's default time budget (user call 2026-08-16)

function storedFor(kind) {
    const raw = MephistoConfig.get(PER_KIND_KEY[kind]);
    const v = raw == null || raw === '' ? null : +JSON.parse(raw);
    if (v && isFinite(v)) return v;
    return kind === 'depth' ? DEPTH_DEFAULT : TIME_DEFAULT_MS_UI;
}

// `fromInput` says the box is the truth this time (a keystroke or a -/+ step); otherwise the MODE is,
// so the box is loaded with the number this mode was last left on rather than reinterpreting the other
// mode's number in these units. Internal value is plies (Depth) or ms (Time).
function syncLimitUi(fromInput) {
    const kind = $('rv_limit_kind').value;
    const num = $('rv_limit_num');
    const isD = kind === 'depth';
    num.step = isD ? 1 : 0.5;            // the -/+ buttons read this
    num.min = isD ? 1 : 0.1;
    num.max = isD ? 40 : 300;
    let disp = fromInput ? parseFloat(num.value)
                         : (isD ? storedFor('depth') : storedFor('time') / 1000);
    if (!isFinite(disp)) disp = isD ? DEPTH_DEFAULT : TIME_DEFAULT_MS_UI / 1000;
    disp = isD ? Math.max(1, Math.min(40, Math.round(disp)))
               : Math.max(0.1, Math.min(300, Math.round(disp * 10) / 10));   // 0.1s resolution
    num.value = String(disp);
    const value = isD ? disp : Math.round(disp * 1000);   // internal: plies or ms
    $('rv_limit_value').value = value;
    setCfg('rv_limit_value', value);
    setCfg(PER_KIND_KEY[kind], value);
    updateEngineOptions();
}

// A native engine is disabled for ONE reason only: its host is not installed. It used to be greyed
// out in depth mode as well, because the host took a time budget and nothing else -- it takes a
// depth now, and an old host that does not understand the field falls back to the time cap, so
// there is no longer a combination that cannot run.
function updateEngineOptions() {
    const sel = $('rv_engine');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = ENGINES.map(e => {
        const missing = e.kind === 'native' && nativeAvailable && !nativeAvailable[e.id];
        return `<option value="${e.id}"${missing ? ' disabled' : ''}>`
            + `${esc(e.label + (missing ? ' - host not installed' : ''))}</option>`;
    }).join('');
    const opt = [...sel.options].find(o => o.value === current && !o.disabled);
    sel.value = opt ? current : ([...sel.options].find(o => !o.disabled)?.value || ENGINES[0].id);
    if (sel.value !== current) setCfg('rv_engine', sel.value);
}

function bindNumber(id, key) {
    const el = $(id);
    if (!el) return;
    el.value = cfg(key);
    el.addEventListener('change', () => {
        const n = Core.clamp(+el.value || CFG_DEFAULTS[key], +el.min || 0, +el.max || 1e9);
        el.value = n;
        setCfg(key, n);
    });
}

function bindSteppers() {
    document.querySelectorAll('.set-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = btn.parentElement.querySelector('input[type=number]');
            if (!input) return;
            const step = +btn.dataset.step || 1;
            const next = (+input.value || 0) + step * (Math.abs(step) === 1 ? (+input.step || 1) : 1);
            input.value = Core.clamp(next, +input.min || 0, +input.max || 1e9);
            input.dispatchEvent(new Event('change', {bubbles: true}));
        });
    });
}

function bindHumanUi() {
    const sel = $('rv_human');
    // The bands come from ONE list. The markup carries them too so the row renders before this runs,
    // but this is the authority -- a net added to the build should only have to be named once.
    const band0 = $('rv_maia_band');
    band0.innerHTML = MAIA_BANDS.map(b => `<option value="${b}">${b}</option>`).join('');
    const sync = () => {
        $('rv_maia_band').classList.toggle('hidden', sel.value !== 'maia');
        $('rv_maia3_wrap').classList.toggle('hidden', sel.value !== 'maia3');
    };
    sel.value = cfg('rv_human');
    sel.addEventListener('change', () => { setCfg('rv_human', sel.value); sync(); });
    const band = $('rv_maia_band');
    band.value = cfg('rv_maia_band');
    band.addEventListener('change', () => setCfg('rv_maia_band', band.value));
    sync();
}

class ReviewPage {
    async onInit() {
        await MephistoConfig.ready;
        await window.mephistoApplyLanguage?.();
        M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 1000});

        $('rv_pgn').addEventListener('input', parsePgnBox);
        $('rv_file_btn').addEventListener('click', () => $('rv_file').click());

        // ---- chess.com review (DEBUG STAGE): send the loaded game, show the raw JSON ----------
        // The game the button sends is EXACTLY the one the engine run would analyse -- the selected
        // entry when a file/fetch produced a list, the box otherwise -- so the two reviews can never
        // quietly disagree about which game they are looking at.
        // ---- chess.com's classifier, locally -----------------------------------------------
        // Three buttons and one rule: nothing downloads until asked. See ee-host.js.
        const eeSay = (t, bad) => { const el = $('rv_ee_status'); if (el) { el.textContent = t; el.classList.toggle('rv-bad', !!bad); } };
        // The version actually installed, which an update can move past the one we ship against.
        let eeInstalled = EE_VERSION, eeFound = '';
        const eeSync = async () => {
            const have = await eeCached();
            const get = $('rv_ee_get'), run = $('rv_ee_run'), forget = $('rv_ee_forget'), upd = $('rv_ee_update');
            if (!get || !run) return;
            get.classList.toggle('hidden', !!have);
            forget?.classList.toggle('hidden', !have);
            upd?.classList.toggle('hidden', !have);
            if (upd) upd.textContent = eeFound ? `Update to v${eeFound}` : 'Check for update';
            run.disabled = !have;
            if (have) eeSay(`Engine ready (${(have.bytes / 1048576).toFixed(1)} MB, v${eeInstalled}, kept on this machine).`
                + (eeFound ? ` v${eeFound} is available.` : ''));
            return have;
        };
        eeVersion().then(v => { eeInstalled = v; eeSync(); });
        // Two jobs, one button: check first, then download what the check found.
        $('rv_ee_update')?.addEventListener('click', async () => {
            const btn = $('rv_ee_update');
            btn.disabled = true;
            try {
                if (!eeFound) {
                    eeSay('Asking chess.com for a newer build\u2026');
                    const latest = await eeCheckUpdate(eeInstalled);
                    if (!eeNewer(eeInstalled, latest)) { eeFound = ''; eeSay(`v${eeInstalled} is the newest build chess.com is serving.`); return; }
                    eeFound = latest;
                    await eeSync();
                    return;
                }
                const target = eeFound;
                await eeUpdate(target, (got, total) => {
                    const mb = (got / 1048576).toFixed(1);
                    eeSay(total ? `Updating to v${target}\u2026 ${mb} MB of ${(total / 1048576).toFixed(1)} MB` : `Updating\u2026 ${mb} MB`);
                });
                eeInstalled = target;
                eeFound = '';
                await eeSync();
            } catch (e) {
                eeSay(`Could not update: ${e.message || e}`, true);
            } finally { btn.disabled = false; }
        });
        $('rv_ee_get')?.addEventListener('click', async () => {
            const btn = $('rv_ee_get');
            btn.disabled = true;
            try {
                eeSay('Downloading chess.com\u2019s explanation engine\u2026');
                await eeDownload((got, total) => {
                    const mb = (got / 1048576).toFixed(1);
                    eeSay(total ? `Downloading\u2026 ${mb} MB of ${(total / 1048576).toFixed(1)} MB` : `Downloading\u2026 ${mb} MB`);
                });
                await eeSync();
            } catch (e) {
                eeSay(`Could not download it: ${e.message || e}`, true);
            } finally { btn.disabled = false; }
        });
        $('rv_ee_forget')?.addEventListener('click', async () => {
            await eeForget();
            eeSay('Engine removed. Download it again whenever you want this mode.');
            await eeSync();
        });
        // Their Stockfish: the same one-rule download, its own button, entirely optional.
        const sfSay = (t, bad) => { const el = $('rv_sf_status'); if (el) { el.textContent = t; el.classList.toggle('rv-bad', !!bad); } };
        // Which engine this row is about follows the TIER: the post-game card is their Stockfish 18
        // Lite, the four Game Review budgets are their Stockfish 16.1 Lite. One row, so the button
        // always refers to the engine the selected budget actually needs.
        const sfBuildNow = () => eeTier(cfg('rv_ee_tier')).build;
        const sfNiceName = (b) => b === SF16_BUILD ? 'Stockfish 16.1' : 'Stockfish 18 Lite';
        const sfSize = (b) => b === SF16_BUILD ? '69 MB' : '7 MB';
        const sfSync = async () => {
            const build = sfBuildNow();
            const have = await sfCached(build);
            const get = $('rv_sf_get');
            if (get) get.textContent = `Download ${sfNiceName(build)} (${sfSize(build)})`;
            get?.classList.toggle('hidden', !!have);
            $('rv_sf_forget')?.classList.toggle('hidden', !have);
            sfSay(have
                ? `chess.com\u2019s ${sfNiceName(build)} ready (${(have.bytes / 1048576).toFixed(1)} MB) - the review now uses their engine as well as their classifier.`
                : sfBuildNow() === SF16_BUILD
                    ? `${sfNiceName(build)} is required for this budget: it IS chess.com\u2019s Game Review engine, and ours at the same seconds would be a different engine.`
                    : 'Optional. Without it the classifier is fed our Stockfish 18 Small, which differs from theirs by a few moves a game.');
            return have;
        };
        sfSync();
        $('rv_sf_get')?.addEventListener('click', async () => {
            const btn = $('rv_sf_get');
            btn.disabled = true;
            try {
                const build = sfBuildNow();
                sfSay(`Downloading chess.com\u2019s ${sfNiceName(build)}\u2026`);
                await sfDownload((got, total) => {
                    const mb = (got / 1048576).toFixed(1);
                    sfSay(total ? `Downloading\u2026 ${mb} MB of ${(total / 1048576).toFixed(1)} MB` : `Downloading\u2026 ${mb} MB`);
                }, build);
                await sfSync();
            } catch (e) { sfSay(`Could not download it: ${e.message || e}`, true); }
            finally { btn.disabled = false; }
        });
        $('rv_sf_forget')?.addEventListener('click', async () => {
            await sfForget(sfBuildNow());
            sfSay('Removed. The review will search with our own engine again.');
            await sfSync();
        });

        // 4-player board navigation
        $('rv4_first')?.addEventListener('click', () => show4pcPly(0));
        $('rv4_prev')?.addEventListener('click', () => show4pcPly(fourpcPly - 1));
        $('rv4_next')?.addEventListener('click', () => show4pcPly(fourpcPly + 1));
        $('rv4_last')?.addEventListener('click', () => show4pcPly((fourpcReport?.frames.length || 1) - 1));

        $('rv_ee_run')?.addEventListener('click', async () => {
            if (running) return;
            if (!games.length) return eeSay('Paste a PGN first.', true);
            const assets = await eeCached();
            if (!assets) { eeSay('Download the engine first.', true); return eeSync(); }
            const btn = $('rv_ee_run');
            running = true; cancel = false;
            btn.disabled = true; $('rv_run').disabled = true; $('rv_stop').disabled = false;
            let rig = null;
            try {
                const game = selectedGame();
                // WHICH ENGINE DOES THE SEARCHING. If chess.com's own Stockfish has been downloaded
                // it is used, and then every input to the classifier is theirs -- same engine, same
                // depth, same line count -- which is the only way to remove the eval difference
                // entirely. Without it we search with our own closest build and say so, because the
                // handful of moves that then disagree are worth knowing about rather than hiding.
                const tier = eeTier(cfg('rv_ee_tier'));
                const budget = tier.movetime ? `${tier.movetime / 1000}s a position` : `depth ${tier.depth}`;
                const sf = await sfCached(tier.build);
                let built;
                if (sf) {
                    eeSay(`Searching with chess.com\u2019s own Stockfish (${budget}, ${EE_MULTIPV} lines)\u2026`);
                    const {positions, moves} = buildPositions(game);
                    await sfSearch(sf, positions, {workers: Math.max(1, Math.min(4, +cfg('rv_workers') || 1)),
                                                   depth: tier.depth || EE_DEPTH, movetime: tier.movetime,
                        multipv: EE_MULTIPV,
                        uciMoves: moves.map(m => m.uci),
                        onProgress: (frac, i, n) => progress(frac * 0.9, `position ${i} of ${n}`)});
                    const book = cfg('rv_book') ? await lookupOpening(positions) : {name: null, plies: 0};
                    built = assemble(game, positions, moves, book, {variant: 'chess', multipv: EE_MULTIPV,
                        limitKind: tier.movetime ? 'movetime' : 'depth',
                        limitValue: tier.movetime || tier.depth,
                        engineName: `chess.com's ${sfNiceName(tier.build)}`});
                } else if (tier.build === SF16_BUILD) {
                    // The Game Review tiers are chess.com's ENGINE at a time budget. Without it there
                    // is nothing to imitate -- our own build at the same seconds is a different
                    // engine, and saying "Deep" over it would be a claim we have not measured.
                    eeSay(`${tier.label} needs chess.com\u2019s Stockfish 16.1 \u2014 press Download Stockfish 16.1 first.`, true);
                    return;
                } else {
                    eeSay('Searching at chess.com\u2019s settings (depth 10, 2 lines, 1 thread)\u2026');
                    rig = await startRig({depth: EE_DEPTH, multipv: EE_MULTIPV, threads: EE_THREADS, engineId: EE_ENGINE});
                    built = await runReview(game, rig, (frac, what) => progress(frac * 0.9, what));
                }
                progress(0.92, 'asking chess.com\u2019s classifier');
                const verdict = await eeRun(assets, eeCommands({
                    positions: built.positions, moves: built.moves,
                    whiteElo: eeElo(game.tags, 'w'), blackElo: eeElo(game.tags, 'b'),
                    result: game.tags?.Result || '*',
                    userColor: 'white',
                }));
                applyEeVerdict(built, verdict);

                built.pgnText = gameText(game);
                batchReports = null;
                report = built;
                renderReport();
                renderBatch();
                progress(1, 'done');
                const how = sf ? 'their engine and their classifier'
                    : 'their classifier, our engine (Stockfish 18 Small)';
                eeSay(`Classified by ${how}, v${EE_VERSION}.`);   // the game's sentence renders in the header
                $('rv-report').scrollIntoView({behavior: 'smooth', block: 'start'});
            } catch (e) {
                eeSay(cancel ? 'Stopped.' : String(e.message || e), !cancel);
                progress(0, '');
                $('rv_progress_wrap')?.classList.add('hidden');
            } finally {
                disposeRig(rig);
                running = false; cancel = false;
                if ($('rv_ee_run')) $('rv_ee_run').disabled = false;
                if ($('rv_run')) $('rv_run').disabled = false;
                if ($('rv_stop')) $('rv_stop').disabled = true;
            }
        });

        $('rv_ccr_run')?.addEventListener('click', async () => {
            const btn = $('rv_ccr_run');
            const sel = +($('rv_game_select')?.value || 0);
            const pgn = (games.length ? gameText(games[sel] ? games[sel] : games[0]) : '')
                || ($('rv_pgn')?.value || '');
            const out = $('rv_ccr_out'), status = $('rv_ccr_status');
            // every error shows the ticket button and remembers its text; a non-error hides it again.
            const say = (t, bad) => {
                status.textContent = t; status.classList.toggle('rv-bad', !!bad);
                ccrLastError = bad ? t : '';
                $('rv_ccr_ticket')?.classList.toggle('hidden', !bad);
            };
            if (!pgn.trim()) return say('Load a game first - paste a PGN or fetch one above.', true);
            if (!(await ccrConsent())) return say('Cancelled - accept the caution to run a chess.com review.', false);
            btn.disabled = true;
            const was = btn.textContent;
            btn.textContent = 'Asking…';
            say(`Sent to chess.com (${$('rv_ccr_strength').value}). The game leaves this machine now; waiting on their answer…`);
            out.classList.add('hidden');
            $('rv_ccr_copy').classList.add('hidden');
            $('rv_ccr_save').classList.add('hidden');
            const game = buildCcrGame(pgn);
            if (game.error) { btn.disabled = false; btn.textContent = was; return say(game.error, true); }
            let res;
            try {
                res = await chrome.runtime.sendMessage({chesscomAnalyze: {game}});
            } catch (e) { res = {error: String(e.message || e)}; }
            btn.disabled = false;
            btn.textContent = was;
            if (!res || res.error) { say(res?.error || 'No answer.', true); if (res?.sentB64) { ccrJson = JSON.stringify(res, null, 2); out.textContent = ccrJson; out.classList.remove('hidden'); $('rv_ccr_save').classList.remove('hidden'); } return; }
            // v2 answers in PROTOBUF frames, not JSON: dump them as base64 so the shape can be
            // decoded offline. A clean close with no frames is the Origin/auth signal.
            const n = res.frames?.length || 0;
            ccrJson = JSON.stringify(res, null, 2);
            // if the built-in decoder got a review, show it READABLY (raw JSON stays behind Save)
            const review = res.decoded && res.decoded.review;
            if (review && review.moves && review.moves.length) {
                // Drive the shared board/move-list from chess.com's answer; fall back to the readable
                // text pane only if the PGN cannot be replayed into positions.
                const built = buildCcrReport(review, pgn);
                if (built) {
                    report = built;
                    renderCcrReport($('rv_ccr_strength').value);
                    out.classList.add('hidden');
                } else {
                    out.textContent = renderCcrReview(review, pgn);
                    out.classList.remove('hidden');
                }
                $('rv_ccr_copy').classList.remove('hidden');
                $('rv_ccr_save').classList.remove('hidden');
                const rt = review.ratings && review.ratings.white != null
                    ? `, ~${review.ratings.white}/${review.ratings.black} rating` : '';
                say(`Reviewed by chess.com via your logged-in tab${rt}. The board below is playable; Save for the raw protobuf.`
                + ' Their server returns the same review for all four strength tiers.');
                return;
            }
            if (!n) {
                const why = res.closeCode === 1008
                    ? 'chess.com rejected it (1008) - sign in to chess.com in this browser (open chess.com, log in), then retry.'
                    : `the socket closed (code ${res.closeCode}${res.closeReason ? ', ' + res.closeReason : ''}).`;
                say(`Ran in your chess.com tab, no answer - ${why}`, true);
            } else {
                say(`Ran in your chess.com tab; ${n} protobuf frame${n === 1 ? '' : 's'} back${res.closeCode ? ` (closed ${res.closeCode})` : ''}. Base64 below - save it.`);
            }
            out.textContent = ccrJson;
            out.classList.remove('hidden');
            $('rv_ccr_copy').classList.remove('hidden');
            $('rv_ccr_save').classList.remove('hidden');
        });
        $('rv_ccr_copy')?.addEventListener('click', async (e) => {
            try { await navigator.clipboard.writeText(ccrJson || ''); e.target.textContent = 'Copied ✓'; }
            catch (err) { e.target.textContent = 'Copy failed'; }
            setTimeout(() => e.target.textContent = 'Copy JSON', 1200);
        });
        $('rv_ccr_save')?.addEventListener('click', () => {
            const url = URL.createObjectURL(new Blob([ccrJson || ''], {type: 'application/json'}));
            const aEl = document.createElement('a');
            aEl.href = url;
            aEl.download = 'chesscom-review.json';
            aEl.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
        // copy the error onto the clipboard and open a fresh issue so it can be pasted into a ticket.
        $('rv_ccr_ticket')?.addEventListener('click', (e) => {
            const body = `Mephisto chess.com review error:\n${ccrLastError || '(no message)'}\n\nWhat I did:\n`;
            navigator.clipboard.writeText(body).catch(() => {});
            e.target.textContent = 'Copied ✓ - opening ticket';
            setTimeout(() => { e.target.textContent = 'Copy error & open ticket'; }, 1500);
            window.open('https://github.com/IchNukeDichWeg/Mephisto/issues/new', '_blank', 'noopener');
        });
        // DROP A PGN ANYWHERE ON THE PAGE -- a button and a paste box are two steps for what should
        // be one. The whole section is the target (aiming at the one textarea is fiddly); the box
        // lights up so the drop has somewhere visible to land, and a non-file drag is left alone.
        wirePgnDrop(document.querySelector('.big-section'), $('rv_pgn'), (text) => loadPgnText(text));
        $('rv_file').addEventListener('change', async () => {
            const f = $('rv_file').files[0];
            if (f) loadPgnText(await f.text());
            $('rv_file').value = ''; // the same file again must fire 'change' again
        });
        $('rv_clip_btn').addEventListener('click', async () => {
            try { loadPgnText(await navigator.clipboard.readText()); }
            catch (e) { note('Could not read the clipboard. Paste into the box instead.', true); }
        });
        $('rv_sample_btn').addEventListener('click', () => loadPgnText(SAMPLE_PGN));
        $('rv_clear_btn').addEventListener('click', () => loadPgnText(''));
        $('rv_fetch_btn').addEventListener('click', async () => {
            const btn = $('rv_fetch_btn');
            const site = $('rv_fetch_site')?.value || 'chesscom';
            btn.disabled = true;
            note(`Fetching from ${site === 'lichess' ? 'lichess.org' : 'chess.com'}...`);
            try { loadPgnText(await (site === 'lichess' ? fetchLichess : fetchChesscom)($('rv_user').value)); }
            catch (e) { note(String(e.message || e), true); }
            finally { btn.disabled = false; }
        });

        // The box is the truth on a keystroke; the -/+ buttons fire 'change' through bindSteppers.
        $('rv_limit_num')?.addEventListener('input', () => syncLimitUi(true));
        $('rv_limit_num')?.addEventListener('change', () => syncLimitUi(true));
        $('rv_limit_kind').value = cfg('rv_limit_kind');
        $('rv_limit_kind').addEventListener('change', () => {
            setCfg('rv_limit_kind', $('rv_limit_kind').value);
            syncLimitUi();
        });
        bindNumber('rv_multipv', 'rv_multipv');
        bindNumber('rv_workers', 'rv_workers');
        bindNumber('rv_threads', 'rv_threads');
        bindNumber('rv_hash', 'rv_hash');
        const rvWarn = () => refreshLimitWarnings($('rv_limits_warn'), $('rv_threads')?.value, $('rv_hash')?.value);
        $('rv_threads')?.addEventListener('input', rvWarn);
        $('rv_hash')?.addEventListener('input', rvWarn);
        setTimeout(rvWarn, 300);
        bindNumber('rv_maia3_elo', 'rv_maia3_elo');
        bindSteppers();
        bindHumanUi();

        // Which of the three reviews is on screen. Registered here like every other setting -- a
        // control that renders but is never wired reads as working and silently forgets itself.
        const rvModeSync = () => {
            const variant = String(cfg('rv_variant') || 'chess');
            // the chess.com paths speak standard chess only: any other game type forces 'own'
            let m = cfg('rv_mode') || 'own';
            if (variant !== 'chess' && m !== 'own') { m = 'own'; setCfg('rv_mode', 'own'); }
            const sel = $('rv_mode');
            if (sel) {
                if (sel.value !== m) sel.value = m;
                for (const opt of sel.options) opt.disabled = variant !== 'chess' && opt.value !== 'own';
            }
            const vsel = $('rv_variant');
            if (vsel && vsel.value !== variant) vsel.value = variant;
            const wsel = $('rv_variant_which');
            if (wsel) {
                wsel.classList.toggle('hidden', variant !== 'variant');
                const w = String(cfg('rv_variant_which') || 'crazyhouse');
                if (wsel.value !== w) wsel.value = w;
            }
            // a fairy variant is Fairy-Stockfish's game: flip the visible engine too, the way the
            // Analysis page does, so the select never shows an engine the run would not use
            if (RV_FAIRY_ONLY.includes(rvChessVariant()) && cfg('rv_engine') !== RV_FAIRY_ENGINE) {
                setCfg('rv_engine', RV_FAIRY_ENGINE);
                if ($('rv_engine')) $('rv_engine').value = RV_FAIRY_ENGINE;
            }
            const fourPc = variant === '4pc';
            $('rv_4pc_note')?.classList.toggle('hidden', !fourPc);
            if (!fourPc) $('rv-4pc')?.classList.add('hidden');
            // Run stays ENABLED for 4pc -- it has a review now (run4pcReview). This line used to
            // grey the button out from the "cannot be replayed" era, which made the whole lane
            // unreachable: a disabled button swallows the click before onRun ever runs.
            document.querySelectorAll('.rv-mode').forEach(el =>
                el.classList.toggle('hidden', fourPc || el.dataset.mode !== m));
            // ...and the settings themselves: a control that cannot affect the selected review is
            // worse than absent, because changing it looks like it did something. Rows marked
            // data-chess-only (the Maia passes) stand down for every other game type; in 4pc, which
            // has no replay at all, every row does.
            document.querySelectorAll('[data-for]').forEach(el =>
                el.classList.toggle('hidden', fourPc || !el.dataset.for.split(' ').includes(m)
                    || (el.hasAttribute('data-chess-only') && variant !== 'chess')));
        };
        $('rv_mode')?.addEventListener('change', () => { setCfg('rv_mode', $('rv_mode').value); rvModeSync(); });
        $('rv_variant')?.addEventListener('change', () => {
            setCfg('rv_variant', $('rv_variant').value);
            note('');
            rvModeSync();
        });
        $('rv_variant_which')?.addEventListener('change', () => {
            setCfg('rv_variant_which', $('rv_variant_which').value);
            rvModeSync();
        });
        syncGameTypeUi = rvModeSync;   // parsePgnBox re-syncs through this when a PGN decides the type
        rvModeSync();

        // The tier list is BUILT from EE_TIERS, so a label can never claim a budget the code does
        // not run, and a measured match percentage appears only where one has actually been measured.
        const tierSel = $('rv_ee_tier');
        if (tierSel) {
            tierSel.innerHTML = Object.entries(EE_TIERS).map(([k, t]) => {
                const bits = [];
                bits.push(t.movetime ? `${t.movetime / 1000}s a move` : `depth ${t.depth}`);
                if (t.rating) bits.push(`~${t.rating}`);
                if (t.match != null) bits.push(`${t.match.toFixed(1)}% match to ${t.matchOf}`);
                return `<option value="${k}">${t.label} \u2014 ${bits.join(', ')}</option>`;
            }).join('');
            tierSel.value = cfg('rv_ee_tier') || 'card';
            tierSel.addEventListener('change', () => { setCfg('rv_ee_tier', tierSel.value); eeSync(); sfSync(); });
        }

        for (const key of ['rv_book', 'rv_human_report', 'rv_strength', 'rv_batch']) {
            const el = $(key);
            if (!el) continue;
            el.checked = !!cfg(key);
            el.addEventListener('change', () => setCfg(key, el.checked));
        }

        // Probing three native hosts takes up to a second; do it once and re-render the list when it
        // lands rather than making the page wait for it.
        updateEngineOptions();
        $('rv_engine').value = cfg('rv_engine');
        $('rv_engine').addEventListener('change', () => setCfg('rv_engine', $('rv_engine').value));
        syncLimitUi();
        if (!nativeAvailable) {
            const ids = ENGINES.filter(e => e.kind === 'native').map(e => e.id);
            Promise.all(ids.map(id => nativeHostAvailable(id))).then(oks => {
                nativeAvailable = {};
                ids.forEach((id, i) => { nativeAvailable[id] = oks[i]; });
                updateEngineOptions();
            });
        } else {
            updateEngineOptions();
        }

        $('rv_run').addEventListener('click', onRun);
        $('rv_stop').addEventListener('click', () => {
            cancel = true;
            // An unbounded search never returns on its own, so asking the loop to stop "after this
            // position" would wait for ever. Interrupt the search itself; the engine answers with
            // bestmove, this position is scored with what it found, and the loop then sees `cancel`.
            activeEngine?.stopSearch?.();
            note('Stopping after this position...');
        });
        $('rv_export').addEventListener('click', () => exportHtml($('rv_export')));
        // Which player? The one whose numbers you are looking at -- so it asks, once, with the two
        // names from the game rather than making you type one. Writing the mix is a real change to
        // how the panel will play, so it says what it measured and how many moves it is drawn from.
        $('rv_fit').addEventListener('click', () => {
            if (!report || !report.moves) return;
            const tags = report.game?.tags || {};
            const white = tags.White || 'White', black = tags.Black || 'Black';
            const ans = prompt(`Fit the Humanize move mix to which player?\n\n`
                + `1 = ${white} (white)\n2 = ${black} (black)`, '1');
            if (ans !== '1' && ans !== '2') return;
            const fit = fitHumanize(report.moves, ans === '1' ? 'w' : 'b');
            const btn = $('rv_fit');
            if (!fit) { btn.textContent = 'No gradeable moves'; setTimeout(() => btn.textContent = 'Fit Humanize to a player', 2500); return; }
            for (const [k, v] of Object.entries(fit.pct)) MephistoConfig.set(`humanize_${k}`, String(v));
            btn.textContent = `Fitted from ${fit.n} moves`;
            setTimeout(() => btn.textContent = 'Fit Humanize to a player', 4000);
        });
        $('rv_first').addEventListener('click', () => showPly(0));
        $('rv_prev').addEventListener('click', () => showPly(cursor - 1));
        $('rv_next').addEventListener('click', () => showPly(cursor + 1));
        $('rv_last').addEventListener('click', () => showPly(report ? report.positions.length - 1 : 0));
        $('rv_flip').addEventListener('click', () => {
            flipped = !flipped;
            board?.orientation(flipped ? 'black' : 'white');
            showPly(cursor);
        });
        document.removeEventListener('keydown', onKey); // re-injected page: never bind twice
        document.addEventListener('keydown', onKey);

        // Closing or reloading the tab has to stop a search, not orphan it. pagehide rather than
        // beforeunload: it also fires when the tab is discarded or navigated by the browser.
        window.removeEventListener('pagehide', stopOnUnload);
        window.addEventListener('pagehide', stopOnUnload);

        // Coming back to this page after visiting another one: the module survived, the DOM did not.
        if (report) {
            $('rv_pgn').value = report.pgnText || '';
            parsePgnBox();
            renderReport();
        }
    }
}

function stopOnUnload() {
    cancel = true;
    try { activeEngine?.dispose(); } catch (e) { /* already gone */ }
    activeEngine = null;
}

function onKey(e) {
    if (!report) return;
    // optional call: the target is not always an Element (a key dispatched at the document is not)
    if (e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') { showPly(cursor - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { showPly(cursor + 1); e.preventDefault(); }
    if (e.key === 'Home') { showPly(0); e.preventDefault(); }
    if (e.key === 'End') { showPly(report.positions.length - 1); e.preventDefault(); }
}

define({
    title: 'Game Review',
    page: new ReviewPage(),
});
