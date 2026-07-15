// ChessBase Tactics (tactics.chessbase.com) page-world probe. The board is ChessBase's proprietary
// CB.* engine (a jQWidgets UI) -- the position never appears as a scrapeable FEN anywhere in the
// DOM. But the live game model IS reachable in the MAIN world as window.V35s (a CB.ChessTrainingApp):
//   V35s.gameKernel.getCurPos().toFEN()                  -> the exact current position (side to
//                                                            move, castling, en passant, counters)
//   V35s.gameKernel.game.addOnCurPosChangedListener(fn)  -> fires on every move / navigation
// Content scripts run in an ISOLATED world and cannot read page globals, so this probe is injected
// into the MAIN world ("world": "MAIN") and bridges via DOM CustomEvents, mirroring tt-probe.js:
//   - 'mephisto-cb-query'  is answered SYNCHRONOUSLY with 'mephisto-cb-state' (the current FEN).
//   - 'mephisto-cb-update' is PUSHED on the model's onCurPosChanged the instant the position
//     changes, so a solved/taken-back move is seen immediately instead of on the fallback poll.
// Puzzles start from ARBITRARY positions, so the FEN is shipped whole (the content-script wraps it
// as '***cbfen***' and the popup feeds it to the engine directly -- no move replay).
(() => {
    // 1c (anti-detection): no persistent `window.__mephisto*` flag (a page could test
    // `'__mephistoCBProbe' in window`) and no `mephisto-*` event names. This IIFE runs once per
    // document load; a rare double injection only duplicates harmless events, so no global guard is
    // needed. Bridge channel names are de-branded to neutral tokens shared with the content script.
    const CB_Q = 'w2q', CB_S = 'w2s', CB_U = 'w2u'; // query / state / update

    const isFen = (s) => typeof s === 'string' &&
        /^([1-8pnbrqkPNBRQK]+\/){7}[1-8pnbrqkPNBRQK]+\s+[wb]\s/.test(s);

    function curFen() {
        try {
            const gk = window.V35s && window.V35s.gameKernel;
            const fen = gk && gk.getCurPos && gk.getCurPos().toFEN();
            return isFen(fen) ? fen : null;
        } catch (e) { return null; }
    }

    const send = (name, fen) =>
        document.dispatchEvent(new CustomEvent(name, {detail: JSON.stringify(fen)}));

    // (Re)subscribe to the current game's position-changed event so moves push instantly. The game
    // object is reused across puzzles (reset + assign, not replaced), but re-check identity each
    // time in case a future build swaps it. Only real position changes fire -- this can't loop.
    let subGame = null;
    function ensureSubscribed() {
        try {
            const g = window.V35s && window.V35s.gameKernel && window.V35s.gameKernel.game;
            if (!g || g === subGame || typeof g.addOnCurPosChangedListener !== 'function') return;
            subGame = g;
            g.addOnCurPosChangedListener(() => {
                const fen = curFen();
                if (fen) send(CB_U, fen);
            });
        } catch (e) { /* model not ready / no listener API -- query + fallback poll still cover it */ }
    }

    // query side: always answers synchronously with the CURRENT position (null if no game yet)
    document.addEventListener(CB_Q, () => {
        ensureSubscribed();
        send(CB_S, curFen());
    });

    // The app boots async; poll briefly until the model exists, then push the first position and
    // wire the subscription. After that, onCurPosChanged pushes and queries carry the state.
    let tries = 0;
    const boot = setInterval(() => {
        const fen = curFen();
        if (fen) { ensureSubscribed(); send(CB_U, fen); clearInterval(boot); }
        if (++tries > 60) clearInterval(boot); // ~30s ceiling, then rely on queries
    }, 500);
})();
