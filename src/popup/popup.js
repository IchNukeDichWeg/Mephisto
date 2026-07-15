import {Chess} from '../../lib/chess.js';

// the tab this popup iframe was injected into (passed by the content-script). Everything this popup
// sends/receives is scoped to THIS tab, so a background tab's popup can't drive the foreground tab
// or turn on its modes. Null only if opened before the content-script learned its id (falls back).
const MY_TAB_ID = parseInt(new URLSearchParams(location.search).get('tab'), 10) || null;

let engine;
let board;
let fen_cache;
let config;

let is_calculating = false;
let discard_stale_search = false; // drop engine output (incl. the flushed bestmove) of a search we stopped
let search_active = false; // a 'go' was issued whose bestmove hasn't arrived yet (is_calculating can't be
                           // used for this: it flips false on the first info line, not on bestmove)
let premove_tracker = {fen: '', lines: {}}; // per-multipv reply stability while the opponent thinks
let prog = 0;
let last_eval = {fen: '', activeLines: 0, lines: []};
let last_clocks = null;   // {mine, theirs, increment, at} scraped off the page (Clock Mode)
let last_our_eval = null; // our-perspective cp after our previous move (humanize criticality)
let opp_clock_mark = null; // opponent's clock when their turn started...
let opp_spend = null;      // ...so their spend on their LAST move = mark - now (Clock Mode mirroring)
// UCI_Elo [min, max] per engine, from each engine's own source (out-of-range values are silently
// ignored by Stockfish, so the slider stays within these): modern SF = 1320/3190; SF 11 = 1350/2850;
// Fairy-SF 14 = 500/2850.
const ELO_RANGE = {
    'stockfish-dev-nnue': [1320, 3190],
    'stockfish-18-nnue': [1320, 3190],
    'stockfish-18-small-nnue': [1320, 3190],
    'stockfish-11-hce': [1350, 2850],
    'fairy-stockfish-14-nnue': [500, 2850],
    'sf-native': [1320, 3190], 'fairy-native': [500, 2850], // full-power native engines (opt-in)
    'remote': [1320, 3190], // unknown engine; assume the modern SF range
};
// Sits above every engine's ceiling (max is 3190), so it reads as "no cap / full strength". Both
// slider ends map to full strength: 0 on the left (Off) and this on the right.
const FULL_STRENGTH_ELO = 3200;
// Slider stops: index 0 = 0 (Off / full strength), then the engine's range in 50-Elo steps with the
// true max always included, and FULL_STRENGTH_ELO as the final right-hand "max+" stop.
function elo_stops(engine) {
    const [min, max] = ELO_RANGE[engine] || [1320, 3190];
    const stops = [0];
    for (let e = min; e < max; e += 50) stops.push(e);
    stops.push(max);
    stops.push(FULL_STRENGTH_ELO);
    return stops;
}

// Opt-in full-power native engines (Chrome auto-launches the host; see native-host/install-native.sh).
// The default WASM engines need NO setup -- these are extra options for users who install a native
// Stockfish/Fairy binary. Engine value == host key in the background worker's NATIVE_HOSTS.
const NATIVE_ENGINES = ['sf-native', 'fairy-native'];
const FAIRY_ENGINES = ['fairy-stockfish-14-nnue', 'fairy-native']; // offer the full variant list
// when a native engine is INSTALLED, its slower WASM equivalents are hidden from the dropdown (files
// stay; the option is just hidden). Probed cheaply via the host's `ping`. native slug -> WASM ids.
const NATIVE_SUPERSEDES = {
    'sf-native': ['stockfish-dev-nnue', 'stockfish-18-nnue', 'stockfish-18-small-nnue', 'stockfish-11-hce'],
    'fairy-native': ['fairy-stockfish-14-nnue'],
};
const SUPERSEDED_BY = {};
for (const [slug, wasms] of Object.entries(NATIVE_SUPERSEDES)) for (const w of wasms) SUPERSEDED_BY[w] = slug;

let turn = ''; // 'w' | 'b'

// --- Background keep-alive --------------------------------------------------------------------
// Chrome throttles timers in a hidden tab and freezes it after ~5 min, so alt-tabbing to another
// app (or a fullscreen window) mid-game would stall autoplay. A tab that is playing audio is exempt
// from both, so while Autoplay is on we run a single inaudible tone. Browsers require a user gesture
// to start audio, so this is (re)started from the popup's own clicks and on visibility changes
// (once the user has interacted, sticky activation lets resume() work even after tabbing away).
let keep_alive_ctx = null;
function keep_alive(active) {
    try {
        if (active) {
            if (!keep_alive_ctx) {
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

document.addEventListener('DOMContentLoaded', async function () {
    // load extension configurations from localStorage
    const computeTime = JSON.parse(localStorage.getItem('compute_time'));
    const fenRefresh = JSON.parse(localStorage.getItem('fen_refresh'));
    const thinkTime = JSON.parse(localStorage.getItem('think_time'));
    const thinkVariance = JSON.parse(localStorage.getItem('think_variance'));
    const moveTime = JSON.parse(localStorage.getItem('move_time'));
    const moveVariance = JSON.parse(localStorage.getItem('move_variance'));
    const autoplay = JSON.parse(localStorage.getItem('autoplay'));
    const computerEval = JSON.parse(localStorage.getItem('computer_evaluation'));
    // engines dropped in this version — migrate stale selections to the current default
    const REMOVED_ENGINES = ['stockfish-6', 'stockfish-16-nnue-40', 'stockfish-16-nnue-7', 'lc0', 'stockfish-17-nnue-79'];
    let storedEngine = JSON.parse(localStorage.getItem('engine'));
    if (REMOVED_ENGINES.includes(storedEngine)) storedEngine = null;
    config = {
        // general settings
        engine: storedEngine || 'stockfish-dev-nnue',
        variant: JSON.parse(localStorage.getItem('variant')) || 'chess',
        elo: JSON.parse(localStorage.getItem('elo')) || 0, // strength cap; 0 = full strength (no UCI_LimitStrength)
        compute_time: (computeTime != null) ? computeTime : 300,
        fen_refresh: (fenRefresh != null) ? fenRefresh : 1000, // FALLBACK poll; positions arrive event-driven
        multiple_lines: JSON.parse(localStorage.getItem('multiple_lines')) || 1,
        threads: JSON.parse(localStorage.getItem('threads')) || 8,
        memory: JSON.parse(localStorage.getItem('memory')) || 512,
        think_time: (thinkTime != null) ? thinkTime : 0,
        think_variance: (thinkVariance != null) ? thinkVariance : 0,
        move_time: (moveTime != null) ? moveTime : 200,
        move_variance: (moveVariance != null) ? moveVariance : 50,
        humanize: JSON.parse(localStorage.getItem('humanize')) || false,
        clock_mode: JSON.parse(localStorage.getItem('clock_mode')) || false,
        mirror_mode: JSON.parse(localStorage.getItem('mirror_mode')) || false,
        computer_evaluation: (computerEval != null) ? computerEval : true,
        threat_analysis: JSON.parse(localStorage.getItem('threat_analysis')) || false,
        simon_says_mode: JSON.parse(localStorage.getItem('simon_says_mode')) || false,
        autoplay: (autoplay != null) ? autoplay : false,
        premove: JSON.parse(localStorage.getItem('premove')) || false,
        puzzle_mode: JSON.parse(localStorage.getItem('puzzle_mode')) || false,
        help_mode: JSON.parse(localStorage.getItem('help_mode')) || false,
        eval_bar: JSON.parse(localStorage.getItem('eval_bar')) || false,
        python_autoplay_backend: JSON.parse(localStorage.getItem('python_autoplay_backend')) || false,
        // appearance settings
        pieces: JSON.parse(localStorage.getItem('pieces')) || 'wikipedia.svg',
        board: JSON.parse(localStorage.getItem('board')) || 'brown',
        coordinates: JSON.parse(localStorage.getItem('coordinates')) || false,
        dark_mode: JSON.parse(localStorage.getItem('dark_mode')) || false,
    };
    document.body.classList.toggle('mephisto-dark', config.dark_mode); // dark theme (set in Appearance)
    // keep autoplay running when the tab is backgrounded: start/resume the keep-alive tone on any
    // panel click and whenever visibility flips, so it's already playing before you tab away
    document.addEventListener('pointerdown', () => { if (config.autoplay) keep_alive(true); }, true);
    document.addEventListener('visibilitychange', () => { if (config.autoplay) keep_alive(true); });
    keep_alive(config.autoplay); // arms/suspends to match the persisted setting (resumes on first gesture)
    push_config();
    init_quick_settings();
    maybe_autodetect_variant(); // variant game page -> auto-apply the variant (+ Fairy) once

    // init chess board
    document.getElementById('board').classList.add(config.board);
    const [pieceSet, ext] = config.pieces.split('.');
    board = ChessBoard('board', {
        position: 'start',
        pieceTheme: `/res/chesspieces/${pieceSet}/{piece}.${ext}`,
        appearSpeed: 'fast',
        moveSpeed: 'fast',
        showNotation: config.coordinates,
        draggable: false
    });

    // init fen LRU cache
    fen_cache = new LRU(100);

    // init engine webworker
    await initialize_engine();

    // listen to messages from content-script
    chrome.runtime.onMessage.addListener(function (response, sender) {
        // the content-script broadcasts (runtime.sendMessage) reach EVERY tab's popup -- ignore any
        // that came from a different tab's content-script so tabs never cross-talk. (Background
        // messages have no sender.tab and pass through.)
        if (MY_TAB_ID && sender.tab && sender.tab.id !== MY_TAB_ID) return;
        if (response.fenresponse) { // reply received -> the poll interval may fire the next request
            fen_request_inflight = false;
            clearTimeout(fen_request_timer);
            if (response.clocks) last_clocks = {...response.clocks, at: Date.now()}; // for Clock Mode budgeting
        }
        if (response.fenresponse && response.dom && response.dom !== 'no') {
            if (board.orientation() !== response.orient) {
                board.orientation(response.orient);
            }
            let parsed;
            try {
                parsed = parse_position_from_response(response.dom);
            } catch (e) {
                console.warn('Mephisto: skipping unparseable scrape:', e.message);
                return; // transient scrape garbage — the next poll (100ms) retries
            }
            const {fen, startFen, moves} = parsed;
            if (!is_legal_position(fen)) {
                // a corrupt/transient scrape (mid-animation, wrong turn guess) can yield an
                // illegal position; feeding one to the wasm engine crashes it (OOB). Skip it.
                console.warn('Mephisto: skipping illegal scraped position:', fen);
                return;
            }
            if (last_eval.fen !== fen) {
                // Clock Mode mirroring: bookkeep the opponent's clock at turn boundaries. When a
                // position lands on OUR turn, they just moved -- their spend = their clock at the
                // start of their turn minus now (they get the increment back after moving). When it
                // lands on THEIR turn, our move went through -- mark where their clock starts.
                const ourColor = (board.orientation() === 'white') ? 'w' : 'b';
                if (turn === ourColor) {
                    opp_spend = (opp_clock_mark != null && last_clocks?.theirs != null)
                        ? Math.max(0, opp_clock_mark - last_clocks.theirs + (last_clocks.increment || 0))
                        : null;
                } else if (last_clocks?.theirs != null) {
                    opp_clock_mark = last_clocks.theirs;
                }
                // check BEFORE on_new_pos: chain/tracker belong to the position we were analysing.
                const instant = premove_instant_reply(fen, moves);
                on_new_pos(fen, startFen, moves);
                if (instant) {
                    // SAFETY: only play a certified reply if it moves OUR piece and (on our turn)
                    // is legal right now -- never click the opponent's move or an illegal move.
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
        } else if (response.click) {
            console.log(response);
            // click the GAME tab (the content-script's sender tab), not whatever tab is active --
            // otherwise a move firing while you're on another tab (e.g. chrome://extensions) dispatches
            // there and fails ("Cannot access a chrome:// URL").
            dispatch_click_event(response.x, response.y, sender?.tab?.id);
        }
    });

    // FALLBACK poll only: the content-script pushes positions event-driven (MutationObserver);
    // this slow poll just heals a missed push (e.g. a mutation the observer filter skipped).
    // Clamped to >=1s so a legacy saved fen_refresh (10ms era) can't reinstate the old
    // 100-scrapes-a-second polling stampede.
    request_fen();
    setInterval(function () {
        request_fen();
    }, Math.max(1000, config.fen_refresh));

    // register button click listeners
    document.getElementById('analyze').addEventListener('click', () => {
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
        window.open(`https://lichess.org/analysis/${variant}?fen=${last_eval.fen}`, '_blank');
    });
    document.getElementById('config').addEventListener('click', () => {
        window.open('/src/options/options.html', '_blank');
    });
    // force re-detection: an SPA can swap games without any reload (e.g. a rematch), and if a
    // scrape ever goes stale this rescans the page and restarts the analysis from scratch
    document.getElementById('recheck')?.addEventListener('click', () => {
        last_eval.fen = '';   // treat whatever comes back as a brand-new position
        send_engine_uci('stop');
        push_config();        // resets the content-script's push dedupe + triggers an immediate push
        request_fen();        // and poll right now as well
    });

    // initialize materialize
    M.Tooltip.init(document.querySelectorAll('.tooltipped'), {});
});

function init_quick_settings() {
    const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    // toggles apply live
    for (const [id, key] of [['qs_autoplay', 'autoplay'], ['qs_premove', 'premove'],
                             ['qs_puzzle', 'puzzle_mode'], ['qs_help', 'help_mode'],
                             ['qs_evalbar', 'eval_bar'], ['qs_humanize', 'humanize'],
                             ['qs_clock', 'clock_mode'], ['qs_mirror', 'mirror_mode']]) {
        const elem = document.getElementById(id);
        if (!elem) continue; // stale cached popup.html mid-update; don't let one missing control kill the popup
        elem.checked = config[key];
        elem.addEventListener('change', () => {
            config[key] = elem.checked;
            save(key, elem.checked);
            keep_alive(config.autoplay); // this change is a user gesture -> can (re)start the tone now
            if (key === 'help_mode' && !elem.checked) request_clear_hint();
            if (key === 'eval_bar' && !elem.checked) request_clear_eval_bar();
            if (key === 'humanize' && !is_remote()) {
                // humanize picks among alternative lines, so it needs MultiPV headroom;
                // re-apply and restart the search under the new setting
                send_engine_uci('stop');
                send_engine_uci(`setoption name MultiPV value ${effective_multipv()}`);
                last_eval.fen = '';
            }
            if (key === 'help_mode' || key === 'autoplay' || key === 'clock_mode' || key === 'mirror_mode') {
                // the go mode (infinite vs movetime) / search budget depends on these; abandon the
                // current search and re-analyse the position under the new mode on the next push
                send_engine_uci('stop');
                last_eval.fen = '';
            }
            push_config();
        });
    }
    // timing settings apply live: compute_time is read at every 'go', think/move times are pushed to the page
    for (const [id, key] of [['qs_search', 'compute_time'],
                             ['qs_move', 'move_time'], ['qs_move_var', 'move_variance']]) {
        const elem = document.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            const value = Math.max((key === 'compute_time') ? 50 : 0, parseInt(elem.value) || 0);
            config[key] = value;
            save(key, value);
            push_config();
        });
    }
    // engine settings need a full engine re-init; reload the popup, it re-reads localStorage
    for (const [id, key, parse] of [
        ['qs_engine', 'engine', v => v],
        ['qs_variant', 'variant', v => v],
        ['qs_fen', 'fen_refresh', v => Math.max(1000, parseInt(v) || 1000)], // fallback poll, floor 1s (see interval clamp)
        ['qs_threads', 'threads', v => parseInt(v) || 8],
        ['qs_memory', 'memory', v => parseInt(v) || 512],
        ['qs_lines', 'multiple_lines', v => parseInt(v) || 1],
    ]) {
        const elem = document.getElementById(id);
        if (!elem) continue;
        elem.value = config[key];
        elem.addEventListener('change', () => {
            // only Fairy-Stockfish plays fairy variants; other engines force standard chess so the
            // net + legality checks stay correct -- EXCEPT Chess960, which every mainline Stockfish
            // plays via UCI_Chess960 (sent at engine init), so it survives an engine switch.
            if (key === 'engine' && !FAIRY_ENGINES.includes(parse(elem.value))
                && !['chess', 'fischerandom'].includes(config.variant)) save('variant', 'chess');
            save(key, parse(elem.value));
            location.reload();
        });
    }
    // The Variant selector: full list for Fairy-Stockfish; Standard + Chess960 for everything else
    // (mainline SF speaks UCI_Chess960). The "detect" button reads the variant off the page.
    // hide WASM engines whose native equivalent is installed: apply the cached result instantly,
    // then re-probe (ping only, cheap) if never checked or stale. Files are never touched.
    const engineSel = document.getElementById('qs_engine');
    if (engineSel) {
        let cached = {};
        try { cached = JSON.parse(localStorage.getItem('native_available')) || {}; } catch (e) { /* */ }
        apply_native_availability(engineSel, new Set(cached.avail || []));
        if (!cached.at || Date.now() - cached.at > 600000) refresh_native_availability(engineSel);
    }
    const variantRow = document.getElementById('qs_variant_row');
    if (variantRow) {
        const fairy = FAIRY_ENGINES.includes(config.engine);
        variantRow.style.display = '';
        document.querySelectorAll('#qs_variant option').forEach(o => {
            o.hidden = !fairy && !['chess', 'fischerandom'].includes(o.value);
        });
    }
    const detectBtn = document.getElementById('qs_variant_detect');
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
    const eloSlider = document.getElementById('qs_elo');
    const eloLabel = document.getElementById('qs_elo_val');
    if (eloSlider && eloLabel) {
        const stops = elo_stops(config.engine);
        const idxOf = (elo) => { // nearest stop to the stored Elo
            if (!(elo > 0)) return 0;                              // Off (far left)
            if (elo >= FULL_STRENGTH_ELO) return stops.length - 1; // max+ (far right)
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
            // the right-hand full-strength stop shows the engine's OWN ceiling, not the 3200 sentinel
            eloLabel.textContent = v === 0 ? 'Off / Full Strength'
                : v >= FULL_STRENGTH_ELO ? `${stops[stops.length - 2]}+ / Full Strength` : v;
        };
        paint();
        eloSlider.addEventListener('input', paint);
        eloSlider.addEventListener('change', () => { save('elo', stops[+eloSlider.value]); location.reload(); });
    }
    // range sliders show their value in the label while dragging ('change' above still does the
    // save+reload when the thumb is released)
    for (const id of ['qs_lines', 'qs_threads', 'qs_memory']) {
        const slider = document.getElementById(id);
        const label = document.getElementById(`${id}_val`);
        if (!slider || !label) continue;
        label.textContent = slider.value;
        slider.addEventListener('input', () => { label.textContent = slider.value; });
    }
}

async function initialize_engine() {
    discard_stale_search = false; // a crashed engine never flushes its bestmove; don't eat the new engine's first result
    search_active = false;
    const engineMap = {
        'stockfish-dev-nnue': 'stockfish-dev/sf_dev.js',
        'stockfish-18-nnue': 'stockfish-18/sf_18.js',
        'stockfish-18-small-nnue': 'stockfish-18-small/sf_18_smallnet.js',
        'stockfish-11-hce': 'stockfish-11-hce/sfhce.js',
        'fairy-stockfish-14-nnue': 'fairy-stockfish-14/fsf14.js',
    }
    const enginePath = `/lib/engine/${engineMap[config.engine]}`;
    const engineBasePath = enginePath.substring(0, enginePath.lastIndexOf('/'));
    if (['stockfish-dev-nnue', 'stockfish-18-nnue', 'stockfish-18-small-nnue', 'fairy-stockfish-14-nnue', 'stockfish-11-hce'].includes(config.engine)) {
        if (typeof SharedArrayBuffer === 'undefined') {
            // the stockfish builds are pthread builds; without cross-origin isolation their
            // worker just dies with an opaque "worker sent an error! undefined:undefined"
            update_best_move('Engine blocked: this page does not provide SharedArrayBuffer '
                + '(cross-origin isolation). Try the Remote Engine, or report which site this happened on.', '');
            return;
        }
        const module = await import(enginePath);
        engine = await module.default();
        engine.listen = (message) => on_engine_response(message);
        engine.onError = (message) => on_engine_error(message);
        if (config.engine.includes('nnue')) {
            async function fetchNnueModels(engine, engineBasePath) {
                if (config.engine !== 'fairy-stockfish-14-nnue') {
                    const nnues = [];
                    for (let i = 0; ; i++) {
                        let nnue = engine.getRecommendedNnue(i);
                        if (!nnue || nnues.includes(nnue)) break;
                        nnues.push(nnue);
                    }
                    return await Promise.all(nnues.map(nnue => fetch_nnue(engineBasePath, nnue)));
                } else {
                    const variantNnueMap = {
                        'chess': 'nn-46832cfbead3.nnue',
                        'fischerandom': 'nn-46832cfbead3.nnue',
                        'crazyhouse': 'crazyhouse-8ebf84784ad2.nnue',
                        'kingofthehill': 'kingofthehill-978b86d0e6a4.nnue',
                        '3check': '3check-cb5f517c228b.nnue',
                        'antichess': 'antichess-dd3cbe53cd4e.nnue',
                        'atomic': 'atomic-2cf13ff256cc.nnue',
                        'horde': 'horde-28173ddccabe.nnue',
                        'racingkings': 'racingkings-636b95f085e3.nnue',
                    };
                    const variantNnue = variantNnueMap[config.variant];
                    const nnue_response = await fetch(`${engineBasePath}/nnue/${variantNnue}`);
                    return [await nnue_response.arrayBuffer()];
                }
            }

            if (config.engine === 'fairy-stockfish-14-nnue') {
                send_engine_uci(`setoption name UCI_Variant value ${config.variant}`);
            }
            const nnues = await fetchNnueModels(engine, engineBasePath);
            nnues.forEach((model, i) => engine.setNnueBuffer(new Uint8Array(model), i))
        }
    }

    if (is_remote()) {
        request_remote_configure({
            // remote-engine.py skips options the engine doesn't declare, so this is safe everywhere
            ...(config.variant === 'fischerandom' ? {"UCI_Chess960": true} : {}),
            // variant for the native Fairy host (engines without UCI_Variant just ignore it)
            ...(config.variant && config.variant !== 'chess' ? {"UCI_Variant": config.variant} : {}),
            ...(config.elo > 0 && config.elo <= 3190 ? {"UCI_LimitStrength": true, "UCI_Elo": config.elo} : {}),
            "Hash": config.memory,
            "Threads": config.threads,
            "MultiPV": config.multiple_lines,
        }).catch(on_remote_error);
    } else {
        send_engine_uci(`setoption name Hash value ${config.memory}`);
        send_engine_uci(`setoption name Threads value ${config.threads}`);
        send_engine_uci(`setoption name MultiPV value ${effective_multipv()}`);
        // Chess960: a mainline Stockfish must be told, or it treats the game as standard chess and
        // mishandles castling whenever the king/rooks aren't on their normal files. (Fairy-Stockfish
        // already gets this from its 'fischerandom' UCI_Variant above, so only the SF engines need it.)
        if (config.variant === 'fischerandom' && config.engine !== 'fairy-stockfish-14-nnue') {
            send_engine_uci('setoption name UCI_Chess960 value true');
        }
        // Strength cap: Stockfish/Fairy clamp UCI_Elo to their own range. 0 = full strength (Off),
        // and the "max+" slider stop sits above every ceiling -> also full strength (limiting off).
        const eloMax = (ELO_RANGE[config.engine] || [1320, 3190])[1];
        if (config.elo > 0 && config.elo <= eloMax) {
            send_engine_uci('setoption name UCI_LimitStrength value true');
            send_engine_uci(`setoption name UCI_Elo value ${config.elo}`);
        } else {
            send_engine_uci('setoption name UCI_LimitStrength value false');
        }
        send_engine_uci('ucinewgame');
        send_engine_uci('isready');
    }
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

let engine_restarts = 0;
let engine_restarting = false;

function on_engine_error(message) {
    console.error(message);
    if (engine_restarting) return;
    if (!/RuntimeError|Aborted|worker sent an error/.test(String(message))) return;
    if (engine_restarts >= 3) {
        // ponytail: cap restarts — a build that keeps trapping (some wasm builds on some machines) shouldn't loop forever
        update_best_move('Engine keeps crashing — pick a different engine in Settings.', '');
        return;
    }
    engine_restarts++;
    engine_restarting = true;
    engine = null; // drop the dead instance; send_engine_uci becomes a no-op meanwhile
    update_best_move(`Engine crashed — restarting (attempt ${engine_restarts}/3)`, '');
    initialize_engine()
        .then(() => { last_eval = {fen: '', activeLines: 0, lines: []}; }) // force re-analysis on next fen poll
        .catch((e) => console.error('Engine restart failed:', e))
        .finally(() => engine_restarting = false);
}

function on_engine_best_move(best, threat, isTerminal=false) {
    if (is_remote()) {
        last_eval.activeLines = last_eval.lines.length;
    }

    console.log('EVALUATION:', JSON.parse(JSON.stringify(last_eval)));
    const piece_name_map = {P: 'Pawn', R: 'Rook', N: 'Knight', B: 'Bishop', Q: 'Queen', K: 'King'};
    const toplay = (turn === 'w') ? 'White' : 'Black';
    const next = (turn === 'w') ? 'Black' : 'White';
    if (!best || best === '(none)') { // game over (or crashed search) — there is no move to draw or play
        const pvLine = last_eval.lines[0] || {};
        if ('mate' in pvLine) {
            update_evaluation('Checkmate!');
            if (config.variant === 'antichess') {
                update_best_move(`${toplay} Wins`, '');
            } else {
                update_best_move(`${next} Wins`, '');
            }
        } else {
            update_evaluation('Stalemate!');
            if (config.variant === 'antichess') {
                update_best_move(`${toplay} Wins`, '');
            } else {
                update_best_move('Draw', '');
            }
        }
        clear_next_move_eta(); // game over: no move coming, drop any countdown started at search time
        toggle_calculating(false);
        return;
    } else if (config.simon_says_mode) {
        if (toplay.toLowerCase() === board.orientation()) {
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
        if (config.threat_analysis && threat && threat !== '(none)') {
            update_best_move(`${toplay} to play, best move is ${best}`, `Best response for ${next} is ${threat}`);
        } else {
            update_best_move(`${toplay} to play, best move is ${best}`, '');
        }
    }

    if (toplay.toLowerCase() === board.orientation()) {
        last_eval.bestmove = best;
        last_eval.threat = threat;
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
            }
        }
        if (!config.help_mode && config.autoplay && isTerminal) {
            // SAFETY: only autoplay a move that actually moves OUR piece and is legal right now.
            // If the turn was mis-scraped we'd otherwise play the opponent's best move as ours.
            if (premove_reply_playable(last_eval.fen, best)) {
                // humanize: maybe swap in a close alternative + a human-looking think delay;
                // a clock-aware mode alone still shapes the timing (budget / opponent mirror).
                // Never in puzzle mode, whose PV playback must follow the engine line exactly.
                if ((config.humanize || clock_aware()) && !config.puzzle_mode) {
                    const pick = humanize_pick(best);
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
                    request_automove(best); // in help mode draw_moves() mirrors the arrows instead
                }
            } else {
                console.warn('Mephisto: not autoplaying a move that is not ours/legal here:', best);
            }
        }
    }

    if (!config.simon_says_mode) {
        draw_moves();
        if (config.threat_analysis) {
            draw_threat()
        }
    }

    toggle_calculating(false);
}

function update_eval_bar(line) {
    const bar = document.getElementById('eval-bar-white');
    if (!bar || !line) return;
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

    // mirror the bar onto the site board (chess.com-style: score inside, on the winning side's end)
    if (config.eval_bar) {
        const text = ('mate' in line) ? `M${Math.abs(line.mate)}` : (Math.abs(line.score) / 100).toFixed(1);
        request_draw_eval_bar({frac, text, winningWhite: frac >= 0.5});
    }
}

function on_engine_evaluation(info) {
    if (!info.lines[0]) return;
    update_eval_bar(info.lines[0]);

    if ('mate' in info.lines[0]) {
        update_evaluation(`Checkmate in ${info.lines[0].mate}`);
    } else {
        update_evaluation(`Score: ${info.lines[0].score / 100.0} at depth ${info.lines[0].depth}`)
    }
    render_alt_lines();
}

// pv arrives as a space-joined STRING from the wasm engines but as a LIST of UCI moves from
// remote-engine.py (it formats python-chess pv arrays) -- normalize before any .split use
function pv_moves(pv) {
    return Array.isArray(pv) ? pv.map(String) : (pv || '').split(' ');
}

// first few moves of a UCI pv as SAN, for the alternative-lines panel
function san_preview(fen, pv, plies = 6) {
    const ucis = pv_moves(pv).slice(0, plies);
    try {
        const chess = new Chess(config.variant, fen);
        return ucis.map(u => chess.move({from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4]}).san).join(' ');
    } catch (e) {
        return ucis.join(' '); // variant/parse hiccup -> raw UCI is still useful
    }
}

// the panel under the board: one row per engine line (eval + start of the line) when the
// Multi Lines slider asks for more than one; hidden otherwise
function render_alt_lines() {
    const panel = document.getElementById('alt-lines');
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
        const evalTxt = ('mate' in line) ? `#${line.mate}` : (line.score / 100).toFixed(2);
        rows.push(`<div class="alt-line"><span class="alt-eval">${evalTxt}</span> ` +
            `<span class="alt-moves">${san_preview(last_eval.fen, line.pv)}</span></div>`);
    }
    panel.innerHTML = rows.join('');
}

function on_engine_response(message) {
    console.log('on_engine_response', message);
    if (is_remote()) {
        last_eval = Object.assign(last_eval, message);
        on_engine_evaluation(last_eval);
        on_engine_best_move(last_eval.bestmove, last_eval.threat, true);
        return;
    }

    if (discard_stale_search) {
        // output of the search we just stopped; UCI ordering ends it with its flushed bestmove
        if (message.startsWith('bestmove')) discard_stale_search = false;
        return;
    }

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
        // (our reply to the predicted opponent move) is across depths 6 / 9 / latest
        if (config.premove && lineInfo.pv && pvIdx <= 1 && Number.isInteger(lineInfo.depth)) {
            const [pred, reply] = lineInfo.pv.split(' ');
            const line = premove_tracker.lines[pvIdx] || (premove_tracker.lines[pvIdx] = {});
            if (lineInfo.depth === 6) line.d6 = `${pred} ${reply}`;
            if (lineInfo.depth === 9) line.d9 = `${pred} ${reply}`;
            line.latest = `${pred} ${reply}`;
            line.pred = pred;
            line.reply = reply;
            line.depth = lineInfo.depth;
            if (pvIdx === 0) maybe_premove_forced_reply(line);
        }
        last_eval.activeLines = Math.max(last_eval.activeLines, lineInfo.multipv);
        if (pvIdx === 0) {
            // continuously show the best move for each depth
            if (last_eval.lines[0] != null) {
                const arr = last_eval.lines[0].pv.split(' ');
                const best = arr[0];
                const threat = arr[1];
                on_engine_best_move(best, threat);
            }
            // reset lines
            last_eval.lines = new Array(config.multiple_lines);
            // trigger an evaluation update
            last_eval.lines[pvIdx] = lineInfo;
            on_engine_evaluation(last_eval);
        } else {
            last_eval.lines[pvIdx] = lineInfo;
            render_alt_lines(); // alternative lines land AFTER the pv-1 reset; keep the panel current
        }
    }

    if (is_calculating) {
        prog++;
        let progMapping = 100 * (1 - Math.exp(-prog / 30));
        document.getElementById('progBar')?.setAttribute('value', `${Math.round(progMapping)}`);
    }
}

function is_legal_position(fen) {
    let chess;
    try {
        chess = new Chess(config.variant, fen);
    } catch (e) {
        return false; // chess.js could not parse the FEN
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
    return true;
}

// "Premove" without the blunder risk: while the opponent thinks we certify a reply to their
// PREDICTED move (max 2 candidate lines). It only fires if the new position is EXACTLY the
// predicted one -- any other move discards the table and searches normally, so a wrong guess
// costs nothing. Certification = the reply is identical at depth 6, depth 9 and the latest
// depth (>= 10). Residual risk is only a marginally weaker (still certified) move, never a
// move meant for a different position.
// Final gate before ANY premove reply is clicked: it must move OUR piece, and when it is already
// our turn (an instant reply, not a premove queued during the opponent's turn) it must be fully
// legal right now. This rejects a stale/mismatched reply that would otherwise click the opponent's
// move or an illegal move.
function premove_reply_playable(fen, uci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci ?? '')) return false;
    try {
        const chess = new Chess(config.variant, fen);
        const our = (board.orientation() === 'white') ? 'w' : 'b';
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
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return;
    if (line.depth < 10 || !line.d6 || line.d6 !== line.d9 || line.d6 !== line.latest) return;
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) return;
    const mover = (premove_tracker.fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover === board.orientation()) return; // only while the opponent is to move
    if (premove_tracker.safe === undefined) {
        // cached per position; certification pins (pred, reply) via the depth-6 snapshot,
        // so at most one pair can ever be checked here per position
        premove_tracker.safe = premove_is_safe(premove_tracker.fen, line.pred, line.reply);
    }
    if (!premove_tracker.safe) return;
    // Humanize: hold premoves that aren't a true recapture / forced reply (see premove_human_reflex)
    if (config.humanize && !premove_human_reflex(premove_tracker.fen, line.pred, line.reply)) return;
    premove_tracker.premoved = true;
    console.log('Premove: reply cannot misfire (forced/bound to predicted move) -- premoving', line.reply);
    request_automove(line.reply);
}

function premove_instant_reply(new_fen, new_moves) {
    if (!config.premove || !config.autoplay) return null;
    if (config.help_mode || config.puzzle_mode || config.simon_says_mode) return null;
    if (premove_tracker.premoved) return null; // already queued as a real site premove
    if (!premove_tracker.fen || premove_tracker.fen !== last_eval.fen) return null;
    const mover = (new_fen.split(' ')[1] === 'w') ? 'white' : 'black';
    if (mover !== board.orientation()) return null; // the certified reply must be OUR move
    let certified = 0;
    for (const idx of [0, 1]) {
        const line = premove_tracker.lines[idx];
        if (!line || line.depth < 10 || !line.d6 || line.d6 !== line.d9 || line.d6 !== line.latest) continue;
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(line.reply ?? '')) continue;
        certified++;
        // primary match: the exact MOVE, per the premove contract -- robust across sites
        // (fen-string reconstruction proved fragile on some site DOMs)
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

function on_new_pos(fen, startFen, moves) {
    console.log("on_new_pos", fen, startFen, moves);
    clear_next_move_eta(); // the countdown belonged to the position that just changed
    humanize_roll = null;  // and so did any pre-rolled humanize outcome
    if (config.help_mode) request_clear_hint(); // position changed; last hint is stale
    premove_tracker = {fen: fen, startFen: startFen || fen, moves: moves || '', lines: {}}; // certifications belong to exactly one position
    const search_in_flight = search_active;
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
    search_start = Date.now();
    // start the countdown NOW (the search fills the pace), on our turn, when a mode changes the
    // base time -- so the full time counts down while the engine thinks. Category is added once the
    // move is picked. Cleared at the top of this function, so a non-pacing move shows nothing.
    if (config.autoplay && !config.help_mode && !config.puzzle_mode
        && ((turn === 'w') ? 'white' : 'black') === board.orientation()) {
        const est = estimated_move_total_ms(fen);
        if (est) {
            // pre-roll the humanize outcome so the countdown shows the coming move from the start
            if (config.humanize) humanize_roll = roll_humanize_category(fen);
            set_move_countdown(search_start + est.ms, est.source, humanize_roll ? humanize_roll.category : null);
        }
    }
    if (is_remote()) {
        if (moves) {
            request_remote_analysis(startFen, movetime, moves).then(on_engine_response).catch(on_remote_error);
        } else {
            request_remote_analysis(fen, movetime).then(on_engine_response).catch(on_remote_error);
        }
    } else {
        if (search_in_flight) {
            // 'stop' makes the engine flush a bestmove for the position it was searching. By the
            // time it arrives, `turn` already belongs to the NEW position -- if the old search was
            // for the opponent's side (they replied mid-search), that stale bestmove would be
            // automoved as OUR move. Discard everything up to and including that flushed bestmove.
            discard_stale_search = true;
        }
        send_engine_uci('stop');
        if (moves) {
            send_engine_uci(`position fen ${startFen} moves ${moves}`);
        } else {
            send_engine_uci(`position fen ${fen}`);
        }
        if (config.help_mode || !config.autoplay) {
            send_engine_uci('go infinite'); // pure analysis: keep deepening until the position changes
        } else {
            send_engine_uci(`go movetime ${movetime}`); // autoplay needs a final bestmove to act on
        }
        search_active = true;
    }

    board.position(fen);
    clear_annotations();
    if (config.simon_says_mode) {
        const toplay = (turn === 'w') ? 'White' : 'Black';
        if (toplay.toLowerCase() !== board.orientation()) {
            draw_moves();
            request_console_log('Best Move: ' + last_eval.bestmove);
        }
    }
    last_eval = {fen, activeLines: 0, lines: new Array(config.multiple_lines),
        lastMove: moves ? moves.trim().split(' ').pop() : null}; // opp's last move (humanize recapture check)
}

function parse_position_from_response(txt) {
    const prefixMap = {
        li: 'Game detected on Lichess.org',
        cc: 'Game detected on Chess.com',
        bt: 'Game detected on BlitzTactics.com'
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

    function parse_position_from_pieces(txt) {
        const directHit = fen_cache.get(txt);
        if (directHit) { // reuse position
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        const chess = new Chess(config.variant);
        chess.clear(); // clear the board so we can place our pieces
        const [playerTurn, ...pieces] = txt.split('*****').slice(0, -1);
        for (const piece of pieces) {
            const attributes = piece.split('-');
            chess.put({type: attributes[1], color: attributes[0]}, attributes[2]);
        }
        chess.setTurn(playerTurn);
        turn = chess.turn();

        // a mid-animation scrape or wrong turn guess can yield a position where the side to move
        // could capture the king — searching such a position crashes the stockfish wasm (OOB)
        const opponent = (turn === 'w') ? 'b' : 'w';
        if (chess._isKingAttacked(opponent)) {
            throw Error('illegal position scraped (opponent king en prise)');
        }

        const record =  {fen: chess.fen()};
        fen_cache.set(txt, record);
        return record;
    }

    const metaTag = txt.substring(3, 8);
    const prefix = metaTag.substring(0, 2);
    document.getElementById('game-detection').innerText = prefixMap[prefix];
    txt = txt.substring(11);

    if (metaTag.includes('var')) {
        if (txt.includes('&')) { // a custom start position is shipped along (chess960 / "From Position")
            const puzTxt = txt.substring(0, txt.indexOf('&'));
            const fenTxt = txt.substring(txt.indexOf('&') + 6);
            let startFen = parse_position_from_pieces(puzTxt).fen;
            if (config.variant === 'fischerandom') {
                startFen = startFen.replace('-', 'KQkq'); // chess960 always starts with full castling rights
            }
            return parse_position_from_moves(fenTxt, startFen);
        }
        return parse_position_from_moves(txt);
    } else if (metaTag.includes('puz')) { // chess.com & blitztactics.com puzzle pages
        return parse_position_from_pieces(txt);
    } else { // chess.com and lichess.org pages
        return parse_position_from_moves(txt);
    }
}

function update_evaluation(eval_string) {
    if (eval_string != null && config.computer_evaluation) {
        document.getElementById('evaluation').innerHTML = eval_string;
    }
}

function update_best_move(line1, line2) {
    if (line1 != null) {
        document.getElementById('chess_line_1').innerHTML = line1;
    }
    if (line2 != null) {
        document.getElementById('chess_line_2').innerHTML = line2;
    }
}

function send_to_active_tab(message) {
    // read lastError so "Receiving end does not exist" (no content-script on tab) stays unlogged
    if (MY_TAB_ID) { // normal path: talk to OUR tab only, even when it's in the background
        chrome.tabs.sendMessage(MY_TAB_ID, message, () => void chrome.runtime.lastError);
        return;
    }
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) { // fallback: no tab id yet
        if (!tabs[0]?.id) return;
        chrome.tabs.sendMessage(tabs[0].id, message, () => void chrome.runtime.lastError);
    });
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

function effective_multipv() {
    // humanize picks among alternatives, so it quietly searches a few extra lines; the DISPLAY
    // still honours config.multiple_lines
    return config.humanize ? Math.max(3, config.multiple_lines) : config.multiple_lines;
}

// Humanize move mix in PERCENT (top/second/third/mistake/blunder, summing to 100), tuned by the
// five sliders in the options page. Read fresh from localStorage on EVERY pick: the options page
// and this popup share the extension's localStorage, so changes apply to the very next move --
// no reload needed. Normalized here so hand-edited storage can't break the roll.
function humanize_rates() {
    const get = (key, dflt) => {
        try {
            const v = JSON.parse(localStorage.getItem(key));
            return (v != null && isFinite(+v)) ? Math.max(0, +v) : dflt;
        } catch (e) {
            return dflt;
        }
    };
    const r = {
        top: get('humanize_top', 50),         // the engine's best move
        second: get('humanize_second', 40),   // second line (unless way worse)
        third: get('humanize_third', 4),      // third line (unless way worse)
        mistake: get('humanize_mistake', 5),  // 60-150cp worse
        blunder: get('humanize_blunder', 1),  // 150-450cp worse, never in decided games
    };
    const sum = r.top + r.second + r.third + r.mistake + r.blunder;
    if (sum > 0) for (const k in r) r[k] = r[k] * 100 / sum;
    return r;
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
    const rates = humanize_rates();
    const r = Math.random() * 100;
    const t = rates.top, s = t + rates.second, th = s + rates.third, mi = th + rates.mistake;
    let category = 'top engine';
    if (r < t) category = 'top engine';
    else if (r < s) category = 'second line';
    else if (r < th) category = 'third line';
    else if (r < mi) category = 'mistake';
    else category = 'blunder';
    return {r, category};
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

// per-move time budget in ms from the scraped clock, or null when no clock-aware mode is on
// (or the clock is unreadable). ~T/30 + 60% of the increment, never more than T/8.
function clock_budget_ms() {
    if (!clock_aware() || !last_clocks || last_clocks.mine == null) return null;
    const elapsed = (Date.now() - last_clocks.at) / 1000; // the scrape is a moment old
    const T = Math.max(1, last_clocks.mine - elapsed);
    const I = last_clocks.increment || 0;
    return Math.max(120, Math.min((T / 30 + 0.6 * I) * 1000, T * 1000 / 8));
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
        ms = opp_spend * 900;                                     // mirror: 90% of their spend
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
        // second/third line only when not way worse (>60cp) -- otherwise the roll falls to best
        const closeEnough = (l) => (l && loss(l) <= 60) ? l : null;
        let cand = null;
        if (r < rates.top) {
            // the best move
        } else if (r < rates.top + rates.second) {
            cand = closeEnough(alts[0]);
            if (cand) category = 'second line';
        } else if (r < rates.top + rates.second + rates.third) {
            cand = closeEnough(alts[1]);
            if (cand) category = 'third line';
        } else if (r < rates.top + rates.second + rates.third + rates.mistake) {
            const pool = alts.filter(l => loss(l) > 60 && loss(l) <= 150);
            cand = pool[Math.floor(Math.random() * pool.length)];
            if (cand) category = 'mistake';
        } else if (Math.abs(bestCp) < 600) { // blunder share; never in decided games
            const pool = alts.filter(l => loss(l) > 150 && loss(l) <= 450);
            cand = pool[Math.floor(Math.random() * pool.length)];
            if (cand) category = 'blunder';
        }
        if (cand && playable(cand.move)) move = cand.move;
        else category = 'top engine'; // gate failed / pool empty / not playable -> best move after all
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
            think = opp_spend * 900; // 90% of their spend, in ms
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
        const el = document.getElementById('next-move');
        if (!el) { clearInterval(eta_timer); return; }
        const left = eta_target - Date.now();
        const suffix = eta_category ? ` · ${eta_category}` : ''; // humanize: which move it plays next
        if (left <= 50) {
            el.textContent = `Playing now (${eta_source})${suffix}`;
            clearInterval(eta_timer);
            return;
        }
        el.textContent = `Playing in ${(left / 1000).toFixed(1)}s (${eta_source})${suffix}`;
    };
    tick();
    eta_timer = setInterval(tick, 100);
}

function clear_next_move_eta() {
    clearInterval(eta_timer);
    eta_target = 0;
    const el = document.getElementById('next-move');
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

function request_automove(move, think = null) {
    // Is this a REAL move on our own turn, or a BLIND premove during the opponent's turn? The site
    // queues a blind premove (it won't appear in the move list until they move), so it must NOT be
    // verified/retried; an on-turn move must be. The popup is authoritative here -- decide from the
    // position's side-to-move (== our colour) rather than letting the content-script re-derive the
    // turn from fragile DOM highlights (which throws on e.g. the lichess analysis board, silently
    // skipping verification). last_eval.fen is the current position (on_new_pos ran before this).
    const our = (board.orientation() === 'white') ? 'w' : 'b';
    const verify = (last_eval.fen?.split(' ')[1] === our);
    const deselect = safe_deselect_square(last_eval.fen, move);
    const message = (config.puzzle_mode)
        ? {automove: true, pv: last_eval.lines[0]?.pv ? pv_moves(last_eval.lines[0].pv) : [move], deselect, verify}
        : {automove: true, move: move, deselect, verify, think};
    send_to_active_tab(message);
}

function request_console_log(message) {
    send_to_active_tab({consoleMessage: message});
}

function request_draw_hint(arrows) {
    send_to_active_tab({drawHint: true, arrows: arrows});
}

function request_clear_hint() {
    send_to_active_tab({clearHint: true});
}

// ask the content-script to read the variant off the current game page; cb(variant | null)
function request_detect_variant(cb) {
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

// apply a detected variant: set it AND switch to the Fairy engine when the variant requires it.
// Without the engine switch, detection was a no-op on a non-Fairy engine -- the variant was saved
// but the engine analysed the board as standard chess.
function apply_detected_variant(v) {
    localStorage.setItem('variant', JSON.stringify(v));
    if (needs_fairy_engine(v) && config.engine !== 'fairy-stockfish-14-nnue') {
        localStorage.setItem('engine', JSON.stringify('fairy-stockfish-14-nnue'));
    }
    location.reload();
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
        const targetEngine = needs_fairy_engine(v) ? 'fairy-stockfish-14-nnue' : config.engine;
        if (config.variant === v && config.engine === targetEngine) return; // already correct
        const key = 'mephisto.autodetected:' + href;
        try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* */ }
        console.log('Mephisto: auto-detected variant', v, '-> applying (was', config.variant + '/' + config.engine + ')');
        apply_detected_variant(v);
    });
}


function request_draw_eval_bar(data) {
    send_to_active_tab({drawEvalBar: true, ...data});
}

function request_clear_eval_bar() {
    send_to_active_tab({clearEvalBar: true});
}

function push_config() {
    send_to_active_tab({pushConfig: true, config: config});
}

function draw_moves() {
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
    for (let i = 0; i < last_eval.activeLines; i++) {
        if (!last_eval.lines[i]) continue;

        const arrow_color = (i === 0) ? '#004db8' : '#4a4a4a';
        const stroke_width = strokeFunc(last_eval.lines[i]);
        draw_move(last_eval.lines[i].move, arrow_color, document.getElementById('move-annotations'), stroke_width);
        if (config.help_mode && stroke_width > 0 && last_eval.lines[i].move) {
            hint_arrows.push({move: last_eval.lines[i].move, width: stroke_width, color: arrow_color});
        }
    }
    if (config.help_mode) {
        if (config.threat_analysis && last_eval.threat && last_eval.threat !== '(none)') {
            hint_arrows.push({move: last_eval.threat, width: 0.2, color: '#bf0000'});
        }
        request_draw_hint(hint_arrows);
    }
}

function draw_threat() {
    if (last_eval.threat) {
        draw_move(last_eval.threat, '#bf0000', document.getElementById('response-annotations'));
    }
}

function draw_move(move, color, overlay, stroke_width = 0.225) {
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
                <line x1='${ax0}' y1='${ay0}' x2='${ax1}' y2='${ay1}' stroke='${color}' fill=${color}' opacity='0.4'
                    stroke-width='${stroke_width}' marker-end='url(#arrow-${marker_id})'/>
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

function clear_annotations() {
    let move_annotation = document.getElementById('move-annotations');
    while (move_annotation.childElementCount) {
        move_annotation.lastElementChild.remove();
    }
    let response_annotation = document.getElementById('response-annotations');
    while (response_annotation.childElementCount) {
        response_annotation.lastElementChild.remove();
    }
}

function toggle_calculating(on) {
    prog = 0;
    is_calculating = on;
    if (is_calculating) {
        update_best_move(`<div>Calculating...<div><progress id='progBar' value='2' max='100'>`, '');
    }
}

async function dispatch_click_event(x, y, tabId) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        // NaN/undefined coords (e.g. a crazyhouse drop move) serialize badly and the debugger rejects them
        console.warn(`Ignoring click with invalid coordinates: (${x}, ${y})`);
        return;
    }
    if (config.python_autoplay_backend) {
        await request_backend_click(x, y);
    } else {
        await request_debugger_click(x, y, tabId);
    }
}

function resolve_click_tab(tabId) {
    // prefer the game tab (content-script sender); fall back to the active tab if unknown
    if (tabId) return Promise.resolve(tabId);
    return new Promise(res => chrome.tabs.query({active: true, currentWindow: true}, t => res(t[0]?.id)));
}

async function request_debugger_click(x, y, tabId) {
    resolve_click_tab(tabId).then((id) => {
        if (!id) return;
        const debugee = {tabId: id};
        chrome.debugger.attach(debugee, '1.3', async () => {
            // "Another debugger is already attached" is expected: we stay attached after the first click
            void chrome.runtime.lastError;
            await dispatch_mouse_event(debugee, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                button: 'left',
                clickCount: 1,
                x: x,
                y: y,
            });
            await dispatch_mouse_event(debugee, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                button: 'left',
                clickCount: 1,
                x: x,
                y: y,
            });
        });
    });
}

async function dispatch_mouse_event(debugee, mouseEvent, mouseEventOpts) {
    return new Promise(resolve => {
        chrome.debugger.sendCommand(debugee, mouseEvent, mouseEventOpts, (result) => {
            if (chrome.runtime.lastError) {
                console.warn(`${mouseEvent} failed: ${chrome.runtime.lastError.message}`);
            }
            resolve(result);
        });
    });
}

async function request_backend_click(x, y) {
    return call_backend(`http://localhost:8080/performClick`, {x: x, y: y});
}

async function request_backend_move(x0, y0, x1, y1) {
    return call_backend('http://localhost:8080/performMove', {x0: x0, y0: y0, x1: x1, y1: y1});
}

function is_remote() {
    return config.engine === 'remote' || uses_native();
}

// --- Native messaging transport (opt-in native Stockfish/Fairy) -------------------------------
// Chrome auto-launches the host; the background worker relays a persistent Port both ways so the
// host can STREAM per-depth 'info' frames, ending with a terminal frame (analyse 'done' /
// configure 'ok'). No server, no setup for the default WASM engines.
let native_bg_port = null;
let native_seq = 0;
const native_pending = new Map(); // id -> {resolve, reject, onInfo}

function uses_native() {
    return NATIVE_ENGINES.includes(config.engine);
}
function native_port_name() {
    return config.engine; // sf-native / fairy-native == the host key in NATIVE_HOSTS
}

// Probe whether a native host is installed & alive, via a `ping` that does NOT launch the engine.
function probe_native(portName, timeoutMs = 2500) {
    return new Promise(resolve => {
        let done = false, port;
        const finish = (ok) => { if (!done) { done = true; try { port.disconnect(); } catch (e) {} resolve(ok); } };
        try { port = chrome.runtime.connect({name: portName}); } catch (e) { return resolve(false); }
        port.onMessage.addListener(f => finish(!!(f && f.ok)));
        port.onDisconnect.addListener(() => finish(false));
        try { port.postMessage({id: 0, cmd: 'ping'}); } catch (e) { finish(false); }
        setTimeout(() => finish(false), timeoutMs);
    });
}
// Hide the WASM option whose native equivalent is installed (never the selected one, so the select
// can't blank out). Applied from cache for an instant UI, then refreshed by a probe.
function apply_native_availability(sel, availSet) {
    if (!sel) return;
    sel.querySelectorAll('option').forEach(o => {
        const slug = SUPERSEDED_BY[o.value];
        if (slug) o.hidden = availSet.has(slug) && o.value !== sel.value;
    });
}
async function refresh_native_availability(sel) {
    const slugs = Object.keys(NATIVE_SUPERSEDES);
    const results = await Promise.all(slugs.map(s => probe_native(s)));
    const avail = slugs.filter((s, i) => results[i]);
    localStorage.setItem('native_available', JSON.stringify({at: Date.now(), avail}));
    apply_native_availability(sel, new Set(avail));
}

function native_bg() {
    if (native_bg_port) return native_bg_port;
    native_bg_port = chrome.runtime.connect({name: native_port_name()});
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
        native_pending.delete(frame.id); // terminal frame
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

// A streamed per-depth update from a native engine (already in the popup line shape, pv as an
// array). Mirrors the WASM `info depth` handling: refresh eval/best-move live AND feed the premove
// tracker. Bound to the fen it was requested for, so late frames from a superseded search are dropped.
function on_native_info(info, fen) {
    if (premove_tracker.fen !== fen) return;
    const pvIdx = (info.multipv || 1) - 1;
    if (config.premove && Array.isArray(info.pv) && pvIdx <= 1 && Number.isInteger(info.depth)) {
        const pred = info.pv[0], reply = info.pv[1];
        const line = premove_tracker.lines[pvIdx] || (premove_tracker.lines[pvIdx] = {});
        if (info.depth === 6) line.d6 = `${pred} ${reply}`;
        if (info.depth === 9) line.d9 = `${pred} ${reply}`;
        line.latest = `${pred} ${reply}`;
        line.pred = pred; line.reply = reply; line.depth = info.depth;
        if (pvIdx === 0) maybe_premove_forced_reply(line);
    }
    last_eval.activeLines = Math.max(last_eval.activeLines, info.multipv || 1);
    last_eval.lines[pvIdx] = info;
    if (pvIdx === 0) {
        on_engine_evaluation(last_eval);
        if (info.pv && info.pv[0]) on_engine_best_move(info.pv[0], info.pv[1], false);
    } else {
        render_alt_lines();
    }
}

async function request_remote_configure(options) {
    if (uses_native()) return native_send('configure', {options});
    return call_backend('http://localhost:9090/configure', options).then(parse_backend_json);
}

async function request_remote_analysis(fen, time, moves = null) {
    if (uses_native()) {
        const posFen = premove_tracker.fen; // bind streamed frames to the real current position
        return native_send('analyse', {fen, time, moves}, info => on_native_info(info, posFen));
    }
    return call_backend('http://localhost:9090/analyse', {
        fen: fen,
        moves: moves,
        time: time,
    }).then(parse_backend_json);
}

async function parse_backend_json(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        // an unrelated server on the port answers with HTML ("<!doctype ...") — surface that instead of a SyntaxError
        throw new Error(`Remote engine at ${res.url} did not return JSON — is remote-engine.py running on that port?`);
    }
}

function on_remote_error(err) {
    console.error(err);
    update_best_move(err.message, '');
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
