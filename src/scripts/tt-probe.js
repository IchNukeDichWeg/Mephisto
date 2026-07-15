// TakeTakeTake page-world probe. The taketaketake.com board is a WebGPU <canvas> -- there are no
// DOM pieces, squares, aria labels or FEN anywhere in the document, so the usual scraping is
// impossible. The full game state lives in the page's React tree as two XState actors:
//   - the GAME MACHINE (mounted as a prop named `takePlayActor`): its context holds `.game` =
//     the server game object (fen, move list, both clocks in ms, viewer color) and
//     `.matchmakingConfig` (increment). This exists on every kind of live game -- bot AND online.
//   - the BOARD actor (a prop on the canvas's own component): its context holds `.gameTree`, the
//     OPTIMISTIC render tree that gains the user's own move ~10ms after the click, ~500ms before
//     the server acknowledges it.
//
// Detection anchors on the GAME MACHINE, found by a bounded breadth-first walk of the fiber tree
// (~0.9ms, <700 nodes) rather than by walking UP from the canvas: the board component varies by
// surface (the old up-from-canvas walk worked on bot games but not online games or the replay
// viewer), whereas the `takePlayActor` prop is a stable semantic anchor. The board actor is picked
// up in the SAME walk when present, purely to read its optimistic move list for low latency; if
// it's ever absent the probe falls back to the (slightly laggier) server move list and still works.
//
// Content scripts run in an ISOLATED world and cannot touch React fibers, so this probe is injected
// into the MAIN world ("world": "MAIN") and bridges via DOM CustomEvents:
//   - 'mephisto-tt-query'  is answered SYNCHRONOUSLY with 'mephisto-tt-state'.
//   - 'mephisto-tt-update' is PUSHED on the game machine's subscription the instant the position
//     changes -- the canvas repaints without any DOM mutation, so without this the content-script
//     would only notice a move on the 1s fallback poll.
(() => {
    // 1c (anti-detection): no persistent `window.__mephisto*` flag (a page could test
    // `'__mephistoTTProbe' in window`) and no `mephisto-*` event names. This IIFE runs once per
    // document load; a rare double injection only duplicates harmless events, so no global guard is
    // needed. Bridge channel names are de-branded to neutral tokens shared with the content script.
    const TT_Q = 'w1q', TT_S = 'w1s', TT_U = 'w1u'; // query / state / update

    const serverGame = (actor) => {
        try {
            const g = actor && actor._snapshot?.context?.game;
            return (g && g.state && typeof g.state.fen === 'string') ? actor : null;
        } catch (e) { return null; }
    };
    const boardActor = (actor) => {
        try {
            const c = actor && actor._snapshot?.context;
            return (c && c.gameTree && c.parentRef) ? actor : null;
        } catch (e) { return null; }
    };

    // one bounded BFS collects the board actor (present on EVERY live surface -- its shape,
    // gameTree + parentRef, is the stable anchor) and the game MACHINE that carries the server
    // game object. On bot games the machine is a standalone prop (`takePlayActor`); on online
    // games it is NOT exposed as a prop and is only reachable through the board actor's parentRef.
    // So whenever a board actor is found, its parentRef is also tested as a machine candidate.
    function findActors() {
        const cv = document.querySelector('canvas');
        if (!cv) return {machine: null, board: null};
        const fk = Object.keys(cv).find(k => k.startsWith('__reactFiber$'));
        if (!fk) return {machine: null, board: null};
        let root = cv[fk];
        while (root.return) root = root.return; // HostRoot -- covers the whole app, not just the canvas
        const q = [root], seen = new Set();
        let machine = null, board = null, n = 0;
        // stop once the board actor is found: on bot games its parentRef IS the machine (set below),
        // on online games there is no machine to find, so scanning further is wasted work
        while (q.length && n < 8000 && !board) {
            const f = q.shift();
            if (!f || seen.has(f)) continue;
            seen.add(f);
            n++;
            const consider = (v) => {
                if (!v || typeof v !== 'object') return;
                if (!machine && serverGame(v)) machine = v;
                if (!board && boardActor(v)) {
                    board = v;
                    // the parentRef is the game machine on surfaces that don't expose it as a prop
                    if (!machine) { const pr = v._snapshot.context.parentRef; if (serverGame(pr)) machine = pr; }
                }
            };
            const pr = f.memoizedProps;
            if (pr && typeof pr === 'object') for (const k of Object.keys(pr)) consider(pr[k]);
            let h = f.memoizedState, hi = 0;                    // actors stored in hooks, not props
            while (h && typeof h === 'object' && hi < 12) { consider(h.memoizedState); h = h.next; hi++; }
            if (f.child) q.push(f.child);
            if (f.sibling) q.push(f.sibling);
        }
        return {machine, board};
    }

    // optimistic mainline of the board actor's render tree (root -> childIds[0] -> leaf)
    function treeMoves(board) {
        try {
            const gt = board && board._snapshot.context.gameTree;
            if (!gt || !gt.positions || !gt.rootId) return null;
            const pos = gt.positions;
            const get = (id) => (pos instanceof Map) ? pos.get(id) : pos[id];
            const moves = [];
            let node = get(gt.rootId), guard = 0;
            while (node && node.childIds && node.childIds.length && guard++ < 600) {
                node = get(node.childIds[0]);
                if (!node || !node.san) break;
                moves.push({san: node.san, uci: node.uci});
            }
            return moves;
        } catch (e) { return null; }
    }

    const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // The two live surfaces store the game very differently:
    //   - BOT games: the machine's context.game is a full server object (fen, moves, ms clocks,
    //     viewer). This is what the earlier probe relied on -- and why it only worked on bot games.
    //   - ONLINE games are LICHESS-BACKED: the machine has lichessGameId / bearerToken / clock /
    //     color and NO `.game` object at all. The move list lives ONLY in the board actor's
    //     gameTree, the position per node as a parsed `chess` object (no fen string).
    // The board's gameTree (SAN mainline) is therefore the ONE thing present on every surface, so
    // detection is anchored on it; the machine's `.game` is used as a bonus when it exists.
    function buildPayload(machine, board) {
        try {
            const bc = board && board._snapshot.context;
            const g = machine && machine._snapshot.context.game;   // bot only; undefined online
            const parent = bc && bc.parentRef && bc.parentRef._snapshot && bc.parentRef._snapshot.context;

            // MOVES: the board's optimistic tree (present everywhere, leads on our own move); fall
            // back to the machine's server list only when there is no board actor.
            const optimistic = treeMoves(board);
            const serverMoves = g ? (g.moves || []).map(m => ({san: m.san, uci: m.uci})) : null;
            const moves = (optimistic && (!serverMoves || optimistic.length >= serverMoves.length))
                ? optimistic : serverMoves;
            if (!moves) return null; // no game on this page (e.g. the lobby or the replay viewer)

            // FEN: bot games hand us the real fen. Online games rebuild the position from the SAN
            // list on the standard start (the content-script ships '***ttfen***' + SANs, the popup
            // replays them with chess.js), so the standard start is a correct detection gate for a
            // standard game. Non-standard starts on online aren't handled here (rare on tt).
            const fen = (g && g.state && typeof g.state.fen === 'string') ? g.state.fen : STANDARD_START;

            const myColor = (g && g.viewer && g.viewer.color)
                || (bc && bc.playerColor) || (parent && parent.color) || null;

            // CLOCKS: bot games carry ms on game.state; online (lichess-backed) games keep them on
            // parent.clock.{white,black}.remainingMs. Read whichever exists (null when neither).
            const clk = parent && parent.clock;
            const whiteClockMs = (g && g.state && g.state.whiteClockMs != null) ? g.state.whiteClockMs
                : (clk && clk.white && typeof clk.white.remainingMs === 'number') ? clk.white.remainingMs : null;
            const blackClockMs = (g && g.state && g.state.blackClockMs != null) ? g.state.blackClockMs
                : (clk && clk.black && typeof clk.black.remainingMs === 'number') ? clk.black.remainingMs : null;
            // increment: exposed on bot games (matchmakingConfig) but not on the online clock object.
            // Mirror Time still works there (it measures the opponent's spend from clock deltas);
            // Clock Mode's "+0.6*increment" term just falls to 0.
            const increment = (machine && machine._snapshot.context.matchmakingConfig)
                ? (parseInt(machine._snapshot.context.matchmakingConfig.increment) || 0) : null;

            return {
                fen, moves,
                activeColor: (g && g.state && g.state.activeColor) || null,
                myColor,
                canMove: !!(g && g.viewer && g.viewer.canMove),
                whiteClockMs, blackClockMs, increment,
                variant: (bc && bc.variant) || (g && g.variant) || 'standard',
            };
        } catch (e) {
            return null; // app internals changed -- degrade to "no game detected"
        }
    }

    const send = (name, payload) =>
        document.dispatchEvent(new CustomEvent(name, {detail: JSON.stringify(payload)}));

    // --- push side: subscribe to the BOARD actor (falling back to the machine if there is no board
    // actor). The board actor is what fires on optimistic gameTree changes -- our own move ~13ms
    // after the click AND the opponent's move (both repaint the tree). The machine only fires on
    // server acknowledgement ~500ms later, so subscribing to it would forfeit the fast path.
    // Re-subscribe when a query finds a different actor (new game / SPA navigation). Only real
    // position changes notify -- clock ticks churn snapshots constantly and must not wake the pipeline.
    let subActor = null, subscription = null, lastKey = '';

    function ensureSubscribed(machine, board) {
        const target = board || machine;
        if (!target || target === subActor) return;
        try { subscription?.unsubscribe(); } catch (e) { /* old actor already dead */ }
        subActor = target;
        subscription = null;
        try {
            subscription = target.subscribe(() => {
                const {machine: m, board: b} = findActors(); // either may remount independently
                const p = buildPayload(m, b);
                // key on the MOVE LIST, not the fen: the optimistic tree move must push ~instantly,
                // and the server fen catching up ~500ms later must NOT push again (no new info)
                const key = p ? `${p.moves.length}|${p.moves[p.moves.length - 1]?.uci || ''}` : 'null';
                if (key === lastKey) return;
                lastKey = key;
                send(TT_U, p);
            });
        } catch (e) { /* no subscribe support -- queries + fallback poll still work */ }
    }

    // --- query side: always answers, synchronously, with the CURRENT game's state
    document.addEventListener(TT_Q, () => {
        const {machine, board} = findActors();
        ensureSubscribed(machine, board);
        send(TT_S, buildPayload(machine, board));
    });
})();
