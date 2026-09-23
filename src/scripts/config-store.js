// Mephisto config store (N1 Phase 3).
// The panel config used to live in the popup iframe's localStorage (extension origin). When the panel
// moves out of the iframe into the page's ISOLATED WORLD (Phase 4), that localStorage becomes the
// SITE's localStorage -- wrong, and writing config keys there would even be a fingerprint. So config
// moves to chrome.storage.local, which every extension context (isolated-world content script,
// offscreen doc, options page, service worker) can read.
//
// Design: a synchronous in-memory CACHE over chrome.storage.local, so the many existing SYNC readers
// (pullConfig, fresh_timing, humanize_rates) don't have to become async -- they read the cache, which
// init() fills once and chrome.storage.onChanged keeps live. Values are the SAME JSON strings
// localStorage held, so existing JSON.parse/stringify call sites are unchanged: get()==getItem,
// set(k, jsonString)==setItem.
//
// Backends by context (see EXT_PAGE below):
//   * popup PAGE / options page (extension origin): chrome.storage.local, with the old localStorage
//     kept as a migration source and a read-fallback -- harmless there, it's OUR storage.
//   * content script (panel in-page): chrome.storage.local ONLY. `localStorage` there is the SITE's,
//     so writing config into it would hand the page a trivially readable fingerprint.
// chrome.storage.local is the single source of truth; anything that reads synchronously must await
// `MephistoConfig.ready` first, or it will read an empty cache and can push stale values back.
(function () {
    const CACHE = {};
    let ready = false;

    // In the popup PAGE / options page, `localStorage` is the EXTENSION's -- the old config backend,
    // still useful as a migration source and a transition mirror. In a CONTENT SCRIPT it is the
    // SITE's localStorage, which must never be touched:
    //   * writing there leaks config keys (autoplay, humanize, engine, ...) into storage the page can
    //     simply read -- a fingerprint, and exactly what removing the iframe was for;
    //   * reading there returns the site's data, not ours.
    // So on the content-script side chrome.storage.local is the ONLY backend.
    const EXT_PAGE = (location.protocol === 'chrome-extension:');

    function lsGet(key) { if (!EXT_PAGE) return null; try { return localStorage.getItem(key); } catch (e) { return null; } }
    function lsSet(key, val) { if (!EXT_PAGE) return; try { localStorage.setItem(key, val); } catch (e) { /* */ } }
    function lsRemove(key) { if (!EXT_PAGE) return; try { localStorage.removeItem(key); } catch (e) { /* */ } }

    const api = {
        // mimics localStorage.getItem: the stored JSON string, or null when absent
        get(key) {
            if (key in CACHE) return CACHE[key];
            return lsGet(key); // Phase-3 fallback (extension origin); empty/null in the isolated world
        },
        // mimics localStorage.setItem(key, jsonString)
        set(key, val) {
            const s = String(val);
            CACHE[key] = s;
            try { chrome.storage.local.set({[key]: s}); } catch (e) { /* SW asleep is fine, cache still set */ }
            lsSet(key, s); // Phase-3 mirror -- REMOVE in Phase 4
        },
        remove(key) {
            delete CACHE[key];
            try { chrome.storage.local.remove(key); } catch (e) { /* */ }
            lsRemove(key);
        },
        // Default thread count, shared by the panel and the options page (both load this file) so the
        // two can't drift apart. cores-1 leaves one for the browser/OS -- handing the engine EVERY
        // core makes the page it's scraping stutter. Clamped to the sliders' 1..24; hardwareConcurrency
        // is undefined in some contexts, so fall back to the old fixed default.
        defaultThreads() {
            const cores = navigator.hardwareConcurrency;
            // HALF the cores, not all-but-one (user call 2026-08-09). All-but-one leaves nothing for
            // the browser on a small machine, and the engine's own scheduling is not the only thing
            // competing -- the page is being scraped and rendered on the same box. Half is a default,
            // not a ceiling: the slider still goes to 24, and an existing install keeps its saved value
            // because this is only consulted when nothing has been stored yet.
            return cores ? Math.max(1, Math.min(24, Math.floor(cores / 2))) : 4;
        },
        // AN ENGINE THAT NO LONGER SHIPS. A saved `engine` naming a build that has been removed is
        // a panel that cannot start: the offscreen loader has no path for it, so every command
        // queues for an engine that will never load. Both readers use this -- the panel to pick what
        // to run, the options page to show what is selected.
        RETIRED_ENGINES: {'stockfish-dev-nnue': 'stockfish-19-nnue',
                          'stockfish-18-small-nnue': 'stockfish-19-small-nnue'},
        liveEngine(id) { return this.RETIRED_ENGINES[id] || id; },

        // Default hotkeys (action -> key-combo), shared by the keydown listener (content script), the
        // rebind UI (options page), and the panel's "(A)" label hints -- ONE source so they can't drift.
        // Single letters: they fire only when you're not typing in a field, and our capture-phase
        // listener preventDefaults them so the site's own letter shortcut doesn't also run.
        HOTKEY_DEFAULTS: {
            manual_play: ' ',
            manual_mode: 'n', autoplay: 'a', premove: 'p', help_mode: 'h', humanize: 'u',
            clock_mode: 'c', clock_pace: 'k', mirror_mode: 'm', eval_bar: 'e', eval_history: 'y', live_stats: 'l', tablebase: 't', puzzle_mode: 'z',
            explorer: 'o', book_play: 'b',
            copy_fen: 'f', copy_pgn: 'g', copy_diagnostics: 'd', redetect: 'r',
            // The two title-bar buttons, which had no keys. 'm' and 'c' were long gone (Mirror Time,
            // Clock Mode), so: v for compact VIEW, i for mInImize.
            compact: 'v', minimize: 'i',
            // Bot Tricks -- a ONE-SHOT action, not a toggle: it plays the chosen game once, and it
            // does nothing at all unless the feature is on and you are on the Play Computer page.
            // Plain t (for troll) has been the Tablebase key since long before this existed, and
            // moving a binding people already have in their fingers to make room for a new one is
            // the wrong trade, so w (for win). j, q and s were the other letters still free.
            bot_trick: 'w',
            panic: 'x',   // everything away, NOW: hide the panel, clear the arrows, stop the search
            // WALKING THE ENGINE'S LINE. The arrow keys, because that is what every board on the
            // web uses them for -- but the handlers return false while Walk With Arrow Keys is off,
            // and a key the panel did not act on is never swallowed, so the site keeps its own
            // arrow-key navigation until you switch this on.
            pv_back: 'ArrowLeft', pv_forward: 'ArrowRight',
            // The cheat sheet. '?' is where every web app with shortcuts (GitHub, Gmail, lichess
            // itself) puts its list, so it is the first key anyone tries. It is typed with Shift on
            // every layout, which is why hotkeyString drops Shift for symbols (see canonHotkey).
            shortcuts: '?',
        },
        // What each action is called, wherever a person reads the list: the Hotkeys settings rows,
        // the macro step pickers and the panel's cheat sheet. Here, beside the defaults, because
        // three places reading one list cannot disagree about what "u" does.
        HOTKEY_LABELS: {
            manual_play: 'Play move (Manual Mode)', manual_mode: 'Toggle Manual Mode', autoplay: 'Toggle Autoplay',
            premove: 'Toggle Premove', explorer: 'Toggle Opening Explorer', book_play: 'Toggle Book Moves',
            help_mode: 'Toggle Help Mode', humanize: 'Toggle Humanize', clock_mode: 'Toggle Clock Mode',
            clock_pace: 'Toggle Pace to Clock', mirror_mode: 'Toggle Mirror Time', eval_bar: 'Toggle Eval Bar',
            eval_history: 'Toggle Eval History', live_stats: 'Toggle Live Stats',
            tablebase: 'Toggle Endgame Tablebase', puzzle_mode: 'Toggle Puzzle Mode',
            copy_fen: 'Copy FEN', copy_pgn: 'Copy PGN', copy_diagnostics: 'Copy Diagnostics',
            redetect: 'Re-detect game', compact: 'Compact view', minimize: 'Minimize / restore panel',
            bot_trick: 'Bot Tricks - play the chosen game at a bot',
            panic: 'Panic - hide the panel, stop the engine',
            pv_back: 'Walk the line back', pv_forward: 'Walk the line forward',
            shortcuts: 'Show shortcuts',
        },
        // "Shift+?" -> "?". A symbol already says whether Shift was down ('?' vs '/', '!' vs '1'), and
        // WHICH key needs Shift differs by layout ('?' is Shift+/ on US, Shift+ß on German), so a
        // binding that kept it would be a different string on every keyboard. Letters keep it: 'a'
        // and 'A' fold together, so there Shift is the only difference. Space keeps it too.
        canonHotkey(k) {
            if (typeof k !== 'string') return '';
            return k.replace(/Shift\+((?:Meta\+)?)(.)$/,
                (m, meta, c) => (c !== ' ' && c.toLowerCase() === c.toUpperCase()) ? meta + c : m);
        },
        // canonical combo string for a keydown: "Alt+a", "Shift+Ctrl+k", " " (space), "ArrowUp", "?".
        // ONE normalization for the listener (content script) and the rebind UI (options page), so
        // what gets stored is exactly what gets compared.
        hotkeyString(e) {
            const parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Meta');
            parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
            return this.canonHotkey(parts.join('+'));
        },
        // the effective bindings: defaults overlaid with whatever the user saved in config.hotkeys.
        // Canonicalized on the way out, so a "Shift+?" saved before canonHotkey existed still fires.
        hotkeys() {
            let saved = {};
            try { saved = JSON.parse(this.get('hotkeys')) || {}; } catch (e) { /* unset/corrupt */ }
            const out = {...this.HOTKEY_DEFAULTS, ...saved};
            for (const a in out) out[a] = this.canonHotkey(out[a]);
            return out;
        },
        // HOTKEY MACROS: one key, a list of existing actions run in order. Stored as config
        // `hotkey_macros` = [{key, steps: [action, ...]}]. Sanitized HERE, on every read, so the
        // listener never has to trust storage: a step must be a real action id (so a macro can
        // never name itself or another macro -- macros have no ids to name), at most 8 of them.
        HOTKEY_MACRO_MAX_STEPS: 8,
        hotkeyMacros() {
            let saved;
            try { saved = JSON.parse(this.get('hotkey_macros')); } catch (e) { /* unset/corrupt */ }
            if (!Array.isArray(saved)) return [];
            return saved.filter(m => m && Array.isArray(m.steps)).map(m => ({
                key: this.canonHotkey(m.key),
                steps: m.steps.filter(s => Object.hasOwn(this.HOTKEY_DEFAULTS, s))
                    .slice(0, this.HOTKEY_MACRO_MAX_STEPS),
            }));
        },
        // Who already owns `key`: an action id, 'macro:<index>', or null. `skipMacro` is the macro
        // being rebound, so pressing its own key again is not a clash with itself.
        hotkeyOwner(key, skipMacro = -1) {
            if (!key) return null;
            const b = this.hotkeys();
            for (const a in b) if (b[a] === key) return a;
            const ms = this.hotkeyMacros();
            for (let i = 0; i < ms.length; i++) if (i !== skipMacro && ms[i].key === key) return 'macro:' + i;
            return null;
        },
        // --- ENGINES THAT ONLY UNDERSTAND A DEPTH -------------------------------------------------
        // stockfish.online's whole API is a fen and a depth: there is nowhere to put a search TIME,
        // so a panel set to "300 ms" would silently get whatever depth 12 costs. Selecting it moves
        // the search budget to Depth and REMEMBERS what was there; selecting anything else puts that
        // back. Visible state, not a hidden special case -- the Budget select really does change,
        // and the value it restores is the user's own.
        //
        // It lives here rather than in either UI because BOTH can change the engine (the panel's
        // quick-settings and the options page), and one rule in two places is one rule that drifts.
        DEPTH_ONLY_ENGINES: ['cloud-stockfish-online'],
        BUDGET_MEMO_KEY: 'search_mode_before_depth_only',

        // Returns the search mode that should now be in force, having written it. Callers refresh
        // their own control from the return value.
        applyEngineBudgetRule(engine) {
            const depthOnly = this.DEPTH_ONLY_ENGINES.includes(engine);
            const current = (() => {
                try { return JSON.parse(this.get('search_mode')); } catch (e) { return 'time'; }
            })();
            if (depthOnly) {
                // remember only the FIRST time, so switching between two depth-only engines cannot
                // overwrite the memo with 'depth' and lose what the user actually had
                if (current !== 'depth' && !this.get(this.BUDGET_MEMO_KEY)) {
                    this.set(this.BUDGET_MEMO_KEY, JSON.stringify(current));
                }
                this.set('search_mode', JSON.stringify('depth'));
                return 'depth';
            }
            const memo = this.get(this.BUDGET_MEMO_KEY);
            if (!memo) return current;               // we never changed it; leave the user's choice alone
            let restored = 'time';
            try { restored = JSON.parse(memo) || 'time'; } catch (e) { /* corrupt memo -> time */ }
            this.remove(this.BUDGET_MEMO_KEY);
            this.set('search_mode', JSON.stringify(restored));
            return restored;
        },

        // load chrome.storage into the cache once; one-time migrate the old localStorage config in.
        async init() {
            if (ready) return;
            let all = {};
            try { all = await chrome.storage.local.get(null); } catch (e) { all = {}; }
            if (!all.__cfg_migrated && EXT_PAGE) {
                try {
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        // config keys only -- skip the content-script's page caches (mephisto.*)
                        if (k && !k.startsWith('mephisto.') && !(k in all)) all[k] = localStorage.getItem(k);
                    }
                } catch (e) { /* no localStorage here */ }
                all.__cfg_migrated = '1';
                try { await chrome.storage.local.set(all); } catch (e) { /* */ }
            }
            Object.assign(CACHE, all);
            ready = true;
        },
    };

    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            for (const k in changes) {
                if ('newValue' in changes[k]) CACHE[k] = changes[k].newValue;
                else delete CACHE[k];
            }
        });
    } catch (e) { /* chrome.storage unavailable -> get() falls back to localStorage */ }

    // Start loading immediately and expose the promise: the options page's form code reads
    // synchronously, so it must await this or it would read a stale/empty cache -- which used to make
    // it push stale values back over newer ones set from the panel.
    api.ready = api.init();
    self.MephistoConfig = api;
})();
