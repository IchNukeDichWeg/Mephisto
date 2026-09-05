// Loaded as a CLASSIC script in two places: the popup PAGE (toolbar popup) and, once the panel
// moves in-page, the content-script isolated world. It can't be an ES module (content scripts
// aren't) and must not be dynamic-imported (that needs web_accessible_resources and leaks the
// extension id via Resource Timing -- issue #35 §3.4). IIFE-wrapped so its globals (config,
// engine, board, ...) can't collide with content-script.js's in the shared isolated world.
(function () {

// the tab this popup iframe was injected into (passed by the content-script). Everything this popup
// sends/receives is scoped to THIS tab, so a background tab's popup can't drive the foreground tab
// or turn on its modes. Null only if opened before the content-script learned its id (falls back).
let MY_TAB_ID = parseInt(new URLSearchParams(location.search).get('tab'), 10) || null;
let engine_init_promise = null; // boot fires engine init without blocking the panel (see boot)
let PANEL_BOOTED = false; // popup.js also loads on every chess page as a content script --
// its listeners must stay inert until THIS tab's panel is actually opened.

// When shown as the toolbar POPUP (Panel Style = "popup") this page is top-level; when shown as the
// floating panel it's an iframe the content-script scales down itself. Only the top-level toolbar
// popup renders at full 568x672, so shrink just that one (CSP blocks an inline <head> script, so we
// tag it here - a brief flash as the popup opens is fine). The floating iframe is left untouched.
if (location.protocol === 'chrome-extension:' && window.top === window.self) {
    document.documentElement.classList.add('toolbar-popup'); // real toolbar popup only, never the host page
}

// Where the panel's own DOM lives. It's `document` while the panel is an iframe (and the toolbar
// popup); Phase 4c repoints PANEL_ROOT at the closed shadow root when the panel moves in-page, and
// the panel's element lookups go through it. (Global page listeners -- pointerdown/visibilitychange
// for keep-alive -- stay on `document`.)
// popup.js runs in two contexts. As a CONTENT SCRIPT (panel in-page) chrome.tabs doesn't exist and
// runtime.sendMessage can't reach content-script.js -- but it shares our realm, so we call it
// directly. As the toolbar popup it's a real extension page and must use tabs messaging.
const IS_CONTENT_SCRIPT = (location.protocol !== 'chrome-extension:');
let PANEL_MSG_HANDLER = null; // content-script -> panel, invoked directly when in-page
let PANEL_ROOT = document;
const BOARD_THEMES = ['brown','red','orange','tan','green','sky','blue','purple','grey','wood','marble','newspaper'];
let PANEL_ASSETS = null; // {pieces:{wP:dataURI,...}} when the panel is in-page
let PANEL_TIP_HOST = document.body || document.documentElement;

let engine;
let board;
let fen_cache;
let config;

// Warm-engine tracking so a closed-then-reopened panel skips the expensive engine re-init (net
// reload). popup.js module state -- including the offscreen engine keyed by ENGINE_CLIENT -- survives
// panel close (only the DOM is torn down), so a reopen can reuse the loaded engine instead of
// disposing and reloading its NNUE. Reset on engine crash (initialize_engine reruns) and naturally
// on tab close (the whole context dies).
let engine_ready = false;
let last_init_engine = null;
let last_init_variant = null;
let last_init_maia = null; // Maia rating at last init; a change loads a different net (part of net identity)
let last_init_fp = null; // fingerprint of the engine-affecting config at last init; unchanged => skip setup

let turn_override = null;      // header king switch: 'w'|'b' forced side to move, or null (auto). Transient.
let turn_detected_prev = null; // last RAW detected side; when it changes, the override auto-clears.

// Swap a FEN's side-to-move (and drop the now-invalid en-passant square). Used by the manual turn
// override to hand the move to the other side.
function flip_fen_turn(fen) {
    const p = fen.split(' ');
    p[1] = (p[1] === 'w') ? 'b' : 'w';
    if (p.length > 3) p[3] = '-';
    return p.join(' ');
}

let is_calculating = false;
// UI language. `i18n(key, english, vars)` -- the English is written at the call site so the source
// still reads as English prose and a missing key can never render blank.
const i18n = (key, dflt, vars) => {
    // NEVER throws. This runs on the scrape/response path as well as on labels, so when i18n.js was
    // missing from the toolbar popup the first lookup took initPanel down and every later response
    // with it -- one absent script tag presenting as a dead scraper. English is always a usable
    // answer, so fall back to the call site's own text rather than propagating.
    try { return MephistoI18n.t(key, dflt, vars); } catch (e) {
        return vars ? String(dflt).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : dflt;
    }
};

// Background-play tracing from the PANEL side, to the service worker's own console -- see bgLog in
// the content-script for why not this page's. Silent while the tab is active. Without this half, a
// silent log is ambiguous: "the panel never issued a move" and "the content-script dropped it" look
// identical from the other end.
function bgTrace(...args) {
    try {
        // VERBOSE LOGGING WINS, exactly as it does for the content-script's bgLog. The gate below is
        // the right default -- ordinary play should not fill the worker console -- but it is silent
        // precisely when someone is sitting there watching the panel fail to move, so every
        // diagnostics report of "it just stops" arrived with the panel's half of the story missing
        // and only the content-script's lines in it. That ambiguity is the entire reason both halves
        // exist. Same lesson as the four-player traces, in the other half of the codebase.
        if (!(config && config.verbose_log)
            && document.visibilityState === 'visible' && document.hasFocus()) return;
        chrome.runtime.sendMessage({bgTrace: {from: 'panel', args: args.map((v) => {
            if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
            try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
        })}}, () => void chrome.runtime.lastError);
    } catch (e) { /* extension context gone */ }
}

// The panel cannot read the locale files itself: it runs in the page's isolated world, where a fetch
// of a chrome-extension:// URL is blocked (web_accessible_resources is deliberately empty). The
// service worker reads them and sends both the chosen language and English underneath it.
function load_language(lang) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({i18nStrings: {lang}}, (res) => {
                if (!chrome.runtime.lastError && res && !res.error) {
                    MephistoI18n.setFallback(res.en || res.strings);
                    MephistoI18n.setStrings(lang, res.strings || res.en);
                }
                resolve();
            });
        } catch (e) {
            resolve(); // extension context gone -- English, which is what the markup already says
        }
    });
}

// Re-translate the panel in place. Cheap (it walks the panel's own small DOM) and it is the only
// thing a language change needs, since every string in the markup carries its key.
function apply_language() {
    MephistoI18n.apply(PANEL_ROOT);
    annotate_hotkey_labels(); // the "(A)" suffixes are appended to label text -- redo them after
    update_best_move(null);   // re-render the readout with the new confidence/tablebase suffixes
}

let pending_stops = 0; // bestmoves still owed by searches we abandoned -- drop that many (see abandon_search)
// WHY THIS IS IN THE DIAGNOSTICS. "It stopped evaluating" has exactly one shape from outside -- the
// progress bar with the PREVIOUS search's numbers under it -- and three causes needing different
// fixes: nothing was asked of the engine, the engine was asked and is silent, or it is answering
// and every frame is being dropped because a stop is still owed. Three values, none of them visible
// anywhere, and no report could tell them apart.
let last_info_at = 0;   // when an engine frame last reached us (0 = never this session)
let stop_charged_at = 0; // when the oldest outstanding stop was charged (see STOP_FLUSH_MS)
// A `stop` only yields a bestmove if a search was actually running. When it is not -- the previous
// search had just ended, or the engine had nothing in flight -- the flush never comes, and a debt
// that can only be paid by that flush is permanent: every frame after it is dropped and the panel
// freezes on the progress bar with the last search's numbers under it, for the rest of the session.
// MEASURED, not theorised: toggling Autoplay mid-game took it to owed=1 with no engine frame
// arriving again (11s, 21s, ...), and each further toggle added another. Give the debt a deadline.
// Letting a genuinely late bestmove through afterwards is safe by construction: every path that
// PLAYS one re-checks the position it was computed for (see boardStillMatchesAnalysis).
const STOP_FLUSH_MS = 1500;
let last_go = '';       // the search actually issued -- `go infinite` never ends on its own
function search_state() {
    const heard = last_info_at ? `${Date.now() - last_info_at}ms ago` : 'NEVER';
    return `${search_active ? 'active' : 'idle'} owed=${pending_stops} last-frame=${heard} go=${last_go || 'none'}`;
}
// Remote/native supersession. `pending_stops` only protects the WASM path -- on_engine_response
// returns early for is_remote(), so a request issued for an OLD position used to be acted on
// whenever it resolved late, playing a move computed for a position that is no longer on the board.
// Every remote analysis carries the generation it was issued in; a resolved response from an older
// generation is dropped. Bumped when a new analysis is issued and when a search is abandoned.
let remote_gen = 0;
// The position an analyse is currently OUT for on a native host. The panel supersedes results
// client-side, but nothing cancels the abandoned search at the host -- `send_engine_uci('stop')` is
// a no-op for native engines -- so a duplicate push for the SAME position issues a second search
// that queues behind the first. The panel then drops the first as superseded and waits on a second
// the host has not begun. Observed as two identical `on_new_pos` lines, one "dropping a superseded
// remote result", and then silence. One request per position fixes it at the source.
// The longest a NATIVE analyse may run. An abandoned one keeps going at the host (see the note where
// this is applied), so this is the ceiling on how long a dead search can block the live one.
const NATIVE_MAX_RT = 8000;
let native_inflight = null;
// Has a native host actually answered this session? The health check needs the difference between
// "a native engine is selected" and "a native engine is talking to us" -- an installer that was
// never run looks exactly like the former and is the commonest cause of a silent panel.
let native_alive = false;
let search_active = false; // a 'go' was issued whose bestmove hasn't arrived yet (is_calculating can't be
                           // used for this: it flips false on the first info line, not on bestmove)
let last_pos = {startFen: null, moves: ''}; // the position's own start + UCI move list, for Copy PGN
let premove_tracker = {fen: '', lines: {}}; // per-multipv reply stability while the opponent thinks
let search_threads_set = null; // last Threads value pushed to the engine; opponent-turn search is capped unless Pondering
let search_multipv_set = null; // last MultiPV pushed to the WASM engine, so an unchanged width is not re-sent
let remote_multipv_set = null; // last MultiPV pushed to a NATIVE host (it stores options; the analyse request has none)
let premove_lines = 2; // top-N lines premove tracks/certifies; widened to the ponder width while pondering (see ponder_line_count)
let prog = 0;
let last_eval = {fen: '', activeLines: 0, lines: []};
let detected_prefix = null; // which site the last scrape came from ('li'/'cc'/'bt'/'tt')
let last_clocks = null;   // {mine, theirs, increment, at} scraped off the page (Clock Mode)
let last_our_eval = null; // our-perspective cp after our previous move (humanize criticality)
let opp_clock_mark = null; // opponent's clock when their turn started...
let opp_spend = null;      // ...so their spend on their LAST move = mark - now (Clock Mode mirroring)
let prev_ply_count = 0;    // plies in the last-seen position; a drop back to the start = a NEW GAME

// Maia's strength IS the net (a rating-conditioned one for maia3), so UCI_Elo means nothing to it
// and the Elo row is hidden rather than shown doing nothing. Its nets are standard-chess only, so
// Chess960 is off the table too.
// NETS THAT ANSWER IN ONE FORWARD PASS. No search, so no depth to wait for, no Threads option to
// set, nothing to ponder with, and no second-guessing their single answer. Listed once because the
// same pair of comparisons was written out in five places, and the sixth net would have missed one.
const ONE_PASS_ENGINES = ['maia', 'maia2', 'maia3', 'elite-leela'];
const is_one_pass = (eng) => ONE_PASS_ENGINES.includes(eng === undefined ? config.engine : eng);
const NO_CHESS960_ENGINES = [...ONE_PASS_ENGINES];
// maia strength = net choice; tetrarch speaks its own four-player protocol and has no UCI_Elo, so
// the slider was purely decorative there -- it advertised a strength cap that nothing applied.
// Must match UPDATE_REPO in background-script.js; the ladder asserts they agree. Was written out
// three times, which is two chances for a fork to be pointed at the wrong releases page.
const UPDATE_REPO_SLUG = 'IchNukeDichWeg/Mephisto';
const NO_ELO_ENGINES = [...ONE_PASS_ENGINES, 'tetrarch-native'];

// engines that speak native messaging (Chrome auto-launches the host, no server -- see
// native-host/install-native.sh). The port name == the engine value (see NATIVE_HOSTS).
// The engine the panel asked for, and the net that actually answered. Two different facts: a dev
// build running last month's net is not the engine you think you are running, and nothing else in
// the panel would tell you. Blank until the engine says so -- inventing a name here would be worse
// than the row being honest about knowing nothing yet.
let engine_net_seen = '';
function update_engine_id() {
    const el = PANEL_ROOT?.getElementById?.('qs_engine_id');
    if (!el) return;
    el.textContent = engine_net_seen ? `${config.engine} - ${engine_net_seen}` : config.engine;
    el.title = el.textContent;
}

const NATIVE_ENGINES = ['sf-native', 'fairy-native', 'tetrarch-native'];
// Cloud evaluation: a real Stockfish, on someone else's machine, reached over HTTPS. THE POSITION
// LEAVES THIS MACHINE -- that is the cost, and it is why these are named "cloud" everywhere they
// appear. A native host is both faster and private, so this is the fallback for a machine that
// cannot run a strong engine locally. They ride the REMOTE path (no WASM to load, no host to
// launch); the fetch itself happens in the service worker (see CLOUD_PROVIDERS there).
const CLOUD_ENGINES = ['cloud-chessapi', 'cloud-stockfish-online'];
// FOUR-PLAYER. Tetrarch plays 14x14 4PC, which chess.js cannot represent at all -- so this
// engine does NOT ride the normal pipeline: no chess.js legality, no premove, no arrows. It is
// offered only on chess.com's 4PC pages and drives the bypass lane (see FOURPC_SITES).
const FOURPC_ENGINES = ['tetrarch-native'];
// What to fall back to when leaving 4PC with no remembered engine -- bundled, needs no native host,
// and plays standard chess, which is the whole point of the fallback.
const FOURPC_FALLBACK_ENGINE = 'stockfish-18-nnue';
// native engines that ARE full Fairy-Stockfish -> offer the whole variant list, like the WASM Fairy
const FAIRY_ENGINES = ['fairy-stockfish-14-nnue', 'fairy-native'];

// The variants our bundled chess.js can actually REPLAY. The dropdown offers four more (Duck,
// Minihouse, Seirawan, Chaturanga) because Fairy ships nets for them and the engine can evaluate
// them -- but chess.js can't, and `new Chess(<unknown variant>)` does NOT throw: it silently falls
// back to the standard start position (see its constructor -> _getDefaultStartingPosition). So the
// scrape would be replayed as an ordinary game and analysed as the wrong position entirely, with
// nothing on screen to say so. `set_detection_status` turns that silence into a plain message.
const CHESSJS_VARIANTS = ['chess', 'fischerandom', 'crazyhouse', 'kingofthehill', '3check',
                          'antichess', 'atomic', 'horde', 'racingkings'];

// UCI_Elo [min, max] per engine, taken from each engine's own source (out-of-range values are
// silently ignored by Stockfish, so the slider must stay within these): modern SF uses
// Skill::LowestElo/HighestElo = 1320/3190; SF 11 = 1350/2850; Fairy-SF 14 = 500/2850.
const ELO_RANGE = {
    'stockfish-19-nnue': [1320, 3190],
    'stockfish-19-small-nnue': [1320, 3190],
    'stockfish-18-nnue': [1320, 3190],
    'stockfish-11-hce': [1350, 2850],
    'fairy-stockfish-14-nnue': [500, 2850],
    // full-power native engines (real Stockfish/Fairy -> same UCI_Elo ranges)
    'sf-dev-native': [1320, 3190],
    'sf18-native': [1320, 3190],
    'sf11-native': [1350, 2850],
    'fairy-native': [500, 2850],
    'remote': [1320, 3190], // unknown engine; assume the modern SF range
};
// Sits above every engine's ceiling (max is 3190), so it reads as "no cap / full strength".
// Both slider ends map to full strength: 0 on the left (Off) and this on the right.
const FULL_STRENGTH_ELO = 3200;
// Slider stops: index 0 = 0 (Off / full strength), then the engine's range in 50-Elo steps with
// the true max always included, and FULL_STRENGTH_ELO as the final right-hand "3200+" stop.
function elo_stops(engine) {
    const [min, max] = ELO_RANGE[engine] || [1320, 3190];
    const stops = [0];
    for (let e = min; e < max; e += 50) stops.push(e);
    stops.push(max);
    stops.push(FULL_STRENGTH_ELO);
    return stops;
}

let turn = ''; // 'w' | 'b'

// --- Background keep-alive --------------------------------------------------------------------
// Chrome throttles timers in a hidden tab and freezes it after ~5 min, so alt-tabbing to another
// app (or a fullscreen window) mid-game would stall autoplay. A tab that is playing audio is exempt
// from both, so while Autoplay is on we run a single inaudible tone. Browsers require a user gesture
// to start audio, so this is (re)started from the popup's own clicks and on visibility changes
// (once the user has interacted, sticky activation lets resume() work even after tabbing away).
let keep_alive_ctx = null;
// STICKY ACTIVATION. Browsers refuse to start audio before the user has interacted with the page, but
// once they have, the permission STICKS -- creating an AudioContext later is allowed and silent.
// Tracking that is what lets every caller arm the tone, instead of only the two that happen to be
// user gestures themselves. Without it, turning Background Play on from the OPTIONS PAGE armed
// nothing: watch_config_changes calls in with allowCreate=false, keep_alive returned immediately at
// the `!keep_alive_ctx` check, and the setting was on while the exemption that makes it work was
// not. Whether the feature worked came down to where you had clicked, which nothing told you.
let user_has_gestured = false;
// allowCreate is true ONLY when called from a real user gesture -- creating/resuming an AudioContext
// without one logs Chrome's "AudioContext was not allowed to start" warning, so non-gesture callers
// (page load, visibilitychange) only resume an already-created context (sticky activation permits that).
// The tone is only worth its cost when moves are actually meant to fire while the tab is hidden.
function keep_alive_wanted() {
    return !!(config.autoplay && config.background_play);
}

function keep_alive(active, allowCreate = false) {
    try {
        if (active) {
            if (!keep_alive_ctx) {
                // `allowCreate` = this call IS a gesture; `user_has_gestured` = one already happened
                // and the permission stuck. Either is enough; neither means it would warn, so don't.
                if (!allowCreate && !user_has_gestured) return;
                keep_alive_ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = keep_alive_ctx.createOscillator();
                const gain = keep_alive_ctx.createGain();
                gain.gain.value = 0.001; // ~-60 dB: inaudible, but nonzero so the tab counts as "audible"
                osc.connect(gain).connect(keep_alive_ctx.destination);
                osc.start();
            }
            if (keep_alive_ctx.state !== 'running') keep_alive_ctx.resume().catch(() => {});
        } else if (keep_alive_ctx && keep_alive_ctx.state === 'running') {
            keep_alive_ctx.suspend().catch(() => {});
        }
    } catch (e) { /* Web Audio unavailable -> background throttling stays; no worse than before */ }
}

async function initPanel(root, tabId) {
    // root = the closed shadow root when the panel lives in-page (4c-2); unset in the popup PAGE
    // (toolbar popup), where the panel owns the whole document.
    if (root) { PANEL_ROOT = root; PANEL_TIP_HOST = root; }
    else { PANEL_TIP_HOST = document.body || document.documentElement; }
    if (tabId != null) { MY_TAB_ID = tabId; ENGINE_CLIENT = String(tabId); } // no ?tab= when in-page
    // BOOTED means "can answer", not "has started". isBooted() is what makes the content script
    // hand us messages directly instead of posting into the runtime, and PANEL_MSG_HANDLER is
    // assigned ~160 lines below this -- so anything arriving in between hit
    // `PANEL_MSG_HANDLER && PANEL_MSG_HANDLER(...)`, evaluated to null, and was dropped WITHOUT a
    // word. The config hand-off is the message that lands in that window.
    PANEL_BOOTED = true;
    // The 4PC lane keeps its own dedupe, and popup.js is a CONTENT SCRIPT -- it survives the panel
    // being closed and reopened on the same page. So `fourpc_last` still held the position on screen,
    // the reopened panel deduped its very first scrape, and nothing appeared until someone moved or
    // the page was reloaded. `fourpc_busy` is worse: closing mid-search left it true forever, and
    // every later position was queued behind a search that would never report.
    // `board4pc` is the same trap one step further on: the renderer holds a reference to the #board
    // element it was built against, and a reopened panel builds a NEW one. Left set, `show_4pc_board`
    // saw a non-null renderer, skipped constructing one, and painted 14x14 into a detached element --
    // so the panel detected the game, sized the pieces, drew the arrow, and showed the 8x8 board.
    fourpc_last = ''; fourpc_busy = false; fourpc_pending = null; board4pc = null;
    await MephistoConfig.init(); // load config from chrome.storage.local into the sync cache first
    // load extension configurations from the config store (chrome.storage.local, cached)
    const computeTime = JSON.parse(MephistoConfig.get('compute_time'));
    const fenRefresh = JSON.parse(MephistoConfig.get('fen_refresh'));
    const thinkTime = JSON.parse(MephistoConfig.get('think_time'));
    const thinkVariance = JSON.parse(MephistoConfig.get('think_variance'));
    const moveTime = JSON.parse(MephistoConfig.get('move_time'));
    const moveVariance = JSON.parse(MephistoConfig.get('move_variance'));
    // the unit the Analysis Limit is read in; anything else in storage means the default
    const analysisLimitMode = (() => { try { return JSON.parse(MephistoConfig.get('analysis_limit_mode')); }
                                       catch (e) { return null; } })();
    const autoplay = JSON.parse(MephistoConfig.get('autoplay'));
    const computerEval = JSON.parse(MephistoConfig.get('computer_evaluation'));
    // engines dropped in this version - migrate stale selections to the current default
    const REMOVED_ENGINES = ['stockfish-6', 'stockfish-16-nnue-40', 'stockfish-16-nnue-7', 'lc0', 'stockfish-17-nnue-79'];
    let storedEngine = JSON.parse(MephistoConfig.get('engine'));
    if (REMOVED_ENGINES.includes(storedEngine)) storedEngine = null;
    config = {
        // general settings
        engine: MephistoConfig.liveEngine(storedEngine) || 'stockfish-19-nnue',
        variant: JSON.parse(MephistoConfig.get('variant')) || 'chess',
        // Four-player mode OVERRIDE. 'auto' reads it off chess.com's own mode chip; the other two
        // force it. Detection can only ever be a guess about someone else's markup, and the mode
        // changes the RULES (promotion is the 8th rank in FFA, the 11th in Teams), so a wrong read
        // is a wrong search with no way for you to say otherwise. This is that way.
        fourpc_mode: JSON.parse(MephistoConfig.get('fourpc_mode')) || 'auto',
        elo: JSON.parse(MephistoConfig.get('elo')) || 0, // strength cap; 0 = full strength (no UCI_LimitStrength)
        tablebase_show: JSON.parse(MephistoConfig.get('tablebase_show')) || 'both', // both | tablebase | engine (display only)
        pv_keys: JSON.parse(MephistoConfig.get('pv_keys')) || false, // arrow keys walk the engine's line
        refute: JSON.parse(MephistoConfig.get('refute')) || false,   // draw the punishing line after a bad move
        refute_plies: JSON.parse(MephistoConfig.get('refute_plies')) || 4,
        game_log: JSON.parse(MephistoConfig.get('game_log')) || false, // write evals into the copied PGN
        second_opinion: JSON.parse(MephistoConfig.get('second_opinion')) || false, // a human net beside the engine
        opp_prep: JSON.parse(MephistoConfig.get('opp_prep')) || false, // their own recent games, long games only
        // The player book: somebody's own openings, played as they play them. See player_book_pick.
        player_book: JSON.parse(MephistoConfig.get('player_book')) || false,
        player_book_user: JSON.parse(MephistoConfig.get('player_book_user') || '""'),
        // Wins only, ON by default WHEN THE FEATURE IS ON: a book built from every game somebody
        // played contains every opening they lost with, which is the opposite of prep.
        player_book_wins: (JSON.parse(MephistoConfig.get('player_book_wins')) !== false),
        maia_level: JSON.parse(MephistoConfig.get('maia_level')) || '1500', // which Maia net (rating band) when engine=maia
        maia3_elo: JSON.parse(MephistoConfig.get('maia3_elo')) || 1500, // Maia-3 target Elo (600-2600, live input, not a reload)
        // Maia-2 asks who is playing WHOM: the same position is answered differently by a 1200
        // against a 2000 than by a 2000 against a 1200. Both live, neither a reload.
        maia2_self_elo: JSON.parse(MephistoConfig.get('maia2_self_elo')) || 1500,
        maia2_oppo_elo: JSON.parse(MephistoConfig.get('maia2_oppo_elo')) || 1500,
        compute_time: (computeTime != null) ? computeTime : 300,
        // TIME OR DEPTH, and BOTH are kept. A depth is reproducible -- the same depth is the same
        // answer on any machine, where a millisecond budget is a different search on every box --
        // so the two are different instruments, not two spellings of one. Switching back and forth
        // must not forget the other number, which is why they are separate keys rather than one
        // value with a unit attached.
        search_mode: (JSON.parse(MephistoConfig.get('search_mode')) === 'depth') ? 'depth' : 'time',
        // GRIND MODE. The content script is what watches for the end of a game and clicks the
        // button that starts the next one, and the content script only ever sees the keys listed
        // here -- a setting absent from this object is a setting that silently does nothing, which
        // is exactly how the first version of this behaved.
        grind_mode: JSON.parse(MephistoConfig.get('grind_mode')) || false,
        grind_delay: Math.max(0, Math.min(600, JSON.parse(MephistoConfig.get('grind_delay') ?? '5') ?? 5)),
        // SAN or UCI, everywhere a move is written. Nf3 and g1f3 are the same move; which one
        // reads faster is a property of the reader, not of the move.
        move_notation: (JSON.parse(MephistoConfig.get('move_notation')) === 'uci') ? 'uci' : 'san',
        // Off by default: the labels are genuinely useful and they are also more ink on the board.
        arrow_labels: JSON.parse(MephistoConfig.get('arrow_labels')) || false,
        // The rank badge is its own decision. It has been drawn unconditionally since 3.1.226, so
        // it stays ON by default -- turning it off is the new option, not turning it on.
        arrow_rank: (JSON.parse(MephistoConfig.get('arrow_rank')) !== false),
        // How many plies of a FORCED continuation to draw ahead. 0 is off; the ceiling is 5 because
        // past that the arrows stop being readable on an 8x8 board rather than because the walk stops.
        forced_lines: Math.max(0, Math.min(5, JSON.parse(MephistoConfig.get('forced_lines')) || 0)),
        // THE WHOLE PV drawn ahead, opt-in. Grey and numbered: unlike the forced chain these are
        // the engine's current SUGGESTION, revisable at the next depth, and speculation must never
        // look like certainty. The limit is plies drawn; 50 is the ceiling because past that the
        // board is ink, not information.
        pv_walk: JSON.parse(MephistoConfig.get('pv_walk')) || false,
        pv_walk_limit: Math.max(1, Math.min(50, JSON.parse(MephistoConfig.get('pv_walk_limit')) || 5)),
        // user arrow colours (Appearance page): raw '#rrggbb' strings, validated at USE
        // (user_color) so a bad stored value falls back to its default instead of breaking boot
        // ARROW_COLOR_KEYS, not a second copy of the list: this one had drifted and was missing
        // three families (the human reply, the safety net, and now the tablebase and refutation
        // arrows), so their pickers wrote a value the panel never read and the colour silently
        // stayed the default. Caught in the browser, not by reading.
        ...Object.fromEntries(ARROW_COLOR_KEYS.map(k => {
            let v = ''; try { v = JSON.parse(MephistoConfig.get(k)) || ''; } catch (e) { /* junk -> default */ }
            return [k, v];
        })),
        // The premove framework's two dials. Confidence is the certification depth (see
        // premove_cert_last); plies is how deep a forced chain may queue (1 = single premoves).
        premove_confidence: JSON.parse(MephistoConfig.get('premove_confidence')) || 14,
        premove_plies: Math.max(1, Math.min(5, JSON.parse(MephistoConfig.get('premove_plies')) || 2)),
        // How loud the arrows are, as a PERCENTAGE (1..100) -- what the slider shows is what is
        // stored, so the number in the settings and the number on disk are the same thing.
        //
        // 3.1.228 stored a 0..1 fraction, and 0.75 read as a percentage is 0.75% -- invisible arrows
        // on every install that had ever touched the slider. Anything at or below 1 is therefore
        // read as the old scale and scaled up. EXACTLY 1 is claimed by both scales -- full opacity
        // then, 1% now -- and resolves as the old meaning on purpose: an install sitting at maximum
        // stays at maximum, where the other reading would turn its arrows invisible. 1% is reachable
        // again the moment the slider is touched.
        arrow_opacity: read_arrow_opacity(),
        // Board animation, opt-out. Nothing about a move needs to slide to be understood.
        board_animation: (JSON.parse(MephistoConfig.get('board_animation')) !== false),
        // Accuracy as it happens, on its own strip under the eval history.
        live_stats: JSON.parse(MephistoConfig.get('live_stats')) || false,
        live_classify: JSON.parse(MephistoConfig.get('live_classify')) || false,
        // The same verdict, on the SITE's board instead of the panel's. Independent of the toggle
        // above on purpose: someone watching the real board wants the badge there whether or not the
        // panel's little board is also carrying one.
        class_on_board: JSON.parse(MephistoConfig.get('class_on_board')) || false,
        streamer_alert: JSON.parse(MephistoConfig.get('streamer_alert')) || false,
        // which verdicts get a badge; everything, unless the settings row says otherwise
        live_classify_which: (() => {
            try {
                const v = JSON.parse(MephistoConfig.get('live_classify_which'));
                return Array.isArray(v) ? v : null;
            } catch (e) { return null; }
        })(),
        compute_depth: JSON.parse(MephistoConfig.get('compute_depth')) || 16,
        fen_refresh: (fenRefresh != null) ? fenRefresh : 1000, // FALLBACK poll; positions arrive event-driven
        multiple_lines: JSON.parse(MephistoConfig.get('multiple_lines')) || 1,
        threads: JSON.parse(MephistoConfig.get('threads')) || MephistoConfig.defaultThreads(),
        memory: JSON.parse(MephistoConfig.get('memory')) || 512,
        think_time: (thinkTime != null) ? thinkTime : 0,
        think_variance: (thinkVariance != null) ? thinkVariance : 0,
        move_time: (moveTime != null) ? moveTime : 400, // ms of cursor travel to the target square (M2)
        move_variance: (moveVariance != null) ? moveVariance : 400,
        humanize: JSON.parse(MephistoConfig.get('humanize')) || false,
        clock_mode: JSON.parse(MephistoConfig.get('clock_mode')) || false,
        clock_pace: JSON.parse(MephistoConfig.get('clock_pace')) || false,
        puzzle_auto_next: JSON.parse(MephistoConfig.get('puzzle_auto_next')) || false,
        drag_moves: JSON.parse(MephistoConfig.get('drag_moves')) || false,
        // the content script reads this off the pushed config, so it has to travel with it
        puzzle_next_delay: JSON.parse(MephistoConfig.get('puzzle_next_delay') ?? 'null') ?? 300,
        // Diagnostics, not play: forces the worker trace on even while the tab is focused. The
        // gate that suppresses it by default is the right default and the wrong thing to have to
        // guess at, so it gets a switch.
        verbose_log: JSON.parse(MephistoConfig.get('verbose_log')) || false,
        mirror_mode: JSON.parse(MephistoConfig.get('mirror_mode')) || false,
        mirror_ratio: JSON.parse(MephistoConfig.get('mirror_ratio')) || 90, // % of the opponent's spend
        // Move times drawn from the shape real ones have, not from a flat band. See lognormal_ms.
        human_times: JSON.parse(MephistoConfig.get('human_times')) || false,
        // Session stats: what this browser session has actually done. See session_stats_label.
        session_stats: JSON.parse(MephistoConfig.get('session_stats')) || false,
        // Ending a game that is over: both off, and both with a threshold. See end_game_action.
        auto_resign: JSON.parse(MephistoConfig.get('auto_resign')) || false,
        auto_resign_cp: JSON.parse(MephistoConfig.get('auto_resign_cp')) || 900,
        auto_draw: JSON.parse(MephistoConfig.get('auto_draw')) || false,
        auto_draw_cp: JSON.parse(MephistoConfig.get('auto_draw_cp')) || 20,
        // The complexity clock: think by how hard the position is. See complexity_k.
        complexity_clock: JSON.parse(MephistoConfig.get('complexity_clock')) || false,
        time_trouble: JSON.parse(MephistoConfig.get('time_trouble')) || false,
        time_trouble_at: JSON.parse(MephistoConfig.get('time_trouble_at')) || 30, // seconds
        // Manual Mode: the engine searches until YOU press the play-move hotkey, then it plays the
        // best move it found. Your own timing -- overrides the clock-pacing modes and never auto-fires.
        manual_mode: JSON.parse(MephistoConfig.get('manual_mode')) || false,
        // Opponent-mistake toast: flag when the opponent plays an inaccuracy/mistake/blunder (Lichess
        // win% method), but only when both evals reached a trustworthy depth.
        opp_alert: JSON.parse(MephistoConfig.get('opp_alert')) || false,
        computer_evaluation: (computerEval != null) ? computerEval : true,
        threat_analysis: JSON.parse(MephistoConfig.get('threat_analysis')) || false,
        // the HUMAN's likely reply beside the engine's best answer -- a different and usually more
        // useful prediction about the opponent actually being faced. Standard chess only (Maia).
        threat_human: JSON.parse(MephistoConfig.get('threat_human')) || false,
        // Playing with a net: opt-in, and quiet by default -- it is meant to be the thing that says
        // nothing until it matters, not another readout competing for attention.
        safety_net: JSON.parse(MephistoConfig.get('safety_net')) || false,
        safety_net_mode: JSON.parse(MephistoConfig.get('safety_net_mode')) || 'quiet',
        safety_net_drop: JSON.parse(MephistoConfig.get('safety_net_drop')) || 10,
        safety_net_max: JSON.parse(MephistoConfig.get('safety_net_max')) || 3,
        // Bot tricks: off until asked for, and the panel row does not exist while it is off.
        bot_tricks: JSON.parse(MephistoConfig.get('bot_tricks')) || false,
        bot_trick_game: JSON.parse(MephistoConfig.get('bot_trick_game')) || 'auto',
        bot_trick_delay: JSON.parse(MephistoConfig.get('bot_trick_delay')) || 500,
        bot_trick_pgn: JSON.parse(MephistoConfig.get('bot_trick_pgn')) || '',
        threat_human_elo: JSON.parse(MephistoConfig.get('threat_human_elo')) || 1500,
        simon_says_mode: JSON.parse(MephistoConfig.get('simon_says_mode')) || false,
        autoplay: (autoplay != null) ? autoplay : false,
        premove: JSON.parse(MephistoConfig.get('premove')) || false,
        // Pondering (settings page only): keep searching, at full threads, while it's the OPPONENT's
        // turn -- burn the wait on a deeper reply. OFF (default) still analyses the opponent's turn for
        // premove/threat/help, but capped to 1 thread so idle time isn't a full-core burn.
        ponder: JSON.parse(MephistoConfig.get('ponder')) || false,
        // The open-ended search's budget (Autoplay off / Help / Manual / ponder). The default is the
        // far right of the slider, which is infinite -- exactly what this search has always been.
        analysis_limit_mode: ANALYSIS_LIMIT_MODES.includes(analysisLimitMode) ? analysisLimitMode : 'time',
        analysis_limit: JSON.parse(MephistoConfig.get('analysis_limit')) || 61,
        tablebase: JSON.parse(MephistoConfig.get('tablebase')) || false,
        move_reason: JSON.parse(MephistoConfig.get('move_reason')) || false,
        eval_history: JSON.parse(MephistoConfig.get('eval_history')) || false,
        // Opening explorer: `explorer` draws the overlay, `book_play` actually plays a weighted-random
        // book move. Two independent toggles -- turning on the overlay must never change how you play.
        // Blur the opponent's name and avatar on the page. For screenshots and screen sharing --
        // a real person's username should not end up in a bug report or a README.
        hide_opponent: JSON.parse(MephistoConfig.get('hide_opponent')) || false,
        explorer: JSON.parse(MephistoConfig.get('explorer')) || false,
        book_play: JSON.parse(MephistoConfig.get('book_play')) || false,
        explorer_db: JSON.parse(MephistoConfig.get('explorer_db') || '"masters"'),
        // A character to play with, not a strength: see playstyle_pick. Off ('balanced') by default,
        // because a preference nobody asked for is a surprise.
        playstyle: (() => {
            try {
                const v = JSON.parse(MephistoConfig.get('playstyle') || '"balanced"');
                return PLAYSTYLE_STYLES.includes(v) ? v : 'balanced';
            } catch (e) { return 'balanced'; }
        })(),
        // CONTEMPT: how many centipawns a game you have to WIN is worth. See contempt_pick.
        contempt: JSON.parse(MephistoConfig.get('contempt')) || false,
        contempt_cp: JSON.parse(MephistoConfig.get('contempt_cp')) || 30,
        puzzle_mode: JSON.parse(MephistoConfig.get('puzzle_mode')) || false,
        // The panel builds its OWN config from named keys, so a setting the content script has is
        // still undefined here unless it is listed. Missing these two meant try_puzzle_capture read
        // config.puzzle_capture === undefined and never played the page's solution, however on the
        // setting was -- captured, gated-in, and then dropped on the floor at the last step.
        puzzle_capture: JSON.parse(MephistoConfig.get('puzzle_capture')) || false,
        puzzle_capture_cdp: JSON.parse(MephistoConfig.get('puzzle_capture_cdp')) || false,
        language: JSON.parse(MephistoConfig.get('language')) || 'en',
        help_mode: JSON.parse(MephistoConfig.get('help_mode')) || false,
        eval_bar: JSON.parse(MephistoConfig.get('eval_bar')) || false,
        python_autoplay_backend: JSON.parse(MephistoConfig.get('python_autoplay_backend')) || false,
        // undetectability: by default only move while the game tab is focused+visible (humans don't
        // play while tabbed away). Opt in to keep autoplay running in the background.
        background_play: JSON.parse(MephistoConfig.get('background_play')) || false,
    };
    // Fetch the classifier if a feature wants it. HERE, not at PANEL_BOOTED: the config hand-off
    // lands after boot, so a panel that booted before it always read the features as off -- and a
    // board with no moves yet never calls for a verdict either, so nothing would ever ask (both
    // seen in the rig: absent when off, and still absent when on).
    ensure_classifier();
    Object.assign(config, {
        // appearance settings
        pieces: JSON.parse(MephistoConfig.get('pieces')) || 'wikipedia.svg',
        board: JSON.parse(MephistoConfig.get('board')) || 'brown',
        coordinates: JSON.parse(MephistoConfig.get('coordinates')) || false,
        dark_mode: JSON.parse(MephistoConfig.get('dark_mode')) || false,
        compact: JSON.parse(MephistoConfig.get('compact')) || false,
    });
    panel_body()?.classList.toggle('mephisto-dark', config.dark_mode); // dark theme (set in Appearance)
    apply_compact();
    // Keep-alive tone. Chrome applies intensive timer throttling to a hidden tab after ~5 minutes,
    // which is what actually stops a backgrounded game -- an inaudible oscillator makes the tab count
    // as playing audio, and audible tabs are exempt.
    //
    // Gated on BACKGROUND PLAY, not on Autoplay. It used to run whenever Autoplay was on, which meant
    // a tab that defers its moves anyway (Background Play off, the default) was still marked audible
    // -- Chrome puts a speaker icon on the tab strip for that, so it bought nothing and added a
    // visible tell. Now it runs only when you have actually asked to play in the background.
    const on_gesture = () => { user_has_gestured = true; keep_alive(keep_alive_wanted(), true); };
    document.addEventListener('pointerdown', on_gesture, true); // gesture: may create
    document.addEventListener('keydown', on_gesture, true);     // ...and so is a hotkey
    document.addEventListener('visibilitychange', () => keep_alive(keep_alive_wanted()));
    push_config();
    init_quick_settings();
    maybe_autodetect_variant(); // variant game page -> auto-apply the variant (+ Fairy) once

    // init chess board
    const boardEl = PANEL_ROOT.getElementById('board');
    // clear any stale theme first, then apply -- a missing/unknown value would leave the squares
    // unthemed (falling back to chessboard.css's defaults), which is what "had to switch the board
    // colour to get the board back" looked like.
    BOARD_THEMES.forEach(t => boardEl.classList.remove(t));
    boardEl.classList.add(BOARD_THEMES.includes(config.board) ? config.board : 'brown');
    const [pieceSet, ext] = config.pieces.split('.');
    // In-page panel: piece images MUST be inlined data: URIs. A chrome-extension:// <img src> would
    // surface in the page's Resource Timing and identify the extension (issue #35 §3.4) -- exactly the
    // leak we removed the iframe to avoid. The popup PAGE keeps the plain extension path.
    if (PANEL_ROOT !== document) {
        try {
            const r = await chrome.runtime.sendMessage({getPieces: true, pieceSet, pieceExt: ext});
            if (r && r.pieces) PANEL_ASSETS = {pieces: r.pieces};
        } catch (e) { /* fall back to the path below */ }
    }
    board = MephistoBoard('board', {
        root: PANEL_ROOT, // in-page the board element is inside the shadow root, not `document`
        position: 'start',
        pieceMap: PANEL_ASSETS?.pieces || null,               // in-page: inlined data: URIs
        pieceTheme: `/res/chesspieces/${pieceSet}/{piece}.${ext}`, // popup page: plain extension path
        showNotation: config.coordinates,
        onMove: play_on_panel_board, // click or drag a piece to play it and keep analysing
        needsPromotion: panel_move_promotes, // ask which piece before a promoting move
        legalTargets: panel_legal_targets,   // dots on where the picked-up piece may actually go
    });

    // init fen LRU cache
    fen_cache = new LRU(100);

    // ENGINE INIT DOES NOT BLOCK THE PANEL (v3.1.250). This used to be awaited here, and
    // PANEL_MSG_HANDLER is assigned right below -- so for the whole engine-load window the panel
    // was up but could not ANSWER the page: no scrape, no board, no eval. On a cold browser that
    // window is the service worker waking, creating the offscreen document and loading a 100MB+
    // net, which is where the "panel does nothing for ten seconds after a restart" report comes
    // from. Nothing below needs the engine to exist yet: the offscreen host queues any uci sent
    // while it loads, and the first search is fired by the first scraped position, not from here.
    // The promise is kept so the few places that genuinely need a configured engine can await it.
    engine_init_promise = initialize_engine(true);
    engine_init_promise.catch(e => console.warn('Mephisto: engine init failed', e));

    // listen to messages from content-script
    PANEL_MSG_HANDLER = function (response, sender) {
        // popup.js is a content script on EVERY chess page now: stay completely inert unless this
        // tab's panel is actually open, or a panel-less page would act on another tab's traffic.
        if (!PANEL_BOOTED) return;
        // the content-script broadcasts (runtime.sendMessage) reach EVERY tab's popup -- ignore any
        // that came from a different tab's content-script so tabs never cross-talk. (Background
        // messages have no sender.tab and pass through.)
        if (MY_TAB_ID && sender.tab && sender.tab.id !== MY_TAB_ID) return;
        // The content-script could not play a move and says why. Shown in the panel rather than
        // only traced: a move that silently does not happen is the least actionable bug report
        // there is, and it was the shape of three separate ones.
        if (response.moveDropped) { set_idle_reason(response.moveDropped); return; }
        // The opponent is live-streaming this game. Said once, in the idle line, and nothing else:
        // what the extension should DO about it is an open question, and inventing an answer would
        // be worse than telling you and letting you decide.
        if (response.streamerNotice) {
            set_idle_reason(i18n('panel.msg.opp_streaming', '{user} is streaming this game right now',
                {user: response.username || '?'}));
            return;
        }
        if (response.fenresponse) { // reply received -> the poll interval may fire the next request
            fen_request_inflight = false;
            sync_puzzle_mode_to_page(response.puzzlePage);
            sync_fourpc_engine_to_page(response.fourPCPage);
            clearTimeout(fen_request_timer);
            if (response.clocks) last_clocks = {...response.clocks, at: Date.now()}; // for Clock Mode budgeting
            // The longest clock reading this game is the closest thing to a base time the panel
            // can see, and it is what Opponent Prep gates on: a 3+0 blitz never reaches five
            // minutes, a 15+10 does on move one. Robust to joining a game late, which a scraped
            // "time control" string would not be.
            if (last_clocks?.mine != null) game_max_clock_s = Math.max(game_max_clock_s, last_clocks.mine);
            if (response.opponent) maybe_opponent_prep(response.opponent);
        }
        if (response.fenresponse && response.dom && response.dom !== 'no') {
            // A manually set position OWNS the panel: the page keeps scraping and would otherwise
            // overwrite it on the very next poll (~1s), which is what makes a paste-a-FEN box useless.
            if (setup_fen) return;
            // FOUR-PLAYER: the payload is a FEN4, not anything chess.js can parse. Route it out of
            // the normal pipeline before the parse that would throw on it.
            if (typeof response.dom === 'string' && response.dom.startsWith('4PC:')) {
                on_new_pos_4pc(response.dom.slice(4));
                return;
            }
            if (board.orientation() !== response.orient) {
                board.orientation(response.orient);
            }
            let parsed;
            try {
                parsed = parse_position_from_response(response.dom);
            } catch (e) {
                console.warn('Mephisto: skipping unparseable scrape:', e.message);
                return; // transient scrape garbage - the next poll (100ms) retries
            }
            // stamped before anything can reject this push; promoted to `analysed_push_key` only
            // once the position is actually accepted (see on_new_pos)
            incoming_push_key = `${response.orient}|${response.dom}`;
            let {fen, startFen, moves} = parsed;
            // AN EMPTY FEN IS NOT A POSITION. A scrape can parse "successfully" into nothing -- a
            // board element that exists with its pieces not yet rendered, a move list the replay
            // could not apply -- and the panel then adopted it: the board wiped, "invalid fen" on
            // screen, and every later scrape deduped against that empty string. Keep the last good
            // position and let the next push retry, exactly as an unparseable scrape already does.
            if (!fen || !String(fen).trim()) {
                bgTrace('scrape parsed to an empty position -- keeping the last one', {
                    head: String(response.dom || '').slice(0, 60),
                    startFen: startFen || null, moves: moves ? String(moves).slice(0, 40) : null});
                return;
            }
            cross_check_position(fen); // warns only; never gates the move
            if (!is_legal_position(fen)) {
                // a corrupt/transient scrape (mid-animation, wrong turn guess) can yield an
                // illegal position; feeding one to the wasm engine crashes it (OOB). Skip it.
                console.warn('Mephisto: skipping illegal scraped position:', fen);
                return;
            }
            if (response.displayOnly) {
                // mid-move mirror: just show the settled position on the panel board so it tracks the
                // move in real time. NO analysis/autoplay -- the authoritative full push (sent when the
                // content-script's `moving` clears) drives those.
                board.position(fen);
                return;
            }
            // Manual turn override (header king switch): force which side is to move. STICKY per
            // position -- held while the same position sits on the board so you can toggle back and
            // forth -- and auto-cleared the instant a real move changes the detected side (below) or
            // the panel closes, so normal play keeps auto-tracking. Flipping rewrites the FEN's turn
            // field (dropping the now-invalid en passant); if handing the move to that side would be
            // illegal we refuse the flip. When forced, treat it as a fresh position (no move chain).
            const rawTurn = fen.split(' ')[1];
            if (rawTurn !== turn_detected_prev) { turn_override = null; turn_detected_prev = rawTurn; }
            if (turn_override && turn_override !== rawTurn) {
                const flipped = flip_fen_turn(fen);
                if (is_legal_position(flipped)) { fen = flipped; startFen = flipped; moves = ''; turn = turn_override; }
                else turn_override = null;
            }
            // Header switch mirrors the side we're actually about to analyse (post-override).
            update_turn_badge(fen);
            // `resume` = the tab regained focus with a move still held (see resumeIfDeferred in the
            // content-script). The position is unchanged BY DEFINITION, so this guard would skip the
            // whole block and the held move would never be re-issued -- coming back to the tab just
            // froze. Fall through on a resume instead. Note this deliberately does NOT clear
            // last_eval.fen: premove_instant_reply matches its tracker against it, so leaving it
            // intact lets an already-certified reply fire immediately rather than re-searching.
            if (last_eval.fen !== fen || (response.resume && config.autoplay)) {
                // Clock Mode mirroring: bookkeep the opponent's clock at turn boundaries. When a
                // position lands on OUR turn, they just moved -- their spend = their clock at the
                // start of their turn minus now (they get the increment back after moving). When it
                // lands on THEIR turn, our move went through -- mark where their clock starts.
                const ourColor = (our_side() === 'white') ? 'w' : 'b';
                if (turn === ourColor) {
                    opp_spend = (opp_clock_mark != null && last_clocks?.theirs != null)
                        ? Math.max(0, opp_clock_mark - last_clocks.theirs + (last_clocks.increment || 0))
                        : null;
                } else if (last_clocks?.theirs != null) {
                    opp_clock_mark = last_clocks.theirs;
                }
                // check BEFORE on_new_pos: the tracker belongs to the position we were analysing
                const instant = premove_instant_reply(fen, moves);
                on_new_pos(fen, startFen, moves);
                if (instant) {
                    // SAFETY: a certified reply is only played if it moves OUR piece and (on our
                    // turn) is legal right now. Guards against a stale/mismatched reply making us
                    // click the opponent's move or an illegal move -- discard it, normal search plays.
                    if (premove_reply_playable(fen, instant)) {
                        console.log('Premove: certified instant reply', instant);
                        request_automove(instant);
                    } else {
                        console.warn('Mephisto: discarding premove reply not playable in this position:', instant);
                    }
                }
            }
        } else if (response.pullConfig) {
            push_config();
        } else if (response.warm) {
            // Attach the debugger BEFORE the move measures any squares. Only meaningful for the CDP
            // clicker -- the python backend moves the real mouse and raises no infobar.
            if (config.python_autoplay_backend) return;
            // NO EARLY RETURN ON A MISSING TAB ID. The in-page panel is handed an empty sender
            // (`PANEL_MSG_HANDLER(msg, {})`), so there is no id here and never was -- bailing on it
            // meant the in-page panel, which is every real game, never warmed at all. Send regardless
            // and let the worker fall back to its own authenticated sender.tab, exactly as the click
            // path already does; the id below only matters for the toolbar popup, which has no tab.
            return chrome.runtime.sendMessage({cdpWarm: true, tabId: sender?.tab?.id})
                .then(r => { if (r && r.error) console.warn('CDP warm failed:', r.error); })
                .catch(() => {});
        } else if (response.click) {
            // click the GAME tab (the content-script's sender tab), not whatever tab is active --
            // otherwise a move firing while you're on another tab (e.g. chrome://extensions) dispatches
            // there and fails ("Cannot access a chrome:// URL"). Returned so the in-page caller can
            // AWAIT the click (its cursor travel paces the from->to gap -- see performSimulatedMoveClicks).
            return dispatch_click_event(response.x, response.y, sender?.tab?.id, response.travelMs, response.sentAt);
        } else if (response.drag) {
            // Same tab and the same await, but press-carry-release: chess.com's variants board only
            // accepts a CAPTURE as a drag (see cdpDrag).
            return dispatch_drag_event(response.x1, response.y1, response.x2, response.y2,
                                       sender?.tab?.id, response.travelMs);
        }
    };
    // Only the toolbar popup needs the runtime listener; in-page, content-script.js calls
    // PANEL_MSG_HANDLER directly (runtime.sendMessage can't cross to a sibling content script).
    if (!IS_CONTENT_SCRIPT) chrome.runtime.onMessage.addListener(PANEL_MSG_HANDLER);

    // FALLBACK poll only: the content-script pushes positions event-driven (MutationObserver);
    // this slow poll just heals a missed push (e.g. a mutation the observer filter skipped).
    // Clamped to >=1s so a legacy saved fen_refresh (10ms era) can't reinstate the old
    // 100-scrapes-a-second polling stampede.
    request_fen();
    setInterval(function () {
        request_fen();
        // chess.com is a single-page app: this script is not rebuilt when the user navigates from
        // the bot list into a game, so the row's visibility has to be re-decided, not decided once.
        sync_bot_row();
        // Re-assert the keep-alive tone. Chrome can SUSPEND an AudioContext in a hidden tab, and
        // nothing revived it -- the only other caller is visibilitychange, which by definition does
        // not fire while you are still away. Once the tone lapses the tab is throttled again and a
        // backgrounded game quietly stops. Resume-only (no gesture here), and a no-op when the
        // context is already running or Background Play is off.
        keep_alive(keep_alive_wanted());
    }, Math.max(1000, config.fen_refresh));

    // Update check: one message to the SW, which caches for 12h. Silent unless there is genuinely a
    // newer release -- a failed or rate-limited check leaves the notice hidden, exactly as if the
    // build were current. Clicking it opens the release page via the background (window.open from a
    // content script runs in the SITE's context and gets swallowed).
    check_for_update();
    watch_config_changes();
    // a reload (Engine/Variant/Elo) rebuilds this script -- bring back any position that was set
    restore_setup_state();

    // register button click listeners
    PANEL_ROOT.getElementById('analyze').addEventListener('click', () => {
        const variantNameMap = {
            'chess': 'standard',
            'fischerandom': 'chess960',
            'crazyhouse': 'crazyhouse',
            'kingofthehill': 'kingOfTheHill',
            '3check': 'threeCheck',
            'antichess': 'antichess',
            'atomic': 'atomic',
            'horde': 'horde',
            'racingkings': 'racingKings',
        }
        const variant = variantNameMap[config.variant];
        // Board only: just the piece-placement field, no side-to-move / castling / clocks. Keep the
        // '/' separators raw -- encodeURIComponent would turn them into %2F and lichess won't parse it.
        const url = `https://lichess.org/analysis/${variant}?fen=${last_eval.fen.split(' ')[0]}`;
        // the background opens it: window.open from a content script runs in the SITE's context and
        // gets swallowed by popup blocking / page policy
        chrome.runtime.sendMessage({openUrl: url});
    });
    PANEL_ROOT.getElementById('copyfen')?.addEventListener('click', () => copy_to_button('copyfen', last_eval.fen));
    PANEL_ROOT.getElementById('qs_copyanalysis')?.addEventListener('click',
        () => copy_to_button('qs_copyanalysis', analysis_text()));
    // FORCE A FRESH SEARCH of the position already on screen. Not a re-detect: the board is not
    // asked about and nothing is scraped, because the case this is for is an answer that went stale
    // under a setting change while the position itself is still right.
    PANEL_ROOT.getElementById('qs_reanalyse')?.addEventListener('click', () => {
        const at = setup_fen || last_eval.fen;
        if (!at) return;
        abandon_search();
        const startFen = setup_fen ? at : (last_pos.startFen || at);
        const moves = setup_fen ? '' : (last_pos.moves || '');
        last_eval.fen = '';
        tablebase_data = null;     // ask again rather than re-showing an answer we are re-deriving
        on_new_pos(at, startFen, moves);
    });
    PANEL_ROOT.getElementById('copypgn')?.addEventListener('click', () => copy_to_button('copypgn', current_pgn()));
    PANEL_ROOT.getElementById('config').addEventListener('click', () => {
        chrome.runtime.sendMessage({openOptions: true}); // the background opens it (see above)
    });
    // force re-detection: an SPA can swap games without any reload (e.g. a rematch), and if a
    // scrape ever goes stale this rescans the page and restarts the analysis from scratch
    PANEL_ROOT.getElementById('recheck')?.addEventListener('click', () => {
        // Re-detect always returns to the live game: clear any manually set position first, or the
        // scrape guard would swallow the very response this button just asked for. Set directly
        // rather than via clear_setup_fen(), which clicks THIS button (and would recurse).
        setup_fen = null;
        snap_crop = null;
        snap_follow_stop();
        stash_setup_state();
        const setupRow = PANEL_ROOT.getElementById('setup-fen-row');
        if (setupRow) setupRow.style.display = 'none';
        last_eval.fen = '';   // treat whatever comes back as a brand-new position
        prev_ply_count = 0;   // treat it as a fresh game...
        opp_spend = opp_clock_mark = last_our_eval = null; // ...and clear stale clock/mirror/humanize pacing
        abandon_search(); // L1: the stopped search still flushes a bestmove -- for the position we're discarding
        fen_request_inflight = false; // don't let an in-flight poll's 500ms guard swallow the re-query
        push_config();        // resets the content-script's push dedupe + triggers an immediate push
        request_fen();        // and poll right now as well -- fires immediately now the guard is clear
    });
    PANEL_ROOT.getElementById('selftest')?.addEventListener('click', run_self_test);
    PANEL_ROOT.getElementById('setupfen')?.addEventListener('click', toggle_setup_fen);
    PANEL_ROOT.getElementById('snapfen')?.addEventListener('click', () => snap_position());
    // Flip the READ position. The board reader has no way to know which way round the board on
    // screen was, so it assumes White at the bottom; one click corrects it rather than making the
    // user retype a FEN.
    // click a move in the panel line to walk back to it; playing from there overwrites the rest
    PANEL_ROOT.getElementById('panel-line')?.addEventListener('click', (e) => {
        const idx = e.target?.dataset?.idx;
        if (idx === undefined) return;
        panel_line_goto(parseInt(idx, 10));
    });
    PANEL_ROOT.getElementById('snap_follow')?.addEventListener('click', snap_follow_toggle);
    PANEL_ROOT.getElementById('setup_fen_flip')?.addEventListener('click', () => {
        const box = PANEL_ROOT.getElementById('setup_fen_input');
        const current = (box?.value || setup_fen || '').trim();
        if (!current) return;
        // "This board is being shown from the other side." That is ONE fact with two consequences,
        // so the button applies both: the recogniser maps the image's top-left to a8 no matter which
        // way the board was drawn, so the DATA needs turning round -- and the VIEW needs turning with
        // it, or the picture jumps 180 degrees away from the screen it is supposed to mirror. Doing
        // only the data (what this did) left you reading a black-side board off white-side
        // coordinates: the pieces looked right, a1 was labelled bottom-left, and it was the labels
        // and the FEN that were wrong.
        setup_view = (setup_view === 'black') ? 'white' : 'black';
        snap_flipped = !snap_flipped;   // and every FOLLOWED read from here on is rotated to match
        const flipped = rotate_fen_180(current);
        if (box) box.value = flipped;
        apply_setup_fen();
    });
    PANEL_ROOT.getElementById('setup_fen_input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); apply_setup_fen(); }
        if (e.key === 'Escape') { e.preventDefault(); clear_setup_fen(); }
    });

    // tooltips (replaces Materialize's M.Tooltip -- Materialize's JS looks elements up via `document`
    // and can't run in a shadow root; this queries a passed root instead). PANEL_ROOT/PANEL_TIP_HOST
    // default to `document`/`document.body` in the iframe; the shadow-root phase passes the root.
    annotate_hotkey_labels(); // show each toggle's shortcut next to it, e.g. "Autoplay (A)"
    init_tooltips(PANEL_ROOT, PANEL_TIP_HOST);
    // The locale arrives AFTER the panel is on screen, never before it.
    //
    // This used to be awaited up here, and it made opening the panel visibly slower: the fetch is a
    // round-trip to the service worker, which is usually asleep and has to be woken first, and
    // nothing rendered until it answered. The markup is already English, so blocking on it bought
    // exactly one thing -- English users waiting for English. Paint first, translate when it lands.
    //
    // Re-running the two calls above afterwards is required, not tidiness: annotate_hotkey_labels
    // APPENDS the "(A)" suffix to label text, and Materialize snapshots data-tooltip when a tooltip
    // is initialised, so both have to be redone against the translated markup.
    if ((config.language || MephistoI18n.DEFAULT_LANG) !== MephistoI18n.DEFAULT_LANG) {
        load_language(config.language).then(() => {
            MephistoI18n.apply(PANEL_ROOT);
            annotate_hotkey_labels();
            init_tooltips(PANEL_ROOT, PANEL_TIP_HOST);
        });
    }

    // The content-script's first push (fired ~30ms after push_config above) can arrive before this
    // panel's message handler exists -- it's dropped, but its dedupe key is already recorded, so the
    // board would stay stale until the position next CHANGES (an opponent move). Now that we're fully
    // wired, force one clean re-fetch: reset the dedupe and re-scrape immediately.
    last_eval.fen = '';
    fen_request_inflight = false;
    push_config();  // resets the content-script's push dedupe + triggers an immediate push
    request_fen();
    // Engine switches go through panel_reload(), so probing here covers them too. Not awaited: the
    // probe waits up to 1s on a host that may not exist, and the panel must not boot behind it.
    refresh_engine_health();
    hide_unavailable_natives();
}

// Native "(local)" engines only work if their messaging host is installed. Probe each on panel load
// and HIDE the dropdown options whose host isn't responding, so the list only offers engines you can
// actually run (a fresh install with no host shows just the WASM + Maia engines + Remote). Probing a
// host that isn't installed fails fast; only installed hosts are briefly launched to answer the ping.
// The currently-selected engine is never hidden -- the health badge already flags it if it's down.
async function hide_unavailable_natives() {
    const sel = PANEL_ROOT.getElementById('qs_engine');
    if (!sel) return;
    // A COLD SERVICE WORKER LOSES THIS RACE. The probe is one connect with a 1s timeout, and right
    // after an extension reload the worker is still starting -- the connect answers nothing in time,
    // the engine is judged missing, and it stays hidden for the whole session with no way to tell it
    // from "not installed". Reported live: a freshly installed native engine simply not in the list.
    // So a FAILED probe is retried once, a second later, by which time the worker is up. A host that
    // really is not installed fails both times and costs one extra second in the background.
    const probe = async (eng) => {
        if (await native_host_available(eng)) return true;   // port name == engine value here
        await new Promise(r => setTimeout(r, 1000));
        return native_host_available(eng);
    };
    await Promise.all(NATIVE_ENGINES.map(async (eng) => {
        const opt = [...sel.options].find(o => o.value === eng);
        if (!opt) return;
        const ok = await probe(eng);
        opt.hidden = !ok && eng !== config.engine;
        if (!ok) console.log(`Mephisto: native host for ${eng} did not answer twice -- hiding it`);
    }));
}
// In the iframe (and toolbar popup) the panel boots on DOMContentLoaded. Once the panel moves in-page
// (4c-2) the content-script imports this module and calls initPanel(shadowRoot) directly instead --
// by then DOMContentLoaded has long fired, so this listener simply never runs there.
if (!IS_CONTENT_SCRIPT) document.addEventListener('DOMContentLoaded', () => initPanel());
// (in-page, content-script.js calls initPanel(shadowRoot, tabId) on toolbar click instead)

// lightweight hover tooltip for `.tooltipped[data-tooltip]` elements (Materialize replacement)
function init_tooltips(queryRoot, appendTo) {
    const tip = document.createElement('div');
    tip.className = 'mephisto-tip';
    tip.style.cssText = 'position:fixed;z-index:2147483647;max-width:240px;padding:6px 9px;'
        + 'background:#323232;color:#fff;font:12px/1.4 Roboto,Arial,sans-serif;border-radius:4px;'
        + 'pointer-events:none;opacity:0;transition:opacity .12s;display:none;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    appendTo.appendChild(tip);
    let hideTimer = null;
    const show = (el) => {
        const text = el.getAttribute('data-tooltip');
        if (!text) return;
        clearTimeout(hideTimer);
        tip.textContent = text;
        tip.style.display = 'block';
        const r = el.getBoundingClientRect();
        // place below by default; nudge left so a wide tip stays on-screen
        const left = Math.min(Math.max(4, r.left), (window.innerWidth || 1200) - 250);
        tip.style.left = left + 'px';
        tip.style.top = (r.bottom + 6) + 'px';
        requestAnimationFrame(() => { tip.style.opacity = '1'; });
    };
    const hide = () => { tip.style.opacity = '0'; hideTimer = setTimeout(() => { tip.style.display = 'none'; }, 150); };
    queryRoot.querySelectorAll('.tooltipped').forEach(el => {
        el.addEventListener('mouseenter', () => show(el));
        el.addEventListener('mouseleave', hide);
    });
}

// Move a number input by one of its own steps, clamped to its own min/max. The amount is NOT
// hard-coded here: it comes from the element's `step`, so the increment lives in the markup beside
// the bounds it must respect. Dispatching `change` is the part that matters -- the config binding
// listens for exactly that, so a stepped value saves and pushes just like a typed one.
function step_number_input(input, dir) {
    const step = Number(input.step) || 1;
    const min = (input.min === '' || input.min == null) ? -Infinity : Number(input.min);
    const max = (input.max === '' || input.max == null) ? Infinity : Number(input.max);
    const now = Number(input.value);
    const next = (Number.isFinite(now) ? now : 0) + step * dir;
    input.value = String(Math.min(max, Math.max(min, next)));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return input.value;
}

function init_quick_settings() {
    const save = (key, value) => MephistoConfig.set(key, JSON.stringify(value));
    // Tab strip. Pure show/hide -- no state to persist and nothing to sync, since every control
    // inside the panels is bound by id exactly as it was when they all sat in one column.
    const tabs = [...PANEL_ROOT.querySelectorAll('.qs-tab')];
    for (const tab of tabs) {
        tab.addEventListener('click', () => {
            for (const t of tabs) {
                const on = t === tab;
                t.setAttribute('aria-selected', String(on));
                PANEL_ROOT.getElementById(t.dataset.panel)?.classList.toggle('qs-on', on);
            }
        });
    }
    // Threads is a count of real cores, so the stepper must not be able to reach a number this
    // machine cannot use. The markup's max=24 is the engine-side cap; the machine's own core count
    // is usually lower and wins. Same ceiling MephistoConfig.defaultThreads() picks from, so the
    // default always sits inside the range the -/+ buttons can walk.
    const threadsInput = PANEL_ROOT.getElementById('qs_threads');
    if (threadsInput) {
        threadsInput.max = String(Math.max(1, Math.min(24, navigator.hardwareConcurrency || 8)));
    }
    // -/+ steppers: the button names its input and its direction; the amount comes from the input.
    for (const btn of PANEL_ROOT.querySelectorAll('.qs-step')) {
        btn.addEventListener('click', () => {
            const input = PANEL_ROOT.getElementById(btn.dataset.for);
            if (input) step_number_input(input, Number(btn.dataset.d));
        });
    }
    // toggles apply live
    for (const [id, key] of [['qs_autoplay', 'autoplay'], ['qs_premove', 'premove'],
                             ['qs_puzzle', 'puzzle_mode'], ['qs_help', 'help_mode'],
                             ['qs_evalbar', 'eval_bar'], ['qs_evalhist', 'eval_history'],
                             ['qs_livestats', 'live_stats'],
                             ['qs_tablebase', 'tablebase'],
                             ['qs_humanize', 'humanize'],
                             ['qs_clock', 'clock_mode'], ['qs_clockpace', 'clock_pace'], ['qs_mirror', 'mirror_mode'],
                             ['qs_manual', 'manual_mode'],
                             ['qs_explorer', 'explorer'], ['qs_book', 'book_play']]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue; // stale cached popup.html mid-update; don't let one missing control kill the popup
        elem.checked = config[key];
        elem.addEventListener('change', () => {
            config[key] = elem.checked;
            save(key, elem.checked);
            keep_alive(keep_alive_wanted(), true); // this change is a user gesture -> can (re)start the tone now
            if (key === 'help_mode' && !elem.checked) request_clear_hint();
            if (key === 'help_mode' || key === 'manual_mode' || key === 'autoplay') mark_autoplay_overridden();
            // FOUR-PLAYER: a search is skipped entirely when the position has not changed
            // (fourpc_last), so any toggle that changes what the SAME position should PRODUCE has to
            // invalidate that. Help Mode was missing here, which is exactly why its arrow never
            // appeared until someone played a move -- turning it on asked for something the dedupe
            // had already decided not to redo. Both directions, and both toggles: switching Help
            // Mode off has to re-run too, or autoplay cannot take the move back over.
            if (key === 'autoplay' || key === 'help_mode') fourpc_last = '';
            if (key === 'eval_bar' && !elem.checked) request_clear_eval_bar();
            // the strip is drawn by drawEvalBar, so clearing and letting the next eval redraw is
            // enough -- clear_eval_bar removes both overlays and the live bar comes straight back
            if (key === 'eval_history') request_clear_eval_bar();
            if (key === 'explorer' || key === 'book_play') {
                // turning either on mid-game should look this position up right away rather than
                // waiting for the next move; the out-of-book latch is per game, so clear it too
                explorer_out_of_book = false; explorer_empty_streak = 0;
                render_explorer();
                if (last_eval.fen) request_explorer(last_eval.fen);
                own_book = null;   // re-ask under the new setting; absence re-latches by itself
                if (last_eval.fen) request_own_book(last_eval.fen);
            }
            if (key === 'tablebase') {
                tablebase_data = null; // a stale answer must not survive a toggle
                if (last_eval.fen) request_tablebase(last_eval.fen);
            }
            if (key === 'humanize') {
                // humanize picks among alternative lines, so it needs MultiPV headroom; re-apply
                // the line count (which drops back to config.multiple_lines when it's turned off,
                // so the engine stops searching the wide list) and restart under the new setting.
                abandon_search();
                if (is_remote()) {
                    remote_multipv_set = effective_multipv();
                    request_remote_configure({MultiPV: remote_multipv_set}).catch(() => { remote_multipv_set = null; });
                } else {
                    send_engine_uci(`setoption name MultiPV value ${effective_multipv()}`);
                }
                last_eval.fen = '';
            }
            if (['help_mode', 'autoplay', 'clock_mode', 'mirror_mode', 'manual_mode'].includes(key)) {
                // Turning Autoplay ON while an unbounded analysis is ALREADY running on this position
                // is the one case where restarting is strictly worse. With Autoplay off the search is
                // `go infinite`, so by the time you flip the toggle it is usually far deeper than the
                // fresh `go movetime` that would replace it -- and abandon_search would then throw
                // that result away (it counts the incoming bestmove into pending_stops). Send a bare
                // `stop` instead and KEEP the bestmove: it arrives through the normal handler, which
                // now sees autoplay on and plays it. Deeper move, and no second search.
                //
                // Gated hard: WASM only (a native host has no stop channel -- its analyse is bounded
                // by the request's `time`, so there is nothing to harvest and it must re-ask), our
                // turn only (the opponent's-turn search returns THEIR move), and only when no other
                // mode is independently forcing the infinite search.
                const our = (our_side() === 'white') ? 'w' : 'b';
                const harvest = key === 'autoplay' && elem.checked && search_active && !is_remote()
                    && !config.help_mode && !config.manual_mode
                    && last_eval.fen && last_eval.fen.split(' ')[1] === our;
                if (harvest) {
                    // NOT abandon_search(): that is the discard path. last_eval.fen is left intact so
                    // the next push doesn't re-analyse the position we just harvested.
                    send_engine_uci('stop');
                    push_config();
                    return;
                }
                // the go mode (infinite vs movetime) / search budget depends on these; abandon the
                // current search and re-analyse the position under the new mode on the next push
                abandon_search();
                last_eval.fen = '';
            }
            push_config();
        });
    }
    // Header turn switch: a king-glyph toggle (White = left, Black = right) in place of the old
    // "Quick Settings" title. It shows the analysed side to move and flips it on tap (routes to
    // flipTurn, same as the on-board badge). Its state is set by update_turn_badge on every position.
    const turnSwitchEl = PANEL_ROOT.getElementById('qs_turn_switch');
    if (turnSwitchEl) {
        const flip = () => self.MephistoPanel.flipTurn();
        turnSwitchEl.addEventListener('click', flip);
        turnSwitchEl.addEventListener('keydown', (e) => { // space/enter toggles (it's role=button)
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
        });
    }
    // timing settings apply live: the search budget is read at every 'go', think/move times are pushed to the page
    for (const [id, key] of [['qs_move', 'move_time'], ['qs_move_var', 'move_variance']]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            const value = Math.max(0, parseInt(elem.value) || 0);
            config[key] = value;
            save(key, value);
            push_config();
        });
    }
    // ONE stepper, TWO settings. The dropdown decides which of compute_time / compute_depth the box
    // is currently editing; the other keeps its value untouched in config and in storage, so
    // switching back restores the number you had rather than a default.
    const searchModeEl = PANEL_ROOT.getElementById('qs_search_mode');
    const searchBoxEl = PANEL_ROOT.getElementById('qs_search');
    if (searchBoxEl) {
        apply_search_mode_ui();
        searchBoxEl.addEventListener('change', () => {
            const b = SEARCH_BOUNDS[config.search_mode];
            const value = Math.min(b.max, Math.max(b.min, parseInt(searchBoxEl.value) || b.min));
            searchBoxEl.value = value;          // show the clamp rather than silently disagreeing
            config[b.key] = value;
            save(b.key, value);
            push_config();
        });
    }
    if (searchModeEl) {
        searchModeEl.addEventListener('change', () => {
            config.search_mode = (searchModeEl.value === 'depth') ? 'depth' : 'time';
            save('search_mode', config.search_mode);
            apply_search_mode_ui();
            push_config();
        });
    }
    // Settings that apply WITHOUT rebuilding the panel. Threads and Hash cannot be set mid-search, so
    // they are queued and flushed at the next `go` (see flush_engine_options); the running search
    // finishes on the settings it began with. Line count and the fallback poll apply immediately.
    //
    // These used to be in the reload group below, which is why nudging Threads restarted a search in
    // progress -- and, worse, discarded a captured position along with the whole panel.
    for (const [id, key, parse] of [
        ['qs_threads', 'threads', v => parseInt(v) || MephistoConfig.defaultThreads()],
        ['qs_memory', 'memory', v => parseInt(v) || 512],
        ['qs_lines', 'multiple_lines', v => parseInt(v) || 1],
        ['qs_fen', 'fen_refresh', v => Math.max(1000, parseInt(v) || 1000)], // floor 1s (see interval clamp)
    ]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            const value = parse(elem.value);
            config[key] = value;
            save(key, value);
            if (key === 'threads') queue_engine_option('Threads', value);
            if (key === 'memory') queue_engine_option('Hash', value); // flush_engine_options clamps for WASM
            if (key === 'multiple_lines') {
                if (is_remote()) {
                    remote_multipv_set = effective_multipv();
                    request_remote_configure({MultiPV: remote_multipv_set}).catch(() => { remote_multipv_set = null; });
                } else {
                    queue_engine_option('MultiPV', effective_multipv());
                }
            }
            if (is_remote() && (key === 'threads' || key === 'memory')) {
                // a native host applies options on its own lock and they take effect on the next
                // analyse, so there is nothing to defer
                request_remote_configure({Threads: config.threads, Hash: config.memory}).catch(() => {});
            }
            push_config();
        });
    }
    // The Maia rating band loads a different .onnx, but that is an ENGINE re-init, not a panel
    // teardown -- initialize_engine already treats maia_level as part of the net's identity, so
    // calling it again swaps the net while the panel, the position and the game state stay put.
    // This used to sit in the reload group below, which is why nudging the band mid-game blanked
    // the panel (user report 2026-08-14). Re-detect afterwards re-analyses the current position.
    const maiaLevelEl = PANEL_ROOT.getElementById('qs_maia_level');
    if (maiaLevelEl) {
        maiaLevelEl.value = config.maia_level;
        maiaLevelEl.addEventListener('change', async () => {
            const level = maiaLevelEl.value;
            if (level === config.maia_level) return;
            maiaLevelEl.disabled = true;              // one swap at a time -- the net load is async
            try {
                abandon_search();                     // the running search is for the old band
                config.maia_level = level;
                save('maia_level', level);
                await initialize_engine(false);       // maia_level is in the identity check: real re-init
                PANEL_ROOT.getElementById('recheck')?.click(); // re-analyse the position on the new band
            } catch (e) {
                console.warn('Mephisto: Maia band switch failed -- falling back to a panel reload', e);
                panel_reload();                       // the old behaviour, now only the failure path
            } finally {
                maiaLevelEl.disabled = false;
            }
        });
    }
    // engine settings that genuinely need a full re-init; reload the panel, it re-reads storage
    for (const [id, key, parse] of [
        ['qs_engine', 'engine', v => v],
        ['qs_variant', 'variant', v => v],
    ]) {
        const elem = PANEL_ROOT.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            // only Fairy-Stockfish plays fairy variants; other engines force standard chess so the
            // net + legality checks stay correct -- EXCEPT Chess960, which every mainline Stockfish
            // plays via UCI_Chess960 (sent at engine init), so it survives an engine switch. Maia is
            // standard-chess only (its nets have no 960), so switching to it always forces chess.
            if (key === 'engine') {
                const eng = parse(elem.value);
                if (eng === 'maia' || eng === 'maia3') save('variant', 'chess');
                else if (!FAIRY_ENGINES.includes(eng) && !['chess', 'fischerandom'].includes(config.variant)) save('variant', 'chess');
            }
            if (key === 'engine') stop_current_engine(); // free the old process before switching
            save(key, parse(elem.value));
            if (key === 'engine') {
                // stockfish.online only understands a depth, so picking it moves the budget to
                // Depth and picking anything else puts back what was there. One rule, in the config
                // layer, so this and the options page cannot disagree about it.
                config.search_mode = MephistoConfig.applyEngineBudgetRule(parse(elem.value));
                apply_search_mode_ui();
            }
            panel_reload();
        });
    }
    // Maia: strength is the NET (the Maia Level dropdown), not UCI_Elo, and it's standard-chess only
    // -> hide the Elo + Variant rows, show the level dropdown.
    const isMaia = config.engine === 'maia';
    const isMaia3 = config.engine === 'maia3';
    const maiaRow = PANEL_ROOT.getElementById('qs_maia_row');
    if (maiaRow) {
        maiaRow.style.display = isMaia ? '' : 'none';
        const ml = PANEL_ROOT.getElementById('qs_maia_level');
        if (ml) ml.value = config.maia_level;
    }
    // Maia-3 Elo slider: live-applied via setoption (SelfElo/OppoElo) -- no net reload -- then re-analyse.
    const maia3Row = PANEL_ROOT.getElementById('qs_maia3_row');
    if (maia3Row) {
        maia3Row.style.display = isMaia3 ? '' : 'none';
        const sl = PANEL_ROOT.getElementById('qs_maia3_elo');
        const lbl = PANEL_ROOT.getElementById('qs_maia3_val');
        if (sl && lbl) {
            sl.value = String(config.maia3_elo);
            lbl.textContent = config.maia3_elo;
            sl.addEventListener('input', () => { lbl.textContent = sl.value; });
            sl.addEventListener('change', () => {
                const v = parseInt(sl.value) || 1500;
                config.maia3_elo = v;
                save('maia3_elo', v);
                send_engine_uci(`setoption name SelfElo value ${v}`);
                send_engine_uci(`setoption name OppoElo value ${v}`);
                abandon_search();
                last_eval.fen = '';   // re-analyse the current position at the new rating
                push_config();
            });
        }
    }
    // MAIA-2 IS A MATCHUP, not a level: two ratings, both live. Same shape as the Maia-3 slider
    // above -- write the config, tell the engine, drop the stale answer and re-ask.
    const maia2Row = PANEL_ROOT.getElementById('qs_maia2_row');
    const maia2Oppo = PANEL_ROOT.getElementById('qs_maia2_oppo_row');
    if (maia2Row) {
        // Two rows, each a -/+ stepper in 50s like every other number here -- a rating is a number
        // you nudge, not a band you pick from a list. The MODEL buckets by 100; that is its own
        // resolution and not something to make the reader type in.
        const shown = (config.engine === 'maia2') ? '' : 'none';
        maia2Row.style.display = shown;
        if (maia2Oppo) maia2Oppo.style.display = shown;
        for (const [id, key, opt] of [['qs_maia2_self', 'maia2_self_elo', 'SelfElo'],
                                      ['qs_maia2_oppo', 'maia2_oppo_elo', 'OppoElo']]) {
            const box = PANEL_ROOT.getElementById(id);
            if (!box) continue;
            box.value = String(config[key]);
            box.addEventListener('change', () => {
                const v = Math.max(600, Math.min(2800, parseInt(box.value) || 1500));
                box.value = String(v);
                config[key] = v;
                save(key, v);
                send_engine_uci(`setoption name ${opt} value ${v}`);
                abandon_search();
                last_eval.fen = '';   // the old answer was for another matchup
                push_config();
            });
        }
    }
    // PLAYSTYLE BELONGS WHERE THE MOVES ARE. It decides which move gets played, so it sits in the
    // panel beside the other things that do -- not only on the settings page. No reload and no
    // re-search: the pick happens when the engine reports its lines, which is after every move.
    // PANEL OPACITY AND DOCKING. Per SITE, not per settings profile -- where this panel sits on
    // lichess has nothing to do with where it sits on chess.com -- so the values live with the
    // geometry in the content script's own per-site record and are read from it here.
    const opRow = PANEL_ROOT.getElementById('qs_opacity_row');
    const dockRow = PANEL_ROOT.getElementById('qs_dock_row');
    if (opRow && dockRow) {
        // Only the in-page panel HAS a wrapper to fade or dock; the toolbar popup is drawn by the
        // browser and neither applies, so the rows are not offered there.
        const style = IS_CONTENT_SCRIPT ? read_panel_style() : null;
        opRow.style.display = dockRow.style.display = style ? '' : 'none';
        const op = PANEL_ROOT.getElementById('qs_opacity');
        const dk = PANEL_ROOT.getElementById('qs_dock');
        if (style && op && dk) {
            op.value = String(style.opacity ?? 100);
            dk.value = style.dock || 'free';
            op.addEventListener('change', () => send_panel_style({opacity: parseInt(op.value) || 100}));
            dk.addEventListener('change', () => send_panel_style({dock: dk.value}));
        }
    }
    // Who owns the board when both the engine and the tablebase have an answer. Display only, so
    // nothing is re-searched: redraw what is already known and repaint the two readings.
    const tbSel = PANEL_ROOT.getElementById('qs_tb_show');
    if (tbSel) {
        tbSel.value = tb_show();
        const tbRow = PANEL_ROOT.getElementById('qs_tb_show_row');
        if (tbRow) tbRow.style.display = config.tablebase ? '' : 'none';
        tbSel.addEventListener('change', () => {
            const v = TB_SHOW_MODES.includes(tbSel.value) ? tbSel.value : 'both';
            config.tablebase_show = v;
            save('tablebase_show', v);
            draw_moves();
            update_best_move(null);   // re-render the readout and its extras under the new mode
            push_config();
        });
    }
    const styleSel = PANEL_ROOT.getElementById('qs_playstyle');
    if (styleSel) {
        styleSel.value = config.playstyle || 'balanced';
        update_playstyle_row();
        styleSel.addEventListener('change', () => {
            const v = PLAYSTYLE_STYLES.includes(styleSel.value) ? styleSel.value : 'balanced';
            config.playstyle = v;
            save('playstyle', v);
            push_config();
        });
    }
    const eloRow = PANEL_ROOT.getElementById('qs_elo_row');
    if (eloRow) eloRow.style.display = (isMaia || isMaia3 || NO_ELO_ENGINES.includes(config.engine)) ? 'none' : '';
    const variantRow = PANEL_ROOT.getElementById('qs_variant_row');
    if (variantRow) {
        if (isMaia || NO_CHESS960_ENGINES.includes(config.engine)) {
            variantRow.style.display = 'none';
        } else {
            const fairy = FAIRY_ENGINES.includes(config.engine);
            variantRow.style.display = '';
            PANEL_ROOT.querySelectorAll('#qs_variant option').forEach(o => {
                o.hidden = !fairy && !['chess', 'fischerandom'].includes(o.value);
            });
        }
    }
    // Four-player mode override, in the Variant row's place. Deliberately NOT in the reload-the-panel
    // table above: the mode is pushed to the content script and to Tetrarch per search, so it needs a
    // re-analysis, not a re-init. Clearing fourpc_last is what makes it apply to the position already
    // on screen instead of the next one -- the mode changes the RULES, so waiting would analyse the
    // board under the rules you just said were wrong.
    const modeRow = PANEL_ROOT.getElementById('qs_fourpc_mode_row');
    if (modeRow) modeRow.style.display = FOURPC_ENGINES.includes(config.engine) ? '' : 'none';
    const modeSel = PANEL_ROOT.getElementById('qs_fourpc_mode');
    if (modeSel) {
        modeSel.value = config.fourpc_mode || 'auto';
        modeSel.addEventListener('change', () => {
            config.fourpc_mode = modeSel.value;
            save('fourpc_mode', modeSel.value);
            fourpc_last = '';
            push_config();
        });
    }
    // Diagnostics, as a button people will actually find. The hotkey stays wired too -- it is one
    // line and costs nothing -- but the button is the way in.
    const diagBtn = PANEL_ROOT.getElementById('qs_copydiag');
    if (diagBtn) {
        diagBtn.addEventListener('click', () => {
            const was = diagBtn.textContent;
            diagBtn.disabled = true;
            // The report is for somebody else; THIS is for you. The same facts, named in the panel
            // the moment you press it, so the commonest report -- "it did nothing" -- often does not
            // need to be filed at all. Not tied to a first run: something that breaks on day two
            // hundred deserves the same answer as something that never started.
            const bad = health_rows(health_state()).filter(r => r.ok === false);
            set_idle_reason(bad.length
                ? `${bad[0].label}: ${bad[0].detail || 'not working'}`
                : 'All checks passed - board, settings and engine are all live.');
            copy_diagnostics((err) => {
                diagBtn.textContent = err ? '✕' : '✓';
                if (err) set_idle_reason(err);
                setTimeout(() => { diagBtn.textContent = was; diagBtn.disabled = false; }, 1100);
            });
        });
    }
    // Bot game. The row lives in the Play tab but only exists on chess.com's Play Computer page,
    // so it is populated and shown by sync_bot_row() off the same slow poll that heals a missed
    // position push -- chess.com is a single-page app and never reloads this script on a
    // navigation, so a one-shot check at startup would show the row on the wrong page forever.
    const botSel = PANEL_ROOT.getElementById('qs_bot_game');
    if (botSel) botSel.addEventListener('change', () => {
        config.bot_trick_game = botSel.value;
        MephistoConfig.set('bot_trick_game', JSON.stringify(botSel.value));
    });
    const botPlay = PANEL_ROOT.getElementById('qs_bot_play');
    if (botPlay) botPlay.addEventListener('click', () => run_bot_trick('mate'));
    const botDraw = PANEL_ROOT.getElementById('qs_bot_draw');
    if (botDraw) botDraw.addEventListener('click', () => run_bot_trick('draw'));
    const detectBtn = PANEL_ROOT.getElementById('qs_variant_detect');
    if (detectBtn) {
        detectBtn.addEventListener('click', () => {
            detectBtn.disabled = true;
            request_detect_variant(v => {
                detectBtn.disabled = false;
                if (v) apply_detected_variant(v);                        // detected -> apply (+ Fairy) & reload
                else { detectBtn.textContent = '?'; setTimeout(() => { detectBtn.textContent = '↻'; }, 1200); }
            });
        });
    }
    // Elo slider: index-mapped so its stops follow the selected engine's real UCI_Elo range
    // (position 0 = Off / full strength). Saves the mapped Elo and reloads to re-init the engine.
    const eloSlider = PANEL_ROOT.getElementById('qs_elo');
    const eloLabel = PANEL_ROOT.getElementById('qs_elo_val');
    if (eloSlider && eloLabel) {
        const stops = elo_stops(config.engine);
        const idxOf = (elo) => { // nearest stop to the stored Elo
            if (!(elo > 0)) return 0;                              // Off (far left)
            if (elo >= FULL_STRENGTH_ELO) return stops.length - 1; // 3200+ (far right)
            let best = 1, bestD = Infinity;
            stops.forEach((e, i) => { // nearest real stop; skip the full-strength sentinel
                if (i && e < FULL_STRENGTH_ELO && Math.abs(e - elo) < bestD) { bestD = Math.abs(e - elo); best = i; }
            });
            return best;
        };
        eloSlider.max = String(stops.length - 1);
        eloSlider.value = String(idxOf(config.elo));
        const paint = () => {
            const v = stops[+eloSlider.value];
            // the right-hand full-strength stop shows the engine's OWN ceiling (SF dev 3190,
            // SF 11 / Fairy 2850), not the internal 3200 sentinel -- stops[len-2] is that max.
            eloLabel.textContent = v === 0 ? 'Off / Full Strength'
                : v >= FULL_STRENGTH_ELO ? `${stops[stops.length - 2]}+ / Full Strength` : v;
        };
        paint();
        eloSlider.addEventListener('input', paint);
        eloSlider.addEventListener('change', () => { save('elo', stops[+eloSlider.value]); panel_reload(); });
    }
    // range sliders show their value in the label while dragging ('change' above still does the
    // save+reload when the thumb is released). Only Memory is still a slider -- Threads and Multi
    // Lines are steppers now, and a stepper shows its value in the field itself.
    for (const id of ['qs_memory']) {
        const slider = PANEL_ROOT.getElementById(id);
        const label = PANEL_ROOT.getElementById(`${id}_val`);
        if (!slider || !label) continue;
        label.textContent = slider.value;
        slider.addEventListener('input', () => { label.textContent = slider.value; });
    }
    // The green fill up to the thumb is a gradient stop CSS cannot compute -- only the element knows
    // its own value -- so it is set here as `--fill`. Runs LAST in this function, after the Elo and
    // Maia sliders have had their real min/max/value assigned above; a slider painted before that
    // would show a fill for the placeholder range.
    const paint_range = (r) => {
        const min = Number(r.min) || 0, max = Number(r.max);
        const span = (max - min) || 1;
        r.style.setProperty('--fill', ((Number(r.value) - min) / span * 100) + '%');
    };
    for (const r of PANEL_ROOT.querySelectorAll('input[type=range]')) {
        paint_range(r);
        r.addEventListener('input', () => paint_range(r));
    }
}

// N1: the WASM engine now lives in the offscreen document (extension origin, cross-origin isolated),
// not in this in-page iframe. `offscreen_engine` is a proxy with the same `.uci(line)` interface the
// popup used on the in-iframe engine object, so send_engine_uci and initialize_engine barely change;
// engine output/errors come back over chrome.runtime and route to the existing handlers below.
let ENGINE_CLIENT = (MY_TAB_ID != null) ? String(MY_TAB_ID) : 'toolbar'; // one engine per panel
const WASM_ENGINES = ['stockfish-19-nnue', 'stockfish-19-small-nnue', 'stockfish-18-nnue',
                      'fairy-stockfish-14-nnue', 'stockfish-11-hce', 'maia', 'maia2', 'maia3', 'elite-leela'];
const offscreen_engine = {
    uci: (line) => { try { chrome.runtime.sendMessage({toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'uci', line}); } catch (e) { /* SW/offscreen gone */ } },
};
// engine output -> existing handlers (filtered to THIS panel's engine)
chrome.runtime.onMessage.addListener((msg) => {
    if (!PANEL_BOOTED || !msg || !msg.fromOffscreen) return;
    if (msg.clientId === maia2_client()) { if (msg.kind === 'line') maia2_on_line(msg.line); return; }
    if (msg.clientId === bench_client()) { bench_sink?.(msg); return; }   // engine-recommendation bench
    if (msg.clientId !== ENGINE_CLIENT) return;
    if (msg.kind === 'line') on_engine_response(msg.line);
    else if (msg.kind === 'error') on_engine_error(msg.error);
});
// ---- MAIA SECOND INFERENCE (premoves for human-predicted replies) ----
// Maia is one forward pass: its line is a PREDICTION of the opponent's move with nothing after
// it, so the premove rail (which plays line.reply) never had anything to play. The second
// inference asks the SAME net, on an ISOLATED offscreen client, what we would answer after that
// prediction; the answer becomes line.reply and rides the existing rails. Isolation matters: a
// separate client id keeps this inference out of the main parser, so it can never contaminate
// last_eval or the tracker. Safety is NOT relaxed: premove_certified accepts a maia2 line, but
// maybe_premove_forced_reply still requires premove_is_safe -- the premove queues only when the
// reply is bound to the predicted move (recapture / forced reply / mate patterns), meaning it
// cannot fire in a position it was not meant for.
let maia2 = null; // {level, doneFen, pending: {fen, line, timer}} -- lazily created per panel

// Renew this panel's lease on the offscreen engine while a search is running. The engine host
// cannot see whether this panel still exists -- a navigation or a crashed tab takes the panel with
// no teardown -- so without this a `go infinite` keeps every core busy for the life of the browser.
// Only while searching: an idle engine burns nothing, so there is nothing to keep alive.
setInterval(() => {
    if (!search_active) return;
    try { chrome.runtime.sendMessage({toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'ping'}); }
    catch (e) { /* SW/offscreen gone -- the lease expiring is exactly the right outcome */ }
}, 15000);

function maia2_client() { return ENGINE_CLIENT + ':m2'; }

function maia2_dispose() {
    if (maia2 && maia2.pending) clearTimeout(maia2.pending.timer);
    maia2 = null;
    try { chrome.runtime.sendMessage({toOffscreen: true, clientId: maia2_client(), cmd: 'dispose'}); } catch (e) { /* gone */ }
}

// Fire the second inference for a reply-less Maia line, at most once per position. Called from
// the parser right after the tracker records line 0 during the opponent's turn.
function maia2_kick(line) {
    if (is_one_pass()) return;
    if (!config.premove || !config.autoplay || premove_tracker.premoved) return;
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return;
    if (config.variant && config.variant !== 'chess') return;
    const fen = premove_tracker.fen;
    if (!fen || !line || !line.pred || line.reply) return;
    const level = (config.engine === 'maia3') ? config.maia3_elo : config.maia_level;
    if (maia2 && maia2.level !== level) maia2_dispose(); // band switched -> the old client runs a stale net
    if (maia2 && maia2.doneFen === fen) return;          // one inference per position
    let fen2;
    try {
        const c = new Chess(config.variant, fen);
        c.move({from: line.pred.slice(0, 2), to: line.pred.slice(2, 4), promotion: line.pred[4]});
        fen2 = c.fen();
    } catch (e) { return; } // prediction not legal by chess.js -> nothing to ask
    if (!maia2) {
        maia2 = {level};
        // no ensureOffscreen needed: the MAIN engine is Maia right now, so the document exists
        try { chrome.runtime.sendMessage({toOffscreen: true, clientId: maia2_client(), cmd: 'init',
                                          engine: config.engine, variant: config.variant, maiaLevel: level}); } catch (e) { maia2 = null; return; }
    }
    if (maia2.pending) clearTimeout(maia2.pending.timer);
    maia2.doneFen = fen;
    // The timer only FREES the slot -- staleness is decided by the fen check when the answer
    // arrives, so a long window never plays a stale move. It must be long: the first kick pays
    // the :m2 client's own net load (seconds for the Maia-3 transformer), and 5s dropped the
    // first premove opportunity of the game on exactly the engine this feature is for.
    maia2.pending = {fen, line, timer: setTimeout(() => { if (maia2) maia2.pending = null; }, 12000)};
    try {
        chrome.runtime.sendMessage({toOffscreen: true, clientId: maia2_client(), cmd: 'uci', line: `position fen ${fen2}`});
        chrome.runtime.sendMessage({toOffscreen: true, clientId: maia2_client(), cmd: 'uci', line: 'go'});
    } catch (e) { maia2.pending = null; }
}

function maia2_on_line(text) {
    if (!maia2 || !maia2.pending) return; // late or duplicate answer, or already timed out
    const m = /^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)$/.exec(text || '');
    if (!m) {
        // mate/stalemate after the prediction answers "(none)": there is no reply to premove,
        // so free the slot now instead of letting it sit until the timer does
        if (/^bestmove \(none\)/.test(text || '')) { clearTimeout(maia2.pending.timer); maia2.pending = null; }
        return;                           // the second client's info lines are noise here
    }
    const p = maia2.pending;
    clearTimeout(p.timer);
    maia2.pending = null;
    // the game moved on while the net was thinking -> the answer belongs to a dead position
    if (premove_tracker.fen !== p.fen || premove_tracker.premoved) return;
    p.line.reply = m[1];
    p.line.maia2 = true;                  // premove_certified's acceptance path
    p.line.pvFull = [p.line.pred, m[1]];
    maybe_premove_forced_reply(p.line);
}


// Create/replace this panel's offscreen engine and load its NNUE; resolves when it reports 'ready'.
// The setoption/ucinewgame/isready lines that follow in initialize_engine are then forwarded in order.
async function ensure_offscreen_engine(engineName) {
    try { await chrome.runtime.sendMessage({ensureOffscreen: true}); } catch (e) { /* SW spinning up */ }
    // Fire the init and return WITHOUT waiting for 'ready'. The offscreen host queues any uci sent
    // while it loads and flushes it in order, so nothing is lost -- and the panel no longer stalls
    // behind a slow engine load (Fairy's per-variant NNUE), which is why its board used to appear late.
    chrome.runtime.sendMessage({toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'init',
                                engine: engineName, variant: config.variant,
                                maiaLevel: engineName === 'maia3' ? config.maia3_elo : config.maia_level,
                                elos: [config.maia2_self_elo, config.maia2_oppo_elo]});
}

async function initialize_engine(reuseWarm = false) {
    pending_stops = 0; // a crashed/replaced engine never flushes what it owed; don't eat the new engine's first result
    // Options queued for the PREVIOUS engine are not this engine's. flush_engine_options only runs
    // in the WASM branch of on_new_pos, so anything queued while a native engine was selected sat
    // here untouched until a WASM engine picked it up and applied it -- including a Hash the WASM
    // heap cannot allocate. This function is about to push the right values for the new engine.
    pending_engine_options = {};
    search_active = false;
    // Fingerprint every engine-affecting setting. If NONE changed since the last init, a reopen can
    // skip engine setup ENTIRELY: the engine is still loaded, still configured, and its hash is warm,
    // so it's ready to take `position ... / go` the instant the first fen lands. This is what makes a
    // warm reopen instant -- no NNUE reload, no Hash realloc, and crucially no `ucinewgame`, which
    // would clear a multi-GB hash (the stall you saw on a native engine with a big Hash). Keeping the
    // hash across a reopen is a bonus: the next search starts warm.
    const fp = [config.engine, config.variant, config.memory, config.threads,
                effective_multipv(), config.elo, !!config.premove, config.maia_level].join('|');
    if (reuseWarm && engine_ready && fp === last_init_fp) {
        if (WASM_ENGINES.includes(config.engine)) engine = offscreen_engine;
        console.log('Engine warm - reused as-is (no reconfigure)');
        return;
    }
    // Net stays loaded only when its IDENTITY is unchanged: engine + variant (+ maia_level, since a
    // Maia rating switch loads a different .onnx). A settings-only change (threads/hash/lines/elo)
    // still reconfigures but skips the reload.
    const warm = reuseWarm && engine_ready && config.engine === last_init_engine
        && config.variant === last_init_variant && config.maia_level === last_init_maia;
    if (WASM_ENGINES.includes(config.engine)) {
        // WASM engine runs in the offscreen document now (see offscreen_engine above). This creates
        // it + loads its NNUE net(s) for THIS panel and resolves when ready; the setoption lines in
        // the `else` below then forward to it in order. Cross-origin isolation / SharedArrayBuffer is
        // guaranteed there (it's an extension page), so the old in-popup SAB check is gone.
        engine = offscreen_engine;
        if (!warm) await ensure_offscreen_engine(config.engine); // else keep the already-loaded engine
    }

    if (is_remote()) {
        request_remote_configure({
            "Hash": config.memory,
            "Threads": config.threads,
            "MultiPV": effective_multipv(), // bumped for Humanize (needs alt-line headroom), like WASM
            "Premove": !!config.premove, // opt-in; engines without the option skip it
            // remote-engine.py skips options the engine doesn't declare, so this is safe everywhere.
            // ALWAYS sent, never omitted-when-standard: the host keeps the last configure it was
            // given (engine_options is a dict it only ever writes into), so leaving these out on the
            // way BACK to Standard left it building Chess960 or Fairy boards for a standard game --
            // the variant was a one-way door. The host handles the explicit standard values
            // (UCI_Variant 'chess' drops the variant net) and skips options an engine doesn't declare.
            "UCI_Chess960": config.variant === 'fischerandom',
            "UCI_Variant": config.variant || 'chess',
            ...(config.elo > 0 && config.elo <= 3190 ? {"UCI_LimitStrength": true, "UCI_Elo": config.elo} : {}),
        }).catch(on_remote_error);
        remote_multipv_set = effective_multipv(); // baseline just configured; don't re-push it
    } else {
        // STOP BEFORE THE PREAMBLE. Boot no longer awaits this init (v3.1.250), so a scraped
        // position can issue `position` + `go infinite` while the engine is still loading -- the
        // offscreen host queues everything and flushes IN ORDER, which puts that `go` AHEAD of the
        // lines below. Stockfish serves `ucinewgame` (and the Hash/Threads setoptions) by waiting
        // for the running search to finish, and an infinite search never does: the engine's command
        // thread wedged FOREVER, every later uci line (stop included) queued behind it, the search
        // streamed the old position for the rest of the session, and apply_setup_fen could never
        // re-drive it. Measured live on lichess/analysis: zero readyok all session, two ignored
        // stops, depth still climbing on the abandoned position 18s after the setup fen was set.
        // A stop here lands ahead of the preamble in the same ordered queue, so the preamble meets
        // a quiet engine. The flushed bestmove is charged by abandon_search and eaten as usual.
        const search_was_live = search_active;
        abandon_search();
        // WASM engines can't allocate the big hash the slider now allows (4 GB) -- their heap is
        // capped, so clamp to 512 MB here. Native engines (remote branch above) get the full value.
        send_engine_uci(`setoption name Hash value ${Math.min(config.memory, 512)}`);
        send_engine_uci(`setoption name Threads value ${config.threads}`);
        search_threads_set = config.threads; // baseline; on_new_pos re-pushes only when the per-turn target differs
        remote_multipv_set = null;           // WASM path: no host to have configured
        send_engine_uci(`setoption name MultiPV value ${effective_multipv()}`);
        search_multipv_set = effective_multipv();   // baseline for the same reason as Threads
        // Win/Draw/Loss readout under the score. Modern Stockfish (dev/18) reports `wdl W D L` per
        // info line once this is on; SF11/Fairy don't declare it and silently ignore this line.
        send_engine_uci('setoption name UCI_ShowWDL value true');
        // Chess960: a mainline Stockfish must be told, or it treats the game as standard chess and
        // mishandles castling whenever the king/rooks aren't on their normal files. (Fairy-Stockfish
        // already gets this from its 'fischerandom' UCI_Variant above, so only the SF engines need it.)
        if (config.variant === 'fischerandom' && config.engine !== 'fairy-stockfish-14-nnue') {
            send_engine_uci('setoption name UCI_Chess960 value true');
        }
        // Strength cap: every Stockfish/Fairy build clamps UCI_Elo to its own range, so send it raw.
        // The native troll engines don't declare the option. 0 = full strength (leave limiting off).
        if (!NO_ELO_ENGINES.includes(config.engine)) {
            // Cap only within the engine's own range; 0 (Off) or anything above its max (the
            // "3200+" slider stop) means full strength -> leave limiting off.
            const eloMax = (ELO_RANGE[config.engine] || [1320, 3190])[1];
            if (config.elo > 0 && config.elo <= eloMax) {
                send_engine_uci('setoption name UCI_LimitStrength value true');
                send_engine_uci(`setoption name UCI_Elo value ${config.elo}`);
            } else {
                send_engine_uci('setoption name UCI_LimitStrength value false');
            }
        }
        send_engine_uci('ucinewgame');
        send_engine_uci('isready');
        // The search stopped above was for a position the panel is still holding -- nothing else
        // re-issues it (the scrape path dedupes on last_eval.fen), so re-drive it here, behind the
        // preamble in the same ordered queue. Skipped when nothing was searching (fresh boot before
        // the first scrape, Maia band switch -- that path abandons first and re-detects itself).
        if (search_was_live && last_eval.fen) {
            on_new_pos(last_eval.fen, last_pos.startFen || last_eval.fen, last_pos.moves || '');
        }
    }
    engine_ready = true;
    if (last_init_engine !== config.engine) { engine_net_seen = ''; update_engine_id(); }
    last_init_engine = config.engine;
    last_init_variant = config.variant;
    last_init_maia = config.maia_level;
    last_init_fp = fp;
    console.log('Engine ready!', engine);
}

async function fetch_nnue(engineBasePath, nnue) {
    // GitHub refuses blobs over 100MB, so oversized nets ship split into
    // `<name>.part0..N` chunks (plain byte splits); stitch them back together here.
    const whole = await fetch(`${engineBasePath}/${nnue}`).then(res => res.ok ? res.arrayBuffer() : null).catch(() => null);
    if (whole) return whole;
    const parts = [];
    for (let i = 0; ; i++) {
        const part = await fetch(`${engineBasePath}/${nnue}.part${i}`).then(res => res.ok ? res.arrayBuffer() : null).catch(() => null);
        if (!part) break;
        parts.push(part);
    }
    if (!parts.length) throw new Error(`NNUE not found: ${nnue} (neither whole file nor .partN chunks)`);
    const buffer = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    parts.reduce((offset, part) => {
        buffer.set(new Uint8Array(part), offset);
        return offset + part.byteLength;
    }, 0);
    return buffer.buffer;
}

function send_engine_uci(message) {
    if (message.startsWith('go ')) last_go = message;
    try {
        if (engine instanceof Worker) {
            engine.postMessage(message);
        } else if (engine && 'uci' in engine) {
            engine.uci(message);
        }
    } catch (e) {
        // wasm engine crashed on the main thread (e.g. RuntimeError: unaligned access / Aborted)
        on_engine_error(`${e}`);
    }
}

// Abandon the search in flight. UCI: `stop` makes the engine flush ONE bestmove for the position it
// was searching. By the time it lands, the position has moved on -- so it must be dropped, or it gets
// played as our move in a position it was never chosen for.
//
// Counted, not a flag: A->B->C arriving before bestmove(A) lands issues two flush-producing stops and
// so owes TWO bestmoves. A flag cleared by the first would let bestmove(B) through as a terminal
// result for the superseded position B. Only a search actually in flight flushes anything -- the
// engine ignores a `stop` with no `go` outstanding, so counting that would eat the NEXT real bestmove.
// Engine options that can only be set between searches. UCI forbids `setoption` while a search is
// running, and Threads/Hash in particular tear down and rebuild the engine's internal state.
//
// These used to force a full panel reload, which is why changing Threads mid-think restarted
// everything -- and why it threw away a captured position with it. They are recorded here instead
// and flushed immediately before the next `go`, once the previous search has been stopped. The
// search you are watching finishes on the settings it started with, which is the only coherent
// answer: changing the thread count under a running search would invalidate everything it has done.
let pending_engine_options = {};

function queue_engine_option(name, value) {
    pending_engine_options[name] = value;
}

// Called from on_new_pos AFTER abandon_search() and BEFORE the `go` -- the one window where UCI
// allows this.
function flush_engine_options() {
    const opts = pending_engine_options;
    pending_engine_options = {};
    for (const name in opts) {
        if (is_remote()) continue; // the native path sends these through request_remote_configure
        // Clamp HERE, not where the value was queued. The queue site can only see the engine that
        // was selected when the slider moved; this runs against the engine that will actually
        // receive it. A WASM heap is capped, so the 4 GB the slider allows has to come down to the
        // same 512 MB initialize_engine applies -- otherwise the queued value silently undoes it.
        const value = (name === 'Hash') ? Math.min(opts[name], 512) : opts[name];
        send_engine_uci(`setoption name ${name} value ${value}`);
        if (name === 'Threads') search_threads_set = value; // keep the per-turn tracker honest
        if (name === 'MultiPV') search_multipv_set = value;
    }
    return opts;
}

function abandon_search() {
    if (search_active) { pending_stops++; stop_charged_at = Date.now(); }
    search_active = false;
    remote_gen++; // a remote/native request still in flight is now for a position we've left
    // ...and release the native in-flight slot with it. Bumping remote_gen commits us to DROPPING
    // that request's result, so continuing to treat it as "the search covering this position" is
    // wrong by definition: send_analysis refuses to issue a second search while native_inflight
    // holds the same posKey, so the panel sat waiting on a result it had already decided to discard.
    //
    // That is what "toggling Autoplay breaks the engine" was. With Autoplay OFF the native budget is
    // an hour (`rt = 3600000`, the pure-analysis rail), and the watchdog that would free the slot is
    // only armed for `rt < 60000` -- so nothing came back and nothing new was issued until the
    // abandoned hour-long search finally answered. Clearing here is safe: both the `.finally` settle
    // and the watchdog re-check `native_inflight === posKey`, so neither can clobber a newer request.
    native_inflight = null;
    send_engine_uci('stop');
}

// Claim the current generation for a remote/native analysis about to be issued, and return a wrapper
// that only lets a callback run if that generation is STILL current. A host request is a promise, not
// a stream we can cancel -- `stop` does not unmake it, so a request issued for an old position still
// resolves, and before this guard its bestmove was played into whatever position had replaced it. In
// a puzzle that is a guaranteed miss: our move flips the board to their scripted reply, the reply
// lands, and the superseded search resolves two plies late.
function remote_result_gate() {
    const gen = ++remote_gen;
    return (fn) => (v) => {
        if (gen !== remote_gen) {
            console.log('Mephisto: dropping a superseded remote result (the position moved on)');
            return;
        }
        fn(v);
    };
}

// The restart budget is for a build that traps REPEATEDLY -- three crashes in quick succession mean
// the engine is not going to work here. It is NOT a lifetime allowance: this counter only ever went
// up, so three unrelated crashes spread over hours of play permanently disabled recovery and the
// panel told you to change engine while the engine was in fact fine. Cleared once the engine has run
// healthily for a while (see note_engine_healthy).
const ENGINE_HEALTHY_MS = 5 * 60 * 1000;
let engine_restarts = 0;
let engine_restarting = false;
let last_engine_crash_at = 0;

// Called whenever a search completes normally. A crash long ago says nothing about the engine now.
function note_engine_healthy() {
    if (!engine_restarts || engine_restarting) return;
    if (Date.now() - last_engine_crash_at < ENGINE_HEALTHY_MS) return;
    console.log(`Mephisto: engine healthy for ${Math.round(ENGINE_HEALTHY_MS / 60000)} min -- restart budget reset`);
    engine_restarts = 0;
}

function on_engine_error(message) {
    console.error(message);
    if (engine_restarting) return;
    // Two different things arrive here: a CRASH of a running engine (restartable, the regex below)
    // and a failure to LOAD one at all -- a missing net, a model that won't fetch, a bad build. The
    // second kind fell through the regex and was dropped, so the panel just sat on its progress bar
    // with the single most useful sentence already in hand. Say it, whatever kind it is.
    update_best_move(i18n('panel.msg.engine_error', 'Engine error - {detail}', {detail: String(message).slice(0, 120)}));
    if (!/RuntimeError|Aborted|worker sent an error/.test(String(message))) {
        engine_ready = false; // a load that failed is not a warm engine; make the next open re-init
        toggle_calculating(false); // nothing is coming, so stop pretending a search is running
        return;
    }
    if (engine_restarts >= 3) {
        // ponytail: cap restarts - a build that keeps trapping (some wasm builds on some machines) shouldn't loop forever
        update_best_move(i18n('panel.msg.engine_keeps_crashing', 'Engine keeps crashing - pick a different engine in Settings.'));
        return;
    }
    engine_restarts++;
    last_engine_crash_at = Date.now();
    engine_restarting = true;
    engine = null; // drop the dead instance; send_engine_uci becomes a no-op meanwhile
    engine_ready = false; // a reopen mid-restart must do a full init, not warm-reuse the dead engine
    update_best_move(i18n('panel.msg.engine_restarting', 'Engine crashed - restarting (attempt {n}/3)', {n: engine_restarts}));
    initialize_engine()
        .then(() => { last_eval = {fen: '', activeLines: 0, lines: []}; }) // force re-analysis on next fen poll
        .catch((e) => console.error('Engine restart failed:', e))
        .finally(() => engine_restarting = false);
}

// Is this move even possible in the position the panel is holding? chess.js THROWS on an illegal
// move rather than returning null, so the try/catch is the test. Unparseable (a variant chess.js
// does not know, a FEN we never had) counts as legal: this guard exists to catch a stale engine,
// not to become a second opinion on the rules.
function move_possible_here(fen, uci) {
    if (!fen || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci || '')) return true;
    try {
        const c = new Chess(config.variant, fen);
        return !!c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
    } catch (e) { return String(e).includes('Invalid move') ? false : true; }
}

let last_resync_at = 0;
const RESYNC_MIN_GAP_MS = 1500;   // one recovery per position change, not a storm of them

// WHEN THE ENGINE IS ANSWERING ABOUT A POSITION WE HAVE LEFT. The panel used to draw it anyway,
// which is how a move from a square holding the OPPONENT'S KING ends up on screen as "White to
// play, best move is g8...", and how an already-played rook move came back as an illegal
// suggestion. The scores and NPS keep updating from the same frames, so nothing looks broken --
// it just quietly says something impossible. Both were reported from live games.
// This cannot be repaired from here (the engine is mid-search on the wrong position), so treat it
// as what it is: we are out of sync. Stop, and ask the page for the position it has right now.
function engine_out_of_sync(best) {
    // While the panel owns its position -- a pasted FEN, and above all the screen reader re-reading
    // a board twice a second -- being a move behind is NORMAL: the next read supersedes this answer
    // on its own. Refusing to draw the impossible move is still right; announcing it is not.
    if (setup_fen) return;
    if (Date.now() - last_resync_at < RESYNC_MIN_GAP_MS) return;
    last_resync_at = Date.now();
    console.warn(`Mephisto: engine answered ${best}, impossible in ${last_eval.fen} -- re-syncing`);
    set_idle_reason(i18n('panel.msg.resyncing',
        'The engine answered for a different position - re-reading the board.'));
    abandon_search();
    last_eval.fen = '';
    fen_request_inflight = false;
    request_fen();
}

// WHEN A VARIANT IS ALREADY OVER. chess.js answers isCheckmate() for STANDARD rules only -- it is
// check plus no legal moves -- so every variant that ends another way went unnoticed and the panel
// kept analysing a finished game (reported live on an atomic position that was already won). Each
// rule below is that variant's own published win condition, read off the board:
//   atomic       a king that has been blown up is simply absent
//   antichess    losing everything, or having nothing to move, WINS
//   racingkings  a king that reached the eighth rank
//   kingofthehill a king that reached one of the four centre squares
//   horde        the horde loses when its last pawn goes
//   3check       the check counter in the FEN's own extra field reaches three
// Returns {winner: 'w'|'b'|null, reason} or null when the game is not over by a variant rule.
function variant_result(fen, variant) {
    try {
        if (!fen || !variant || variant === 'chess' || variant === 'fischerandom') return null;
        const board = new Chess(variant, fen);
        // chess.js does NOT throw on junk -- it quietly loads something else, and that something
        // can be missing a king, which would announce a won game from a typo. Trust the position
        // only if the placement we handed it is the placement it now holds.
        if (board.fen().split(' ')[0] !== fen.split(' ')[0]) return null;
        const rows = board.board();
        const kingSq = (color) => {
            for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
                const p = rows[r][f];
                if (p && p.type === 'k' && p.color === color) return {file: f, rank: 7 - r};
            }
            return null;
        };
        const wk = kingSq('w'), bk = kingSq('b');
        if (variant === 'atomic') {
            if (!bk) return {winner: 'w', reason: 'black king destroyed'};
            if (!wk) return {winner: 'b', reason: 'white king destroyed'};
        }
        if (variant === 'racingkings') {
            // both kings reaching the last rank is a draw, and chess.js already forbids a move that
            // lets black follow white in -- so a single king on rank 8 is the whole condition
            if (wk && wk.rank === 7) return {winner: 'w', reason: 'king reached the eighth rank'};
            if (bk && bk.rank === 7) return {winner: 'b', reason: 'king reached the eighth rank'};
        }
        if (variant === 'kingofthehill') {
            const hill = (k) => k && k.rank >= 3 && k.rank <= 4 && k.file >= 3 && k.file <= 4;
            if (hill(wk)) return {winner: 'w', reason: 'king reached the centre'};
            if (hill(bk)) return {winner: 'b', reason: 'king reached the centre'};
        }
        if (variant === 'horde') {
            const hordePawns = rows.flat().some(p => p && p.color === 'w' && p.type === 'p');
            if (!hordePawns) return {winner: 'b', reason: 'the horde is gone'};
        }
        if (variant === 'antichess') {
            // giving everything away is the win condition, and so is having no move at all
            const left = (color) => rows.flat().some(p => p && p.color === color);
            if (!left('w')) return {winner: 'w', reason: 'all pieces given away'};
            if (!left('b')) return {winner: 'b', reason: 'all pieces given away'};
            if (board.moves().length === 0) {
                const stm = fen.split(' ')[1];
                return {winner: stm, reason: 'no moves left'};
            }
        }
        if (variant === '3check') {
            // the counter rides in the FEN's own extra field, e.g. "+2+1" (white's, then black's)
            const m = /\s\+(\d)\+(\d)\s*$/.exec(fen);
            if (m) {
                if (+m[1] >= 3) return {winner: 'w', reason: 'three checks delivered'};
                if (+m[2] >= 3) return {winner: 'b', reason: 'three checks delivered'};
            }
        }
        return null;
    } catch (e) {
        return null;   // a position chess.js cannot read is not a verdict
    }
}

function on_engine_best_move(best, threat, isTerminal=false) {
    if (is_remote()) {
        last_eval.activeLines = last_eval.lines.length;
    }
    // The search is over, so whatever was held back for being shallow is the final word on this
    // position -- draw it rather than leaving the bar showing the move before.
    if (isTerminal) flush_held_eval();

    console.log('EVALUATION:', JSON.parse(JSON.stringify(last_eval)));
    const piece_name_map = {
        P: i18n('piece.pawn', 'Pawn'), R: i18n('piece.rook', 'Rook'), N: i18n('piece.knight', 'Knight'),
        B: i18n('piece.bishop', 'Bishop'), Q: i18n('piece.queen', 'Queen'), K: i18n('piece.king', 'King'),
    };
    const white = i18n('color.white', 'White'), black = i18n('color.black', 'Black');
    const toplay = (turn === 'w') ? white : black;
    const next = (turn === 'w') ? black : white;
    // A variant that has already been won ends the analysis, whatever the engine still has to say:
    // its search has no notion of an exploded king or a third check, so it happily reports a move
    // in a finished game (reported live on a won atomic position).
    const vres = variant_result(last_eval.fen, config.variant);
    if (vres) {
        const side = vres.winner === 'w' ? white : black;
        update_evaluation(i18n('panel.msg.variant_over', 'Game over'));
        update_best_move(i18n('panel.msg.wins', '{side} Wins', {side}) + ` - ${vres.reason}`);
        clear_next_move_eta();
        toggle_calculating(false);
        return;
    }
    if (!best || best === '(none)') { // game over (or crashed search) - there is no move to draw or play
        const pvLine = last_eval.lines[0] || {};
        if ('mate' in pvLine) {
            update_evaluation(i18n('panel.msg.checkmate', 'Checkmate!'));
            if (config.variant === 'antichess') {
                update_best_move(i18n('panel.msg.wins', '{side} Wins', {side: toplay}));
            } else {
                update_best_move(i18n('panel.msg.wins', '{side} Wins', {side: next}));
            }
        } else {
            update_evaluation(i18n('panel.msg.stalemate', 'Stalemate!'));
            if (config.variant === 'antichess') {
                update_best_move(i18n('panel.msg.wins', '{side} Wins', {side: toplay}));
            } else {
                update_best_move(i18n('panel.msg.draw', 'Draw'));
            }
        }
        clear_next_move_eta(); // game over: no move coming, drop any countdown started at search time
        toggle_calculating(false);
        return;
    } else if (!move_possible_here(last_eval.fen, best)) {
        // not our position any more: draw nothing, play nothing, and get back in step
        engine_out_of_sync(best);
        return;
    }
    // The tablebase pick will BE the played move -- it outranks the engine at play time -- so the
    // readout must announce IT. The panel used to say the engine's pick while autoplay made the
    // tablebase's, which read as "it plays a different move" (reported live, 2026-08-25). One
    // substitution HERE keeps the readout, last_eval.bestmove, premove certification and the
    // safety net all talking about the move that actually gets made.
    {
        const tb_show = tablebase_pick(last_eval.fen);
        if (tb_show && move_possible_here(last_eval.fen, tb_show)) best = tb_show;
    }
    if (config.simon_says_mode) {
        if (toplay.toLowerCase() === our_side()) {
            const startSquare = best.substring(0, 2);
            const startPiece = board.position()[startSquare];
            const startPieceType = (startPiece) ? startPiece.substring(1) : null;
            if (startPieceType) {
                update_best_move(piece_name_map[startPieceType]);
            }
        } else {
            update_best_move('');
        }
    } else {
        // Threat Analysis draws the red arrow (draw_threat) -- it no longer prints a second text
        // line; the "Best response for ..." readout was removed.
        // Pondering the opponent's turn (their move, ponder on): flag it so the live readout reads
        // "Pondering -- Black to play, ..." rather than looking like a stalled search on our move.
        // Maia is a single forward pass -- it can't deepen, so it never really ponders; every other
        // engine (WASM, native SF/Fairy, remote) does.
        const pondering = config.ponder && toplay.toLowerCase() !== our_side()
            && !is_one_pass();
        update_best_move(`${pondering ? i18n('panel.msg.pondering', 'Pondering - ') : ''}` + i18n('panel.msg.to_play_best', '{side} to play, best move is {move}', {side: toplay, move: notate(last_eval.fen, best)}));
    }

    if (toplay.toLowerCase() === our_side()) {
        last_eval.bestmove = best;
        last_eval.threat = threat;
        last_eval.humanReply = null;    // belongs to the previous best move until re-asked
        // the net's own Maia read is per POSITION, not per best move -- keep it while the fen holds
        if (last_eval.humanSelf && last_eval.humanSelf.fen !== last_eval.fen) last_eval.humanSelf = null;
        request_threat_human(last_eval.fen, best);
        request_second_opinion(last_eval.fen, best);
        request_safety_net_human(last_eval.fen);
        if (config.simon_says_mode) {
            const startSquare = best.substring(0, 2);
            if (board.position()[startSquare] == null) {
                // The current best move is stale so abort! This happens when the opponent makes a move in
                // the middle of continuous evaluation: the engine isn't done evaluating the opponent's
                // position and ends up returning the opponent's best move on our turn.
                return;
            }
            const startPiece = board.position()[startSquare].substring(1);
            if (last_eval.lines[0] != null) {
                if ('mate' in last_eval.lines[0]) {
                    request_console_log(`${piece_name_map[startPiece]} ==> #${last_eval.lines[0].mate}`);
                } else {
                    request_console_log(`${piece_name_map[startPiece]} ==> ${last_eval.lines[0].score / 100.0}`);
                }
            }
            if (config.threat_analysis) {
                clear_annotations();
                draw_threat();
                draw_human_reply();
            }
            draw_safety_net();   // its own toggle -- the net is not a threat feature
        }
        // Manual Mode plays on YOUR keypress and nothing else. It normally never reaches here because
        // its search is `go infinite` and so emits no bestmove -- but Maia/Maia-3 are a single forward
        // pass that answers a `go` regardless of the limit, so on those engines Manual Mode was
        // autoplaying by itself. State the contract here instead of relying on the engine to withhold
        // a bestmove, the way every other move-path guard already lists the mode.
        if (isTerminal) {
            bgTrace('bestmove', {best, autoplay: config.autoplay, help: config.help_mode,
                manual: config.manual_mode});
        }
        // Every reason autoplay can decline, said out loud in the PAGE console. This is the last
        // silent branch in the move path: a terminal bestmove arrives, the gate refuses, and nothing
        // is printed anywhere -- which is indistinguishable from the engine never answering.
        if (isTerminal && config.autoplay && !config.help_mode && !config.manual_mode
                && !premove_reply_playable(last_eval.fen, best)) {
            const f = String(last_eval.fen || '');
            console.warn('Mephisto: NOT autoplaying', best, '-- premove_reply_playable said no.',
                {fen: f, sideToMove: f.split(' ')[1], ourSide: our_side(),
                 pieceOnFrom: (() => { try { return new Chess(config.variant, f).get(best.slice(0, 2)); }
                                       catch (e) { return 'unreadable'; } })()});
        }
        if (isTerminal && config.autoplay && (config.help_mode || config.manual_mode)) {
            console.warn('Mephisto: NOT autoplaying', best,
                config.help_mode ? '-- Help Mode is on' : '-- Manual Mode is on');
        }
        if (!config.help_mode && !config.manual_mode && config.autoplay && isTerminal) {
            // SAFETY: only autoplay a move that actually moves OUR piece and is legal right now.
            // If the turn was mis-scraped we'd otherwise play the opponent's best move as ours.
            // AUTO RESIGN / AUTO DRAW go in FRONT of the move: a game we are ending is not one we
            // are still making moves in. Both off unless switched on, and null until a threshold has
            // actually been crossed. A draw is OFFERED and the move still gets played -- that is what
            // offering a draw is -- so only a resignation takes the move away.
            const ending = maybe_end_game();
            if (ending === 'resign') {
                console.log('Mephisto: not playing a move into a game we have resigned');
            } else if (premove_reply_playable(last_eval.fen, best)) {
                // humanize: maybe swap in a close alternative + a human-looking think delay;
                // a clock-aware mode alone still shapes the timing
                // a clock-aware mode alone still shapes the timing (budget / opponent mirror).
                // Never in puzzle mode, whose PV playback must follow the engine line exactly.
                // Book move (weighted random over the human distribution) outranks the engine's pick
                // while we're still in book -- Move priority: Puzzle DB > Tablebase > Book > Humanize > engine.
                // It only
                // replaces WHICH move is played; the timing below is untouched, so Clock/Mirror/
                // Humanize still pace it exactly as they would have. Null whenever the lookup hasn't
                // landed, we're out of book, or every candidate failed the games/engine filters.
                const book = book_pick(last_eval.fen);
                if (book && !premove_reply_playable(last_eval.fen, book)) {
                    console.warn('Mephisto: ignoring a book move that is not ours/legal here:', book);
                }
                // Tablebase outranks everything: at <=7 men the position is SOLVED, so this is not a
                // preference the engine could out-search, it is the move. Same shape as the book --
                // it replaces only WHICH move is played, never the timing, so Clock/Mirror/Humanize
                // still pace it exactly as they would have. Null whenever the probe is off, out of
                // range, or hasn't landed yet, in which case nothing here changes.
                const tb = tablebase_pick(last_eval.fen);
                if (tb && !premove_reply_playable(last_eval.fen, tb)) {
                    console.warn('Mephisto: ignoring a tablebase move that is not ours/legal here:', tb);
                }
                // No puzzle-database branch here on purpose: a position the database knows is played
                // by maybe_play_puzzle_move before any search starts, so if we have reached a
                // bestmove at all, the database did not have this position.
                const tb_ok = tb && premove_reply_playable(last_eval.fen, tb);
                // Playstyle sits UNDER the book and the tablebase and OVER the bare engine pick:
                // both of those are facts about the position, while a style is a preference between
                // moves the engine already called equal. Move only -- the timing below is untouched.
                const styled = playstyle_pick(best);
                if (styled !== best && !premove_reply_playable(last_eval.fen, styled)) {
                    console.warn('Mephisto: ignoring a playstyle move that is not ours/legal here:', styled);
                }
                const style_ok = styled !== best && premove_reply_playable(last_eval.fen, styled);
                // CONTEMPT sits ABOVE the playstyle and below the two facts: a style is a preference
                // between moves the engine already called equal, while contempt is a decision about
                // how the GAME ends. Move only -- the timing below is untouched, like the rest.
                const fought = contempt_pick(best);
                const fight_ok = fought !== best && premove_reply_playable(last_eval.fen, fought);
                if (fought !== best && !fight_ok) {
                    console.warn('Mephisto: ignoring a contempt move that is not ours/legal here:', fought);
                }
                const played = tb_ok ? tb
                    : (book && premove_reply_playable(last_eval.fen, book)) ? book
                    : fight_ok ? fought
                    : style_ok ? styled : best;
                if (fight_ok && !tb_ok && !book) console.log(`Contempt (${contempt_cp()}cp): playing ${fought} over ${best}, which draws on the spot`);
                if (style_ok && !fight_ok && !tb_ok && !book) console.log(`Playstyle (${config.playstyle}): playing ${styled} over ${best}`);
                if (tb_ok && tb !== best) console.log(`Tablebase: playing ${tb} over ${best} (solved position)`);
                if (!tb_ok && played !== best) console.log(`Book: playing ${played} over ${best} (weighted random)`);
                if ((config.humanize || clock_aware()) && !config.puzzle_mode) {
                    const pick = humanize_pick(best);
                    // tb_ok must be explicit here: now that the readout substitutes the tablebase
                    // move into `best`, played === best on a tablebase hit -- and without this,
                    // humanize's roll could override a SOLVED position's move
                    if (tb_ok || played !== best) pick.move = played; // book/tablebase win the move, humanize keeps the clock
                    if (pick.move !== best) console.log(`Humanize: playing ${pick.move} over ${best}`);
                    // the search already burned most of the intended think (on_new_pos sized it to
                    // the pace), so only wait out the RESIDUAL -- never idle time the engine could
                    // have spent searching. Clock-aware paces are largely consumed by the search;
                    // a pure-humanize long think still waits here (its search stayed at the default).
                    const elapsed = Date.now() - search_start;
                    const residual = Math.max(0, Math.round(pick.think - elapsed));
                    // re-anchor the countdown to the AUTHORITATIVE total (search_start + think) and
                    // add the move category -- it keeps counting the full time down to the play, so
                    // the move fires exactly when the countdown hits zero.
                    set_move_countdown(search_start + pick.think, pick.source, pick.category);
                    request_automove(pick.move, residual);
                } else {
                    request_automove(played); // in help mode draw_moves() mirrors the arrows instead
                }
            } else {
                console.warn('Mephisto: not autoplaying a move that is not ours/legal here:', best);
            }
        }
    }

    render_move_reason(best); // opt-in; renders nothing at all when the toggle is off

    if (!config.simon_says_mode) {
        draw_moves();
        if (config.threat_analysis) {
            draw_threat();
            draw_human_reply();
        }
        draw_safety_net();   // its own toggle -- the net is not a threat feature
    }

    note_engine_healthy(); // a search that finished is the only evidence the engine is well
    toggle_calculating(false);
}

// A drawn bar for a position no engine evaluated (a puzzle answered straight from the database).
// Deliberately NOT record_eval_history: 0.5 here means "not measured", and writing it into the
// history strip would draw it as a measured equality alongside real scores.
function draw_eval_bar_unevaluated() {
    const bar = PANEL_ROOT.getElementById('eval-bar-white');
    if (bar) {
        if (bar.style.background) {
            bar.style.background = '';
            const wrap = PANEL_ROOT.getElementById('eval-bar');
            if (wrap) wrap.style.background = '';
        }
        const flipped = board.orientation() === 'black';
        bar.style.top = flipped ? '0' : 'auto';
        bar.style.bottom = flipped ? 'auto' : '0';
        bar.style.height = '50%';
    }
    // THE BAR IS NOT THE ONLY THING THIS MESSAGE DRAWS. The graph and the Live Stats strip ride on
    // it, so gating the send on the bar's own toggle meant Live Stats (and the graph) drew nothing
    // at all with the bar off -- with their own switch on. Each rider is already null-gated on its
    // own setting; `bar` says whether the bar itself is wanted.
    if (config.eval_bar || config.eval_history || config.live_stats) {
        request_draw_eval_bar({frac: 0.5, text: '0.0', winningWhite: true, bar: !!config.eval_bar,
                               history: config.eval_history ? eval_history : null,
                               stats: config.live_stats ? live_stats(eval_history) : null,
                               phases: null});
    }
}

// A NEW POSITION IS NOT AN EVALUATION YET. The first iterations of a search are worth nothing --
// depth 1 is a static eval with one ply on top -- and painting them made the bar snap to 0.0 and
// back on every move, worst exactly when the machine is busy and those first iterations arrive
// slowly. So the bar (and the history strip the graders read) holds the LAST settled reading until
// the new search has reached this depth. Not a smoothing: nothing is averaged or invented, the
// previous measurement simply stands until there is a real one to replace it.
// 6, not 8: any engine that searches at all reaches it, even on a 10ms budget, so the hold costs
// nothing to a real search while still skipping the static-eval iterations that caused the jump.
const EVAL_MIN_DEPTH = 6;
// ...and the nets that do not search are exempt outright. Maia is ONE forward pass: depth 1 is not
// an early iteration of a deeper answer, it IS the answer, so holding it would hold it forever.
const NO_DEPTH_ENGINES = ONE_PASS_ENGINES;   // named for what the hold cares about
let eval_bar_fen = '';        // the position the bar is currently showing
let held_eval_line = null;    // the newest reading withheld for being too shallow

// Whatever was withheld, drawn anyway: a search that ENDED below the floor (a short movetime, a
// one-pass Maia, a cloud engine that reports no depth at all) is all the evaluation this position
// is ever going to get, and holding it forever would leave the bar a move behind.
function flush_held_eval() {
    const line = held_eval_line;
    held_eval_line = null;
    if (line) update_eval_bar(line, true);
}

function update_eval_bar(line, force = false) {
    const bar = PANEL_ROOT.getElementById('eval-bar-white');
    if (!bar || !line) return;
    const depth = Number.isFinite(line.depth) ? line.depth : 0;
    if (!force && depth < EVAL_MIN_DEPTH && !NO_DEPTH_ENGINES.includes(config.engine)
        && eval_bar_fen && eval_bar_fen !== last_eval.fen) {
        held_eval_line = line;   // the position moved on and this reading is too shallow to show
        return;
    }
    // Reclaim the colours if the 4PC lane painted this bar red/blue. Those are inline styles on the
    // same two elements, so without this a normal game inherits Team Red vs Team Blue until the panel
    // happens to be rebuilt.
    if (bar.style.background) {
        bar.style.background = '';
        const wrap = PANEL_ROOT.getElementById('eval-bar');
        if (wrap) wrap.style.background = '';
    }
    let frac; // white's share of the bar; scores/mates are white-relative here
    if ('mate' in line) {
        // mate 0 = the side to move IS checkmated, so the sign carries no direction
        frac = (line.mate === 0) ? ((turn === 'w') ? 0 : 1) : ((line.mate > 0) ? 1 : 0);
    } else {
        const winning_chance = 2 / (1 + Math.exp(-0.00368 * line.score)) - 1; // lichess curve, cp -> [-1,1]
        frac = Math.max(0.03, Math.min(0.97, 0.5 + winning_chance / 2));
    }
    // mirror the player's perspective like lichess: the bar's bottom belongs to the bottom player,
    // so when playing black the white share hangs from the top and black grows from the bottom.
    // (the TEXT eval stays white-relative on purpose -- positive is always good for white.)
    const flipped = board.orientation() === 'black';
    bar.style.top = flipped ? '0' : 'auto';
    bar.style.bottom = flipped ? 'auto' : '0';
    bar.style.height = `${frac * 100}%`;

    // Eval history: one entry per POSITION seen this game, as the same 0..1 white-share the live bar
    // uses, so the strip and the bar are the same quantity drawn two ways. Keyed by the position's
    // move count so a re-analysis of the same position overwrites rather than appends -- the panel
    // re-evaluates constantly (every info line, every fallback poll) and appending would turn a
    // 40-move game into thousands of bands.
    record_eval_history(frac);

    // mirror the bar onto the site board (chess.com-style: score inside, on the winning side's end)
    if (config.eval_bar || config.eval_history || config.live_stats) {
        const text = ('mate' in line) ? `M${Math.abs(line.mate)}` : (Math.abs(line.score) / 100).toFixed(1);
        request_draw_eval_bar({frac, text, winningWhite: frac >= 0.5, bar: !!config.eval_bar,
                               history: config.eval_history ? eval_history : null,
                               stats: config.live_stats ? live_stats(eval_history) : null,
                               phases: config.eval_history
                                   ? game_phases(premove_tracker.startFen, premove_tracker.moves) : null});
    }
    eval_bar_fen = last_eval.fen;   // what the bar now shows, so the next position knows to hold
    held_eval_line = null;
}

// Below this much search, the engine's nodes/elapsed is dividing by a 0-1ms integer and the answer
// is noise rather than a speed (see nps_is_trustworthy).
const NPS_MIN_MS = 50;
// Nothing reaches 30M nps -- not even a native build with every thread. Anything above it is the
// same divide-by-almost-zero artifact wearing a plausible-looking number.
const NPS_MAX = 30_000_000;

// Is this line's nps a real speed, or the artifact?
//
// Elapsed is derived as nodes/nps rather than read from the info's own `time`, because that field's
// UNIT depends on which engine path produced it: the WASM engines are parsed straight from raw UCI,
// where `time` is INTEGER MILLISECONDS, while the native + remote hosts go through python-chess,
// which does `info["time"] = int(time_ms) / 1000.0` -- FLOAT SECONDS. A single threshold can't mean
// both, and gating on it hid nps entirely on every native engine. nodes/nps is the engine's own
// elapsed whichever path it came from, and needs no unit at all.
function nps_is_trustworthy(line) {
    if (!Number.isFinite(line.nps) || line.nps <= 0 || line.nps > NPS_MAX) return false;
    if (!Number.isFinite(line.nodes) || line.nodes <= 0) return true; // can't derive: the cap stands alone
    return (line.nodes / line.nps) * 1000 >= NPS_MIN_MS;
}

// nodes/second, grouped Swiss-style: 1019100 -> "1'019'100 NPS" (so you can see engine speed)
function format_nps(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'") + ' NPS';
}

function on_engine_evaluation(info) {
    if (!info.lines[0]) return;
    update_eval_bar(info.lines[0]);

    // nps is nodes/elapsed, so the opening instants of a search divide by ~0 and report impossible
    // speeds -- one real report read 843'779'000 NPS, which is exactly 843'779 nodes "in 1ms". Show
    // it only once it's believable (see nps_is_trustworthy); until then keep the last good value.
    const npsEl = PANEL_ROOT.getElementById('nps');
    const l0 = info.lines[0];
    if (npsEl && nps_is_trustworthy(l0)) {
        npsEl.textContent = format_nps(l0.nps);
        // Calibration samples ride the same filter -- it already rejects the impossible readings the
        // opening milliseconds of a search produce. Depth-gated on top: an early iteration's nps is
        // real but unrepresentative, and the point is to measure this machine at speed.
        if (Number.isFinite(l0.depth) && l0.depth >= 12) { record_nps_sample(l0.nps); record_advice_nps(l0.nps); }
    }
    if ('mate' in info.lines[0]) {
        update_evaluation(`Checkmate in ${info.lines[0].mate}`);
    } else {
        update_evaluation(`Score: ${info.lines[0].score / 100.0} at depth ${info.lines[0].depth}`)
    }
    render_wdl(info.lines[0]);
    render_alt_lines();

    // track this position's eval (white-relative cp + depth) for the opponent-mistake alert
    const l0d = info.lines[0];
    if (l0d && Number.isFinite(l0d.depth)) {
        const cpWhite = ('mate' in l0d) ? (l0d.mate > 0 ? 100000 : -100000) : l0d.score; // score is white-relative
        last_pos_eval = {fen: last_eval.fen, cpWhite, depth: l0d.depth, sideToMove: turn};
        opp_alert_maybe_fire();
    }
}

// Win/Draw/Loss line under the score, from the engine's own UCI_ShowWDL output. `wdl` is
// [white, draw, black] in permille. Shown from YOUR side (board orientation) so your colour is
// always listed first and the order stays put across moves. Blank for engines that don't report
// it (SF11, Fairy, remote engines without a WDL model) so the row just collapses.
function render_wdl(line) {
    const el = PANEL_ROOT.getElementById('wdl');
    if (!el) return;
    const wdl = line && line.wdl;
    if (!Array.isArray(wdl) || wdl.length !== 3) { el.textContent = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    const whitePct = (wdl[0] / 10).toFixed(1);
    const drawPct = (wdl[1] / 10).toFixed(1);
    const blackPct = (100 - wdl[0] / 10 - wdl[1] / 10).toFixed(1); // derive third -> always sums to 100
    const w = `White ${whitePct}%`, d = `Draw ${drawPct}%`, b = `Black ${blackPct}%`;
    el.textContent = (board.orientation() === 'black') ? `${b} | ${d} | ${w}` : `${w} | ${d} | ${b}`;
}

// One distinct colour per engine line, so with Multi Lines on you can tell which arrow is which:
// line 1 (best) blue, then green / amber / orange / purple for 2nd..5th. Used for the arrows on BOTH
// the panel board and (in Help Mode) the site board, and echoed on the alternative-lines panel so it
// reads as a legend -- the green row is the green arrow. Was: line 1 blue, every other line the same
// grey, so 2nd/3rd/4th/5th were indistinguishable.
const LINE_COLORS = ['#0a5bd3', '#0f9d58', '#e0a400', '#e8710a', '#9333ea'];
// The forced chain's own ramps, deliberately not LINE_COLORS: those mean "the engine's Nth choice",
// and reusing them would say a forced reply was an alternative you could pick.
//
// TWO ramps, one per side. Whose move an arrow is matters more than how deep it sits -- a chain
// drawn in one colour reads as one player's plan, when half of it is the reply being forced OUT of
// the opponent. Ours cool through blue, theirs through violet, and each ramp still darkens with
// depth so the order inside a side is readable without a legend.
// Magenta for ours, teal for theirs (user call 2026-08-14): the old blue/violet ramps sat next to
// line #1's blue and line #5's purple in LINE_COLORS and read as engine lines on a busy board.
// Neither magenta nor teal appears anywhere in LINE_COLORS or the red threat arrow.
const FORCED_COLORS_OURS   = ['#d81b8c', '#c01578', '#a81064'];
const FORCED_COLORS_THEIRS = ['#00a693', '#00907f', '#007a6b'];
// The whole-PV walk is GREY, one hue for both sides: nothing in it is certain -- it is the
// engine's current line, revisable at the next depth -- so it must not wear either the certainty
// ramps above or a LINE_COLORS hue. Thin and numbered, drawn under everything else.
const PV_WALK_COLOR = '#8f8f8f';

// USER ARROW COLOURS (Appearance page): every arrow family can be re-coloured -- a '#rrggbb'
// string in config; anything else (empty field, junk) falls back to the shipped default above,
// so a cleared setting can never draw an invisible arrow. The forced ramps derive their darker
// shades from the base, so one picker recolours a whole family and the depth-read survives.
const ARROW_COLOR_KEYS = ['arrow_color_line1', 'arrow_color_line2', 'arrow_color_line3',
    'arrow_color_line4', 'arrow_color_line5', 'arrow_color_forced_ours',
    'arrow_color_forced_theirs', 'arrow_color_pv_walk', 'arrow_color_threat', 'arrow_color_book',
    'arrow_color_human_reply', 'arrow_color_safety_net', 'arrow_color_tb', 'arrow_color_refute'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function user_color(key, dflt) { const v = config && config[key]; return HEX_COLOR_RE.test(v || '') ? v : dflt; }
function shade_hex(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const d = (c) => Math.max(0, Math.round(c * (1 - f)));
    return '#' + [d((n >> 16) & 255), d((n >> 8) & 255), d(n & 255)].map(c => c.toString(16).padStart(2, '0')).join('');
}
function forced_ramp(ours) {
    const base = config && config[ours ? 'arrow_color_forced_ours' : 'arrow_color_forced_theirs'];
    if (!HEX_COLOR_RE.test(base || '')) return ours ? FORCED_COLORS_OURS : FORCED_COLORS_THEIRS;
    return [base, shade_hex(base, 0.14), shade_hex(base, 0.28)];
}

function line_color(i) { const idx = Math.min(i, LINE_COLORS.length - 1); return user_color('arrow_color_line' + (idx + 1), LINE_COLORS[idx]); }

// Is this search budgeted by DEPTH rather than by the clock? Open-ended searches (Help Mode, Manual
// Mode, pondering) are neither -- they run until the position changes -- so this only ever decides
// between `go depth` and `go movetime`.
function searching_by_depth() {
    return config.search_mode === 'depth' && config.compute_depth > 0;
}

// HOW LONG AN OPEN-ENDED SEARCH RUNS. With Autoplay off (or Help/Manual Mode, or a ponder) there is
// no move to play, so the search has always been `go infinite` -- it deepens until the position
// changes. That is the right default and it stays the default: position 61, the far right of the
// slider, IS infinite in every mode.
//
// One slider, three meanings, because a budget is one idea: the mode says which unit the position is
// read in. Nodes are logarithmic (1M to 1B is three decades; a linear slider would spend 59 of its
// 60 stops above 100M), the other two are the unit itself.
//
// KEEP IN STEP WITH general.js's copy, which draws the readout from the same numbers -- the options
// page is an ES module and the panel is a content script, so there is no file both can import. The
// ladder runs BOTH and asserts they agree on all 61 positions in all three modes.
const ANALYSIS_LIMIT_MAX = 61;                 // the position that means "no limit"
const ANALYSIS_LIMIT_MODES = ['time', 'depth', 'nodes'];
function analysis_limit_value(mode, pos) {
    const p = Math.max(1, Math.min(ANALYSIS_LIMIT_MAX, Math.round(Number(pos) || ANALYSIS_LIMIT_MAX)));
    if (p >= ANALYSIS_LIMIT_MAX) return null;  // infinite
    if (mode === 'depth') return p;                       // plies, 1-60
    if (mode === 'nodes') {                               // 1e6 .. 1e9, log-spaced over 1-60
        return Math.round(1e6 * Math.pow(1000, (p - 1) / 59));
    }
    return p * 1000;                                      // time: 1-60 seconds, in ms
}

// The `go` arguments for an analysis search, or null when it is unlimited (`go infinite`).
function analysis_go_args() {
    const v = analysis_limit_value(config.analysis_limit_mode, config.analysis_limit);
    if (v == null) return null;
    if (config.analysis_limit_mode === 'depth') return `depth ${v}`;
    if (config.analysis_limit_mode === 'nodes') return `nodes ${v}`;
    return `movetime ${v}`;
}

// What the shared stepper means in each mode. The step matters as much as the range: 25 is a
// sensible nudge in milliseconds and nonsense in plies.
const SEARCH_BOUNDS = {
    time:  {key: 'compute_time',  min: 50, max: 30000, step: 25},
    depth: {key: 'compute_depth', min: 1,  max: 60,    step: 1},
};

// Point the one stepper at the setting the dropdown currently names.
function apply_search_mode_ui() {
    const sel = PANEL_ROOT.getElementById('qs_search_mode');
    const box = PANEL_ROOT.getElementById('qs_search');
    if (!box) return;
    const b = SEARCH_BOUNDS[config.search_mode] || SEARCH_BOUNDS.time;
    if (sel) sel.value = config.search_mode;
    box.min = b.min; box.max = b.max; box.step = b.step;
    box.value = config[b.key];
}

// pv arrives as a space-joined STRING from the wasm engines but can be a LIST of UCI moves from a
// native/remote host (python-chess formats pv as an array) -- normalize before any .split use
function pv_moves(pv) {
    return Array.isArray(pv) ? pv.map(String) : (pv || '').split(' ');
}

// ONE move, in whichever notation is configured. Everything that writes a move for a human to read
// goes through here or through line_preview below, so the setting cannot be honoured in some places
// and forgotten in others.
//
// SAN needs the position the move is played FROM -- that is what makes it short -- so a caller with
// no fen gets UCI back rather than a guess. UCI is also the fallback on any parse failure: a raw
// `g1f3` is still a readable move, where an empty string is a bug that looks like a missing answer.
function notate(fen, uci) {
    if (!uci || typeof uci !== 'string') return uci || '';
    if (config.move_notation === 'uci' || !fen) return uci;
    try {
        const mv = new Chess(config.variant, fen)
            .move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
        return mv?.san || uci;
    } catch (e) {
        return uci;
    }
}

// first few moves of a UCI pv, in the configured notation, for the alternative-lines panel
function san_preview(fen, pv, plies = 6) {
    const ucis = pv_moves(pv).slice(0, plies);
    if (config.move_notation === 'uci') return ucis.join(' ');
    try {
        const chess = new Chess(config.variant, fen);
        return ucis.map(u => chess.move({from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4]}).san).join(' ');
    } catch (e) {
        return ucis.join(' '); // variant/parse hiccup -> raw UCI is still useful
    }
}

// the panel under the board: one row per engine line (eval + start of the line) when the
// Multi Lines slider asks for more than one; hidden otherwise
// The overlay. Draws the opening name and the most-played replies with their win/draw/loss split,
// straight from the database -- it reflects what the lookup returned and never decides anything.
function render_explorer() {
    const panel = PANEL_ROOT.getElementById('book-lines');
    if (!panel) return;
    // show the block whenever the explorer is on and we have either data OR something to report
    const show = config.explorer && (explorer_data?.moves?.length || explorer_error || explorer_out_of_book);
    panel.style.display = show ? '' : 'none';
    apply_explorer(!!show); // grow/shrink the fixed-size panel box to match
    if (!show) { panel.innerHTML = ''; return; }
    if (!explorer_data?.moves?.length) { // no book data -- say WHY rather than render an empty box
        panel.innerHTML = `<div class="bk-opening">${explorer_error
            ? `Explorer unavailable (${explorer_error})` : 'Out of book'}</div>`;
        return;
    }
    const rows = [];
    if (explorer_data.opening?.name) {
        const eco = explorer_data.opening.eco ? `${explorer_data.opening.eco} ` : '';
        rows.push(`<div class="bk-opening">${eco}${explorer_data.opening.name}</div>`);
    }
    for (const m of explorer_data.moves.slice(0, 5)) {
        const w = m.white || 0, d = m.draws || 0, b = m.black || 0, n = w + d + b;
        if (!n) continue;
        const pct = v => Math.round(100 * v / n);
        // W/D/L is always White's side of it, matching how the database reports it
        rows.push(`<div class="bk-line"><b>${m.san}</b> ` +
            `<span class="bk-pct">${pct(w)}/${pct(d)}/${pct(b)}%</span> ` +
            `<span class="bk-pct">(${n.toLocaleString()})</span></div>`);
    }
    panel.innerHTML = rows.join('');
    draw_book_moves();
}

// The panel is a fixed-size box the content script scales, so showing the overlay can't enlarge it
// on its own -- same problem compact mode has, and the same fix (see setPanelBook).
function apply_explorer(show) {
    panel_body()?.classList.toggle('mephisto-book', !!show);
    self.MephistoContent?.setPanelBook?.(!!show);
}

function render_alt_lines() {
    const panel = PANEL_ROOT.getElementById('alt-lines');
    if (!panel) return;
    if (config.multiple_lines <= 1) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = '';
    const rows = [];
    for (let i = 0; i < config.multiple_lines; i++) {
        const line = last_eval.lines?.[i];
        if (!line || !line.pv) continue;
        // A HUMAN MODEL ANSWERS A DIFFERENT QUESTION, so it gets a different number. Maia scores the
        // position once and puts the same eval on every line, so this column read as five copies of
        // one number; what actually differs between its lines is how likely each move is, which the
        // net has always known and now sends (`maiaprob`, in ten-thousandths -- see maia.js). The
        // percentage is the chance out of EVERY legal move, so a few lines summing to under 100 is
        // the truth rather than a rounding error.
        const evalTxt = (line.maiaprob != null) ? `${(line.maiaprob / 100).toFixed(1)}%`
            : ('mate' in line) ? `#${line.mate}` : (line.score / 100).toFixed(2);
        // colour the eval to match this line's board arrow, so the panel is a legend for the arrows.
        // inline style -- beats the dark-mode `#alt-lines .alt-eval` colour rule (no !important there).
        // The line's OWN move carries the weight; the continuation behind it is context, so it is
        // dimmed rather than competing with it at equal strength. 7 plies = the move plus the next
        // six. A short pv just yields a shorter tail, and a 1-ply pv none at all.
        const sans = san_preview(last_eval.fen, line.pv, 7).split(' ').filter(Boolean);
        const head = sans[0] || '';
        const cont = sans.slice(1).join(' ');
        rows.push(`<div class="alt-line"><span class="alt-eval" style="color:${line_color(i)}">${evalTxt}</span> ` +
            `<span class="alt-moves">${head}</span>` +
            (cont ? ` <span class="alt-cont">${cont}</span>` : '') + `</div>`);
    }
    // SAY WHAT THE NUMBER IS. With an engine the column is an evaluation; with a human model it is
    // a probability, and nothing on screen said which -- the same digits read completely differently.
    const human = (last_eval.lines || []).some(l => l && l.maiaprob != null);
    const head = rows.length
        ? `<div class="alt-head">${human ? i18n('panel.col_prob', 'Probability') : i18n('panel.col_eval', 'Eval')}</div>`
        : '';
    panel.innerHTML = head + rows.join('');
}

// The engine saying, in its own handshake, that it does not have the variant we asked for. Fairy
// ignores an unknown UCI_Variant and keeps playing the one it had, which turns "analyse this Duck
// Chess game" into a confident standard-chess answer with nothing to show it is wrong. Naming it in
// the status line is the whole fix: the analysis is not made correct, it is made honest.
let unsupported_variant = null;
function note_unsupported_variant(name) {
    unsupported_variant = name;
    const el = PANEL_ROOT.getElementById('game-detection');
    if (el) {
        el.classList.add('unsupported');
        el.innerText = `${name} is not a variant this engine has - the analysis below is standard chess`;
    }
}

function on_engine_response(message) {
    console.log('on_engine_response', message);
    if (typeof message === 'string' && message.startsWith('info string mephisto-unsupported-variant')) {
        return note_unsupported_variant(message.split(' ').pop());
    }
    if (is_remote()) {
        last_eval = Object.assign(last_eval, message);
        on_engine_evaluation(last_eval);
        on_engine_best_move(last_eval.bestmove, last_eval.threat, true);
        return;
    }

    if (pending_stops > 0) {
        // output of a search we abandoned; UCI ordering ends each one with its flushed bestmove, so
        // one bestmove settles one owed stop -- the rest of that search's info lines are dropped too.
        // Clearing search_active matters as much as the decrement: this branch RETURNS, so it used to
        // skip the `search_active = false` below and leave the flag set on a search that had just
        // ended. The next abandon_search then charged a stop for a search owing nothing, and that
        // off-by-one is PERMANENT -- every later bestmove is eaten and the panel never moves again
        // for the rest of the session. A `go` that produces no bestmove at all is enough to start it
        // (Maia is a single forward pass: if it rejects, nothing is ever emitted). The next `go`
        // sets the flag again, so this is safe for the ordinary supersession case.
        if (message.startsWith('bestmove')) { pending_stops--; search_active = false; return; }
        // the flush is not coming -- stop eating the engine's output (see STOP_FLUSH_MS)
        if (Date.now() - stop_charged_at > STOP_FLUSH_MS) {
            console.warn(`Mephisto: ${pending_stops} stop(s) never flushed - resuming engine output`);
            pending_stops = 0;
        } else {
            return;
        }
    }

    last_info_at = Date.now();   // the panel is HEARING the engine (see search_state for why)
    // WHAT IS ACTUALLY LOADED. Every real engine announces its net on load ('info string NNUE
    // evaluation using nn-<hash>.nnue'), and the offscreen host announces the ones it had to fetch.
    // The panel knows which engine it ASKED for; this is the only evidence of what answered.
    if (message.startsWith('info string')) {
        const net = /\b((?:nn-[0-9a-f]+|[\w.-]+)\.(?:nnue|onnx))\b/.exec(message);
        if (net) { engine_net_seen = net[1]; update_engine_id(); }
    }
    revive_attempts = 0;         // ...so whatever we did to revive it worked
    if (message.includes('lowerbound') || message.includes('upperbound') || message.includes('currmove')) {
        return; // ignore these messages
    } else if (message.startsWith('bestmove')) {
        search_active = false;
        const arr = message.split(' ');
        const best = arr[1];
        const threat = arr[3];
        on_engine_best_move(best, threat, true);
    } else if (message.startsWith('info depth')) {
        const lineInfo = {};
        const tokens = message.split(' ').slice(1);
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token === 'score') {
                lineInfo.rawScore = `${tokens[i + 1]} ${tokens[i + 2]}`;
                i += 2; // take 2 tokens
            } else if (token === 'wdl') {
                // `wdl <win> <draw> <loss>` in permille, from the side-to-move's perspective.
                // Normalize to [white, draw, black] so the display never needs the turn again.
                const w = parseInt(tokens[i + 1]), d = parseInt(tokens[i + 2]), l = parseInt(tokens[i + 3]);
                lineInfo.wdl = (turn === 'w') ? [w, d, l] : [l, d, w];
                i += 3; // take 3 tokens
            } else if (token === 'pv') {
                lineInfo['move'] = tokens[i + 1];
                lineInfo[token] = tokens.slice(i + 1).join(' '); // take rest of tokens
                break;
            } else {
                const num = parseInt(tokens[i + 1]);
                lineInfo[token] = isNaN(num) ? tokens[i + 1] : num;
                i++; // take 1 token
            }
        }

        const scoreNumber = Number(lineInfo.rawScore.substring(lineInfo.rawScore.indexOf(' ') + 1));
        const scoreType = lineInfo.rawScore.includes('cp') ? 'score' : 'mate';
        lineInfo[scoreType] = (turn === 'w' ? 1 : -1) * scoreNumber;

        const pvIdx = (lineInfo.multipv - 1) || 0;
        // premove: while this position is searched, track how stable each line's 2nd move
        // (our reply to the predicted opponent move) is across depths 13 / 14 / latest
        if (config.premove && lineInfo.pv && pvIdx < premove_lines && Number.isInteger(lineInfo.depth)) {
            const [pred, reply] = lineInfo.pv.split(' ');
            const line = premove_tracker.lines[pvIdx] || (premove_tracker.lines[pvIdx] = {});
            line.pvFull = pv_moves(lineInfo.pv);   // the whole line, for the deep premove chain
            if (lineInfo.depth === premove_cert_prev()) line.dPrev = `${pred} ${reply}`;
            if (lineInfo.depth === premove_cert_last()) line.dLast = `${pred} ${reply}`;
            line.latest = `${pred} ${reply}`;
            line.pred = pred;
            line.reply = reply;
            line.depth = lineInfo.depth;
            if (pvIdx === 0) maybe_premove_forced_reply(line);
            if (pvIdx === 0) maia2_kick(line); // Maia lines have no reply; ask the net for ours
        }
        last_eval.activeLines = Math.max(last_eval.activeLines, lineInfo.multipv);
        if (pvIdx === 0) {
            // fresh depth: clear last depth's lines, then set line 0
            last_eval.lines = new Array(config.multiple_lines);
            last_eval.lines[pvIdx] = lineInfo;
            // Show THIS depth's best move right away. It used to show the PREVIOUS depth's line 0
            // instead, so on the first depth (no previous line) the move text stayed "Calculating..."
            // while the score and NPS had already updated -- a visible one-depth lag. The native path
            // (on_native_info) already shows the current move; this makes WASM match it, so the panel
            // streams the move from the very first depth.
            const arr = lineInfo.pv.split(' ');
            on_engine_best_move(arr[0], arr[1]);
            on_engine_evaluation(last_eval);
        } else {
            last_eval.lines[pvIdx] = lineInfo;
            render_alt_lines(); // alternative lines land AFTER the pv-1 reset; keep the panel current
            // ...and REDRAW THE ARROWS. draw_moves only ran from the pv-1 branch, which clears the
            // line array first -- so it always drew with exactly one line in hand and Multi Lines
            // showed a single arrow no matter how many lines the panel listed. Help Mode mirrors the
            // same set onto the site board, so it was one arrow there too.
            if (!config.simon_says_mode) draw_moves();
            // The safety net has the same blind spot from the other side: its verdict was computed
            // in the pv-1 branch, when this depth's OTHER lines did not exist yet. Re-judge as they
            // land -- this is where the set first becomes computable at all.
            if (config.safety_net) { draw_safety_net(); update_best_move_suffix(); }
        }
    }

    if (is_calculating) {
        prog++;
        let progMapping = 100 * (1 - Math.exp(-prog / 30));
        PANEL_ROOT.getElementById('progBar')?.setAttribute('value', `${Math.round(progMapping)}`);
    }
}

// A SECOND opinion on the position, where the page happens to publish one.
//
// Every scraping bug this project has had shares a shape: the reconstruction is wrong but perfectly
// LEGAL, so nothing downstream can object and the engine quietly answers a different game. A missing
// en-passant square, absent castling rights, a torn read caught mid-update -- all invisible from the
// inside. An independent source settles it instantly.
//
// The panel runs in the page's isolated world, so it can read the page's own DOM directly -- no
// message round trip. Best-effort BY DESIGN: most pages publish nothing, the ones that do move their
// markup, and this must never gate a move. It only ever warns. Placement ONLY, because a page's FEN
// and ours legitimately differ on move counters, and on side-to-move when the page is showing a
// browsed position rather than the live one.
const FEN_PLACEMENT_RE = /((?:[pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8})/;
let last_crosscheck_warn = 0;

function page_published_placement() {
    try {
        // lichess keeps the live FEN in a copyable input; some pages expose one in a data attribute.
        // Anything that parses as a placement field will do -- we are not guessing at a schema.
        const el = document.querySelector('input.copyable[value*="/"], input[name="fen"], [data-fen]');
        const raw = el?.value || el?.getAttribute?.('data-fen') || '';
        const m = FEN_PLACEMENT_RE.exec(raw);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

function cross_check_position(fen) {
    try {
        const ours = (fen || '').split(' ')[0];
        // Both sides must actually LOOK like a placement field. Without this, a garbage `fen` is
        // "different from" the page's real one and produces a warning whose text is the garbage --
        // which reports the wrong problem. A scrape that malformed is caught by is_legal_position
        // immediately after this call; the cross-check is only here to compare two real positions.
        if (!ours || !FEN_PLACEMENT_RE.test(ours)) return;
        const theirs = page_published_placement();
        if (!theirs || theirs === ours) return;
        if (Date.now() - last_crosscheck_warn < 5000) return; // one complaint per position, not per poll
        last_crosscheck_warn = Date.now();
        console.warn('Mephisto: the position we reconstructed disagrees with the one the page publishes.\n' +
            `  ours: ${ours}\n  page: ${theirs}\n` +
            '  The page is more likely right -- re-detect, or report this with both strings.');
    } catch (e) { /* a diagnostic must never break the move path */ }
}

function is_legal_position(fen) {
    let chess;
    try {
        chess = new Chess(config.variant, fen);
    } catch (e) {
        return false; // chess.js could not parse the FEN
    }
    // Piece-count sanity, standard chess only, gated like apply_castling_rights (Horde
    // alone starts with 36 white pawns; other Fairy variants break these bounds too).
    // chess.js parses an over-populated board, but the WASM dev Stockfish rejects it
    // ("More than 32 pieces on the board") and after that rejection its input side is
    // wedged for the life of the offscreen document -- so it must never see one.
    if (!config.variant || config.variant === 'chess') {
        const placement = fen.split(' ')[0];
        const count = (re) => (placement.match(re) || []).length;
        if (count(/[PNBRQK]/g) > 16 || count(/[pnbrqk]/g) > 16) return false;
        if (count(/P/g) > 8 || count(/p/g) > 8) return false;
        if (count(/K/g) !== 1 || count(/k/g) !== 1) return false;
    }
    // Strict legality only for standard chess / chess960. Other variants have their own
    // rules (antichess & horde legitimately have no king, racingkings differs) and run on
    // fairy-stockfish, which tolerates unusual positions.
    if (config.variant === 'chess' || config.variant === 'fischerandom') {
        if (chess._kings.w === -1 || chess._kings.b === -1) {
            return false; // a missing king crashes the wasm engine (OOB)
        }
        const opponent = (chess.turn() === 'w') ? 'b' : 'w';
        if (chess._isKingAttacked(opponent)) {
            return false; // side-not-to-move in check => its king is capturable (engine OOB)
        }
        const ranks = fen.split(' ')[0].split('/');
        if (/[pP]/.test(ranks[0]) || /[pP]/.test(ranks[7])) {
            return false; // pawns cannot stand on the back ranks
        }
    }
    // A castling right with no king or rook behind it is not an unusual position, it is a corrupt
    // FEN, and it is the same class of hazard as the missing king above: the bundled WASM Stockfish
    // reads the right, looks for the rook, and never answers -- the panel then waits on a bestmove
    // that is not coming. Standard chess only; in 960 the rook is not on a corner by definition.
    if (config.variant === 'chess') {
        const CASTLE_HOME = {K: ['e1', 'h1', 'w'], Q: ['e1', 'a1', 'w'],
                             k: ['e8', 'h8', 'b'], q: ['e8', 'a8', 'b']};
        for (const right of (fen.split(' ')[2] || '-')) {
            if (right === '-') continue;
            const home = CASTLE_HOME[right];
            if (!home) return false; // not a castling character at all
            const [kingSq, rookSq, color] = home;
            const king = chess.get(kingSq), rook = chess.get(rookSq);
            if (!king || king.type !== 'k' || king.color !== color) return false;
            if (!rook || rook.type !== 'r' || rook.color !== color) return false;
        }
    }
    return true;
}

// "Premove" without the blunder risk: while the opponent thinks we certify a reply to their
// PREDICTED move (max 2 candidate lines). It only fires if the new position is EXACTLY the
// predicted one -- any other move discards the table and searches normally, so a wrong guess
// costs nothing. Certification = the reply is identical at depth 13, depth 14 and the latest
// depth (>= 14) -- see PREMOVE_DEPTH_PREV/LAST. Residual risk is only a marginally weaker
// (still certified) move, never a move meant for a different position.
// Final gate before ANY premove reply is clicked: it must move OUR piece, and when it is already
// our turn (an instant reply, not a premove queued during the opponent's turn) it must be fully
// legal right now. This rejects a stale/mismatched chain that would otherwise click the opponent's
// move or an illegal move (the observed "it plays the opponent's move and gets stuck" bug).
// Premove certification window. A (their move, our reply) pair is only trusted once the search has
// reached PREMOVE_DEPTH_LAST and has not changed its mind over the final two iterations: the pair
// must be identical at depth 13, at depth 14, and at the latest depth reported. Raised from the old
// 6 / 9 / >=10 window -- a pair that is merely stable in shallow search still flips often enough by
// depth 14 that premoves were firing on replies the engine went on to abandon.
// The certification depth is the CONFIDENCE dial (Settings -> Premove Confidence): the pair must
// be identical at depth N-1, at depth N, and at the latest depth reported. 14 is the measured
// default from the 6/9/10 -> 13/14 raise; the clamp keeps a typed value inside depths engines
// actually reach in a think.
function premove_cert_last() {
    const n = parseInt(config?.premove_confidence);
    return Number.isFinite(n) ? Math.max(8, Math.min(22, n)) : 14;
}
function premove_cert_prev() { return premove_cert_last() - 1; }

// shared by BOTH `info depth` parsers (WASM and native) so the two gates cannot drift apart
function premove_certified(line) {
    if (!line) return false;
    // A LINE WITH NO REPLY CAN NEVER CERTIFY, whatever else is true of it. Maia answers with a
    // single move at one node -- its pv has a pred and nothing after it -- and the rules bypass
    // below would otherwise certify that line whenever the opponent happens to be forced. Every
    // consumer of a certified line assumes line.reply is a playable move; until 3.1.241 the only
    // thing standing between a reply-less certified line and a click was one downstream regex.
    // Executed check (2026-08-14): a {pred, depth:1, pv:[pred]} Maia-shaped line certified true.
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) return false;
    // MAIA SECOND INFERENCE: this reply came from asking the same net what we play after its
    // predicted move (maia2_on_line sets the flag). One node has no depth window to stabilize,
    // so this path certifies unconditionally and delegates ALL safety to premove_is_safe in
    // maybe_premove_forced_reply: the premove queues only when the reply is bound to the
    // predicted move and therefore cannot fire in a wrong position.
    if (line.maia2) return true;
    // A reply that is the opponent's ONLY legal move is a fact about the rules -- no depth window
    // can add or subtract confidence from it. NOTE what this does NOT do: it does not let a
    // single-move engine premove (an earlier revision of this comment claimed it did, and was
    // wrong). Certification answers "is the prediction trustworthy" -- but a Maia line has no
    // line.reply to PLAY, and the gate above rejects it for exactly that reason. A single-move
    // engine premoves only once something produces the reply: the roadmap's second inference on
    // the rules-certified future position. That mechanism plugs in here when it is built.
    if (line.pred && premove_tracker.fen) {
        try {
            const c = new Chess(config.variant, premove_tracker.fen);
            const legal = c.moves({verbose: true});
            if (legal.length === 1) {
                const only = `${legal[0].from}${legal[0].to}${legal[0].promotion || ''}`;
                if (only === line.pred) return true;
            }
        } catch (e) { /* variant chess.js cannot parse -- fall through to the depth window */ }
    }
    return line.depth >= premove_cert_last()
        && !!line.dPrev && line.dPrev === line.dLast && line.dPrev === line.latest;
}

function premove_reply_playable(fen, uci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return false;
    try {
        const chess = new Chess(config.variant, fen);
        const our = (our_side() === 'white') ? 'w' : 'b';
        const piece = chess.get(uci.slice(0, 2));
        if (!piece || piece.color !== our) return false; // never our-play the opponent's (or an empty) square
        if (fen.split(' ')[1] === our) {                 // our turn -> the reply must be legal immediately
            chess.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
        }
        return true;
    } catch (e) {
        return false; // illegal move, or can't parse -> don't play it
    }
}

// A physical premove is SAFE when the certified reply could never be legal after any opponent
// move OTHER than the predicted one: forced moves (no other moves exist) and recaptures/replies
// bound to the predicted move (anything else makes the premove illegal, and the site silently
// cancels illegal premoves). Either way it cannot fire in a wrong position.
function premove_is_safe(fen, pred, reply) {
    const [from, to, promotion] = [reply.slice(0, 2), reply.slice(2, 4), reply[4]];
    let others;
    try {
        others = new Chess(config.variant, fen).moves({verbose: true});
    } catch (e) {
        return false;
    }
    for (const move of others) {
        if (`${move.from}${move.to}${move.promotion || ''}` === pred) continue;
        try {
            const after = new Chess(config.variant, fen);
            after.move({from: move.from, to: move.to, promotion: move.promotion});
            after.move({from, to, promotion});
            return false; // the reply is also legal after a different opponent move -> could blunder
        } catch (e) {
            // reply illegal after this move: the site would cancel the premove -- safe here
        }
    }
    return true; // forced move (no other moves) or a reply only legal in the predicted position
}

// Humanize-only extra gate on premoves: even a premove that can't misfire looks robotic when it
// instantly snaps off a piece that merely moved in to attack. With Humanize on, only let a premove
// fire when a human reflexively would -- a TRUE recapture (the opponent's predicted move was itself
// a capture and we take back on that square) or a genuinely forced reply (the only legal move after
// it). Anything else is held so the normal humanized think time plays it. Off when Humanize is off:
// Mirror/Clock keep full premove speed (they don't chase the "look human" goal). Fail-safe: if the
// position can't be verified, hold the premove (with Humanize on, erring toward looking human).
function premove_human_reflex(fen, pred, reply) {
    try {
        const c = new Chess(config.variant, fen);
        const predMove = c.moves({verbose: true}).find(m => `${m.from}${m.to}${m.promotion || ''}` === pred);
        if (!predMove) return false;
        if (predMove.captured && reply.slice(2, 4) === pred.slice(2, 4)) return true; // true recapture
        c.move({from: pred.slice(0, 2), to: pred.slice(2, 4), promotion: pred[4]});
        return c.moves().length === 1; // forced: exactly one legal reply after the predicted move
    } catch (e) {
        return false;
    }
}

// Don't wait for the opponent when waiting can't help: queue the certified reply as a REAL
// site premove (clicks during their turn) whenever premove_is_safe says it can't misfire.
function maybe_premove_forced_reply(line) {
    if (premove_tracker.premoved || !config.autoplay) return;
    // taketaketake: blind premoves RE-ENABLED (user testing) -- the site has its own premove
    // system (ctx.premove in the board actor), so the same contract as chess.com/lichess should
    // hold. The earlier queen blunder predates the optimistic-state probe (v3); if it recurs,
    // gate this on `detected_prefix === 'tt'` again.
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return;
    if (!premove_certified(line)) return;
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) return;
    const mover = (premove_tracker.fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover === our_side()) return; // only while the opponent is to move
    if (premove_tracker.safe === undefined) {
        // cached per position; certification pins (pred, reply) via the depth-13 snapshot,
        // so at most one pair can ever be checked here per position
        premove_tracker.safe = premove_is_safe(premove_tracker.fen, line.pred, line.reply);
    }
    if (!premove_tracker.safe) return;
    // Humanize: hold premoves that aren't a true recapture / forced reply (see premove_human_reflex)
    if (config.humanize && !premove_human_reflex(premove_tracker.fen, line.pred, line.reply)) return;
    premove_tracker.premoved = true;
    // DEEP PREMOVE (chess.com only past the first move -- lichess REPLACES a queued premove
    // rather than queueing another, so plies beyond 1 would silently overwrite themselves there).
    // The chain is built by the same certainty rule as the on-board forced lines: their plies must
    // be rules-forced and agree with the engine's line, ours come from that line. Premove Plies
    // caps how many of ours queue in one click session.
    const deepOk = detected_prefix === 'cc' && (!config.variant || config.variant === 'chess');
    const chain = (deepOk && config.premove_plies >= 2)
        ? forced_premove_moves(premove_tracker.fen,
                               line.pvFull || [line.pred, line.reply], config.premove_plies)
        : [];
    // the chain's first move must BE the certified reply, or the pv and the tracker disagree
    if (chain.length > 1 && chain[0] === line.reply) {
        console.log(`Premove: forced ${chain.length}-deep chain -- queueing`, chain.join(' '));
        request_double_premove(chain);
    } else {
        console.log('Premove: reply cannot misfire (forced/bound to predicted move) -- premoving', line.reply);
        request_automove(line.reply);
    }
}

// Second premove for a DOUBLE premove. Returns its UCI, or null if the line isn't forced enough to
// stack one safely. chess.com only, standard chess only. The bar is "1 legal move back to back": the
// opponent's move (pred) must be their ONLY legal move here, and after our reply the opponent must be
// forced again (1 legal move), and our follow-up then forced (1 legal move) -- that lone move is the
// second premove. Anything less and a different opponent move could leave the second premove in a
// position it was never meant for, so we return null and queue just the one.
// THE WHOLE FORCED CHAIN, not just the next move. Walks the engine's line forward while every reply
// is genuinely forced -- the side to move has exactly one legal move -- and returns each ply.
//
// "Forced" here means ONE LEGAL MOVE, nothing softer. A move that is merely best, or the only one
// that does not lose, is a judgement the search makes and can revise; a position with one legal
// reply is a fact about the rules. Drawing a five-move arrow chain off a judgement would be
// confidently wrong exactly when the position is sharpest, which is when someone is looking at it.
//
// THE CHAIN IS OUR PREMOVES (user call 2026-08-14). What matters is not the opponent's forced
// reply for its own sake -- it is that their being forced makes OUR next move safe to premove. So
// the walk takes OUR plies from the engine's line and THEIR plies only while they are the one legal
// move; the first ply where the opponent has a real choice ends the chain, because everything after
// it would be conditional on a guess. Everything drawn is therefore certain given only our own
// choices: our moves are ours to make, and their replies are the rules' to make.
let forced_chain_key = null, forced_chain_memo = [];
let pv_walk_key = null, pv_walk_memo = [];

function forced_chain(fen, pv, maxPlies) {
    const out = [];
    if (!Number.isFinite(maxPlies) || maxPlies <= 0) return out;
    // STANDARD CHESS ONLY, like forced_second_premove and for a harder reason: in drop variants the
    // bundled chess.js never generates pocket drops in moves(), so "one legal move" there is a fact
    // about an incomplete move list, not about the rules -- and this function's whole contract is
    // that a forced ply is a rules fact. Chess960 shares variant 'chess' and is fine.
    if (config.variant && config.variant !== 'chess') return out;
    try {
        const c = new Chess(config.variant, fen);
        const line = pv_moves(pv).filter(Boolean);
        for (let i = 0; i < maxPlies; i++) {
            const legal = c.moves({verbose: true});
            if (!legal.length) break;
            const ours = (i % 2) === 0;   // ply 0 is our side to move in the analysed position
            let uci;
            if (legal.length === 1) {
                const m = legal[0];
                uci = `${m.from}${m.to}${m.promotion || ''}`;     // forced: the rules pick it
            } else if (ours && i < line.length) {
                uci = line[i];                                    // OUR choice -- follow the engine's
            } else {
                break;   // THEIR choice ends the chain: past here is a guess, not a fact
            }
            // chess.js THROWS on a move the position does not allow -- it never returns null -- so
            // a bare null check here was dead code and a disagreeing pv only stopped the walk by
            // luck of the outer catch. Caught per ply, the plies already walked stay valid.
            let rec = null;
            try { rec = c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]}); } catch (e) { /* pv/board disagree */ }
            if (!rec) break;
            out.push({uci, forced: legal.length === 1, ply: i});
        }
    } catch (e) {
        return out; // variant chess.js cannot play -- whatever we already have is still true
    }
    return out;
}

// OUR premove-able moves while the opponent stays rules-forced, up to maxOurs of them. The board
// starts with THEIR side to move (fen is the position the opponent is thinking in). Their plies must
// be their ONLY legal move AND agree with the engine's line -- a forced reality the pv disagrees
// with means the pv is for another branch, and the whole chain is distrusted rather than patched.
// Our plies come from the pv (or our own only-move). Same certainty rule as the on-board forced
// chain: everything returned is certain given only our own choices.
function forced_premove_moves(fen, pv, maxOurs) {
    const ours = [];
    if (!Number.isFinite(maxOurs) || maxOurs <= 0) return ours;
    try {
        const c = new Chess(config.variant, fen);
        const line = pv_moves(pv).filter(Boolean);
        for (let i = 0; ; i++) {
            const legal = c.moves({verbose: true});
            const theirs = (i % 2) === 0;
            let uci;
            if (theirs) {
                if (legal.length !== 1) break;                     // their real choice ends certainty
                const m = legal[0];
                uci = `${m.from}${m.to}${m.promotion || ''}`;
                if (line[i] && line[i] !== uci) break;             // pv is for a different branch
            } else if (i < line.length) {
                uci = line[i];                                     // our choice: the engine's move
            } else if (legal.length === 1) {
                const m = legal[0];
                uci = `${m.from}${m.to}${m.promotion || ''}`;      // no pv left but ours is forced too
            } else {
                break;
            }
            if (!c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]})) break;
            if (!theirs) { ours.push(uci); if (ours.length >= maxOurs) break; }
        }
    } catch (e) {
        return ours; // variant chess.js cannot play -- whatever is collected is still certain
    }
    return ours;
}

// THE WHOLE LINE, validated ply by ply. Where forced_chain walks only while the RULES force each
// reply, this walks the engine's pv as-is -- every ply is a suggestion, which is why the drawing
// side renders it grey. chess.js replays the line so a truncated or garbled pv can never draw an
// arrow from a square nothing stands on; the walk stops at the first ply that does not parse.
function pv_walk_moves(fen, pv, maxPlies) {
    const out = [];
    if (!Number.isFinite(maxPlies) || maxPlies <= 0) return out;
    const moves = pv_moves(pv);
    try {
        const c = new Chess(config.variant, fen);
        for (let i = 0; i < moves.length && i < maxPlies; i++) {
            const uci = moves[i];
            if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
            c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]}); // throws where the line breaks
            out.push({uci, ply: i});
        }
    } catch (e) { /* first illegal ply ends the walk */ }
    return out;
}

function premove_instant_reply(new_fen, new_moves) {
    if (!config.premove || !config.autoplay) return null;
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return null;
    if (premove_tracker.premoved) return null; // already queued as a real site premove
    if (!premove_tracker.fen || premove_tracker.fen !== last_eval.fen) return null;
    const mover = (new_fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover !== our_side()) return null; // the certified reply must be OUR move
    let certified = 0;
    for (let idx = 0; idx < premove_lines; idx++) {
        const line = premove_tracker.lines[idx];
        if (!premove_certified(line)) continue;
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) continue;
        certified++;
        // primary match: the exact MOVE, per the premove contract (robust across sites --
        // fen string reconstruction proved fragile)
        // Humanize holds non-reflex replies (returns null -> normal humanized search plays it);
        // off when Humanize is off, so plain Premove / Clock / Mirror keep full instant speed.
        const held = config.humanize && !premove_human_reflex(premove_tracker.fen, line.pred, line.reply);
        if (premove_tracker.moves && new_moves
                && new_moves === `${premove_tracker.moves} ${line.pred}`) {
            return held ? null : line.reply; // the opponent played exactly the predicted move
        }
        try { // fallback for moves-less contexts: apply the prediction and compare positions
            const chess = new Chess(config.variant, premove_tracker.fen);
            chess.move({from: line.pred.slice(0, 2), to: line.pred.slice(2, 4), promotion: line.pred[4]});
            if (chess.fen() === new_fen) {
                return held ? null : line.reply;
            }
        } catch (e) {
            // predicted move not applicable to this position; fall through to the next line
        }
    }
    if (certified) { // diagnostic: we HAD a certified reply and the opponent's move missed it
        console.log('Premove(WASM): no match for certified line(s)',
            {tracked: premove_tracker.moves, got: new_moves});
    }
    return null;
}

// While pondering we don't know which move the opponent will pick -- and they won't mirror the
// engine's #1 -- so ponder the top 5 candidate replies: it warms the TT for whichever they play and
// lets Premove certify a reply to any of them. Applies to every engine: the caller sits above the
// engine branch in on_new_pos, and the native path pushes the matching MultiPV to its host.
// Narrow it when the position is forcing, where the
// realistic replies are few and the width is better spent on depth: 1-2 legal moves (a real forced
// move), or a recapture of the piece we just moved (lastUci's destination is capturable).
function ponder_line_count(fen, lastUci) {
    try {
        const legal = new Chess(config.variant, fen).moves({verbose: true});
        if (legal.length <= 2) return Math.max(1, legal.length);
        const ourDest = /^[a-h][1-8][a-h][1-8]/.test(lastUci || '') ? lastUci.slice(2, 4) : null;
        if (ourDest && legal.some(m => m.to === ourDest && m.captured)) return 2; // recapture likely
        return 5;
    } catch (e) {
        return 5; // variant fen chess.js can't parse: default to the wide ponder
    }
}

// --- Opening explorer -------------------------------------------------------------------------
// Human opening data from lichess, used two ways: an overlay in the panel (`explorer`), and an
// actual weighted-random book move (`book_play`). They are separate toggles on purpose -- switching
// on a read-out must never silently change your play.
//
// It is NEVER on the critical path. The lookup is fired the moment a position arrives and never
// awaited: if the answer hasn't landed by the time the engine's move is ready, the engine move is
// played and the book is simply skipped for that move. A slow or rate-limited request can therefore
// never delay a move or eat into a Clock/Mirror time budget.
const BOOK_MIN_GAMES = 20;   // drop 3-game oddities -- the move must be statistically real
const BOOK_MAX_LOSS = 40;    // cp: the engine's veto. A book move this far below its best is "worse"
let explorer_data = null;    // {fen, moves:[...], opening} for the position we last looked up
let explorer_out_of_book = false; // latched per game: first empty answer stops all further lookups
let explorer_error = null;   // last lookup failure, shown in the overlay instead of drawing nothing
const INITIAL_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'; // standard start array
let setup_fen = null;        // a manually set position: while held, page scrapes are IGNORED
let snap_crop = null;        // the screen rect the last capture came from, for re-scanning it

// A panel reload rebuilds this whole script, so every module variable goes with it -- including a
// position you had just captured off the screen. Changing Engine or Variant would silently throw
// your board away and go back to following the page. Park it in storage across the rebuild instead.
// (Threads, Hash, Lines and the poll no longer reload at all -- see the settings handler.)
const SETUP_STASH_KEY = 'setup_fen_stash';

function stash_setup_state() {
    try {
        if (setup_fen) {
            MephistoConfig.set(SETUP_STASH_KEY, JSON.stringify({fen: setup_fen, crop: snap_crop, view: setup_view, flipped: snap_flipped}));
        } else {
            MephistoConfig.set(SETUP_STASH_KEY, JSON.stringify(null));
        }
    } catch (e) { /* storage unavailable -- the reload simply loses it, as before */ }
}

function restore_setup_state() {
    try {
        const raw = JSON.parse(MephistoConfig.get(SETUP_STASH_KEY) || 'null');
        if (!raw?.fen || !is_legal_position(raw.fen)) return false;
        setup_fen = raw.fen;
        snap_crop = raw.crop || null;
        setup_view = (raw.view === 'white' || raw.view === 'black') ? raw.view : null;
        snap_flipped = !!raw.flipped;
        const row = PANEL_ROOT.getElementById('setup-fen-row');
        if (row) row.style.display = '';
        const input = PANEL_ROOT.getElementById('setup_fen_input');
        if (input) input.value = setup_fen;
        setup_fen_msg(i18n('panel.fen.restored', 'Restored the position you had set - Re-detect to follow the page again'));
        update_snap_follow_button();
        try {
            turn = setup_fen.split(' ')[1] || 'w';
            board.orientation(setup_view || (turn === 'w' ? 'white' : 'black'));
            board.position(setup_fen);
            update_turn_badge(setup_fen);
        } catch (e) { /* board not ready yet */ }
        on_new_pos(setup_fen, setup_fen, '');
        return true;
    } catch (e) {
        return false;
    }
}
let explorer_empty_streak = 0; // consecutive empty lookups; 3 = genuinely out of book

// --- Syzygy tablebase --------------------------------------------------------------------------
// With <=7 men on the board the position is SOLVED, so a hit here is not an opinion the engine can
// out-search -- it is the answer, and it beats any move a bounded search produces. Probed over the
// network (in the service worker, so the page issues nothing): the real tablebases are hundreds of
// gigabytes, which is not something to ship with a browser extension.
//
// Off by default and opt-in under Settings, exactly like the Opening Explorer: it tells a third
// party the position you are looking at, and that is the user's call to make, not a default.
//
// NEVER on the critical path. The lookup is fired when a position arrives and never awaited -- if
// the answer has not landed by the time the engine's move is ready, the engine's move is played and
// the probe is simply skipped for that move. A slow or blocked endpoint cannot delay a move or eat
// into a Clock/Mirror budget.
const TABLEBASE_MAX_MEN = 7;   // the largest Syzygy set lichess serves
let tablebase_data = null;     // {fen, category, dtz, dtm, moves:[...]} for the last position probed

// lichess serves Syzygy for standard, atomic and antichess only (probed -- everything else 404s).
// Chess960 is excluded on purpose: a <=7-man 960 position can still carry castling rights, which
// Syzygy does not model, so /standard would be answering about a different position.
const TABLEBASE_VARIANTS = ['chess', 'atomic', 'antichess'];

function tablebase_enabled() {
    return config.tablebase && TABLEBASE_VARIANTS.includes(config.variant || 'chess');
}

// men on the board, straight off the FEN placement field
function piece_count(fen) {
    return (fen.split(' ')[0].match(/[prnbqkPRNBQK]/g) || []).length;
}

// Fire-and-forget. Never awaited by the move path (see the note above).
function request_tablebase(fen) {
    if (!tablebase_enabled()) return;
    // A hidden tab makes no third-party requests -- unless Background Play is on, in which case the
    // game IS still being played and a tablebase answer is exactly as wanted as it is in front of you.
    if (document.hidden && !config.background_play) return;
    if (piece_count(fen) > TABLEBASE_MAX_MEN) return;  // out of range -- don't ask
    if (tablebase_data?.fen === fen) return;           // already have this position
    chrome.runtime.sendMessage({tablebaseLookup: {fen, variant: config.variant || 'chess'}}, (res) => {
        if (chrome.runtime.lastError || !res || res.error || !res.moves?.length) return;
        tablebase_data = {fen, ...res};
        console.log(`Tablebase: ${res.category} (dtz ${res.dtz}, dtm ${res.dtm}) -> ${res.moves[0].uci}`);
        // The probe usually answers before the engine, and on_engine_best_move then announces the
        // tablebase move. When the ENGINE answered first, the readout already names the engine's
        // pick -- rewrite it with the move this answer now dictates, and redraw so its arrow
        // leads. (The move already played, if any, stays played: this repairs the announcement.)
        const pick = tablebase_pick(fen);
        if (pick && last_eval.fen === fen && last_eval.bestmove && last_eval.bestmove !== pick
            && move_possible_here(fen, pick)) {
            last_eval.bestmove = pick;
            const side = (turn === 'w') ? i18n('color.white', 'White') : i18n('color.black', 'Black');
            update_best_move(i18n('panel.msg.to_play_best', '{side} to play, best move is {move}',
                {side, move: notate(fen, pick)}));
            render_move_reason(pick);
            draw_moves();
            return;
        }
        update_best_move_suffix();
    });
}

// The optimal move for THIS position, or null. lichess returns `moves` sorted best-first, so the
// answer is simply moves[0] -- there is nothing to weigh or filter, and deliberately no "is the
// engine's move close enough" check like the opening book has: a solved position has a best move
// and everything else is worse by definition.
function tablebase_pick(fen) {
    if (!tablebase_enabled()) return null;
    if (tablebase_data?.fen !== fen) return null;      // stale or never answered
    const best = tablebase_data.moves?.[0]?.uci;
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best ?? '') ? best : null;
}

// WHICH OF THE TWO ANSWERS GETS THE SCREEN. At 7 pieces or fewer both the engine and the tablebase
// answer the same position, and they answer differently in kind: one is a search, the other is
// solved. Drawn together with no distinction they were unreadable -- the tablebase move wore line
// 1's blue and the engine's own first line was dropped underneath it, so the board showed "the top
// engine line" that was not the engine's at all (reported 2026-08-30).
//
// This decides the DISPLAY only. The tablebase still outranks the engine for the move that is
// actually played in every mode, because at <=7 pieces its move is proved and the engine's is not --
// which is also why the readout keeps naming the played move even under 'engine'.
const TB_SHOW_MODES = ['both', 'tablebase', 'engine'];
// Amber, chosen to clash with nothing already on the board: not in LINE_COLORS, not in BOOK_COLORS,
// not the red threat and not the grey PV walk. A tablebase arrow must never be mistakable for a
// line the engine ranked, because it does not mean the same thing.
const TB_COLOR = '#f59e0b';
function tb_show() {
    return TB_SHOW_MODES.includes(config.tablebase_show) ? config.tablebase_show : 'both';
}
// "Is there a tablebase answer to show, and are we showing it"
function tb_show_tb() { return tb_show() !== 'engine'; }
// The engine keeps the screen unless the tablebase both owns it AND actually answered -- otherwise
// 'Tablebase only' would leave an empty panel on every position with more than seven men.
function tb_show_engine(fen) { return tb_show() !== 'tablebase' || !tablebase_pick(fen ?? last_eval.fen); }

// The verdict line under the readout. The readout itself names the tablebase move whenever the
// pick will drive the play (see on_engine_best_move); this label carries the verdict, the count
// and the source.
// ALWAYS FROM YOUR SIDE. A tablebase answers the side to move, so on your move it said "winning"
// and on theirs "losing" -- the same position, described from whichever side happened to be on the
// clock, which reads as the game swinging every ply. The engine's own score is already normalised
// this way; this makes the tablebase agree with it. The MOVE is untouched: it is played for
// whoever is to move, and only the sentence about it changes.
const TB_FLIP = {win: 'loss', loss: 'win', 'cursed-win': 'blessed-loss', 'blessed-loss': 'cursed-win'};

function tablebase_category_for_us(category, fen) {
    const turn = String(fen || '').split(' ')[1];
    if (!turn || !category) return category;
    const theirMove = ((turn === 'w') ? 'white' : 'black') !== our_side();
    return theirMove ? (TB_FLIP[category] || category) : category;
}

function tablebase_label() {
    if (!tablebase_data || tablebase_data.fen !== last_eval.fen) return '';
    const c = tablebase_category_for_us(tablebase_data.category, tablebase_data.fen);
    // dtm is a real MATE distance in PLIES (lichess's Gaviota data, <=5 men; merged into local
    // answers when the network allows); dtz only counts plies to a capture or pawn move. With a
    // mate distance the label counts MATE IN MOVES -- what a chess player reads -- and without
    // one it says DTZ instead of pretending.
    const hasDtm = tablebase_data.dtm != null;
    const n = Math.abs((hasDtm ? tablebase_data.dtm : tablebase_data.dtz) ?? 0);
    const m = Math.ceil(n / 2);   // plies -> moves for the mate count
    // name the source: "(local)" means the user's own files answered and nothing left this machine
    const s = tablebase_data.source === 'local' ? ' ' + i18n('panel.tb.local', '(local)') : '';
    if (c === 'win') return (hasDtm ? i18n('panel.tb.mate', 'Tablebase: mate in {m}', {m})
                                    : i18n('panel.tb.win_dtz', 'Tablebase: winning, DTZ {n}', {n})) + s;
    if (c === 'loss') return (hasDtm ? i18n('panel.tb.mated', 'Tablebase: mated in {m}', {m})
                                     : i18n('panel.tb.loss_dtz', 'Tablebase: losing, DTZ {n}', {n})) + s;
    if (c === 'draw') return i18n('panel.tb.draw', 'Tablebase: draw') + s;
    if (c === 'cursed-win') return i18n('panel.tb.cursed', 'Tablebase: winning, DTZ {n} (50-move drawn)', {n}) + s;
    if (c === 'blessed-loss') return i18n('panel.tb.blessed', 'Tablebase: loss (50-move drawn)') + s;
    return '';
}

// --- Lichess puzzle database ---------------------------------------------------------------------
// Opt-in, and opting in is importing the file (Settings -> Puzzle Database). With nothing imported
// every lookup misses and Puzzle Mode behaves exactly as it always has.
//
// Why it is worth having: the engine's best move and the puzzle's INTENDED move are not the same
// thing. A puzzle has one scored answer, and a stronger move that isn't it still loses the puzzle.
// When the position is in the database the whole solution is known, so there is nothing to search.
//
// The read has to go through the service worker. This panel runs in the page's ISOLATED WORLD, and
// an isolated world's indexedDB belongs to the SITE -- the extension's database is not reachable
// from here at all, however the code is arranged.
//
// A hit is expanded ONCE into every our-turn position of the line, so plies 2, 3, 4... answer from
// memory with no further round-trip. If the opponent ever leaves the line the position simply isn't
// in the map, the lookup misses, and the engine plays -- no special case needed.
let puzzle_solutions = null;   // Map(placement+stm -> our uci) for the line we last matched
let puzzle_asked = null;       // the position the last request was for (don't re-ask on every poll)

const PUZZLE_DB_SITES = ['li', 'cc'];   // sites a puzzle database can be imported for
function puzzle_db_enabled() {
    // LICHESS ONLY, and that is a resource decision as much as a correctness one. The database is
    // built from lichess games, so a chess.com or BlitzTactics position is not in it and never will
    // be -- looking it up there is a message to the service worker and a disk read per position, every
    // one of them a guaranteed miss. Ask only where an answer can exist.
    //
    // Standard chess only for the same reason plus one: the key is a bare placement, so a variant
    // position could in principle collide with a standard one.
    // Each site has its OWN database now, so the question is no longer "is this lichess" but
    // "does a database exist for where we are". BlitzTactics and TakeTakeTake still have none, and
    // asking there would be a message and a disk read per position for a guaranteed miss.
    if (!PUZZLE_DB_SITES.includes(detected_prefix)) return false;
    return config.puzzle_mode && (!config.variant || config.variant === 'chess');
}

function puzzle_key(fen) {
    const parts = String(fen).split(' ');
    return `${parts[0]} ${parts[1] || 'w'}`;
}

// Walk the solution from the position it was stored against, recording OUR move for each of our
// turns. chess.js is what makes the intermediate positions trustworthy -- unlike the import, this
// runs once per puzzle, not six million times.
//
// OURS is the side to move at a position matching the SOLVER's side, NOT the even steps. The line
// does not always lead with our move: the capture store keeps a "post-setup" reading -- the position
// right after our first move, opponent to reply -- whose line[0] is THEIRS. On lichess /training the
// board lands on exactly that reading after our first move and re-matches it, so expanding it by loop
// parity marked our real SECOND move as the opponent's (null), and the puzzle stalled one move in
// while streak/storm (which never re-match a stored position mid-solution) played on. Asking the
// board whose turn it is fixes the parity for either leading side; it falls back to the old even-step
// rule only when the side is somehow unavailable, which keeps every our-leading line byte-identical.
function puzzle_expand(fen, solution) {
    const map = new Map();
    let ourSide = null;
    try { const s = our_side(); ourSide = s === 'white' ? 'w' : s === 'black' ? 'b' : null; } catch (e) { /* board not ready */ }
    try {
        const chess = new Chess(config.variant, fen);
        const moves = solution.split(' ').filter(Boolean);
        for (let i = 0; i < moves.length; i++) {
            // EVERY position of the line goes in, not just the ones we move from: ours carry the
            // move, theirs carry null. Membership is then the answer to "is this position part of the
            // puzzle in hand", and that is a fact about the line rather than an inference about the
            // board. Their positions used to be held out of the engine by `!our_turn` alone -- and on
            // a chess.com puzzle page the side to move is inferred from a scrape of the PIECES, with
            // no move list to check it against. One poll that reads it wrong sends a position in the
            // middle of a solved line to a full search, which then draws its own arrow over the
            // solution and moves the eval bar. The next scrape lands back in the line and it snaps
            // back: an arrow that jumps to a different move in a puzzle that has a fixed one.
            const stm = chess.fen().split(' ')[1];
            const ours = ourSide ? (stm === ourSide) : (i % 2 === 0);
            map.set(puzzle_key(chess.fen()), ours ? moves[i] : null);
            const m = moves[i];
            if (!chess.move({from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4]})) break;
        }
        // ...and the position the line ENDS on, which belongs to the puzzle as much as any other and
        // is the one the board sits in from the last move until the next puzzle loads. Searching it
        // is the engine eval that appears between puzzles.
        map.set(puzzle_key(chess.fen()), null);
    } catch (e) {
        return map; // a line that doesn't replay gives back whatever it managed; the rest just misses
    }
    return map;
}

// --- Puzzle Storm / Racer -------------------------------------------------------------------------
// These pages DO ship their whole puzzle set with the page -- exact FEN and full solution for every
// puzzle, 137 for Storm and 69 for Racer -- which would be better than the database here: no import
// needed, and an exact FEN on a page that has no move list and therefore has to infer castling and
// en passant.
//
// It was implemented and REVERTED, because re-fetching the URL to read that payload returns a
// DIFFERENT RUN. Verified against a live board: the position on screen matched NONE of the 137
// puzzles a fetch returned. Feeding those solutions would play confidently wrong moves -- strictly
// worse than not having the feature.
//
// (The test that made it look safe compared two fetches TO EACH OTHER. Both were new runs, so they
// agreed with each other and told us nothing about the run being displayed. Compare against the
// rendered board, never against another copy of the same guess.)
//
// The data is only in the page at LOAD time -- lichess deletes its own bootstrap script once it has
// read it, which is why it cannot be re-read afterwards. A correct implementation would need a
// content script at `run_at: document_start` capturing that script node before the page removes it.
// Not built: it is a real change to how the extension injects, and unverified guesses have cost
// enough today.

// --- solutions read off the page itself ----------------------------------------------------------
// The other half of the note above, built the way that note says it has to be: a document_start probe
// that captures the payload the page was ALREADY given, and never re-requests anything. Opt-in
// (`puzzle_capture`), and inert until the probe reports something.
//
// It is checked BEFORE the database because it needs no round trip at all -- the answer is already in
// this tab -- and because when both know the position they agree; the page's own solution is the one
// the page will score you against.
//
// Safety is structural rather than careful: the capture is stored under its own position, the lookup
// is by the position ON THE BOARD, and the line was replayed for legality before it was stored. A
// capture belonging to a different run is a key that never matches, so the failure mode is a MISS and
// the engine plays, which is exactly where the feature started.
function puzzle_capture_enabled() {
    return config.puzzle_mode && config.puzzle_capture
        && PUZZLE_DB_SITES.includes(detected_prefix)
        && (!config.variant || config.variant === 'chess');
}

function try_puzzle_capture(fen) {
    if (!puzzle_capture_enabled()) return false;
    let hit = null;
    try { hit = self.puzzleCaptureFor?.(fen) || null; } catch (e) { return false; }
    if (!hit?.line) return false;
    const map = puzzle_expand(fen, hit.line);
    // expand replays from the BOARD's fen; a line that does not fit the board leaves nothing useful
    // behind, and taking it would only mean claiming an answer we do not have
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(map.get(puzzle_key(fen)) ?? '')) return false;
    puzzle_solutions = map;
    // the publisher's own rating rides along with the captured line -- both lichess and chess.com
    // put it in the payload, so a page-read solution shows "Rating N" exactly like a database one
    puzzle_rating = (typeof hit.rating === 'number' && hit.rating > 0) ? hit.rating : null;
    puzzle_from_page = true;
    puzzle_answered = puzzle_key(fen);
    puzzle_deferred = null;
    clearTimeout(puzzle_defer_timer);
    console.log(`Puzzle: solution read from the page -- ${hit.line}`
              + (puzzle_rating ? ` (rated ${puzzle_rating})` : ''));
    update_best_move_suffix();
    return true;
}

// Fire-and-forget, exactly like the tablebase probe: the move path never awaits it, it either has an
// answer by the time a move is due or it doesn't.
function request_puzzle_solution(fen) {
    // The page's own answer costs nothing to check and arrives with no wait, so it goes first.
    if (try_puzzle_capture(fen)) {
        if (last_eval.fen === fen) {
            const pick = puzzle_pick(fen);
            if (pick) show_puzzle_answer(pick);
            draw_moves();
        }
        maybe_play_puzzle_move(fen);
        return;
    }
    if (!puzzle_db_enabled()) return;
    if (puzzle_solutions?.has(puzzle_key(fen))) return; // already covered by the line in hand
    if (puzzle_asked === puzzle_key(fen)) return;       // asked once; the answer is coming or was null
    puzzle_asked = puzzle_key(fen);
    chrome.runtime.sendMessage({puzzleLookup: {fen, site: detected_prefix}}, (res) => {
        // ANSWERED EITHER WAY. A miss used to return silently, which is why the search had to be
        // started speculatively -- and a search started speculatively is a search that can finish
        // first and play the engine's move into a puzzle the database could have answered.
        puzzle_answered = puzzle_key(fen);
        if (chrome.runtime.lastError || !res || res.error || !res.solution) {
            release_deferred_search(fen);
            return;
        }
        // A HIT ends the wait too. Without this the deferral stays armed and its watchdog re-enters
        // on_new_pos 1.5s later for a position that has already been answered and played.
        puzzle_deferred = null;
        clearTimeout(puzzle_defer_timer);
        puzzle_solutions = puzzle_expand(fen, res.solution);
        puzzle_rating = res.rating ?? null;
        puzzle_from_page = false;
        console.log(`Puzzle DB: solution known -- ${res.solution}` +
                    (puzzle_rating ? ` (rated ${puzzle_rating})` : ''));
        update_best_move_suffix();
        // The answer landed after on_new_pos ran: draw it and play it now.
        // The panel already ran on_new_pos for this position and found nothing, so it has to be
        // told the answer as well as shown it -- with Autoplay off nothing below will do it.
        if (last_eval.fen === fen) {
            const pick = puzzle_pick(fen);
            if (pick) show_puzzle_answer(pick);
            draw_moves();
        }
        maybe_play_puzzle_move(fen);
    });
}

// The position we have a definitive database answer for -- hit OR miss -- and the search that is
// waiting on one. Puzzle Mode holds the engine until the database has spoken, because an engine move
// played into a position the database knew is precisely how a solved puzzle gets failed.
let puzzle_answered = null;
let puzzle_deferred = null;   // {fen, startFen, moves} -- re-entered once the answer lands
let puzzle_defer_timer = null;
// How long the engine will wait on the database before giving up and searching anyway. A lookup is
// one message and one indexed read, so this is generous by an order of magnitude -- it exists so a
// worker that never answers costs a slower move rather than NO move, which is the worse failure.
const PUZZLE_LOOKUP_WAIT_MS = 1500;

function release_deferred_search(fen) {
    const w = puzzle_deferred;
    if (!w || puzzle_key(w.fen) !== puzzle_key(fen)) return;
    puzzle_deferred = null;
    clearTimeout(puzzle_defer_timer);
    console.log('Puzzle DB: no entry for this position -- searching normally');
    on_new_pos(w.fen, w.startFen, w.moves);
}

// Is this position part of the solution line we are holding? True for THEIRS and for the position
// the line ends on, both of which have no move for us -- which is exactly why `puzzle_pick` cannot
// answer this: it returns null for a position the line owns and for one it has never heard of alike.
function puzzle_in_line(fen) {
    return !!(puzzle_db_enabled() && puzzle_solutions?.has(puzzle_key(fen)));
}

// Our move in THIS position per the database, or null.
function puzzle_pick(fen) {
    if (!puzzle_db_enabled()) return null;
    const uci = puzzle_solutions?.get(puzzle_key(fen));
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '') ? uci : null;
}

// Play the known move NOW, without waiting for the engine.
//
// This started out hanging off the engine's bestmove handler, next to the tablebase and book picks,
// and that was wrong twice over. It made the whole feature depend on a search TERMINATING -- so with
// Autoplay's `go movetime` it merely wasted the search, and on any path that does not produce a
// terminal bestmove nothing was ever played at all. Worse, the gate around that block tests whether
// the ENGINE's move is playable, so a database move could be discarded because the engine's own
// suggestion was unusable. And it defeats the point: when the position is in the database the entire
// solution is known, and there is nothing left for a search to decide.
//
// Is there a known move for this position that we are allowed to play right now? Split from the
// action because on_new_pos has to decide whether to start a search BEFORE it is in a state where
// the move can actually be issued.
//
// Same safety the engine's own moves get: the move must belong to US and be legal here. A database
// hit is a position match, not proof that this board is that position.
function puzzle_move_ready(fen) {
    if (!config.autoplay || config.help_mode || config.manual_mode || config.simon_says_mode) return null;
    const uci = puzzle_pick(fen);
    if (!uci) return null;
    if (!premove_reply_playable(fen, uci)) {
        console.warn('Mephisto: ignoring a puzzle move that is not ours/legal here:', uci);
        return null;
    }
    return uci;
}

// Called at the end of on_new_pos AND from the lookup callback -- on the first position of a puzzle
// the answer arrives a moment after on_new_pos has already run. No latch of its own: a second call
// for the same position is what a FAILED move needs (the content-script re-pushes it), and a double
// click is already impossible -- the content-script's `moving` guard drops it.
// A beat before the first click, and ONLY on a database move.
//
// Every other move path has a search in front of it, and that search is what has always been letting
// the board finish animating before anything gets clicked. A known solution has no search to hide
// behind: without this the click is issued in the same tick as the scrape that produced it, while the
// opponent's reply is still moving across the board. That is what made the mismatch guard fire on
// essentially every puzzle move. Delaying the SEND (rather than sleeping inside the click sequence)
// also means the content-script's guard judges a board that has settled.
// The DEFAULT, not the value: it is a setting now (Settings -> General -> Puzzle Move Delay).
// Kept as a constant because it is also the fallback whenever the setting is unset or unreadable,
// and because the reasoning above is about this number.
const PUZZLE_MOVE_DELAY_MS = 300;

// Read fresh per move rather than off the config snapshot: the point of a knob like this is that
// you drag it while watching puzzles being solved, and a value that only takes effect on the next
// panel rebuild would be useless for that.
function puzzle_move_delay_ms() {
    let v = null;
    try { v = JSON.parse(MephistoConfig.get('puzzle_delay') ?? 'null'); } catch (e) { v = null; }
    return (typeof v === 'number' && v >= 0 && v <= 3000) ? v : PUZZLE_MOVE_DELAY_MS;
}
// The pending pre-move pause. Superseded rather than stacked: on_new_pos can legitimately run twice
// for the SAME board -- a re-push flagged as a resume does exactly that -- and two live timers would
// send the move twice, which the content-script then has to drop on its `moving` guard.
let puzzle_move_timer = null;
let puzzle_rating = null;   // what the publisher rated the puzzle we are on, when they said
let puzzle_from_page = false;   // did this solution come from the page (capture) or the imported DB

// WHICH SCRAPE THIS PANEL IS ACTUALLY WORKING FROM.
//
// `incoming_push_key` is the key of the push being handled right now; `analysed_push_key` is the one
// the panel ACCEPTED and reasoned about. They differ exactly when a push is looked at and rejected --
// a puzzle misread being the case that matters, because it deliberately leaves the panel's state
// untouched. When that happens the panel goes on holding the previous position, and any move it
// still has pending belongs to THAT position, not to what is on screen now.
//
// The key is the content script's own (`orientation|scrape`), so it can re-derive it from the live
// board and compare. Shipped with every move it sends, which is what lets a move be refused when the
// board is no longer the position it was computed for -- see boardStillMatchesAnalysis. A puzzle
// answer from the previous puzzle was played into the next one three times before this existed.
let incoming_push_key = null;
let analysed_push_key = null;

// ...and a watchdog behind it, because the puzzle click path does NOT verify itself.
//
// A normal autoplay move goes through simulateMoveVerified: it checks the move list actually grew,
// retries, and on final failure clears both dedupes so the position is re-analysed. A puzzle move is
// one UNVERIFIED click. So any single failure -- a dropped click, a mismatch abort, a mid-animation
// board -- is PERMANENT: the board never changes, so the popup's own `last_eval.fen` dedupe swallows
// every re-push and nothing ever tries again. That is the difference between a hiccup and a panel
// that has quietly stopped playing.
//
// Capped, and deliberately no engine fallback after the cap: the failure here is in CLICKING, not in
// choosing the move, and the engine's move would go out through the very same clicks.
// Bounded by TIME, not by attempts. It counted attempts first, and the log showed why that is
// wrong: three retries inside four seconds all came back "DROPPED: a previous move is still in
// progress" -- which is not a failed move, it is a move still happening -- and then it gave up on a
// position that was about to work. Time is the honest budget: keep offering the move until the board
// changes or the window closes, and let the content-script drop whatever arrives too early.
const PUZZLE_MOVE_RETRY_MS = 1500;
const PUZZLE_MOVE_WINDOW_MS = 9000;
let puzzle_retry_timer = null;
let puzzle_retry = {key: null, until: 0};

function maybe_play_puzzle_move(fen, opts = {}) {
    const uci = puzzle_move_ready(fen);
    if (!uci) return false;
    console.log(`Puzzle DB: playing ${uci} (known solution, no search)`);
    abandon_search(); // no search is wanted here, and none of its output should arrive behind ours
    show_puzzle_answer(uci);
    clearTimeout(puzzle_move_timer);
    puzzle_move_timer = setTimeout(() => {
        // Only skip if the BOARD really moved on. Compared on placement + side to move, not on the
        // whole FEN: on a puzzle page the castling rights and ep square are inferred and the move
        // counters are often re-derived, so the FEN string can change while the position in front of
        // you has not. Comparing strings here meant a cosmetic re-scrape cancelled the move -- and
        // because this function had already told on_new_pos it was handling things (returning true,
        // which skips the search), that left the position with NO move and NO search at all.
        if (puzzle_key(last_eval.fen) !== puzzle_key(fen)) {
            console.log('Puzzle DB: position moved on during the pre-move pause -- not sending');
            return;
        }
        request_automove(uci, null, false, {paused: true, retry: opts.retry});
        watch_puzzle_move(fen, uci);
    }, puzzle_move_delay_ms());
    return true;
}

// Did the move we just sent actually land? The only evidence that matters is the board changing, so
// that is what this waits for: same position still there = it did not land = send it again.
function watch_puzzle_move(fen, uci) {
    const key = puzzle_key(fen);
    // A new position opens a fresh window; the same one keeps the deadline it already had.
    if (puzzle_retry.key !== key) puzzle_retry = {key, until: Date.now() + PUZZLE_MOVE_WINDOW_MS};
    clearTimeout(puzzle_retry_timer);
    puzzle_retry_timer = setTimeout(() => {
        if (puzzle_key(last_eval.fen) !== key) return; // the board moved on -- the move landed
        if (Date.now() > puzzle_retry.until) {
            console.warn(`Mephisto: puzzle move ${uci} did not land within ` +
                `${PUZZLE_MOVE_WINDOW_MS}ms -- giving up on this position (Re-detect to retry)`);
            bgTrace('puzzle move gave up', {uci});
            return;
        }
        bgTrace('puzzle move re-issued', {uci, msLeft: puzzle_retry.until - Date.now()});
        maybe_play_puzzle_move(last_eval.fen, {retry: true});
    }, PUZZLE_MOVE_RETRY_MS);
}

// Appended to the move readout, so a database move is never silently substituted for the engine's.
function puzzle_label() {
    if (!puzzle_pick(last_eval.fen)) return '';
    // The rating belongs on THIS line rather than beside the move: this is the line that says where
    // the move came from, and "how hard was it" is the same kind of fact.
    return (puzzle_from_page ? i18n('panel.puzzle_page_label', 'Page solution')
                            : i18n('panel.puzzle_db_label', 'Puzzle database'))
        + (puzzle_rating ? ` (${i18n('panel.msg.puzzle_rating', 'Rating {r}', {r: puzzle_rating})})` : '');
}

function explorer_enabled() {
    return (config.explorer || config.book_play)
        && (!config.variant || config.variant === 'chess') // API is standard-chess only here
        && !config.puzzle_mode;                            // puzzles are not book positions
}

// Fire-and-forget. Never awaited by the move path (see the note above).
function request_explorer(fen) {
    if (!explorer_enabled() || explorer_out_of_book) return;
    // Same rule as the tablebase probe: silent in a hidden tab, unless Background Play says the game
    // is still going. Otherwise a backgrounded game silently loses its book moves.
    if (document.hidden && !config.background_play) return;
    if (explorer_data?.fen === fen) return; // already have this position
    chrome.runtime.sendMessage({explorerLookup: {fen, db: config.explorer_db || 'masters'}}, (res) => {
        // A failed lookup must SAY so. Drawing nothing is indistinguishable from "the feature is
        // broken" -- which is exactly how a blocked endpoint presented.
        if (chrome.runtime.lastError || !res || res.error) {
            explorer_error = res?.error || chrome.runtime.lastError?.message || 'no response';
            explorer_data = null;
            console.warn('Mephisto: explorer lookup failed -', explorer_error);
            render_explorer();
            return;
        }
        explorer_error = null;
        if (!res.moves?.length) {
            // Don't latch on a SINGLE empty answer. "Out of book" at move 1 is impossible, so one
            // empty response means something is wrong with the lookup, not that the game left book
            // -- and latching there would kill the feature for the rest of the game with no retry.
            // Three in a row is a real exit from book; anything less retries on the next move.
            explorer_empty_streak++;
            console.warn(`Mephisto: explorer returned no moves for ${fen} (${explorer_empty_streak}/3)`);
            if (explorer_empty_streak >= 3) explorer_out_of_book = true;
            explorer_data = null;
            render_explorer();
            return;
        }
        explorer_empty_streak = 0;
        explorer_data = {fen, moves: res.moves, opening: res.opening || null};
        render_explorer();
    });
}

// ---- the user's OWN book (a Polyglot .bin imported on the settings page) ----------------------
// It lives in the EXTENSION's IndexedDB and the service worker answers per position with one
// binary search -- the puzzle database's architecture, because the panel's own indexedDB is the
// SITE's. `moves: null` from the worker means no book is loaded at all, which is latched so a
// bookless install costs one message per session, not one per move. An EMPTY answer is NOT
// latched, unlike the explorer: the probe is local and deterministic (no rate limit to protect),
// and a game can transpose back into a repertoire book after leaving it.
let own_book = null;          // {fen, moves: [{uci, weight}]} for the last position answered
let own_book_absent = false;  // the worker said no book is loaded (per panel lifetime)

// Fire-and-forget, exactly like request_explorer: the move path never waits for it.
function request_own_book(fen) {
    if (!config.book_play || own_book_absent) return;
    if (config.variant && config.variant !== 'chess') return;   // Polyglot keys standard chess
    if (config.puzzle_mode) return;
    if (own_book?.fen === fen) return;
    chrome.runtime.sendMessage({bookLookup: {fen}}, (res) => {
        if (chrome.runtime.lastError || !res || res.error) return;   // worker asleep/failed: retry next move
        if (res.moves === null) { own_book_absent = true; return; }
        own_book = {fen, moves: res.moves || []};
    });
}

// Fire-and-forget. Never awaited by the move path (see the note above).
function request_explorer(fen) {
    if (!explorer_enabled() || explorer_out_of_book) return;
    // Same rule as the tablebase probe: silent in a hidden tab, unless Background Play says the game
    // is still going. Otherwise a backgrounded game silently loses its book moves.
    if (document.hidden && !config.background_play) return;
    if (explorer_data?.fen === fen) return; // already have this position
    chrome.runtime.sendMessage({explorerLookup: {fen, db: config.explorer_db || 'masters'}}, (res) => {
        // A failed lookup must SAY so. Drawing nothing is indistinguishable from "the feature is
        // broken" -- which is exactly how a blocked endpoint presented.
        if (chrome.runtime.lastError || !res || res.error) {
            explorer_error = res?.error || chrome.runtime.lastError?.message || 'no response';
            explorer_data = null;
            console.warn('Mephisto: explorer lookup failed -', explorer_error);
            render_explorer();
            return;
        }
        explorer_error = null;
        if (!res.moves?.length) {
            // Don't latch on a SINGLE empty answer. "Out of book" at move 1 is impossible, so one
            // empty response means something is wrong with the lookup, not that the game left book
            // -- and latching there would kill the feature for the rest of the game with no retry.
            // Three in a row is a real exit from book; anything less retries on the next move.
            explorer_empty_streak++;
            console.warn(`Mephisto: explorer returned no moves for ${fen} (${explorer_empty_streak}/3)`);
            if (explorer_empty_streak >= 3) explorer_out_of_book = true;
            explorer_data = null;
            render_explorer();
            return;
        }
        explorer_empty_streak = 0;
        explorer_data = {fen, moves: res.moves, opening: res.opening || null};
        render_explorer();
    });
}

// Weighted-random pick, with BOTH filters the design calls for:
//   1. minimum games   -- the move has to be statistically real, not a 3-game curiosity
//   2. the engine veto -- it must also be within BOOK_MAX_LOSS cp of the engine's own best, judged
//      from the MultiPV lines the engine is already producing (no extra search)
// Returns a UCI move, or null to let the engine's move stand.
function book_pick(fen) {
    if (!config.book_play && !config.player_book) return null;
    // THE USER'S OWN BOOK OUTRANKS THE ONLINE STATISTICS: its lines are prep, played as given --
    // no minimum-games filter and no engine veto, because second-guessing a deliberately loaded
    // repertoire is exactly what loading one is meant to end. Weighted random over the book's own
    // weights; an all-zero-weight book (they exist) plays uniform rather than nothing. The rail's
    // own legality check still stands after this returns.
    if (own_book && own_book.fen === fen && own_book.moves.length) {
        const pool = own_book.moves.filter(m => m.weight > 0);
        const total = pool.reduce((s, m) => s + m.weight, 0);
        if (pool.length && total > 0) {
            let roll = Math.random() * total;
            for (const m of pool) { if ((roll -= m.weight) <= 0) return m.uci; }
            return pool[pool.length - 1].uci;
        }
        return own_book.moves[Math.floor(Math.random() * own_book.moves.length)].uci;
    }
    // THE PLAYER BOOK sits under an imported .bin (that one is a repertoire chosen on purpose) and
    // over the online statistics: a real person's own repeated choices beat a database average, and
    // this one has its own toggle, so it plays whether or not the explorer book is switched on.
    const mine = player_book_pick(fen);
    if (mine) return mine;
    if (!config.book_play) return null;          // the rest of this is the explorer's, and it is off
    if (!explorer_data || explorer_data.fen !== fen) return null;
    const evals = engine_line_scores();          // uci -> cp, from the current MultiPV lines
    const best = Math.max(...Object.values(evals), -Infinity);
    const pool = [];
    for (const m of explorer_data.moves) {
        const games = (m.white || 0) + (m.draws || 0) + (m.black || 0);
        if (games < BOOK_MIN_GAMES) continue;                       // filter 1: statistically real
        const cp = evals[m.uci];
        if (cp === undefined) continue;                             // engine never looked at it -> skip
        if (Number.isFinite(best) && best - cp > BOOK_MAX_LOSS) continue; // filter 2: engine veto
        pool.push({uci: m.uci, games});
    }
    if (!pool.length) return null;
    let roll = Math.random() * pool.reduce((s, m) => s + m.games, 0);
    for (const m of pool) { if ((roll -= m.games) <= 0) return m.uci; }
    return pool[pool.length - 1].uci;
}

// cp score per first-move-of-PV, from the lines the engine has already returned for this position.
// Mate scores collapse to a large cp so a mate never loses the veto comparison.
// Scores are OURS, not White's. `line.score`/`line.mate` are stored WHITE-relative (see the
// (turn === 'w' ? 1 : -1) flip in the info parsers), so book_pick's `Math.max(...)` was picking the
// line best for WHITE. As Black that is the line worst for us: the veto then kept the blunders and
// discarded the good book moves, and only as Black -- correct as White, so invisible half the time.
// line_cp_ours is the flip every other consumer already goes through, including mate-in-0.
function engine_line_scores() {
    const out = {};
    for (const line of last_eval.lines || []) {
        if (!line?.pv) continue;
        const uci = pv_moves(line.pv)[0];
        if (!uci) continue;
        const cp = line_cp_ours(line);
        if (typeof cp === 'number') out[uci] = cp;
    }
    return out;
}

// --- Set up a position by FEN ------------------------------------------------------------------
// Opens an input under the lines; a valid FEN is analysed instead of the page's board. While one is
// held the panel stops following the page entirely (see the `setup_fen` guard in the scrape handler),
// because a live scrape would otherwise replace it on the next poll.
// Play a move on the PANEL's own board and keep analysing from there. Any move takes the panel out
// of page-following mode (the same `setup_fen` hold the FEN box uses) -- otherwise the next scrape
// would overwrite the position a second later. That makes the little board a usable analysis board:
// set up or capture a position, then walk the line move by move. Returns false on an illegal move so
// the board just drops the selection.
// Does this move promote? Returns the mover's colour (so the picker shows the right pieces), or
// null. Asked BEFORE the move is made, so it works for click and drag alike.
function panel_move_promotes(from, to) {
    const base = setup_fen || last_eval.fen;
    if (!base) return null;
    try {
        const c = new Chess(config.variant, base);
        const m = c.moves({verbose: true}).find(x => x.from === from && x.to === to && x.promotion);
        return m ? m.color : null;
    } catch (e) {
        return null; // can't tell -> don't interrupt with a picker, the move path will auto-queen
    }
}

// --- Panel move history -------------------------------------------------------------------------
// A line you can walk. Every move played ON THE PANEL BOARD is appended here with the position it
// produced, so you can click back to any point and carry on from there -- and playing a different
// move at that point OVERWRITES the rest, which is what you want when you are trying something out
// rather than reviewing a fixed game.
//
// Deliberately a single line, not a tree. A branching tree needs a tree UI, and the thing being asked
// for is "let me take that back and try the other move", which truncation answers exactly.
let panel_line = [];      // [{san, uci, fen}] -- fen is the position AFTER that move
let panel_line_base = ''; // the position the line started from
let panel_line_idx = -1;  // -1 = at the base position, otherwise the index we are sitting on

function panel_line_reset(base) {
    panel_line = [];
    panel_line_base = base || '';
    panel_line_idx = -1;
    render_panel_line();
}

// Append a move, truncating anything after the point we are currently sitting on.
function panel_line_push(san, uci, fen) {
    if (panel_line_idx < panel_line.length - 1) panel_line.length = panel_line_idx + 1; // overwrite
    panel_line.push({san, uci, fen});
    panel_line_idx = panel_line.length - 1;
    render_panel_line();
}

// Jump to a point in the line. -1 is the position it started from.
function panel_line_goto(idx) {
    if (idx < -1 || idx >= panel_line.length) return;
    const fen = (idx === -1) ? panel_line_base : panel_line[idx].fen;
    if (!fen) return;
    panel_line_idx = idx;
    setup_fen = fen;
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) input.value = fen;
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = '';
    setup_fen_msg(i18n('panel.fen.walking_line', 'Walking the panel line - play a move to continue from here, Re-detect to follow the page'));
    last_eval.fen = ''; prev_ply_count = 0;
    abandon_search();
    try {
        turn = fen.split(' ')[1] || 'w';
        board.position(fen);
        update_turn_badge(fen);
    } catch (e) { /* board not ready */ }
    render_panel_line();
    on_new_pos(fen, fen, '');
}

// WALKING THE LINE WITH THE ARROW KEYS. Back is just the walker one step left. Forward is the
// interesting half: at the tip of the line there is nothing recorded yet, so it plays the engine's
// own best move FOR THE POSITION YOU ARE SITTING ON -- which is what makes this walking the PV
// rather than replaying a fixed list. Each step re-searches from where you land (panel_line_goto
// does that already), so the next press follows the engine's line from there.
function pv_walk_back() {
    if (panel_line_idx < 0) return false;   // already at the base: let the site have the key
    panel_line_goto(panel_line_idx - 1);
    return true;
}

function pv_walk_forward() {
    if (panel_line_idx < panel_line.length - 1) { panel_line_goto(panel_line_idx + 1); return true; }
    const at = (panel_line_idx === -1) ? (panel_line_base || last_eval.fen)
                                       : panel_line[panel_line_idx].fen;
    // Only extend with a line that belongs to the position we are actually on. Pressing forward
    // faster than the engine answers must do NOTHING rather than push another position's move.
    if (!at || last_eval.fen !== at) return false;
    const uci = pv_moves(last_eval.lines?.[0]?.pv)[0] || last_eval.lines?.[0]?.move;
    if (!uci) return false;
    try {
        const chess = new Chess(config.variant, at);
        if (!chess.move(uci)) return false;
        panel_line_push(chess.history().slice(-1)[0], uci, chess.fen());
        panel_line_goto(panel_line.length - 1);
        return true;
    } catch (e) { return false; }
}

function render_panel_line() {
    const el = PANEL_ROOT.getElementById('panel-line');
    if (!el) return;
    if (!panel_line.length) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    const parts = [`<span class="pl-move${panel_line_idx === -1 ? ' pl-current' : ''}" data-idx="-1">start</span>`];
    panel_line.forEach((m, i) => {
        const num = (i % 2 === 0) ? `${Math.floor(i / 2) + 1}.` : '';
        parts.push(`<span class="pl-move${i === panel_line_idx ? ' pl-current' : ''}" data-idx="${i}">${num}${m.san}</span>`);
    });
    el.innerHTML = parts.join(' ');
    // Scroll the strip ITSELF, by setting its scrollLeft. NOT scrollIntoView(): that walks up and
    // scrolls every ancestor scroll container it finds, which here means the panel body -- so a line
    // long enough to overflow dragged the WHOLE panel sideways and clipped the title, the readout and
    // the FEN box off the left edge.
    const cur = el.querySelector('.pl-current');
    if (cur) {
        const target = cur.offsetLeft - (el.clientWidth / 2) + (cur.offsetWidth / 2);
        el.scrollLeft = Math.max(0, target);
    }
}

// Where the piece on `square` may legally go, for the board's move dots. The board itself knows no
// rules -- it draws pieces and reports clicks -- so legality is answered here, against the position
// the panel is actually analysing.
//
// Returns [] rather than throwing on anything unexpected: a piece with no legal moves still selects,
// and an empty list is the honest answer for a pinned or blocked one. It also means a variant fen
// chess.js cannot parse degrades to "no dots" instead of breaking the board.
function panel_legal_targets(square) {
    try {
        const base = setup_fen || last_eval.fen;
        if (!base) return [];
        return new Chess(config.variant, base)
            .moves({square, verbose: true})
            .map(m => m.to);
    } catch (e) {
        return [];
    }
}

function play_on_panel_board(from, to, promotion) {
    const base = setup_fen || last_eval.fen;
    if (!base) return false;
    let next, san;
    try {
        const c = new Chess(config.variant, base);
        // `promotion` comes from the board's picker when the move promotes; queen otherwise
        const mv = c.move({from, to, promotion: promotion || 'q'});
        if (!mv) return false;
        next = c.fen();
        san = mv.san; // `mv` is block-scoped to this try -- read what we need while it is in scope
    } catch (e) {
        return false; // illegal move (or a variant fen chess.js can't parse) -> keep the position
    }
    // record it in the walkable line BEFORE setup_fen moves on -- the base is whatever we were on
    if (!panel_line.length && !panel_line_base) panel_line_base = base;
    panel_line_push(san, `${from}${to}${promotion || ''}`, next);
    setup_fen = next;
    stash_setup_state();
    // SHOW the setup row: it carries the "not following the page" message and the live FEN, and a
    // hidden row would leave that state invisible -- the board would just stop tracking the game with
    // no explanation. It also means the FEN of whatever you've walked to is always there to copy.
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = '';
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) input.value = next;
    setup_fen_msg(i18n('panel.fen.panel_board', 'Playing on the panel board - Re-detect to follow the page again'));
    last_eval.fen = ''; prev_ply_count = 0;
    opp_spend = opp_clock_mark = last_our_eval = null;
    explorer_out_of_book = false; explorer_data = null; explorer_empty_streak = 0;
    abandon_search();
    turn = next.split(' ')[1];
    // The header switch is only refreshed on the SCRAPE path, and a move played on the panel board
    // never goes near it -- so walking a line left the header stuck on whoever moved first while the
    // position underneath it had moved on. It is the panel's own move; it has to keep its own state.
    update_turn_badge(next);
    on_new_pos(next, next, '');
    return true;
}

// Read the position off the screen. Captures the tab, lets the recogniser find the board, and loads
// the result as a manual position -- so it works on any page (a video, a diagram, an image), and the
// board it produces is immediately playable. `crop` (from the drag-select fallback) skips detection.
// Rotate a position 180 degrees: a1 becomes h8. Colours are untouched -- this turns the BOARD, it
// does not swap sides.
//
// Needed because the board reader has no idea which way round the board on screen was. It maps the
// image's top-left corner to a8, always, so a board shown from Black's perspective (which is how
// every game looks to the player with black, and how plenty of videos are framed) is read upside
// down. The result is usually still a LEGAL position, so nothing downstream can catch it -- it just
// quietly analyses a different game. Detecting the orientation from pixels is not reliable, so this
// is offered as one click instead of guessed at.
// Which way up the panel draws a HELD position (a typed FEN or one read off the screen), or null to
// derive it from the side to move as before. It is remembered across follow ticks and panel rebuilds,
// because a board being watched on a screen does not turn round between plies -- and re-deriving it
// from the turn meant the view flipped every single move.
let setup_view = null;
// FOLLOW SCREEN reads a fresh board every tick and always maps the image's top-left to a8. On a
// board drawn from Black's side every read is therefore 180 degrees out -- and, because a rotated
// position is usually still LEGAL, nothing notices. Flipping used to rotate `setup_fen` only, so the
// very next read came back unrotated, could not be explained as one legal move, and re-seeded from
// the raw placement -- silently undoing the flip. That is the board "randomly flipping back".
// This flag makes the flip STICK: every incoming read is rotated before it is used.
let snap_flipped = false;

// The colour the panel is ANSWERING FOR, which is not the same question as which way the board is
// drawn. On a live game they coincide: the side the page shows us is the side we play. On a held
// position there is no "us" -- the answer wanted is always for whoever is to move -- and that is what
// apply_setup_fen used to encode by forcing the orientation to follow the turn. Splitting the two is
// what lets Flip board turn the VIEW round without the panel concluding it now plays the other
// colour and going quiet. For a live game this returns exactly board.orientation(), as before.
function our_side() {
    if (setup_fen) return (turn === 'w') ? 'white' : 'black';
    return board.orientation();
}

// ---- bot-game tricks: the panel half ---------------------------------------------------------
// The LIBRARY itself lives in src/scripts/bot-games.js, because the settings page offers the same
// list and duplicating eight game names in two files is how they drift apart. Only the parts that
// need chess.js and the translation layer are here.
const BOT_GAMES = (typeof self !== 'undefined' && self.MephistoBotGames) || [];

// PGN -> a plain list of SAN moves. The bundled chess.js is a trimmed build with no PGN support at
// all (no loadPgn, no header parsing), so this does the extraction, and a real PGN carries far more
// than moves: header tags, brace comments with clock and eval annotations on EVERY move, nested
// variations, NAGs, glyph suffixes, and a result marker. Anything not a move is removed here rather
// than fed to chess.js and caught as an error, because "your PGN is broken" is the wrong answer to
// a perfectly ordinary chess.com export.
function pgn_san_tokens(pgn) {
    let t = String(pgn || '').replace(/\r/g, '\n');
    t = t.replace(/^\s*%.*$/gm, ' ');            // escape-mechanism lines
    t = t.replace(/^\s*\[[^\]\n]*\]\s*$/gm, ' ');// header tags, whole lines only
    t = t.replace(/;[^\n]*/g, ' ');              // rest-of-line comments
    t = t.replace(/\{[^}]*\}/g, ' ');            // brace comments -- PGN braces do not nest
    // Variations DO nest, so one regex cannot do it: strip the innermost pair until none are left.
    // Bounded rather than while(true) -- a PGN with an unbalanced '(' would otherwise spin forever.
    for (let i = 0; i < 64 && /\([^()]*\)/.test(t); i++) t = t.replace(/\([^()]*\)/g, ' ');
    t = t.replace(/[()]/g, ' ');                 // an unbalanced bracket left over
    t = t.replace(/\$\d+/g, ' ');                // NAGs
    // Result markers BEFORE castling is normalised: "1-0" and "0-1" must not survive to be read as
    // a castle, and "1/2-1/2" must not leave a stray "1/2".
    t = t.replace(/\b(?:1-0|0-1|1\/2-1\/2|½-½)\b|\*/g, ' ');
    t = t.replace(/\d+\s*\.(?:\.\.)?/g, ' ');    // move numbers, with or without "..." and spacing
    t = t.replace(/\be\.p\.?/gi, ' ');           // the optional en-passant marker
    return t.split(/\s+/)
        .map(tok => tok
            .replace(/[!?]+$/, '')               // !, ?, !?, ?!, !!, ?? are commentary, not notation
            .replace(/^0-0-0/, 'O-O-O')          // some sources write castling with zeroes
            .replace(/^0-0/, 'O-O'))
        .filter(tok => /^(?:[KQRBN][a-h1-8]?x?[a-h][1-8]|[a-h]x?[a-h]?[1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/.test(tok));
}

// The game's result, in the notation everybody reads it in. Derived from the winner rather than
// stored beside it: two fields saying the same thing is one of them going stale.
function bot_result(winner) {
    return winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '\u00bd-\u00bd';
}

// A pasted game, checked the way the built-in lines are checked in the suite: replayed from the
// starting position, and accepted only if every move is legal AND the game is over at the end.
//
// OVER, not won. A checkmate is the obvious case, but a stalemate, a threefold, a fifty-move or a
// dead position all end a bot game just as completely -- chess.com's client claims those itself.
// What is NOT allowed is a game that finished by resignation or on time: that stops with the bot
// still to move, and it will then answer for real. Returns the reason rather than a line when it
// fails, because "nothing happened" is the failure people report.
function bot_pgn_line(pgn) {
    const text = String(pgn || '').trim();
    if (!text) return {error: i18n('panel.bot.pgn_empty', 'Paste a game into Settings first.')};
    const moves = pgn_san_tokens(text);
    if (!moves.length) return {error: i18n('panel.bot.pgn_unreadable', 'No moves found in that PGN.')};
    const check = new Chess();
    for (const san of moves) {
        try { if (!check.move(san)) return {error: i18n('panel.bot.pgn_illegal', 'Illegal move in that PGN: {m}.', {m: san})}; }
        catch (e) { return {error: i18n('panel.bot.pgn_illegal', 'Illegal move in that PGN: {m}.', {m: san})}; }
    }
    // A GAME THAT DOES NOT END ITSELF IS NO LONGER REFUSED. Most real games stop by resignation or
    // by agreement, and neither is a position any client can claim -- which used to rule out almost
    // every game anybody would want to paste. It is played out in full and then ended with a draw
    // claim, the same way the built-in classical game is. The bot never gets a turn either way.
    const mated = check.isCheckmate();
    const ends = check.isGameOver();
    return {id: 'pgn', name: i18n('panel.bot.pgn_name', 'Your pasted game'),
            // A draw belongs to neither colour, so it plays from either side.
            winner: mated ? (check.turn() === 'w' ? 'black' : 'white') : null,
            endWith: ends ? null : 'draw', moves};
}

// The list the dropdown shows, pasted game included when there is one.
function bot_game_choices() {
    const out = BOT_GAMES.slice();
    const custom = bot_pgn_line(config.bot_trick_pgn);
    if (!custom.error) out.push(custom);
    return out;
}

// Auto picks a line that WINS FOR US. our_side() is right on a live game (it is board.orientation()
// there), but the page is the authority and disagrees on a board drawn the other way round, which is
// why a wrong-colour answer retries rather than giving up.
function bot_pick(id, side) {
    const all = bot_game_choices();
    if (id && id !== 'auto') return all.find(g => g.id === id) || null;
    // Auto means WIN FOR ME, so a drawn line is not a candidate here however well it fits: it ends
    // the game and takes nothing. Picking one explicitly still plays it, from either colour.
    const fits = all.filter(g => g.winner === side);
    const pool = fits.length ? fits : all;
    // Shortest first is the wrong default -- that is the four-move mate every time. Pick at random
    // among the ones that fit so a run of bots does not leave an identical game in every archive.
    return pool[Math.floor(Math.random() * pool.length)] || null;
}

function on_computer_play_page() {
    try {
        return /(^|\.)chess\.com$/.test(location.hostname)
            && /^\/play\/computer(\/|$)/.test(location.pathname);
    } catch (e) { return false; }
}

// Fill the dropdown and show or hide the row. Cheap enough to run on the slow poll: it rebuilds the
// options only when the list or the selection actually changed, so it is a string compare per tick.
let bot_row_signature = null;
function sync_bot_row() {
    const row = PANEL_ROOT.getElementById('qs_bot_row');
    if (!row) return;
    const show = on_computer_play_page() && String(config.bot_tricks) === 'true';
    row.hidden = !show;
    if (!show) return;
    const sel = PANEL_ROOT.getElementById('qs_bot_game');
    if (!sel) return;
    const games = bot_game_choices();
    const want = config.bot_trick_game || 'auto';
    const sig = want + '|' + games.map(g => g.id + ':' + g.moves.length).join(',');
    if (sig === bot_row_signature) return;
    bot_row_signature = sig;
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    // AN EMPTY DROPDOWN LOOKS BROKEN AND SAYS NOTHING. The library is a separate content script, so
    // it can be absent for one real reason: the extension was updated without being reloaded, and
    // the manifest's new file was never injected. Say that, rather than render a blank box.
    auto.textContent = games.length
        ? i18n('panel.bot.auto', 'Auto (fits your colour)')
        : i18n('panel.bot.no_library', 'No games loaded - reload the extension');
    sel.appendChild(auto);
    for (const g of games) {
        const o = document.createElement('option');
        o.value = g.id;
        // The move count is the useful half of the label -- it is how long this will take -- and the
        // result after it, because a drawn line ends the game without winning it.
        const n = Math.ceil(g.moves.length / 2);
        o.textContent = i18n('panel.bot.opt', '{name} - {n} ({res})',
            {name: g.name, n, res: bot_result(g.winner)});
        sel.appendChild(o);
    }
    sel.value = games.some(g => g.id === want) ? want : 'auto';
    const play = PANEL_ROOT.getElementById('qs_bot_play');
    if (play) play.disabled = !games.length;   // Draw stays live: it needs no game at all
}

// One press. `retried` is the wrong-colour retry: our_side() is the board's orientation and the page
// knows better, so a mismatched Auto pick is re-picked once against the colour the page reports
// rather than reported as a failure the user has to fix by hand.
function run_bot_trick(what, retried) {
    const row = PANEL_ROOT.getElementById('qs_bot_row');
    const btn = PANEL_ROOT.getElementById(what === 'draw' ? 'qs_bot_draw' : 'qs_bot_play');
    const send = (req) => {
        if (btn) btn.disabled = true;
        chrome.runtime.sendMessage({botExploit: req}, (r) => {
            if (btn) btn.disabled = false;
            if (!chrome.runtime.lastError && r && !r.ok && r.why === 'wrong-colour' && r.side && !retried
                && (config.bot_trick_game || 'auto') === 'auto') {
                run_bot_trick(what, r.side);   // the page told us the colour; pick again for it
                return;
            }
            set_idle_reason(bot_trick_message(what, r));
        });
    };
    if (what === 'draw') { send({what: 'draw'}); return; }

    const want = config.bot_trick_game || 'auto';
    const game = bot_pick(want, retried || our_side());
    if (!game) {
        // The only way here is a chosen PGN that stopped parsing. Say which, not "nothing happened".
        const custom = bot_pgn_line(config.bot_trick_pgn);
        set_idle_reason(custom.error || i18n('panel.bot.no_game', 'No game to play - choose one first.'));
        return;
    }
    if (row) row.dataset.playing = game.id;
    send({what: 'mate', moves: game.moves, winner: game.winner, endWith: game.endWith || null,
          delay: Math.max(0, Math.min(5000, Number(config.bot_trick_delay) || 500))});
}

// Every failure here is something the user can act on, so each one is named. The default branch
// covers the shapes that all mean the same thing -- chess.com changed the board object under us --
// and prints the raw reason with it, because that is the report worth having.
function bot_trick_message(what, r) {
    if (chrome.runtime.lastError || !r) return i18n('panel.bot.gone', 'Could not reach the page.');
    if (r.ok) {
        if (r.did === 'draw') return i18n('panel.bot.drawn', 'The bot accepted a draw it was never offered.');
        return r.seconds > 3
            ? i18n('panel.bot.playing_long', 'Playing {n} moves - about {s}s.', {n: Math.ceil(r.moves / 2), s: r.seconds})
            : i18n('panel.bot.playing', 'Playing {n} moves.', {n: Math.ceil(r.moves / 2)});
    }
    switch (r.why) {
        case 'not-computer-page':
            return i18n('panel.bot.wrong_page', 'Bot tricks only work on the Play Computer page.');
        case 'not-enabled':
            return i18n('panel.bot.off', 'Turn Bot Tricks on in Settings first.');
        case 'no-board':
            return i18n('panel.bot.no_board', 'No bot game on this page yet - start one.');
        case 'not-move-1':
            return i18n('panel.bot.not_start', 'Only from the starting position - start a new bot game.');
        case 'wrong-colour':
            // Two whole sentences rather than one with the colour words substituted in. Slotting
            // "white"/"black" into a template needs them as standalone lowercase strings, which
            // reads badly in the languages that inflect them and worse in the ones that do not put
            // the subject there at all.
            return r.side === 'white'
                ? i18n('panel.bot.wrong_colour_white', 'That game is a win for black, and you are playing white.')
                : i18n('panel.bot.wrong_colour_black', 'That game is a win for white, and you are playing black.');
        case 'no-side':
            return i18n('panel.bot.no_side', 'Could not tell which colour you are playing.');
        default:
            return i18n('panel.bot.refused', 'The page refused it ({why}) - chess.com may have closed this.',
                {why: String(r.why || '?')});
    }
}

function rotate_fen_180(fen) {
    try {
        const parts = fen.split(' ');
        const squares = [];
        for (const ch of parts[0]) {
            if (ch === '/') continue;
            if (/\d/.test(ch)) squares.push(...Array(Number(ch)).fill(''));
            else squares.push(ch);
        }
        if (squares.length !== 64) return fen;
        squares.reverse(); // 180 degrees is simply the square sequence backwards
        const rows = [];
        for (let r = 0; r < 8; r++) {
            let row = '', gap = 0;
            for (let f = 0; f < 8; f++) {
                const sq = squares[r * 8 + f];
                if (sq) { if (gap) { row += gap; gap = 0; } row += sq; }
                else gap++;
            }
            if (gap) row += gap;
            rows.push(row);
        }
        parts[0] = rows.join('/');
        parts[3] = '-'; // any en-passant square is meaningless once the board has turned
        parts[2] = '-'; // ...and so are castling rights: they name squares the pieces have left
        return parts.join(' ');
    } catch (e) {
        return fen;
    }
}

// --- Follow the screen ---------------------------------------------------------------------------
// Re-read the SAME rectangle on a timer, so a board that is playing on screen -- a video, a stream,
// a game being shown in another app -- keeps the panel in step without capturing by hand each move.
//
// Only offered after a capture, because it needs the rectangle that capture found; there is nothing
// to re-scan before one. Each pass is the ordinary recognise path with detection skipped, so it is
// as cheap as it can be, and a scan that reads the SAME position does nothing at all -- an unchanged
// board must not restart the search on every tick.
// Chrome's own ceiling on captureVisibleTab: roughly two calls a second, and exceeding it fails the
// call rather than delaying it. This is the fastest a screen read can legally happen, so it is the
// floor between reads -- not a pacing choice of ours.
const SNAP_QUOTA_MS = 500;
// HOW HARD FOLLOWING IS ALLOWED TO PUSH: as hard as Chrome's capture quota allows. Slowing this
// down was the wrong lever -- what the machine actually spends is threads x duty cycle, and the
// THREAD BUDGET (see ort-env.js, default 2 cores, settable) bounds that no matter how often a read
// fires. Pacing on top of a budget just makes it late for no saving.
const SNAP_FOLLOW_MS = SNAP_QUOTA_MS;
let snap_follow_timer = null;
let snap_follow_busy = false;

function snap_following() {
    return snap_follow_timer !== null;
}

function snap_follow_stop() {
    if (snap_follow_timer !== null) clearTimeout(snap_follow_timer);
    snap_follow_timer = null;
    update_snap_follow_button();
}

function snap_follow_start() {
    if (snap_following() || !snap_crop) return;
    // Chained, NOT setInterval. A read is a full-tab PNG capture plus a 59MB ONNX pass, and
    // chrome.tabs.captureVisibleTab is throttled by Chrome to about 2 calls/second -- so a fixed
    // 250ms clock did not produce 4 reads/second, it produced quota errors and ticks dropped by the
    // busy flag, which is why the panel ran behind a video. Firing the next read when the last one
    // FINISHES runs the pipeline flat out at whatever rate it can actually sustain.
    const loop = async () => {
        if (snap_follow_timer === null) return;
        const t0 = Date.now();
        await snap_follow_tick();
        if (snap_follow_timer === null) return;
        // STRAIGHT BACK IN, BUT NOT FASTER THAN CHROME ALLOWS. The chain already guarantees one read
        // at a time, so a gap on top of that only adds latency -- except that captureVisibleTab is
        // quota'd at about two calls a second, and asking more often does not return frames faster,
        // it returns errors. Those are skipped reads, so over-asking is strictly slower than pacing.
        //
        // Measured from the START of the last read, so a slow read costs nothing extra: if it
        // already took longer than the quota window, the next one fires immediately.
        const since = Date.now() - t0;
        snap_follow_timer = setTimeout(loop, Math.max(0, SNAP_FOLLOW_MS - since));
    };
    snap_follow_timer = setTimeout(loop, 0);
    update_snap_follow_button();
    setup_fen_msg(i18n('panel.fen.following', 'Following the screen')); // terse: it sits above the buttons
}

function snap_follow_toggle() {
    if (snap_following()) { snap_follow_stop(); setup_fen_msg(i18n('panel.fen.stopped_following', 'Stopped following')); }
    else snap_follow_start();
}

// Which single legal move turns `prevFen` into the placement we just read off the screen? Returns the
// FULL fen after that move -- side to move, ep square, castling rights and counters all derived rather
// than guessed -- or null when nothing explains the read.
//
// Null is the important return. At this poll rate a settled board is one ply from the last one, so a
// placement that NO legal move produces is not a position: it is a frame caught mid-animation, or a
// square the recogniser got wrong. Skipping it is free (the next read is 250ms away) and accepting it
// is not: the panel would analyse a position that never existed, and any turn flip made on the way in
// would stay wrong for good.
//
// The second pass is what lets the colour sort itself out. A capture is seeded White-to-move because
// the recogniser reports pieces and nothing else; if the ply only makes sense as Black's, that IS the
// evidence that the seed was wrong, so it is adopted rather than left for the king switch.
function follow_infer_ply(prevFen, placement) {
    if (!prevFen) return null;
    const from_side = (fen) => {
        try {
            const chess = new Chess(config.variant, fen);
            const hits = [];
            for (const san of chess.moves()) {
                chess.move(san);
                if (chess.fen().split(' ')[0] === placement) hits.push(chess.fen());
                chess.undo();
                if (hits.length > 1) return null; // ambiguous -- take nothing rather than a coin flip
            }
            return (hits.length === 1) ? hits[0] : null;
        } catch (e) { return null; }
    };
    return from_side(prevFen) || from_side(flip_fen_turn(prevFen));
}

let snap_last_error = null;    // dedupe the read-failure warning
let snap_unexplained = 0;      // consecutive reads no single legal move explains
const SNAP_RESEED_AFTER = 4;   // ~2s at the 500ms quota cadence -- the 8 it used to be was calibrated for a 250ms loop, so the real delay had silently doubled to 4s

async function snap_follow_tick() {
    if (snap_follow_busy || !snap_crop) return;   // a slow read must not stack up behind itself
    if (document.hidden) return;                  // nothing of ours is on screen to read (see below)
    snap_follow_busy = true;
    try {
        const res = await chrome.runtime.sendMessage({captureAndRecognize: {crop: snap_crop}});
        if (res?.error) {
            // Surfaced, not swallowed. The usual one is Chrome's captureVisibleTab quota (~2/sec),
            // and a silent skip made that look like "the recogniser is slow" rather than "we asked
            // too often". Throttled reads are normal, so say it once rather than every tick.
            if (res.error !== snap_last_error) {
                snap_last_error = res.error;
                console.warn('Mephisto: screen read failed:', res.error);
            }
            return;
        }
        snap_last_error = null;
        if (!res || !res.placement) return;
        // Rotate the READ, not just the stored position. Everything below -- the unchanged-check,
        // the ply inference and the re-seed -- then works in the same frame the panel is holding.
        // `res` is a const, so this is a local rather than a reassignment.
        let placement = res.placement;
        if (snap_flipped) {
            const rot = rotate_fen_180(`${placement} w - - 0 1`).split(' ')[0];
            if (rot) placement = rot;
        }
        const prev = (setup_fen || '').split(' ');
        if (setup_fen && placement === prev[0]) return; // unchanged -- do not restart the search
        // Work out WHICH ply was played, rather than assuming one was. follow_infer_ply replays every
        // legal move from the position we hold and keeps the one that lands on what we just read, so
        // the side to move, the en-passant square, the castling rights and the move counters all come
        // out right -- and, just as importantly, the read is CONFIRMED. A bare "the pieces changed, so
        // flip the colour" cannot tell a ply from a single misread square, and one misread would put
        // the colour permanently out of phase for the rest of the session with nothing to correct it.
        // It also self-corrects the STARTING colour: the recogniser cannot see whose move it is, so a
        // capture is seeded White-to-move, and if the first ply only makes sense as a Black move the
        // inference says so and adopts it. That is the colour switching itself, instead of being your job.
        let fen = follow_infer_ply(setup_fen, placement);
        if (fen) {
            snap_unexplained = 0;
        } else {
            // Nothing legal explains the read. Usually that is a frame caught mid-animation and the
            // next tick resolves it -- but not always, and "wait for a read I can explain" was a trap:
            // if the board jumped more than one ply (a video scrubbed, a new game, a position the
            // recogniser got wrong once), NOTHING is ever one ply from what we hold and following
            // stops dead while still claiming to follow. So give up explaining after a short run and
            // take the position as read, seeding the turn the same way a fresh capture does.
            if (++snap_unexplained < SNAP_RESEED_AFTER) return;
            snap_unexplained = 0;
            const prev = (setup_fen || '').split(' ');
            fen = `${placement} ${prev[1] || 'w'} - - 0 1`;
            if (!is_legal_position(fen)) fen = flip_fen_turn(fen);
            console.warn('Mephisto: could not explain the board as one move -- re-seeding from what is on screen');
            setup_fen_msg(i18n('panel.fen.reseeded', 'Re-seeded · check the side to move'));
        }
        if (!is_legal_position(fen)) return;       // belt and braces; the inference only plays legal moves
        setup_fen = fen;
        stash_setup_state();
        const input = PANEL_ROOT.getElementById('setup_fen_input');
        if (input) input.value = fen;
        last_eval.fen = '';
        try { turn = fen.split(' ')[1] || 'w'; board.position(fen); update_turn_badge(fen); } catch (e) { /* */ }
        on_new_pos(fen, fen, '');
    } catch (e) {
        // the tab went away, or the offscreen recogniser is not up -- stop rather than spin
        snap_follow_stop();
        setup_fen_msg(i18n('panel.fen.follow_failed', 'Stopped following (the capture failed)'));
    } finally {
        snap_follow_busy = false;
    }
}

// The button exists only while there is a rectangle to re-scan.
function update_snap_follow_button() {
    const btn = PANEL_ROOT.getElementById('snap_follow');
    if (!btn) return;
    btn.hidden = !snap_crop;
    btn.textContent = snap_following() ? 'Stop following' : 'Follow screen';
    btn.classList.toggle('following', snap_following());
}

// THE PANEL GETS OUT OF THE WAY for a capture that has to FIND the board. Mephisto's panel carries
// a chessboard of its own, and the detector cannot know which one was meant -- it has picked the
// panel's. Blanking its rectangle in the captured frame was the first idea and is wrong: the panel
// overlaps the board it is being asked about, so blanking takes a strip of the real board with it.
//
// Only for a DETECTION snap. A follow read passes the box it already knows, so nothing is being
// searched for and the panel can stay where it is -- hiding it on every tick would flicker.
async function with_panel_hidden(fn) {
    const wrap = PANEL_ROOT.getElementById && PANEL_ROOT.getElementById('mephisto-overlay');
    if (!wrap) return fn();                       // toolbar popup: not part of the captured tab
    const before = wrap.style.opacity;
    wrap.style.opacity = '0';
    // two frames: one for the style to apply, one for the compositor to have painted without it
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
        return await fn();
    } finally {
        wrap.style.opacity = before || '';
    }
}

// The "least sure" line, as buttons. Clicking one swaps that square to the model's runner-up and
// re-analyses -- the whole point being that a single wrong square no longer means reading again.
function render_unsure(low, unresolved) {
    const el = PANEL_ROOT.getElementById('setup_fen_msg');
    if (!el) return;
    // a repaired square is ALWAYS shown, whatever its numbers now say: it was changed on rule
    // grounds, and its chip (whose runner-up is the original reading) is the one-click undo
    const unsure = (low || []).filter(sq => sq.prob < 0.9 || sq.repaired);
    el.textContent = 'Read from screen - turn with the king switch, orientation with Flip board';
    // a rule the runners-up could not fix is worth a plain sentence: the position on the board
    // genuinely breaks it, and the chips below are where to correct it by hand
    if (unresolved && unresolved.length) {
        el.textContent += ` · could not fix: ${unresolved.join(', ')}`;
    }
    if (!unsure.length) return;
    el.appendChild(document.createTextNode(' · least sure: '));
    unsure.forEach((sq, i) => {
        if (i) el.appendChild(document.createTextNode(', '));
        const name = (p) => (p ? p : 'empty');
        const chip = document.createElement('span');
        chip.className = 'mephisto-fix-chip';
        chip.textContent = `${sq.square} ${name(sq.piece)} ${Math.round(sq.prob * 100)}%`;
        if (sq.repaired) chip.textContent += ' (rule fix)';
        if (sq.alt !== undefined && sq.alt !== null && sq.alt !== sq.piece) {
            chip.title = sq.repaired
                ? `Changed because the read had ${sq.repaired}. Click to put back ${name(sq.alt)}.`
                : `Click to make ${sq.square} ${name(sq.alt)} (${Math.round((sq.altProb || 0) * 100)}%)`;
            chip.dataset.square = sq.square;
            chip.dataset.alt = sq.alt;
            chip.addEventListener('click', () => apply_square_fix(sq.square, sq.alt));
        } else {
            chip.classList.add('mephisto-fix-chip-dead');   // nothing to offer: still worth naming
        }
        el.appendChild(chip);
    });
}

// Put one piece on one square of the position that was read, and start again from there.
function apply_square_fix(square, piece) {
    const fen = (PANEL_ROOT.getElementById('setup_fen_input')?.value || setup_fen || '').trim();
    if (!fen) return;
    let next = null;
    try {
        const c = new Chess(config.variant, fen);
        if (piece) {
            const type = piece.toLowerCase();
            const color = (piece === piece.toUpperCase()) ? 'w' : 'b';
            c.remove(square);
            if (!c.put({type, color}, square)) return;      // chess.js refuses e.g. a second king
        } else {
            c.remove(square);
        }
        next = c.fen();
    } catch (e) {
        return;                                             // an edit that does not make a position
    }
    if (!next || !is_legal_position(next)) {
        setup_fen_msg(`Making ${square} ${piece || 'empty'} would not be a legal position.`);
        return;
    }
    setup_fen = next;
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) input.value = next;
    stash_setup_state();
    panel_line_reset(next);
    abandon_search();
    setup_fen_msg(`${square} is ${piece || 'empty'} now.`);
    on_new_pos(next, next, '');
}

async function snap_position(crop) {
    setup_fen_msg('');
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = '';
    setup_fen_msg(i18n('panel.fen.reading', 'Reading the board from the screen…'));
    let res;
    try {
        res = crop
            ? await chrome.runtime.sendMessage({captureAndRecognize: {crop}})
            : await with_panel_hidden(() => chrome.runtime.sendMessage({captureAndRecognize: {}}));
    } catch (e) {
        setup_fen_msg(i18n('panel.fen.capture_failed', 'Capture failed ({detail})', {detail: e}));
        return;
    }
    if (!res || res.error) {
        // No board found -> offer the manual path rather than dead-ending. This is the documented
        // fallback: the detector is the flakiest step on a busy page or a video frame.
        setup_fen_msg(`${res?.error === 'no board found' ? 'No board found' : `Failed: ${res?.error}`} - drag a box around the board`);
        request_drag_select();
        return;
    }
    // The recogniser reports placement only: it cannot know whose move it is or the castling rights.
    // Assume white to move with no rights -- both are then correctable (the header king switch flips
    // the turn, and the FEN box is right there showing what was read).
    // TURN IT ROUND IF IT IS PLAINLY UPSIDE DOWN. An image carries no side to move, so the reader
    // assumes White at the bottom -- and a board shown from Black's side comes out rotated, with
    // every answer about it wrong until someone presses Flip. The recogniser only says so when the
    // board's own coordinates say so, or failing that when the rules are lopsided about it.
    let placement = res.placement, auto_flipped = false;
    if (res.upsideDown) {
        placement = rotate_fen_180(`${placement} w - - 0 1`).split(' ')[0];
        auto_flipped = true;
    }
    const fen = `${placement} w - - 0 1`;
    if (!is_legal_position(fen)) {
        setup_fen_msg(i18n('panel.fen.illegal_read', 'Read a position that is not legal - try dragging a box around the board'));
        request_drag_select();
        return;
    }
    setup_fen = fen;
    snap_crop = res.box || crop || null; // remember WHERE it was read from
    stash_setup_state();
    update_snap_follow_button();
    panel_line_reset(fen); // a freshly read position starts its own line
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) input.value = fen;
    // Name the squares the model was least sure of -- and make each one a FIX. A misread square
    // usually still yields a legal position, so this used to be the only warning anyone got, with
    // no way to act on it short of reading the whole board again. Each chip now applies the
    // model's second choice for that square, which is what a misread almost always is.
    render_unsure(res.low || [], res.unresolved || []);
    // say it out loud: an automatic 180 is exactly the kind of thing that must never happen quietly
    if (auto_flipped) setup_fen_msg(i18n('panel.fen.auto_flipped',
        'Read from screen - Black was at the bottom, so the board was turned round. Flip board undoes it.'));
    last_eval.fen = ''; prev_ply_count = 0;
    opp_spend = opp_clock_mark = last_our_eval = null;
    explorer_out_of_book = false; explorer_data = null; explorer_empty_streak = 0;
    abandon_search();
    turn = 'w';
    setup_view = auto_flipped ? 'black' : null; // an auto-flip HAS been told which way up it is
    snap_flipped = auto_flipped;                // ...and so has its follow loop
    board.orientation(auto_flipped ? 'black' : 'white');
    on_new_pos(fen, fen, '');
}

// Ask the content-script to put a drag-to-select overlay on the page; it replies with the rect in
// image pixels, which goes back through the same recognise path with detection skipped.
function request_drag_select() {
    send_to_active_tab({dragSelect: true});
}

function setup_fen_msg(text) {
    const el = PANEL_ROOT.getElementById('setup_fen_msg');
    if (el) el.textContent = text || '';
}

function toggle_setup_fen() {
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (!row) return;
    if (setup_fen || row.style.display !== 'none') return clear_setup_fen(); // second click = back to live
    row.style.display = '';
    setup_fen_msg('');
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    if (input) { input.value = last_eval.fen || ''; input.focus(); input.select(); }
}

function apply_setup_fen() {
    const input = PANEL_ROOT.getElementById('setup_fen_input');
    const fen = (input?.value || '').trim();
    if (!fen) return clear_setup_fen();
    // Validate BEFORE anything downstream sees it. A bad position is worse than no position: an
    // illegal one crashes the wasm engine outright (the same OOB guard the scrape path has).
    let parsed;
    try {
        parsed = new Chess(config.variant, fen).fen();
    } catch (e) {
        setup_fen_msg(i18n('panel.fen.not_valid', 'Not a valid FEN'));
        return;
    }
    // chess.js SILENTLY falls back to the standard start position for input it can't read, so a
    // successful parse is not proof the FEN was understood -- typing junk would quietly set up a new
    // game. The piece placement round-trips exactly, so compare it: if it doesn't match what was
    // typed, chess.js substituted its default and the input was never a FEN.
    if (parsed.split(' ')[0] !== fen.split(/\s+/)[0]) {
        setup_fen_msg(i18n('panel.fen.not_valid', 'Not a valid FEN'));
        return;
    }
    if (!is_legal_position(parsed)) {
        setup_fen_msg(i18n('panel.fen.illegal', 'Illegal position'));
        return;
    }
    setup_fen = parsed;
    stash_setup_state();
    setup_fen_msg(i18n('panel.fen.set', 'Set - the panel is no longer following the page'));
    // treat it as a brand-new game so no stale pacing/premove/book state carries over
    last_eval.fen = ''; prev_ply_count = 0;
    opp_spend = opp_clock_mark = last_our_eval = null;
    explorer_out_of_book = false; explorer_data = null;
    abandon_search();
    turn = parsed.split(' ')[1];
    // The view is sticky once chosen (Flip board), and only DERIVED from the turn when it has never
    // been set. Deriving it every time meant the board spun round on every ply of a followed game --
    // which is also why our_side() exists: what the panel answers for no longer rides on this.
    board.orientation(setup_view || (turn === 'w' ? 'white' : 'black'));
    on_new_pos(parsed, parsed, '');
}

function clear_setup_fen() {
    panel_line_reset(''); // back to the live game -- the walked line is finished with
    setup_view = null;    // the page decides the orientation again
    snap_crop = null;
    snap_follow_stop();
    // The arrows drawn onto the region go with it. Help Mode redraws its own on the next position;
    // leaving these would strand an arrow over a board Mephisto is no longer reading.
    if (!config.help_mode) request_clear_hint();
    stash_setup_state(); // clears the stash: a reload must NOT bring the position back
    const row = PANEL_ROOT.getElementById('setup-fen-row');
    if (row) row.style.display = 'none';
    if (!setup_fen) return;         // was only open, never applied -- nothing to restore
    setup_fen = null;
    setup_fen_msg('');
    PANEL_ROOT.getElementById('recheck')?.click(); // back to the live game, same path as Re-detect
}

// A board that differs from a position in the line we are holding by EXACTLY ONE SQUARE.
//
// That cannot be a real position. Every legal move empties the square it leaves and fills the one it
// lands on, so any move changes AT LEAST two squares -- castling and en passant change more. One
// square different is arithmetically impossible from a move and can only be a bad read of the board.
//
// They happen. chess.com puzzle pages carry no move list, so the position is rebuilt from the piece
// elements on the board, and a poll landing mid-animation can read one of them wrong. The one that
// produced this: a black queen on c6 came back as a WHITE KNIGHT, in a game where white had no
// knight at all and our move onto that square was a PAWN capture. Identical to the real board in the
// other 63 squares.
//
// Left alone it was not merely cosmetic. The phantom is in no puzzle line, so it fell through to a
// full engine search, and that search's move was then drawn over the solution -- an arrow flicking to
// e1e7 in a puzzle whose answer was d5c6, and an eval bar moving for a position that has never
// existed. Ignoring the poll costs nothing: they arrive every few milliseconds and the next one is
// clean.
// A misread is a poll landing mid-animation, so it is gone within a frame or two. Anything still
// arriving a second later is the board's actual state, whatever it looks like, and must be allowed
// through -- ignoring it forever would be a panel that never moves again, which is the worse
// failure of the two by a distance. (This is the same lesson as the database lookup's own timeout:
// a wait that cannot end is not a safety measure.)
const MISREAD_TOLERANCE_MS = 1000;
let misread_board = null;   // the placement we are currently ignoring, and since when
let misread_since = 0;

function puzzle_misread(fen) {
    if (!puzzle_db_enabled() || !puzzle_solutions?.size) return false;
    const board = expand_placement(fen);
    if (!board) return false;
    const stm = String(fen).split(' ')[1] || 'w';
    let bad = false;
    for (const key of puzzle_solutions.keys()) {
        const [placement, known_stm] = key.split(' ');
        const known = expand_placement(placement);
        if (!known) continue;
        let diff = 0;
        for (let i = 0; i < 64 && diff < 2; i++) if (board[i] !== known[i]) diff++;
        // Same board, same side to move: this IS that position. Nothing else can outvote it.
        if (diff === 0 && stm === known_stm) { misread_board = null; return false; }
        // Same board, the OTHER side to move. Also impossible: every ply flips the side, so for a
        // placement to come back in a line the side to move comes back with it. This is the read
        // that survived the first version of this check -- placements compared, side ignored -- and
        // it cost a full engine search and a wrong arrow in the middle of a solved line.
        // One square different is impossible for the same reason a move cannot change fewer than two.
        if (diff === 1 || (diff === 0 && stm !== known_stm)) bad = true;
    }
    if (bad) {
        const seen = puzzle_key(fen);
        if (misread_board !== seen) { misread_board = seen; misread_since = Date.now(); }
        else if (Date.now() - misread_since > MISREAD_TOLERANCE_MS) {
            console.warn('Mephisto: a board that cannot be a real position has persisted -- ' +
                         'treating it as real');
            return false;
        }
        return true;
    }
    misread_board = null;
    return false;
}

// A FEN's placement field as a flat 64-character board, '.' for an empty square. Null if it isn't one.
function expand_placement(fen) {
    const rows = String(fen).split(' ')[0].split('/');
    if (rows.length !== 8) return null;
    let out = '';
    for (const row of rows) {
        for (const c of row) out += /[1-8]/.test(c) ? '.'.repeat(Number(c)) : c;
    }
    return out.length === 64 ? out : null;
}

// Everything the panel SHOWS for a database answer, in one place.
//
// All of this used to live inside maybe_play_puzzle_move, which returns immediately when the toggles
// forbid playing -- so with Autoplay off the panel drew the arrow and then said NOTHING: no move, no
// score, the previous position's numbers still sitting there. Showing the answer and playing it are
// different jobs and only the second one is Autoplay's business.
// The answer this position was given, kept for the diagnostics alone. A wrong move on a puzzle is
// either a wrong ANSWER or a right answer clicked onto the wrong squares, and a report that carries
// neither cannot tell them apart -- which is exactly the position one live report left us in.
// Paired with the content script's `lastAimed`, one paste settles it.
let last_puzzle_answer = null;

function show_puzzle_answer(uci) {
    try {
        last_puzzle_answer = `${uci} from ${puzzle_from_page ? 'page' : 'database'}`
            + (puzzle_rating ? ` (rated ${puzzle_rating})` : '')
            + ` for ${puzzle_key(last_eval.fen || '')}`
            + (puzzle_solutions ? ` [${puzzle_solutions.size} plies mapped]` : '');
    } catch (e) { last_puzzle_answer = `${uci} (context unavailable)`; }
    toggle_calculating(false);
    update_best_move(i18n('panel.msg.puzzle_solution', 'Puzzle solution: {move}', {move: uci}));
    // Nothing searched this position, so the number in the readout belongs to a DIFFERENT one --
    // usually the previous puzzle. Left there it reads as a live evaluation. What this slot has to
    // say is that there is NO score; where the move came from is the line above it, which already
    // reads "Puzzle database (Rating N)" -- saying it twice was two lines for one fact.
    update_evaluation(i18n('panel.msg.no_eval', 'No evaluation - the answer was known'));
    last_eval.lines = [];        // and no stale line for draw_moves or the alt-line list to redraw
    draw_eval_bar_unevaluated(); // ...nor a stale bar, which would claim an eval that was never made
    // ...nor a stale WIN/DRAW/LOSS row, and nor a stale NPS. Both are written ONLY from the engine's
    // info handler, so on this path -- where `puzzle_have` reaches `abandon_search()` and no search
    // is ever issued -- neither is reached, and both keep whatever the last real search left there
    // (the eval that runs between puzzles, on positions outside the line). Reported as "the engine
    // leaked through", which is exactly how it reads: a live-looking speed and a confident 100% sat
    // directly under a line saying nothing was evaluated. Nothing was: these are last week's
    // numbers, not this position's. Same reasoning as the score and the bar above them.
    //
    // NPS is deliberately sticky DURING a search (it holds the last good value through the opening
    // milliseconds, which report impossible speeds) -- that is why it survives to here, and why it
    // has to be cleared explicitly rather than left to the next reading.
    render_wdl(null);
    const npsEl = PANEL_ROOT.getElementById('nps');
    if (npsEl) npsEl.textContent = '';
}

function on_new_pos(fen, startFen, moves) {
    held_eval_line = null;   // a reading held for the PREVIOUS position is not this one's
    // Taken here and held in a LOCAL for the whole call: whichever push brought us in, that is the
    // one this position belongs to, and nothing that happens below can attach it to a different one.
    // Null on the paths that have no push behind them at all (a pasted FEN, the panel's own board,
    // a re-detect), which leaves `forPush` null and falls back to the older check.
    const pushKeyForThisPosition = incoming_push_key;
    incoming_push_key = null;
    // BEFORE the repaint and before the annotations are cleared: a misread must leave the panel
    // exactly as it was, and both of those are visible changes.
    if (puzzle_misread(fen)) {
        bgTrace('puzzle misread -- ignoring this poll', {fen: String(fen).split(' ')[0]});
        return;   // deliberately WITHOUT promoting incoming_push_key: we are still on the old position
    }
    // The key travels in a LOCAL from here (see the top of this function) and is adopted only where
    // last_eval is, far below. Adopting it here was wrong and shipped a wrong move: there are two
    // early returns between this point and last_eval -- the deferred puzzle lookup is one -- so the
    // panel could end up describing the OLD position with the NEW position's key. A move still
    // pending for the old one then passed its own last_eval guard AND carried the new reference, so
    // the content script compared the new board against the new key, matched, and clicked a stale
    // answer into a live board. Observed as e6g8, correct for the position it was found in.
    clear_idle_reason();   // a new position: whatever stopped the last move no longer applies

    console.log("on_new_pos", fen, startFen, moves);
    // PAINT FIRST. Showing the position we were just handed needs none of the ~200 lines below it --
    // not the search dispatch, the premove bookkeeping, the explorer/tablebase lookups or the native
    // configure round-trip -- yet the repaint used to sit at the very END of all of it, so the small
    // board visibly lagged the page. It is a synchronous DOM render (panel-board.js renders on the
    // spot, no animation), so doing it here costs nothing and the board tracks the page immediately.
    // Annotations come with it: they belong to the position that just left, and drawing the new
    // position under the old arrows is worse than a blank board for the moment before draw_moves().
    try {
        hide_4pc_board();   // a normal position means the 14x14 renderer must give the host back
        board.position(fen);
        clear_annotations();
        clear_book_annotations(); // stale book arrows go now; the new position's lookup redraws them
        // The board badge grades the move that LANDED here, so it belongs to the position that just
        // left. Cleared with the rest; draw_last_move_class puts the new one up once this position
        // has been graded.
        if (config.class_on_board) send_to_active_tab({clearMoveClass: true});
    } catch (e) { /* board not built yet (first push before init finished) -- the next push paints it */ }
    opp_alert_on_new_pos(fen); // arm the opponent-mistake check from the just-finished position's eval
    last_pos = {startFen: startFen || null, moves: moves || ''}; // Copy PGN reads this
    clear_next_move_eta(); // the countdown belonged to the position that just changed
    humanize_roll = null;  // and so did any pre-rolled humanize outcome
    if (config.help_mode) request_clear_hint(); // position changed; last hint is stale
    // WHERE THEY JUST CAPTURED, which is what makes our next move a recapture -- and a recapture is
    // the one move a human plays without thinking. Replaying the list is the only honest way to know
    // (a move list carries no capture flag), and it is a handful of moves on a chess.js board.
    last_capture_square = last_capture_from(startFen || fen, moves || '');
    premove_tracker = {fen: fen, startFen: startFen || fen, moves: moves || '', lines: {}}; // certifications belong to exactly one position
    // NEW-GAME RESET. On sites that swap games WITHOUT a page reload (taketaketake rematch, SPA
    // rematches), per-game pacing state would otherwise carry over -- Mirror Time mirroring the LAST
    // opponent's spend, or the wall-clock idle gap between games, and Humanize's swing keyed off the
    // finished game's eval. When the ply count drops back to the start, start the new game clean.
    const ply_count = moves ? moves.trim().split(/\s+/).filter(Boolean).length : 0;
    // a DROP in ply count back near the start = a new game (live-game plies only ever climb). The
    // `<= 4` keeps it to real restarts (catches fast bullet where a couple plies land before the
    // first scrape) while a transient mid-game mis-scrape can't trip it from a deep position.
    if (ply_count < prev_ply_count && ply_count <= 4) {
        opp_spend = null; opp_clock_mark = null; last_our_eval = null;
        explorer_out_of_book = false; explorer_data = null; explorer_empty_streak = 0; // new game = back in book
        // A NEW GAME IS A NEW OPPONENT AND A NEW CLOCK. Without this the prep book stayed keyed to
        // the last person and the "longest clock seen" carried a 15+10 game's base time into the
        // bullet game after it -- so a bullet game would have asked, which is exactly what the
        // gate exists to prevent.
        game_max_clock_s = 0; opp_prep_for = ''; opp_prep_book = null; opp_prep_games = 0;
        // A NEW GAME IS NOT PAST ANY LINE. Without this a resignation streak carried into the next
        // game and could end it three moves in, and a draw already offered would never be offered.
        resign_streak = draw_streak = 0; end_game_sent = '';
        // The game that just finished, folded into the session totals before anything is cleared.
        session_note_game(eval_history);
    }
    // fire the book lookup NOW so the answer has the whole search to arrive; never awaited
    request_explorer(fen);
    request_own_book(fen);
    maybe_player_book();   // one fetch per player per session; it latches itself
    request_tablebase(fen);
    request_puzzle_solution(fen);
    bgTrace('on_new_pos', {turn, autoplay: config.autoplay, puzzle: config.puzzle_mode,
        known: !!puzzle_pick(fen), fen: fen.split(' ')[0].slice(0, 46)});
    prev_ply_count = ply_count;
    // Do we already know this position's move (ply 2+ of a solution looked up a move ago)? Decided
    // HERE so the engine branch below can be skipped, but PLAYED at the very end of this function --
    // request_automove reads last_eval, and last_eval only describes this position once we get there.
    // TWO DIFFERENT QUESTIONS, and conflating them was the bug.
    //
    //   puzzle_have  -- does the DATABASE hold a move for this position? A fact about the database.
    //   puzzle_known -- may we PLAY it right now? A fact about the toggles: puzzle_move_ready
    //                   returns null with Autoplay off, or Help/Manual/Simon-Says on.
    //
    // Everything below except the actual move wants the FIRST one. Using the second meant that with
    // Help Mode on -- or Autoplay simply off -- the panel concluded it did not know a position the
    // database had answered, deferred the search, and RETURNED before the line that draws the
    // solution arrow. Every poll: annotations cleared at the top of this function, never redrawn.
    // Then the deferral watchdog gave up and ran a full engine search on a puzzle whose answer was
    // already in hand. Missing arrows and a busy engine, from one variable answering the wrong
    // question.
    const puzzle_have = !!puzzle_pick(fen);
    const puzzle_known = puzzle_move_ready(fen);
    toggle_calculating(true);
    // SIZE THE SEARCH TO THE PACE. When a clock-aware mode intends to spend, say, 1.2s on this move,
    // the engine should SEARCH ~1.2s (minus a margin to play it) rather than find a shallow move in
    // the default time and then idle -- the wait becomes a deeper move instead of dead time. Floor
    // at the configured search time so pacing never makes the engine think LESS than the default,
    // unless it's genuinely time to hurry (low clock, or a forced move). Pure Humanize (no clock)
    // keeps the default search: its long thinks key off the position's criticality, which isn't
    // known until after the search, so that time stays a post-search wait.
    const pace = paced_move_target_ms();
    let movetime = config.compute_time;
    if (pace != null) {
        const filled = Math.round(pace.ms - MOVE_MARGIN);
        movetime = pace.lowClock
            ? Math.max(50, Math.min(filled, Math.round(pace.ms))) // hurrying: let it drop below default
            : Math.max(config.compute_time, filled);              // else fill the pace, never under default
        movetime = Math.max(50, movetime);
    } else {
        // humanize without a clock mode: fill the estimated human think, never under the default
        const hz = humanize_presearch_ms(fen);
        if (hz != null) movetime = Math.max(config.compute_time, Math.round(hz - MOVE_MARGIN));
    }
    // a forced move (one legal reply) needs no thinking time -- play it fast even mid-pace
    try {
        if (new Chess(config.variant, fen).moves().length === 1) movetime = Math.min(movetime, config.compute_time);
    } catch (e) { /* variant fen chess.js can't parse -- skip the forced-move shortcut */ }

    // ...and in time trouble every move is that move. Applied last so it wins over the pacing modes,
    // which are budgeting a clock this says is nearly gone.
    if (in_time_trouble()) movetime = Math.min(movetime, TIME_TROUBLE_SEARCH_MS);
    search_start = Date.now();
    // start the countdown NOW (the search fills the pace), on our turn, when a mode changes the
    // base time -- so the full time counts down while the engine thinks. Category is added once the
    // move is picked. Cleared at the top of this function, so a non-pacing move shows nothing.
    // Manual Mode times the move itself (you press the key), so no auto-countdown.
    if (config.autoplay && !config.help_mode && !config.puzzle_mode && !config.manual_mode
        && ((turn === 'w') ? 'white' : 'black') === our_side()) {
        const est = estimated_move_total_ms(fen);
        if (est) {
            // pre-roll the humanize outcome so the countdown shows the coming move from the start
            if (config.humanize) humanize_roll = roll_humanize_category(fen);
            set_move_countdown(search_start + est.ms, est.source, humanize_roll ? humanize_roll.category : null);
        }
    }
    // whose move is it -- drives the ponder budget (remote/native) and the per-turn thread cap (WASM)
    const our_turn = ((turn === 'w') ? 'white' : 'black') === our_side();
    // Puzzle Mode never analyses the opponent's turn. In a puzzle their reply is scripted and lands
    // in a couple of hundred ms, and nothing consumes an opponent-turn search here: Premove is
    // disabled in Puzzle Mode (all three entry points bail on it), so there is no certification to
    // feed, and the bestmove it produces moves one of THEIR pieces, which premove_reply_playable
    // rejects anyway. It only burns cores and leaves a search in flight that the real position then
    // has to supersede. Stop whatever is running and wait for their move instead.
    // Ponder width, hoisted ABOVE the engine branch because it is engine-agnostic. It used to live in
    // the WASM branch only, so on a native engine Pondering never actually widened the candidate list
    // and premove_lines stayed at 2 -- the width bought nothing there. See the remote branch below
    // for why the configure has to be awaited rather than fired alongside the analyse.
    const ponder_now = config.ponder && !our_turn;
    premove_lines = ponder_now ? ponder_line_count(fen, moves ? moves.trim().split(' ').pop() : null) : 2;
    const want_multipv = ponder_now ? premove_lines : effective_multipv();

    // WAIT FOR THE DATABASE BEFORE SEARCHING. The lookup is a message to the worker plus a disk
    // read; a search is slower, but not always, and the engine finishing first is what produced
    // moves that failed puzzles the database could have solved. Deferred, not skipped: the answer
    // re-enters this function, so a miss searches exactly as it always did.
    if (puzzle_db_enabled() && !puzzle_have && puzzle_answered !== puzzle_key(fen)) {
        puzzle_deferred = {fen, startFen, moves};
        abandon_search();
        toggle_calculating(true);
        clearTimeout(puzzle_defer_timer);
        puzzle_defer_timer = setTimeout(() => {
            console.warn('Mephisto: the puzzle database did not answer in time -- searching anyway');
            puzzle_answered = puzzle_key(fen);   // do not wait again for this position
            release_deferred_search(fen);
        }, PUZZLE_LOOKUP_WAIT_MS);
        return;
    }
    if (puzzle_have) {
        // Nothing is searched here, so nothing will ever repaint the readout or the eval bar -- and
        // left alone they keep showing the LAST position's score over this one, which reads as a live
        // evaluation of a position no engine has looked at. That is where "why is the engine still
        // evaluating?" comes from about an engine that is not running. A database answer has no
        // score: say so, and park the bar at a draw. No eval, no claim.
        //
        // Both are done HERE rather than in maybe_play_puzzle_move, which only runs when the move is
        // actually played -- with Autoplay off the stale number stayed on screen.
        // THE MOVE IS ALREADY DECIDED, SO NOTHING IS SEARCHED. `puzzle_have`, not `puzzle_known`:
        // the answer is in the database whether or not the toggles let us play it, and Help Mode
        // wants to be SHOWN that answer without an engine deciding anything. The database answer is the move; an
        // evaluation of a position we are not choosing in is a number nobody acts on, bought with a
        // search on every puzzle.
        //
        // There used to be a depth-10 "display only" search here, purely so the readout had a score
        // in it. It cost two bugs in one day: the flag that marked its result unplayable was cleared
        // in exactly one place, so any path that ended the search another way -- the next puzzle
        // arriving, or simply having Autoplay off, which put the clear behind an unreachable branch
        // -- left it set, and the NEXT position's real bestmove was then discarded as "display
        // only". No move, no error, no second search. A feature whose entire output was a number on
        // screen is not worth a latch that can swallow the next move.
        abandon_search();
    } else if (config.puzzle_mode && (!our_turn || puzzle_in_line(fen))) {
        // Their turn, OR a position inside the line we are already holding. Nothing here is ours to
        // decide, so nothing is searched -- and the second test does not depend on having read the
        // side to move correctly off the board.
        abandon_search();
        if (puzzle_in_line(fen)) draw_eval_bar_unevaluated();
    } else if (is_remote()) {
        // pure analysis (Help Mode / Autoplay off) keeps deepening like the WASM `go infinite`: give
        // it a long budget that the next position (a new request supersedes this one) cuts short.
        // PONDERING rides the same rail on the opponent's turn: the native hosts and remote engine
        // turn this `time` into their search limit, so the engine thinks through their whole move
        // instead of stopping after our move time. Superseded by the next position like Help Mode.
        const open_ended = config.help_mode || !config.autoplay || config.manual_mode
                           || (config.ponder && !our_turn);
        // MULTIPV NEEDS A SEARCH THAT ENDS. a native host may compute lines 2..k only once the main search is
        // over -- re-searching with the better lines' first moves excluded at the root, then emits
        // the whole `multipv 1..k` batch in one go, just before bestmove. On the open-ended rail that
        // moment never arrives: the panel asks for an hour, the engine streams untagged per-depth
        // frames forever, every one of them lands on line 1, and the Multi Lines panel shows exactly
        // one row no matter what the slider says. (Verified against the host: at time=3600000, 15s of
        // streaming yields 20 info frames and not one multipv tag; at time=250 it yields all five.)
        //
        // So when more than one line is asked for, bound the search even in analysis mode. The cost
        // is real and worth naming: analysis stops deepening at the move budget instead of running
        // indefinitely. That is the trade for MultiPV working at all -- and at Multi Lines 1, which
        // is the default, nothing changes.
        // The Analysis Limit, where the user set one: it replaces the hour-long rail rather than
        // riding on top of it, and a nodes/depth limit still travels with a TIME so the host has a
        // ceiling (an unreachable depth on a slow box would otherwise run to NATIVE_MAX_RT anyway).
        const limit = open_ended ? analysis_limit_value(config.analysis_limit_mode, config.analysis_limit) : null;
        const limit_depth = (limit != null && config.analysis_limit_mode === 'depth') ? limit : null;
        const limit_nodes = (limit != null && config.analysis_limit_mode === 'nodes') ? limit : null;
        let rt = (open_ended && !(uses_native() && want_multipv > 1)) ? 3600000 : movetime;
        if (limit != null) rt = (config.analysis_limit_mode === 'time') ? limit : Math.max(rt, 60000);
        // A NATIVE SEARCH CANNOT BE CALLED BACK, so it must never be open-ended.
        //
        // `abandon_search()` sends UCI `stop`, and send_engine_uci is a NO-OP for a native host --
        // `engine` is only ever set for the WASM lane. So an abandoned native search is not
        // abandoned at all: the host keeps working on it and the next request QUEUES BEHIND IT.
        // On the analysis rail (Help Mode, Manual Mode, or simply Autoplay off) that orphan was an
        // HOUR long, and the watchdog that would free the slot only arms below 60s -- so one toggle
        // of Autoplay could leave the host chewing on a dead position for the rest of the session,
        // which is why it stayed slow into the next GAME: the host process outlives the page.
        // Bounded, the orphan dies on its own and the watchdog always arms.
        // The cap exists because an abandoned native search used to be unstoppable. A limit the user
        // typed in is not the case it protects against, so an explicit one is honoured up to a
        // minute -- which is also where the watchdog below still arms.
        if (uses_native()) rt = Math.min(rt, limit != null ? 60000 : NATIVE_MAX_RT);
        const posKey = moves ? `${startFen}|${moves}` : fen;
        const send_analysis = () => {
            if (uses_native() && native_inflight === posKey) {
                console.log('Mephisto: already analysing this position -- not issuing a second search');
                return;
            }
            const fresh = remote_result_gate(); // drop this result if the position moves on first
            // Cleared however the promise settles -- including for a result we discard as
            // superseded -- so a later push for this same position can still be searched.
            const settle = () => { if (native_inflight === posKey) native_inflight = null; };
            if (uses_native()) {
                native_inflight = posKey;
                if (rt <= 60000) {
                    setTimeout(() => {
                        if (native_inflight !== posKey) return;   // it settled; nothing to do
                        console.warn('Mephisto: the engine never answered this search -- releasing ' +
                                     'it so the next position push can retry');
                        native_inflight = null;
                    }, rt + 6000);
                }
            }
            const want_depth = limit_depth || (searching_by_depth() ? config.compute_depth : null);
            if (moves) {
                request_remote_analysis(startFen, rt, moves, want_depth, limit_nodes)
                    .then(fresh(on_engine_response)).catch(fresh(on_remote_error)).finally(settle);
            } else {
                request_remote_analysis(fen, rt, null, want_depth, limit_nodes)
                    .then(fresh(on_engine_response)).catch(fresh(on_remote_error)).finally(settle);
            }
        };
        // The host reads MultiPV out of its stored options, not out of the analyse request, so the
        // width is configured separately. FIRE AND FORGET, never awaited.
        //
        // It was awaited at first, to avoid a race: the host handles each message on its own thread
        // and they only serialise on the engine lock, so a configure sent alongside an analyse can
        // lose and apply its width to the NEXT position instead. That reasoning was right and the
        // fix was wrong -- chaining the analysis onto the configure's promise means a configure that
        // never settles issues NO SEARCH AT ALL. With Pondering on, the width changes every time the
        // turn flips, so that is one round-trip per move, and one that fails to resolve leaves the
        // panel with a spinning progress bar and no move. A width that is one position stale is a
        // vastly better failure than a search that never starts.
        if (want_multipv !== remote_multipv_set) {
            remote_multipv_set = want_multipv;
            // on failure, forget what we think the host has so the next position re-pushes it
            request_remote_configure({MultiPV: want_multipv}).catch(() => { remote_multipv_set = null; });
        }
        send_analysis();
    } else {
        // discards the flushed bestmove of the search we're superseding -- `turn` already belongs to
        // the NEW position, so if the old search was for the opponent's side (they replied mid-search)
        // that stale bestmove would otherwise be automoved as OUR move
        abandon_search();
        // Threads/Hash changed while a search was running: apply them NOW, in the gap between the
        // stop above and the go below. That is the only point UCI allows it.
        //
        // BEFORE the per-turn cap, not after. It used to run after, so on the opponent's turn the cap
        // sent `Threads 2` and the flush immediately sent the slider's full value straight over the
        // top of it -- two contradictory setoptions back to back, the background search running at
        // full cores, and search_threads_set left equal to the full count so nothing ever corrected
        // it. Flushing first makes the cap the last word, which is the whole point of the cap.
        flush_engine_options();
        // Thread budget per turn: our move gets the full count; the opponent's turn is background
        // work, so it is capped unless Pondering is on (then keep full strength -- see the go
        // below, which also lets a ponder run infinite for the whole opponent think). Maia is a single
        // forward pass with no Threads option, so leave it alone. Only re-push when the target changes.
        if (!is_one_pass()) {
            // The cap applies ONLY to the real in-game wait on the opponent. Analysis / Help / Manual
            // have no opponent to save cores for, so they keep the full count -- as does our own move.
            //
            // 2, not 1: this search is what Premove certifies from, and certification now needs the
            // pair stable at depth 13 AND 14 (see PREMOVE_DEPTH_PREV/LAST). One thread frequently
            // never got there inside the move time, so premoves stopped firing with Pondering off.
            // Two roughly doubles the nodes for the same wall clock while still leaving the machine
            // to the browser. Never ABOVE the user's own budget -- if they set 1 thread, they get 1.
            const bg_wait = config.autoplay && !config.help_mode && !config.manual_mode
                && !our_turn && !config.ponder;
            const want_threads = bg_wait ? Math.min(2, config.threads) : config.threads;
            if (want_threads !== search_threads_set) {
                send_engine_uci(`setoption name Threads value ${want_threads}`);
                search_threads_set = want_threads;
            }
        }
        // Re-assert the line count every move: humanize_rates() is read fresh per pick, so turning
        // the Mistakes/Blunders sliders on has to widen the engine's list NOW (see
        // effective_multipv). Set at engine init only, those sliders would silently do nothing until
        // the next re-init -- the exact trap that made the whole mix look broken. Free between
        // searches; we just stopped one. (The remote/native path reaches the same width a different
        // way: an analyse request carries only {fen, time, moves}, so MultiPV goes to the host via
        // request_remote_configure -- see the awaited push in that branch.)
        // Pondering overrides the width: the opponent's turn is searched over their top few candidate
        // replies (ponder_line_count), not our configured line count -- premove_lines mirrors it so an
        // instant reply can be certified for any of them.
        // ONLY WHEN IT CHANGED, exactly like Threads above and like the native lane's
        // remote_multipv_set. This runs in the gap between `stop` and `go`, and with Autoplay off or
        // Help Mode on the search being stopped is `go infinite` -- so every command sent here waits
        // behind an engine that is still tearing that search down. The width almost never changes
        // between two moves, so this was a command's worth of that wait on every single move, bought
        // for nothing. (The reason it is re-asserted at all is real and unchanged: humanize_rates()
        // is read fresh per pick, so a Mistakes/Blunders slider must widen the list NOW -- that
        // still happens, because changing it changes the value.)
        if (want_multipv !== search_multipv_set) {
            send_engine_uci(`setoption name MultiPV value ${want_multipv}`);
            search_multipv_set = want_multipv;
        }
        if (moves) {
            send_engine_uci(`position fen ${startFen} moves ${moves}`);
        } else {
            send_engine_uci(`position fen ${fen}`);
        }
        // Manual Mode searches forever too: it plays on YOUR keypress, never on a timer. Pondering on
        // the opponent's turn is also open-ended: ponder the whole think, abandon_search cuts it off
        // the instant they move (its bestmove is discarded, being for the opponent's side).
        if (config.help_mode || !config.autoplay || config.manual_mode || (config.ponder && !our_turn)) {
            // pure analysis / manual / ponder: no move is owed, so the search runs to the Analysis
            // Limit -- and that limit is infinite unless the slider was moved off its right end.
            send_engine_uci(`go ${analysis_go_args() || 'infinite'}`);
        } else if (searching_by_depth()) {
            // `go depth` only -- NOT `go depth N movetime M`. A movetime alongside a depth is a
            // race, and whichever fires first decides, which would make the reproducible instrument
            // stop being reproducible on a slow machine. The pacing modes still hold the move back
            // afterwards; they just no longer cut the search short.
            send_engine_uci(`go depth ${config.compute_depth}`);
        } else {
            send_engine_uci(`go movetime ${movetime}`); // autoplay needs a final bestmove to act on
        }
        search_active = true;
    }

    // (the repaint + annotation clear that used to live here now run at the TOP of this function)
    if (config.simon_says_mode) {
        const toplay = (turn === 'w') ? 'White' : 'Black';
        if (toplay.toLowerCase() !== our_side()) {
            draw_moves();
            request_console_log('Best Move: ' + notate(last_eval.fen, last_eval.bestmove));
        }
    }
    last_eval = {fen, activeLines: 0, lines: new Array(config.multiple_lines),
        lastMove: moves ? moves.trim().split(' ').pop() : null}; // opp's last move (humanize recapture check)
    // IN THE SAME BREATH AS last_eval, and only here. The reference exists to say which board a move
    // was computed for, so it has to describe the position the panel is actually reasoning with --
    // if the two can drift apart, the check reads as passing while comparing the wrong pair.
    analysed_push_key = pushKeyForThisPosition;
    // A known solution means no search ran, so nothing else will ever call draw_moves for this
    // position -- the arrow has to be drawn from here or there is no arrow at all.
    //
    // INSTRUMENTED: `puzzle_known` and `puzzle_solutions` are two pieces of state that can disagree
    // -- known says "this puzzle is in the database", the Map says "and here is the move for THIS
    // position in it". A position the line has already passed leaves the first true and the second
    // empty, which would clear the arrows on every poll and never redraw them. Reported as both, so
    // the next trace says which.
    const pick = puzzle_pick(fen);
    bgTrace('puzzle arrow', {pick: pick || null, known: puzzle_known,
        haveSolutions: !!puzzle_solutions, entries: puzzle_solutions ? puzzle_solutions.size : 0,
        key: puzzle_key(fen)});
    // AFTER last_eval was moved to this position, not in the branch above it. The readout's own
    // label calls puzzle_pick(last_eval.fen) to decide whether to say "Puzzle database (Rating N)",
    // so showing the answer any earlier labelled the PREVIOUS position -- which is why the rating
    // was missing.
    if (pick) { show_puzzle_answer(pick); draw_moves(); }
    if (puzzle_known) maybe_play_puzzle_move(fen);
}

// Restore the en-passant square on a position that was rebuilt from PIECES ALONE (chess.com
// puzzles: no move list on the page). Such a FEN always serialises "-" for ep, so an ep capture is
// invisible to the engine -- and in a pawn endgame that is frequently the entire point of the
// puzzle, which is why they were being failed. `lastMove` is the page's last-move highlight.
//
// The square is only declared when the capture is genuinely available: the last move was a two-rank
// pawn push, and a pawn of the side to move stands beside it. Declaring it otherwise would change
// the position's identity (and its hash) without changing what is legal.
// Restore castling rights on a position rebuilt from PIECES ALONE. Same root cause as the missing
// en-passant square: clear()+put() cannot carry rights, so every chess.com puzzle position came out
// with "-" and NEITHER side could ever castle. That is wrong twice over -- the engine can't find a
// solution that IS O-O, and, far more often, it evaluates a position that isn't the one on screen
// (king safety and rook activity both hinge on whether the king may still castle), so it plays a
// good move for the wrong position.
//
// Inferred the standard way, from the board: a side gets a right only when its king sits on the home
// square AND the matching rook sits on its home corner. That is the same convention diagram-to-FEN
// tools and chess.com's own puzzle FENs use. It is a well-behaved guess, not proof -- a king or rook
// that moved away and came back would be granted a right it does not really have. In a tactical
// puzzle that is vanishingly rare, and the failure it replaces (never castling, in every puzzle) is
// both far more common and worse: the wrong castle at most fails to click, the wrong evaluation
// silently picks the wrong move.
//
// Standard chess only: chess960 home squares are not e1/a1/h1, and this path already handles a real
// game's move-0 position separately (isStartPos), where the rights are a fact rather than a guess.
function apply_castling_rights(fen) {
    if (config.variant && config.variant !== 'chess') return fen;
    try {
        const c = new Chess(config.variant, fen);
        const home = (sq, type, color) => {
            const p = c.get(sq);
            return !!p && p.type === type && p.color === color;
        };
        let rights = '';
        if (home('e1', 'k', 'w')) {
            if (home('h1', 'r', 'w')) rights += 'K';
            if (home('a1', 'r', 'w')) rights += 'Q';
        }
        if (home('e8', 'k', 'b')) {
            if (home('h8', 'r', 'b')) rights += 'k';
            if (home('a8', 'r', 'b')) rights += 'q';
        }
        // An empty inference CLEARS the field, it does not leave the old one standing. The piece-only
        // rebuild arms KQkq before placing pieces, and chess.js assigns those bits 960-style to
        // whatever squares the kings and rooks land on -- so a position with both kings off their home
        // squares kept rights that no rook backs. chess.js will then happily generate a castle from
        // them (a rook endgame with kings on d4/d6 offered O-O), while the engine, which ignores
        // unbacked rights, never suggests it. For standard chess this inference is the whole truth.
        rights = rights || '-';
        const fields = fen.split(' ');
        if (fields[2] === rights) return fen;
        fields[2] = rights;
        const patched = fields.join(' ');
        new Chess(config.variant, patched); // reject a patch this chess.js won't parse
        return patched;
    } catch (e) {
        return fen; // the position without rights is still a valid position
    }
}

function apply_ep_square(fen, lastMove) {
    if (!/^[a-h][1-8][a-h][1-8]$/.test(lastMove ?? '')) return fen;
    try {
        const [from, to] = [lastMove.slice(0, 2), lastMove.slice(2, 4)];
        if (from[0] !== to[0]) return fen;                       // not a straight push
        const moved = new Chess(config.variant, fen).get(to);
        if (!moved || moved.type !== 'p') return fen;             // not a pawn that landed there
        const stm = fen.split(' ')[1];
        if (moved.color === stm) return fen;                      // the mover must be the OTHER side
        const [fromRank, toRank] = [Number(from[1]), Number(to[1])];
        const double = (moved.color === 'w' && fromRank === 2 && toRank === 4)
                    || (moved.color === 'b' && fromRank === 7 && toRank === 5);
        if (!double) return fen;
        // an enemy pawn must actually be beside the pushed pawn, or there is no ep right to record
        const file = to.charCodeAt(0);
        const board = new Chess(config.variant, fen);
        const adjacent = [file - 1, file + 1]
            .filter(f => f >= 'a'.charCodeAt(0) && f <= 'h'.charCodeAt(0))
            .map(f => board.get(String.fromCharCode(f) + to[1]));
        if (!adjacent.some(p => p && p.type === 'p' && p.color === stm)) return fen;

        const fields = fen.split(' ');
        fields[3] = to[0] + ((moved.color === 'w') ? '3' : '6');
        const patched = fields.join(' ');
        new Chess(config.variant, patched); // reject a patch this chess.js won't parse
        return patched;
    } catch (e) {
        return fen; // anything unexpected: the position without ep is still a valid position
    }
}

function parse_position_from_response(txt) {
    const prefixMap = {
        li: i18n('panel.detected_on', 'Game detected on {site}', {site: 'Lichess.org'}),
        cc: i18n('panel.detected_on', 'Game detected on {site}', {site: 'Chess.com'}),
        bt: i18n('panel.detected_on', 'Game detected on {site}', {site: 'BlitzTactics.com'}),
        tt: i18n('panel.detected_on', 'Game detected on {site}', {site: 'TakeTakeTake'}),
        cb: i18n('panel.position_detected_on', 'Position detected on {site}', {site: 'ChessBase Tactics'}),
    };

    function parse_position_from_moves(txt, startFen = null) {
        const directKey = (startFen) ? `${startFen}_${txt}` : txt;
        const directHit = fen_cache.get(directKey);
        if (directHit) { // reuse position
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        let record;
        const lastMoveRegex = /([\w-+=#]+[*]+)$/;
        const indirectKey = directKey.replace(lastMoveRegex, '');
        const indirectHit = fen_cache.get(indirectKey);
        if (indirectHit) { // append newest move
            const chess = new Chess(config.variant, indirectHit.fen);
            const moveReceipt = chess.move(txt.match(lastMoveRegex)[0].split('*****')[0]);
            turn = chess.turn();
            record = {fen: chess.fen(), startFen: indirectHit.startFen, moves: indirectHit.moves + ' ' + moveReceipt.lan}
        } else { // perform all moves
            const chess = new Chess(config.variant, startFen);
            const sans = txt.split('*****').slice(0, -1);
            let moves = '';
            for (const san of sans) {
                const moveReceipt = chess.move(san);
                moves += moveReceipt.lan + ' ';
            }
            turn = chess.turn();
            record = {fen: chess.fen(), startFen: chess.startFen(), moves: moves.trim()};
        }

        fen_cache.set(directKey, record);
        return record;
    }

    // isStartPos: this is a game's move-0 position (chess960 / lichess "From Position"), not a
    // puzzle. It decides whether castling rights are inferred -- see the block below.
    function parse_position_from_pieces(txt, isStartPos = false) {
        const directHit = fen_cache.get(txt);
        if (directHit) { // reuse position
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        const chess = new Chess(config.variant);
        chess.clear(); // clear the board so we can place our pieces
        // A position built by clear()+put() can NEVER hold castling rights: _put only records the
        // king/rook "initial" squares while _castling is ALREADY non-zero, and clear() zeroes it --
        // a chicken-and-egg that made every position parsed here serialize with "-". For a game's
        // start that's wrong and fatal: the replay of the real move list hits the first O-O and
        // throws "Invalid move: O-O", so EVERY scrape of a "From Position" game (queen odds, etc.)
        // was skipped and the panel showed "no game detected". Arming the bits first lets the
        // placements below register the true king/rook squares -- chess960 included, since _put
        // reads a rook placed before the king as queenside and after it as kingside, and the pieces
        // arrive in file order. Only for a start position: in a puzzle the king has usually already
        // moved, and granting rights there would invent a castle that isn't legal.
        if (isStartPos) {
            chess.setCastlingRights('w', {k: true, q: true});
            chess.setCastlingRights('b', {k: true, q: true});
        }
        const [playerTurn, ...tokens] = txt.split('*****').slice(0, -1);
        // `lm-<from><to>` is the page's last-move highlight, shipped by the chess.com puzzle scrape
        // purely so the en-passant square can be recovered (see below). Everything else is a piece.
        let lastMove = null;
        for (const token of tokens) {
            if (token.startsWith('lm-')) { lastMove = token.slice(3); continue; }
            const attributes = token.split('-');
            chess.put({type: attributes[1], color: attributes[0]}, attributes[2]);
        }
        if (isStartPos) {
            // Keep only the rights the board actually backs. A start with no rook on a side (an
            // endgame position, say) would otherwise serialize a right nothing supports -- an
            // illegal FEN, and those are what crash the wasm engine (see the en-prise guard below).
            for (const color of ['w', 'b']) {
                const backed = chess._rooksInitial[color].reduce((flags, r) => flags | r.flag, 0);
                chess._castling[color] &= backed;
            }
        }
        chess.setTurn(playerTurn);
        turn = chess.turn();

        // a mid-animation scrape or wrong turn guess can yield a position where the side to move
        // could capture the king - searching such a position crashes the stockfish wasm (OOB)
        const opponent = (turn === 'w') ? 'b' : 'w';
        if (chess._isKingAttacked(opponent)) {
            throw Error('illegal position scraped (opponent king en prise)');
        }

        // The STANDARD initial array can only ever occur at move 0 -- pawns cannot move backwards, so
        // it is unreachable once a game is under way. Its castling rights are therefore necessarily
        // KQkq, which makes this a fact rather than a guess. It matters because this path builds
        // positions with clear()+put(), which cannot carry rights (see above), and lichess has no
        // move list before the first move -- so a live game's opening position came through here and
        // serialized as "w - -". The engine then analysed a start position where neither side may
        // castle, and the opening-explorer lookup matched nothing (no master game has that position).
        // Rebuild it as a start position so the rights are armed before the pieces are placed.
        // Variant-safe by construction: chess960 and the other variants don't have this placement.
        if (!isStartPos && chess.fen().split(' ')[0] === INITIAL_PLACEMENT) {
            return parse_position_from_pieces(txt, true); // isStartPos=true -> cannot recurse again
        }

        // Both patches restore information the piece scrape cannot carry. Castling first: it only
        // reads piece placement, so it is independent of the ep field it is followed by.
        const record =  {fen: apply_ep_square(apply_castling_rights(chess.fen()), lastMove)};
        fen_cache.set(txt, record);
        return record;
    }

    const metaTag = txt.substring(3, 8);
    const prefix = metaTag.substring(0, 2);
    detected_prefix = prefix;
    set_detection_status(prefixMap[prefix]);
    txt = txt.substring(11);

    if (metaTag.includes('var')) {
        if (txt.includes('&')) { // a custom start position is shipped along (chess960 / "From Position")
            const puzTxt = txt.substring(0, txt.indexOf('&'));
            const fenTxt = txt.substring(txt.indexOf('&') + 6);
            // `true` = this is the game's move-0 position, so castling rights are inferred from the
            // board (see parse_position_from_pieces). That replaces a chess960-only string patch
            // (`startFen.replace('-', 'KQkq')`) which papered over the same missing-rights bug for
            // 960 alone -- which is why 960 castled fine while every standard "From Position" game
            // died on its first O-O.
            const startFen = parse_position_from_pieces(puzTxt, true).fen;
            return parse_position_from_moves(fenTxt, startFen);
        }
        return parse_position_from_moves(txt);
    } else if (metaTag.includes('puz')) { // chess.com & blitztactics.com puzzle pages
        return parse_position_from_pieces(txt);
    } else if (metaTag === 'cbfen' || metaTag === 'ccgeo') { // a complete FEN shipped as-is: ChessBase, and the chess.com
        // variants boards that are read geometrically (Setup Chess builds its own start position,
        // so there is no move list to replay and no start to replay it from).
        turn = txt.split(' ')[1] || 'w';
        return {fen: txt};
    } else { // chess.com and lichess.org pages
        return parse_position_from_moves(txt);
    }
}

// BOTH READINGS, ON ONE LINE, each named: `Score: 2.31 at depth 24 / Tablebase: winning, DTZ 27`.
// The engine's number and the tablebase's verdict do not measure the same thing -- one is an
// estimate and the other is the result -- so they are printed side by side rather than one
// silently replacing the other. Which halves appear is the Tablebase Display setting; with the
// tablebase owning the line but having no answer for this position, the engine's number stands
// rather than leaving the row blank.
function update_evaluation(eval_string) {
    if (eval_string != null && config.computer_evaluation) {
        const tb = tb_show_tb() ? tablebase_label() : '';
        const engine = tb_show_engine() ? eval_string : '';
        PANEL_ROOT.getElementById('evaluation').innerHTML =
            [engine, tb].filter(Boolean).join(' / ') || eval_string;
    }
}

// One line: the "Best response for X is Y" threat readout used to occupy a second line here, and
// its empty reserved row showed as a gap under the move. Threat Analysis is now arrow-only.
// --- Why this move ------------------------------------------------------------------------------
// Names the tactic behind the engine's choice: fork, promotion, a capture that wins material, mate.
// Opt-in (Settings -> Explain Moves), off by default, and shown on its own line rather than over the
// board -- the opponent-mistake toast already owns that space and two things fighting for it is
// worse than either alone.
//
// DELIBERATELY CONSERVATIVE. Only motifs that can be established from the position itself are named;
// pins, skewers and discovered attacks need a judgement this cannot make reliably, so they are not
// guessed at. When nothing is certain it says nothing, because a confidently wrong explanation is
// worse than none -- you would learn the wrong thing from it.
const REASON_PIECE_CP = {p: 100, n: 320, b: 330, r: 500, q: 900, k: 0};
const REASON_FORK_MIN = 320; // only a knight or better counts as a forked target

// The most valuable piece the side to move could take for free right now, or null. "For free" is
// the whole point: a defended piece is a trade, not a threat, and calling every capture a threat
// would make the explanation noise. Undefended is checked by asking whether the CAPTURED square is
// covered by the other side once the capture has happened.
function biggest_hanging(fen, victimColor) {
    try {
        const c = new Chess(config.variant, fen);
        if (c.turn() === victimColor) c.setTurn(victimColor === 'w' ? 'b' : 'w');
        let best = null;
        for (const m of c.moves({verbose: true})) {
            if (!m.captured) continue;
            const cp = REASON_PIECE_CP[m.captured] || 0;
            if (cp < REASON_FORK_MIN) continue;              // a pawn is not worth a sentence
            const probe = new Chess(config.variant, c.fen());
            const rec = probe.move({from: m.from, to: m.to, promotion: m.promotion});
            if (!rec) continue;
            const defended = probe.moves({verbose: true}).some(r => r.to === m.to);
            if (defended && cp <= (REASON_PIECE_CP[m.piece] || 0)) continue;  // an even trade is not a threat
            const name = ({p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen'})[m.captured];
            if (!best || cp > best.cp) best = {cp, name};
        }
        return best;
    } catch (e) {
        return null;   // a variant chess.js will not flip -- say nothing rather than guess
    }
}

// THE TABLEBASE'S OWN REASON. move_reason below explains tactics -- what a move wins, forks or
// saves -- and in a SOLVED position that is at best a side effect: the move is played because it
// is the one that keeps or converts the result. Every claim here is read straight off the probe's
// own move list (categories are from the side to move AFTER each move, so 'loss' is a move that
// loses for THEM), so it is fact, not judgement. Silent unless the probe covers this exact
// position and actually scored this move.
function tablebase_reason(fen, uci) {
    if (!tablebase_data || tablebase_data.fen !== fen) return '';
    const moves = tablebase_data.moves || [];
    const me = moves.find(m => m.uci === uci);
    if (!me) return '';
    const root = tablebase_data.category;
    const wins = (m) => m.category === 'loss' || m.category === 'blessed-loss';
    const holds = (m) => m.category === 'draw';
    // dtm/dtz on a child are negative while THEY are losing, so the largest value is the fastest
    // finish; with no mate distances the same comparison on dtz is the fastest conversion.
    const fastest = (pool) => {
        const useDtm = pool.every(m => typeof m.dtm === 'number');
        const val = (m) => useDtm ? m.dtm : m.dtz;
        const top = Math.max(...pool.map(val));
        return {best: val(me) === top, useDtm};
    };
    if (root === 'win' || root === 'cursed-win') {
        if (!wins(me)) return '';
        const pool = moves.filter(wins);
        if (pool.length === 1) return 'only move that wins';
        const {best, useDtm} = fastest(pool);
        if (!best) return 'keeps the win';
        return useDtm ? 'fastest mate' : 'converts fastest';
    }
    if (root === 'draw') {
        if (!holds(me)) return '';
        const pool = moves.filter(holds);
        return pool.length === 1 ? 'only move that draws' : 'holds the draw';
    }
    if (root === 'loss' || root === 'blessed-loss') {
        // everything loses: the reason is that this one loses SLOWEST
        const {best} = fastest(moves.filter(m => m.category === 'win' || m.category === 'cursed-win'));
        return best ? '' : 'holds out longest';
    }
    return '';
}

function move_reason(fen, uci) {
    if (!config.move_reason) return '';
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return '';
    try {
        const before = new Chess(config.variant, fen);
        const from = uci.slice(0, 2), to = uci.slice(2, 4);
        const mover = before.get(from);
        if (!mover) return '';
        const captured = before.get(to);
        const rec = before.move({from, to, promotion: uci[4]});
        if (!rec) return '';

        const reasons = [];
        if (before.isCheckmate()) return 'checkmate';
        // a solved position answers "why this move" better than any tactic can
        const tb_why = tablebase_reason(fen, uci);
        if (tb_why) reasons.push(tb_why);
        if (uci[4]) reasons.push(`promotes to ${({q: 'a queen', r: 'a rook', b: 'a bishop', n: 'a knight'})[uci[4]]}`);

        // A capture is only worth naming when it WINS something: taking a defended equal is a trade.
        if (captured) {
            const gain = REASON_PIECE_CP[captured.type] || 0;
            const defended = before.moves({verbose: true}).some(m => m.to === to);
            if (!defended) reasons.push(`wins a ${({p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen'})[captured.type]}`);
            else if (gain - (REASON_PIECE_CP[mover.type] || 0) >= 100) reasons.push('wins material');
        }

        // Fork: the piece that just moved now attacks two or more valuable things. Computed by asking
        // what OUR piece on `to` could take -- which needs the turn flipped back, since the move has
        // just handed it over.
        const after = new Chess(config.variant, before.fen());
        after.setTurn(mover.color);
        let targets = 0;
        try {
            for (const m of after.moves({square: to, verbose: true})) {
                if (m.captured && (REASON_PIECE_CP[m.captured] || 0) >= REASON_FORK_MIN) targets++;
            }
        } catch (e) { /* flipping the turn made an illegal position -- just skip the fork test */ }
        const givesCheck = before.isCheck();
        // Phrasing matters here: "check, forking" read like a sentence that had been cut off.
        if (targets >= 2) reasons.push('a fork');
        else if (givesCheck && targets >= 1) reasons.push('a fork with check');
        else if (givesCheck) reasons.push('check');

        // WHAT IT STOPS. Everything above says what the move DOES; the commonest honest answer to
        // "why this move" is what would have happened otherwise. Asked the only way that cannot be
        // wrong: play the opponent's best capture in the position we came FROM, and see whether this
        // move took it off the board. No search, no judgement -- one legal-move comparison.
        // Never claimed off a CHECKING move: while the opponent is in check, capturing the hanging
        // piece is not legal THIS ply, so the after-position comparison goes blind and a move that
        // merely delays the capture by one tempo read as saving it (reproduced: an unrelated rook
        // check labelled "saves the queen"). Silence over a false claim; a check that genuinely
        // saves loses its caption, which is the cheaper error.
        if (!captured && !givesCheck) {
            const threat = biggest_hanging(fen, mover.color);
            if (threat) {
                const still = biggest_hanging(before.fen(), mover.color);
                if (!still || still.cp < threat.cp) reasons.push(`saves the ${threat.name}`);
            }
        }

        // WHAT IT THREATENS, when it does not already win something outright. Same method, the other
        // way round: what can WE take next that we could not before.
        if (!captured && targets < 2 && !givesCheck) {
            const now = biggest_hanging(before.fen(), mover.color === 'w' ? 'b' : 'w');
            const was = biggest_hanging(fen, mover.color === 'w' ? 'b' : 'w');
            if (now && (!was || now.cp > was.cp)) reasons.push(`threatens the ${now.name}`);
        }

        return reasons.length ? reasons.join(', ') : '';
    } catch (e) {
        return '';
    }
}

let move_reason_key = null, move_reason_memo = '';

function render_move_reason(uci) {
    const el = PANEL_ROOT.getElementById('move-reason');
    if (!el) return;
    // Memoized: this runs on every info frame (on_engine_best_move fires per depth line), and
    // biggest_hanging inside move_reason builds a probe board per candidate capture -- identical
    // work for an identical answer, dozens of times a second, on the click-servicing thread.
    const key = `${last_eval.fen}|${uci || ''}|${config.move_reason}`
        // the probe usually lands AFTER the first render: without it in the key the Why line
        // would keep the tactics-only text it computed a beat earlier
        + `|${tablebase_data?.fen === last_eval.fen ? `${tablebase_data.moves?.[0]?.uci}:${tablebase_data.dtm ?? ''}` : ''}`;
    if (key !== move_reason_key) {
        move_reason_key = key;
        move_reason_memo = move_reason(last_eval.fen, uci);
    }
    const text = move_reason_memo;
    el.textContent = text ? `Why: ${text}` : '';
    el.hidden = !text;
}

// How much better the best move is than the second best -- the thing a human actually wants to know
// and the one thing the panel never said. "Only move" and "six moves are all fine" are completely
// different situations that both used to render as a single arrow and a score.
//
// Reads the MultiPV lines that are already on screen; needs no extra search. Silent when only one
// line is being computed (Multi Lines = 1), because with nothing to compare against there is no gap
// to report -- it does NOT widen the search to find one.
const CONFIDENCE_ONLY_MOVE_CP = 150; // best is winning by this much more -> effectively forced
const CONFIDENCE_EQUAL_CP = 20;      // within this -> genuinely a choice

function move_confidence_label() {
    try {
        if (!last_eval.fen || config.simon_says_mode) return '';
        // a single legal move is "only move" regardless of what the engine reports
        const legal = new Chess(config.variant, last_eval.fen).moves().length;
        if (legal === 1) return i18n('panel.conf.only_move', 'Only move');
        const a = last_eval.lines?.[0], b = last_eval.lines?.[1];
        if (!a || !b) return '';                       // Multi Lines = 1, or line 2 not in yet
        // mate scores don't subtract meaningfully against centipawns
        if (a.mate != null || b.mate != null) {
            return (a.mate != null && b.mate == null) ? i18n('panel.conf.only_line_mates', 'Only line that mates') : '';
        }
        if (typeof a.score !== 'number' || typeof b.score !== 'number') return '';
        const gap = Math.abs(a.score - b.score);
        if (gap >= CONFIDENCE_ONLY_MOVE_CP) return i18n('panel.conf.clearly_best', 'Clearly best (+{gap})', {gap: (gap / 100).toFixed(1)});
        if (gap <= CONFIDENCE_EQUAL_CP) return i18n('panel.conf.several_equal', 'Several equal');
        return i18n('panel.conf.over_second', '+{gap} over #2', {gap: (gap / 100).toFixed(2)});
    } catch (e) {
        return ''; // unparseable variant fen etc. -- the readout is better bare than wrong
    }
}

// The tablebase verdict and the confidence gap go on their OWN line, not appended to the move text.
// body sets `white-space: nowrap` and the left column is 378px, so "White to play, best move is a6a7
// -- tablebase: win in 13" simply ran off the edge and was clipped mid-word. A second, smaller line
// costs ~18px of a column that has room, and neither string has to be abbreviated to fit.
function readout_extras() {
    // Both labels return BARE text and the separator is added here. They used to carry their own
    // leading ' - ' / '·', so which punctuation started the line depended on which label happened to
    // be present -- and stripping it back off needed a regex that missed the em dash.
    // tablebase_label() USED to ride here as well. It now belongs to the evaluation line, beside the
    // engine's own number, where the two readings can be compared -- printing it in both places
    // said the same thing twice and left the eval row still claiming the engine's estimate alone.
    const extra = [puzzle_label(), move_confidence_label(), human_reply_label(),
                   second_opinion_label(), opp_prep_label(), player_book_label(), safety_net_label(),
                   session_stats_label()].filter(Boolean).join(' · ');
    return extra ? `<span class="line1-extra">${extra}</span>` : '';
}

function update_best_move(line1) {
    if (line1 != null) {
        last_best_move_line = line1;
        PANEL_ROOT.getElementById('chess_line_1').innerHTML = line1 + readout_extras();
    }
}

// --- Why nothing is happening --------------------------------------------------------------------
// Every path that ends in "the panel produces no move" used to end in silence, and silence is
// indistinguishable from a bug: it is what sent three separate "autoplay is broken" reports at
// something that was refusing by design. One sentence, in the panel, where the person who needs it
// is already looking. The DETAIL still goes to the trace -- this is the user-facing half.
let idle_reason_text = '';
function set_idle_reason(text) {
    idle_reason_text = text || '';
    const el = PANEL_ROOT.getElementById('idle-reason');
    if (!el) return; // stale cached popup.html
    el.textContent = idle_reason_text;
    el.hidden = !idle_reason_text;
}
const clear_idle_reason = () => set_idle_reason('');
let last_best_move_line = null; // the readout without the tablebase suffix, so it can be re-rendered

// The tablebase answer arrives AFTER the readout is drawn (it is never awaited), so re-render with
// the verdict appended rather than leaving the panel claiming a plain engine move.
function update_best_move_suffix() {
    if (last_best_move_line == null) return;
    const el = PANEL_ROOT.getElementById('chess_line_1');
    if (el) el.innerHTML = last_best_move_line + readout_extras();
}


// Config changes that need a full engine re-init used to just reload the popup page. In-page that
// would reload the SITE, so rebuild the panel instead -- same outcome: fresh config, fresh engine.
// Copy to the clipboard. navigator.clipboard needs a secure context + focus; the button click gives
// us the gesture, but fall back to the old execCommand path if it's unavailable/denied.
async function copy_text(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) {
        return false;
    }
}

// Copy `text`, flashing the button's own icon as the receipt. Shared by Copy FEN and Copy PGN.
async function copy_to_button(id, text) {
    if (!text) return;
    const icon = PANEL_ROOT.getElementById(id)?.querySelector('.mp-icon');
    const ok = await copy_text(text);
    if (!icon) return;
    const was = icon.textContent;
    icon.textContent = ok ? '✓' : '✕';
    setTimeout(() => { icon.textContent = was; }, 900);
}

// The game so far, as PGN. chess.js has no pgn() of its own, so build it from history()'s SAN --
// the same replay the analysis already does. Returns null when there's nothing to copy, or when the
// variant is one chess.js can't replay (see CHESSJS_VARIANTS), rather than emitting a wrong game.
// THE PANEL'S ANSWER, AS TEXT. Everything the panel is showing about this position in a form that
// survives a paste: the position, the score with the depth it was reached at, and every candidate
// line with its own score. Deliberately plain text and not markdown -- it goes into issues, notes
// and messages, and half of those render neither.
function analysis_text() {
    const fen = last_eval.fen;
    if (!fen) return null;
    const out = [`FEN: ${fen}`, `Engine: ${config.engine}`];
    const l0 = last_eval.lines?.[0];
    if (l0) {
        const score = ('mate' in l0 && l0.mate != null) ? `mate in ${l0.mate}` : `${(l0.score / 100).toFixed(2)}`;
        out.push(`Score: ${score} at depth ${l0.depth ?? '?'}`);
    }
    const tb = tablebase_label();
    if (tb) out.push(tb);
    for (let i = 0; i < (last_eval.activeLines || 0); i++) {
        const l = last_eval.lines?.[i];
        if (!l || !l.move) continue;
        const score = ('mate' in l && l.mate != null) ? `#${l.mate}` : (l.score / 100).toFixed(2);
        // The PV as played from this position, in the notation the panel is set to -- a line of raw
        // uci is not something anyone reads back.
        out.push(`${i + 1}. ${notate(fen, l.move)} (${score})${l.pv ? '  ' + pv_text(fen, l.pv) : ''}`);
    }
    return out.join('\n');
}

// A pv as SAN (or uci, following Move Notation), replayed once from the position it belongs to.
function pv_text(fen, pv) {
    const ucis = pv_moves(pv);
    if (!ucis.length) return '';
    if (config.move_notation !== 'san') return ucis.join(' ');
    try {
        const chess = new Chess(config.variant, fen);
        const san = [];
        for (const uci of ucis) {
            const m = chess.move(uci);
            if (!m) break;
            san.push(chess.history().slice(-1)[0]);
        }
        return san.join(' ');
    } catch (e) { return ucis.join(' '); }
}

// One ply's `{[%eval ...] [%depth ...]}`, or '' when that ply was never actually evaluated.
// eval_seen is the authority on which is which -- see record_eval_history, where gaps are filled
// with a COPY of the previous value so the graph stays a curve.
function game_log_comment(ply) {
    if (!eval_seen[ply]) return '';
    const f = ply_facts[ply];
    const line = f?.lines?.[0];
    if (!line) return '';
    // ALREADY WHITE-RELATIVE, and flipping it here made every eval the wrong way round: the info
    // parsers normalise the engine's side-to-move score once, on the way in (see the comment on the
    // eval bar: "the TEXT eval stays white-relative on purpose"). PGN's %eval wants exactly that,
    // so it is written as it stands. Caught in the browser: 1.e4 came out as -0.30.
    const white = (typeof line.mate === 'number' && !Number.isNaN(line.mate))
        ? `#${line.mate}`
        : (typeof line.score === 'number' ? (line.score / 100).toFixed(2) : null);
    if (white == null) return '';
    const depth = f.depth ? ` [%depth ${f.depth}]` : '';
    return `{[%eval ${white}]${depth}}`;
}

// WHAT ANALYSED THIS GAME, written so that nothing else has to understand it.
//
// `Annotator` is a real PGN tag from the standard's own supplemental list, and it means exactly
// this: who (or what) annotated the game. Everything more specific goes in tags NAMESPACED with
// `Mephisto`, because the one way to break a reader is to put our meaning on a name it already has
// -- a GUI that reads `Event` or `Round` must find what it expects there. An unknown tag is
// required to be ignored, and both sites do; lichess keeps them on import, and chess.com drops them
// without complaint.
//
// Deliberately NOT in the movetext: a comment before the first move is the one place some readers
// still mishandle, and the `{[%eval ...]}` comments per ply already carry the per-move story.
function pgn_provenance_tags() {
    const sel = PANEL_ROOT?.getElementById?.('qs_engine');
    const engine = [...(sel?.options || [])].find(o => o.value === config.engine)?.textContent?.trim()
                   || config.engine;
    const net = engine_net_seen ? ` net ${engine_net_seen}` : '';
    const budget = searching_by_depth() ? `depth ${config.compute_depth}` : `${config.compute_time}ms`;
    let version = '';
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* no runtime here */ }
    const modes = ['autoplay', 'humanize', 'clock_mode', 'mirror_mode', 'premove', 'tablebase',
                   'book_play', 'player_book', 'contempt', 'complexity_clock', 'human_times']
        .filter(k => config[k]);
    const tags = [
        `[Annotator "Mephisto${version ? ' ' + version : ''}"]`,
        `[MephistoEngine "${engine}${net}"]`,
        `[MephistoSearch "${budget}, MultiPV ${config.multiple_lines}, threads ${config.threads}"]`,
    ];
    if (modes.length) tags.push(`[MephistoModes "${modes.join(' ')}"]`);
    return tags.map(t => t.replace(/[\r\n]+/g, ' '));
}

function current_pgn() {
    const {startFen, moves} = last_pos;
    if (!moves) return null;
    let san;
    try {
        const chess = new Chess(config.variant, startFen || undefined);
        for (const uci of moves.split(' ').filter(Boolean)) chess.move(uci);
        san = chess.history();
    } catch (e) { return null; }
    if (!san.length) return null;

    const tags = [`[Variant "${config.variant}"]`, ...pgn_provenance_tags()];
    // A non-standard start (chess960, "From Position") MUST ship as SetUp+FEN tags -- without them
    // the PGN reads back from move 1 of the standard position, i.e. a different game entirely.
    if (startFen) tags.push('[SetUp "1"]', `[FEN "${startFen}"]`);

    // Number from the START position rather than from "1." with white: a From-Position game can
    // begin at any move number, and with black to play -- which PGN writes as `12... Nf6`.
    const fields = (startFen || '').split(' ');
    let num = parseInt(fields[5]) || 1;
    let black = fields[1] === 'b';
    let body = '';
    for (let i = 0; i < san.length; i++) {
        if (!black) body += `${num}. `;
        else if (i === 0) body += `${num}... `; // black to move at the start needs the ellipsis once
        body += san[i] + ' ';
        // THE PANEL'S OWN READING OF EVERY PLY, in the comment format lichess and chess.com both
        // already write and read: `{[%eval 0.31] [%depth 22]}`. It is the panel's live evaluation
        // of the position AFTER the move, at whatever depth it actually reached in the game -- not
        // a re-analysis, which is what Game Review is for. Only plies that were really measured get
        // a comment; a filler value copied forward to keep the graph a curve is not a measurement.
        if (config.game_log) {
            const c = game_log_comment(i + 1);
            if (c) body += c + ' ';
        }
        if (black) num++;
        black = !black;
    }
    return `${tags.join('\n')}\n\n${body.trim()}`;
}

// The element the panel's own classes live on: the panel body in-page, <body> in the toolbar popup.
function panel_body() {
    return (PANEL_ROOT === document) ? document.body : PANEL_ROOT.getElementById('mephisto-panel-body');
}

// Compact mode: collapse to just the status + move lines + score, hiding the board, the eval bar,
// quick-settings and the extras. The toggle lives in the floating panel's TITLE BAR (window chrome,
// next to minimize) -- the button row along the bottom is full, and a control that hides the panel's
// contents shouldn't live among the contents it hides.
function toggle_compact() {
    config.compact = !config.compact;
    MephistoConfig.set('compact', config.compact);
    apply_compact();
}

function apply_compact() {
    panel_body()?.classList.toggle('mephisto-compact', !!config.compact);
    // Hiding elements can't shrink the panel on its own: it's a FIXED-size box that the content
    // script scales, so the box and its wrapper have to be resized too. No-op in the toolbar popup,
    // where Chrome sizes the bubble around the content.
    self.MephistoContent?.setPanelCompact?.(!!config.compact);
}

// Native engines are a separate process that may simply not be installed, and the failure is
// otherwise silent (the panel just never evaluates). Probe the host -- `ping` answers WITHOUT
// launching the engine -- and show a dot. WASM engines are bundled, so the dot is hidden for them.
async function refresh_engine_health() {
    const el = PANEL_ROOT.getElementById('engine-health');
    if (!el) return;
    if (!NATIVE_ENGINES.includes(config.engine)) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.className = 'probing';
    el.title = 'Checking the native host…';
    const want = config.engine; // a switch mid-probe must not let a stale result paint the new engine
    const ok = await native_host_available(native_port_name());
    if (config.engine !== want) return;
    el.className = ok ? 'ok' : 'down';
    el.title = ok ? 'Native host is responding' : 'Native host not responding - run native-host/install.sh once';
}

// The status line under the buttons. A variant chess.js can't replay would otherwise sit there
// showing a normal "Game detected on ..." while analysing the wrong position -- say so instead.
function set_detection_status(text) {
    const el = PANEL_ROOT.getElementById('game-detection');
    if (!el) return;
    if (!CHESSJS_VARIANTS.includes(config.variant)) {
        // reuse the dropdown's own label rather than keeping a second name map in sync
        const opt = [...(PANEL_ROOT.getElementById('qs_variant')?.options || [])]
            .find(o => o.value === config.variant);
        el.innerText = `${opt ? opt.innerText : config.variant}: analysis not supported`;
        el.classList.add('unsupported');
        return;
    }
    el.classList.remove('unsupported');
    el.innerText = text;
}

function panel_reload() {
    if (IS_CONTENT_SCRIPT) { self.MephistoContent?.reopenPanel?.(); return; }
    location.reload();
}

// "Receiving end does not exist" means the tab has no live content-script. The overwhelmingly common
// cause is a RELOADED EXTENSION with the game tab still open: reloading orphans every content script
// already injected, and the orphan cannot be messaged again. The popup then polls into the void and
// sits on "No Chess Game Detected" forever -- which reads as a broken scraper rather than a page that
// needs reloading. This is toolbar-popup-only by nature: the floating panel IS the content script, so
// it cannot be orphaned away from itself.
//
// The error was deliberately swallowed (it is expected on non-chess tabs), so this counts instead:
// a couple of consecutive failures is a dead relay, one is just a tab that isn't ready.
// Chrome names the cause, and the two causes need different fixes -- so report WHICH, rather than
// one message that is right half the time:
//   "Receiving end does not exist"  -> no live content-script (extension reloaded, tab not reloaded)
//   "Cannot access contents of..."  -> no host permission for this site (a manifest matter, and the
//                                      reason the toolbar popup can fail where the floating panel
//                                      cannot: the panel talks to content-script.js in its own
//                                      isolated world and never touches chrome.tabs at all)
let relay_failures = 0;
function note_relay_result(lastError) {
    if (!lastError) { relay_failures = 0; return; }
    if (++relay_failures !== 3) return; // exactly 3 -> report once, don't repaint every poll
    const why = String(lastError.message || lastError);
    console.warn('Mephisto: the panel cannot reach this tab\'s content script:', why);
    set_detection_status(/access|permission/i.test(why)
        ? i18n('panel.no_site_access', 'No access to this site - check the extension\'s permissions')
        : i18n('panel.reload_the_page', 'Reload this page - the extension was updated'));
}

function send_to_active_tab(message) {
  // In-page panel: content-script.js is in THIS isolated world -- call it directly. chrome.tabs is
  // undefined here, and runtime.sendMessage would go to the extension, never to a sibling content script.
  if (IS_CONTENT_SCRIPT) {
      try { self.MephistoContent?.handle(message); } catch (e) { console.warn('Mephisto: panel->content failed', e); }
      return;
  }
  try { // chrome.* throws "Extension context invalidated" if the extension was reloaded while this
        // popup page is still live -- harmless (a reload re-injects a fresh one)
    // read lastError so "Receiving end does not exist" (no content-script on tab) stays unlogged
    if (MY_TAB_ID) { // normal path: talk to OUR tab only, even when it's in the background
        chrome.tabs.sendMessage(MY_TAB_ID, message, () => note_relay_result(chrome.runtime.lastError));
        return;
    }
    // The TOOLBAR POPUP always lands here: chrome.action.setPopup registers popup.html with no
    // ?tab= param, so MY_TAB_ID is null for the whole session. This is the path that has to report,
    // not the one above -- which is why the first version of note_relay_result never fired in the
    // one mode it was written for.
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) { // fallback: no tab id yet
        if (!tabs[0]?.id) return note_relay_result({message: 'no active tab'});
        chrome.tabs.sendMessage(tabs[0].id, message, () => note_relay_result(chrome.runtime.lastError));
    });
  } catch (e) { /* extension context invalidated -- ignore */ }
}

let fen_request_inflight = false;
let fen_request_timer = null;

function request_fen() {
    // don't pile up overlapping fen requests when the scrape round-trip is slower than the poll
    // interval (10ms). Self-heals: the content-script skips replying while it performs a move (or
    // before config arrives), so a 500ms fallback clears the flag -- polling can never wedge.
    if (fen_request_inflight) return;
    fen_request_inflight = true;
    clearTimeout(fen_request_timer);
    fen_request_timer = setTimeout(() => { fen_request_inflight = false; }, 500);
    send_to_active_tab({queryfen: true});
}

// An empty square that the moving piece CANNOT legally reach -- clicking it first clears any
// stale board selection (e.g. a piece left selected by a failed click) without risking an
// accidental move (a random empty square might be a legal destination and would move the piece).
function safe_deselect_square(fen, move) {
    if (!/^[a-h][1-8][a-h][1-8]/.test(move ?? '')) return null;
    try {
        const chess = new Chess(config.variant, fen);
        const from = move.slice(0, 2), to = move.slice(2, 4);
        const dests = new Set(chess.moves({square: from, verbose: true}).map(m => m.to));
        for (const f of 'abcdefgh') {
            for (const r of '12345678') {
                const sq = f + r;
                if (sq === from || sq === to) continue;
                if (chess.get(sq)) continue;   // occupied
                if (dests.has(sq)) continue;   // a legal destination -> clicking it could move the piece
                return sq;
            }
        }
    } catch (e) { /* bad fen -> no deselect */ }
    return null;
}

// -------------------------------------------------------------------------------------------
// Humanize + Clock Mode: decide WHAT to play (occasionally a non-best line, capped loss) and
// HOW LONG to visibly "think" (instant recaptures/forced moves, long thinks on critical
// positions, everything scaled to the clock when Clock Mode reads one off the page).

// How many lines the ENGINE searches. Humanize picks its move out of that list, so the list has to
// actually contain the move it wants; the DISPLAY still honours config.multiple_lines.
//
// The mistake/blunder bands (200-400cp / 400-600cp worse, see humanize_pick) can only be filled by
// moves the engine ranks LOW. Its top 3 all sit within ~40cp of each other, so at MultiPV 3 those
// pools were always empty and every mistake/blunder roll silently fell back to the best move --
// which is exactly why the mix produced 97%-accuracy, 0-mistake games. Moves that bad usually start
// around rank 6-12 in a middlegame, so ask for a deep list when those bands are switched on.
//
// Only when they're switched on: a wide MultiPV makes the engine search every one of those root
// moves properly, which costs real depth. Nobody who leaves mistakes/blunders at 0 should pay it.
const HUMANIZE_DEEP_MULTIPV = 20;
// Roughly how far down the cp ladder a short (6-line) list reaches in a typical middlegame: its 6th
// move is usually only ~40-60cp worse than best. Any band that extends past this needs a wide list.
const HUMANIZE_SHALLOW_REACH_CP = 60;

function effective_multipv() {
    if (!config.humanize) return config.multiple_lines;
    const rates = humanize_rates();
    const t = humanize_thresholds();
    // Every non-top band picks its move from the engine's LINE LIST, so the list must reach as deep
    // as the worst band you've given a share. This used to trigger the wide search only for
    // inaccuracy/mistake/blunder -- but a "third/fourth line" move sits just as far down the list
    // (rank ~8-13), so with a 6-line list those rolls found an empty pool and silently fell back to
    // the TOP move. That's why a 60%-non-top mix still played like a 96%-accuracy engine: the deeper
    // bands never had candidates. Go wide whenever the deepest band with a share reaches past what a
    // short list covers -- which correctly keeps a pure top+near-best mix on the cheap 6-line search.
    let deepest = 0;
    for (const cat of ['second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder'])
        if ((rates[cat] || 0) > 0) deepest = Math.max(deepest, t[cat]);
    const wantsDeep = deepest > HUMANIZE_SHALLOW_REACH_CP;
    return Math.max(wantsDeep ? HUMANIZE_DEEP_MULTIPV : 6, config.multiple_lines);
}

// Ordered worst-to... no: BEST-to-worst. The roll walks these as cumulative % slices; each non-top
// category is a centipawn BAND whose upper bound is its own threshold and lower bound is the
// previous category's threshold (top = 0). Shared by the roll and the pick so they can't drift.
const HUMANIZE_ORDER = ['top', 'second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder'];
const HUMANIZE_LABEL = {
    top: 'top engine', second: 'second line', third: 'third line', fourth: 'fourth line',
    inaccuracy: 'inaccuracy', mistake: 'mistake', blunder: 'blunder',
};

function humanize_get(key, dflt) {
    try {
        const v = JSON.parse(MephistoConfig.get(key));
        return (v != null && isFinite(+v)) ? Math.max(0, +v) : dflt;
    } catch (e) { return dflt; }
}

// Humanize move mix in PERCENT (the seven HUMANIZE_ORDER categories, normalized to sum 100). Tuned
// by the sliders in the options page and read fresh on EVERY pick -- the options page and this popup
// share the extension's storage, so edits apply to the very next move, no reload. fourth/inaccuracy
// default to 0 so adding them didn't change any existing user's behaviour.
function humanize_rates() {
    const r = {
        top: humanize_get('humanize_top', 50),
        second: humanize_get('humanize_second', 40),
        third: humanize_get('humanize_third', 4),
        fourth: humanize_get('humanize_fourth', 0),
        inaccuracy: humanize_get('humanize_inaccuracy', 0),
        mistake: humanize_get('humanize_mistake', 5),
        blunder: humanize_get('humanize_blunder', 1),
    };
    const sum = HUMANIZE_ORDER.reduce((a, k) => a + r[k], 0);
    if (sum > 0) for (const k in r) r[k] = r[k] * 100 / sum;
    return r;
}

// Per-category centipawn thresholds -- each is a band's UPPER bound; the lower bound is the previous
// category's. Defaults trace Lichess's own move-quality boundaries (WinPercent.scala / Advice.scala):
// from an equal position a 110cp loss is a 10% win-chance drop (Inaccuracy), 230cp a 20% drop
// (Mistake), 377cp a 30% drop (Blunder). Clamped strictly ascending so a hand-edited/again-misordered
// store can't invert a band.
function humanize_thresholds() {
    const t = {
        second: humanize_get('humanize_cp_second', 40),
        third: humanize_get('humanize_cp_third', 75),
        fourth: humanize_get('humanize_cp_fourth', 110),
        inaccuracy: humanize_get('humanize_cp_inaccuracy', 230),
        mistake: humanize_get('humanize_cp_mistake', 377),
        blunder: humanize_get('humanize_cp_blunder', 600),
    };
    let prev = 0;
    for (const k of ['second', 'third', 'fourth', 'inaccuracy', 'mistake', 'blunder']) {
        t[k] = Math.max(prev + 1, t[k]);
        prev = t[k];
    }
    return t;
}

// (lo, hi] cp band per non-top category, from the ascending thresholds.
function humanize_band_bounds() {
    const t = humanize_thresholds();
    return {
        second: [0, t.second], third: [t.second, t.third], fourth: [t.third, t.fourth],
        inaccuracy: [t.fourth, t.inaccuracy], mistake: [t.inaccuracy, t.mistake],
        blunder: [t.mistake, t.blunder],
    };
}

// Which category a 0-100 roll lands in, given the % shares. Cumulative over HUMANIZE_ORDER.
function category_for_roll(r, rates) {
    let acc = 0;
    for (const cat of HUMANIZE_ORDER) { acc += rates[cat] || 0; if (r < acc) return cat; }
    return 'top';
}

// Pre-rolled humanize outcome for the current move, decided at SEARCH START so the countdown can
// show which move is coming from the very beginning (not just the last instant). The random slice
// roll doesn't need the search -- only whether the chosen line is actually PLAYABLE does, which
// humanize_pick checks later using this same roll (`humanize_roll.r`), so what's shown matches what
// gets played, with a rare late correction (a recapture, or a rolled slice that turns out too weak
// and falls back to the top move). {r: the 0-100 roll, category: the label to show}.
let humanize_roll = null;

function roll_humanize_category(fen) {
    try {
        if (new Chess(config.variant, fen).moves().length === 1) return {r: 0, category: 'instant response'};
    } catch (e) { /* variant fen chess.js can't parse -- fall through to the mix roll */ }
    const r = Math.random() * 100;
    return {r, category: HUMANIZE_LABEL[category_for_roll(r, humanize_rates())]};
}

// our-perspective centipawns for a line whose score/mate are stored white-relative;
// mates map to huge cp so comparisons Just Work (closer mate = bigger)
function line_cp_ours(line) {
    const sign = (turn === 'w') ? 1 : -1;
    if ('mate' in line) {
        if (line.mate === 0) return -100000 * sign; // side to move IS mated
        return sign * Math.sign(line.mate) * (100000 - 1000 * Math.abs(line.mate));
    }
    return sign * line.score;
}

// Clock Mode and Mirror Time are both "clock-aware": either one reads the scraped clock and
// paces to it. They differ in HOW: Clock Mode budgets from OUR clock (T/30 + 0.6*increment),
// Mirror Time paces to the OPPONENT's spend (x0.9). Mirror falls back to the budget when their
// spend hasn't been measured yet, and both share the same low-time safety rails.
function clock_aware() {
    return config.clock_mode || config.mirror_mode;
}

// MIRROR TIME IS A RATIO NOW, not a hardcoded 90%. Mirroring at 90% still loses the clock race
// whenever the opponent's own spend is the thing running you low -- you are always paying nine
// tenths of a number you did not choose. The setting lets that go either way: below 100 pulls ahead
// on the clock a little every move (what it always did), above 100 deliberately spends more than
// they do, for a longer game where the extra think is worth more than the seconds.
// The catch-up rule below it is NOT optional and applies at every ratio: when you are actually
// behind on the clock the target is cut by 30% regardless, so a ratio over 100 can never dig the
// hole deeper.
const MIRROR_RATIO_DEFAULT = 90;
function mirror_ratio() {
    const n = parseInt(config.mirror_ratio);
    return Number.isFinite(n) ? Math.max(50, Math.min(150, n)) / 100 : MIRROR_RATIO_DEFAULT / 100;
}

// TIME TROUBLE: one switch that changes how the whole move is spent, rather than four sliders you
// would have to move by hand as the clock runs down. Below the threshold the search is capped and
// the simulated human delay collapses to its floor -- in a scramble the thing that loses games is
// the 400ms of cursor travel, not the depth. Independent of Clock Mode and Mirror Time on purpose:
// it answers "am I about to flag", which is true whether or not you asked for clock-aware pacing.
const TIME_TROUBLE_SEARCH_MS = 250;   // a depth-8-ish move on any machine, and it is not the search
                                      // that is costing you here
const TIME_TROUBLE_MOVE_MS = 200;     // the floor a click still needs to look like a hand made it
function time_trouble_at() {
    const n = parseInt(config.time_trouble_at);
    return Number.isFinite(n) ? Math.max(5, Math.min(120, n)) : 30;
}
function in_time_trouble() {
    if (!config.time_trouble || !last_clocks || last_clocks.mine == null) return false;
    const T = last_clocks.mine - (Date.now() - last_clocks.at) / 1000;
    return T <= time_trouble_at();
}

// ---- HOW LONG A PERSON ACTUALLY TAKES ----------------------------------------------------------
// Every think time here is drawn UNIFORMLY: base + random * variance, which is flat between two
// edges and stops dead at both. Real move times are not flat. They pile up just under a short,
// typical value and trail away to the right -- most moves come quickly, a few take several times
// the median, and none takes less than nothing. That shape is a log-normal, and it is the shape a
// histogram of move times is read as human by.
//
// One switch, sampling the same AVERAGE the settings already describe, so the numbers you set still
// mean what they meant: the median is the mean of the uniform draw it replaces. Sigma is the spread
// in log space -- 0.5 puts the slow tenth of moves at about 2x the median and the fast tenth at
// about half, which is what a real move-time histogram looks like.
//
// The CURSOR TRAVEL is deliberately left alone: a hand does not move across the board log-normally,
// and its floor exists for a different reason (a click that lands too fast stops looking like one).
const HUMAN_TIME_SIGMA = 0.5;
const HUMAN_TIME_MAX_K = 4;    // the tail is long, not infinite -- never more than 4x the median
// The midpoints of humanize's own uniform bands, so switching this on changes the SHAPE of its
// think times without changing what they average.
const HUMAN_TIME_MEDIAN = {instant: 75, quick: 500, normal: 1300, long: 4250};

function lognormal_ms(median, sigma = HUMAN_TIME_SIGMA) {
    if (!(median > 0)) return 0;
    // Box-Muller: two uniforms in, one standard normal out. Math.random() can return exactly 0 and
    // log(0) is -Infinity, so the first draw is nudged off that edge.
    const u = Math.random() || Number.MIN_VALUE, v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.round(Math.min(median * Math.exp(sigma * z), median * HUMAN_TIME_MAX_K));
}

// ---- THE COMPLEXITY CLOCK ----------------------------------------------------------------------
// A fixed think time spends the same seconds on a position with one move as on a position with five.
// A person does the opposite: they bang out the obvious move and sit on the hard one. This reads how
// far apart the engine's own top two lines are -- the one complexity measure that is free, because
// the search has already produced it -- and stretches or shrinks the THINK by that.
//
// Multiplicative and opt-in, so it composes with everything rather than replacing anything: with
// Humanize on it scales humanize's think, with it off it scales the configured one, and the clock
// caps still sit above it, so it can never spend time the clock does not have. It never stretches a
// reflex: a recapture is instant because it is a recapture, not because the position is easy.
const COMPLEXITY_STEPS = [    // gap between the best two lines (cp) -> multiplier on the think
    {under: 15, k: 1.6},      // a real choice: two moves the engine itself cannot separate
    {under: 40, k: 1.3},
    {under: 100, k: 1.0},     // ordinary: the settings as configured
    {under: 250, k: 0.8},
];
const COMPLEXITY_OBVIOUS_K = 0.6;   // one move ahead by more than two and a half pawns: just play it

function complexity_k() {
    if (!config.complexity_clock) return 1;
    const cps = (last_eval.lines || []).filter(l => l && l.move)
        .map(l => line_cp_ours(l)).filter(cp => Number.isFinite(cp))
        .sort((a, b) => b - a);
    if (cps.length < 2) return 1;                  // one line is no measure of anything
    if (Math.abs(cps[0]) >= 90000) return 1;       // a mate is not a hard position, it is a found one
    const gap = cps[0] - cps[1];
    for (const step of COMPLEXITY_STEPS) if (gap < step.under) return step.k;
    return COMPLEXITY_OBVIOUS_K;
}

// per-move time budget in ms from the scraped clock, or null when no clock-aware mode is on
// (or the clock is unreadable). ~T/30 + 60% of the increment, never more than T/8.
function clock_budget_ms() {
    if (!clock_aware()) return null;
    return clock_move_budget_ms();
}

// The same arithmetic WITHOUT the Clock Mode gate. Split out so a second feature can read the clock
// without switching Clock Mode on -- turning that toggle on has always meant "pace the SEARCH to the
// clock", and quietly making it mean something else as well would change what it does for everyone
// already using it.
function clock_move_budget_ms() {
    if (!last_clocks || last_clocks.mine == null) return null;
    const elapsed = (Date.now() - last_clocks.at) / 1000; // the scrape is a moment old
    const T = Math.max(1, last_clocks.mine - elapsed);
    const I = last_clocks.increment || 0;
    return Math.max(120, Math.min((T / 30 + 0.6 * I) * 1000, T * 1000 / 8));
}

// --- Clock-paced move timing (opt-in, `clock_pace`) ----------------------------------------------
// Clock Mode paces the SEARCH. Nothing ever paced the SIMULATED HUMAN DELAY -- the think pause and
// the cursor travel -- so in a 10-second scramble the extension still spent a fixed 400ms moving the
// mouse, which is exactly when you cannot afford it.
//
// This scales those, and only those, and only when switched on. With clock to spare your settings
// are used EXACTLY as configured: it never makes a move slower, only shorter, and never below a
// floor where the click stops looking like a hand moved it.
const CLOCK_PACE_SHARE = 0.35;    // of the per-move budget, spent on looking human
const CLOCK_PACE_FLOOR_MS = 150;  // a move still has to travel and land

function clock_pace_timing(t) {
    // Time trouble collapses the human-looking part to its floor before anything else gets a say:
    // the think pause and the cursor travel are what a scramble actually costs, and Pace to Clock
    // (below) only helps if you switched it on and only in proportion.
    if (in_time_trouble()) {
        return {think_time: 0, think_variance: 0, move_time: TIME_TROUBLE_MOVE_MS, move_variance: 0};
    }
    if (!config.clock_pace) return t;

    const budget = clock_move_budget_ms();
    if (budget == null) return t;                  // no readable clock -> your settings, untouched
    // Mean rather than max: variance is symmetric, so the average move costs half of it.
    const want = t.think_time + t.think_variance / 2 + t.move_time + t.move_variance / 2;
    const cap = Math.max(CLOCK_PACE_FLOOR_MS, budget * CLOCK_PACE_SHARE);
    if (!(want > cap)) return t;                   // enough clock: leave everything alone
    const k = cap / want;
    return {
        think_time: Math.round(t.think_time * k),
        think_variance: Math.round(t.think_variance * k),
        // the move itself keeps the floor; the pause before it is what gives way first
        move_time: Math.max(CLOCK_PACE_FLOOR_MS, Math.round(t.move_time * k)),
        move_variance: Math.round(t.move_variance * k),
    };
}

// time reserved (ms) to actually click the move + engine stop/flush overhead, so the SEARCH never
// eats the whole budget and leave nothing to play it in
const MOVE_MARGIN = 150;
let search_start = 0; // when the current autoplay search was issued (for the residual think below)

// The intended TOTAL time (ms) for the current move from the clock-aware modes, computed WITHOUT
// the search results (Mirror = opponent's spend x0.9, Clock = the T/30 budget). Used to SIZE the
// search in on_new_pos so the engine thinks the whole time instead of finding a shallow move fast
// and then idling. null when no clock-aware mode is active or the clock is unreadable. This is an
// estimate that omits humanize's kind-based caps (which need the results) -- humanize_pick stays
// the authoritative think, and on_engine_best_move only waits out whatever the search didn't cover.
function paced_move_target_ms() {
    if (!clock_aware() || !last_clocks || last_clocks.mine == null) return null;
    const T = last_clocks.mine - (Date.now() - last_clocks.at) / 1000; // seconds remaining
    let ms;
    if (config.mirror_mode && opp_spend != null) {
        ms = opp_spend * 1000 * mirror_ratio();                   // mirror: their spend, x the ratio
        if (last_clocks.theirs != null && T < last_clocks.theirs) ms *= 0.7; // catch up when behind
    } else {
        ms = clock_budget_ms();
        if (ms == null) return null;
    }
    ms = Math.min(ms, T * 1000 / 8);   // never sink an eighth of the clock into one move
    if (T < 20) ms = Math.min(ms, 250);
    if (T < 8) ms = 0;
    return {ms, lowClock: T < 20};
}

// Pre-search estimate (ms) of humanize's think for THIS move, for humanize WITHOUT a clock-aware
// mode (which would otherwise size the search itself). Humanize's real "long think" keys off the
// position's criticality, only known after the search -- so here we estimate it from the signals
// available BEFORE it: game phase and how balanced the game is (|last eval|). A tense, level game
// gets a deep search; an opening or a decided game gets a quick one. It's just a search size --
// humanize_pick still decides the actual think from the results, and any shortfall is waited out.
function humanize_presearch_ms(fen) {
    if (!config.humanize || clock_aware() || !config.autoplay
        || config.help_mode || config.puzzle_mode) return null;
    let fullmove = 999;
    try { fullmove = parseInt(fen.split(' ')[5]) || 999; } catch (e) { /* variant fen */ }
    if (fullmove < 8) return 500;                                   // opening: reel it off
    const evalCp = (last_our_eval != null) ? Math.abs(last_our_eval) : 0;
    if (evalCp > 600) return 500;                                  // game decided: moves matter less
    if (evalCp < 150) return 2500;                                 // balanced & tense: think
    return 1200;                                                   // ordinary middlegame
}

// {move, think}: which move to actually play, and how long to sit on it first
// ---- PLAYSTYLE: a character, not a strength -----------------------------------------------------
// The lineup covered "strong" and "human-like" and nothing in between, and every engine here plays
// the same way: the top line, every time. This picks between the lines the search ALREADY produced,
// by how forcing each move is -- checks, captures and promotions on one end, quiet moves on the
// other -- and only ever inside a small tolerance, so the character never costs a real move.
//
// It is deliberately not an evaluation: the engine has already said what these moves are worth, and
// second-guessing that is how a style becomes a weakness. All this decides is WHICH of two moves
// the engine considers equal gets played.
const PLAYSTYLE_MARGIN = 35;   // centipawns a style may spend; a hair under the noise between two
                               // near-equal lines at panel depths, so nothing measurable is given up
// A HUMAN NET PRICES ITS MOVES IN PROBABILITY, NOT CENTIPAWNS. Maia and Elite Leela report the same
// position eval on every line -- the score is the position's, the ranking is the policy's -- so a
// centipawn tolerance admits EVERY candidate there and the style would quietly override the net's
// own human ranking, which is the one thing those engines are for. On those lines the tolerance is
// the move's share of the top move's probability instead. Two thirds is a judgment, not a
// measurement: enough to choose between moves a person might really play, not enough to reach the
// tail of the distribution.
const PLAYSTYLE_PROB_RATIO = 0.66;
// WHAT "ALREADY WINNING" MEANS to the Disrespect style: the position has to be worth +6 BEFORE the
// move, and the move it picks has to still be worth +2 AFTER it. The second number is belt and
// braces -- the 35cp tolerance already keeps every candidate within a third of a pawn of the best,
// so a +6 position cannot produce a +2 candidate -- but it is the rule the style is supposed to obey
// and it costs nothing to say so, rather than leaving it as something the tolerance happens to imply.
const PLAYSTYLE_WINNING_CP = 600, PLAYSTYLE_WINNING_AFTER_CP = 200;
const PLAYSTYLE_STYLES = ['balanced', 'attacking', 'quiet', 'greedy', 'space',
                          'sacrifice', 'safe', 'drawish', 'disrespect', 'ultra'];
const PLAYSTYLE_PIECE_VAL = {p: 1, n: 3, b: 3, r: 5, q: 9, k: 0};

// EVERY STYLE IS ONE NUMBER, read off the move and the position it lands in, and the picker simply
// takes the highest inside the tolerance. Nothing here is an evaluation -- the engine has already
// said what these moves are worth, and all a style decides is which of the ones it called equal
// gets played. Returns null when chess.js will not replay the move, which is no opinion at all.
//
//   attacking  forcing: a check is worth more than a capture, a capture more than a quiet move
//   quiet      the same number, negated -- the calm move among equals
//   greedy     the material it takes, so a hanging rook beats a hanging pawn (checks are not the point)
//   space      how far it goes toward the opponent, pawns counted double -- the move that gains ground
//   sacrifice  the material it OFFERS: what the piece is worth if the opponent may take it, less what
//              it just took. Sound by construction -- the engine already called this line equal, so a
//              sacrifice it likes is one that works, not a blunder wearing a bow.
//   safe       the same number negated: nothing left where it can be taken
//   drawish    the line closest to 0.00 among the ones inside the tolerance. (Its opposite is not a
//              style: taking the sharpest line IS Balanced.)
//   disrespect the rude one, and the only style that reads the CLOCK of the game as well as the move:
//              a second queen when one is already on the board, a sacrifice made while the engine
//              says you are already winning, an opening move on the rim (a knight to the edge, a
//              rook's pawn, a king walk), and the king strolling toward theirs once it is safe.
//              It is rude, not bad: the tolerance still holds, so every one of these is a move the
//              engine called equal to the best, and "winning" means +6 before the move and +2
//              after it. Nothing here throws the game away, which is the point -- a troll who
//              resigns is not funny.
//   ultra      Attacking taken to its end: a check counts double what it does there, a capture
//              double, and on top of that the move earns for landing NEXT TO THE ENEMY KING and for
//              any material it offers on the way in. Same tolerance as everything else, so it is a
//              player who throws pieces at the king only when the engine says that still holds.
function style_score(fen, uci, style, cp, bestCp) {
    try {
        const c = new Chess(config.variant || 'chess', fen);
        const white = c.turn() === 'w';
        const mv = c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
        if (!mv) return null;                       // not legal here: no opinion
        const forcing = (c.isCheck() ? 2 : 0) + (mv.captured ? 1 : 0) + (mv.promotion ? 1 : 0);
        if (style === 'sacrifice' || style === 'safe') {
            // what we are offering: the piece's value if the opponent can take it where it now
            // stands, less whatever it just captured. A defended piece is still offered -- the
            // opponent gets to decide -- which is what makes this a style and not an evaluation.
            const them = white ? 'b' : 'w';
            const exposed = c.isAttacked(mv.to, them)
                ? (PLAYSTYLE_PIECE_VAL[mv.piece] || 0) - (PLAYSTYLE_PIECE_VAL[mv.captured] || 0) : 0;
            return style === 'sacrifice' ? exposed : -exposed;
        }
        // The engine's own number for this line, so "closest to equality" is its opinion, not ours.
        if (style === 'drawish') return Number.isFinite(cp) ? -Math.abs(cp) : 0;
        if (style === 'attacking') return forcing;
        if (style === 'quiet') return -forcing;
        if (style === 'greedy') {
            return (PLAYSTYLE_PIECE_VAL[mv.captured] || 0)
                + (mv.promotion ? PLAYSTYLE_PIECE_VAL[mv.promotion] || 0 : 0);
        }
        if (style === 'disrespect') {
            const them = white ? 'b' : 'w';
            const us = white ? 'w' : 'b';
            let score = 0;
            // A SECOND QUEEN when one is already there. (The promotion itself is not the joke --
            // having two of them is.)
            if (mv.promotion === 'q') {
                let queens = 0;
                for (const row of c.board()) {
                    for (const sq of row) if (sq && sq.type === 'q' && sq.color === us) queens++;
                }
                if (queens > 1) score += 5;
            }
            const winning = Number.isFinite(bestCp) && bestCp >= PLAYSTYLE_WINNING_CP
                && Number.isFinite(cp) && cp >= PLAYSTYLE_WINNING_AFTER_CP;
            // giving material away while ALREADY winning: the engine still has to call it equal
            if (winning && c.isAttacked(mv.to, them)) {
                score += Math.max(0, (PLAYSTYLE_PIECE_VAL[mv.piece] || 0) - (PLAYSTYLE_PIECE_VAL[mv.captured] || 0));
            }
            const fullmove = Number(fen.split(' ')[5]) || 99;
            const file = mv.to[0], rim = (file === 'a' || file === 'h');
            // an opening played on the rim: a knight to the edge, a rook's pawn, or a king walk
            if (fullmove <= 10 && ((mv.piece === 'n' && rim) || (mv.piece === 'p' && rim) || mv.piece === 'k')) {
                score += 2;
            }
            // ...and once it is safely won, the king goes for a stroll toward theirs
            if (winning && mv.piece === 'k') {
                let king = null;
                for (const row of c.board()) {
                    for (const sq of row) if (sq && sq.type === 'k' && sq.color === them) king = sq.square;
                }
                if (king) {
                    const dist = Math.max(Math.abs(king.charCodeAt(0) - mv.to.charCodeAt(0)),
                                          Math.abs(Number(king[1]) - Number(mv.to[1])));
                    score += Math.max(0, 4 - dist);
                }
            }
            return score;
        }
        if (style === 'ultra') {
            const them = white ? 'b' : 'w';
            let king = null;
            for (const row of c.board()) {
                for (const sq of row) if (sq && sq.type === 'k' && sq.color === them) king = sq.square;
            }
            const dist = king
                ? Math.max(Math.abs(king.charCodeAt(0) - mv.to.charCodeAt(0)),
                           Math.abs(Number(king[1]) - Number(mv.to[1]))) : 8;
            const offered = c.isAttacked(mv.to, them)
                ? (PLAYSTYLE_PIECE_VAL[mv.piece] || 0) - (PLAYSTYLE_PIECE_VAL[mv.captured] || 0) : 0;
            return (c.isCheck() ? 4 : 0) + (mv.captured ? 2 : 0) + (mv.promotion ? 1 : 0)
                + Math.max(0, 3 - dist)          // landing in the king's neighbourhood
                + Math.max(0, offered);          // ...and paying for the privilege
        }
        if (style === 'space') {
            const rank = (sq) => Number(sq[1]);
            const forward = white ? rank(mv.to) - rank(mv.from) : rank(mv.from) - rank(mv.to);
            return forward * (mv.piece === 'p' ? 2 : 1);
        }
        return 0;
    } catch (e) { return null; }                    // a variant chess.js cannot replay: no opinion
}

// WHERE A STYLE CAN ACTUALLY CHOOSE. Offering a control that cannot do anything is worse than not
// offering it: the engine has to report more than one scored line, and the moves have to be ones
// chess.js can replay. A cloud or remote engine answers with a single line; four-player chess runs
// its own path entirely; a Fairy variant is a position the scorer will not replay, so it would have
// no opinion. In all three the row is hidden and the picker stands down, so the control and the
// behaviour cannot disagree.
function playstyle_applies() {
    if (CLOUD_ENGINES.includes(config.engine) || config.engine === 'remote') return false;
    if (FOURPC_ENGINES.includes(config.engine)) return false;
    if (config.variant !== 'chess' && config.variant !== 'fischerandom') return false;
    return (parseInt(config.multiple_lines) || 1) >= 2;
}

// The row follows the same answer, live: Multi Lines is right there in the panel and changes without
// a reload, so the control appears and disappears with the thing that makes it possible.
function update_playstyle_row() {
    const row = PANEL_ROOT.getElementById('qs_playstyle_row');
    if (row) row.style.display = playstyle_applies() ? '' : 'none';
}

// The style's pick among the search's own lines, or `best` when the style has nothing to say.
function playstyle_pick(best) {
    const style = config.playstyle;
    if (!style || style === 'balanced') return best;
    if (!playstyle_applies()) return best;   // the row is hidden here too -- see playstyle_applies
    const fen = last_eval.fen;
    const lines = (last_eval.lines || []).filter(l => l && l.move);
    if (lines.length < 2) return best;
    const bestLine = lines.find(l => l.move === best) || lines[0];
    const bestCp = line_cp_ours(bestLine);
    if (!Number.isFinite(bestCp) || Math.abs(bestCp) >= 90000) return best;  // never toy with a mate
    // Each style's number already points the right way, so the pick is always the highest.
    let pick = best, pickScore = style_score(fen, best, style, bestCp, bestCp);
    if (pickScore === null) return best;
    const bestProb = bestLine.maiaprob;
    const human = Number.isFinite(bestProb);   // a policy net: rank by probability, not by score
    for (const l of lines) {
        if (l.move === best) continue;
        if (human) {
            if (!Number.isFinite(l.maiaprob) || l.maiaprob < bestProb * PLAYSTYLE_PROB_RATIO) continue;
        } else {
            const cp = line_cp_ours(l);
            if (!Number.isFinite(cp) || bestCp - cp > PLAYSTYLE_MARGIN) continue;  // outside the tolerance
            if (Math.abs(cp) >= 90000) continue;
        }
        const s = style_score(fen, l.move, style, line_cp_ours(l), bestCp);
        if (s === null) continue;
        if (s > pickScore) { pick = l.move; pickScore = s; }
    }
    return pick;
}

// ---- CONTEMPT: the dial for a game you have to WIN ---------------------------------------------
// The engine is perfectly happy with a draw. When you are not -- the last round of a tournament, a
// match you are behind in -- the repetition it offers at 0.00 is half a point gone, and no setting
// could say so. This one can: it spends up to `contempt_cp` centipawns to avoid a move that ENDS
// THE GAME as a draw on the spot, and nothing else. When the top move is not one of those it returns
// the engine's move untouched, so in an ordinary game the dial changes nothing at all.
//
// "Ends the game" is a fact here, not an estimate: the candidate is replayed on a board carrying the
// game's own history, so a threefold, a fifty-move, a stalemate and insufficient material are all
// chess.js's own verdict rather than a guess from the score. A repetition the engine merely SEES
// three plies deep is not caught -- that would need the PV, and a PV is a prediction about the
// opponent. Ceiling stated; the upgrade path is to walk the PV when one is trusted that far.
const CONTEMPT_MAX_CP = 200;   // more than two pawns is not contempt any more, it is a worse move

function contempt_cp() {
    const n = parseInt(config.contempt_cp);
    return Number.isFinite(n) ? Math.max(0, Math.min(CONTEMPT_MAX_CP, n)) : 30;
}

// The game's own board, replayed from its start so chess.js has counted the repetitions -- which is
// the only way a threefold is knowable at all. null when the replay cannot be trusted (no move list,
// a variant chess.js will not play, a mis-scrape), and a null board simply means no move is called a
// draw: contempt then returns the engine's own pick, which is the right way to be unsure.
function game_board() {
    try {
        const start = last_pos.startFen || last_eval.fen;
        if (!start || !last_eval.fen) return null;
        const board = new Chess(config.variant, start);
        for (const uci of String(last_pos.moves || '').trim().split(/\s+/).filter(Boolean)) {
            if (!board.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]})) return null;
        }
        // It has to be THIS position, not merely a legal one: placement, side, castling and ep.
        const key = (f) => String(f).split(' ').slice(0, 4).join(' ');
        return key(board.fen()) === key(last_eval.fen) ? board : null;
    } catch (e) {
        return null;
    }
}

// Which of these moves ends the game in a draw right now, as a Set of UCI. Empty whenever the board
// could not be replayed, so an unknown position never loses a move to contempt.
function drawing_moves(uciList) {
    const out = new Set();
    const board = game_board();
    if (!board) return out;
    for (const uci of uciList) {
        try {
            if (!board.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]})) continue;
            if (board.isDraw()) out.add(uci);
            board.undo();
        } catch (e) { /* a candidate chess.js will not replay is no evidence of a draw */ }
    }
    return out;
}

// The move to play instead of `best` when `best` draws on the spot and something inside the dial
// does not. `best` back unchanged whenever contempt is off, the top move is not a draw, or every
// candidate within the tolerance draws as well -- in which case the draw is the position, not a
// choice anyone is making.
function contempt_pick(best) {
    if (!config.contempt || !best) return best;
    const margin = contempt_cp();
    if (!margin) return best;
    const lines = (last_eval.lines || []).filter(l => l && l.move);
    const bestLine = lines.find(l => l.move === best);
    const bestCp = bestLine ? line_cp_ours(bestLine) : null;
    if (!Number.isFinite(bestCp) || Math.abs(bestCp) >= 90000) return best; // a mate is not a draw
    const drawing = drawing_moves(lines.map(l => l.move));
    if (!drawing.has(best)) return best;                    // nothing to avoid: the usual case
    let pick = best, pickCp = -Infinity;
    for (const l of lines) {
        if (drawing.has(l.move)) continue;
        const cp = line_cp_ours(l);
        if (!Number.isFinite(cp) || cp <= -90000) continue; // never walk into a mate to dodge a draw
        if (bestCp - cp > margin) continue;                 // outside what the dial is willing to pay
        if (cp > pickCp) { pick = l.move; pickCp = cp; }
    }
    return pick;
}

function humanize_pick(best) {
    const fen = last_eval.fen;
    const lines = (last_eval.lines || []).filter(l => l && l.move && l.pv);
    const bestLine = lines.find(l => l.move === best) || lines[0];
    const bestCp = bestLine ? line_cp_ours(bestLine) : 0;

    let category = 'top engine'; // which slice of the move mix the pick came from (for the countdown)
    // reflex moves first: a human ALWAYS bangs out the recapture / the only legal move --
    // instantly, and without ever "choosing" an alternative
    const lastOpp = last_eval.lastMove; // opponent's move that produced this position (lan)
    // True recapture only: the opponent's move must have been a CAPTURE (which zeroes the FEN
    // halfmove clock) AND we take back on that same square. Instantly snapping off a piece that
    // merely moved in to attack (e.g. a knight hitting our queen) is NOT a reflex for a human --
    // treating it as one made the instant replies look illegitimate. (A pawn push also zeroes the
    // clock, but taking a just-pushed pawn on its square is still a fair reflex; those are rare.)
    let halfmove = 1;
    try { halfmove = parseInt(fen.split(' ')[4]); } catch (e) { /* variant fen: leave >0, no false reflex */ }
    const recapture = lastOpp && halfmove === 0 && best.slice(2, 4) === lastOpp.slice(2, 4);
    let forced = false, fullmove = 999;
    try {
        const chess = new Chess(config.variant, fen);
        forced = chess.moves().length === 1;
        fullmove = parseInt(fen.split(' ')[5]) || 999;
    } catch (e) { /* variant fen chess.js can't parse -- classification just loses two signals */ }

    // ---- WHAT to play: mostly the best move; sometimes a close second; rarely a real mistake.
    // (only Humanize deviates -- with Clock Mode alone this function only shapes the timing)
    let move = best;
    if (config.humanize && !recapture && !forced
        && lines.length >= 2 && bestLine && bestCp < 90000 /* never toy with our own mate */) {
        const playable = (m) => premove_reply_playable(fen, m); // moves OUR piece + legal here
        const loss = (l) => bestCp - line_cp_ours(l);
        const alts = lines.filter(l => l !== bestLine && line_cp_ours(l) > -90000); // never move INTO mate
        const rates = humanize_rates(); // move mix percents; live-tunable in the options page
        // reuse the roll made at search start (so the countdown's shown move matches what's played)
        const r = (humanize_roll != null) ? humanize_roll.r : Math.random() * 100;
        // Each non-top category is a (lo, hi] centipawn band whose edges the user sets in the options
        // page (Move-Quality Thresholds); pick a random alternative whose loss falls in the rolled
        // band. A move worse than the top of the blunder band is never played -- that's a hanging
        // queen, not a human error -- so an out-of-band roll falls back to the best move.
        const bands = humanize_band_bounds();
        const fromBand = ([lo, hi]) => {
            const pool = alts.filter(l => loss(l) > lo && loss(l) <= hi);
            return pool[Math.floor(Math.random() * pool.length)];
        };
        const cat = category_for_roll(r, rates);
        let cand = null;
        // blunders never in an already-decided game (we're the ones winning/losing big)
        if (cat !== 'top' && !(cat === 'blunder' && Math.abs(bestCp) >= 600)) {
            cand = fromBand(bands[cat]);
            if (cand) category = HUMANIZE_LABEL[cat];
        }
        if (cand && playable(cand.move)) move = cand.move;
        else category = 'top engine'; // top slice / pool empty / not playable -> best move after all
    }

    // ---- HOW LONG to think: classify the position, then sample a duration.
    const second = lines.find(l => l !== bestLine);
    const gap = second ? bestCp - line_cp_ours(second) : Infinity;
    const swing = (last_our_eval != null) ? bestCp - last_our_eval : 0;
    last_our_eval = bestCp;

    let kind;
    if (recapture || forced) kind = 'instant';
    else if (gap < 35 && Math.abs(bestCp) < 150) kind = 'long';   // tense: close choices, level game
    else if (swing < -120) kind = 'long';                          // something went wrong -- "sit up"
    else if (gap > 250 || fullmove < 8) kind = 'quick';            // obvious move / opening reel-off
    else kind = 'normal';

    const r = Math.random();
    let think = {instant: r * 150, quick: 250 + r * 500,
                 normal: 600 + r * 1400, long: 2000 + r * 4500}[kind];
    // The complexity clock, when it is on: humanize already sits longer on a TENSE position (the
    // 'long' kind), and this scales what it sits by how far apart the top lines actually are. Never
    // on a reflex -- an instant move is instant because it is forced, not because it is easy.
    // Human Move Times: the same average, drawn from the shape real move times have.
    if (config.human_times) think = lognormal_ms(HUMAN_TIME_MEDIAN[kind]);
    if (kind !== 'instant') think *= complexity_k();


    // ---- clock pacing (only when a clock-aware toggle is on and a clock was read).
    // Mirror Time (its own toggle): spend what the opponent spent on their last move, minus 10%,
    // so our clock tracks theirs while slowly pulling ahead (plus 30% extra haste whenever we're
    // actually behind on time). Falls back to Clock Mode's T/30 + 0.6*increment budget when their
    // spend hasn't been measured (first move, unreadable clock) -- and Clock Mode alone uses that
    // budget always. Reflex moves stay instant regardless, and both paths share the safety rails.
    // `source` = who decided the timing (priority: reflex > mirror > clock > humanize), for the
    // "Playing in ..." countdown under the score.
    if (recapture || forced) category = 'instant response';
    let source = (kind === 'instant') ? 'Reflex' : 'Humanize';
    const budget = clock_budget_ms();
    if (budget != null) {
        const T = last_clocks.mine - (Date.now() - last_clocks.at) / 1000;
        if (config.mirror_mode && kind !== 'instant' && opp_spend != null) {
            think = opp_spend * 1000 * mirror_ratio(); // their spend x the ratio, in ms
            if (last_clocks.theirs != null && T < last_clocks.theirs) think *= 0.7;
            think = Math.min(think, T * 1000 / 8); // never sink an eighth of the clock into one move
            source = 'Mirror Time';
        } else {
            const cap = {instant: think, quick: budget * 0.35, normal: budget, long: budget * 2.5}[kind];
            think = Math.min(think, cap);
            if (kind !== 'instant') source = 'Clock Mode';
        }
        if (T < 20) think = Math.min(think, 250);
        if (T < 8) think = 0;
    }
    return {move, think: Math.round(think), source, category: config.humanize ? category : null};
}

// "Playing in X.Xs (Mirror Time)" countdown under the score -- shown whenever a pacing mode
// (mirror/clock/humanize) decided a think delay for the move that is about to be played
let eta_timer = null, eta_target = 0, eta_source = '', eta_category = null;

// The "Playing in X.Xs" countdown is TARGET-anchored so it can span the whole move: it's started
// when the SEARCH begins (on_new_pos) with the full intended time -- so it counts the entire pace
// down while the engine thinks, not just the ~150ms tail left after the search fills the time --
// and updated when the move is picked (on_engine_best_move) to add which humanize slice is coming.
function set_move_countdown(target, source, category = null) {
    eta_target = target; eta_source = source; eta_category = category;
    clearInterval(eta_timer);
    const tick = () => {
        const el = PANEL_ROOT.getElementById('next-move');
        if (!el) { clearInterval(eta_timer); return; }
        const left = eta_target - Date.now();
        const suffix = eta_category ? ` · ${eta_category}` : ''; // humanize: which move it plays next
        if (left <= 50) {
            el.textContent = i18n('panel.eta.now', 'Playing now ({source}){suffix}', {source: eta_source, suffix});
            clearInterval(eta_timer);
            return;
        }
        el.textContent = i18n('panel.eta.in', 'Playing in {secs}s ({source}){suffix}',
        {secs: (left / 1000).toFixed(1), source: eta_source, suffix});
    };
    tick();
    eta_timer = setInterval(tick, 100);
}

function clear_next_move_eta() {
    clearInterval(eta_timer);
    eta_target = 0;
    const el = PANEL_ROOT.getElementById('next-move');
    if (el) el.textContent = '';
}

// Estimated TOTAL time (ms) this move will take + who's pacing it -- known before the search from
// the clock (Mirror/Clock) or the humanize criticality estimate. null when nothing changes the
// base time (plain autoplay), so no countdown is shown then.
function estimated_move_total_ms(fen) {
    const pace = paced_move_target_ms();
    if (pace != null) {
        if (pace.ms <= 0) return null; // low clock -> effectively instant, nothing to count down
        return {ms: pace.ms, source: (config.mirror_mode && opp_spend != null) ? 'Mirror Time' : 'Clock Mode'};
    }
    const hz = humanize_presearch_ms(fen);
    if (hz != null) return {ms: hz, source: 'Humanize'};
    return null;
}

// The four think/move timing values, read fresh from localStorage (options page + quick settings
// both write here). Falls back to the loaded config value when a key is unset. JSON.parse(null)
// is null, so `!= null` keeps a legitimate 0.
// The square the last move captured on, or null if it took nothing. Replays the move list on a
// chess.js board because that is the only place the answer exists -- the list is just squares.
function last_capture_from(startFen, movesStr) {
    const list = String(movesStr || '').trim().split(/\s+/).filter(Boolean);
    if (!list.length) return null;
    try {
        const c = new Chess(config.variant, startFen);
        let last = null;
        for (const uci of list) {
            last = c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
            if (!last) return null;                 // a list we cannot replay tells us nothing
        }
        return (last && last.captured) ? last.to : null;
    } catch (e) {
        return null;
    }
}

// ---- WHAT THE MOVE IS, not just how many have been played -----------------------------------
// Pacing used to be one distribution for every move, which is the tell: a human is not evenly slow.
// They are instant on a recapture, slower with the queen than with the king, slower again when they
// can see a mate, and they stop deliberating at all when the flag is near. These are multipliers on
// the THINK part -- the pause before the move -- because that is the part a watcher can see.
//
// All of it is a pure function of the position, the move and the clock, which is what lets it be
// executed in the tests against real positions rather than argued about.
const SITUATION = {
    recapture:  0.25,   // taking back on the square they just took on: nobody thinks about this
    forced:     0.30,   // only one legal move: there is nothing to weigh
    mateSeen:   1.35,   // a mate on the board is checked twice before it is played
    queen:      1.25,   // the piece you least want to hang
    rook:       1.10,
    minor:      1.00,
    pawn:       0.90,
    king:       0.80,   // usually forced or obvious
};
// Clock pressure. Nobody spends twelve seconds on move forty with thirty left on the clock.
const CLOCK_STEPS = [
    {under: 10, k: 0.15},
    {under: 30, k: 0.35},
    {under: 60, k: 0.60},
    {under: 120, k: 0.85},
];

// `info` is {fen, uci, mate, legalCount, lastCapture}. Anything missing simply does not apply, so a
// caller that knows nothing still gets the user's own settings back unchanged.
function situational_k(info) {
    if (!info || !info.uci) return 1;
    let k = 1;
    const to = info.uci.slice(2, 4);
    // A RECAPTURE: they captured on a square, and this move captures back on that same square.
    if (info.lastCapture && info.lastCapture === to) return SITUATION.recapture;
    if (info.legalCount === 1) return SITUATION.forced;
    if (info.mate != null && Math.abs(info.mate) > 0) k *= SITUATION.mateSeen;
    const piece = (info.piece || '').toLowerCase();
    if (piece === 'q') k *= SITUATION.queen;
    else if (piece === 'r') k *= SITUATION.rook;
    else if (piece === 'n' || piece === 'b') k *= SITUATION.minor;
    else if (piece === 'p') k *= SITUATION.pawn;
    else if (piece === 'k') k *= SITUATION.king;
    return k;
}

function clock_k(secondsLeft) {
    if (secondsLeft == null || !isFinite(secondsLeft)) return 1;
    for (const step of CLOCK_STEPS) if (secondsLeft < step.under) return step.k;
    return 1;
}

// The think part is scaled; the MOVE part (the click itself) is left alone -- a human's hand does
// not speed up because the position is simple, and the existing floor exists for the same reason.
function situational_timing(t, info) {
    const k = situational_k(info) * clock_k(info && info.secondsLeft) * complexity_k();
    if (k === 1) return t;
    return {
        ...t,
        think_time: Math.max(0, Math.round(t.think_time * k)),
        think_variance: Math.max(0, Math.round(t.think_variance * k)),
    };
}

// What the panel knows about the move it is about to play, in the shape situational_timing wants.
function move_situation(fen, uci) {
    const out = {uci, secondsLeft: null, mate: null, legalCount: null, piece: '', lastCapture: null};
    try {
        if (last_clocks && last_clocks.mine != null) {
            out.secondsLeft = last_clocks.mine - (Date.now() - last_clocks.at) / 1000;
        }
        const line = last_eval.lines && last_eval.lines[0];
        if (line && line.mate != null) out.mate = line.mate;
        if (fen && uci) {
            const c = new Chess(config.variant, fen);
            out.legalCount = c.moves().length;
            const from = c.get(uci.slice(0, 2));
            if (from) out.piece = from.type;
        }
        out.lastCapture = last_capture_square;
    } catch (e) { /* an unparseable position tells us nothing, which is fine */ }
    return out;
}

// The square the OPPONENT last captured on, which is what makes the next move a recapture. Set from
// the move list as positions arrive; null when their last move took nothing.
let last_capture_square = null;

function fresh_timing(situation) {
    const num = (key, fallback) => {
        const v = JSON.parse(MephistoConfig.get(key));
        return (v != null) ? v : fallback;
    };
    // Read fresh from storage, THEN paced to the clock if that is switched on -- so editing the
    // sliders mid-game still applies to the very next move, and the pacing works from what you
    // actually set rather than from a snapshot.
    // Situation first (what the move IS), then the clock cap (what the clock allows). In that
    // order, because the cap is a ceiling: scaling a move up for a visible mate must not be able to
    // spend time the clock does not have.
    const t = {
        think_time: num('think_time', config.think_time),
        think_variance: num('think_variance', config.think_variance),
        move_time: num('move_time', config.move_time),
        move_variance: num('move_variance', config.move_variance),
    };
    // Human Move Times replaces the flat draw with a log-normal one of the same average, and hands
    // on a FIXED number (variance 0): the shape is decided here, in one place, rather than half here
    // and half in the content script's own `think_time + random * variance`.
    if (config.human_times) {
        t.think_time = lognormal_ms(t.think_time + t.think_variance / 2);
        t.think_variance = 0;
    }
    return clock_pace_timing(situational_timing(t, situation));
}

// ---- Self-test: a one-tap health check shown in the status line for a few seconds. Scrape = a
// position is currently detected; Engine = it has produced analysis for it; Native = for a native
// engine, the host actually answered a ping (the real active check -- a missing host is the usual
// "nothing happens" cause). Restores the status line after ~6s.
async function run_self_test() {
    const el = PANEL_ROOT.getElementById('game-detection');
    if (!el) return;
    const prev = el.innerText, wasUnsupported = el.classList.contains('unsupported');
    el.classList.remove('unsupported');
    el.innerText = 'Self-test: running…';
    const scrapeOK = !!last_eval.fen;
    const engineOK = !!(last_eval.lines && last_eval.lines[0] && last_eval.lines[0].pv);
    let nativePart = '', nativeOK = true;
    if (NATIVE_ENGINES.includes(config.engine)) {
        nativeOK = await native_host_available(native_port_name());
        nativePart = nativeOK ? ' · Native ✓' : ' · Native ✗ (run native-host/install.sh)';
    }
    const mark = (b) => b ? '✓' : '✗';
    const allOK = scrapeOK && engineOK && nativeOK;
    el.innerText = `Self-test - Scrape ${mark(scrapeOK)} · Engine ${mark(engineOK)}${nativePart}`;
    el.classList.toggle('unsupported', !allOK);
    setTimeout(() => { el.innerText = prev; el.classList.toggle('unsupported', wasUnsupported); }, 6000);
}

// ---- Lichess win% + accuracy (win-percent model, PR #11148 + AccuracyPercent.scala). cp is
// white/side-relative centipawns. Used by the opponent-mistake alert and mirrored in the options
// page's threshold readout, so both label a move exactly as a Lichess game review would.
// LIVE STATS, derived entirely from the eval history rather than from new bookkeeping. The history
// is one white-win fraction per ply, so every move's cost is the change across it -- and the panel
// and Game Review already agree that a win% drop is what makes a move good or bad. Nothing here is
// measured a second way, which is the only reason the strip can agree with the review afterwards.
//
// Lichess's accuracy curve, the same one Game Review uses. A move is scored on the drop it caused
// FOR THE SIDE THAT PLAYED IT; the other side's turn is not their responsibility.
function accuracy_from_drop(drop) {
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1669));
}

// HEALTH CHECK. "It did nothing" is the commonest report and the hardest to act on, and every fact
// needed to answer it is already gathered for the diagnostics -- it was simply never shown until
// somebody asked. Deliberately NOT tied to a first run: something that stops working on day two
// hundred deserves the same answer as something that never started.
//
// Returns rows rather than a rendered string so the caller decides how to show them, and so this is
// testable without a panel. `ok: null` means "not applicable here" -- a native host is not a fault
// on a WASM engine, and reporting it as one would send people chasing the wrong thing.
// One place that knows where each fact lives, so the check and the diagnostics cannot drift.
function health_state() {
    return {
        site: (typeof site !== 'undefined' && site) || null,
        board: !!(last_eval && last_eval.fen),
        fen: (last_eval && last_eval.fen) || null,
        config: !!config,
        engine: !!engine || uses_native() || is_remote(),
        engineName: config?.engine || null,
        usesNative: uses_native(),
        nativeUp: native_alive,
    };
}

function health_rows(state) {
    const st = state || {};
    const rows = [];
    const row = (label, ok, detail) => rows.push({label, ok, detail});
    row('Site recognised', !!st.site, st.site || 'this page is not one of the supported sites');
    row('Board found', !!st.board, st.board ? '' : 'the page has no board the scraper recognises');
    row('Position read', !!st.fen, st.fen ? '' : 'nothing has been scraped yet');
    row('Settings received', !!st.config, st.config ? '' : 'the page script never got its settings');
    row('Engine loaded', !!st.engine, st.engineName || 'no engine has answered yet');
    row('Native host', st.usesNative ? !!st.nativeUp : null,
        st.usesNative ? (st.nativeUp ? st.engineName : 'the host is not answering -- run its installer once')
                      : 'not needed for this engine');
    return rows;
}

function live_stats(history) {
    // counts carries the FULL published scheme (brilliant .. blunder), so the strip says the same
    // words the Game Review will afterwards; the four coarse keys stay for anything still reading
    // them, and are now derived from the classifier rather than from a second set of bands.
    const empty = () => ({moves: 0, accuracy: null, best: 0, inaccuracy: 0, mistake: 0, blunder: 0,
                          counts: {}});
    const out = {white: empty(), black: empty(), plies: 0};
    if (!Array.isArray(history) || history.length < 2) return out;
    const classes = classify_history();
    const acc = {white: [], black: []};
    for (let i = 0; i + 1 < history.length; i++) {
        const before = history[i], after = history[i + 1];
        if (typeof before !== 'number' || typeof after !== 'number') continue;
        // ply i is played BY the side to move at ply i: white on even plies.
        const side = (i % 2 === 0) ? 'white' : 'black';
        // a drop is always measured in the mover's own favour, so both sides read the same way
        const drop = (side === 'white' ? 1 : -1) * (before - after) * 100;
        const s = out[side];
        s.moves++;
        acc[side].push(accuracy_from_drop(drop));
        const label = win_drop_label(drop);
        if (label) s[label]++; else s.best++;
        // the classifier's own verdict, when it could form one (it needs the engine's lines for
        // that ply); a ply it could not judge simply is not counted rather than counted wrongly
        const klass = classes[i];
        if (klass) s.counts[klass] = (s.counts[klass] || 0) + 1;
        out.plies = i + 1;
    }
    for (const side of ['white', 'black']) {
        const a = acc[side];
        out[side].accuracy = a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
    }
    return out;
}

function win_percent(cp) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
// Judgement label from a win% DROP (before - after). 20/10/5, the published chess.com bands the
// Game Review uses since 3.1.251 -- the panel and the review MUST agree, or the same move gets two
// verdicts depending on which screen you read it on (they were 30/20/10 here and in the review
// before that release, so both moved together).
// --- PLAYING WITH A NET -----------------------------------------------------------------------
// Not "here is the best move". The question this answers is the one you actually have when the
// moves are yours: am I about to throw this away, and what still holds if I am? So it reports a
// SET -- every candidate whose win% is within a drop of the best one -- and in its quiet mode it
// says nothing at all until that set is small enough to be a warning.
//
// The ruler is the win% the panel already judges moves by (win_percent + the published bands), so a
// move this calls safe and a move the Game Review later calls a mistake cannot disagree.
//
// It can only ever see the lines the engine was asked for: with Multiple Lines at 1 there is no
// set to report, and it says so rather than implying the one line is the only safe move.
// The last COMPLETE verdict, per position. The line array is rebuilt at the top of every depth
// iteration (pv 1 lands alone, pv 2..N a beat later), so any read taken at that instant sees one
// line and would flicker to "forced"/silence once per depth -- which is exactly how the whole
// feature managed to render nothing while four lines sat on screen. A position that is GENUINELY
// forced never produces a fuller verdict, so reusing the cache cannot hide a real forced move.
let net_last_full = null;   // {fen, set}

function safety_net_set() {
    if (!config.safety_net) return null;
    const lines = (last_eval.lines || []).filter(l => l && l.move && typeof l.score === 'number');
    if (!lines.length) return null;
    if (lines.length < 2) {
        if (Number(config.multiple_lines) > 1) {
            // mid-iteration: the rest of this depth's lines land in a moment -- hold the last full
            // verdict for THIS position rather than flickering. No fuller verdict ever arriving is
            // what a truly forced move looks like, and that stays silent.
            if (net_last_full && net_last_full.fen === last_eval.fen) return net_last_full.set;
            return {forced: true, moves: [lines[0].move], total: 1};
        }
        return {needMoreLines: true, moves: [], total: 0};
    }
    // scores are white-relative; the side to move is the one choosing, so flip for black
    const sign = (turn === 'w') ? 1 : -1;
    const wp = (l) => win_percent(sign * l.score);
    const best = Math.max(...lines.map(wp));
    const drop = Math.max(1, Math.min(50, Number(config.safety_net_drop) || 10));
    const moves = lines.filter(l => best - wp(l) <= drop).map(l => l.move);
    const set = {moves, all: lines.map(l => l.move), total: lines.length, drop, bestWp: best, needMoreLines: false};
    net_last_full = {fen: last_eval.fen, set};   // the verdict the mid-iteration reads hold on to
    return set;
}

// Below this best-win%, quiet mode stops nagging: the game is not being thrown away, it is
// already gone, and "only one move holds" over a lost position is noise. Live mode still shows
// the set -- asking to always see it is asking to always see it.
const SAFETY_NET_FLOOR_WP = 20;

// When quiet mode speaks. The question is not "is the set small" but "are YOU about to leave it":
// while Maia says your likely move already holds, there is nothing to say, however sharp the
// position -- and when it says you are about to step off, the set is the warning. Maia's answer
// arrives a beat after the engine's (one forward pass, cached per position); until it lands, the
// set-size rule stands in, so the net never goes silent for want of a second engine.
function safety_net_showing() {
    const set = safety_net_set();
    if (!set || set.needMoreLines) return set;
    if (set.forced) return null;                     // a recapture is not a decision
    // order the set the way a HUMAN meets it: Maia's probability, engine order for the rest
    const human = (last_eval.humanSelf && last_eval.humanSelf.fen === last_eval.fen)
        ? last_eval.humanSelf.list : null;
    if (human) {
        const rank = new Map(human.map((h, i) => [h.uci, i]));
        set.moves = set.moves.slice().sort((a, b) =>
            (rank.has(a) ? rank.get(a) : 99) - (rank.has(b) ? rank.get(b) : 99));
        set.likely = human[0]?.uci || null;
    }
    if (config.safety_net_mode === 'live') return set;
    if (set.bestWp != null && set.bestWp < SAFETY_NET_FLOOR_WP) return null;   // unsavable
    if (set.likely) {
        if (set.moves.includes(set.likely)) return null;   // your likely move already holds
        // fire only on a move the engine actually SCORED outside the set -- a likely move the
        // list never reached is unknown, not condemned, and falls through to the size rule
        if (set.all.includes(set.likely)) { set.likelyThrows = true; return set; }
    }
    const critical = Math.max(1, Math.min(5, Number(config.safety_net_max) || 3));
    // a set that is everything we looked at is not a warning: the engine simply saw no danger
    return (set.moves.length <= critical && set.moves.length < set.total) ? set : null;
}

function win_drop_label(drop) {
    if (drop >= 20) return 'blunder';
    if (drop >= 10) return 'mistake';
    if (drop >= 5) return 'inaccuracy';
    return null;
}

// ---- Opponent-mistake alert. Flag when the opponent plays an inaccuracy/mistake/blunder, judged by
// the same Lichess win% method. Only when BOTH the position they moved from and the one they moved to
// were searched to a trustworthy depth -- a shallow eval swings wildly and would invent blunders.
const OPP_ALERT_MIN_DEPTH = 14;
let last_pos_eval = null; // {fen, cpWhite, depth, sideToMove} of the position currently on the board
// which verdicts are worth interrupting for: the opponent giving something away, not the ordinary
// run of good moves (a classifier that also names 'best' would fire on almost every move)
const ALERT_CLASSES = ['blunder', 'miss', 'mistake', 'inaccuracy'];
let opp_alert_armed = null; // {beforeCpWhite, oppColor} set when the opponent just moved; cleared on fire

// Called when a NEW position arrives (on_new_pos), BEFORE last_eval is reset. If the position we were
// just analysing was the opponent's turn and reached depth, its eval is the "before their move" value.
function opp_alert_on_new_pos(newFen) {
    if (!config.opp_alert || !last_pos_eval) { opp_alert_armed = null; return; }
    // A RE-PUSH of the unchanged position must not disarm. chess.com re-reports the same position
    // routinely, and the disarm used to run before this check -- so the pending alert was cleared
    // in the gap between the opponent's move and the first deep-enough eval, every time, and the
    // toast never fired there at all. Found live in the audit sweep with a hung queen on the board.
    if (last_pos_eval.fen === newFen) return;
    opp_alert_armed = null;
    if (!config.opp_alert || !last_pos_eval || last_pos_eval.fen === newFen) return;
    if (last_pos_eval.depth < OPP_ALERT_MIN_DEPTH) return; // shallow "before" -> don't trust it
    const our = (our_side() === 'white') ? 'w' : 'b';
    if (last_pos_eval.sideToMove !== our) { // it was the OPPONENT to move -> they just made this move
        // keep the "before" fen too, so we can render their move in SAN at fire time
        opp_alert_armed = {beforeCpWhite: last_pos_eval.cpWhite, oppColor: last_pos_eval.sideToMove,
                           beforeFen: last_pos_eval.fen};
    }
}

// UCI -> SAN in the position it was played from; falls back to the raw UCI if chess.js can't parse.
function uci_to_san(fen, uci) {
    if (!fen || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return uci || '';
    try {
        return new Chess(config.variant, fen).move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]}).san;
    } catch (e) { return uci; }
}

// Called when the CURRENT position's eval updates (on_engine_evaluation). Fires once the new position
// is also deep enough, comparing the opponent's win% before vs after their move.
function opp_alert_maybe_fire() {
    if (!config.opp_alert || !opp_alert_armed || !last_pos_eval) return;
    if (last_pos_eval.fen !== last_eval.fen || last_pos_eval.depth < OPP_ALERT_MIN_DEPTH) return;
    const sign = (opp_alert_armed.oppColor === 'w') ? 1 : -1; // opponent-relative eval
    const drop = win_percent(sign * opp_alert_armed.beforeCpWhite) - win_percent(sign * last_pos_eval.cpWhite);
    const uci = last_eval.lastMove || ''; // the opponent's move that produced this position
    const san = uci_to_san(opp_alert_armed.beforeFen, uci);
    // THE SAME VERDICT THE STRIP AND THE REPORT GIVE. The alert used to derive its own label from
    // the drop, which meant a move could be announced as a Mistake and counted as a Miss two
    // inches away. When the classifier has graded this ply, that verdict wins -- it also knows
    // Miss (a win let go), which a drop alone cannot tell from an ordinary mistake. Where it has
    // nothing to say (no history recorded), the old drop label still fires.
    const classes = classify_history();
    const graded = classes.length ? classes[classes.length - 1] : null;
    const label = (graded && ALERT_CLASSES.includes(graded)) ? graded : win_drop_label(drop);
    opp_alert_armed = null; // fire at most once per opponent move
    if (label) send_to_active_tab({oppAlert: true, label, drop: Math.round(drop), san, uci});
}

// ---- Manual Mode: play the engine's current best move on YOUR keypress (the play-move hotkey).
// The search runs `go infinite` in Manual Mode, so it never fires on its own; this is the trigger.
// Returns whether it CONSUMED the key: true whenever Manual Mode is on (so the play-move key -- e.g.
// Space -- is swallowed during a game), false otherwise (so Space still scrolls the page when Manual
// Mode is off). Actually plays only on our turn with a legal, ours move.
function manual_play() {
    if (!config.manual_mode) return false; // not our concern -> let the key through (Space scrolls)
    // only on OUR turn, and only a move that's actually ours + legal right now (same guard autoplay
    // uses). last_eval.bestmove is set only on our turn, so a stale opponent-turn value can't leak.
    const our = (our_side() === 'white') ? 'w' : 'b';
    if (last_eval.fen?.split(' ')[1] === our) {
        const best = last_eval.bestmove || last_eval.lines?.[0]?.move;
        if (best && premove_reply_playable(last_eval.fen, best)) {
            request_automove(best, null, true); // manual:true bypasses the content-script's autoplay gate
        }
    }
    return true; // Manual Mode is on: swallow the key even if there was nothing to play this instant
}

// ---- Hotkeys. The content script owns the keydown listener (keys land on the game page) and calls
// this with an action name; here we perform it. Toggles flip the quick-settings checkbox and fire
// its change event, so they reuse ALL the existing wiring (config write, push, engine re-init).
const HOTKEY_TOGGLES = { // action -> the quick-settings checkbox it flips
    autoplay: 'qs_autoplay', premove: 'qs_premove', help_mode: 'qs_help', humanize: 'qs_humanize',
    clock_mode: 'qs_clock', clock_pace: 'qs_clockpace', mirror_mode: 'qs_mirror', manual_mode: 'qs_manual',
    eval_bar: 'qs_evalbar', eval_history: 'qs_evalhist', live_stats: 'qs_livestats',
    tablebase: 'qs_tablebase', puzzle_mode: 'qs_puzzle',
    explorer: 'qs_explorer', book_play: 'qs_book',
};
// Returns true if it handled the action (the content-script listener only swallows the key then, so
// an inert binding -- e.g. Space while Manual Mode is off -- doesn't block the page's own use of it).
// "Alt+a" -> "Alt+A", " " -> "Space" (for the little "(A)" hint on each toggle)
function hotkey_pretty(k) {
    if (!k) return '';
    return k.split('+').map(p => p === ' ' ? 'Space' : (p.length === 1 ? p.toUpperCase() : p)).join('+');
}
// Append the bound key to each quick-settings toggle label, e.g. "Autoplay (A)", so the shortcut is
// visible where you use it. Reads the live bindings; run once after the toggles are wired.
// One style for every shortcut hint, wherever it appears: the quick-settings rows and the title
// bar's two buttons read the same because they mean the same thing. The title-bar hint was smaller
// and raised (`vertical-align:super`), which made it look like a footnote marker rather than a key.
const HOTKEY_HINT_CSS = 'opacity:0.5;font-size:0.82em;margin-left:3px';

function annotate_hotkey_labels() {
    const keys = MephistoConfig.hotkeys();
    for (const action in HOTKEY_TOGGLES) {
        const input = PANEL_ROOT.getElementById(HOTKEY_TOGGLES[action]);
        const label = input?.closest('.qs-row')?.querySelector('.qs-label');
        if (!label || !keys[action]) continue;
        // UPDATED, not skipped-if-present. Skipping meant a key rebound on the settings page kept
        // advertising the old one until the panel was rebuilt -- a label that lies about a shortcut
        // is worse than no label.
        let s = label.querySelector('.qs-hk');
        if (!s) {
            s = document.createElement('span');
            s.className = 'qs-hk';
            s.style.cssText = HOTKEY_HINT_CSS;
            label.appendChild(s);
        }
        s.textContent = `(${hotkey_pretty(keys[action])})`;
    }
    // ...and the title bar's own two buttons. They are the content script's markup, but they sit in
    // the same shadow root, so they are reachable from here -- and doing it here means they follow
    // the same bindings, the same rebinds and the same language pass as every other shortcut hint.
    for (const [action, cls] of [['compact', 'mephisto-overlay-compact'],
                                 ['minimize', 'mephisto-overlay-min']]) {
        const el = PANEL_ROOT.querySelector?.(`.${cls}`);
        if (!el || !keys[action]) continue;
        const key = hotkey_pretty(keys[action]);
        let hk = el.querySelector('.mephisto-bar-hk');
        if (!hk) {
            hk = document.createElement('span');
            hk.className = 'mephisto-bar-hk';
            hk.style.cssText = HOTKEY_HINT_CSS;
            el.appendChild(hk);
        }
        hk.textContent = `(${key})`;
        // the tooltip gains the key too, from the ORIGINAL text each time -- appending to the live
        // title would grow "(V) (V) (V)" across rebinds
        if (el.dataset.baseTitle === undefined) el.dataset.baseTitle = el.title || '';
        el.title = el.dataset.baseTitle ? `${el.dataset.baseTitle} (${key})` : key;
    }
}

// THE PANIC KEY: everything away, NOW. Screen first -- the panel, the eval bar and every arrow go
// in one call (removeOverlay suspends the search before tearing anything down, so nothing keeps
// burning cores) -- and no SETTING changes, so reopening from the toolbar brings everything back
// exactly as configured. In the toolbar bubble there is no overlay to remove; the search is stopped
// and the bubble closes, which is the same promise kept in that context.
function panic() {
    try { send_engine_uci('stop'); } catch (e) { /* the engine is not up; nothing to stop */ }
    if (self.MephistoContent?.closePanel) {
        self.MephistoContent.closePanel();
    } else {
        try { self.MephistoPanel?.suspend?.(); } catch (e) { /* not booted */ }
        window.close();
    }
    return true;
}

function do_hotkey(action) {
    if (action === 'panic') return panic();
    if (action === 'manual_play') return manual_play();
    if (action === 'copy_fen') { copy_to_button('copyfen', last_eval.fen); return true; }
    if (action === 'copy_pgn') { copy_to_button('copypgn', current_pgn()); return true; }
    if (action === 'copy_diagnostics') {
        // The reason line doubles as the confirmation: there is no button left to flash a tick on,
        // and a hotkey that appears to do nothing is worse than no hotkey.
        copy_diagnostics((err) => set_idle_reason(err || i18n('panel.diagnostics_copied',
            'Diagnostics copied to the clipboard.')));
        return true;
    }
    if (action === 'redetect') { PANEL_ROOT.getElementById('recheck')?.click(); return true; }
    // WALK THE ENGINE'S LINE with the arrow keys. Returns FALSE while the toggle is off -- the
    // dispatcher only swallows a key the panel acted on, so the site keeps its own arrow-key move
    // navigation (lichess and chess.com both use them) until this is switched on deliberately.
    if (action === 'pv_back' || action === 'pv_forward') {
        if (!config.pv_keys) return false;
        return action === 'pv_back' ? pv_walk_back() : pv_walk_forward();
    }
    // Bot Tricks. Returns FALSE anywhere the row is not showing, so the key stays the site's own on
    // every other page rather than being swallowed by a feature that is switched off -- the same
    // contract Manual Mode's Space has.
    if (action === 'bot_trick') {
        if (!on_computer_play_page() || String(config.bot_tricks) !== 'true') return false;
        run_bot_trick('mate');
        return true;
    }
    // The two title-bar buttons. Compact is the panel's own state; minimize is the overlay's chrome
    // and lives in the content script, so it is asked rather than done here (same as panic).

    // The two title-bar buttons. Compact is the panel's own state; minimize is the overlay's chrome
    // and lives in the content script, so it is asked rather than done here (same as panic).
    if (action === 'compact') { toggle_compact(); return true; }
    if (action === 'minimize') {
        try { return !!self.MephistoContent?.toggleMinimize?.(); }
        catch (e) { return false; }   // toolbar-popup mode has no overlay to minimize
    }
    const box = HOTKEY_TOGGLES[action] && PANEL_ROOT.getElementById(HOTKEY_TOGGLES[action]);
    if (!box) return false;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    return true;
}

// Follow the page in and out of Puzzle Mode, the way the variant detector follows a variants page
// onto Fairy-Stockfish. Arriving at lichess/training or chess.com/puzzles switches it on; leaving
// switches it back off.
//
// The off half matters more than the on half. Puzzle Mode changes how the panel plays quite a lot --
// one move at a time, the opponent's turn not analysed, Premove disabled -- so leaving it latched on
// when you go back to a real game would be a worse bug than never having offered this. It is only
// undone if WE were the one who turned it on: a manual choice is never overridden.
// Did THIS extension switch Puzzle Mode on for a puzzle page? STORED, not a variable.
//
// It was a variable, and that made the off half quietly stop working. The panel is rebuilt far more
// often than it looks -- every page load, every tab switch, every time the service worker is woken --
// and each new panel starts with the flag false while `puzzle_mode` comes back true from storage.
// The two then agree ("already where it should be"), so nothing records that the switch was ours,
// and leaving the site hits the "you turned it on yourself" guard and leaves Puzzle Mode latched on
// in a real game. Reloading once on a puzzle page was enough to lose it for the rest of the session.
function auto_puzzle_flag() {
    return MephistoConfig.get('auto_puzzle_mode') === 'true';
}
function set_auto_puzzle_flag(on) {
    if (auto_puzzle_flag() === !!on) return;   // a write per poll otherwise, forever, in every game
    MephistoConfig.set('auto_puzzle_mode', on ? 'true' : 'false');
}

// `onPuzzlePage` is the content-script's `isPuzzlePage()` and nothing else -- ONE predicate decides
// both directions, so Puzzle Mode can only be switched off outside exactly the URLs that switch it
// on. The panel deliberately holds no list of its own to drift from that one.
function sync_puzzle_mode_to_page(onPuzzlePage) {
    if (onPuzzlePage == null) return;              // site the content-script does not classify
    if (onPuzzlePage === !!config.puzzle_mode) {   // already where it should be
        // On a puzzle page with it already on, this is either our own doing carried across a reload
        // or your manual choice -- and the stored flag is the only thing that can still tell them
        // apart, so it is left exactly as it is.
        if (!onPuzzlePage) set_auto_puzzle_flag(false);
        return;
    }
    if (!onPuzzlePage && !auto_puzzle_flag()) return; // you turned it on yourself -- leave it alone
    const box = PANEL_ROOT.getElementById('qs_puzzle');
    if (!box) return;
    set_auto_puzzle_flag(onPuzzlePage);
    // Flip the checkbox and fire its change event rather than writing config directly: that is the
    // one path that also saves, pushes to the content-script and re-renders, and it is what the
    // hotkeys use for the same reason.
    box.checked = onPuzzlePage;
    box.dispatchEvent(new Event('change'));
    console.log(`Puzzle Mode ${onPuzzlePage ? 'on' : 'off'} - following the page`);
}

// ==================================================================================================
// FOUR-PLAYER BYPASS LANE
//
// 4PC is 14x14 with four seats and a FEN4 position. chess.js cannot represent ANY of that, so this
// lane deliberately skips the whole normal pipeline: no chess.js parse, no legality check, no
// premove, no arrows, no eval bar, no panel board. Scrape in, engine move out, two clicks.
//
// It is entered only when BOTH hold -- the scrape came back as a 4PC payload AND the selected engine
// is a four-player one -- so nothing about the ordinary path changes shape when this file is loaded.
// ==================================================================================================
let board4pc = null;           // the 14x14 renderer, non-null only while it OWNS the #board host
let fourpc_last = '';          // last FEN4 we analysed, to skip re-analysing an unchanged board
let fourpc_busy = false;       // one search at a time: Tetrarch is single-threaded and ignores `stop`
let fourpc_pending = null;     // newest position that arrived while a search was in flight

function is_fourpc_engine() {
    return FOURPC_ENGINES.includes(config.engine);
}

// `4PC:<ourSeat>:<fen4>` -- the content script tags the payload with the seat we are sitting in,
// because "our turn" cannot be derived from a FEN4 alone (it names the side to move, not us).
// The four-player engine follows the page, the way Puzzle Mode does: 4PC needs Tetrarch and Tetrarch
// is useless anywhere else, so selecting it by hand on every game (and remembering to put it back)
// is a chore the page can do for us.
//
// `fourpc_prev_engine` holds what to go back to AND doubles as "we are the ones who switched" -- so a
// deliberate choice is never overridden, matching the Puzzle Mode follow. Changing engine reloads the
// panel, which is why every path here returns unless something actually has to change: a switch that
// re-fires on each poll would reload the panel once a second.
let fourpc_prev_engine = null;

function sync_fourpc_engine_to_page(onFourPCPage) {
    if (onFourPCPage == null) return;                 // a site the content-script does not classify
    const sel = PANEL_ROOT.getElementById('qs_engine');
    if (!sel) return;
    const isFourPC = is_fourpc_engine();
    if (onFourPCPage) {
        if (isFourPC) return;                         // already on a four-player engine
        if (fourpc_prev_engine) {
            // We switched, and you have since picked something else WHILE STILL on a 4PC page. That
            // is a deliberate choice, so stop managing the engine rather than switching back on the
            // next poll and fighting you once a second. (Puzzle Mode's version of this does fight
            // you; it should not, but that is its bug to fix, not one to copy.)
            fourpc_prev_engine = null;
            return;
        }
        fourpc_prev_engine = config.engine;            // remember what to restore
        sel.value = FOURPC_ENGINES[0];
        sel.dispatchEvent(new Event('change'));        // the one path that saves, pushes and reloads
        console.log(`Engine -> ${FOURPC_ENGINES[0]} - following the page (was ${fourpc_prev_engine})`);
        return;
    }
    // LEFT THE 4PC PAGES. Unlike Puzzle Mode this is not a preference to respect: Tetrarch plays
    // 14x14 four-player chess and nothing else, so leaving it selected on a normal game is simply a
    // broken panel. Switch away whether we chose it or you did.
    if (!isFourPC) { fourpc_prev_engine = null; return; }  // already on something else
    // back to what you had, unless that was also a 4PC engine (or there was nothing to remember)
    const back = (fourpc_prev_engine && !FOURPC_ENGINES.includes(fourpc_prev_engine))
        ? fourpc_prev_engine : FOURPC_FALLBACK_ENGINE;
    fourpc_prev_engine = null;
    sel.value = back;
    sel.dispatchEvent(new Event('change'));
    console.log(`Engine -> ${back} - restored on leaving 4-player chess`);
}

// 4PC does NOT go through request_automove. That function is two-player to its bones: it asks
// our_side() for white/black, computes `verify` from last_eval.fen (which this lane never sets), runs
// safe_deselect_square through chess.js -- and, the one that actually bit, it ships the move as
// `pv: [move]` whenever Puzzle Mode is on, because the content-script's puzzle branch takes that
// shape. The content script tests `response.pv` BEFORE the 4PC branch, so a 4PC move arrived at the
// 8x8 simulator and was refused by its [a-h][1-8] regex. Nothing clicked, and Puzzle Mode being on is
// not a state anyone would think to mention.
//
// An explicit `fourpc: true` flag, checked first, makes the routing independent of any other setting.
function request_automove_4pc(move) {
    send_to_active_tab({automove: true, fourpc: true, move, timing: fresh_timing(),
                        deselect: null, verify: false, manual: false});
}

// One arrow spec per engine line, best first, in the 8x8 board's palette. Falls back to the single
// best move when the host returned no line array at all (MultiPV 1, or an older host).
function fourpc_arrow_specs(lines, best) {
    const seen = new Set();
    const specs = (lines || [])
        .map(l => l && (l.move || (l.pv && l.pv[0])))
        .filter(mv => mv && !seen.has(mv) && seen.add(mv))
        .slice(0, effective_multipv())
        .map((mv, i) => ({move: mv, color: line_color(i), width: i === 0 ? 0.22 : 0.14}));
    return specs.length ? specs : (best ? [{move: best, color: line_color(0), width: 0.22}] : []);
}

// The list under the board, coloured to match the arrows so it reads as their legend -- the same
// thing render_alt_lines does for 8x8. Separate because there is no chess.js for a 14x14 board and
// therefore no SAN: four-player moves are shown as the coordinates the rest of this lane uses.
// `flip` normalises the score to YOUR team, exactly as the readout does, so a line does not read
// +3 and -3 on alternate plies.
function render_alt_lines_4pc(lines, flip) {
    const panel = PANEL_ROOT.getElementById('alt-lines');
    if (!panel) return;
    if (effective_multipv() <= 1 || !lines || lines.length < 2) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }
    panel.style.display = '';
    const rows = [];
    for (let i = 0; i < Math.min(lines.length, effective_multipv()); i++) {
        const line = lines[i];
        if (!line) continue;
        const moves = line.pv && line.pv.length ? line.pv : (line.move ? [line.move] : []);
        if (!moves.length) continue;
        const evalTxt = ('mate' in line) ? `#${flip * line.mate}`
                                         : (flip * (line.score || 0) / 100).toFixed(2);
        const head = moves[0];
        const cont = moves.slice(1, 7).join(' ');
        rows.push(`<div class="alt-line"><span class="alt-eval" style="color:${line_color(i)}">${evalTxt}</span> ` +
            `<span class="alt-moves">${head}</span>` +
            (cont ? ` <span class="alt-cont">${cont}</span>` : '') + `</div>`);
    }
    panel.innerHTML = rows.join('');
}

// The eval bar in 4PC. Two teams, not two colours: R+Y against B+G (RULES.md 2), so the bar is Team
// Red against Team Blue and YOUR team always grows from the bottom -- the same "bottom belongs to
// you" convention the two-player bar uses for board orientation.
//
// The normal update_eval_bar cannot be reused: it reads `turn` and board.orientation(), both of which
// are two-player state this lane never sets, and its share is white-relative. This takes the score
// already normalised to your team, so positive is always your side.
const FOURPC_SEAT_NAME = {R: 'Red', B: 'Blue', Y: 'Yellow', G: 'Green'};
const FOURPC_TEAM_COLOR = ['#c33c3c', '#3f72c4'];   // team Red (R+Y), team Blue (B+G)
function update_eval_bar_4pc(line, flip, ourSeat) {
    const wrap = PANEL_ROOT.getElementById('eval-bar');
    const fill = PANEL_ROOT.getElementById('eval-bar-white');
    if (!wrap || !fill || !line) return;
    // The host falls back to a bare {move, pv} when a search returns no `info` line at all. Without
    // this, `score` is undefined, the exp() below is NaN, and `height: NaN%` silently freezes the bar
    // wherever it happened to be -- which reads as "the eval bar does not move".
    if (!('mate' in line) && !Number.isFinite(line.score)) return;
    const ourTeam = (ourSeat === 'R' || ourSeat === 'Y') ? 0 : 1;
    let frac;                                       // OUR team's share of the bar
    if ('mate' in line) {
        frac = (flip * line.mate >= 0) ? 1 : 0;
    } else {
        const wc = 2 / (1 + Math.exp(-0.00368 * flip * line.score)) - 1;  // same lichess curve
        frac = Math.max(0.03, Math.min(0.97, 0.5 + wc / 2));
    }
    wrap.style.background = FOURPC_TEAM_COLOR[1 - ourTeam];   // the other team fills the rest
    fill.style.background = FOURPC_TEAM_COLOR[ourTeam];
    fill.style.top = 'auto';                        // your team is ALWAYS the bottom of the bar
    fill.style.bottom = '0';
    fill.style.height = `${frac * 100}%`;
}

// The 8x8 and 14x14 renderers share the single #board host, so swapping is just "whoever renders
// last owns it". Both are synchronous and cheap, so there is nothing to tear down.
function show_4pc_board(fen4, ourSeat) {
    try {
        // The header switch is White-vs-Black. With four seats it is not merely useless but
        // actively wrong -- the panel says "Red to move" directly under a control reading
        // "White to move". Hidden the same way the Elo and Variant rows hide themselves.
        const ts = PANEL_ROOT.getElementById('qs_turn_switch');
        if (ts) ts.style.display = 'none';
        if (!board4pc) board4pc = MephistoBoard4PC('board', {root: PANEL_ROOT});
        board4pc.orientation((ourSeat || 'r').toLowerCase());   // you are always at the bottom
        board4pc.position(fen4);
    } catch (e) { /* host not built yet; the next position paints it */ }
}

function hide_4pc_board() {
    if (!board4pc) return;
    board4pc = null;
    const ts = PANEL_ROOT.getElementById('qs_turn_switch');
    if (ts) ts.style.display = '';
    request_clear_hint();          // 4PC arrows must not survive onto an 8x8 board
    try { board.position(board.position()); } catch (e) { /* 8x8 board not built yet */ }
}

function fourpc_drain() {
    const next = fourpc_pending;
    fourpc_pending = null;
    if (next) on_new_pos_4pc(next);
}

function on_new_pos_4pc(payload) {
    clear_idle_reason();   // as above -- the board moved, so the last reason is stale

    // `<seat>:<mode>:<fen4>` -- the mode decides the promotion rank AND whether Tetrarch can search
    // this game at all, so it travels with the position rather than being assumed.
    const i = payload.indexOf(':');
    const j = payload.indexOf(':', i + 1);
    const ourSeat = payload.slice(0, i);
    const mode = payload.slice(i + 1, j);
    const fen4 = payload.slice(j + 1);
    if (!fen4) return;
    // A position arriving mid-search used to be DROPPED, and `fourpc_last` had already been set to
    // the in-flight one -- so once the board settled on a position we skipped, nothing re-triggered
    // it and the panel sat there until the page was reloaded. Hold the newest instead and pick it up
    // when the current search returns. (Tetrarch is single-threaded and ignores `stop`, so the search
    // in flight genuinely cannot be cancelled -- queueing is the only correct answer.)
    // PAINT FIRST, ahead of both early returns. The dedupe below exists to avoid re-SEARCHING an
    // unchanged position, not to avoid redrawing it -- and anything that repaints the shared host
    // behind our back (a panel rebuild on the engine auto-switch, most obviously) leaves the 8x8
    // board showing with no way back, because the position it would need to react to is already the
    // one in `fourpc_last`. Rendering is synchronous and cheap; there is no reason to gate it.
    show_4pc_board(fen4, ourSeat);
    if (fourpc_busy) { fourpc_pending = payload; return; }
    if (fen4 === fourpc_last) return;
    fourpc_last = fen4;
    const turn = fen4[0];
    const ours = (turn === ourSeat);
    const seatName = FOURPC_SEAT_NAME[turn] || turn;
    // SCORE PERSPECTIVE, hoisted: in Teams, Tetrarch reports from the side-to-move's TEAM
    // (PROTOCOL.md) and the seat rotates every ply, so the raw number flips sign each move and the
    // same evaluation reads as +3.06 then -3.06. Normalised to YOUR team it means one thing all
    // game. Standard pairing is R+Y against B+G (RULES.md 2). Needed BEFORE the search so the
    // streamed info can use it too.
    // FFA IS NOT ZERO-SUM: the paranoid search (Tetrarch v8) scores every node in the ROOT seat's
    // own terms -- me against the other three -- and there is no negation that turns one seat's
    // outlook into another's. The score is shown as the mover's own, unflipped; the readout already
    // names whose turn it is.
    const team = (seat) => (seat === 'R' || seat === 'Y') ? 0 : 1;
    const flip = (mode !== 'ffa' && ourSeat !== '?' && team(turn) !== team(ourSeat)) ? -1 : 1;
    set_detection_status(i18n('panel.fourpc_detected', '4-player chess - {seat} to move',
        {seat: FOURPC_SEAT_NAME[turn] || turn}));
    if (!is_fourpc_engine()) {
        update_best_move(i18n('panel.fourpc_needs_engine',
            'Select the Tetrarch engine to analyse 4-player chess (Teams mode only)'));
        return;
    }
    fourpc_busy = true;
    // Mode is the one option that changes the RULES (promotion is the 8th rank in FFA, the 11th in
    // Teams), so it is pushed before the first search. Setup is deliberately NOT sent: every position
    // arrives as a full FEN4, which makes all five starting setups the same code path.
    // FFA SEARCHES TOO since Tetrarch v8: a paranoid formulation (root seat maximised, the other
    // three minimised) with its own net, selected by the engine's bundle the moment Mode is set.
    // MultiPV alongside it. Tetrarch declares MultiPV (spin 1-64) and emits one `info ... multipv N`
    // per line; the host already keys them by rank and returns them in order, so the whole feature
    // was one option away. Mode and Setup reset the board when they change and MultiPV does not, and
    // the host skips values that have not changed, so sending them together is safe.
    request_remote_configure({Mode: mode || 'teams', MultiPV: effective_multipv()}).catch(() => {});
    toggle_calculating(true);
    native_send('analyse', {fen4, time: Math.max(200, config.compute_time || 1000)}, (info) => {
        // The host emits one frame per depth exactly like the two-player hosts, and the panel has
        // always had the rows for them -- 4PC simply never asked. Same NPS box, same score line.
        if (!info || fen4 !== fourpc_last) return;
        const npsEl = PANEL_ROOT.getElementById('nps');
        if (npsEl && Number.isFinite(info.nps) && info.nps > 0) npsEl.textContent = format_nps(info.nps);
        if ('mate' in info) {
            update_evaluation(i18n('panel.msg.mate_in', 'Checkmate in {n}', {n: flip * info.mate}));
        } else if (Number.isFinite(info.score) && Number.isFinite(info.depth)) {
            update_evaluation(i18n('panel.msg.score_at_depth', 'Score: {score} at depth {depth}',
                {score: (flip * info.score / 100).toFixed(2), depth: info.depth}));
        }
        if (info.move) {
            update_best_move(i18n('panel.msg.fourpc_to_play', '{seat} to play, best move is {move}',
                {seat: seatName, move: info.move}));
        }
    })
        .then((res) => {
            fourpc_busy = false;
            fourpc_drain();
            if (fen4 !== fourpc_last) return;          // the board moved on while we searched
            const best = res && res.bestmove;
            // `0000` is UCI's null move -- Tetrarch returns it when the position has no move to make
            // (game over). It is not a move to play, and passing it on got it as far as the clicker.
            if (!best || best === '(none)' || best === '0000') {
                update_best_move(i18n('panel.no_move', 'No move'));
                return;
            }
            const line = res.lines && res.lines[0];
            // SCORE PERSPECTIVE. Tetrarch reports from the side-to-move's TEAM (PROTOCOL.md), and the
            // seat to move rotates every ply -- so the raw number flips sign each move and the same
            // evaluation reads as +3.06 then -3.06. Normalise to YOUR team so it means one thing all
            // game: positive is good for you. Standard pairing is R+Y against B+G (RULES.md 2).
            toggle_calculating(false);
            update_best_move(i18n('panel.msg.fourpc_to_play', '{seat} to play, best move is {move}',
                {seat: seatName, move: best}));
            if (line && 'mate' in line) {
                update_evaluation(i18n('panel.msg.mate_in', 'Checkmate in {n}', {n: flip * line.mate}));
            } else if (line && Number.isFinite(line.score)) {
                update_evaluation(i18n('panel.msg.score_at_depth', 'Score: {score} at depth {depth}',
                    {score: (flip * line.score / 100).toFixed(2), depth: line.depth ?? 0}));
            }
            // NOT gated on config.eval_bar: that toggle governs the PAGE overlay, and the
            // normal path calls update_eval_bar unconditionally. Gating this one meant the
            // panel strip kept its default white/black instead of the two team colours.
            if (line) update_eval_bar_4pc(line, flip, ourSeat);
            // Help Mode draws the move instead of playing it, exactly as on an 8x8 board. The
            // renderer understands 14x14 now, so this is just a matter of asking for it.
            // One arrow per line, thickest and most saturated for the best -- the same convention
            // and the same palette the 8x8 board uses, so a four-player board reads the same way.
            // Deduped on the move: Tetrarch can return the same first move in two lines when they
            // transpose, and two arrows on one square is just a darker arrow.
            //
            // Built ONCE and used three times: the page board, the panel's own 14x14 board, and the
            // eval list under it. They were three different amounts of information about the same
            // search, which is what "the mini board does not show them" was.
            const arrows = fourpc_arrow_specs(res.lines, best);
            try { board4pc?.highlight(arrows); } catch (e) { /* board swapped away mid-search */ }
            render_alt_lines_4pc(res.lines, flip);
            if (config.help_mode) request_draw_hint(arrows);
            else request_clear_hint();
            if (ours && config.autoplay && !config.help_mode) request_automove_4pc(best);
            else if (config.autoplay) {
                // "Autoplay does nothing in four-player chess" has been reported more than once, and
                // all three gates above are silent -- a skipped move looks exactly like a move that
                // was never searched. Name the gate that stopped it instead of guessing again.
                // `ourSeat` is '?' whenever the seat could not be read off the page, which makes
                // `ours` false for every position and autoplay dead for the whole game.
                request_console_log(`4PC autoplay skipped: yourSeat=${ourSeat} turnSeat=${turn} ` +
                    `yourTurn=${ours} helpMode=${!!config.help_mode}`);
            }
        })
        .catch((e) => {
            fourpc_busy = false;
            fourpc_drain();
            // Tetrarch is the ONE engine with nothing bundled behind it -- every other entry in the
            // dropdown either ships as WASM or degrades to one. So "host not found" here almost
            // always means it was never installed, and "Engine error" sent people looking for a bug
            // instead of the installer. Say what to do.
            update_best_move(native_host_missing(e)
                ? i18n('panel.tetrarch_setup', 'Tetrarch is not installed yet - see the README section '
                       + '"Four-player chess" for macOS, Linux and Windows setup')
                : i18n('panel.engine_error', 'Engine error'));
            console.warn('Mephisto: 4PC analyse failed', e);
        });
}

// Did this failure mean "the native host is not installed"? The worker phrases a missing host as
// "<label> native host unavailable (Specified native messaging host ... not found.)", and a port that
// dies before the first reply comes through as a closed port. Neither is distinguishable from a
// crashed host, which is fine: both answers are "run the installer".
function native_host_missing(e) {
    return /not found|unavailable|port closed|no such file/i.test(String((e && e.message) || e || ''));
}

// PUZZLE MODE PACING, and the rule that matters most: DO NOT MOVE TWICE INTO THE SAME POSITION.
//
// After our move the puzzle scripts the opponent's reply, and until that reply lands the board still
// shows the position we just moved from. A second move issued into it answers a question already
// answered -- on a graded puzzle that is a wrong answer, not a no-op. So the board CHANGING is the
// proof that the opponent moved, and it is the only proof accepted here. No time window: a timeout
// would just make the mistake take longer to arrive.
//
// Two independent flags, because they mean different things and conflating them broke this once:
//   paused  -- this call has already waited out the pre-move pause (the database path had its own)
//   checked -- this call has already passed the guard; the delayed continuation must not re-run it
//              and find the record it wrote itself.
// `retry` is the one legitimate repeat: watch_puzzle_move re-issues into an unchanged board because
// the puzzle click path is unverified and the first click may simply have missed.
let puzzle_last_sent = {key: null, at: 0};

function request_automove(move, think = null, manual = false, opts = {}) {
    if (config.puzzle_mode && !manual) {
        if (!opts.checked) {
            const key = puzzle_key(last_eval.fen || '');
            if (key && key === puzzle_last_sent.key && !opts.retry) {
                console.log('Puzzle: already moved from this position -- waiting for the reply');
                return;
            }
            puzzle_last_sent = {key, at: Date.now()};
        }
        if (!opts.paused) {
            clearTimeout(puzzle_move_timer);
            puzzle_move_timer = setTimeout(
                () => request_automove(move, think, manual, {...opts, paused: true, checked: true}),
                puzzle_move_delay_ms());
            return;
        }
    }
    bgTrace('request_automove', {move, think, puzzle: config.puzzle_mode});
    // Is this a REAL move on our own turn, or a BLIND premove during the opponent's turn? The site
    // queues a blind premove (it won't appear in the move list until they move), so it must NOT be
    // verified/retried; an on-turn move must be. The popup is authoritative here -- decide from the
    // position's side-to-move (== our colour) rather than letting the content-script re-derive the
    // turn from fragile DOM highlights (which throws on e.g. the lichess analysis board, silently
    // skipping verification). last_eval.fen is the current position (on_new_pos ran before this).
    const our = (our_side() === 'white') ? 'w' : 'b';
    const verify = (last_eval.fen?.split(' ')[1] === our);
    const deselect = safe_deselect_square(last_eval.fen, move);
    // Read the think/move timing FRESH from storage on every move (the options page shares this
    // localStorage), so editing the sliders mid-game applies to the next move -- not the snapshot
    // taken when the panel/config first loaded. `?? config.x` keeps the loaded value if unset.
    const timing = fresh_timing(move_situation(last_eval.fen, move));
    // Session stats count the move HERE, at the one funnel every move of ours goes through, and
    // count the delay it really waited: the pacing modes' explicit think when there was one, the
    // configured think when there was not.
    //
    // ON-TURN MOVES ONLY (`verify`). A blind premove is queued during the OPPONENT's turn and fires
    // the instant they move, so the think attached to it is not a wait anybody had -- counting it
    // would drag the session average toward a number no move ever took.
    if (verify) session_note_move((think != null) ? think : timing.think_time);
    const message = (config.puzzle_mode)
        // Puzzle Mode ships the move as a one-element `pv` purely because the content-script's
        // puzzle branch takes that shape. It is ONE move: Puzzle Mode used to auto-play the engine's
        // whole line without going back to the engine, and every move after the first was the tail of
        // a single short search -- unsearched moves that threw away won puzzles. Every move it plays
        // is now a move it actually searched.
        // `forPush` is the scrape this move was computed from. The content script refuses to click
        // when the live board no longer matches it -- the check it already made, but against the
        // right reference: its own last push can have moved on to a position this panel never
        // accepted, which is how a stale answer reached a live board.
        ? {automove: true, pv: [move], deselect, verify, timing, manual, forPush: analysed_push_key}
        : {automove: true, move: move, deselect, verify, think, timing, manual, forPush: analysed_push_key};
    send_to_active_tab(message);
}

// Queue two forced premoves back-to-back in ONE click session. Both are blind (opponent to move), so
// verify=false; they must ship in a single message because the content-script's `moving` guard drops a
// second automove that arrives while the first is still clicking.
function request_double_premove(moves) {
    send_to_active_tab({automove: true, premoves: moves, deselect: null, verify: false,
        timing: fresh_timing(), manual: false});
}

function request_console_log(message) {
    send_to_active_tab({consoleMessage: message});
}

function request_draw_hint(arrows, region) {
    send_to_active_tab({drawHint: true, arrows: arrows, region: region || null});
}

function request_clear_hint() {
    send_to_active_tab({clearHint: true});
}

// One white-share value per ply of the current game, for the history strip beside the eval bar.
// Indexed by ply so the constant re-analysis of a single position overwrites its own slot instead of
// appending -- without that the strip would grow by a band per engine info line.
let eval_history = [];
let eval_history_game = null; // the startFen this history belongs to; a new game resets it

// --- Game phases (lichess's Divider, ported) ----------------------------------------------------
// Opening / middlegame / endgame boundaries for the eval graph, computed exactly the way lichess
// does it so the dividers land where a lichess user expects. Ported from scalachess Divider.scala:
//
//   midgame = first position where  majorsAndMinors <= 10  OR  backrankSparse  OR  mixedness > 150
//   endgame = first position where  majorsAndMinors <= 6   (only looked for once a midgame exists)
//   the midgame marker is dropped if it does not actually precede the endgame one
//
// `mixedness` sums a positional score over the 49 overlapping 2x2 regions of the board (a 7x7 grid
// of them). Worth stating because the obvious reading is 3x3: the source builds them from the
// bitboard constant 0x0303, which is a 2x2 block, and the score table below bottoms out at 4 pieces
// per region -- which only makes sense for 4 squares.
const PHASE_MIXEDNESS_THRESHOLD = 150;
const PHASE_MIDGAME_PIECES = 10;
const PHASE_ENDGAME_PIECES = 6;

// score(y, white, black) verbatim from Divider.scala. y is the region's rank index, 1..7.
function phase_region_score(y, white, black) {
    switch (white) {
        case 0: switch (black) {
            case 1: return 1 + y;
            case 2: return y < 6 ? 2 + (6 - y) : 0;
            case 3: return y < 7 ? 3 + (7 - y) : 0;
            case 4: return y < 7 ? 3 + (7 - y) : 0;
            default: return 0;
        }
        case 1: switch (black) {
            case 0: return 1 + (8 - y);
            case 1: return 5 + Math.abs(4 - y);
            case 2: return 4 + (7 - y);
            case 3: return 5 + (7 - y);
            default: return 0;
        }
        case 2: switch (black) {
            case 0: return y > 2 ? 2 + (y - 2) : 0;
            case 1: return 4 + (y - 1);
            case 2: return 7;
            default: return 0;
        }
        case 3: switch (black) {
            case 0: return y > 1 ? 3 + (y - 1) : 0;
            case 1: return 5 + (y - 1);
            default: return 0;
        }
        case 4: return black === 0 ? (y > 1 ? 3 + (y - 1) : 0) : 0;
        default: return 0;
    }
}

const SQ_FILES = 'abcdefgh';

// one snapshot's three inputs, read off a chess.js position
function phase_metrics(c) {
    let majorsMinors = 0, whiteFirstRank = 0, blackLastRank = 0;
    const grid = []; // [file][rank] -> 'w' | 'b' | null, so the region scan is cheap
    for (let f = 0; f < 8; f++) {
        grid[f] = [];
        for (let r = 0; r < 8; r++) {
            const p = c.get(SQ_FILES[f] + (r + 1));
            grid[f][r] = p ? p.color : null;
            if (!p) continue;
            if (p.type !== 'k' && p.type !== 'p') majorsMinors++;
            if (r === 0 && p.color === 'w') whiteFirstRank++;
            if (r === 7 && p.color === 'b') blackLastRank++;
        }
    }
    let mixedness = 0;
    for (let ry = 0; ry <= 6; ry++) {
        for (let rx = 0; rx <= 6; rx++) {
            let w = 0, b = 0;
            for (let dx = 0; dx < 2; dx++) {
                for (let dy = 0; dy < 2; dy++) {
                    const col = grid[rx + dx][ry + dy];
                    if (col === 'w') w++; else if (col === 'b') b++;
                }
            }
            mixedness += phase_region_score(ry + 1, w, b);
        }
    }
    return {majorsMinors, backrankSparse: whiteFirstRank < 4 || blackLastRank < 4, mixedness};
}

let phase_cache = {key: null, value: {mid: null, end: null}};

// {mid, end} as ply indices into the eval history, either possibly null.
function game_phases(startFen, movesStr) {
    const key = `${startFen}|${movesStr}`;
    if (phase_cache.key === key) return phase_cache.value;
    const out = {mid: null, end: null};
    try {
        const c = new Chess(config.variant, startFen || undefined);
        const moves = (movesStr || '').trim().split(/\s+/).filter(Boolean);
        for (let i = 0; i <= moves.length; i++) {
            if (i > 0) {
                const m = moves[i - 1];
                c.move({from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4]});
            }
            const {majorsMinors, backrankSparse, mixedness} = phase_metrics(c);
            if (out.mid === null
                && (majorsMinors <= PHASE_MIDGAME_PIECES || backrankSparse
                    || mixedness > PHASE_MIXEDNESS_THRESHOLD)) {
                out.mid = i;
            }
            // lichess only starts looking for the endgame once a midgame was found
            if (out.mid !== null && out.end === null && majorsMinors <= PHASE_ENDGAME_PIECES) {
                out.end = i;
            }
        }
        // a midgame marker that doesn't precede the endgame one is dropped, as in Divider.apply
        if (out.mid !== null && out.end !== null && !(out.mid < out.end)) out.mid = null;
    } catch (e) {
        return {mid: null, end: null}; // variant fen chess.js can't replay -- no dividers, no error
    }
    phase_cache = {key, value: out};
    return out;
}

function record_eval_history(frac) {
    // Recorded for EITHER reader. Live Stats derives its accuracy from this same array, so gating
    // the recording on the graph's own toggle left the strip with nothing to read and looking broken.
    // One number per ply either way -- there is nothing to save by not recording it.
    // EVERY READER, not two of them. Move Classification and the Opponent Mistake Alert grade from
    // this same array, so with the graph and the strip both off nothing was ever recorded and
    // nothing was ever graded -- the badge simply never appeared, on any move, with its own toggle
    // on. (The comment below already records this mistake being made once, for the strip.)
    // `session_stats` is in this gate for the reason the comment above records happening twice
    // already: its accuracy is derived from THIS array, so with only that switch on nothing was ever
    // recorded and the session line simply never grew an accuracy -- a feature that looks broken
    // with its own toggle on. It is not in classifier_wanted() on purpose: the accuracy comes from
    // the eval history alone, and the classifier is a much heavier thing to start for it.
    if ((!config.eval_history && !config.session_stats && !classifier_wanted())
        || typeof frac !== 'number') return;
    // premove_tracker is the one place the CURRENT position's startFen + move list are kept
    // (on_new_pos sets it unconditionally, whether or not Premove is on). last_eval carries neither.
    const startFen = premove_tracker.startFen || '';
    if (eval_history_game !== startFen) { eval_history_game = startFen; eval_history = []; }
    const moves = premove_tracker.moves || '';
    const ply = moves ? moves.trim().split(/\s+/).filter(Boolean).length : 0;
    if (ply > 512) return;                        // absurd move list -- don't grow without bound
    // Gaps are filled with a COPY of the last value so the graph stays a curve -- but a copy is not
    // a measurement, and grading a move against one invents a swing that never happened (seen live:
    // the move that WON a queen was charged as a blunder, because the ply before it was a filler).
    // eval_seen marks which plies were actually evaluated; only those get graded.
    while (eval_history.length < ply) {
        eval_seen[eval_history.length] = false;
        eval_history.push(eval_history[eval_history.length - 1] ?? 0.5);
    }
    eval_history[ply] = frac;
    eval_seen[ply] = true;
    if (eval_history.length > ply + 1) eval_history.length = ply + 1; // a takeback truncates
    if (eval_seen.length > ply + 1) eval_seen.length = ply + 1;
    // ...and what the ENGINE saw here, which is what makes the move that leaves this position
    // classifiable: its rank among the lines, and how much better it was than the second choice.
    if (last_eval.fen && Array.isArray(last_eval.lines)) {
        const lines = last_eval.lines
            .filter(l => l && l.move && (typeof l.score === 'number' || typeof l.mate === 'number'))
            .map(l => ({move: l.move,
                        score: typeof l.score === 'number' ? l.score : (l.mate > 0 ? 100000 : -100000),
                        mate: typeof l.mate === 'number' ? l.mate : undefined}));
        // KEEP THE FULLEST SNAPSHOT, never the newest. The engine rebuilds its line array at the top
        // of every depth iteration with pv 1 alone, so a snapshot taken at that instant shows ONE
        // line -- and one line is exactly how a forced position looks. Taken naively, every move of
        // a normal game graded as Forced (seen live, the whole strip read "4="). The count for a
        // position only ever grows, so keeping the maximum is both correct and self-healing.
        const prev = ply_facts[ply];
        const fresh = !prev || prev.fen !== last_eval.fen;
        const fuller = fresh || lines.length >= prev.lines.length;
        const depth = Number(last_eval.lines?.[0]?.depth) || 0;
        // THE FIRST FRAME PAST THE FLOOR, kept for good. Grading compares two positions, and live
        // each one is searched for however long it happens to get -- one gets 12 plies, the next 26
        // because you sat on it. Comparing those two charges the mover for the ENGINE changing its
        // mind, so the pair used to be refused instead (see CLASSIFY_DEPTH_SLACK), which is why a
        // move went ungraded on a board with every switch on. Both positions now have a reading
        // taken at the same shallow depth, so the pair is comparable whatever happened afterwards.
        const ref = (!fresh && prev.ref) ? prev.ref
                  : (depth >= CLASSIFY_MIN_DEPTH ? {frac, depth} : null);
        // AND THE TABLEBASE'S VERDICT, when this position had one. It is what makes a proved
        // conversion gradeable at all: the engine's centipawns say a rook was thrown away, the
        // tablebase says the win was held, and only one of those is a fact.
        const tb = (tablebase_data && tablebase_data.fen === last_eval.fen) ? tablebase_data.category : null;
        if (lines.length && fuller) ply_facts[ply] = {fen: last_eval.fen, turn, lines, depth, ref, tb};
    }
    if (ply_facts.length > ply + 1) ply_facts.length = ply + 1;
}

// EVERY MOVE OF THIS GAME, GRADED, by the same rules the Game Review uses -- one classifier, in
// src/scripts/classify-core.js, so a move the strip calls a Mistake cannot come back an Excellent
// in the report afterwards. What the panel already had: the win% of every position (eval_history)
// and the engine's lines for each (ply_facts). What it needed: the board itself, replayed once,
// for the two facts a score cannot carry -- whether the move was forced, and whether it gave up
// material to be Brilliant.
//
// Book is deliberately always false here: the review knows it from the bundled opening table,
// which the panel does not load (it is a page-weight cost on every chess page for a label). A
// book move therefore reads as what it also is -- Best, or Excellent.
let eval_seen = [];      // per ply: was this position actually evaluated, or is it filler?
let ply_facts = [];      // per ply: the position and the engine's lines AS PLAYED FROM
let last_logged_class = [];   // so the trace prints a verdict once, not once per frame
// A verdict is only as good as the two searches behind it. 10 plies is the floor the opponent
// alert already trusts; 4 plies of slack lets a normal live game grade while refusing the pairs
// that differ enough for the engine to have changed its mind.
const CLASSIFY_MIN_DEPTH = 10, CLASSIFY_DEPTH_SLACK = 4;
let move_classes = [];   // per ply: the class of the move played there
let move_class_key = '';

// The classifier is not shipped on every page (7.6KB for three opt-in features). Ask the worker to
// inject it the first time something needs it; until it lands, grading simply produces nothing,
// which is exactly how these features behave before the first evaluation anyway.
let classifier_asked = false;
function classifier_wanted() {
    // `refute` grades your last move to decide whether to draw its punishment, and `game_log`
    // writes the eval of every ply into the exported PGN -- both read the same recorded history
    // that this gate controls. Left out, each looked broken with its own switch on: nothing was
    // ever recorded, so nothing was ever graded and every eval comment came out empty.
    return !!(config.live_stats || config.live_classify || config.class_on_board || config.opp_alert
              || config.refute || config.game_log);
}
function ensure_classifier() {
    if (self.MephistoClassify || classifier_asked || !classifier_wanted()) return;
    classifier_asked = true;
    try {
        chrome.runtime.sendMessage({needClassifier: true}, (res) => {
            if (!res || !res.ok) classifier_asked = false;   // worker asleep or refused: retry later
        });
    } catch (e) { classifier_asked = false; }
}

// The five tablebase verdicts, as a scale, so two of them can be compared. A child position is
// scored for the side to move THERE, which is the opponent -- so it is negated to read it from the
// mover's side, exactly as the tablebase's own move ordering does.
const TB_RESULT_VALUE = {win: 2, 'cursed-win': 1, draw: 0, 'blessed-loss': -1, loss: -2};
// The verdicts a proved result is allowed to overrule. `book` and `forced` are facts of their own,
// and the good grades need no help.
const TB_OVERRIDABLE = new Set(['inaccuracy', 'mistake', 'blunder']);

function tb_held_the_result(before, after) {
    if (!(before in TB_RESULT_VALUE) || !(after in TB_RESULT_VALUE)) return false;
    return -TB_RESULT_VALUE[after] >= TB_RESULT_VALUE[before];
}

function classify_history() {
    const C = self.MephistoClassify;
    if (!C) { ensure_classifier(); return []; }
    const startFen = premove_tracker.startFen || '';
    const moves = (premove_tracker.moves || '').trim().split(/\s+/).filter(Boolean);
    const key = `${startFen}|${moves.join(' ')}|${eval_history.length}|${ply_facts.length}`
        + `|${eval_seen.filter(Boolean).length}|${ply_facts.filter(f => f && f.ref).length}`;
    if (key === move_class_key) return move_classes;
    move_class_key = key;
    move_classes = [];
    try {
        const board = new Chess(config.variant || 'chess', startFen || undefined);
        for (let i = 0; i < moves.length; i++) {
            const uci = moves[i];
            const fen = board.fen();
            const white = (i % 2) === 0;
            // win% is stored white-relative; every input below is from the MOVER's side, exactly
            // as the review computes it -- get this backwards and every black move is a blunder
            const wpAt = (ply) => {
                const f = ply_facts[ply]?.ref ? ply_facts[ply].ref.frac : eval_history[ply];
                if (typeof f !== 'number' || (!ply_facts[ply]?.ref && eval_seen[ply] === false)) return null;
                return (white ? f : 1 - f) * 100;
            };
            const winBefore = wpAt(i), winAfter = wpAt(i + 1);
            // TWO EVALS ARE ONLY COMPARABLE AT COMPARABLE DEPTH. Live, each position is searched
            // for as long as it happens to get; a shallow "before" against a deep "after" charges
            // the mover for the ENGINE changing its mind (seen in the trace: the engine's own top
            // move came back a blunder, 70.5 -> 29.5). The review never hits this because it
            // searches every position to the same budget. Ungraded beats wrongly graded.
            // Reference depths where both plies have one -- they are first-crossings of the same
            // floor, so they sit within a ply or two of each other by construction, and the pair is
            // comparable however deep either search ran on afterwards. Falls back to the final
            // depths (and the old slack) for a position recorded before the reference existed.
            const dBefore = ply_facts[i]?.ref?.depth || ply_facts[i]?.depth || 0;
            const dAfter = ply_facts[i + 1]?.ref?.depth || ply_facts[i + 1]?.depth || 0;
            const comparable = dBefore >= CLASSIFY_MIN_DEPTH && dAfter >= CLASSIFY_MIN_DEPTH
                && Math.abs(dBefore - dAfter) <= CLASSIFY_DEPTH_SLACK;
            const facts = ply_facts[i];
            let rank = null, secondWin = null;
            if (facts && facts.fen === fen) {
                const sign = white ? 1 : -1;
                const at = facts.lines.findIndex(l => l.move === uci);
                rank = at >= 0 ? at + 1 : null;
                secondWin = facts.lines.length > 1 ? C.winPercent(facts.lines[1].score * sign) : null;
            }
            // FORCED IS A FACT ABOUT THE BOARD, not about how many lines the engine happened to
            // have sent. The review infers it from the line count because it never replays the
            // game; the panel is replaying anyway, so it can just count the legal moves -- and
            // must, because the panel's line array routinely holds one line mid-iteration, which
            // graded an entire normal game as Forced (seen live: the strip read "4=").
            const onlyMove = board.moves().length === 1;
            // the sacrifice replay is the expensive part: only ask where the answer could matter
            const sacrifice = (winBefore != null && winAfter != null && !onlyMove
                               && winAfter >= 50 && winBefore < 90 && Math.max(0, winBefore - winAfter) < 2)
                ? C.sacrificesMaterial(Chess, config.variant || 'chess', fen, uci) : false;
            move_classes[i] = (winBefore == null || winAfter == null || !comparable) ? null
                : C.classify({winBefore, winAfter, rank, onlyMove, isBook: false, secondWin, sacrifice});
            // A SOLVED POSITION IS NOT A MATTER OF OPINION. At seven men or fewer the tablebase
            // knows the result, and a move that holds it cannot be a mistake however the engine's
            // number moved -- the conversion that wins a K+P ending by giving up a rook reads as a
            // -900 blunder and is the only move that wins. Reported from a real game: Rxg5+, the
            // tablebase's own first choice, graded a blunder.
            //
            // It only ever REMOVES a negative verdict. Grading a move badly because the tablebase
            // says the result got worse would need the same care about depth and comparability that
            // the rest of this function spends, and it is not what went wrong.
            if (move_classes[i] && tb_held_the_result(ply_facts[i]?.tb, ply_facts[i + 1]?.tb)
                && TB_OVERRIDABLE.has(move_classes[i])) {
                console.log(`Classify: ${Math.floor(i / 2) + 1}${white ? '.' : '...'} ${uci} was `
                    + `${move_classes[i]} by the engine's number, but the tablebase says the result `
                    + `held (${ply_facts[i].tb} -> ${ply_facts[i + 1].tb}) -- grading it best`);
                move_classes[i] = 'best';
            }
            // One line per verdict, with the numbers behind it -- the same courtesy the tablebase and
            // the book get. A verdict nobody can check is a verdict nobody can report a fault in.
            if (move_classes[i] && move_classes[i] !== last_logged_class[i]) {
                last_logged_class[i] = move_classes[i];
                console.log(`Classify: ${Math.floor(i / 2) + 1}${white ? '.' : '...'} ${uci} = `
                    + `${move_classes[i]} (win% ${winBefore.toFixed(1)} -> ${winAfter.toFixed(1)}`
                    + `${rank ? `, rank ${rank}` : ''}${onlyMove ? ', forced' : ''}${sacrifice ? ', sacrifice' : ''})`);
            }
            const mv = board.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
            if (!mv) break;   // the move list and the start position disagree: grade no further
        }
    } catch (e) {
        // a variant chess.js cannot replay just means no classes this game, never a broken panel
    }
    return move_classes;
}

// The panel's look-and-place lives in the page, with the geometry, because it is per site. These
// two are the whole channel: a direct call in the isolated world the panel already shares with the
// content script (see send_to_active_tab for why that is a call and not a message).
function read_panel_style() {
    if (!IS_CONTENT_SCRIPT) return null;
    try { return self.MephistoContent?.handle({panelStyleRead: true}) || null; } catch (e) { return null; }
}
function send_panel_style(style) {
    send_to_active_tab({panelStyle: style});
}

function request_draw_eval_bar(data) {
    send_to_active_tab({drawEvalBar: true, ...data});
}

function request_clear_eval_bar() {
    send_to_active_tab({clearEvalBar: true});
}

// Board turn badge: driven by the panel's authoritative side-to-move (the parsed FEN's turn field),
// NOT the raw scrape -- so it shows the same side the engine is actually analysing. Always on while
// a position is detected (no config gate); cleared when detection is lost or the panel closes.
function update_turn_badge(fen) {
    const t = (typeof fen === 'string') ? fen.split(' ')[1] : null;
    if (t === 'w' || t === 'b') set_turn_switch(t); // header king switch (the on-board pill was removed)
}

// Reflect the current side to move on the header king-switch (thumb left = White, right = Black).
function set_turn_switch(turn) {
    const el = PANEL_ROOT.getElementById('qs_turn_switch');
    if (!el) return;
    const black = turn === 'b';
    el.classList.toggle('black', black);
    const thumb = el.querySelector('.turn-thumb');
    if (thumb) thumb.innerHTML = black ? '&#9818;' : '&#9812;'; // ♚ / ♔
    const side = PANEL_ROOT.getElementById('qs_turn_side');
    if (side) {
        side.textContent = black
            ? i18n('panel.black_to_move', 'Black to move')
            : i18n('panel.white_to_move', 'White to move');
    }
}


// ask the content-script to read the variant off the current game page; cb(variant | null)
function request_detect_variant(cb) {
    if (IS_CONTENT_SCRIPT) { // same realm -> ask content-script.js straight out
        try {
            const r = self.MephistoContent?.detectVariant();
            return cb((r && r.variant) || null, (r && r.href) || null);
        } catch (e) { return cb(null, null); }
    }
    const ask = tabId => chrome.tabs.sendMessage(tabId, {detectVariant: true}, resp => {
        if (chrome.runtime.lastError) return cb(null, null);
        cb((resp && resp.variant) || null, (resp && resp.href) || null);
    });
    if (MY_TAB_ID) return ask(MY_TAB_ID);
    chrome.tabs.query({active: true, currentWindow: true}, tabs => (tabs[0] && tabs[0].id) && ask(tabs[0].id));
}

// fairy-only variants -- everything a mainline engine can't play. Chess960 is NOT here (mainline
// Stockfish plays it via UCI_Chess960), so detecting it must not force the Fairy engine.
function needs_fairy_engine(v) {
    return v && v !== 'chess' && v !== 'fischerandom';
}

// Is a native host actually installed? Open a throwaway port to it and `ping` (the host answers that
// WITHOUT launching the engine); any reply means installed, a 'fatal'/disconnect means not. ~1s cap.
function native_host_available(portName) {
    return new Promise(resolve => {
        let done = false, port;
        const finish = (ok) => { if (done) return; done = true; try { port.disconnect(); } catch (e) { /* */ } resolve(ok); };
        try { port = chrome.runtime.connect({name: portName}); } catch (e) { return resolve(false); }
        port.onMessage.addListener(frame => finish(!frame.fatal)); // a non-fatal frame = the host answered
        port.onDisconnect.addListener(() => finish(false));
        try { port.postMessage({id: -1, cmd: 'ping'}); } catch (e) { return finish(false); }
        setTimeout(() => finish(false), 1000);
    });
}

// Which Fairy engine to switch to on variant detect: the LOCAL (native) full-power Fairy whenever its
// host is installed (probed directly, so it's preferred even from a WASM engine), else the bundled
// WASM Fairy so variant detection still works with zero setup.
async function preferred_fairy_engine() {
    return (await native_host_available('fairy-native')) ? 'fairy-native' : 'fairy-stockfish-14-nnue';
}

// apply a detected variant: set it AND switch to the Fairy engine when the variant requires it.
// Without the engine switch, detection was a no-op on a mainline Stockfish -- the variant was saved
// but the engine analysed the board as standard chess.
async function apply_detected_variant(v) {
    MephistoConfig.set('variant', JSON.stringify(v));
    // switch to Fairy only if not already on one (native or WASM) -- don't downgrade native->WASM
    if (needs_fairy_engine(v) && !FAIRY_ENGINES.includes(config.engine)) {
        MephistoConfig.set('engine', JSON.stringify(await preferred_fairy_engine()));
    }
    panel_reload();
}

// Auto-detect the variant on a chess.com / lichess variant GAME page so it just works -- apply the
// detected variant (switching to Fairy when needed) without the user picking engine + variant by
// hand. Runs at most once per game URL (sessionStorage guard) so a manual change afterwards is
// respected and there's no reload loop.
function maybe_autodetect_variant() {
    request_detect_variant((v, href) => {
        if (!v || !href) return;
        // only AUTO-apply where detection is URL-definitive: chess.com /variants/ game pages. The
        // lichess detector is DOM-heuristic and could false-positive on a standard game, so lichess
        // stays on the explicit Detect button (which now switches to Fairy too).
        if (!/\/variants\//.test(href)) return;
        // already correct: right variant AND (no Fairy needed, or already on some Fairy engine).
        // (Which Fairy engine - native vs WASM - is resolved by an async probe inside apply.)
        if (config.variant === v && (!needs_fairy_engine(v) || FAIRY_ENGINES.includes(config.engine))) return;
        const key = 'mephisto.autodetected:' + href;
        try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* */ }
        console.log('Mephisto: auto-detected variant', v, '-> applying (was', config.variant + '/' + config.engine + ')');
        apply_detected_variant(v);
    });
}

// Options-page changes reaching a LIVE panel.
//
// MephistoConfig keeps its own cache fresh via chrome.storage.onChanged, but `config` here is a
// SNAPSHOT taken once at init, and push_config() ships that snapshot to the content script. So a
// setting flipped on the options page updated storage, and nothing else: the panel kept its old
// value and the content script kept being told the old value. Background Play was the visible
// casualty -- you turned it on and moves carried on deferring -- but every options-page setting had
// it, including Endgame Tablebase and Search Time.
//
// Only settings that are safe to change mid-session are applied. Engine, variant, threads and memory
// need a full engine re-init, which is a panel rebuild; those are deliberately left to the existing
// reload path rather than half-applied under a running search.
const LIVE_CONFIG_KEYS = [
    'autoplay', 'premove', 'ponder', 'tablebase', 'background_play', 'hide_opponent',
    'explorer', 'book_play', 'explorer_db', 'help_mode', 'humanize', 'clock_mode', 'mirror_mode',
    'manual_mode', 'eval_bar', 'eval_history', 'live_stats', 'puzzle_mode', 'simon_says_mode', 'threat_analysis',
    'threat_human', 'threat_human_elo',
    'safety_net', 'safety_net_mode', 'safety_net_drop', 'safety_net_max',
    'bot_tricks', 'bot_trick_game', 'bot_trick_delay', 'bot_trick_pgn',
    'computer_evaluation', 'multiple_lines', 'compute_time', 'compute_depth', 'search_mode',
    'live_classify', 'class_on_board', 'live_classify_which', 'playstyle', 'tablebase_show',
    'contempt', 'contempt_cp', 'complexity_clock', 'human_times',
    'player_book', 'player_book_user', 'player_book_wins',
    'auto_resign', 'auto_resign_cp', 'auto_draw', 'auto_draw_cp', 'session_stats',
    // the new panel-side features: all display or pacing decisions the panel makes per move, so a
    // change on the settings page has to reach an open panel rather than waiting for a reopen
    'pv_keys', 'refute', 'refute_plies', 'second_opinion', 'opp_prep', 'game_log',
    'mirror_ratio', 'time_trouble', 'time_trouble_at',
    'maia2_self_elo', 'maia2_oppo_elo',
    'analysis_limit', 'analysis_limit_mode',
    'arrow_opacity', 'arrow_rank', 'arrow_labels', 'board_animation', 'move_notation', 'forced_lines', 'pv_walk', 'pv_walk_limit',
    'premove_confidence', 'premove_plies', 'move_time', 'move_variance', 'move_reason',
    ...ARROW_COLOR_KEYS, // repaint on the next frame, no reload
    'think_time', 'think_variance', 'elo', 'opp_alert', 'dark_mode',
    // toggling the trace has to take effect on the session you are already debugging
    'verbose_log', 'fourpc_mode', 'clock_pace', 'puzzle_delay', 'puzzle_auto_next', 'puzzle_next_delay',
    'drag_moves',
    // not a behaviour key: the listener reads the bindings fresh on every keypress, so the KEY works
    // the moment it is saved. This is so the hints beside the toggles and on the title bar stop
    // advertising the old one while it does.
    'hotkeys',
];

let resync_after_config_change = false;

// AN ENGINE THAT GOES QUIET USED TO BE FOREVER. The drop guard above (pending_stops) waits for a
// bestmove that a stopped search owes -- and its deadline only gets a chance to run when a frame
// ARRIVES, so silence never clears it. Reported from a live game as
// `search active owed=1 last-frame=2238ms go=go infinite`: the panel holding a debt, dropping
// everything, with a search it believed was running and an engine that was not answering. The
// scores and speed on screen are the last ones from before it went quiet, so nothing looks wrong.
// A search with no frames for this long is not thinking, it is gone.
const ENGINE_SILENT_MS = 4000;
const REVIVE_GAP_MS = 8000;    // never faster than this, so a revive cannot become a loop
let last_revive_at = 0;
let revive_attempts = 0;

// A CONVERGED SEARCH IS SILENT TOO, and that is not the same as a dead one. With Autoplay off (also
// Help Mode, Manual Mode, and a snapped position nobody is playing) the search is `go infinite`, so
// `search_active` stays true for as long as the panel is open -- and an engine that has proved a
// mate, or simply has nothing new to say about a quiet position, stops emitting frames. Silence
// alone therefore meant "dead": the watchdog restarted the search every few seconds and REBUILT the
// engine every second attempt, which is the panel sitting on its loading bar with Autoplay off.
// Reported with screen capture on, where it is worst -- a captured position never changes, so
// nothing else ever re-drives the search and the loop is the only thing happening.
//
// So ask before concluding. `isready` is answered by a live engine EVEN MID-SEARCH (it is handled on
// the input thread, and a wedged command thread answering nothing is exactly the tell that found the
// preamble deadlock). Any reply at all refreshes last_info_at, so a live engine stands the watchdog
// down without this function needing to hear the answer itself.
let engine_probe_at = 0;
function revive_if_engine_silent() {
    if (!PANEL_BOOTED || !search_active) return;
    if (!last_info_at || Date.now() - last_info_at < ENGINE_SILENT_MS) return;
    if (Date.now() - last_revive_at < REVIVE_GAP_MS) return;
    // One probe per silence, and only where there is something to probe: send_engine_uci is a no-op
    // for a native host (it takes its work through request_remote_analyse), so those keep the old
    // behaviour rather than waiting on an answer that can never come.
    if (!is_remote() && Date.now() - engine_probe_at > ENGINE_SILENT_MS) {
        engine_probe_at = Date.now();
        send_engine_uci('isready');
        return;   // give it one tick to answer before declaring it dead
    }
    last_revive_at = Date.now();
    revive_attempts++;
    console.warn(`Mephisto: no engine frame for ${Date.now() - last_info_at}ms during a search `
                 + `(attempt ${revive_attempts}) -- reviving`);
    set_idle_reason(i18n('panel.msg.engine_quiet', 'The engine went quiet - restarting the search.'));
    abandon_search();
    pending_stops = 0;      // AFTER abandon_search, which charges one: nothing will ever pay these
    last_eval.fen = '';
    // First try costs nothing: ask the page where the board is and search again. If it is still
    // silent after that, the engine itself is gone (its host can be torn down underneath us), and
    // only a rebuild brings it back.
    if (revive_attempts >= 2) {
        revive_attempts = 0;
        console.warn('Mephisto: still silent -- rebuilding the engine');
        try { initialize_engine(); } catch (e) { console.warn('Mephisto: engine rebuild failed', e); }
        // A held setup position is OURS to restart -- no scrape will ever re-drive it (the handler
        // drops fenresponses while setup_fen is held). Safe to issue while the rebuild is still
        // loading: the host queues in order and initialize_engine now stops the queued search
        // before its ucinewgame preamble, then re-drives last_eval.fen behind it.
        if (setup_fen) on_new_pos(setup_fen, setup_fen, '');
        return;
    }
    fen_request_inflight = false;
    // Same reason as above: with a setup position held, asking the page is a no-op by design --
    // re-drive the position the panel owns instead.
    if (setup_fen) { on_new_pos(setup_fen, setup_fen, ''); return; }
    request_fen();
}
setInterval(revive_if_engine_silent, 2000);

function watch_config_changes() {
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !PANEL_BOOTED) return;
            let touched = false;
            for (const key of LIVE_CONFIG_KEYS) {
                if (!(key in changes)) continue;
                // HOTKEYS ARE NOT A PANEL VALUE. The bindings are read fresh from MephistoConfig on
                // every keypress, so nothing here has to adopt them -- only the hints need redrawing.
                // Handled before the parse below on purpose: "Reset hotkeys to defaults" REMOVES the
                // key, so newValue is undefined, and JSON.parse would throw and skip the reset --
                // leaving the panel advertising the custom keys it no longer has.
                if (key === 'hotkeys') { annotate_hotkey_labels(); continue; }
                let value;
                try { value = JSON.parse(changes[key].newValue); } catch (e) { continue; }
                if (value === undefined || value === config[key]) continue;
                config[key] = value;
                touched = true;
                // The boot path clamps this; without the same clamp HERE, a typed 50 on the
                // options page ran an open panel at maxPlies 51 while a reloaded one ran at 5.
                if (key === 'forced_lines') config.forced_lines = Math.max(0, Math.min(5, parseInt(value) || 0));
                if (key === 'pv_walk_limit') config.pv_walk_limit = Math.max(1, Math.min(50, parseInt(value) || 5));
                if (key === 'help_mode' && !value) request_clear_hint();
                if (key === 'class_on_board' && !value) send_to_active_tab({clearMoveClass: true});
                // one overlay message carries the bar, the graph and the stats strip: clear all
                // three and let the next evaluation redraw whichever are still switched on
                if (key === 'eval_bar' || key === 'eval_history' || key === 'live_stats') request_clear_eval_bar();
                if (key === 'multiple_lines' || key === 'variant') update_playstyle_row();
                if (key === 'live_stats' || key === 'live_classify' || key === 'class_on_board'
                    || key === 'opp_alert') ensure_classifier();
                if (key === 'tablebase') tablebase_data = null;       // a stale answer must not survive
                // Display-only: nothing is re-searched, but the board and the evaluation line
                // are both drawn from what is already in hand and have to be repainted now rather
                // than at the next engine frame -- with Autoplay off there may not be another one.
                if (key === 'tablebase' || key === 'tablebase_show') { draw_moves(); update_best_move(null); }
                if (key === 'refute' || key === 'refute_plies' || key === 'second_opinion') {
                    draw_moves(); update_best_move(null);
                }
                if (key === 'refute' || key === 'game_log') ensure_classifier();   // both read the graded history
                // A DIFFERENT PLAYER, OR A DIFFERENT FILTER, IS A DIFFERENT BOOK. Without this the
                // panel kept the book it fetched under the old name and played it under the new one.
                if (key === 'player_book' || key === 'player_book_user' || key === 'player_book_wins') {
                    player_book = null; player_book_for = ''; player_book_games = 0;
                    maybe_player_book();
                    update_best_move(null);
                }
                // a reply computed at the old rating must not sit under a label showing the new one:
                // drop it and ask again (ensure_threat_human retunes the net in place via setoption)
                if (key === 'threat_human' || key === 'threat_human_elo') {
                    last_eval.humanReply = null;
                    threat_human_cache.clear();
                    if (config.threat_human && last_eval.fen && last_eval.bestmove) {
                        request_threat_human(last_eval.fen, last_eval.bestmove);
                    } else {
                        update_best_move_suffix();   // toggled off: take the label out of the readout
                    }
                }
                if (key === 'language') load_language(value).then(apply_language);
                // these change the go mode / search budget -- restart under the new setting
                if (['help_mode', 'autoplay', 'clock_mode', 'mirror_mode', 'manual_mode',
                     'analysis_limit', 'analysis_limit_mode'].includes(key)) {
                    abandon_search();
                    last_eval.fen = '';
                    resync_after_config_change = true;
                }
            }
            if (!touched) return;
            sync_quick_settings();       // the panel's own switches must show the new state
            keep_alive(keep_alive_wanted(), false); // resume-only: no gesture here
            push_config();               // and the content script has to be told, or nothing changes
            // A go-mode change abandoned the search, so something has to ask the engine again.
            // push_config alone leans on the page choosing to re-push, which does not always land --
            // measured on chess.com, the panel sat on the progress bar with no engine frame for as
            // long as the board stayed still. Ask the page for the position it has RIGHT NOW: the
            // same recovery the Re-detect button runs. This used to REPLAY the position the panel
            // was holding, which put the previous position's move on screen (an illegal one, once
            // the board had moved on) -- a held position is exactly what must not be trusted here.
            if (resync_after_config_change) {
                resync_after_config_change = false;
                fen_request_inflight = false;   // don't let an in-flight poll's guard swallow this
                request_fen();
            }
        });
    } catch (e) { /* no chrome.storage here -> options changes need a panel reload, as before */ }
}

// Mirror `config` back onto the quick-settings switches, so a change made on the options page shows
// up on the panel instead of leaving the two disagreeing about what is on.
function sync_quick_settings() {
    for (const key in HOTKEY_TOGGLES) {
        const box = PANEL_ROOT.getElementById(HOTKEY_TOGGLES[key]);
        if (box && typeof config[key] === 'boolean' && box.checked !== config[key]) {
            box.checked = config[key];
        }
    }
    for (const [id, key] of [['qs_move', 'move_time'], ['qs_move_var', 'move_variance']]) {
        const el = PANEL_ROOT.getElementById(id);
        if (el && String(el.value) !== String(config[key])) el.value = config[key];
    }
    apply_search_mode_ui(); // the shared stepper: mode AND the value that mode names
    mark_autoplay_overridden();
}

// Autoplay can be ON and still never play: on_engine_best_move refuses when Help Mode or Manual
// Mode is set, which is correct -- both mean "I will make the move myself". That used to be obvious
// with all the switches in one flat column. They live on separate tabs now, so an armed-looking
// Autoplay can sit beside a Help Mode you cannot see. Say so on the Autoplay row itself.
function mark_autoplay_overridden() {
    const row = PANEL_ROOT.getElementById('qs_autoplay')?.closest('.qs-toggle');
    if (!row) return;
    const by = config.help_mode ? 'Help Mode' : config.manual_mode ? 'Manual Mode' : null;
    row.classList.toggle('qs-overridden', !!(config.autoplay && by));
    row.title = by && config.autoplay
        ? `Autoplay is on but ${by} is playing the move instead - turn ${by} off to autoplay`
        : '';
}

function push_config() {
    send_to_active_tab({pushConfig: true, config: config});
}

let last_draw_trace = null; // see the note in draw_moves: this trace is per-CHANGE, not per-call

// THE LAST MOVE, GRADED, ON THE SQUARE IT LANDED ON -- what chess.com shows in a review, except
// live, while the game is still being played. Opt-in (Move Classification): it is an opinion drawn
// on the board, and a board covered in verdicts is not what everyone wants while playing. Drawn on
// the PANEL's own board, not the site's: the site board has no badge layer, and the panel board is
// the one the panel already owns.
// WHY THAT MOVE WAS BAD, drawn rather than named. The badge says "blunder"; this says what the
// blunder LOSES -- the opponent's whole punishing line, on the board, ply by ply. Everything it
// needs is already in hand at that moment: the position after your move is the one being searched,
// so the engine's own principal variation from here IS the refutation, and the classifier has
// already decided whether the move deserves one.
//
// Only after YOUR move, only when it graded inaccuracy or worse, and only while the opponent is to
// move -- once they reply the line is history and the board has moved on.
const REFUTE_CLASSES = ['inaccuracy', 'mistake', 'miss', 'blunder'];
const REFUTE_COLOR = '#d1495b';   // its own red, darker than the threat arrow's, and it is the only
                                  // thing on the board that means "this already happened"
function draw_refutation(hint_arrows, page_arrows) {
    if (!config.refute) return;
    const moves = (premove_tracker.moves || '').trim().split(/\s+/).filter(Boolean);
    if (!moves.length) return;
    // The move just played must be OURS -- the opponent's mistakes are the Opponent Mistake Alert's
    // job, and drawing both would put two red lines on one board.
    const mover = (moves.length % 2 === 1) ? 'white' : 'black';
    if (mover !== our_side()) return;
    const klass = classify_history()[moves.length - 1];
    if (!REFUTE_CLASSES.includes(klass)) return;
    const pv = last_eval.lines?.[0]?.pv;
    if (!pv || !last_eval.fen) return;
    const limit = Math.max(1, Math.min(6, config.refute_plies || 4));
    const steps = pv_walk_moves(last_eval.fen, pv, limit);
    const col = user_color('arrow_color_refute', REFUTE_COLOR);
    for (const step of steps) {
        draw_move(step.uci, col, PANEL_ROOT.getElementById('move-annotations'), 0.14, step.ply + 1, '');
        if (page_arrows) hint_arrows.push({move: step.uci, width: 0.14, color: col, rank: step.ply + 1, label: ''});
    }
}

function draw_last_move_class() {
    if (!config.live_classify && !config.class_on_board) return;
    const moves = (premove_tracker.moves || '').trim().split(/\s+/).filter(Boolean);
    if (!moves.length) return;
    const uci = moves[moves.length - 1];
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return;   // drops and 4pc moves have no square
    const klass = classify_history()[moves.length - 1];
    const C = self.MephistoClassify;
    if (!klass || !C) return;
    // the per-class filter: null means "everything", which is what an untouched install has
    if (config.live_classify_which && !config.live_classify_which.includes(klass)) return;
    const sq = uci.slice(2, 4);
    // ...on the SITE's board, when that toggle is on. The content script sizes it to that board's
    // squares; the same class, the same colour and the same glyph as the panel's own badge, because
    // the same classifier decided both.
    if (config.class_on_board) {
        send_to_active_tab({drawMoveClass: true, square: sq, glyph: C.CLASS_GLYPH[klass] || '',
                            color: C.CLASS_COLOR[klass] || '#8b8987', klass});
    }
    const overlay = PANEL_ROOT.getElementById('move-annotations');
    if (!overlay || !config.live_classify) return;
    const fx = sq.charCodeAt(0) - 97 + 1, ry = parseInt(sq[1], 10);
    const flipped = board.orientation() !== 'white';
    const cx = 0.5 + ((flipped ? 9 - fx : fx) - 1);
    const cy = 8 - (0.5 + ((flipped ? 9 - ry : ry) - 1));
    // top-right of the square, like the review's board badge, so the piece stays visible
    overlay.innerHTML += `
        <svg style='position: absolute; z-index: 1; left: 0; top: 0; pointer-events: none;'
             width='344px' height='344px' viewBox='0, 0, 8, 8'>
            <circle cx='${cx + 0.34}' cy='${cy - 0.34}' r='0.26' fill='${C.CLASS_COLOR[klass] || '#8b8987'}'
                    stroke='#1b1b1b' stroke-width='0.04' />
            <text x='${cx + 0.34}' y='${cy - 0.34}' text-anchor='middle' dominant-baseline='central'
                  font-size='0.3' font-family='system-ui, sans-serif' font-weight='700'
                  fill='#111'>${C.CLASS_GLYPH[klass] || ''}</text>
        </svg>`;
}

function draw_moves() {
    // A known puzzle solution replaces the engine's arrow entirely -- and it is the only arrow there
    // is, since a database hit skips the search, so last_eval.lines is empty and the loop below would
    // draw nothing at all. Not gated on Autoplay the way playing the move is: Help Mode wants to be
    // SHOWN the answer, which is exactly when an arrow is the whole point.
    const solution = puzzle_pick(last_eval.fen);
    // Three ways out of here and only one of them puts an arrow on the board. Which one it was is
    // exactly the thing a report of "no arrows" cannot tell you from the outside.
    //
    // ONLY WHEN THE ANSWER CHANGES. draw_moves runs on every engine info frame -- dozens a second --
    // and each trace line is a message to the SERVICE WORKER, which is the same worker that
    // dispatches clicks and relays a native engine's frames. Tracing every call put ~100 messages a
    // second in front of every click: 500ms clicks, one timing out at 3s, and moves held in flight
    // for ten seconds. The state this reports changes at most once per position.
    const drawKey = `${solution || ''}|${!!last_eval.lines[0]}|${!!config.help_mode}|${last_eval.fen || ''}`;
    if (drawKey !== last_draw_trace) {
        last_draw_trace = drawKey;
        bgTrace('draw_moves', {solution: solution || null, haveLine0: !!last_eval.lines[0],
            help: !!config.help_mode, fen: String(last_eval.fen || '').split(' ')[0]});
    }
    if (solution) {
        clear_annotations();
        draw_move(solution, line_color(0), PANEL_ROOT.getElementById('move-annotations'), 0.25);
        if (config.help_mode) {
            engine_hint_arrows = [{move: solution, width: 0.25, color: line_color(0)}];
            push_hint_arrows();
        }
        return;
    }
    if (last_eval.lines[0] == null) return;

    function strokeFunc(line) {
        const MATE_SCORE = 20;
        const WINNING_THRESHOLD = 4;
        const MAX_STROKE = 0.225, MIN_STROKE = 0.075;
        const STROKE_SHIM = 0.0125;

        const top_line = last_eval.lines[0];
        const top_score = (turn === 'w' ? 1 : -1) * top_line.score / 100;
        const score = (turn === 'w' ? 1 : -1) * line.score / 100;
        if (top_line.move === line.move) { // is best move?
            console.log(`0 => ${MAX_STROKE + 2 * STROKE_SHIM}`);
            return MAX_STROKE + 2 * STROKE_SHIM; // accentuate the best move
        } else if (isNaN(top_score) || top_score >= WINNING_THRESHOLD) { // is winning?
            if (isNaN(score)) {
                console.log(`winning: #${line.mate} => ${MAX_STROKE - STROKE_SHIM}`);
                return MAX_STROKE - STROKE_SHIM; // moves that checkmate are necessarily good
            } else if (score < WINNING_THRESHOLD) {
                console.log(`winning: ${score} => losing`);
                return 0; // hide moves that are not winning
            } else {
                const delta = (isNaN(top_score) ? MATE_SCORE : top_score) - score;
                console.log(`winning: ${score} => ok ${delta}`);
                if (delta <= 0) {
                    return MAX_STROKE - 2 * STROKE_SHIM; // moves that are still winning are good
                } else {
                    const stroke = MAX_STROKE - 2 * STROKE_SHIM - delta / 150;
                    return Math.min(MAX_STROKE, Math.max(MIN_STROKE, stroke));
                }
            }
        } else { // is roughly equal?
            const delta = top_score - score;
            if (isNaN(score) || delta >= WINNING_THRESHOLD) {
                console.log(`${delta} => 0`);
                return 0; // hide moves that are too losing or get us checkmated
            } else {
                const stroke = MAX_STROKE - delta / 15;
                console.log(`${delta} => ${stroke}`);
                return Math.min(MAX_STROKE, Math.max(MIN_STROKE, stroke))
            }
        }
    }

    clear_annotations();
    const hint_arrows = []; // help mode mirrors the popup's arrows onto the site's board
    // ...and so does screen-reading, onto the region it read. A board read off the screen has no
    // site board to annotate, and the whole point of following one is that the answer belongs on
    // the board you are looking at -- so entering that mode is the opt-in, no Help Mode needed.
    const page_arrows = config.help_mode || !!snap_region();
    // THE FORCED CONTINUATION, drawn ahead of itself. Everything after the engine's own move is a
    // move nobody has a choice about, so it can be shown as fact rather than as a suggestion -- and
    // seeing it is the difference between playing a move and knowing why it is safe. Drawn FIRST so
    // the engine's live arrows sit on top of it.
    // MEMOIZED on its inputs, same reason as last_draw_trace two lines up: draw_moves runs on every
    // engine info frame, and the chain's inputs change at most a few times a second -- recomputing a
    // FEN parse plus six legal-move generations dozens of times a second on the thread that also
    // services clicks is the exact cost class that once produced 3s click timeouts here.
    let chain = [];
    if (config.forced_lines) {
        const pvKey = pv_moves(last_eval.lines[0]?.pv).slice(0, config.forced_lines + 1).join(' ');
        const key = `${last_eval.fen}|${pvKey}|${config.forced_lines}`;
        if (key !== forced_chain_key) {
            forced_chain_key = key;
            forced_chain_memo = forced_chain(last_eval.fen, last_eval.lines[0]?.pv, config.forced_lines + 1);
        }
        chain = forced_chain_memo;
    }
    // THE WHOLE PV, drawn ahead (opt-in pv_walk). Grey, thin, numbered by ply, drawn FIRST so both
    // the forced chain's certainty colours and the live engine arrows sit on top. Plies the forced
    // chain draws are skipped -- they keep their certainty colours -- and ply 0 is always skipped:
    // that is the move the panel already draws in its line colour. Memoized like the chain above
    // and for the same reason: this runs on every engine info frame.
    if (config.pv_walk && last_eval.lines[0]) {
        const limit = Math.max(1, Math.min(50, config.pv_walk_limit || 5));
        const wpv = pv_moves(last_eval.lines[0].pv).slice(0, limit).join(' ');
        const wkey = `${last_eval.fen}|${wpv}|${limit}`;
        if (wkey !== pv_walk_key) {
            pv_walk_key = wkey;
            pv_walk_memo = pv_walk_moves(last_eval.fen, last_eval.lines[0].pv, limit);
        }
        const skip = Math.max(1, chain.length); // forced plies keep their colours; ply 0 its line colour
        const wcol = user_color('arrow_color_pv_walk', PV_WALK_COLOR);
        for (const step of pv_walk_memo) {
            if (step.ply < skip) continue;
            draw_move(step.uci, wcol, PANEL_ROOT.getElementById('move-annotations'), 0.10, step.ply + 1, '');
            if (config.help_mode) hint_arrows.push({move: step.uci, width: 0.10, color: wcol, rank: step.ply + 1, label: ''});
        }
    }
    for (let i = chain.length - 1; i >= 1; i--) {   // skip ply 0: that is the move the panel already draws
        const step = chain[i];
        // OUR unforced moves are the point now -- they are the premoves the forced replies make
        // safe -- so nothing is skipped: every ply that survived the walk is certain by construction
        // (ours because we choose it, theirs because the rules do).
        // ply 0 is the side to move in the analysed position -- us -- so even plies are ours.
        // Each side's ramp advances on its OWN moves, not on the shared depth, or one side would
        // skip every other shade and the two would stop looking like sequences.
        const ours = (step.ply % 2) === 0;
        const ramp = forced_ramp(ours);
        const color = ramp[Math.min(Math.floor((step.ply - 1) / 2), ramp.length - 1)];
        draw_move(step.uci, color, PANEL_ROOT.getElementById('move-annotations'), 0.12, 0, '');
        if (page_arrows) hint_arrows.push({move: step.uci, width: 0.12, color, rank: 0, label: ''});
    }
    // The tablebase pick leads the board too: it is the move autoplay makes, so its arrow is the
    // widest one, labeled with the mate count (or TB), and an engine line that agrees with it is
    // not drawn twice underneath.
    // IN ITS OWN COLOUR, not line 1's. It is a different kind of answer from an engine line and the
    // board has to say so; the label carries the mate count where the tables have one.
    const tb_pick = tablebase_pick(last_eval.fen);
    const tb_arrow = (tb_pick && tb_show_tb()) ? tb_pick : null;
    if (tb_arrow) {
        const tb_label = tablebase_data?.dtm != null
            ? '#' + Math.ceil(Math.abs(tablebase_data.dtm) / 2) : 'TB';
        const tb_col = user_color('arrow_color_tb', TB_COLOR);
        draw_move(tb_arrow, tb_col, PANEL_ROOT.getElementById('move-annotations'), 0.25, 0, tb_label);
        if (page_arrows) hint_arrows.push({move: tb_arrow, width: 0.25, color: tb_col, rank: 0, label: tb_label});
    }

    for (let i = 0; i < last_eval.activeLines; i++) {
        if (!tb_show_engine()) break;                  // 'Tablebase only': its arrow is the whole board
        if (!last_eval.lines[i]) continue;
        // Only when the tablebase arrow was actually DRAWN -- under 'Engine only' it was not, and
        // skipping the engine's own line then left the best move with no arrow at all.
        if (tb_arrow && last_eval.lines[i].move === tb_arrow) continue;

        const arrow_color = line_color(i); // per-rank colour (was blue for #1, grey for all the rest)
        const stroke_width = strokeFunc(last_eval.lines[i]);
        // Rank AND eval travel with the arrow. Colour alone never said WHICH line an arrow was --
        // you had to look away from the board and count rows in the panel to find out.
        const rank = config.arrow_rank ? (i + 1) : 0;
        const label = arrow_label(last_eval.lines[i]);
        draw_move(last_eval.lines[i].move, arrow_color, PANEL_ROOT.getElementById('move-annotations'),
                  stroke_width, rank, label);
        if (page_arrows && stroke_width > 0 && last_eval.lines[i].move) {
            hint_arrows.push({move: last_eval.lines[i].move, width: stroke_width, color: arrow_color,
                              rank, label});
        }
    }
    // The human net's own pick, when it is not the engine's. Drawn in the same colour the human
    // reply already uses, so "this is what a person plays" is one colour everywhere.
    const so = config.second_opinion ? last_eval.secondOpinion : null;
    if (so && so.uci && so.uci !== last_eval.lines?.[0]?.move) {
        const hcol = user_color('arrow_color_human_reply', '#a8657f');
        draw_move(so.uci, hcol, PANEL_ROOT.getElementById('move-annotations'), 0.16, 0, 'H');
        if (page_arrows) hint_arrows.push({move: so.uci, width: 0.16, color: hcol, rank: 0, label: 'H'});
    }
    draw_refutation(hint_arrows, page_arrows);   // ...and, when it was bad, how it gets punished
    draw_last_move_class();   // on top of the arrows: it grades a move already made

    if (page_arrows) {
        if (config.threat_analysis && last_eval.threat && last_eval.threat !== '(none)') {
            hint_arrows.push({move: last_eval.threat, width: 0.2, color: user_color('arrow_color_threat', '#bf0000')});
        }
        engine_hint_arrows = hint_arrows;
        push_hint_arrows(); // engine arrows + the book, in one replace
    }
}

// Book arrows, in their own layer so they COEXIST with the engine's: draw_moves() clears
// move+response on every depth update, and anything drawn there would flicker away with it.
// One colour (the panel's teal accent, distinct from the five LINE_COLORS and the red threat) with
// the width carrying popularity -- so the main line reads as the main line at a glance.
// One colour per book move, like the engine's per-rank line colours -- all five chosen to clash with
// neither LINE_COLORS nor the red threat arrow, so a book arrow is never mistaken for an engine line.
const BOOK_COLORS = ['#14b8a6', '#ec4899', '#22d3ee', '#a3e635', '#fb7185'];

let engine_hint_arrows = []; // last set draw_moves built, kept so a late book lookup can re-send both

// Book arrows as {move,width,color}. ONE builder for both boards so the panel and the site board can
// never drift apart. Offered whenever a lookup ran for THIS position -- so Help Mode shows the book
// whether you switched on the overlay or Book Moves.
function book_arrow_specs(fen) {
    const at = fen || last_eval.fen;
    if (explorer_data?.fen !== at) return [];
    const top = explorer_data.moves.slice(0, 5);
    const most = Math.max(...top.map(m => (m.white || 0) + (m.draws || 0) + (m.black || 0)), 1);
    return top.map((m, i) => ({
        move: m.uci,
        // the least-played stays a real arrow; the main line matches the engine's best-move stroke
        width: 0.13 + 0.13 * (((m.white || 0) + (m.draws || 0) + (m.black || 0)) / most),
        color: user_color('arrow_color_book', BOOK_COLORS[Math.min(i, BOOK_COLORS.length - 1)]),
    }));
}

// Help Mode draws onto the SITE's board. request_draw_hint REPLACES the whole set, so the engine's
// arrows and the book's must go in a SINGLE call -- sending them separately would make whichever
// landed last erase the other, and the book lookup always lands after the first engine depth.
function push_hint_arrows() {
    const region = snap_region();
    // HELP MODE OWNS THE ARROWS ON SCREEN, always. The screen reader used to be exempt -- drawing
    // onto the region it was following even with Help Mode off -- on the reasoning that arrows are
    // the whole point of following a board. They are, but the toggle is the toggle.
    if (!config.help_mode) return;
    request_draw_hint([...engine_hint_arrows, ...book_arrow_specs()], region);
}

// The board the screen reader is following, in CAPTURED IMAGE pixels, or null when the panel is
// analysing a real board on the page. The content script divides by devicePixelRatio to land it
// back on the page, and `flipped` is the same flag the follow loop rotates its reads by, so an
// arrow drawn here always points the way the board on screen is facing.
function snap_region() {
    if (!setup_fen || !snap_crop) return null;
    const {x, y, w, h} = snap_crop;
    if (![x, y, w, h].every(v => Number.isFinite(v) && v > 0)) return null;
    return {x, y, w, h, flipped: !!snap_flipped};
}

function clear_book_annotations() {
    const layer = PANEL_ROOT.getElementById('book-annotations');
    while (layer?.childElementCount) layer.lastElementChild.remove();
    return layer;
}

function draw_book_moves(fen) {
    push_hint_arrows(); // Help Mode: re-send the site-board set now the book is known
    const layer = clear_book_annotations();
    if (!layer || !config.explorer) return;
    // Draw only for the position actually on the board. The caller passes it explicitly: during
    // on_new_pos, last_eval still describes the PREVIOUS position (it isn't reassigned until the very
    // end), so comparing against it there matched the old fen and painted the previous position's
    // book onto the new one -- which is why the arrows went wrong the moment a move was played.
    const at = fen || last_eval.fen;
    if (explorer_data?.fen !== at) return;
    for (const a of book_arrow_specs(at)) draw_move(a.move, a.color, layer, a.width);
}

// Maia-3, not the banded Maia-1 nets: one transformer with a LIVE rating dial, so the whole
// 600-2600 range is real and a rating change is a setoption, not a 30MB net reload.
let threat_human_id = null;      // offscreen clientId, minted per panel boot
let threat_human_elo_loaded = null;
let threat_human_ready = null;   // the in-flight init, so two asks share one load
let threat_human_cache = new Map();   // fen-after-our-move -> {uci, prob}, valid for ONE rating

function threat_human_elo() {
    const want = Number(config.threat_human_elo) || 1500;
    return Math.max(600, Math.min(2600, Math.round(want)));
}

function ensure_threat_human() {
    const elo = threat_human_elo();
    if (threat_human_ready && threat_human_elo_loaded === elo) return threat_human_ready;
    if (threat_human_ready && threat_human_elo_loaded !== null) {
        // the net is up -- retune it in place; the cached replies belong to the old rating
        threat_human_elo_loaded = elo;
        threat_human_cache.clear();
        safety_human_cache.clear();
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'uci',
                                    line: `setoption name SelfElo value ${elo}`});
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'uci',
                                    line: `setoption name OppoElo value ${elo}`});
        return threat_human_ready;
    }
    threat_human_elo_loaded = elo;
    // ENGINE_CLIENT-derived like maia2_client(): the background relays fromOffscreen to the tab by
    // parseInt(clientId) -- a name that does not start with the tabId is never relayed to a panel.
    if (!threat_human_id) threat_human_id = ENGINE_CLIENT + ':hr';
    threat_human_ready = (async () => {
        await chrome.runtime.sendMessage({ensureOffscreen: true});
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('maia load timed out')); }, 60000);
            const onMsg = (m) => {
                if (!m || !m.fromOffscreen || m.clientId !== threat_human_id) return;
                if (m.kind === 'ready') { cleanup(); resolve(); }
                if (m.kind === 'error') { cleanup(); reject(new Error(m.error)); }
            };
            const cleanup = () => { clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); };
            chrome.runtime.onMessage.addListener(onMsg);
        });
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'init',
                                    engine: 'maia3', maiaLevel: elo});
        await ready;
        // FIVE lines, not one: the safety net reads Maia's ordering off this same client. The
        // threat reply still parses only multipv 1, and the probabilities are a softmax over ALL
        // legal moves, so widening the list changes no number either consumer reads.
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'uci',
                                    line: 'setoption name MultiPV value 5'});
    })();
    return threat_human_ready;
}

function dispose_threat_human() {
    if (!threat_human_id) return;
    try { chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'dispose'}); }
    catch (e) { /* the offscreen doc is already gone */ }
    threat_human_id = null;
    threat_human_ready = null;
    threat_human_elo_loaded = null;
    threat_human_cache.clear();
    safety_human_cache.clear();
}

// one forward pass for the position after `fen` -- resolves {uci, prob} or null
async function threat_human_reply(fenAfter) {
    if (threat_human_cache.has(fenAfter)) return threat_human_cache.get(fenAfter);
    await ensure_threat_human();
    const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => { cleanup(); resolve(null); }, 15000);
        let top = null;
        const onMsg = (m) => {
            if (!m || !m.fromOffscreen || m.clientId !== threat_human_id || m.kind !== 'line') return;
            const info = /info .*multipv 1 .*maiaprob (\d+) pv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(m.line || '');
            if (info) top = {uci: info[2], prob: Number(info[1]) / 10000};
            if (/^bestmove\b/.test(m.line || '')) { cleanup(); resolve(top); }
        };
        const cleanup = () => { clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); };
        chrome.runtime.onMessage.addListener(onMsg);
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'uci', line: `position fen ${fenAfter}`});
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'uci', line: 'go nodes 1'});
    });
    if (answer) threat_human_cache.set(fenAfter, answer);
    return answer;
}

// asked from the same branch that arms the threat arrow; drawn only if the position has not moved on
function request_threat_human(fen, best) {
    if (!config.threat_analysis || !config.threat_human) return;
    if (config.variant && config.variant !== 'chess') return;    // the nets know one game
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best || '')) return;
    let fenAfter;
    try {
        const c = new Chess(config.variant, fen);
        if (!c.move({from: best.slice(0, 2), to: best.slice(2, 4), promotion: best[4]})) return;
        fenAfter = c.fen();
    } catch (e) { return; }
    threat_human_reply(fenAfter).then((r) => {
        if (!r) return;
        if (last_eval.fen !== fen || last_eval.bestmove !== best) return;   // the moment has passed
        last_eval.humanReply = r;
        if (config.threat_analysis) draw_human_reply();
        update_best_move_suffix();   // the reply arrives after the readout, same shape as the tablebase verdict
    }).catch(() => {});
}

function draw_human_reply() {
    if (last_eval.humanReply?.uci) {
        // the human column's own colour, distinct from every engine arrow and the red threat
        draw_move(last_eval.humanReply.uci, user_color('arrow_color_human_reply', '#a8657f'),
                  PANEL_ROOT.getElementById('response-annotations'));
    }
}

// ---- the net's own Maia read: what YOU are likely to play HERE --------------------------------
// One forward pass on the CURRENT position, on the threat reply's engine (same client, same net,
// same rating dial) but its own cache: this one keeps Maia's whole top list, because the net wants
// the ORDER, not just the first line. Quiet mode reads the top entry -- silence while your likely
// move already holds -- and the drawn set is sorted by these probabilities, so what it offers are
// human-playable moves that still hold the edge, not engine order.
const safety_human_cache = new Map();   // fen -> [{uci, prob}] in Maia's own order
async function safety_human_choices(fen) {
    if (safety_human_cache.has(fen)) return safety_human_cache.get(fen);
    await ensure_threat_human();
    const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => { cleanup(); resolve(null); }, 15000);
        const list = [];
        const onMsg = (m) => {
            if (!m || !m.fromOffscreen || m.clientId !== threat_human_id || m.kind !== 'line') return;
            const info = /info .*multipv (\d+) .*maiaprob (\d+) pv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(m.line || '');
            if (info) list[Number(info[1]) - 1] = {uci: info[3], prob: Number(info[2]) / 10000};
            if (/^bestmove\b/.test(m.line || '')) { cleanup(); resolve(list.filter(Boolean)); }
        };
        const cleanup = () => { clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); };
        chrome.runtime.onMessage.addListener(onMsg);
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'uci', line: `position fen ${fen}`});
        chrome.runtime.sendMessage({toOffscreen: true, clientId: threat_human_id, cmd: 'uci', line: 'go nodes 1'});
    });
    if (answer && answer.length) safety_human_cache.set(fen, answer);
    return answer || [];
}

// asked whenever the net is watching our turn; redraws when the answer lands, because the verdict
// can change either way (a fired warning goes quiet, a quiet position fires)
function request_safety_net_human(fen) {
    if (!config.safety_net) return;
    if (config.variant && config.variant !== 'chess') return;    // the nets know one game
    if (!our_turn_now()) return;
    if (last_eval.humanSelf?.fen === fen) return;
    safety_human_choices(fen).then((list) => {
        if (!list.length) return;
        if (last_eval.fen !== fen) return;    // the moment has passed
        last_eval.humanSelf = {fen, list};
        draw_safety_net();
        update_best_move_suffix();
    }).catch(() => {});
}

// Drawn on OUR turn only: the whole point is the move being yours. Its own colour and the response
// layer, so it never poses as the engine's best-move arrow -- these are not recommendations, they
// are the moves that keep the result.
function draw_safety_net() {
    // Its own layer, cleared on every draw: Maia's verdict lands AFTER the engine's, and can turn
    // a fired warning quiet (or the reverse) -- appending onto a shared layer could neither erase
    // stale arrows nor be erased without taking the threat's with it.
    const host = PANEL_ROOT.getElementById('net-annotations');
    if (!host) return;
    while (host.childElementCount) host.lastElementChild.remove();
    if (!our_turn_now()) return;
    const set = safety_net_showing();
    if (!set || set.needMoreLines || set.forced || !set.moves.length) return;
    const colour = user_color('arrow_color_safety_net', '#4c9f70');
    for (const uci of set.moves) draw_move(uci, colour, host, 0.14);
}

function safety_net_label() {
    if (!config.safety_net || !our_turn_now()) return '';
    const set = safety_net_showing();
    if (!set) return '';
    if (set.needMoreLines) return i18n('panel.msg.net_needs_lines', 'Safety net needs more than one line');
    if (set.forced || !set.moves.length) return '';
    // say WHY it fired when the reason is your own likely move -- a warning that names the danger
    // is actionable; a bare list is homework
    const prefix = set.likelyThrows
        ? i18n('panel.msg.net_likely_throws', 'Your likely {move} drops it - ',
               {move: notate(last_eval.fen, set.likely)})
        : '';
    if (set.moves.length === 1) {
        return prefix + i18n('panel.msg.net_only_one', 'Only one move holds: {move}',
                    {move: notate(last_eval.fen, set.moves[0])});
    }
    return prefix + i18n('panel.msg.net_holds', '{n} moves hold: {moves}',
                {n: set.moves.length, moves: set.moves.map(u => notate(last_eval.fen, u)).join(', ')});
}

// "Ours" without requiring Autoplay: the net is for when YOU are moving, which is precisely when
// the panel is not playing for you.
function our_turn_now() {
    try { return String(turn === 'w' ? 'white' : 'black') === our_side(); } catch (e) { return false; }
}

// ---- OPPONENT PREP: what THIS opponent actually plays here --------------------------------------
// The opening explorer says what humans play. This says what the person across the board plays --
// from their own recent public games, which both sites publish. In a long game that is worth more
// than a database average: people repeat their repertoire, and a line they have played eleven times
// is a line they will play again.
//
// LONGER GAMES ONLY, deliberately. It costs a fetch and a replay of forty games, the answer is only
// useful while you still have time to think about it, and in bullet you do not. The gate is the
// longest clock reading seen this game -- the closest thing to a base time that is visible from
// here, and it survives joining a game late.
const OPP_PREP_MIN_CLOCK_S = 300;   // five minutes: rapid and up
const OPP_PREP_MAX_PLY = 24;        // prep is an opening question; past ply 24 they are on their own
let game_max_clock_s = 0;
let opp_prep_for = '';              // the opponent we already asked about
let opp_prep_book = null;           // 'placement turn' -> {uci: count} from THEIR games, their colour
let opp_prep_games = 0;

function opp_prep_long_enough() { return game_max_clock_s >= OPP_PREP_MIN_CLOCK_S; }

function maybe_opponent_prep(name) {
    if (!config.opp_prep || !opp_prep_long_enough()) return;
    if (!/^[\w.-]{2,30}$/.test(name) || name === opp_prep_for) return;
    opp_prep_for = name;
    opp_prep_book = null;
    opp_prep_games = 0;
    // 'li' / 'cc' are the panel's own site codes; the worker asks lichess or chess.com accordingly,
    // and anywhere else there is no public archive to ask about.
    const site = detected_prefix === 'li' ? 'lichess' : detected_prefix === 'cc' ? 'chesscom' : null;
    if (!site) return;
    chrome.runtime.sendMessage({oppPrepLookup: {site, username: name}}, (res) => {
        void chrome.runtime.lastError;
        if (!res || res.error || !Array.isArray(res.games)) return;
        if (opp_prep_for !== name) return;              // a new opponent while we waited
        build_opp_prep_book(name, res.games);
        update_best_move(null);                          // the label can appear without a new search
    });
}

// ONE BUILDER, TWO FEATURES. Opponent Prep reads it to say what they play; the Player Book reads
// it to decide what WE play. `winsOnly` is the difference that makes a book of your own games worth
// having: every game you ever played includes every opening you lost with.
function build_moves_book(games, name, {maxPly, winsOnly}) {
    const book = new Map();
    let used = 0;
    const lower = String(name || '').toLowerCase();
    for (const g of games) {
        const theirColour = (String(g.white || '').toLowerCase() === lower) ? 'w'
                          : (String(g.black || '').toLowerCase() === lower) ? 'b' : null;
        if (!theirColour || !g.san) continue;
        // A game with no Result tag ('*', an archive that dropped it) is not a win anyone can prove.
        if (winsOnly && g.result !== (theirColour === 'w' ? '1-0' : '0-1')) continue;
        try {
            const chess = new Chess('chess');
            let ply = 0;
            for (const san of g.san.split(' ')) {
                if (ply >= maxPly) break;
                const before = chess.fen();
                const mv = chess.move(san);
                if (!mv) break;                          // an unreadable game stops, it does not throw
                if (before.split(' ')[1] === theirColour) {
                    const key = before.split(' ').slice(0, 2).join(' ');
                    const uci = mv.from + mv.to + (mv.promotion || '');
                    const at = book.get(key) || {};
                    at[uci] = (at[uci] || 0) + 1;
                    book.set(key, at);
                }
                ply++;
            }
            used++;
        } catch (e) { /* one unparseable game must not cost the other thirty-nine */ }
    }
    return {book, used};
}

function build_opp_prep_book(name, games) {
    const built = build_moves_book(games, name, {maxPly: OPP_PREP_MAX_PLY, winsOnly: false});
    opp_prep_book = built.book;
    opp_prep_games = built.used;
}

// The readout line. Only on THEIR turn: prep is about what they are about to do.
function opp_prep_label() {
    if (!config.opp_prep || !opp_prep_book || !last_eval.fen) return '';
    const [placement, turn] = last_eval.fen.split(' ');
    if (((turn === 'w') ? 'white' : 'black') === our_side()) return '';
    const at = opp_prep_book.get(`${placement} ${turn}`);
    if (!at) return '';
    const [uci, n] = Object.entries(at).sort((a, b) => b[1] - a[1])[0];
    return i18n('panel.msg.opp_prep', '{who} has played {move} here ({n}x)',
                {who: opp_prep_for, move: notate(last_eval.fen, uci), n});
}

// ---- WHAT THIS SESSION HAS ACTUALLY DONE -------------------------------------------------------
// The live stats strip grades the GAME in front of you. Nothing said anything about the session: how
// many games, how many moves, how long they really took. That is the number that tells you whether
// the pacing settings are doing what you set them to -- "2.4s average" against a 3-second think time
// is the answer to a question the sliders cannot answer themselves.
//
// It lives for as long as the panel does, which is what "session" means here, and it is said plainly
// in the tooltip: a reload starts a new one. Nothing is stored, because a running total kept on disk
// is a thing to explain, migrate and eventually get wrong.
let session = {games: 0, moves: 0, think_ms: 0, acc: []};

// Our own move, as it goes out. `think` is the pacing modes' explicit delay when there was one, and
// the configured think otherwise -- the number the move actually waited, either way.
function session_note_move(think_ms) {
    if (!Number.isFinite(think_ms)) return;
    session.moves++;
    session.think_ms += Math.max(0, think_ms);
}

// A game just ended (the ply count dropped back to the start). Its accuracy is folded in HERE, once,
// rather than recomputed on every render: live_stats runs the classifier over the whole history.
function session_note_game(history) {
    session.games++;
    try {
        const side = our_side();
        const acc = live_stats(history)[side]?.accuracy;
        if (Number.isFinite(acc)) session.acc.push(acc);
    } catch (e) { /* an ungradeable game still counts as a game */ }
}

function session_stats_label() {
    if (!config.session_stats || !session.moves) return '';
    const avg = (session.think_ms / session.moves / 1000).toFixed(1);
    const acc = session.acc.length
        ? Math.round(session.acc.reduce((a, b) => a + b, 0) / session.acc.length) : null;
    // Two strings rather than five: a label built by joining four translated fragments is four
    // chances for a language to want a different order.
    return i18n('panel.msg.session', 'Session: {games} games · {moves} moves · {avg}s avg',
                {games: session.games, moves: session.moves, avg})
        + (acc != null ? i18n('panel.msg.session_acc', ' · {n}% accuracy', {n: acc}) : '');
}

// ---- ENDING A GAME THAT IS OVER ----------------------------------------------------------------
// A lost game still has to be resigned by hand, and a dead-drawn one still has to be offered, which
// means sitting there clicking out a position neither side can change. Both are off until asked for,
// both take a threshold, and neither fires on a single reading: the score has to stay past the line
// for three of OUR turns running, because one deep line at one depth is not a verdict.
//
// The panel decides and the content script presses the button -- the score lives here, the markup
// lives there. Once per game per action: a declined draw offer is not re-offered every move, which
// is the behaviour that gets people muted.
const END_GAME_STREAK = 3;            // consecutive turns of ours past the line
const AUTO_DRAW_MIN_FULLMOVE = 20;    // nobody offers a draw on move six; that is just rude
let resign_streak = 0, draw_streak = 0, end_game_sent = '';

function auto_resign_cp() {
    const n = parseInt(config.auto_resign_cp);
    return Number.isFinite(n) ? Math.max(100, Math.min(3000, n)) : 900;
}

function auto_draw_cp() {
    const n = parseInt(config.auto_draw_cp);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 20;
}

// The decision itself: our own score and the move number in, an action or null out, streaks updated.
// Deliberately a pure function of the config and its two arguments -- this is the half that decides
// to end a game, and it is worth being able to run it rather than reason about it.
function end_game_action(cp, fullmove) {
    if (!Number.isFinite(cp)) {                 // no score: no evidence, and the count starts again
        resign_streak = draw_streak = 0;
        return null;
    }
    // A mate score needs no special case: being mated is a very negative number, which is already
    // past any threshold anyone would set.
    if (config.auto_resign && cp <= -auto_resign_cp()) resign_streak++; else resign_streak = 0;
    if (config.auto_draw && Math.abs(cp) <= auto_draw_cp() && fullmove >= AUTO_DRAW_MIN_FULLMOVE) draw_streak++;
    else draw_streak = 0;
    if (resign_streak >= END_GAME_STREAK) return 'resign';
    if (draw_streak >= END_GAME_STREAK) return 'draw';
    return null;
}

// Reads the current position's score, asks the rule above, and sends the click ONCE. Returns the
// action so the caller can decline to also play a move into a game it just resigned.
// HOW FAR INTO THE GAME WE ARE. NOT from the FEN: the panel's position is SCRAPED FROM THE BOARD,
// and neither site's DOM carries the move counters -- every live scrape reads "0 1" (measured on
// lichess 2026-09-04, and it is why the draw offer did not fire once in a whole test game). The move
// LIST is what the panel really has, so the count comes from there; a game joined from a set-up
// position still gets the FEN's own number when that one is larger.
//
// The same fact is why contempt can only see a THREEFOLD and never the fifty-move rule: the halfmove
// clock is gone for the same reason, and only the replayed move list can put it back.
function game_fullmove() {
    let fromFen = 0;
    try { fromFen = parseInt(String(last_eval.fen).split(' ')[5]) || 0; } catch (e) { /* variant fen */ }
    const plies = String(last_pos.moves || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(fromFen, Math.floor(plies / 2) + 1);
}

function maybe_end_game() {
    if (!config.auto_resign && !config.auto_draw) return null;
    if (config.help_mode || config.manual_mode || config.puzzle_mode) return null;
    const line = (last_eval.lines || []).find(l => l && l.move);
    const cp = line ? line_cp_ours(line) : null;
    const action = end_game_action(Number.isFinite(cp) ? cp : NaN, game_fullmove());
    if (!action) return null;
    if (action !== end_game_sent) {
        end_game_sent = action;
        console.log(`Mephisto: ${action === 'resign' ? 'resigning' : 'offering a draw'} -- the score has been past`
                    + ` the line for ${END_GAME_STREAK} of our moves`);
        send_to_active_tab({gameAction: action});
    }
    return action;
}

// ---- THE PLAYER BOOK: somebody's openings, played the way they play them -----------------------
// Opponent Prep asks the public archive about the person across the board and tells you what it
// found. This asks it about a person YOU name -- yourself, or a titled player whose openings you
// want to borrow -- and then PLAYS what came back, weighted by how often they played it. Prep, not
// statistics: no engine veto and no minimum beyond a single repeat, because second-guessing a
// repertoire is exactly what choosing one is meant to end.
//
// It is a book, so it runs out: past the opening horizon, or in a position that player never had,
// it returns nothing at all and the engine's move stands. Nothing is deferred and nothing is
// awaited -- the lookup lands between moves or it does not, like every other book here.
const PLAYER_BOOK_MAX_PLY = 24;   // the same opening horizon Opponent Prep uses
const PLAYER_BOOK_MIN = 2;        // played at least twice: once is an accident, not a repertoire
let player_book = null;           // 'placement turn' -> {uci: count}, that player's moves only
let player_book_for = '';         // site|user|filter we already asked about, so we ask once
let player_book_games = 0;

// "name", "lichess:name", "chesscom:name" -> {site, name}. A bare name means the site you are on,
// which is the common case and the one nobody should have to spell out. null when there is nothing
// usable in the box, which is also what an empty box gives.
function parse_player_book_user() {
    const m = /^(?:(lichess|chesscom|li|cc)\s*[:/]\s*)?([\w.-]{2,30})$/i
        .exec(String(config.player_book_user || '').trim());
    if (!m) return null;
    const tag = (m[1] || '').toLowerCase();
    const site = tag ? (tag[0] === 'l' ? 'lichess' : 'chesscom')
                     : (detected_prefix === 'li' ? 'lichess'
                        : detected_prefix === 'cc' ? 'chesscom' : null);
    return site ? {site, name: m[2]} : null;
}

// Ask once per player, per filter. The key carries the wins-only flag because switching that is a
// different book from the same games, and a book that did not rebuild would silently be the old one.
function maybe_player_book() {
    if (!config.player_book) { player_book_for = ''; return; }
    const who = parse_player_book_user();
    if (!who) return;
    const key = `${who.site}|${who.name.toLowerCase()}|${config.player_book_wins ? 'wins' : 'all'}`;
    if (key === player_book_for) return;
    player_book_for = key;
    player_book = null;
    player_book_games = 0;
    chrome.runtime.sendMessage({playerBookLookup: {site: who.site, username: who.name}}, (res) => {
        void chrome.runtime.lastError;
        // A failed lookup un-latches so the next position tries again -- a worker that was asleep,
        // or an archive that was briefly down, must not cost the book for the whole session.
        if (!res || res.error || !Array.isArray(res.games)) {
            if (player_book_for === key) player_book_for = '';
            console.warn('Mephisto: player book lookup failed -', res?.error || 'no response');
            return;
        }
        if (player_book_for !== key) return;          // the setting changed while we waited
        const built = build_moves_book(res.games, who.name,
                                       {maxPly: PLAYER_BOOK_MAX_PLY, winsOnly: !!config.player_book_wins});
        player_book = built.book;
        player_book_games = built.used;
        console.log(`Player book: ${built.book.size} positions from ${built.used} of ${who.name}'s games`
                    + (config.player_book_wins ? ' (wins only)' : ''));
        update_best_move(null);                       // the label can appear without a new search
    });
}

// What that player played here, as {uci: count}, or null. Only ever on OUR turn: the key carries the
// side to move, so a position where it is their move is simply not in our half of the book.
function player_book_at(fen) {
    if (!config.player_book || !player_book || !fen) return null;
    const [placement, turn] = String(fen).split(' ');
    if (((turn === 'w') ? 'white' : 'black') !== our_side()) return null;
    const at = player_book.get(`${placement} ${turn}`);
    if (!at) return null;
    const total = Object.values(at).reduce((sum, n) => sum + n, 0);
    return (total >= PLAYER_BOOK_MIN) ? at : null;
}

// Weighted random over what they actually played -- the same rule the explorer book uses, on a much
// smaller sample. The rail's own legality check still stands after this returns.
function player_book_pick(fen) {
    const at = player_book_at(fen);
    if (!at) return null;
    const entries = Object.entries(at);
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    let roll = Math.random() * total;
    for (const [uci, n] of entries) if ((roll -= n) <= 0) return uci;
    return entries[entries.length - 1][0];
}

// The readout line, on the positions the book actually covers: who it is and what they mostly play.
function player_book_label() {
    const at = player_book_at(last_eval.fen);
    if (!at) return '';
    const [uci, n] = Object.entries(at).sort((a, b) => b[1] - a[1])[0];
    const who = parse_player_book_user();
    return i18n('panel.msg.player_book', 'Book: {who} plays {move} here ({n}x)',
                {who: who ? who.name : '?', move: notate(last_eval.fen, uci), n});
}

// ---- TWO ENGINES AT ONCE: what a human of a chosen rating would play HERE -----------------------
// The engine answers "what is best". A human net answers "what does a player of this strength
// actually play". They are different questions, and the interesting positions are the ones where
// the answers come apart -- that gap is where a human loses the game, and it is invisible while
// only one of them is on screen.
//
// It costs one forward pass on a net that is already loaded for the threat reply (same client, same
// rating dial), and it reuses that pass's cache -- so with Human Reply also on, the second opinion
// is free.
const SECOND_OPINION_LOW = 0.10;   // the engine's move played less than a tenth of the time by a
                                   // player of this rating: that is a real disagreement, not noise
function request_second_opinion(fen, best) {
    if (!config.second_opinion) return;
    if (config.variant && config.variant !== 'chess') return;   // the nets know one game
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best || '')) return;
    if (second_opinion_at === fen) return;                      // once per position
    second_opinion_at = fen;
    safety_human_choices(fen).then((list) => {
        if (!list || !list.length || last_eval.fen !== fen) return;
        const top = list[0];
        const forEngine = list.find(m => m.uci === best);
        last_eval.secondOpinion = {
            uci: top.uci, prob: top.prob,
            engineProb: forEngine ? forEngine.prob : 0,
            // "Disagrees" is not "picked another move" -- two moves can be near-equal to a human
            // net. It is the net rating the ENGINE's move as one this player would rarely find.
            disagrees: top.uci !== best && (forEngine ? forEngine.prob : 0) < SECOND_OPINION_LOW,
        };
        update_best_move(null);
        draw_moves();
    }).catch(() => {});
}
let second_opinion_at = '';

function second_opinion_label() {
    const o = config.second_opinion ? last_eval.secondOpinion : null;
    if (!o) return '';
    const move = notate(last_eval.fen, o.uci);
    const pct = (o.prob * 100).toFixed(0);
    return o.disagrees
        ? i18n('panel.msg.second_opinion_off', 'A {elo} plays {move} ({pct}%) - and almost never the engine\'s',
               {elo: threat_human_elo(), move, pct})
        : i18n('panel.msg.second_opinion', 'A {elo} plays {move} ({pct}%)',
               {elo: threat_human_elo(), move, pct});
}

function human_reply_label() {
    if (!config.threat_analysis || !config.threat_human || !last_eval.humanReply) return '';
    const r = last_eval.humanReply;
    return i18n('panel.msg.human_reply', 'A {elo} likely replies {move} ({pct}%)',
                {elo: threat_human_elo(), move: notate_after_best(r.uci), pct: (r.prob * 100).toFixed(0)});
}

// the reply is a move in the position AFTER our best move, so its SAN must be built there
function notate_after_best(uci) {
    try {
        const c = new Chess(config.variant, last_eval.fen);
        c.move({from: last_eval.bestmove.slice(0, 2), to: last_eval.bestmove.slice(2, 4), promotion: last_eval.bestmove[4]});
        const mv = c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
        return mv ? mv.san : uci;
    } catch (e) { return uci; }
}

function draw_threat() {
    if (last_eval.threat) {
        draw_move(last_eval.threat, user_color('arrow_color_threat', '#bf0000'), PANEL_ROOT.getElementById('response-annotations'));
    }
}

// An arrow's own evaluation, from White's point of view like every other score the panel shows, so
// a line does not read one way on the board and the other way in the panel. Mate is written as #N
// rather than as a centipawn score, because a mate is not a number of pawns.
// See the config note: values <= 1 are the pre-3.1.229 fraction, everything else is a percentage.
function read_arrow_opacity() {
    const raw = JSON.parse(MephistoConfig.get('arrow_opacity'));
    if (!Number.isFinite(raw) || raw <= 0) return 75;
    return Math.max(1, Math.min(100, raw <= 1 ? Math.round(raw * 100) : Math.round(raw)));
}

// The configured opacity, scaled against whatever this overlay's baseline was, so a slider at its
// default leaves every arrow exactly as it has always looked.
function arrow_alpha(base) {
    const pct = Number(config.arrow_opacity);
    const frac = (Number.isFinite(pct) ? pct : 75) / 100;
    // scaled against this overlay's own baseline, so the slider at 75 leaves every arrow exactly as
    // it has always looked; floored so the slider's bottom end cannot render an invisible arrow
    return Math.max(0.05, Math.min(1, base * (frac / 0.75))).toFixed(3);
}

function arrow_label(line) {
    // A human model's lines all carry ONE position eval (a single forward pass), so an eval label
    // says nothing -- the number that identifies a Maia line is how likely the move is. It rides
    // whichever numbering toggle is on: for a human model the probability IS the ranking, so it
    // belongs wherever a rank or a label would have gone. Both toggles off still means a bare arrow.
    if (line && line.maiaprob != null) {
        return (config.arrow_rank || config.arrow_labels) ? `${Math.round(line.maiaprob / 100)}%` : '';
    }
    if (!line || !config.arrow_labels) return '';
    if (Number.isFinite(line.mate) && line.mate !== 0) return `#${Math.abs(line.mate)}`;
    if (!Number.isFinite(line.score)) return '';
    const cp = (turn === 'w' ? 1 : -1) * line.score / 100;
    return (cp > 0 ? '+' : '') + cp.toFixed(2);
}

function draw_move(move, color, overlay, stroke_width = 0.225, rank = 0, label = '') {
    if (!move || move === '(none)') {
        overlay.lastElementChild?.remove();
        return; // hide overlay on win/loss
    } else if (stroke_width === 0) {
        return; // hide losing moves
    }

    function get_coord(square) {
        const x = square[0].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
        const y = parseInt(square[1]);
        return (board.orientation() === 'white') ? {x, y} : {x: 9 - x, y: 9 - y};
    }

    function get_coords(move) {
        const {x: x0, y: y0} = get_coord(move.substring(0, 2));
        const {x: x1, y: y1} = get_coord(move.substring(2, 4));
        return {x0, y0, x1, y1}
    }

    if (move.includes('@')) {
        const coord = get_coord(move.substring(2, 4));
        const x = 0.5 + (coord.x - 1);
        const y = 8 - (0.5 + (coord.y - 1));
        const imgX = 43 * (coord.x - 1);
        const imgY = 43 * (8 - coord.y);

        const MAX_STROKE = 0.25;
        stroke_width = 0.1 * stroke_width / MAX_STROKE;
        const stroke_diff = (MAX_STROKE - stroke_width) / 10;
        console.log("STROKE_DIFF:", MAX_STROKE, "-", stroke_width, "=", stroke_diff);

        const pieceIdentifier = turn + move[0];
        const [pieceSet, ext] = config.pieces.split('.');
        const piecePath = `/res/chesspieces/${pieceSet}/${pieceIdentifier}.${ext}`
        overlay.innerHTML += `
            <img style='position: absolute; z-index: -1; left: ${imgX}px; top: ${imgY}px; opacity: 0.4;' width='43px'
                height='43px' src='${piecePath}' alt='${pieceIdentifier}'>
            <svg style='position: absolute; z-index: -1; left: 0; top: 0;' width='344px' height='344px' viewBox='0, 0, 8, 8'>
                <circle cx='${x}' cy='${y}' r='${0.45 + stroke_diff}' fill='transparent' opacity='0.4' stroke='${color}' stroke-width='${stroke_width}' />
            </svg>
        `;
    } else {
        const coords = get_coords(move);
        const x0 = 0.5 + (coords.x0 - 1);
        const y0 = 8 - (0.5 + (coords.y0 - 1));
        const x1 = 0.5 + (coords.x1 - 1);
        const y1 = 8 - (0.5 + (coords.y1 - 1));

        const dx = x1 - x0;
        const dy = y1 - y0;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ax0 = x0 + 0.1 * ((x1 - x0) / d);
        const ay0 = y0 + 0.1 * (dy / d);
        const ax1 = x1 - 0.4 * ((x1 - x0) / d);
        const ay1 = y1 - 0.4 * (dy / d);

        const marker_id = color.replace(/[ ,()]/g, '-');
        overlay.innerHTML += `
            <svg style='position: absolute; z-index: -1; left: 0; top: 0;' width='344px' height='344px' viewBox='0, 0, 8, 8'>
                <defs>
                    <marker id='arrow-${marker_id}' markerWidth='13' markerHeight='13' refX='1' refY='7' orient='auto'>
                        <path d='M1,5.75 L3,7 L1,8.25' fill='${color}' />
                    </marker>
                </defs>
                <line x1='${ax0}' y1='${ay0}' x2='${ax1}' y2='${ay1}' stroke='${color}' fill=${color}' opacity='${arrow_alpha(0.4)}'
                    stroke-width='${stroke_width}' marker-end='url(#arrow-${marker_id})'/>
                ${arrow_badge_svg(x1, y1, color, rank, label)}
            </svg>
        `;

        if (move.length === 5) {
            const imgX = 43 * (coords.x1 - 1);
            const imgY = 43 * (8 - coords.y1);
            const pieceIdentifier = turn + move[4];
            const [pieceSet, ext] = config.pieces.split('.');
            const piecePath = `/res/chesspieces/${pieceSet}/${pieceIdentifier}.${ext}`;
            overlay.innerHTML += `
                <img style='position: absolute; z-index: -1; left: ${imgX}px; top: ${imgY}px; opacity: 0.4;' width='43px'
                    height='43px' src='${piecePath}' alt='${pieceIdentifier}'>
            `;
        }
    }
}

// The rank badge and the eval, drawn at the arrow's HEAD -- the square the move lands on, which is
// where the eye already is. Board units (the viewBox is 0..8), so it scales with the board.
function arrow_badge_svg(x1, y1, color, rank, label) {
    if (!rank && !label) return '';
    const parts = [];
    if (rank) {
        parts.push(`<circle cx='${x1}' cy='${y1 - 0.34}' r='0.17' fill='${color}' opacity='0.92'/>` +
            `<text x='${x1}' y='${y1 - 0.34}' text-anchor='middle' dominant-baseline='central'` +
            ` font-size='0.24' font-weight='700' fill='#fff'>${rank}</text>`);
    }
    if (label) {
        // escaped: a score is ours, but this string is interpolated into markup and a `#` mate is
        // one character away from being something else if the source ever changes
        const safe = String(label).replace(/[<>&]/g, '');
        parts.push(`<text x='${x1}' y='${y1 + 0.42}' text-anchor='middle' dominant-baseline='central'` +
            ` font-size='0.30' font-weight='700' fill='${color}' opacity='0.95'` +
            ` stroke='#000' stroke-width='0.05' paint-order='stroke'>${safe}</text>`);
    }
    return parts.join('');
}

function clear_annotations() {
    let move_annotation = PANEL_ROOT.getElementById('move-annotations');
    while (move_annotation.childElementCount) {
        move_annotation.lastElementChild.remove();
    }
    let response_annotation = PANEL_ROOT.getElementById('response-annotations');
    while (response_annotation.childElementCount) {
        response_annotation.lastElementChild.remove();
    }
    const net_annotation = PANEL_ROOT.getElementById('net-annotations');
    while (net_annotation && net_annotation.childElementCount) {
        net_annotation.lastElementChild.remove();
    }
}

function toggle_calculating(on) {
    prog = 0;
    is_calculating = on;
    if (is_calculating) {
        // Depth-1 streams in a few ms and replaces this line with the real eval + move (see the
        // `info depth` branch: `on_engine_best_move(arr[0], arr[1]); on_engine_evaluation(...)`).
        // Show ONLY the progress bar in the gap -- the old "Calculating..." placeholder made the
        // panel look frozen for a moment when in fact it was already searching. Anything remembered
        // from the previous position is stale, so we clear the text rather than leave it there.
        update_best_move(`<progress id='progBar' value='2' max='100'>`);
    }
}

async function dispatch_click_event(x, y, tabId, travelMs, sentAt) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        // NaN/undefined coords (e.g. a crazyhouse drop move) serialize badly and the debugger rejects them
        console.warn(`Ignoring click with invalid coordinates: (${x}, ${y})`);
        return;
    }
    if (config.python_autoplay_backend) {
        await request_backend_click(x, y); // the python clicker moves the real mouse itself
        return;
    }
    return request_debugger_click(x, y, tabId, travelMs, sentAt);
}

async function dispatch_drag_event(x1, y1, x2, y2, tabId, travelMs) {
    if (![x1, y1, x2, y2].every(Number.isFinite)) {
        console.warn(`Ignoring drag with invalid coordinates: (${x1}, ${y1}) -> (${x2}, ${y2})`);
        return;
    }
    // The python clicker moves the real mouse and has no drag verb, so fall back to the two clicks
    // it does have. That path is unchanged and still works everywhere click-click works.
    if (config.python_autoplay_backend) {
        await request_backend_click(x1, y1);
        await request_backend_click(x2, y2);
        return;
    }
    const id = await resolve_click_tab(tabId);
    try {
        const r = await chrome.runtime.sendMessage({cdpDrag: true, tabId: id, x1, y1, x2, y2, travelMs});
        if (r && r.error) console.warn('CDP drag failed:', r.error);
    } catch (e) {
        console.warn('CDP drag failed:', e);
    }
}

function resolve_click_tab(tabId) {
    // prefer the game tab (content-script sender); fall back to the active tab if unknown
    if (tabId) return Promise.resolve(tabId);
    if (MY_TAB_ID) return Promise.resolve(MY_TAB_ID);
    if (IS_CONTENT_SCRIPT) return Promise.resolve(null); // chrome.tabs doesn't exist here
    return new Promise(res => chrome.tabs.query({active: true, currentWindow: true}, t => res(t[0]?.id)));
}

async function request_debugger_click(x, y, tabId, travelMs, sentAt) {
    // chrome.debugger is NOT available to a content script (which is what this file is once the panel
    // lives in-page), so the background owns the attach + Input.dispatchMouseEvent. Still a TRUSTED
    // click -- isTrusted can't tell it from a human one (issue #35 §2). The background traces a
    // mouseMoved cursor path over travelMs before the click (M2); awaiting it paces the move.
    const id = await resolve_click_tab(tabId);
    if (!id) { console.warn('[Mephisto/bg] click dropped: no tab id resolved'); return; }
    // A click MUST settle. The caller awaits it inside the move sequence, and that sequence is what
    // clears the content-script's `moving` guard when it finishes -- so a round-trip that never
    // returns wedges every subsequent move until the 15s stale-latch budget expires. In a hidden tab
    // that is the difference between playing and stopping. Resolve either way and let the move's own
    // verification decide whether it worked; a click we cannot confirm is not worse than no click.
    // reached = content -> panel -> here. Everything before the worker is asked to do anything.
    const reachedMs = Number.isFinite(sentAt) ? Math.max(0, Date.now() - sentAt) : null;
    const settled = await Promise.race([
        do_debugger_click(id, x, y, travelMs),
        new Promise((r) => setTimeout(() => r('timeout'), CLICK_TIMEOUT_MS)),
    ]);
    if (settled === 'timeout') {
        bgTrace('click TIMED OUT', {x: Math.round(x), y: Math.round(y), ms: CLICK_TIMEOUT_MS});
        console.warn('Mephisto: CDP click did not return in time -- continuing');
        return {reachedMs, timeout: true};
    }
    return {reachedMs, ...(settled || {})};
}

// How long a single click round-trip may take before the move gives up waiting on it. Generous
// against a woken service worker, far below the stale-`moving` budget it exists to keep us out of.
const CLICK_TIMEOUT_MS = 3000;

async function do_debugger_click(id, x, y, travelMs) {
    if (document.hidden) console.log('[Mephisto/bg] CDP click ->', {tab: id, x: Math.round(x), y: Math.round(y)});
    try {
        // sentAt lets the worker measure the hop into itself -- see the note on hopWorstMs.
        const askedAt = Date.now();
        const r = await chrome.runtime.sendMessage({cdpClick: true, tabId: id, x, y, travelMs,
                                                    sentAt: askedAt});
        if (r && r.error) console.warn('CDP click failed:', r.error);
        // roundMs - workerMs = the two message hops plus whatever kept THIS realm from resuming.
        return {roundMs: Date.now() - askedAt, workerMs: r?.workerMs, disp: r?.disp, dispMs: r?.dispMs};
    } catch (e) {
        console.warn('CDP click failed:', e);
    }
}


async function request_backend_click(x, y) {
    return call_backend(`http://localhost:8080/performClick`, {x: x, y: y});
}

async function request_backend_move(x0, y0, x1, y1) {
    return call_backend('http://localhost:8080/performMove', {x0: x0, y0: y0, x1: x1, y1: y1});
}

// Both the HTTP "Remote Engine" and the serverless native engines speak the same request/response
// shape and reuse the same on_engine_response remote branch.
// Compare the newest published release against the running build and, only if it is actually newer,
// reveal the notice. Everything here fails silent: no network, a rate-limited API, a malformed reply
// or a missing element all end with the notice staying hidden. Version compare is numeric per part,
// so 3.1.9 -> 3.1.10 reads as an upgrade (a string compare would call it a downgrade).
// --- Machine calibration ------------------------------------------------------------------------
// The shipped defaults (300ms search) are a number, not a measurement: the same 300ms is a shallow
// search on a laptop and a deep one on a 24-core desktop, so "the defaults" mean different playing
// strengths on different machines. Equal NODES is the thing that travels; equal milliseconds is not.
//
// So: measure the NPS this machine actually reaches during normal play -- no separate benchmark, the
// engine already reports nps on every info line -- and work out the search time that would hit a
// reference node count. Then SUGGEST it. Silently rewriting someone's setting because a heuristic
// had an opinion is exactly the kind of surprise the house rules exist to prevent, so this offers
// the number and applies it only on a click, and only ever offers once per install.
const CALIBRATION_TARGET_NODES = 1_500_000; // ~ what 300ms buys on the reference machine
const CALIBRATION_SAMPLES = 8;              // completed searches to median before saying anything
const CALIBRATION_MIN_MS = 200, CALIBRATION_MAX_MS = 2000;
let nps_samples = [];

function record_nps_sample(nps) {
    if (nps_samples === null) return;                 // already suggested (or dismissed) this install
    if (!Number.isFinite(nps) || nps <= 0) return;
    nps_samples.push(nps);
    if (nps_samples.length >= CALIBRATION_SAMPLES) maybe_suggest_calibration();
}

function suggested_compute_time(npsMedian) {
    const ms = Math.round((CALIBRATION_TARGET_NODES / npsMedian) * 1000);
    return Math.max(CALIBRATION_MIN_MS, Math.min(CALIBRATION_MAX_MS, Math.round(ms / 50) * 50));
}

function maybe_suggest_calibration() {
    const samples = nps_samples;
    nps_samples = null;                               // one offer per install, whatever happens next
    try {
        // ONLY on a genuinely fresh install. The background sets this from chrome.runtime.onInstalled
        // with reason 'install'; a reload or an upgrade does not arm it. Without this the prompt
        // turned up mid-game on an install that had been running for months.
        if (MephistoConfig.get('calibrate_pending') !== 'true') return;
        if (MephistoConfig.get('calibrated') === 'true') return; // already answered
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const want = suggested_compute_time(median);
        // only worth mentioning if it is a real difference, not a rounding nudge.
        // NOTE the two shapes: `calibrate_pending` / `calibrated` are RAW strings -- that is how the
        // service worker writes the flag (background-script.js `{calibrate_pending: 'true'}`) and how
        // both guards above read it -- while every ordinary config key is JSON. `save` (JSON) is also
        // not in scope here: it is local to init_quick_settings, so calling it threw a ReferenceError
        // straight into the catch below and this notice has never once been shown.
        MephistoConfig.set('calibrate_pending', 'false'); // spent: offered once, taken or not
        // A DEPTH needs no calibrating -- that is the whole point of it, and the suggestion is
        // measured in milliseconds. Offering it here would write a time into a box showing plies.
        //
        // Inlined rather than calling searching_by_depth(): this whole function runs inside a
        // try/catch, so a helper that is somehow not in scope would not throw here -- it would
        // silently disable the notice, which is the exact bug the `save` note above records.
        if (config.search_mode === 'depth') return;
        if (Math.abs(want - config.compute_time) < Math.max(100, config.compute_time * 0.25)) return;
        const el = PANEL_ROOT.getElementById('calibrate-notice');
        if (!el) return;
        el.textContent = i18n('panel.calibrated', 'This machine measures {nps}M nps - ', {nps: (median / 1e6).toFixed(1)}) +
            `Search Time ${want}ms matches the reference strength (now ${config.compute_time}ms). Tap to apply.`;
        el.hidden = false;
        el.onclick = (e) => {
            e.preventDefault();
            config.compute_time = want;
            MephistoConfig.set('compute_time', JSON.stringify(want)); // ordinary config key -> JSON
            MephistoConfig.set('calibrated', 'true');                 // raw flag, read as === 'true'
            const box = PANEL_ROOT.getElementById('qs_search');
            if (box) box.value = want;
            el.hidden = true;
            push_config();
            console.log(`Mephisto: search time calibrated to ${want}ms from ${(median / 1e6).toFixed(2)}M nps`);
        };
    } catch (e) { /* a suggestion is a nicety -- never let it break the panel */ }
}

// --- WHICH ENGINE THIS MACHINE SHOULD RUN --------------------------------------------------------
// The dropdown offers every engine and no guidance, so a two-core laptop defaults into the 112MB net
// and crawls. The core count is known and the speed is MEASURED rather than guessed: the live search
// already reports nps for the engine in use, and the candidate is benched on its own offscreen
// client at a fixed depth before a word is said. Nothing switches by itself -- it is offered once,
// per install, and applied on a click.
//
// ponytail: the candidate list is two deep -- an installed native Stockfish, else the small net. A
// bench of EVERY engine would load every bundled net (half a gigabyte) to answer a question these
// two candidates already answer, and it would do it on the machine least able to afford it.
const ENGINE_ADVICE_CORES = 4;        // above this the heavy net is fine; say nothing
const ENGINE_ADVICE_MARGIN = 1.5;     // measured speed-up worth interrupting someone for
const ENGINE_ADVICE_DEPTH = 12;       // the depth floor the live nps samples are taken at, so the
                                      // two numbers compared are the same kind of measurement
const ENGINE_ADVICE_SAMPLES = 4;      // live readings before the current engine's speed is settled
const ENGINE_ADVICE_TIMEOUT = 30000;  // a bench that never finishes must not leave a client behind
const BIG_NET_WASM = ['stockfish-19-nnue', 'stockfish-18-nnue'];
// SF19's small build carries a 1.2MB net and benches MORE nodes than the full one, where SF18
// Small's was 15MB. It is the small recommendation now, and SF18 Small is not in this build.
const SMALL_NET_WASM = 'stockfish-19-small-nnue';
let advice_nps = [];                  // live nps readings for the engine in use (null once spent)

// The whole decision, with nothing to look up: every input is passed in, so it can be run.
// `nativeSf` is the id of a native Stockfish whose host answered the probe, or null.
function engine_advice({engine, cores, nativeSf, currentNps, candidateNps}) {
    if (!BIG_NET_WASM.includes(engine)) return null;   // only the heavy defaults are worth advising off
    // A native host is the same engine without the browser tax, and it is already installed -- no
    // measurement needed to prefer it, and no bench worth spending on a machine this size.
    if (nativeSf) return {engine: nativeSf, why: 'native'};
    if (!(cores > 0) || cores > ENGINE_ADVICE_CORES) return null;
    if (!(currentNps > 0) || !(candidateNps > 0)) return null;
    // MEASURED, not assumed: the small net is not automatically faster, and on a machine that keeps
    // up with the big one there is nothing to say.
    if (candidateNps < currentNps * ENGINE_ADVICE_MARGIN) return null;
    return {engine: SMALL_NET_WASM, why: 'small', currentNps, candidateNps};
}

// The first native Stockfish still visible in the dropdown. hide_unavailable_natives() has already
// hidden the ones whose host did not answer, so "visible" IS "installed" -- and reading the list
// rather than a table of engine ids keeps this working on a build with a different lineup.
function installed_native_sf() {
    const sel = PANEL_ROOT.getElementById('qs_engine');
    if (!sel) return null;
    const opt = [...sel.options].find(o => !o.hidden && /^sf/.test(o.value)
                                           && NATIVE_ENGINES.includes(o.value));
    return opt ? opt.value : null;
}

// One fixed-depth search on an ISOLATED offscreen client: its own engine instance, its own client
// id, and nothing of it reaches the panel's parser. Resolves the nps of the deepest iteration that
// reached the target depth, or null if anything at all goes wrong.
let bench_sink = null;
const bench_client = () => ENGINE_CLIENT + ':bn';
function bench_engine(engine, depth) {
    return new Promise((resolve) => {
        let done = false, nps = 0, timer = null;
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            bench_sink = null;
            try { chrome.runtime.sendMessage({toOffscreen: true, clientId: bench_client(), cmd: 'dispose'}); }
            catch (e) { /* the offscreen document is already gone */ }
            resolve(v);
        };
        bench_sink = (msg) => {
            if (msg.kind === 'error') return finish(null);
            if (msg.kind === 'ready') {
                send_bench_uci('position startpos');
                send_bench_uci(`go depth ${depth}`);
                return;
            }
            if (msg.kind !== 'line') return;
            const line = msg.line || '';
            const d = /\bdepth (\d+)/.exec(line), n = /\bnps (\d+)/.exec(line);
            if (d && n && Number(d[1]) >= depth) nps = Number(n[1]);
            if (/^bestmove\b/.test(line)) finish(nps || null);
        };
        timer = setTimeout(() => finish(null), ENGINE_ADVICE_TIMEOUT);
        try {
            chrome.runtime.sendMessage({toOffscreen: true, clientId: bench_client(), cmd: 'init',
                                        engine, variant: 'chess'});
        } catch (e) { finish(null); }
    });
}
function send_bench_uci(line) {
    try { chrome.runtime.sendMessage({toOffscreen: true, clientId: bench_client(), cmd: 'uci', line}); }
    catch (e) { /* offscreen gone; the timeout closes the bench */ }
}

function record_advice_nps(nps) {
    if (advice_nps === null || !Number.isFinite(nps) || nps <= 0) return;
    advice_nps.push(nps);
    if (advice_nps.length >= ENGINE_ADVICE_SAMPLES) maybe_advise_engine();
}

async function maybe_advise_engine() {
    const samples = advice_nps;
    advice_nps = null;                                 // one look per panel, whatever happens next
    try {
        if (MephistoConfig.get('engine_advised') === 'true') return;  // raw flag, like `calibrated`
        const cores = navigator.hardwareConcurrency || 0;
        const nativeSf = installed_native_sf();
        // The cheap answer first: an installed native needs no bench at all.
        let advice = engine_advice({engine: config.engine, cores, nativeSf, currentNps: 0, candidateNps: 0});
        if (!advice) {
            if (!BIG_NET_WASM.includes(config.engine) || !(cores > 0) || cores > ENGINE_ADVICE_CORES) return;
            // The bench competes for the very cores this is about, so it waits for an idle panel
            // rather than stealing from a search in progress.
            if (is_calculating) { advice_nps = samples; return; }   // put the samples back; try again later
            const sorted = [...samples].sort((a, b) => a - b);
            const currentNps = sorted[Math.floor(sorted.length / 2)];
            const candidateNps = await bench_engine(SMALL_NET_WASM, ENGINE_ADVICE_DEPTH);
            advice = engine_advice({engine: config.engine, cores, nativeSf, currentNps, candidateNps});
            if (advice) console.log(`Mephisto: ${config.engine} ${(currentNps / 1000).toFixed(0)}k nps here, `
                + `${SMALL_NET_WASM} ${(candidateNps / 1000).toFixed(0)}k at depth ${ENGINE_ADVICE_DEPTH}`);
        }
        MephistoConfig.set('engine_advised', 'true');   // spent: measured once, said or not
        if (!advice) return;
        show_engine_advice(advice);
    } catch (e) { /* advice is a nicety -- never let it break the panel */ }
}

function show_engine_advice(advice) {
    const el = PANEL_ROOT.getElementById('engine-notice');
    const sel = PANEL_ROOT.getElementById('qs_engine');
    if (!el || !sel) return;
    const nameOf = (id) => [...sel.options].find(o => o.value === id)?.textContent?.trim() || id;
    el.textContent = advice.why === 'native'
        ? i18n('panel.engine_advice_native',
            '{name} is installed and runs outside the browser, which is faster here. Tap to switch.',
            {name: nameOf(advice.engine)})
        : i18n('panel.engine_advice_small',
            '{cores} cores here: {from} measures {a}k nps, {to} measures {b}k. Tap to switch.',
            {cores: navigator.hardwareConcurrency || 0, from: nameOf(config.engine), to: nameOf(advice.engine),
             a: Math.round(advice.currentNps / 1000), b: Math.round(advice.candidateNps / 1000)});
    el.hidden = false;
    el.onclick = (e) => {
        e.preventDefault();
        el.hidden = true;
        // The dropdown's own change handler owns everything a switch entails (the variant coupling,
        // the budget rule, stopping the old engine, the reload). Driving it is the whole apply.
        sel.value = advice.engine;
        sel.dispatchEvent(new Event('change'));
    };
}

function check_for_update() {
    const el = PANEL_ROOT.getElementById('update-notice');
    if (!el) return;
    // WHAT CHANGED OUTRANKS EVERYTHING. Straight after a self-update, the one thing worth saying is
    // what you just got -- telling someone about the NEXT update, or about missing engines, on the
    // first panel open after an install would bury it. Shown once and cleared, and only when the
    // note is for the version actually running (a note left by a rollback is not news).
    try {
        chrome.storage.local.get('mephisto_whats_new', ({mephisto_whats_new: note}) => {
            if (chrome.runtime.lastError || !note ||
                note.version !== chrome.runtime.getManifest().version) return check_for_update_assets(el);
            chrome.storage.local.remove('mephisto_whats_new');
            el.textContent = note.headline
                ? i18n('panel.updated_to_with_note', 'Updated to v{v} - {note}',
                    {v: note.version, note: note.headline})
                : i18n('panel.updated_to', 'Updated to v{v}', {v: note.version});
            el.hidden = false;
            const url = `https://github.com/${UPDATE_REPO_SLUG}/releases/tag/v${note.version}`;
            el.href = url;
            el.onclick = (e) => { e.preventDefault(); chrome.runtime.sendMessage({openUrl: url}); };
        });
    } catch (e) { /* extension context gone */ }
}

// The original body of check_for_update: what it did before the what's-new note took precedence.
function check_for_update_assets(el) {
    if (!el) return;
    // AN INCOMPLETE INSTALL OUTRANKS AN AVAILABLE UPDATE. If the engines are missing there is no
    // point telling someone a newer version exists -- the build they have cannot run at all, and the
    // fix is the FULL archive rather than whatever is newest. Checked first, and it short-circuits.
    try {
        chrome.runtime.sendMessage({assetsCheck: true}, (res) => {
            if (chrome.runtime.lastError || !res || res.ok) return check_for_update_version(el);
            el.textContent = i18n('panel.incomplete_install',
                'Engines missing - you have the update-only download. Get the full zip.');
            el.href = `https://github.com/${UPDATE_REPO_SLUG}/releases/latest`;
            el.hidden = false;
            el.onclick = (e) => {
                e.preventDefault();
                chrome.runtime.sendMessage({openUrl: el.href});
            };
        });
    } catch (e) { /* extension context gone */ }
}

function check_for_update_version(el) {
    try {
        chrome.runtime.sendMessage({updateCheck: true}, (res) => {
            // the version compare lives in the SW (isNewer) -- one implementation, not two
            if (chrome.runtime.lastError || !res || res.error || !res.latest || !res.newer) return;
            // ALREADY INSTALLED, JUST NOT RELOADED YET. getManifest() reports the running version,
            // and a self-update writes files that Chrome has not picked up -- so `newer` stays true
            // against a version already on disk and the notice offered an update you had. The
            // installer records what it wrote; if that is the release being offered, say nothing.
            chrome.storage.local.get('mephisto_installed_version', (got) => {
                if (!chrome.runtime.lastError && got?.mephisto_installed_version === res.latest) return;
                show_update_notice(el, res);
            });
        });
    } catch (e) { /* extension context gone -- nothing to notify about */ }
}

function show_update_notice(el, res) {
    {
            el.textContent = i18n('panel.update_available', 'Update available - v{latest} (you have v{current})',
      {latest: res.latest, current: res.current});
            el.hidden = false;
            // Set the REAL destination on the anchor. Belt and braces: in the toolbar popup a plain
            // target="_blank" works on its own, and if the handler below ever fails to run, the link
            // still goes to the release rather than to whatever page the panel is sitting on.
            const url = res.url || `https://github.com/${UPDATE_REPO_SLUG}/releases/latest`;
            el.href = url;
            el.onclick = (e) => {
                e.preventDefault();   // in-page, target="_blank" is unreliable -- let the worker open it
                chrome.runtime.sendMessage({openUrl: url});
            };
            // If self-updating is already set up -- permission granted AND a folder chosen -- the
            // notice becomes the button that does it. Only THEN: with nothing set up there is no
            // one-click update to offer, and the release page is still the right destination.
            // The panel cannot run the install itself (it lives in the page's isolated world, where
            // there is no showDirectoryPicker and no access to the extension's IndexedDB), so the
            // click hands off to the worker, which opens the settings page and lets it run.
        // WHERE THE NOTICE SENDS YOU depends on whether self-updating is switched ON, not on whether
        // it happens to be fully set up (user call 2026-08-09):
        //   off            -> the release page, which is the only way to get it
        //   on + ready     -> install it, one click, no page to visit
        //   on, not ready  -> the Updates section, where the missing piece (a folder, a permission)
        //                     is chosen -- sending someone to GitHub there is sending them to do by
        //                     hand the thing they already asked the extension to do for them.
        chrome.runtime.sendMessage({updateReady: true}, (ready) => {
            if (chrome.runtime.lastError) return;
            if (ready?.ok) {
                el.textContent = i18n('panel.update_install_now',
                    'Update available - v{latest} (you have v{current}) - click to install',
                    {latest: res.latest, current: res.current});
                el.onclick = (e) => {
                    e.preventDefault();
                    chrome.runtime.sendMessage({startUpdate: true});
                };
            } else if (ready?.enabled) {
                el.textContent = i18n('panel.update_finish_setup',
                    'Update available - v{latest} - finish setting up automatic updates',
                    {latest: res.latest});
                el.onclick = (e) => {
                    e.preventDefault();
                    chrome.runtime.sendMessage({openUpdates: true});
                };
            }
        });
    }
}

// Everything worth knowing about a failure, in one paste. The worker holds the trace ring and
// the things only it can see (bundled assets, connected hosts, granted permissions); the panel
// adds what only IT knows -- what is on screen, and why it last did nothing.
//
// NOT a toolbar button: that row is absolutely positioned by id on a 45px pitch and its own
// comment does the arithmetic showing five is exactly what fits. A sixth fell out of the layout
// and landed on the board. It is a hotkey and a settings button instead.
function copy_diagnostics(onDone = () => {}) {
        const ctx = {
            site: (typeof site !== 'undefined' && site) || location.hostname,
            path: location.pathname,                       // path only: never the query string
            engine: config.engine,
            detection: PANEL_ROOT.getElementById('game-detection')?.textContent || '',
            reason: idle_reason_text,
            search: search_state(),
            fen: last_eval.fen || '',
            // Every toggle that changes what the panel DOES, including the newer ones: a report that
            // omits them cannot explain a board with an extra red line on it or a PGN full of
            // comments, and "which switches were on" is the first question any report raises.
            toggles: ['autoplay', 'premove', 'help_mode', 'manual_mode', 'humanize', 'puzzle_mode',
                      'puzzle_capture', 'puzzle_capture_cdp', 'clock_mode', 'mirror_mode',
                      'background_play', 'verbose_log', 'tablebase', 'refute', 'second_opinion',
                      'opp_prep', 'game_log', 'pv_keys', 'time_trouble',
                      'contempt', 'complexity_clock', 'human_times', 'player_book',
                      'auto_resign', 'auto_draw', 'session_stats']
                .filter(k => config[k]).join(' ') || 'none on',
            // The page-side script's own view. Without this a dead content script and a page with no
            // board produce byte-identical reports.
            content: (() => { try { return self.MephistoContent?.status?.() || 'no page script'; }
                              catch (e) { return 'status threw: ' + (e && e.message); } })(),
            // The two halves of a wrong move, which no report carried until one went unexplained:
            // WHICH answer was chosen and where it came from, and (in `content`, as lastAimed) which
            // squares the clicks were actually pointed at. Agreeing but wrong on the board means the
            // answer was wrong; disagreeing means the coordinates were.
            puzzleAnswer: last_puzzle_answer || 'none this session',
        };
        chrome.runtime.sendMessage({diagnostics: ctx}, (res) => {
            if (chrome.runtime.lastError || !res || res.error) {
                return onDone(`Mephisto diagnostics unavailable: ${chrome.runtime.lastError?.message || res?.error || 'no answer'}`);
            }
            copy_text(res.report).then(okd => onDone(okd ? '' : 'Could not write to the clipboard.'));
        });
}

function is_remote() {
    // "remote" = anything that isn't an in-browser WASM engine: HTTP remote-engine.py, a native
    // messaging host, or a cloud provider. The split happens in request_remote_* below.
    return config.engine === 'remote' || uses_native() || uses_cloud();
}

function uses_cloud() {
    return CLOUD_ENGINES.includes(config.engine);
}

// --- Native messaging over a persistent Port to the BACKGROUND worker (connectNative from a
// content script is torn down by Chrome). The Port lets the host STREAM per-depth 'info' frames
// (live depth like Stockfish), ending with a 'done' frame. Each request's onInfo gets the
// intermediate frames; the promise resolves on 'done'.
let native_bg_port = null;
let native_bg_port_name = null; // which engine that port was opened for
// Panel-local, and only ever panel-local: the service worker renumbers every request onto its own
// sequence before it reaches the shared host and renumbers the reply back on the way in. So two panels
// both counting from 1 is fine now -- which it was NOT before, when replies were broadcast and matched
// on this number at the far end, and each tab happily took the other's evaluation.
let native_seq = 0;
const native_pending = new Map(); // id -> {resolve, reject, onInfo}

// engines that speak native messaging (Chrome auto-launches the host, no server) and the port
// name that selects the host in the background worker (see NATIVE_HOSTS there)
function uses_native() {
    return NATIVE_ENGINES.includes(config.engine);
}
function native_port_name() {
    return config.engine; // sf-native / fairy-native == the host key in NATIVE_HOSTS
}

// Shut down whatever engine is running right now. Used when SELECTING a different engine: the
// offscreen WASM engine is disposed and the native host's port is closed (the background shuts the
// host down when its last port goes), so the engine you just left stops instead of idling loaded.
function stop_current_engine() {
    try { abandon_search(); } catch (e) { /* */ }
    try {
        chrome.runtime.sendMessage({toOffscreen: true, clientId: ENGINE_CLIENT, cmd: 'dispose'});
    } catch (e) { /* SW/offscreen already gone */ }
    maia2_dispose(); // the second-inference client shares the main engine's lifetime
    if (native_bg_port) {
        try { native_bg_port.disconnect(); } catch (e) { /* */ }
        native_bg_port = null;
        native_bg_port_name = null;
    }
    engine_ready = false;
    last_init_fp = null; // never let a warm-reuse fingerprint match across an engine change
}

function native_bg() {
    // The port is per ENGINE. Switching engines re-opens the panel but does not reload this script,
    // so a cached port would still be wired to the engine you switched AWAY from -- the old host
    // kept running (burning cores on a stale search) and, worse, the new engine's requests went to
    // it. Drop the port whenever the selected engine no longer matches the one it was opened for;
    // the background kills a host once its last port closes.
    const want = native_port_name();
    if (native_bg_port && native_bg_port_name !== want) {
        try { native_bg_port.disconnect(); } catch (e) { /* already gone */ }
        native_bg_port = null;
        for (const pend of native_pending.values()) pend.reject(new Error('engine switched'));
        native_pending.clear();
    }
    if (native_bg_port) return native_bg_port;
    native_bg_port_name = want;
    native_bg_port = chrome.runtime.connect({name: want});
    native_bg_port.onMessage.addListener(frame => {
        if (frame.fatal) {
            for (const p of native_pending.values()) p.reject(new Error(frame.fatal));
            native_pending.clear();
            return;
        }
        const p = native_pending.get(frame.id);
        if (!p) return;
        if (frame.error) { native_pending.delete(frame.id); p.reject(new Error(`Native engine: ${frame.error}`)); return; }
        if (frame.info) { if (p.onInfo) p.onInfo(frame.info); return; } // streamed per-depth update
        native_pending.delete(frame.id); // terminal frame (analyse 'done', or configure 'ok')
        p.resolve(frame);
    });
    native_bg_port.onDisconnect.addListener(() => {
        native_bg_port = null;
        for (const p of native_pending.values()) p.reject(new Error('Native engine background port closed'));
        native_pending.clear();
    });
    return native_bg_port;
}

function native_send(cmd, data, onInfo) {
    const id = ++native_seq;
    return new Promise((resolve, reject) => {
        native_pending.set(id, {resolve, reject, onInfo});
        try {
            native_bg().postMessage({id, cmd, ...data});
        } catch (e) {
            native_pending.delete(id);
            reject(e);
        }
    });
}

// A streamed per-depth update from a native host (already in the panel's line shape). Mirrors the
// WASM `info depth` handling: refresh the eval/best-move display live AND feed premove_tracker.
// Bound to the fen it was requested for, so late frames from a superseded search are ignored.
function on_native_info(info, fen) {
    native_alive = true;                     // it spoke, whatever else happens to this frame
    if (premove_tracker.fen !== fen) return; // stale: position already moved on
    const pvIdx = (info.multipv || 1) - 1;
    // Premove certification for the native engines: track how stable each line's reply is across
    // depths 13 / 14 / latest, exactly like the WASM `info depth` parser -- without this they'd
    // never premove, since certification is what the premove path waits on.
    // Bound by premove_lines rather than a hardcoded 2, to match the WASM parser and
    // premove_instant_reply (which scans idx < premove_lines). This is now a real width on native
    // too: on_new_pos sets premove_lines above the engine branch and the remote path configures the
    // matching MultiPV on its host, so Pondering widens the candidate list here exactly as it does
    // for WASM. It used to be capped at 2 regardless, which made the ponder width a no-op.
    // `!info.bound` is the native equivalent of the WASM parser's lowerbound/upperbound drop. An
    // aspiration re-search carries an UNRESOLVED pv -- the window failed, the engine has not settled
    // on that line -- so it must not feed certification. The hosts have always tagged these frames
    // for exactly this purpose; the flag was simply never read here, which let a late fail-low
    // re-assert an abandoned 13/14 pair and fire a premove on a reply the engine had discarded.
    // The frame still reaches the display below: depth/eval/nps are fine, only the pv is provisional.
    if (config.premove && info.pv && info.pv[0] != null
            && !info.bound && pvIdx < premove_lines && Number.isInteger(info.depth)) {
        const pred = String(info.pv[0]), reply = (info.pv[1] != null) ? String(info.pv[1]) : '';
        const line = premove_tracker.lines[pvIdx] || (premove_tracker.lines[pvIdx] = {});
        line.pvFull = pv_moves(info.pv);           // same field as the WASM parser -- shared consumer
        if (info.depth === premove_cert_prev()) line.dPrev = `${pred} ${reply}`;
        if (info.depth === premove_cert_last()) line.dLast = `${pred} ${reply}`;
        line.latest = `${pred} ${reply}`;
        line.pred = pred;
        line.reply = reply;
        line.depth = info.depth;
        if (pvIdx === 0) maybe_premove_forced_reply(line);
    }
    last_eval.activeLines = Math.max(last_eval.activeLines, info.multipv || 1);
    last_eval.lines[pvIdx] = info;
    if (pvIdx > 0 && !config.simon_says_mode) {
        render_alt_lines();
        draw_moves(); // same as the WASM path: without this only line 1 ever gets an arrow
    }
    if (pvIdx === 0) {
        on_engine_evaluation(last_eval);
        if (info.pv && info.pv[0]) {
            on_engine_best_move(info.pv[0], info.pv[1], false); // live arrow, non-terminal
        } else if (is_calculating) {
            // An info line with a score but NO pv (a dead-drawn or terminal position) left the
            // progress bar in the move line forever, so the panel looked like it was still loading
            // while the eval and depth were plainly updating. Say what's actually happening instead.
            is_calculating = false;
            update_best_move(Number.isInteger(info.depth)
        ? i18n('panel.msg.searching_depth', 'Searching (depth {depth})', {depth: info.depth})
        : i18n('panel.msg.searching', 'Searching'));
        }
    }
}

// Replay a UCI move list onto a starting position, because a cloud provider takes a position and
// nothing else. Returns null rather than a wrong board if any move does not fit -- an answer to the
// wrong position is worse than no answer, and that is precisely the bug this exists to prevent.
function cloud_fen_after(startFen, moves) {
    const list = String(moves || '').trim().split(/\s+/).filter(Boolean);
    if (!list.length) return startFen;
    try {
        const c = new Chess(config.variant, startFen);
        for (const uci of list) {
            // not `rec`: the ladder bans a bare `const rec = c.move(` file-wide, because in
            // forced_chain that shape was a guard that could never run (chess.js throws)
            const applied = c.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
            if (!applied) return null;
        }
        return c.fen();
    } catch (e) {
        return null;
    }
}

async function request_remote_configure(options) {
    if (uses_native()) return native_send('configure', {options});
    // A cloud provider has no options to set: one request in, one line out. Silently doing nothing
    // is right here -- posting these to localhost:9090 would hit whatever else is on that port.
    if (uses_cloud()) return null;
    return call_backend('http://localhost:9090/configure', options).then(parse_backend_json);
}

async function request_remote_analysis(fen, time, moves = null, depth = null) {
    if (uses_native()) {
        // guard streamed frames by the ACTUAL position (moves-mode passes startFen here, but
        // premove_tracker.fen holds the real current fen), so late frames don't leak across moves
        const posFen = premove_tracker.fen;
        // `time` travels WITH a depth, deliberately. The host applies both as one python-chess
        // Limit, where the time is the ceiling that stops an unreachable depth running forever on a
        // slow machine -- and a native search cannot be called back, so an unbounded one is not
        // merely slow, it is unstoppable (see NATIVE_MAX_RT).
        // `nodes` is the Analysis Limit's third unit. A host that predates it ignores the key and
        // searches to the time it was given, which is the same search one notch less precise --
        // never a wrong one.
        return native_send('analyse', {fen, time, moves, depth, nodes},
            info => on_native_info(info, posFen), ourTurn);
    }
    if (uses_cloud()) {
        // MOVES MODE. On a real game this is called with the game's START position and the moves
        // played since -- what remote-engine.py and the native hosts take, and what carries the
        // repetition history a bare FEN cannot. A cloud provider takes ONE fen and has nowhere to
        // put a move list, so the moves are applied here first. Dropping them is what shipped in
        // 3.1.260, and it meant every cloud answer after the first move was an answer to the
        // STARTING position -- "best move is d2d4" beside a game that had left the opening.
        const target = cloud_fen_after(fen, moves);
        if (!target) throw new Error('could not work out the current position for the cloud engine');
        // Time where the provider has somewhere to put it (chess-api's maxThinkingTime), depth
        // otherwise; the worker clamps depth to each provider's own ceiling.
        const res = await chrome.runtime.sendMessage({cloudAnalyse: {
            engine: config.engine, fen: target, depth: depth || null,
            thinkMs: depth ? null : (time || null),
        }});
        if (!res) throw new Error('the cloud engine did not answer (is the extension still loaded?)');
        if (res.error) throw new Error(res.error);
        return res;
    }
    return call_backend('http://localhost:9090/analyse', {
        fen: fen,
        moves: moves,
        time: time,
        depth: depth,
    }).then(parse_backend_json);
}

async function parse_backend_json(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        // an unrelated server on the port answers with HTML ("<!doctype ...") - surface that instead of a SyntaxError
        throw new Error(`Remote engine at ${res.url} did not return JSON - is remote-engine.py running on that port?`);
    }
}

function on_remote_error(err) {
    console.error(err);
    update_best_move(err.message);
    toggle_calculating(false);
}

async function call_backend(url, data) {
    return fetch(url, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-cache',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
}

// the content-script calls this to boot the panel inside its closed shadow root
self.MephistoPanel = {
    initPanel,
    isBooted: () => PANEL_BOOTED,
    // the drag-select overlay (content-script) hands back a crop in image pixels; re-run the
    // recognise path with board detection skipped
    snapWithCrop: (crop) => { snap_position(crop).catch(e => console.warn('Mephisto: snap failed', e)); },
    // the floating panel's title bar owns the compact toggle; the panel owns the state
    toggleCompact: () => toggle_compact(),
    // the content-script's keydown listener dispatches hotkey actions here; returns whether it was
    // handled, so the listener only swallows the key then (see do_hotkey / the keydown listener).
    hotkey: (action) => { try { return do_hotkey(action); } catch (e) { console.warn('Mephisto: hotkey failed', e); return false; } },
    // content-script.js pushes positions/clocks straight in (same realm, no messaging)
    // returns the handler's value so a click can be awaited (the click branch returns its dispatch promise)
    // A THROW IN HERE IS INVISIBLE, and that is how a dead panel looks exactly like a quiet one:
    // on_new_pos clears the annotations at the top and redraws them at the bottom, so an exception
    // between the two wipes the arrows and never puts them back -- on every poll, forever, with a
    // console.warn in the PAGE's console that no diagnostics report has ever carried. Trace it.
    onContentMessage: (msg) => {
        try {
            return PANEL_MSG_HANDLER && PANEL_MSG_HANDLER(msg, {});
        } catch (e) {
            console.warn('Mephisto: content->panel failed', e);
            bgTrace('PANEL THREW', {
                on: Object.keys(msg || {}).slice(0, 4).join(','),
                error: String(e && e.message || e),
                // the frame that actually threw, which is the whole point of surfacing this
                at: String(e && e.stack || '').split('\n').slice(1, 4).map(l => l.trim()).join(' | '),
            });
        }
    },
    // Called by the content-script when the panel closes (X button, panel-style change, page unload).
    // Closing means CLOSED. abandon_search() stops the search, PANEL_BOOTED=false makes every
    // incoming position push inert, the engine is shut down, and the held position is forgotten.
    //
    // The engine used to be kept warm here so reopening skipped the net reload / host relaunch --
    // USER CALL: that is not the trade they want. A closed panel now costs nothing at all, and
    // reopening pays a normal engine init.
    //
    // The captured/typed position used to survive too, restored on the next open. Same call: closing
    // is how you say you are done with it. The stash still carries a position across a same-session
    // panel REBUILD (changing Engine or Variant tears the panel down and puts it straight back), which
    // is a different thing and was a real bug when it lost your board -- that behaviour stays.
    suspend: () => {
        try { abandon_search(); } catch (e) { /* ignore */ }
        try { dispose_threat_human(); } catch (e) { /* ignore */ }
        setup_fen = null; snap_crop = null; setup_view = null;
        try { snap_follow_stop(); } catch (e) { /* ignore */ }
        try { stash_setup_state(); } catch (e) { /* ignore */ } // setup_fen is null -> clears the stash
        try { stop_current_engine(); } catch (e) { /* ignore */ }
        // Drop any manual turn override so reopening auto-adjusts to the current position's real side.
        turn_override = null;
        turn_detected_prev = null;
        PANEL_BOOTED = false;
    },
    // Header king-switch tap: flip the manual side-to-move override from whatever's currently shown.
    // Sticky per position (held across re-scrapes of the same board so you can toggle back and forth),
    // auto-cleared when a real move changes the side or on close. Re-analyses immediately.
    flipTurn: () => {
        // A manually held position (screenshot capture, pasted FEN, or a move played on the panel
        // board) never goes through the scrape path -- that's where turn_override is applied, and it
        // returns early while setup_fen is set. So flip THIS position's turn directly and re-analyse,
        // or the switch is dead exactly when you most need it: a captured board is assumed white to
        // move, and without this you could never move the black pieces.
        if (setup_fen) {
            const flipped = flip_fen_turn(setup_fen);
            if (!is_legal_position(flipped)) return; // handing the move over would be illegal
            setup_fen = flipped;
            const input = PANEL_ROOT.getElementById('setup_fen_input');
            if (input) input.value = flipped;
            turn = flipped.split(' ')[1];
            set_turn_switch(turn);
            try { abandon_search(); } catch (e) { /* */ }
            last_eval.fen = '';
            on_new_pos(flipped, flipped, '');
            return;
        }
        const cur = (last_eval.fen && last_eval.fen.split(' ')[1]) === 'b' ? 'b' : 'w';
        turn_override = (cur === 'w') ? 'b' : 'w';
        set_turn_switch(turn_override); // instant feedback; the re-analysis repaints it from the FEN
        try { abandon_search(); } catch (e) { /* */ }
        last_eval.fen = '';
        push_config();
    },
};
})();
