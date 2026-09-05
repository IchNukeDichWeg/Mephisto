// The engine drivers, shared by Game Review and the Analysis page. Two transports behind one
// interface: `analyse(fen, turn)` resolves to `{lines, depth, nodes}` with every score already
// converted to WHITE-POSITIVE centipawns, and `startInfinite(fen, turn, onUpdate, opts)` streams
// the same shape as the search deepens. Which transport is in use never leaves this file.
//
// It lives here rather than inside the review page because the analysis page needs exactly the same
// thing, and a second copy would drift: the offscreen client-id rule below (one id per engine, or
// the second init silently disposes the first) was learned once and must not be re-learned.
const Core = self.MephistoReviewCore;

// The budget slider's last notch: the sentinel that means `go infinite`. Nothing in this file ever
// decides such a search has run long enough -- no settle rule, no ceiling, no backstop timeout.
// It runs until stopSearch() is called, which is what the Stop button does.
const LIMIT_INFINITE = 1e9;

// The engines a review can judge a game with. WASM entries need nothing installed; native entries
// are probed for a live host before they are offered, since picking one that is not installed
// produces a page that sits at 0% forever.
//
// Maia is deliberately NOT in this list. It does not search: it answers "what would a human of this
// rating play", which is a different question from "how good was this move", and a review built on
// it would report a blunder as excellent whenever it was a HUMAN-LOOKING blunder. It is the Human
// model pass instead, which is its own row directly under this one.
// what an unusable selection falls back to: bundled, small, and plays standard chess
const ENGINE_FALLBACK = 'stockfish-19-small-nnue';
const ENGINES = [
    {id: 'stockfish-19-nnue', label: 'Stockfish 19 (WASM)', kind: 'wasm'},
    {id: 'stockfish-19-small-nnue', label: 'Stockfish 19 Small (WASM)', kind: 'wasm'},
    {id: 'stockfish-18-nnue', label: 'Stockfish 18 (WASM)', kind: 'wasm'},
    {id: 'stockfish-11-hce', label: 'Stockfish 11 HCE (WASM)', kind: 'wasm'},
    // The one engine here that plays the fairy variants; the offscreen loader picks the matching
    // per-variant net and validates the variant against the engine's own declared list.
    {id: 'fairy-stockfish-14-nnue', label: 'Fairy-Stockfish 14 (WASM)', kind: 'wasm'},
    {id: 'sf-native', label: 'Stockfish (native)', kind: 'native'},
    {id: 'fairy-native', label: 'Fairy-Stockfish (native)', kind: 'native'},
];

// The human model. Its own list because it answers its own question, and because the bands are the
// nets that ACTUALLY SHIP -- lib/engine/maia holds maia-1100 through maia-1900 and maia-2200,
// and nothing else. 2000 and 2100 were offered here and have never existed: picking one failed to
// load, and the Analysis page's moves-by-rating chart drew both as a dive to zero in the middle of
// every line, which is how they were finally noticed.
const MAIA_BANDS = ['1100', '1200', '1300', '1400', '1500', '1600', '1700', '1800', '1900', '2200'];

const CFG_DEFAULTS = {
    rv_engine: 'stockfish-18-nnue',
    rv_limit_kind: 'depth',
    rv_limit_value: 16,      // the ACTIVE budget, in whatever units rv_limit_kind is in
    // ...and the number each mode was last left on, so switching between them does not reinterpret
    // one mode's value in the other's units (16 plies read as 16ms, 1000ms read as depth 1000).
    rv_limit_depth: 16,      // plies
    rv_limit_time: 1000,     // ms
    rv_multipv: 3,
    // Not a literal: 4 is most of a two-core laptop and a quarter of a workstation. The panel
    // and the settings page already share this, so a review uses the same rule.
    get rv_threads() { return MephistoConfig.defaultThreads(); },
    // HOW MANY ENGINES SEARCH AT ONCE. The positions of a game are independent, so N engines cut
    // the pass to about 1/N of the wall clock -- what chess.com's review does. Two by default: the
    // second engine is nearly free on any machine that can run one, and the threads below are
    // SPLIT between them, so this trades a little depth-per-position for a lot less waiting.
    rv_workers: 2,
    rv_hash: 256,
    rv_human: '',
    rv_maia_band: '1500',
    rv_maia3_elo: 1500,
    rv_book: true,
    rv_human_report: false,
    rv_strength: false,      // the maximum-likelihood rating estimate; a pass per rating band

    rv_batch: false,
    rv_mode: 'own',          // which of the three reviews the page shows: own | local | online
    rv_ee_tier: 'card',      // chess.com classifier search budget: card | fast | standard | deep | max
    rv_variant: 'chess',     // the game type: chess | chess960 | variant | 4pc
    rv_variant_which: 'crazyhouse',   // which Fairy variant, when rv_variant is 'variant'
};

// A game whose clocks and blunders make the whole report show something. Deliberately a famous
// short one: it finishes analysing in seconds even on the small net, so the first thing a new user
// clicks does not take a minute.
// Switching between the two budgets has to move the NUMBER as well: 16 means something as a depth
// and nothing as a millisecond count.
const DEPTH_DEFAULT = 16;
const TIME_DEFAULT_MS = 1000;

const SAMPLE_PGN = `[Event "Immortal Game"]
[Site "London"]
[Date "1851.06.21"]
[White "Anderssen"]
[Black "Kieseritzky"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`;

// ---- module state (survives a route change; the DOM does not) ---------------------------------
let games = [];         // every game in the pasted PGN
let report = null;      // the finished review, or null
let running = false;
let cancel = false;
let board = null;
let cursor = 0;         // which ply the board is showing (0 = start position)
let flipped = false;
let nativeAvailable = null; // engine id -> bool, probed once per page load
let batchReports = null;    // every game's report, when a batch was run
// The engine currently searching, if any. Held at module scope for one reason: closing or reloading
// this tab has to shut it down. Nothing else would -- the worker frees a PANEL's engine when its tab
// closes (keyed by tab id) and this client is deliberately not one, so a run abandoned by closing
// the tab would leave a multi-threaded search burning cores with nobody watching it.
let activeEngine = null;
// ...and the WHOLE pool, for the same reason. Stop and the tab-close handler used to address
// `activeEngine` alone, which is engines[0]: with the default two workers, pressing Stop left the
// second engine searching out its full budget (up to 300 s per position in Time mode) after the page
// had already said "Stopped.".
let activeEngines = [];

const $ = (id) => document.getElementById(id);

// ---- engine drivers ---------------------------------------------------------------------------
// Two transports, one interface: `analyse(fen)` resolves to `{lines, depth, nodes}` with every score
// already converted to WHITE-POSITIVE centipawns. Which transport is in use never leaves this
// section -- everything below reads `lines[i].cp` and nothing else.

// The WASM engines, over the offscreen document's UCI relay. clientId is a STRING that does not
// parse as a tab id on purpose: the service worker relays engine output to `parseInt(clientId)` and
// must not try to deliver ours to a tab (see background-script.js).
class WasmEngine {
    constructor(name, opts, clientId) {
        this.name = name;
        this.opts = opts;
        // ONE ID PER ENGINE. The offscreen host keys everything on this: a second `init` with the
        // same id DISPOSES the first engine and replaces it, and both listeners then see the
        // survivor's output. That is fine when the two run one after the other, and it was -- until
        // the batch refactor started the analysis engine and the human model together, at which
        // point Maia's init silently killed Stockfish and answered in its place. Every eval after
        // that was a depth-1 human-likelihood score, which reads as a sawtooth on the graph and as
        // a perfect game in the numbers.
        this.clientId = clientId || 'review';
        this.listeners = [];
        this.waiters = new Set();   // the reject halves of pending once() promises -- see dispose()
        this.onMessage = (msg) => {
            if (!msg || !msg.fromOffscreen || msg.clientId !== this.clientId) return;
            for (const fn of this.listeners.slice()) fn(msg);
        };
    }

    async start() {
        await chrome.runtime.sendMessage({ensureOffscreen: true});
        chrome.runtime.onMessage.addListener(this.onMessage);
        const ready = this.once(m => m.kind === 'ready' || m.kind === 'error', 120000);
        chrome.runtime.sendMessage({
            toOffscreen: true, clientId: this.clientId, cmd: 'init',
            engine: this.name, variant: this.opts.variant || 'chess', maiaLevel: this.opts.maiaLevel,
            // Maia-2 answers a MATCHUP: it takes both ratings and ignores maiaLevel. Sent for every
            // engine because the loader drops what it does not use, exactly as the panel does.
            elos: this.opts.elos || [this.opts.maiaLevel || 1500, this.opts.maiaLevel || 1500],
        });
        const r = await ready;
        if (r.kind === 'error') throw new Error(r.error);
        if (!this.isMaia()) {
            this.send(`setoption name Threads value ${this.opts.threads}`);
            this.send(`setoption name Hash value ${this.opts.hash}`);
            this.send(`setoption name MultiPV value ${this.opts.multipv}`);
            // Chess960 castling is a UCI option on the MAINLINE Stockfishes, not a variant --
            // exactly as the panel sends it at engine init (popup.js). Fairy is told through
            // UCI_Variant by the offscreen loader instead, and Maia has no 960 at all.
            if (this.opts.variant === 'fischerandom' && this.name !== 'fairy-stockfish-14-nnue') {
                this.send('setoption name UCI_Chess960 value true');
            }
        } else {
            // Maia has no threads and no hash -- it is one forward pass -- but it DOES read MultiPV,
            // and without this it answers with a single line. That made the human model look like it
            // had exactly one idea in every position (found on the Analysis page, 2026-08-15: the
            // human column showed one move at 100%). Game Review's human column gets the same fix.
            this.send(`setoption name MultiPV value ${this.opts.multipv}`);
        }
        this.send('ucinewgame');
        await this.isready();
    }

    // Every net that answers in ONE forward pass: no threads, no hash, no MultiPV, no depth to wait
    // for. Named for what it tests rather than for Maia -- Elite Leela and Maia-2 are the same shape
    // and were silently sent Threads/Hash/MultiPV they do not have.
    isMaia() { return ONE_PASS_NETS.includes(this.name); }

    send(line) {
        chrome.runtime.sendMessage({toOffscreen: true, clientId: this.clientId, cmd: 'uci', line});
    }

    // Resolve on the first message matching `pred`. Every wait here is bounded: a WASM engine that
    // dies mid-load emits nothing at all, and an unbounded await would leave the page at 0% with a
    // progress bar and no explanation -- the exact failure the floating panel had.
    once(pred, timeoutMs) {
        return new Promise((resolve, reject) => {
            // Infinity = wait for ever. setTimeout would fire IMMEDIATELY on a non-finite delay
            // (it coerces to 0), so an unbounded search would end the instant it began.
            const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
                off();
                reject(new Error(`the engine stopped answering after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs) : null;
            const fn = (msg) => { if (pred(msg)) { off(); resolve(msg); } };
            const off = () => {
                if (timer) clearTimeout(timer);
                this.waiters.delete(bail);
                const i = this.listeners.indexOf(fn);
                if (i >= 0) this.listeners.splice(i, 1);
            };
            // dispose() calls this: a cleared listener list would otherwise leave the promise
            // PENDING FOREVER -- and anything serialised behind it (the Maia-3 sweep queue, most
            // painfully) hangs with it. Found live: turning the Maia 3 dial wedged the human
            // column for good, with the offscreen host perfectly healthy underneath.
            const bail = () => { off(); reject(new Error('engine disposed')); };
            this.waiters.add(bail);
            this.listeners.push(fn);
        });
    }

    async isready() {
        const wait = this.once(m => m.kind === 'line' && /^readyok\b/.test(m.line), 60000);
        this.send('isready');
        await wait;
    }

    // One position. Collects the best info line PER multipv slot at the deepest depth reached, then
    // returns when `bestmove` arrives -- which is the only reliable "the search is over" signal UCI
    // has. A slot is overwritten only by a line at least as deep, so a shallow re-search late in the
    // iteration cannot replace a deeper result.
    async analyse(fen, turn) {
        const slots = new Map();
        let nodes = 0, depth = 0;
        const collect = (msg) => {
            if (msg.kind !== 'line') return;
            const info = Core.parseInfo(msg.line);
            if (!info || info.bound) return;
            nodes = Math.max(nodes, info.nodes || 0);
            depth = Math.max(depth, info.depth);
            const prev = slots.get(info.multipv);
            if (!prev || info.depth >= prev.depth) slots.set(info.multipv, info);
        };
        // UNBOUNDED SEARCH means exactly `go infinite` (user call 2026-08-15): nothing here decides
        // it has thought long enough. It ends when something ASKS it to -- stopSearch(), which the
        // Stop button calls -- and until then the position keeps getting deeper.
        this.listeners.push(collect);
        const done = this.once(m => m.kind === 'line' && /^bestmove\b/.test(m.line), this.searchTimeout());
        this.send(`position fen ${fen}`);
        this.send(this.goCommand());
        try {
            await done;
        } finally {
            const i = this.listeners.indexOf(collect);
            if (i >= 0) this.listeners.splice(i, 1);
        }
        return this.toResult(slots, turn, depth, nodes);
    }

    // INFINITE ANALYSIS, the way an analysis board works everywhere: the engine keeps thinking about
    // the position in front of you and the lines deepen while you look at them, until you move on.
    // `onUpdate(lines, depth, nodes)` fires as results improve; `stop()` ends it. Maia has nothing to
    // deepen (one forward pass), so it answers once and reports done.
    // `opts.depth` caps the search: `go depth N` instead of `go infinite`, so the engine stops
    // itself and the result carries `done: true`. Everything else -- streaming, stop(), the drain
    // discipline -- is the one search path unchanged.
    startInfinite(fen, turn, onUpdate, opts = {}) {
        const slots = new Map();
        let nodes = 0, depth = 0, stopped = false, timer = null, finished = false;
        const emit = () => {
            if (!stopped) onUpdate(Object.assign(this.toResult(slots, turn, depth, nodes), {done: finished}));
        };
        const collect = (msg) => {
            if (msg.kind !== 'line') return;
            if (/^bestmove\b/.test(msg.line)) { finished = true; if (timer) { clearTimeout(timer); timer = null; } emit(); return; }
            const info = Core.parseInfo(msg.line);
            if (!info || info.bound) return;
            nodes = Math.max(nodes, info.nodes || 0);
            depth = Math.max(depth, info.depth);
            const prev = slots.get(info.multipv);
            if (!prev || info.depth >= prev.depth) slots.set(info.multipv, info);
            // coalesced: an engine emits info far faster than a screen can show it, and rendering
            // every line is how an analysis page becomes unusable at high depth
            if (!timer) timer = setTimeout(() => { timer = null; emit(); }, 180);
        };
        this.listeners.push(collect);
        this.send(`position fen ${fen}`);
        const capDepth = this.isMaia() ? 0 : Math.max(0, Math.floor(+opts.depth || 0));
        this.send(this.isMaia() ? 'go' : (capDepth ? `go depth ${capDepth}` : 'go infinite'));
        return {
            // STOP MEANS "STOPPED", NOT "ASKED TO STOP". A search that has been told to stop keeps
            // emitting info lines until its `bestmove` arrives, and those lines describe the OLD
            // position -- start the next search before it lands and they are collected as if they
            // were the new one. It showed as an engine line that is illegal in the position on the
            // board (d2d4 after 1.d4). So stop() resolves on bestmove, and the caller awaits it.
            stop: () => {
                if (stopped) return Promise.resolve();
                stopped = true;
                if (timer) { clearTimeout(timer); timer = null; }
                const drop = () => {
                    const i = this.listeners.indexOf(collect);
                    if (i >= 0) this.listeners.splice(i, 1);
                };
                // A depth-capped search that already sent its bestmove has nothing to stop --
                // waiting for a second bestmove here would stall the next position for 8s.
                if (this.isMaia() || finished) { drop(); return Promise.resolve(); }
                const done = this.once(m => m.kind === 'line' && /^bestmove\b/.test(m.line), 8000)
                    .catch(() => null)      // an engine that never answers must not wedge the page
                    .then(() => drop());
                this.send('stop');
                return done;
            },
        };
    }

    goCommand() {
        if (this.isMaia()) return 'go';                       // one forward pass; no budget to give
        const {limitKind, limitValue} = this.opts;
        if (limitKind === 'depth') return `go depth ${limitValue}`;
        return limitValue >= LIMIT_INFINITE ? 'go infinite' : `go movetime ${limitValue}`;
    }

    // Generous, because it is a backstop and not a budget: a 4-thread WASM search at depth 20 in a
    // sharp position can take a while, and cutting it short would silently corrupt the review.
    searchTimeout() {
        const {limitKind, limitValue} = this.opts;
        if (limitKind === 'depth') return 180000;
        // NO backstop for an unbounded search. A timeout here would be a time limit wearing another
        // name, and the whole point of this setting is that there is no time limit.
        if (limitValue >= LIMIT_INFINITE) return Infinity;
        return Math.max(30000, limitValue * 20);
    }

    toResult(slots, turn, depth, nodes) {
        const lines = [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, info]) => ({
            cp: Core.toWhiteCp(info.score, info.mate, turn),
                wdl: info.wdl || null,   // permille, side-to-move relative
            mate: info.mate ?? null,
            prob: info.prob ?? null,   // human models only; null from any search engine
            pv: info.pv,
            depth: info.depth,
        }));
        return {lines, depth, nodes};
    }

    // Interrupt the search in progress WITHOUT tearing the engine down. The stopped search still
    // emits until its `bestmove`, so analyse() resolves normally with whatever depth it reached --
    // which is the only way an unbounded search can ever end.
    stopSearch() {
        try { this.send('stop'); } catch (e) { /* the worker is already gone */ }
    }

    dispose() {
        try { chrome.runtime.onMessage.removeListener(this.onMessage); } catch (e) { /* gone */ }
        try {
            chrome.runtime.sendMessage({toOffscreen: true, clientId: this.clientId, cmd: 'dispose'});
        } catch (e) { /* the worker or the offscreen doc is already gone */ }
        // Reject, do not abandon: every promise still waiting on this engine settles NOW, so a
        // chain awaiting one of them keeps moving instead of hanging on an answer that can never
        // arrive. The callers already handle a failed engine; none of them handled a silent one.
        for (const bail of [...this.waiters]) { try { bail(); } catch (e) { /* */ } }
        this.waiters.clear();
        this.listeners = [];
    }
}

// The native hosts, over the service worker's port relay. The host answers a whole `analyse` with
// its final line list, already white-relative, so there is no UCI parsing on this path at all.
// How long a depth-mode native search is allowed to take if the host turns out not to understand
// `depth`. It has to be a real budget rather than a token one: an old host will spend all of it.
const NATIVE_DEPTH_CAP_MS = 8000;
// The native stand-in for `go infinite`. A host's `analyse` always carries a budget, so unbounded
// analysis is one very long request that streams its info frames; this is a ceiling, not a target
// -- stop() ends it long before, and an hour is the same figure the panel's ponder budget uses.
const NATIVE_INFINITE_MS = 3600000;

class NativeEngine {
    constructor(name, opts, clientId) {   // clientId is the WASM host's business; a port is its own
        this.name = name;
        this.opts = opts;
        this.seq = 0;
        this.pending = new Map();
    }

    async start() {
        this.port = chrome.runtime.connect({name: this.name});
        this.port.onMessage.addListener((frame) => {
            if (frame && frame.fatal) {
                for (const {reject} of this.pending.values()) reject(new Error(frame.fatal));
                this.pending.clear();
                return;
            }
            if (!frame || frame.id == null) return;
            const p = this.pending.get(frame.id);
            if (!p) return;
            if (frame.info) { p.onInfo?.(frame.info); return; }   // a streamed depth update, not the answer
            this.pending.delete(frame.id);
            if (frame.error) p.reject(new Error(frame.error));
            else p.resolve(frame);
        });
        this.port.onDisconnect.addListener(() => {
            const err = new Error('the native host disconnected -- run native-host/install.sh once');
            for (const {reject} of this.pending.values()) reject(err);
            this.pending.clear();
            this.port = null;
        });
        await this.request('configure', {options: {
            MultiPV: this.opts.multipv, Threads: this.opts.threads, Hash: this.opts.hash,
            UCI_Variant: 'chess',
        }});
    }

    // `extra.onInfo` receives every streamed `{info}` frame for THIS request (already matched by
    // id, so another request's tail can never leak in); `extra.timeoutMs` overrides the backstop
    // for a request whose budget the default arithmetic knows nothing about.
    request(cmd, data, extra = {}) {
        return new Promise((resolve, reject) => {
            if (!this.port) return reject(new Error('the native host is not connected'));
            const id = ++this.seq;
            this.pending.set(id, {resolve, reject, onInfo: extra.onInfo});
            // The host has no cancel: if it never answers, this promise would hold the whole run.
            setTimeout(() => {
                if (!this.pending.has(id)) return;
                this.pending.delete(id);
                reject(new Error('the native host did not answer this position'));
            }, extra.timeoutMs || Math.max(30000, (this.opts.limitKind === 'depth'
                ? NATIVE_DEPTH_CAP_MS : (this.opts.limitValue || 300)) * 20));
            try { this.port.postMessage({id, cmd, ...data}); } catch (e) { this.pending.delete(id); reject(e); }
        });
    }

    // The host's line shape (its format_line) -> the page's. The host already reports
    // white-relative scores (python-chess `.white()`), so unlike the WASM path there is no turn to
    // fold into cp -- but its wdl is white-relative too, and the pages read wdl as side-to-move
    // permille (the WASM convention), so THAT one is folded. One mapper because the streamed info
    // frames and the terminal `lines` array carry the same fields.
    toLine(l, turn) {
        return {
            cp: (l.mate != null && l.mate !== undefined)
                ? (l.mate > 0 ? Core.MATE_CP - Math.abs(l.mate) : -(Core.MATE_CP - Math.abs(l.mate)))
                : (l.score || 0),
            wdl: Array.isArray(l.wdl) ? (turn === 'w' ? l.wdl : [l.wdl[2], l.wdl[1], l.wdl[0]]) : null,
            mate: l.mate ?? null,
            pv: l.pv,
            depth: l.depth || 0,
        };
    }

    async analyse(fen, turn) {
        // BOTH budgets go over the wire. A host that understands `depth` uses it; one that predates
        // the field ignores it and uses `time` exactly as before, so an old install keeps working
        // rather than silently doing something else. In depth mode `time` is the safety cap.
        const depthMode = this.opts.limitKind === 'depth';
        const frame = await this.request('analyse', {
            fen,
            time: depthMode ? NATIVE_DEPTH_CAP_MS : this.opts.limitValue,
            depth: depthMode ? this.opts.limitValue : undefined,
        });
        const lines = (frame.lines || []).filter(l => l.pv && l.pv.length).map(l => this.toLine(l, turn));
        return {lines, depth: lines.length ? lines[0].depth : 0, nodes: 0};
    }

    // INFINITE ANALYSIS over the one-shot wire, same contract as the WASM version above. The host
    // cannot run `go infinite` -- an `analyse` always carries a budget -- but it STREAMS an info
    // frame per depth, so one very long request behaves exactly like it: the lines deepen on screen
    // until stop(). `opts.depth` becomes the host's own depth budget (the host stops itself and the
    // result carries `done: true`); otherwise the budget is NATIVE_INFINITE_MS, a ceiling.
    startInfinite(fen, turn, onUpdate, opts = {}) {
        const slots = new Map();
        let depth = 0, nodes = 0, stopped = false, timer = null, settled = false;
        const emit = (done) => {
            if (stopped) return;
            const lines = [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
            onUpdate({lines, depth, nodes, done});
        };
        const capDepth = Math.max(0, Math.floor(+opts.depth || 0));
        const req = this.request('analyse', {
            fen,
            time: NATIVE_INFINITE_MS,
            depth: capDepth || undefined,
        }, {
            timeoutMs: NATIVE_INFINITE_MS + 30000,
            onInfo: (info) => {
                if (stopped || !info.pv || !info.pv.length || info.bound) return;
                depth = Math.max(depth, info.depth || 0);
                nodes = Math.max(nodes, info.nodes || 0);
                const prev = slots.get(info.multipv || 1);
                if (!prev || (info.depth || 0) >= prev.depth) slots.set(info.multipv || 1, this.toLine(info, turn));
                // coalesced for the same reason as the WASM path -- a native engine emits faster still
                if (!timer) timer = setTimeout(() => { timer = null; emit(false); }, 180);
            },
        });
        req.then((frame) => {
            settled = true;
            if (timer) { clearTimeout(timer); timer = null; }
            // the terminal frame is the complete answer; it replaces whatever the stream built up
            slots.clear();
            const finals = (frame.lines || []).filter(l => l.pv && l.pv.length);
            finals.forEach((l, i) => slots.set(l.multipv || i + 1, this.toLine(l, turn)));
            depth = Math.max(depth, finals[0]?.depth || 0);
            nodes = Math.max(nodes, finals[0]?.nodes || 0);
            emit(true);
        }).catch(() => { settled = true; /* stopped, superseded or timed out -- nothing to show */ });
        return {
            // STOPPING A HOST: `{cmd:'stop'}` is not understood by any installed host (it answers an
            // id-less error frame every listener drops). What DOES interrupt one is a NEWER analyse:
            // the host's request counter bumps and the running search is abandoned (python-chess
            // sends the UCI stop on its way out of the analysis context). So the kill switch is a
            // 1ms analyse of the same position -- which also works on every host already installed.
            // The wait afterwards is ORDERING, not politeness: the abandoned request's terminal
            // frame proves the kill's counter bump happened, so a search the caller starts next
            // cannot be the one the kill supersedes. Bounded like the WASM stop, and skipped
            // entirely when the host already finished on its own (a depth-capped search).
            stop: () => {
                if (stopped) return Promise.resolve();
                stopped = true;
                if (timer) { clearTimeout(timer); timer = null; }
                if (settled) return Promise.resolve();
                this.request('analyse', {fen, time: 1}, {timeoutMs: 30000}).catch(() => {});
                return Promise.race([
                    req.then(() => {}, () => {}),
                    new Promise(r => setTimeout(r, 8000)),
                ]);
            },
        };
    }

    // Interrupt a running one-shot analyse (Game Review's Stop): same kill switch as
    // startInfinite's stop() and for the same reason -- `{cmd:'stop'}` was always a silent no-op,
    // so Stop used to leave the host searching out its whole budget. The superseded request still
    // resolves, with whatever lines it had, which is what the review path already expects.
    stopSearch() {
        this.request('analyse', {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', time: 1,
        }, {timeoutMs: 30000}).catch(() => { /* port already gone -- nothing left to stop */ });
    }

    dispose() {
        try { this.port?.disconnect(); } catch (e) { /* already gone */ }
        this.port = null;
        this.pending.clear();
    }
}

// The Maia nets are engines here too (the pages ask for them by name for the human pass), so an id
// is "known" if this list or that one has it.
// The human-trained nets, which makeEngine must not mistake for an unknown id and replace with
// Stockfish. Keep in step with ONE_PASS_ENGINES in popup.js.
const KNOWN_HUMAN = ['maia', 'maia2', 'maia3', 'elite-leela'];
const ONE_PASS_NETS = KNOWN_HUMAN;

function makeEngine(id, opts, clientId) {
    const spec = ENGINES.find(e => e.id === id);
    // AN UNKNOWN ID USED TO BECOME A WASM ENGINE and the offscreen loader then fetched
    // `/lib/engine/undefined` -- which is what a stale stored selection (an engine dropped in a
    // later version, or a panel-only engine like a cloud/remote entry) looked like on screen:
    // "Failed to fetch dynamically imported module ... /lib/engine/undefined". Fall back to a
    // shipped engine and SAY so, rather than failing on a path built from a typo.
    if (!spec && !KNOWN_HUMAN.includes(id)) {
        console.warn(`Mephisto: unknown engine "${id}" - falling back to ${ENGINE_FALLBACK}`);
        id = ENGINE_FALLBACK;
    }
    const kind = ENGINES.find(e => e.id === id)?.kind;
    return (kind === 'native')
        ? new NativeEngine(id, opts, clientId) : new WasmEngine(id, opts, clientId);
}

// Is a native host installed? Same probe the panel uses: `ping` is answered without launching the
// engine, so this costs nothing even when all three are present.
function nativeHostAvailable(portName) {
    return new Promise(resolve => {
        let done = false, port;
        const finish = (ok) => { if (done) return; done = true; try { port.disconnect(); } catch (e) { /* */ } resolve(ok); };
        try { port = chrome.runtime.connect({name: portName}); } catch (e) { return resolve(false); }
        port.onMessage.addListener(frame => finish(!frame.fatal));
        port.onDisconnect.addListener(() => finish(false));
        try { port.postMessage({id: -1, cmd: 'ping'}); } catch (e) { return finish(false); }
        setTimeout(() => finish(false), 1200);
    });
}


self.MephistoEngines = {
    ENGINES, MAIA_BANDS, WasmEngine, NativeEngine, makeEngine, nativeHostAvailable,
    NATIVE_DEPTH_CAP_MS, LIMIT_INFINITE,
};
