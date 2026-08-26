// Chess.com's OWN post-game classifier, run locally.
//
// WHAT THIS IS. When a game ends on chess.com, the free post-game card (Book / Best / Excellent /
// Blunder, accuracy, the coach's sentence) is produced entirely in your browser -- measured: zero
// worker messages before the game ends, 1,275 immediately after, and not one server request carries
// any analysis. Five workers do it: four `stockfish-18-lite-single` at `go depth 10` with MultiPV 2,
// one position each, and one `explanation-engine` WASM that turns those evals into the verdict.
//
// WHY IT IS NOT BUNDLED. explanation-engine.wasm is 28.7 MB and is Chess.com's commercial Torch
// engine (its own strings say TORCH_LICENSE_OWNER / KOMODO_TEP), so shipping a copy in a public
// release would be redistributing a licensed binary. It is fetched from chess.com's own CDN on
// request, behind a button, and cached here afterwards. Exactly the bytes their page loads.
//
// WHY A SANDBOXED PAGE. The engine is an Emscripten build whose glue calls eval(), and an MV3
// extension page may not have 'unsafe-eval'. A sandboxed page may -- and its own default CSP has
// `child-src 'self'`, which blocks the blob worker, so the manifest widens that too. Both blocks
// were hit in that order; neither is optional.
// The build we ship against. A newer one found by eeCheckUpdate() overrides it and is remembered,
// so EE_VERSION is the FLOOR, not necessarily what is installed -- read eeVersion() for that.
const EE_VERSION = '1.124.57';
let eeVer = EE_VERSION;
const eeBase = (v = eeVer) => `https://www.chess.com/r2/assets-chess-engine/explanation-engine/${v}/default/`;
const EE_DB = 'mephisto-ee';
const EE_STORE = 'assets';

// CHESS.COM'S OWN STOCKFISH, optional and downloaded the same way. Their classifier is only as
// faithful as the evals it is fed, and ours are not theirs: our closest build still disagrees on a
// few moves per game because a 30-60cp difference at depth 10 moves a move across a class boundary.
// This is the engine that removes that variable -- "Stockfish 18 Lite WASM", official Stockfish 18,
// small net, single-threaded, GPLv3 (so unlike the classifier it COULD be shipped; it is fetched
// anyway, to keep the two halves of this feature on one rule and the download opt-in).
const SF_BUILD = 'stockfish-18-lite-single-a7c6773';
// The engine chess.com's GAME REVIEW runs, as opposed to the post-game card's. Their settings page
// calls it "Stockfish 16"; the asset on their own CDN is 16.1, and they serve four of them --
// lite/full x single/threaded. FOUND by probing their CDN, not guessed.
//
// THE FULL NET, not the lite one, and that is the single biggest accuracy lever here. Measured over
// ten games x 16 moves a side against chess.com's own Game Review:
//     lite  depth 18  92.19%      lite  depth 24  93.44%
//     lite  depth 22  93.44%      lite  depth 26  94.06%
//     FULL  depth 18  95.31%      FULL  depth 22  97.40%
// The full net at depth 18 beats the lite net at depth 26 while running six times faster, so the
// net was the ceiling all along, not the depth. It costs 69 MB instead of 7 MB; it is an opt-in
// download behind a button, and the accuracy is why.
const SF16_BUILD = 'stockfish-16.1-single';
const SF16_LITE = 'stockfish-16.1-lite-single';   // their smaller build, kept for the record
const SF_BASE = 'https://www.chess.com/r2/assets-chess-engine/Stockfish/';
// chess.com serves more than Stockfish from the same root -- Torch 4 lives under /Torch/. A build
// id containing a slash is taken as a path from the assets root; a bare one keeps the Stockfish
// folder, so the ids already cached stay valid and nobody re-downloads.
const sfUrl = (build) => build.includes('/')
    ? SF_BASE.replace(/Stockfish\/$/, '') + build
    : SF_BASE + build;

// The five ways to run the classifier. The first reproduces chess.com's free post-game card exactly
// -- their engine, their depth, their line count. The other four are chess.com's own Game Review
// strength tiers, and they are DEPTHS, not times.
//
// That is chess.com's own word, not an inference from the numbers looking depth-shaped. Their
// settings select carries 18/22/24/26, and their analysis bundle maps exactly those four:
//     function t9e(e){switch(e){case 18:return Gz.Strength.Fast;case 22:return Gz.Strength.Standard;
//                              case 24:return Gz.Strength.Deep;case 26:return Gz.Strength.Maximum;}}
// and carries the value throughout as `analysisDepth`, including in what they post to their own
// metrics endpoint: `{analysisDepth: Number(d.analysisDepth), engineType: ...Stockfish16}`.
// The DOM id is `settings-analysis-time`, which is misleading -- the property is the depth.
// No `go depth 22` is ever seen in the browser because the Game Review search runs on their server.
//
// Depth is also the better unit for us: the same depth is the same answer on any machine, which a
// seconds budget is not.
// `match` is the measured agreement over NINE DIVERSE GAMES (337 plies: wins, losses, draws, 14 to
// 47 moves, ratings 1080-2812), against the chess.com product each tier imitates -- `matchOf` names
// it. Both sides read the ratings and result from the SAME pgn text, or the classifier is judging
// two different games.
//
// An earlier campaign put these at 95-96%. That set was ten quiet opening lines and 83% of its
// plies were BOOK -- free agreement both sides get from the same opening book, measuring nothing.
// On plies that need a judgement the honest figures are lower and are in the README.
const EE_TIERS = {
    card:     {label: 'Post-game review', build: SF_BUILD,   depth: 10, movetime: 0, rating: null,
               match: 96.2, matchOf: 'their post-game card'},
    fast:     {label: 'Fast',             build: SF16_BUILD, depth: 18, movetime: 0, rating: 3270,
               match: 83.1, matchOf: 'their Game Review'},
    standard: {label: 'Standard',         build: SF16_BUILD, depth: 22, movetime: 0, rating: 3430,
               match: 83.7, matchOf: 'their Game Review'},
    deep:     {label: 'Deep',             build: SF16_BUILD, depth: 24, movetime: 0, rating: 3500,
               match: 86.7, matchOf: 'their Game Review'},
    max:      {label: 'Maximum',          build: SF16_BUILD, depth: 26, movetime: 0, rating: 3560,
               match: 84.9, matchOf: 'their Game Review'},
};
const eeTier = (k) => EE_TIERS[k] || EE_TIERS.card;
// Their WASM finds its binary through location.hash and splits it on a comma; the second field is a
// MODE it must not misread. A bare wasm URL works, `#wasm,` works, and `#wasm,worker` silently
// produces an engine that never answers `uci` -- measured all three.
const SF_HASH_SUFFIX = ',';

function eeOpenDb() {
    return new Promise((resolve, reject) => {
        const rq = indexedDB.open(EE_DB, 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore(EE_STORE);
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
    });
}

function eeIdb(mode, fn) {
    return eeOpenDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(EE_STORE, mode);
        const rq = fn(tx.objectStore(EE_STORE));
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
    }));
}

// Keyed by version: a newer engine on chess.com is a different classifier, and quietly reusing the
// old one would make our answer disagree with theirs for a reason nobody could see.
const kJs = () => `js:${eeVer}`;
const kWasm = () => `wasm:${eeVer}`;
const K_VER = 'installed-version';

// Keyed by BUILD, so the card's engine and the Game Review's engine can both be kept and neither
// is ever silently served in place of the other.
const kSfJs = (b = SF_BUILD) => `sfjs:${b}`;
const kSfWasm = (b = SF_BUILD) => `sfwasm:${b}`;

async function sfCached(build = SF_BUILD) {
    try {
        const js = await eeIdb('readonly', s => s.get(kSfJs(build)));
        const wasm = await eeIdb('readonly', s => s.get(kSfWasm(build)));
        return (js && wasm) ? {js, wasm, bytes: js.length + wasm.byteLength} : null;
    } catch (e) { return null; }
}

async function sfDownload(onProgress, build = SF_BUILD) {
    const say = (n, total) => { try { onProgress(n, total); } catch (e) { /* caller's problem */ } };
    const jsRes = await fetch(sfUrl(build) + '.js');
    if (!jsRes.ok) throw new Error(`${build}.js: HTTP ${jsRes.status}`);
    const js = await jsRes.text();
    const res = await fetch(sfUrl(build) + '.wasm');
    if (!res.ok) throw new Error(`${build}.wasm: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        say(got, total);
    }
    const wasm = await new Blob(chunks).arrayBuffer();
    await eeIdb('readwrite', s => s.put(js, kSfJs(build)));
    await eeIdb('readwrite', s => s.put(wasm, kSfWasm(build)));
    return {js, wasm, bytes: js.length + wasm.byteLength};
}

async function sfForget(build = SF_BUILD) {
    try {
        await eeIdb('readwrite', s => s.delete(kSfJs(build)));
        await eeIdb('readwrite', s => s.delete(kSfWasm(build)));
    } catch (e) { /* nothing cached */ }
}

// Which build is actually installed. Read once at startup: the version is stored beside the blobs
// so an update survives a reload, and the cache keys are version-scoped so the two can never drift.
async function eeVersion() {
    try {
        const v = await eeIdb('readonly', s => s.get(K_VER));
        if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) eeVer = v;
    } catch (e) { /* first run */ }
    return eeVer;
}

// Is `b` newer than `a`? Field by field -- '1.125.0' string-compares BELOW '1.124.57'.
function eeNewer(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) > (pa[i] || 0); }
    return false;
}

async function eeExists(v) {
    try { return (await fetch(eeBase(v) + 'explanation-engine.js', {method: 'HEAD'})).ok; }
    catch (e) { return false; }
}

// Look for a newer build. chess.com publishes no directory listing and no `latest` alias -- both
// 404 -- so the only way to learn about one is to ask for it by name. MEASURED 2026-08-24 against
// the live CDN: 1.124.57 is up, 1.124.58 and 1.124.60 are 404, and 1.125.0 IS up. So they roll the
// MINOR and walk the patch inside it, which is exactly what this probes: a few more patches of the
// installed minor, then newer minors and the patch run inside the newest live one. Ten HEAD
// requests at most, and only when the user presses the button.
const EE_PROBE_MISSES = 3;

async function eeCheckUpdate(from) {
    const cur = from || eeVer;
    const [maj, min, pat] = cur.split('.').map(Number);
    if (![maj, min, pat].every(Number.isFinite)) return cur;
    let best = cur;
    for (let p = pat + 1, miss = 0; miss < EE_PROBE_MISSES; p++) {
        if (await eeExists(`${maj}.${min}.${p}`)) { best = `${maj}.${min}.${p}`; miss = 0; } else miss++;
    }
    for (let m = min + 1, miss = 0; miss < EE_PROBE_MISSES; m++) {
        if (!await eeExists(`${maj}.${m}.0`)) { miss++; continue; }
        miss = 0;
        best = `${maj}.${m}.0`;
        for (let p = 1, pm = 0; pm < EE_PROBE_MISSES; p++) {
            if (await eeExists(`${maj}.${m}.${p}`)) { best = `${maj}.${m}.${p}`; pm = 0; } else pm++;
        }
    }
    return eeNewer(cur, best) ? best : cur;
}

// Switch to `v` and fetch it. The OLD blobs are dropped only after the new ones are safely stored,
// so a failed update leaves the working engine in place rather than no engine at all.
async function eeUpdate(v, onProgress) {
    const old = eeVer;
    eeVer = v;
    try {
        await eeDownload(onProgress);
    } catch (e) {
        eeVer = old;
        throw e;
    }
    await eeIdb('readwrite', s => s.put(v, K_VER));
    if (old !== v) {
        try { await eeIdb('readwrite', s => s.delete(`js:${old}`)); } catch (e) { /* nothing to drop */ }
        try { await eeIdb('readwrite', s => s.delete(`wasm:${old}`)); } catch (e) { /* nothing to drop */ }
    }
    return v;
}

async function eeCached() {
    try {
        const js = await eeIdb('readonly', s => s.get(kJs()));
        const wasm = await eeIdb('readonly', s => s.get(kWasm()));
        return (js && wasm) ? {js, wasm, bytes: js.length + wasm.byteLength} : null;
    } catch (e) { return null; }
}

// One download, reported in bytes as it arrives -- 28.7 MB with no progress is indistinguishable
// from a hang, which is the whole reason this is behind a button rather than automatic.
async function eeDownload(onProgress) {
    const say = (n, total, what) => { try { onProgress(n, total, what); } catch (e) { /* caller's problem */ } };
    const jsRes = await fetch(eeBase() + 'explanation-engine.js');
    if (!jsRes.ok) throw new Error(`explanation-engine.js: HTTP ${jsRes.status}`);
    const js = await jsRes.text();

    const res = await fetch(eeBase() + 'explanation-engine.wasm');
    if (!res.ok) throw new Error(`explanation-engine.wasm: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        say(got, total, 'engine');
    }
    const wasm = new Blob(chunks).arrayBuffer ? await new Blob(chunks).arrayBuffer() : null;
    if (!wasm) throw new Error('could not assemble the engine');
    await eeIdb('readwrite', s => s.put(js, kJs()));
    await eeIdb('readwrite', s => s.put(wasm, kWasm()));
    return {js, wasm, bytes: js.length + wasm.byteLength};
}

async function eeForget() {
    try {
        await eeIdb('readwrite', s => s.delete(kJs()));
        await eeIdb('readwrite', s => s.delete(kWasm()));
    } catch (e) { /* nothing cached */ }
}

// Run one batch of commands and hand back the verdict. The sandbox is created and destroyed per
// run: the engine holds the whole game internally and there is no command to reset it, so reusing
// one would analyse the previous game again with this one appended.
function eeRun(assets, commands, {timeoutMs = 180000} = {}) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.src = chrome.runtime.getURL('src/options/ee-sandbox.html');
        frame.style.display = 'none';
        let settled = false;
        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            try { frame.remove(); } catch (e) { /* already gone */ }
            err ? reject(err) : resolve(val);
        };
        const timer = setTimeout(() => finish(new Error('the explanation engine did not answer')), timeoutMs);
        const onMsg = (ev) => {
            if (ev.source !== frame.contentWindow) return;
            const m = ev.data || {};
            if (m.type === 'error') return finish(new Error(m.error || 'engine error'));
            if (m.type === 'booted') {
                for (const line of commands) frame.contentWindow.postMessage({cmd: 'send', line}, '*');
                return;
            }
            // Its answers are one line each; the verdict is the one that opens with the game header.
            if (m.type === 'line' && /^json \{"whiteElo"/.test(m.line)) {
                let out = null;
                try { out = JSON.parse(m.line.slice(5)); } catch (e) { return finish(new Error('unreadable verdict')); }
                finish(null, out);
            }
        };
        window.addEventListener('message', onMsg);
        frame.onload = () => {
            // The wasm is transferred, not copied: 28.7 MB through the structured clone twice per
            // run is a visible stall on its own.
            const copy = assets.wasm.slice(0);
            frame.contentWindow.postMessage({cmd: 'boot', js: assets.js, wasm: copy}, '*', [copy]);
        };
        document.body.appendChild(frame);
    });
}

// Search every position with chess.com's own Stockfish, in the sandbox, at their budget. One
// sandbox for the whole game: Stockfish is stateless between `position` commands, unlike the
// classifier, which accumulates the game and has no reset.
//
// `positions` is filled IN PLACE with {lines, depth} in the same shape our own engine transport
// produces -- white-relative cp, pv as an array of UCI moves -- so everything downstream (assemble,
// eeCommands, the renderer) cannot tell which engine searched.
// `movetime` (ms) OR `depth`. A time budget cannot filter on a known final depth the way `go depth`
// can, so the collector keeps the DEEPEST line seen per multipv slot, which is correct for both.
// ONE sandboxed engine, driving the positions handed to it. `take()` yields the next index to
// search or -1 when the run is finished, so several of these can share one queue -- see sfSearch.
function sfSearchOne(assets, positions, take, done, {depth = 10, movetime = 0, multipv = 2, hash = 0, uciMoves = null, timeoutMs = 60000} = {}) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.src = chrome.runtime.getURL('src/options/ee-sandbox.html');
        frame.style.display = 'none';
        let settled = false;
        let onLine = null;
        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            try { frame.contentWindow.postMessage({cmd: 'quit'}, '*'); } catch (e) { /* already gone */ }
            try { frame.remove(); } catch (e) { /* already gone */ }
            err ? reject(err) : resolve(val);
        };
        let timer = setTimeout(() => finish(new Error('Stockfish did not answer')), timeoutMs);
        const bump = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('Stockfish stopped answering')), timeoutMs); };
        const send = (line) => frame.contentWindow.postMessage({cmd: 'send', line}, '*');
        const onMsg = (ev) => {
            if (ev.source !== frame.contentWindow) return;
            const m = ev.data || {};
            if (m.type === 'error') return finish(new Error(m.error || 'Stockfish error'));
            if (m.type === 'booted') return run();
            if (m.type === 'line' && onLine) onLine(String(m.line));
        };
        const until = (re) => new Promise((res) => {
            const prev = onLine;
            onLine = (l) => { if (collect) collect(l); if (re.test(l)) { onLine = prev; res(l); } };
        });
        let collect = null;
        async function run() {
            try {
                send('uci'); await until(/^uciok/);
                // The options they set, in their order. Skill Level 20 is full strength (their
                // way of saying "not limited") and Contempt is rejected by this build as "No such
                // option" -- sent anyway, because matching their stream exactly costs nothing and
                // guessing which of their commands mattered is how a difference gets introduced.
                send('setoption name Skill Level value 20');
                send('setoption name Contempt value 0');
                send(`setoption name MultiPV value ${multipv}`);
                send('setoption name Threads value 1');
                // Only when asked. chess.com's post-game card never sets Hash, so the card tier must
                // not either -- it would stop being a reproduction of their run.
                if (hash) send(`setoption name Hash value ${hash}`);
                send('isready'); await until(/^readyok/);
                for (;;) {
                    const i = take();
                    if (i < 0) break;
                    const p = positions[i];
                    const best = {};
                    // Deepest line per slot. The search reports every depth on the way up, and a
                    // shallower one would be an early answer wearing the same shape -- but with a
                    // time budget the final depth is not known in advance, so it cannot be a filter.
                    collect = (l) => {
                        const mp = l.match(/multipv (\d+)/), dp = l.match(/depth (\d+)/);
                        const sc = l.match(/score (cp|mate) (-?\d+)/), pv = l.match(/ pv (.*)$/);
                        if (!mp || !dp || !sc || !pv) return;
                        const d = Number(dp[1]), k = Number(mp[1]);
                        if (movetime ? (best[k] && best[k].depth > d) : d !== depth) return;
                        best[k] = {
                            depth: d,
                            cp: sc[1] === 'cp' ? Number(sc[2]) : null,
                            mate: sc[1] === 'mate' ? Number(sc[2]) : null,
                            pv: pv[1].split(' '),
                        };
                    };
                    // THE FULL HISTORY, not a bare FEN -- chess.com sends `position fen <start>
                    // moves e2e4 e7e5 ...` for every position, and so must we. A bare FEN gives the
                    // engine the same board with no past: repetition detection sees nothing to
                    // repeat, and a position it should score as a draw it scores on the material.
                    // Costs nothing and is exactly what their command line says.
                    if (uciMoves) send(`position fen ${positions[0].fen} moves ${uciMoves.slice(0, i).join(' ')}`.trimEnd());
                    else send(`position fen ${p.fen}`);
                    send(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
                    await until(/^bestmove/);
                    collect = null;
                    bump();
                    // Their scores are side-to-move relative, as raw UCI always is. Everything
                    // downstream expects white-relative, which is what our own transport stores --
                    // and toWhiteCp is the same encoding, so a mate keeps its DISTANCE here instead
                    // of being flattened to the wire cap. The cap belongs on the wire only; a
                    // flattened score reached the eval bar as a literal "300." where it should read
                    // M3, and mate-in-1 and mate-in-9 were the same number.
                    const Core = self.MephistoReviewCore;
                    p.lines = [1, 2].filter(k => best[k]).slice(0, multipv)
                        .map(k => ({cp: Core.toWhiteCp(best[k].cp, best[k].mate, p.turn),
                                    mate: best[k].mate, pv: best[k].pv}));
                    p.depth = best[1]?.depth ?? depth;
                    done();
                }
                finish(null, positions);
            } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
        }
        window.addEventListener('message', onMsg);
        frame.onload = () => {
            const copy = assets.wasm.slice(0);
            frame.contentWindow.postMessage({cmd: 'boot', js: assets.js, wasm: copy, hashSuffix: SF_HASH_SUFFIX}, '*', [copy]);
        };
        document.body.appendChild(frame);
    });
}

// N sandboxed engines over ONE queue. The positions of a game are independent, so this is the same
// trick the main review uses -- and it is why the chess.com classifier run went from "quite some
// time" to about 1/N of it. Their protocol is per-engine, so nothing about the verdicts changes:
// each engine sets their options, searches the positions it draws, and writes into the same array.
//
// uciMoves (their "position ... moves" form, used by the deepest tier so repetition is visible)
// makes a position depend on the game so far, not on the engine that searched it -- so it is safe
// to split, but each engine must be handed the WHOLE move list, which it already is.
function sfSearch(assets, positions, opts = {}) {
    const workers = Math.max(1, Math.min(4, opts.workers || 1));
    const {onProgress} = opts;
    let next = 0, finished = 0;
    const take = () => (next < positions.length ? next++ : -1);
    const done = () => {
        finished++;
        if (onProgress) { try { onProgress(finished / positions.length, finished, positions.length); } catch (e) { /* */ } }
    };
    if (workers === 1) return sfSearchOne(assets, positions, take, done, opts);
    return Promise.all(Array.from({length: workers}, () => sfSearchOne(assets, positions, take, done, opts)))
        .then(() => positions);
}

// THE PROTOCOL, exactly as chess.com drives it -- captured from a real game and replayed back into
// this engine, which reproduced their verdict field for field (see the suite).
//
// SCORES GO IN WHITE-POSITIVE, and this function does NOT convert them -- `positions[].lines[].cp`
// is ALREADY white-relative, because engines.js stores `Core.toWhiteCp(...)` when it parses the
// engine's info lines. Raw UCI is side-to-move relative and would need flipping; ours does not, and
// flipping it again is a double negation that only shows on black's moves.
//
// That is not hypothetical: it shipped through a full end-to-end run looking plausible. Every black
// reply was scored as its own mirror image, so the classifier saw the evaluation lurch every half
// move -- accuracy came out 73% against chess.com's 97% on the same game, with nine "missed wins"
// in a quiet Ruy Lopez. Nothing errored. The white-POV requirement itself is measured: 33 of 33
// positions in a captured real game matched white-POV and only 17 matched side-to-move.
// MEASURED CEILING: the engine takes cp 30000 and ABORTS at 31000 --
// `Aborted(Assertion failed: good_score_or_none(v.score), at: ../../src/node.cpp,447,extend)`,
// which kills the whole run with no verdict. Our own mate scores are +/-(100000 - distance), so any
// game containing a mate crashed it. Binary-searched against the real engine rather than guessed.
//
// The 30000 clamp is applied HERE, on the wire, by eeScore() -- not upstream in the search. The
// stored line keeps the real +/-(100000 - distance), because the eval bar and the PV list read the
// same field and need the distance to print M3. Flattening it at the source made every mate show
// as "300." on the bar. What the classifier sees is unchanged: it only reads the gap between the
// best move and the played one, and both ends are decisive at the cap.
//
// ponytail: the classifier still cannot tell mate-in-1 from mate-in-9 -- both arrive as 30000.
// needs mates ordered against each other.
const EE_SCORE_CAP = 30000;

function eeScore(cp) {
    if (!Number.isFinite(cp)) return null;
    return Math.max(-EE_SCORE_CAP, Math.min(EE_SCORE_CAP, Math.round(cp)));
}

function eeCommands({positions, moves, whiteElo, blackElo, result, userColor}) {
    const cmd = [
        'uci', 'isready',
        `setoption name UserColor value ${userColor || 'white'}`,
        `setoption name Result value ${result || '*'}`,
        `setoption name WhiteElo value ${Math.round(whiteElo || 1500)}`,
        `setoption name BlackElo value ${Math.round(blackElo || 1500)}`,
        'setoption name ClassificationV3 value true',
        'setoption name ScoreWhiteToMove value true',
        'setoption name SerializeLikeCEAC value true',
        'setoption name UCI_Variant value chess',
        'setoption name UCI_Chess960 value false',
        `position fen ${positions[0].fen}`,
    ];
    const describe = (p) => {
        for (const line of (p.lines || []).slice(0, 2)) {
            if (!line || !line.pv || !line.pv.length) continue;
            const cp = eeScore(line.cp);
            if (cp === null) continue;
            cmd.push(`variation ${line.pv.join(' ')} cp ${cp} depth ${p.depth || 10}`);
        }
    };
    for (let i = 0; i < moves.length; i++) {
        describe(positions[i]);
        cmd.push(`push ${moves[i].uci}`);
    }
    // The final position gets its lines too: the last move is classified against them.
    if (positions[moves.length]) describe(positions[moves.length]);
    cmd.push('fetch analysis', 'quit');
    return cmd;
}

// Their vocabulary -> ours. `greatFind` is our `great`; everything else already matches, and an
// unknown name becomes `good` rather than throwing a whole review away over one word.
const EE_CLASS = {
    brilliant: 'brilliant', greatFind: 'great', great: 'great', best: 'best',
    excellent: 'excellent', good: 'good', book: 'book', forced: 'forced',
    inaccuracy: 'inaccuracy', mistake: 'mistake', miss: 'miss', blunder: 'blunder',
};

export {EE_VERSION, eeBase, eeVersion, eeNewer, eeCheckUpdate, eeUpdate, EE_CLASS, EE_SCORE_CAP, eeScore, SF_BUILD, SF16_BUILD, SF16_LITE, EE_TIERS, eeTier, sfCached, sfDownload, sfForget, sfSearch, eeCached, eeDownload, eeForget, eeRun, eeCommands};
