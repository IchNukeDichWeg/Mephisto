// Minimal drop-in replacement for chessboard.js (N1 Phase 4a).
// The panel uses only a tiny slice of chessboard.js: position get/set, orientation get/set, on a
// DISPLAY-ONLY board (draggable:false). chessboard.js needs jQuery and looks its board element up via
// `document`, so it can't live in a shadow root -- this can. It emits the SAME DOM class names
// chessboard.js does (.board-b72b1 / .square-55d63 / .white-1e1d7 / .black-3c85d / .piece-417db /
// .notation-322f9 / .alpha-d2270 / .numeric-fc462), so popup.css + chessboard.css style it unchanged.
//
// API (the subset popup.js calls):
//   const b = MephistoBoard(elOrId, {position:'start'|fen|obj, orientation, pieceTheme, showNotation, root})
//   b.position()      -> {square: 'wP', ...}      b.position(fen|'start'|obj) -> set + re-render
//   b.orientation()   -> 'white'|'black'          b.orientation('white'|'black') -> set + re-render
//   b.resize()        -> re-render at current container size
(function () {
    const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

    function fenToObj(fen) {
        if (fen == null) return {};
        if (fen === 'start') fen = START;
        if (typeof fen === 'object') return fen;
        fen = String(fen).split(' ')[0]; // piece-placement field only
        const obj = {};
        const rows = fen.split('/');
        for (let r = 0; r < 8 && r < rows.length; r++) {
            const rank = 8 - r;
            let file = 0;
            for (const ch of rows[r]) {
                if (ch >= '1' && ch <= '8') { file += (ch.charCodeAt(0) - 48); }
                else { obj[FILES[file] + rank] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase(); file++; }
            }
        }
        return obj;
    }

    function MephistoBoard(elOrId, cfg) {
        cfg = cfg || {};
        const host = (typeof elOrId === 'string')
            ? (cfg.root || document).getElementById(elOrId)
            : elOrId;
        let orientation = cfg.orientation || 'white';
        let pos = fenToObj(cfg.position);
        const theme = cfg.pieceTheme || '';
        const pieceMap = cfg.pieceMap || null; // in-page panel: inlined data: URIs (no extension URLs)
        const showNotation = cfg.showNotation;
        const pieceUrl = (p) => (pieceMap ? (pieceMap[p] || '') : theme.replace('{piece}', p));

        function render() {
            if (!host) return;
            const size = host.clientWidth || 350;
            const sq = Math.floor(size / 8);
            const board = document.createElement('div');
            board.className = 'board-b72b1';
            board.style.width = (sq * 8) + 'px';
            board.style.height = (sq * 8) + 'px';
            const ranks = (orientation === 'white') ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
            const files = (orientation === 'white') ? FILES : [...FILES].reverse();
            for (let ri = 0; ri < 8; ri++) {
                const row = document.createElement('div');
                row.style.cssText = 'clear:both';
                for (let fi = 0; fi < 8; fi++) {
                    const f = files[fi], rk = ranks[ri], alg = f + rk;
                    const light = (FILES.indexOf(f) + rk) % 2 === 0; // a1 dark, h1 light
                    const s = document.createElement('div');
                    s.className = `square-55d63 ${light ? 'white-1e1d7' : 'black-3c85d'} square-${alg}`;
                    s.style.cssText = `width:${sq}px;height:${sq}px;float:left;position:relative`;
                    const p = pos[alg];
                    if (p) {
                        const img = document.createElement('img');
                        img.className = 'piece-417db';
                        img.src = pieceUrl(p);
                        img.style.cssText = `width:${sq}px;height:${sq}px`;
                        s.appendChild(img);
                    }
                    if (showNotation) {
                        if (fi === 0) { const n = document.createElement('div'); n.className = 'notation-322f9 numeric-fc462'; n.textContent = rk; s.appendChild(n); }
                        if (ri === 7) { const n = document.createElement('div'); n.className = 'notation-322f9 alpha-d2270'; n.textContent = f; s.appendChild(n); }
                    }
                    row.appendChild(s);
                }
                board.appendChild(row);
            }
            host.innerHTML = '';
            host.appendChild(board);
        }

        render();
        // The first render can run before the injected <style> has been applied/laid out, so
        // host.clientWidth may not be the CSS's 350px yet and the squares come out mis-sized.
        // Re-render once on the next frame, when layout has settled. Cheap and self-healing.
        requestAnimationFrame(() => render());
        return {
            position(arg) { if (arg === undefined) return {...pos}; pos = fenToObj(arg); render(); },
            orientation(o) { if (o === undefined) return orientation; orientation = o; render(); },
            resize() { render(); },
        };
    }

    self.MephistoBoard = MephistoBoard;
})();
