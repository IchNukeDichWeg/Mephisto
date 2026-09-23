// README screenshots, taken from the REAL unpacked extension in Chrome for Testing.
//
//   node test/screenshots.mjs [--out docs] [--only analysis-lines,hotkeys] [--chrome <path>] [--headless]
//
// puppeteer must be resolvable, the same way test/run-harness.js finds it (NODE_PATH works: it is
// loaded through createRequire). Headed by default, which is the proven local method; CI runs it
// under xvfb-run (.github/workflows/screenshots.yml). Output names are the README's docs/*.png.
// About 3-6 min: ~30 s per panel shot, and the review shot analyses a whole sample game.
//
// NOT automated, because each needs something a clean profile does not have: read-from-screen (a
// video playing), puzzle-database (the imported DB), taketaketake (an account), four-player (a
// chess.com 4PC game).
//
// How the panel is found: it lives in a CLOSED shadow root under an anonymous <div>, which page JS
// cannot enter, but CDP DOM.getDocument {pierce: true} walks closed roots too. The panel is opened
// the way the toolbar button does it, {toggleOverlay: true} to the tab, sent from the service worker
// (the rig has no toolbar to click).
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (e) { console.error('screenshots: puppeteer not resolvable -- set NODE_PATH to a node_modules that has it'); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Settings every shot starts from. Values are JSON strings, as config-store.js stores them. Two
// threads keep a CI runner (and a laptop) responsive; the two flags are first-run notices that
// would otherwise sit in the panel.
const SEED = {threads: 2, rv_threads: 2, dark_mode: true, engine_advised: true, calibrated: true,
              calibrate_pending: false, engine: 'stockfish-19-nnue', multiple_lines: 1, explorer: false,
              // every shot is seeded ON TOP of this, and storage persists between shots: without a
              // base variant, the atomic shot's setting leaked into every shot after it
              variant: 'chess'};
const lichess = (fen, variant = 'fromPosition') => `https://lichess.org/analysis/${variant}/${fen.replace(/ /g, '_')}`;
// White to move in every position: the panel's detection of the side to move is what is being shown,
// not tested, and a sparse position can fail board detection (seen with KQK).
const SHOTS = [
    {name: 'analysis-lines', cfg: {multiple_lines: 5},
     url: lichess('r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQ - 5 6')},
    {name: 'multiple-lines', cfg: {multiple_lines: 3},
     url: lichess('rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4')},
    {name: 'maia3', cfg: {engine: 'maia3', maia3_elo: 1500},
     url: lichess('rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5')},
    {name: 'variants', cfg: {engine: 'fairy-stockfish-14-nnue', variant: 'atomic', multiple_lines: 2},
     url: lichess('rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2', 'atomic')},
    // the explorer answers from explorer.lichess.org, which can refuse anonymous requests
    // The explorer is behind OAuth now and answers 401 without a token, while the engine line still
    // reads "best move is": `refuse` fails the shot on that text instead of shipping a picture of the
    // error. Pass --lichess-token-file (a personal token, no scopes) to make it answer.
    {name: 'opening-explorer', cfg: {explorer: true, multiple_lines: 3}, refuse: /Explorer unavailable/,
     url: lichess('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3')},
    {name: 'game-review', options: 'review'},
    {name: 'humanize', options: 'settings/general', section: '#humanize'},
    {name: 'hotkeys', options: 'settings/general', section: '#hotkeys'},
];
const SETTLE_MS = 4000;          // after "best move is": let the depth climb and the arrows land
const PANEL_TIMEOUT_MS = 120000; // a cold engine plus a first search
const REVIEW_TIMEOUT_MS = 600000;
const VIEWPORT = {width: 1440, height: 900, deviceScaleFactor: 2};

function args(argv) {
    const o = {out: path.join(ROOT, 'docs'), only: null, chrome: undefined, headless: false, token: ''};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') o.out = path.resolve(argv[++i]);
        else if (argv[i] === '--only') o.only = argv[++i].split(',');
        else if (argv[i] === '--chrome') o.chrome = argv[++i];
        else if (argv[i] === '--headless') o.headless = true;
        // a FILE, not the token itself: a command line is visible to every process on the box
        else if (argv[i] === '--lichess-token-file') o.token = fs.readFileSync(argv[++i], 'utf8').trim();
        else throw new Error(`unknown option ${argv[i]}`);
    }
    return o;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(what, fn, timeout, every = 1000) {
    const end = Date.now() + timeout;
    for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(every);
    }
}

// id -> nodeId, walking light DOM, shadow roots (closed ones included) and frames
async function findNode(cdp, id) {
    const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
    const stack = [root];
    while (stack.length) {
        const n = stack.pop();
        const a = n.attributes || [];
        for (let i = 0; i < a.length; i += 2) if (a[i] === 'id' && a[i + 1] === id) return n.nodeId;
        stack.push(...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : []));
    }
    return null;
}

async function boxOf(cdp, id) {
    const nodeId = await findNode(cdp, id);
    if (!nodeId) return null;
    const q = (await cdp.send('DOM.getBoxModel', {nodeId})).model.border;
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return {x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys)};
}

async function panelText(cdp) {
    const nodeId = await findNode(cdp, 'mephisto-panel-body');
    if (!nodeId) return '';
    const {object} = await cdp.send('DOM.resolveNode', {nodeId});
    const {result} = await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, returnByValue: true,
        functionDeclaration: 'function () { return this.innerText; }'});
    return result.value || '';
}

async function panelShot(browser, sw, shot, file) {
    await sw.evaluate(async (kv) => { await chrome.storage.local.set(kv); }, jsonValues({...SEED, ...shot.cfg}));
    const page = await browser.newPage();
    try {
        await page.setViewport(VIEWPORT);
        await page.goto(shot.url, {waitUntil: 'networkidle2', timeout: 60000});
        await page.reload({waitUntil: 'networkidle2', timeout: 60000});   // once: the content script's first read races the page
        await page.waitForSelector('cg-board', {timeout: 30000});
        await sleep(2000);
        const cdp = await page.createCDPSession();
        // Only one lichess tab is ever open, so a broadcast reaches only it: without the `tabs`
        // permission a url-filtered tabs.query returns nothing. A toggle is a toggle, so it is only
        // re-sent while the panel is still absent.
        await until('the panel', async () => {
            if (await findNode(cdp, 'mephisto-overlay')) return true;
            await sw.evaluate(async () => {
                for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {toggleOverlay: true}, () => void chrome.runtime.lastError);
            });
            await sleep(3000);
            return !!(await findNode(cdp, 'mephisto-overlay'));
        }, 30000, 0);
        await until('"best move is" in the panel', async () => /best move is/.test(await panelText(cdp)), PANEL_TIMEOUT_MS);
        await sleep(SETTLE_MS);
        if (shot.refuse && shot.refuse.test(await panelText(cdp))) {
            throw new Error(`panel shows ${shot.refuse} - not a usable picture (see the comment on this shot)`);
        }
        await page.mouse.move(1, 1);   // no hover state or tooltip in the picture
        await page.evaluate(() => window.scrollTo(0, 0));   // viewport and page coordinates now agree
        const panel = await boxOf(cdp, 'mephisto-overlay');
        const board = await page.$eval('cg-board', el => { const r = el.getBoundingClientRect(); return {x: r.left, y: r.top, x2: r.right, y2: r.bottom}; });
        const pad = 8;
        const x = Math.max(0, Math.min(panel.x, board.x) - pad), y = Math.max(0, Math.min(panel.y, board.y) - pad);
        const x2 = Math.min(VIEWPORT.width, Math.max(panel.x2, board.x2) + pad), y2 = Math.min(VIEWPORT.height, Math.max(panel.y2, board.y2) + pad);
        await page.screenshot({path: file, clip: {x, y, width: x2 - x, height: y2 - y}});
        return (await panelText(cdp)).split('\n').find(l => /best move is/.test(l));
    } finally {
        await page.close();
    }
}

// The options page scrolls an INNER container, so a page clip would miss anything below the fold;
// ElementHandle.screenshot scrolls the element itself into view.
async function optionsShot(browser, sw, extId, shot, file) {
    await sw.evaluate(async (kv) => { await chrome.storage.local.set(kv); }, jsonValues(SEED));
    const page = await browser.newPage();
    try {
        await page.setViewport(VIEWPORT);
        await page.goto(`chrome-extension://${extId}/src/options/options.html`, {waitUntil: 'networkidle2'});
        // the router is driven by the nav link, not by a #hash in the address bar
        await page.evaluate((id) => document.getElementById(id).click(), shot.options);
        if (shot.section) {
            const el = await page.waitForSelector(shot.section, {visible: true, timeout: 30000});
            await sleep(1000);
            await el.screenshot({path: file});
            return shot.section;
        }
        await page.waitForSelector('#rv_sample_btn', {visible: true, timeout: 30000});
        await page.click('#rv_sample_btn');
        await until('the sample PGN', () => page.$eval('#rv_pgn', el => el.value.trim().length > 0), 30000);
        await page.click('#rv_run');
        await until('the review report', () => page.evaluate(() =>
            !document.getElementById('rv-report')?.classList.contains('hidden')
            && /^100%/.test(document.getElementById('rv_progress_text')?.textContent || '')), REVIEW_TIMEOUT_MS, 2000);
        await sleep(1500);
        await page.mouse.move(1, 1);
        await (await page.$('#rv-report')).screenshot({path: file});
        return 'review report';
    } finally {
        await page.close();
    }
}

const jsonValues = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));

async function main() {
    const o = args(process.argv.slice(2));
    if (o.token) SEED.lichess_token = o.token;
    const shots = SHOTS.filter(s => !o.only || o.only.includes(s.name));
    if (!shots.length) throw new Error(`--only matched nothing; names: ${SHOTS.map(s => s.name).join(', ')}`);
    fs.mkdirSync(o.out, {recursive: true});
    const browser = await puppeteer.launch({
        headless: o.headless,
        executablePath: o.chrome,   // undefined -> the Chrome for Testing puppeteer downloaded
        defaultViewport: null,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [`--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`, '--lang=en-US',
               '--window-position=40,40', '--window-size=1580,1020'],
    });
    const started = Date.now();
    const results = [];
    try {
        const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker'
            && /\/src\/scripts\/background-script\.js$/.test(t.url()), {timeout: 30000});
        // attached DevTools keep the worker from being stopped for idleness between shots
        const sw = await swTarget.worker();
        const extId = new URL(swTarget.url()).host;
        await sw.evaluate(async () => { await chrome.storage.local.remove('mephisto_whats_new'); });
        for (const [i, shot] of shots.entries()) {
            const file = path.join(o.out, `${shot.name}.png`);
            const t0 = Date.now();
            try {
                const detail = shot.options ? await optionsShot(browser, sw, extId, shot, file)
                                            : await panelShot(browser, sw, shot, file);
                results.push([shot.name, 'ok']);
                console.log(`[${i + 1}/${shots.length}] ok   ${shot.name}.png  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${detail || ''}`);
            } catch (e) {
                results.push([shot.name, 'FAIL']);
                console.log(`[${i + 1}/${shots.length}] FAIL ${shot.name}.png  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${e.message}`);
            }
        }
    } finally {
        await browser.close();
    }
    const bad = results.filter(r => r[1] !== 'ok');
    console.log(`\n${results.length - bad.length}/${results.length} screenshots in ${o.out}, `
        + `${((Date.now() - started) / 1000).toFixed(0)}s total${bad.length ? `; failed: ${bad.map(r => r[0]).join(', ')}` : ''}`);
    process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error('screenshots FATAL', e); process.exit(2); });
