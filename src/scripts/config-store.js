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
    let initP = null;   // the one in-flight/finished load, see init()
    // chrome.storage.local was read into CACHE. From then on a key missing from CACHE is a key that
    // does not exist: the localStorage mirror in an extension page is not told when a content script
    // removes a key (lsRemove is a no-op there), so falling back to it brought back a Budget memo
    // the panel had already removed, and the next engine switch in Settings reset Budget to Time
    // (audit 3.1.329 SYS-5). The fallback stays for the window before that read, and for a page
    // where chrome.storage cannot be read at all.
    let loaded = false;

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
            if (loaded) return null;
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
        // two can't drift apart. Half the cores leaves room for the browser/OS and the page being
        // scraped. Clamped to the sliders' 1..24; hardwareConcurrency is undefined in some contexts,
        // so fall back to the old fixed default of 4.
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

        // ARROW PALETTES. `arrow_palette` picks which colours the arrows wear: the shipped ones, this
        // colour-blind set, or the per-family colours in the arrow_color_* keys. Those keys are kept
        // whichever palette is picked, so leaving Custom and coming back restores them. The table is
        // here because both the panel (which draws) and the Appearance page read it.
        //
        // ONE CLICK FOR A PALETTE THAT SURVIVES COLOUR BLINDNESS. The shipped defaults lean on
        // red/green separation, which is exactly the pair deuteranopia and protanopia collapse --
        // and the arrows are the whole interface here, so "which line is that" stops being
        // answerable. These are Okabe-Ito, the standard eight-hue set chosen to stay distinct under
        // every common form; the families past the eighth take neutrals, since there are more arrow
        // families than there are hues that survive.
        // fifteen families -- the eight Okabe-Ito colours (black is one), three greys and four dark
        // or saturated extras. Every family gets its OWN colour: tablebase used to repeat line 3's
        // orange and refutation the threat's vermillion, and each of those pairs is drawn together
        // (audit 3.1.331 APPEARANCE-1). The new ones were picked by worst CIELAB distance under
        // simulated deutan, protan and tritan vision (Machado 2009): violet tablebase >= 33 from
        // every other family, dark-red refutation >= 31, and forced-theirs moved off human reply's
        // grey (5 -> 23).
        ARROW_PALETTES: ['default', 'colorblind', 'custom'],
        // LIGHT, DARK OR SYSTEM (theme). System follows prefers-color-scheme, and every reader
        // (options.js for the settings, review and analysis pages; popup.js for the panel) re-applies
        // on its change, so it updates live. No key stored is System. Before the one-time migration
        // below has run, a stored dark_mode still says dark, so an existing dark install does not
        // flash light on its first load.
        THEMES: ['light', 'dark', 'system'],
        theme() {
            let v = null;
            try { v = JSON.parse(this.get('theme') ?? 'null'); } catch (e) { /* corrupt -> system */ }
            if (this.THEMES.includes(v)) return v;
            try { if (JSON.parse(this.get('dark_mode') ?? 'false') === true) return 'dark'; } catch (e) { /* corrupt */ }
            return 'system';
        },
        themeIsDark(theme = this.theme()) {
            if (theme === 'dark') return true;
            if (theme !== 'system') return false;
            try { return !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
        },
        ARROW_COLORBLIND: {
            arrow_color_line1: '#0072b2', arrow_color_line2: '#009e73', arrow_color_line3: '#e69f00',
            arrow_color_line4: '#56b4e9', arrow_color_line5: '#cc79a7',
            arrow_color_forced_ours: '#f0e442', arrow_color_forced_theirs: '#bbbbbb',
            arrow_color_pv_walk: '#5a5a5a', arrow_color_threat: '#d55e00',
            arrow_color_book: '#000000', arrow_color_human_reply: '#7f7f7f',
            arrow_color_safety_net: '#004c6d', arrow_color_tb: '#9900ff',
            arrow_color_refute: '#772200', arrow_color_human_error: '#332288',
        },
        // Default hotkeys (action -> key-combo), shared by the keydown listener (content script), the
        // rebind UI (options page), and the panel's "(A)" label hints -- ONE source so they can't drift.
        // Single letters: they fire only when you're not typing in a field, and our capture-phase
        // listener preventDefaults them so the site's own letter shortcut doesn't also run.
        HOTKEY_DEFAULTS: {
            manual_play: ' ',
            manual_mode: 'n', autoplay: 'a', premove: 'p', help_mode: 'h', humanize: 'u',
            clock_mode: 'c', mirror_mode: 'm', eval_bar: 'e', eval_history: 'y', live_stats: 'l', tablebase: 't', puzzle_mode: 'z',
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
            // WALKING THE ENGINE'S LINE. Unbound by default: the arrow keys suit it, but both chess
            // sites use them for their own move navigation, so they stay the site's until you bind
            // them. An unbound key is the off state; this replaced the Walk With Arrow Keys switch
            // (see __pv_keys_hotkeys in loadOnce).
            pv_back: '', pv_forward: '',
            // The cheat sheet. '?' is where every web app with shortcuts (GitHub, Gmail, lichess
            // itself) puts its list, so it is the first key anyone tries. It is typed with Shift on
            // every layout, which is why hotkeyString drops Shift for symbols (see canonHotkey).
            shortcuts: '?',
            // CUSTOM TOGGLES: two keys that each flip ONE on/off setting of your choosing (which one
            // lives in config `hotkey_custom`, see hotkeyCustom). Unbound by default -- no letter is
            // taken from anyone until you pick one.
            custom_1: '', custom_2: '',
        },
        // What each action is called, wherever a person reads the list: the Hotkeys settings rows,
        // the macro step pickers and the panel's cheat sheet. Here, beside the defaults, because
        // three places reading one list cannot disagree about what "u" does. This is the English;
        // each reader translates it through hk.<action> in the locale files.
        HOTKEY_LABELS: {
            manual_play: 'Play move (Manual Mode)', manual_mode: 'Toggle Manual Mode', autoplay: 'Toggle Autoplay',
            premove: 'Toggle Premove', explorer: 'Toggle Explorer', book_play: 'Toggle Book Moves',
            help_mode: 'Toggle Help Mode', humanize: 'Toggle Humanize', clock_mode: 'Toggle Clock Mode',
            mirror_mode: 'Toggle Mirror Time', eval_bar: 'Toggle Eval Bar',
            eval_history: 'Toggle Eval History', live_stats: 'Toggle Live Stats',
            tablebase: 'Toggle Tablebase', puzzle_mode: 'Toggle Puzzle Mode',
            copy_fen: 'Copy FEN', copy_pgn: 'Copy PGN', copy_diagnostics: 'Copy Diagnostics',
            redetect: 'Re-detect game', compact: 'Compact view', minimize: 'Minimize / restore panel',
            bot_trick: 'Bot Tricks - play the chosen game at a bot',
            panic: 'Panic - hide the panel, stop the engine',
            pv_back: 'Walk the line back', pv_forward: 'Walk the line forward',
            shortcuts: 'Show shortcuts',
            custom_1: 'Custom 1 - toggle a setting', custom_2: 'Custom 2 - toggle a setting',
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
        // canonical combo string for a keydown: "Alt+a", "Ctrl+Shift+k", " " (space), "ArrowUp", "?".
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
            // A NEW ACTION NEVER TAKES A KEY YOU ALREADY USE. The rebind UI saves every action that
            // existed at the time, so an action missing from `saved` arrived in a later version. If
            // its default letter is already one of your saved keys or a macro key, it starts
            // unbound: the listener acts on the first match only, so giving it the letter made one
            // of the two dead (Panic rebound to W went silent once Bot Tricks shipped on W;
            // audit 3.1.331 CONFIGSTORE-1).
            const taken = new Set(this.hotkeyMacros().map(m => m.key));
            for (const a in this.HOTKEY_DEFAULTS) if (Object.hasOwn(saved, a)) taken.add(out[a]);
            taken.delete('');
            for (const a in this.HOTKEY_DEFAULTS) if (!Object.hasOwn(saved, a) && taken.has(out[a])) out[a] = '';
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
        // CUSTOM TOGGLES. Config `hotkey_custom` = [{setting, label, def}, ...], one per HOTKEY_CUSTOM
        // action: the on/off setting the key flips, its name as the Settings page showed it (so the
        // panel can say what it did without a copy of every label), and the setting's default (so the
        // first press of a setting never saved flips it from what it really is). Sanitized on every
        // read like the macros; an unassigned slot is {setting: ''} and its key does nothing.
        HOTKEY_CUSTOM: ['custom_1', 'custom_2'],
        // On/off settings whose switch was removed. A custom slot left on one would still eat its key
        // and flip (or reload the panel for) a value nothing reads, while the Settings picker, which
        // has no option for it, shows the slot as unassigned. Refusing them here covers every
        // removal at once; the one-time migrations in loadOnce only cleared the PV keys, Pace to
        // Clock, Contempt and Dark Mode slots, never Board Animation or Mistakes Where People Make Them.
        // Add a name here whenever a switch is removed (audit 3.1.335 CONFIG-1).
        RETIRED_SETTINGS: ['board_animation', 'clock_pace', 'contempt', 'dark_mode', 'humanize_maia_where', 'pv_keys'],
        hotkeyCustom() {
            let saved;
            try { saved = JSON.parse(this.get('hotkey_custom')); } catch (e) { /* unset/corrupt */ }
            const arr = Array.isArray(saved) ? saved : [];
            return this.HOTKEY_CUSTOM.map((_, i) => {
                const c = arr[i];
                const ok = c && typeof c.setting === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(c.setting)
                    && c.setting !== 'hotkeys' && c.setting !== 'hotkey_macros' && c.setting !== 'hotkey_custom'
                    && !this.RETIRED_SETTINGS.includes(c.setting);
                return ok ? {setting: c.setting, label: String(c.label || c.setting).slice(0, 80), def: c.def === true}
                          : {setting: '', label: '', def: false};
            });
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
                // never overwrite the memo with 'depth', so switching between two depth-only engines
                // cannot lose what the user actually had. Any other budget is the user's latest
                // choice, so it replaces an older memo.
                if (current !== 'depth') {
                    this.set(this.BUDGET_MEMO_KEY, JSON.stringify(current));
                }
                this.set('search_mode', JSON.stringify('depth'));
                return 'depth';
            }
            const memo = this.get(this.BUDGET_MEMO_KEY);
            if (!memo) return current;               // we never changed it; leave the user's choice alone
            // The memo only stands for the Depth WE set. A budget that is no longer Depth was chosen
            // after that, so it stays and the memo goes: restoring the memo would bring back an old
            // Time budget out of nowhere on the next engine switch (audit 3.1.331 CONFIGSTORE-2).
            if (current !== 'depth') { this.remove(this.BUDGET_MEMO_KEY); return current; }
            let restored = 'time';
            try { restored = JSON.parse(memo) || 'time'; } catch (e) { /* corrupt memo -> time */ }
            this.remove(this.BUDGET_MEMO_KEY);
            this.set('search_mode', JSON.stringify(restored));
            return restored;
        },

        // load chrome.storage into the cache once; one-time migrate the old localStorage config in.
        // ONE LOAD, HOWEVER MANY CALLERS. The file starts a load itself (api.ready below) and
        // popup.js calls init() again; `ready` only stops a call made after the first has finished,
        // so a second call during the first read took its own, older snapshot and wrote it back
        // over the first one's migration writes, and the panel booted on the pre-migration
        // engine (audit 3.1.331 CONFIGSTORE-3). Every caller now shares the first load.
        init() {
            return initP || (initP = api.loadOnce());
        },
        async loadOnce() {
            if (ready) return;
            let all = {}, read = false;
            try { all = await chrome.storage.local.get(null); read = true; } catch (e) { all = {}; }
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
            loaded = read;   // only once CACHE holds what was read: the migration above awaits
            // ONE MAIA ENTRY, ONE RATING (3.1.322). Maia-1's bands are covered by Maia-3's live rating,
            // and Maia-2 is Maia-3's rating plus the opponent's. A Maia-1 selection moves to Maia-3 at
            // its band, and a Maia-2 one keeps its own rating as the shared one -- once, here.
            try {
                if (!CACHE.__maia_merged) {
                    const saved = JSON.parse(CACHE['engine'] ?? 'null');
                    if (saved === 'maia') {
                        const band = parseInt(JSON.parse(CACHE['maia_level'] ?? '"1500"')) || 1500;
                        api.set('maia3_elo', JSON.stringify(band));
                        api.set('engine', JSON.stringify('maia3'));
                    } else if (saved === 'maia2') {
                        const self = parseInt(JSON.parse(CACHE['maia2_self_elo'] ?? '1500')) || 1500;
                        api.set('maia3_elo', JSON.stringify(self));
                    }
                    api.set('__maia_merged', '1');
                }
            } catch (e) { /* corrupt -> the panel's defaults decide */ }
            // ERR LIKE YOUR RATING BECAME THE DEFAULT (3.1.323). It replaces the move-mix shares, so whoever
            // had tuned them (the options page stores a share only when it is edited) keeps their mix:
            // their Err Like Your Rating is set off -- once, here, and never over a choice already made.
            try {
                if (!CACHE.__match_default) {
                    const MIX = ['humanize_top', 'humanize_second', 'humanize_third', 'humanize_fourth',
                        'humanize_inaccuracy', 'humanize_mistake', 'humanize_blunder'];
                    if (CACHE['humanize_match'] === undefined && MIX.some(k => CACHE[k] !== undefined)) {
                        api.set('humanize_match', JSON.stringify(false));
                    }
                    api.set('__match_default', '1');
                }
            } catch (e) { /* corrupt -> the default decides */ }
            // WALK WITH ARROW KEYS BECAME TWO ORDINARY HOTKEYS. The switch gated two keys that were
            // always bound; now an unbound key is off. Whoever had it on keeps the arrow keys (or their
            // own rebinding of them); whoever had it off gets both cleared, because the rebind UI saves
            // every action and their saved ArrowLeft/ArrowRight would otherwise start firing. A custom
            // toggle that flipped the retired switch is unassigned. Once, here.
            try {
                if (!CACHE.__pv_keys_hotkeys) {
                    const on = JSON.parse(CACHE['pv_keys'] ?? 'false') === true;
                    let saved = {};
                    try { saved = JSON.parse(CACHE['hotkeys'] ?? '{}'); } catch (e) { /* corrupt */ }
                    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
                    const before = JSON.stringify(saved);
                    for (const [a, k] of [['pv_back', 'ArrowLeft'], ['pv_forward', 'ArrowRight']]) {
                        if (on && !Object.hasOwn(saved, a)) saved[a] = k;
                        else if (!on && Object.hasOwn(saved, a)) saved[a] = '';
                    }
                    if (JSON.stringify(saved) !== before) api.set('hotkeys', JSON.stringify(saved));
                    let custom = null;
                    try { custom = JSON.parse(CACHE['hotkey_custom'] ?? 'null'); } catch (e) { /* corrupt */ }
                    if (Array.isArray(custom) && custom.some(c => c && c.setting === 'pv_keys')) {
                        api.set('hotkey_custom', JSON.stringify(custom.map(c => (c && c.setting === 'pv_keys') ? {setting: ''} : c)));
                    }
                    api.set('__pv_keys_hotkeys', '1');
                }
            } catch (e) { /* corrupt -> the defaults decide: both unbound */ }
            // PACE TO CLOCK IS ALWAYS ON (clock_pace_timing). Its switch and its hotkey are gone: the
            // rebind UI saves every action, so a saved clock_pace binding would keep holding its key ('k'
            // by default) for an action nothing performs, and a custom toggle on it would flip a setting
            // nothing reads. Both are dropped, once, here.
            try {
                if (!CACHE.__clock_pace_retired) {
                    let saved = null;
                    try { saved = JSON.parse(CACHE['hotkeys'] ?? 'null'); } catch (e) { /* corrupt */ }
                    if (saved && typeof saved === 'object' && !Array.isArray(saved) && Object.hasOwn(saved, 'clock_pace')) {
                        delete saved.clock_pace;
                        api.set('hotkeys', JSON.stringify(saved));
                    }
                    let custom = null;
                    try { custom = JSON.parse(CACHE['hotkey_custom'] ?? 'null'); } catch (e) { /* corrupt */ }
                    if (Array.isArray(custom) && custom.some(c => c && c.setting === 'clock_pace')) {
                        api.set('hotkey_custom', JSON.stringify(custom.map(c => (c && c.setting === 'clock_pace') ? {setting: ''} : c)));
                    }
                    api.set('__clock_pace_retired', '1');
                }
            } catch (e) { /* corrupt -> nothing to drop */ }
            // THE VARIANCES ARE FOLDED INTO THEIR TIMES (owner call). A move now draws Think Time + up to
            // Think Time again (popup fresh_timing), so a time and its variance become ONE number that
            // keeps the old average: base + variance/2 = 1.5 * new. Absent keys are their defaults (think
            // 0 +0, move 400 +400, the latter unchanged). Base and flag go in ONE write, so another
            // context loading at the same moment sees either the old pair or the new number with its flag,
            // never the new number without it (which would fold it a second time). Skipped when storage
            // could not be read: an empty cache would only set the flag. An imported settings file from
            // before carries no flag, so the import clears it and the reload folds that file's values.
            try {
                if (loaded && !CACHE.__variance_folded) {
                    const num = (k, d) => {
                        let v = d;
                        try { v = Number(JSON.parse(CACHE[k] ?? 'null') ?? d); } catch (e) { /* corrupt -> default */ }
                        return Number.isFinite(v) && v >= 0 ? v : d;
                    };
                    const write = {__variance_folded: '1'};
                    for (const [base, vari, d0, d1] of [['think_time', 'think_variance', 0, 0], ['move_time', 'move_variance', 400, 400]]) {
                        if (!(base in CACHE) && !(vari in CACHE)) continue;
                        write[base] = JSON.stringify(Math.round((num(base, d0) + num(vari, d1) / 2) / 1.5));
                    }
                    Object.assign(CACHE, write);
                    try { chrome.storage.local.set(write); } catch (e) { /* cache still set */ }
                    for (const [k, v] of Object.entries(write)) lsSet(k, v);
                    for (const k of ['think_variance', 'move_variance']) if (k in CACHE) api.remove(k);
                }
            } catch (e) { /* corrupt -> the times stay as stored */ }
            // ARROW PALETTE (arrow_palette). The colour-blind button used to write its colours into the
            // fifteen arrow_color_* keys, so a stored set is read once, here: all fifteen equal to the
            // colour-blind table is that palette, any other stored colour is Custom (every value kept),
            // nothing stored is the default and needs no key.
            try {
                if (loaded && !CACHE.__arrow_palette) {
                    const write = {__arrow_palette: '1'};
                    if (!('arrow_palette' in CACHE)) {
                        const keys = Object.keys(api.ARROW_COLORBLIND);
                        const val = (k) => { try { return String(JSON.parse(CACHE[k] ?? '""') || '').toLowerCase(); } catch (e) { return ''; } };
                        if (keys.every(k => val(k) === api.ARROW_COLORBLIND[k])) write.arrow_palette = JSON.stringify('colorblind');
                        else if (keys.some(k => val(k))) write.arrow_palette = JSON.stringify('custom');
                    }
                    Object.assign(CACHE, write);
                    try { chrome.storage.local.set(write); } catch (e) { /* cache still set */ }
                    for (const [k, v] of Object.entries(write)) lsSet(k, v);
                }
            } catch (e) { /* corrupt -> the default palette */ }
            // PLAY FOR THE WIN IS THE FIGHTER PLAYSTYLE (owner call): its switch and its centipawn dial
            // are gone, and Fighter applies a fixed 30cp. The switch on with Balanced (or no style stored)
            // becomes Fighter. On beside another style, that style stays: one style at a time, and the one
            // picked by name wins. Both keys are dropped, and a custom hotkey on the switch is unassigned,
            // or it would flip a setting nothing reads.
            try {
                if (loaded && !CACHE.__contempt_fighter) {
                    const write = {__contempt_fighter: '1'};
                    let on = false, style = 'balanced';
                    try { on = JSON.parse(CACHE['contempt'] ?? 'false') === true; } catch (e) { /* corrupt -> off */ }
                    try { style = JSON.parse(CACHE['playstyle'] ?? '"balanced"'); } catch (e) { /* corrupt -> balanced */ }
                    if (on && (!style || style === 'balanced')) write.playstyle = JSON.stringify('fighter');
                    let custom = null;
                    try { custom = JSON.parse(CACHE['hotkey_custom'] ?? 'null'); } catch (e) { /* corrupt */ }
                    if (Array.isArray(custom) && custom.some(c => c && c.setting === 'contempt')) {
                        write.hotkey_custom = JSON.stringify(custom.map(c => (c && c.setting === 'contempt') ? {setting: ''} : c));
                    }
                    Object.assign(CACHE, write);
                    try { chrome.storage.local.set(write); } catch (e) { /* cache still set */ }
                    for (const [k, v] of Object.entries(write)) lsSet(k, v);
                    for (const k of ['contempt', 'contempt_cp']) if (k in CACHE) api.remove(k);
                }
            } catch (e) { /* corrupt -> the style stays as stored */ }
            // DARK MODE IS THE THEME SELECT (owner call): Light, Dark or System. A stored dark_mode true is
            // Dark; false or nothing stored is Light, which is what that install has been showing. A fresh
            // install gets System, written by the service worker's onInstalled, so a theme already stored
            // is left alone. The old key is dropped, and a custom hotkey on it is unassigned.
            try {
                if (loaded && !CACHE.__theme) {
                    const write = {__theme: '1'};
                    if (!('theme' in CACHE)) {
                        let dark = false;
                        try { dark = JSON.parse(CACHE['dark_mode'] ?? 'false') === true; } catch (e) { /* corrupt -> light */ }
                        write.theme = JSON.stringify(dark ? 'dark' : 'light');
                    }
                    let custom = null;
                    try { custom = JSON.parse(CACHE['hotkey_custom'] ?? 'null'); } catch (e) { /* corrupt */ }
                    if (Array.isArray(custom) && custom.some(c => c && c.setting === 'dark_mode')) {
                        write.hotkey_custom = JSON.stringify(custom.map(c => (c && c.setting === 'dark_mode') ? {setting: ''} : c));
                    }
                    Object.assign(CACHE, write);
                    try { chrome.storage.local.set(write); } catch (e) { /* cache still set */ }
                    for (const [k, v] of Object.entries(write)) lsSet(k, v);
                    if ('dark_mode' in CACHE) api.remove('dark_mode');
                }
            } catch (e) { /* corrupt -> System until the next load */ }
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
