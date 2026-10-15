// Mephisto UI translation. Plain script, no module: the options page loads it with a <script> tag,
// the service worker with importScripts(), and the panel gets it injected as a content script -- so
// all three share ONE language list and one lookup, and none of them can drift from the others.
//
// NOT chrome.i18n. Chrome's own i18n picks the BROWSER's UI locale and offers no way to override it
// at runtime, and the whole point here is a Language setting you choose yourself. `_locales/` stays
// for what it is actually for (the extension name in the Chrome UI).
//
// One JSON per language in locales/, flat key -> text. English is the fallback for every key, so a
// locale that is missing a string shows English rather than a blank or a raw key, and adding a string
// to the UI never breaks a translation that has not caught up yet.
(function (root) {
'use strict';

// code == the locales/<code>.json filename. `name` is each language IN THAT LANGUAGE -- someone
// looking for their own language is not helped by a list written in English.
const LANGUAGES = [
    {code: 'en', name: 'English'},
    {code: 'de', name: 'Deutsch'},
    {code: 'es', name: 'Español'},
    {code: 'fr', name: 'Français'},
    {code: 'pt', name: 'Português'},
    {code: 'it', name: 'Italiano'},
    {code: 'nl', name: 'Nederlands'},
    {code: 'pl', name: 'Polski'},
    {code: 'tr', name: 'Türkçe'},
    {code: 'ru', name: 'Русский'},
    {code: 'zh', name: '中文'},
    {code: 'hi', name: 'हिन्दी'},
    {code: 'ja', name: '日本語'},
    {code: 'ko', name: '한국어'},
];
const DEFAULT_LANG = 'en';
const LANG_CODES = LANGUAGES.map(l => l.code);

let strings = {};          // the active locale
let fallback = {};         // English, always
let current = DEFAULT_LANG;

// {name} placeholders, so a translator can move the value to wherever the sentence needs it rather
// than being stuck with English word order -- which is the usual reason string concatenation makes
// translations read badly.
function format(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// The English text is passed in at every call site as `dflt`, so the source stays readable and a key
// that is missing everywhere still renders something sensible.
function t(key, dflt, vars) {
    const text = strings[key] ?? fallback[key] ?? dflt ?? key;
    return format(text, vars);
}

function setStrings(lang, obj) {
    current = LANG_CODES.includes(lang) ? lang : DEFAULT_LANG;
    strings = obj || {};
    if (current === DEFAULT_LANG) fallback = strings;
}

function setFallback(obj) { fallback = obj || {}; }

// Extension-origin contexts only (options page, service worker). The panel runs in the page's
// isolated world, where a fetch of a chrome-extension:// URL is blocked unless the file is listed in
// web_accessible_resources -- and that list was deliberately emptied, because an extension URL the
// page can reach is an extension the page can detect. The panel asks the worker instead.
async function fetchLocale(lang) {
    if (!LANG_CODES.includes(lang)) return null; // also the path-traversal guard: `lang` is a setting
    const url = (root.chrome?.runtime?.getURL)
        ? chrome.runtime.getURL(`src/i18n/locales/${lang}.json`)
        : `locales/${lang}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
}

// Load `lang` plus English underneath it, and make both active.
async function use(lang) {
    const en = (lang === DEFAULT_LANG) ? null : await fetchLocale(DEFAULT_LANG).catch(() => null);
    const obj = await fetchLocale(lang).catch(() => null);
    setFallback(en || obj || {});
    setStrings(lang, obj || en || {});
    return strings;
}

// --- applying a locale to markup ----------------------------------------------------------------
//   data-i18n        -> the element's text
//   data-i18n-tip    -> its data-tooltip (Materialize reads that attribute)
//   data-i18n-title  -> its title attribute
//
// The text case replaces the element's FIRST TEXT NODE, not its textContent. Several labels here are
// `<label>Some Setting <i class="material-icons">info</i></label>` -- an icon element, or a <span>
// holding a live value, sitting inside the same label. Assigning textContent would delete it.
function apply(scope) {
    const el = scope || root.document;
    if (!el || !el.querySelectorAll) return;
    for (const node of el.querySelectorAll('[data-i18n]')) {
        const text = t(node.dataset.i18n, null);
        if (text == null) continue;
        const first = [...node.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
        if (first) first.textContent = text;
        else if (!node.firstElementChild) node.textContent = text;
    }
    for (const node of el.querySelectorAll('[data-i18n-ph]')) {
        const text = t(node.dataset.i18nPh, null);
        if (text != null) node.setAttribute('placeholder', text);
    }
    for (const node of el.querySelectorAll('[data-i18n-tip]')) {
        const text = t(node.dataset.i18nTip, null);
        if (text != null) node.setAttribute('data-tooltip', text);
    }
    for (const node of el.querySelectorAll('[data-i18n-title]')) {
        const text = t(node.dataset.i18nTitle, null);
        if (text != null) node.setAttribute('title', text);
    }
    // A few explanatory paragraphs are a sentence with <b> and <a> woven through it. Splitting those
    // into fragments would force every translator into English word order, so the whole paragraph
    // (markup and all) is one string. The value comes from our own bundled locale files, never from
    // the page or the network, so there is nothing here a site could inject into.
    for (const node of el.querySelectorAll('[data-i18n-html]')) {
        const text = t(node.dataset.i18nHtml, null);
        if (text != null) node.innerHTML = text;
    }
}

// --- error codes ------------------------------------------------------------------------------------
// Every failure the USER started (a pick that was wrong, a download that did not arrive, a file that
// would not import) carries a short stable code, so a bug report can say "MPH-U02" instead of pasting
// a paragraph, and the README can say what to do about it. The code is shown in front of the
// translated message: "MPH-U02: That isn't Mephisto's folder. ...".
//
// STABLE, AND NEVER REUSED. A code that was retired stays retired -- an old report or README line that
// names it must keep meaning what it meant, so a removed failure leaves a gap, not a free number.
// Letter = area: U self-update, P puzzle database, S settings import, B opening book, T tablebase,
// E engines and hosts, N model/net download, R review (chess.com, lichess), V reading the screen.
//
// `key` is the locale key of the message and `en` the English default (kept identical to
// locales/en.json by the test suite). Where a message already existed as a panel string it keeps that
// key rather than getting a second, so the two cannot be translated apart.
//
// Errors that cross a message channel as plain text (the offscreen document's model downloads reach
// the panel as String(error)) carry just the code at the front of their message; the panel looks the
// code up here, so those messages take no {placeholders} -- the technical detail stays in the console.
const ERRORS = Object.freeze(Object.fromEntries([
    ['MPH-U01', 'err.U01', 'That folder has no manifest.json. Pick the folder you loaded in chrome://extensions (Load unpacked).'],
    ['MPH-U02', 'err.U02', 'That isn\'t Mephisto\'s folder. Pick the folder you loaded in chrome://extensions (Load unpacked).'],
    ['MPH-U03', 'err.U03', 'Automatic updates are switched off. Turn them on in Settings first.'],
    ['MPH-U04', 'err.U04', 'Chrome is no longer holding the download permission. Switch automatic updates off and on again to ask for it.'],
    ['MPH-U05', 'err.U05', 'Mephisto\'s folder is not set, or Chrome no longer lets it write there. Press Choose Extension Folder and allow access.'],
    ['MPH-U06', 'err.U06', 'Could not reach GitHub. Check your internet connection and try again.'],
    ['MPH-U07', 'err.U07', 'This release has no update archive. Download the full zip from the Releases page instead.'],
    ['MPH-U08', 'err.U08', 'The download failed (HTTP {status}). Try again in a minute.'],
    ['MPH-U09', 'err.U09', 'That download is the full archive, not the small update one. Download the full zip by hand instead.'],
    ['MPH-U10', 'err.U10', 'The downloaded update is damaged. Try again; if it keeps failing, install the full zip.'],
    ['MPH-U11', 'err.U11', 'The downloaded archive does not match the release it was published as. Try again later, or install the full zip.'],
    ['MPH-U12', 'err.U12', 'There is nothing to roll back to.'],
    ['MPH-U13', 'err.U13', 'The backup is incomplete, so nothing was restored.'],
    ['MPH-U14', 'err.U14', 'There is no interrupted update to finish.'],
    ['MPH-U15', 'err.U15', 'The staged update is incomplete. Press Install Update to download it again.'],

    ['MPH-P01', 'err.P01', 'That is the compressed file. Decompress it first (unzstd lichess_db_puzzle.csv.zst), then pick the .csv.'],
    ['MPH-P02', 'err.P02', 'The puzzle import failed. What was already imported is kept; run it again to continue.'],
    ['MPH-P03', 'err.P03', 'No puzzles were recognised in that file. Pick lichess_db_puzzle.csv or a Chess.com puzzle CSV.'],
    ['MPH-P04', 'err.P04', 'Could not read the puzzle database. Reload this page; if it keeps happening, press Remove and import again.'],

    ['MPH-S01', 'err.S01', 'That file is not valid JSON. Pick a file made with Export Settings.'],
    ['MPH-S02', 'err.S02', 'That does not look like a Mephisto settings file. Pick a file made with Export Settings.'],
    ['MPH-S03', 'err.S03', 'The value of "{key}" is not valid, so nothing was imported. Export the settings again from a working install.'],

    ['MPH-B01', 'err.B01', 'That is not a usable Polyglot book. Pick a .bin file in the Polyglot format.'],

    ['MPH-T01', 'err.T01', 'That folder holds no Syzygy tablebase files (.rtbw). Pick the folder that contains them.'],
    ['MPH-T02', 'err.T02', 'Access to the tablebase folder has lapsed. Press Re-allow.'],
    ['MPH-T03', 'err.T03', 'Writing to that folder was not allowed. Press Download tables again and allow it.'],
    ['MPH-T04', 'err.T04', 'Downloading needs permission to reach tablebase.lichess.ovh. Press Download tables again and allow it.'],
    ['MPH-T05', 'err.T05', 'Could not read the file list from the tablebase server. Check your internet connection and try again.'],
    ['MPH-T06', 'err.T06', 'Out of space in that folder, so the download stopped. Free some room or choose a smaller set.'],
    ['MPH-T07', 'err.T07', 'The tablebase folder cannot be used ({detail}). Choose the folder again.'],

    ['MPH-E01', 'err.E01', 'The native engine host is not installed or not running. Run native-host/install-native.sh once (see the README), then reload this page.'],
    ['MPH-E02', 'panel.msg.remote_unreachable', 'Remote Engine: nothing is answering on localhost:9090. Start remote-engine.py, or pick another engine.'],
    ['MPH-E03', 'err.E03', 'Something other than remote-engine.py is answering on localhost:9090. Stop it, or start remote-engine.py there.'],
    ['MPH-E04', 'panel.msg.engine_keeps_crashing', 'Engine keeps crashing - pick a different engine in Settings.'],
    ['MPH-E05', 'panel.msg.engine_error', 'Engine error - {detail}'],
    ['MPH-E06', 'err.E06', 'The online engine could not answer. Check your internet connection, or pick another engine in Settings.'],
    ['MPH-E07', 'panel.tetrarch_setup', 'Tetrarch is not installed yet - see the README section "Four-player chess" for macOS, Linux and Windows setup'],

    ['MPH-N01', 'err.N01', 'Could not download a model file this build does not include. Check your internet connection and try again.'],
    ['MPH-N02', 'err.N02', 'The model download was cut short or came out the wrong size. Try again.'],
    ['MPH-N03', 'err.N03', 'The downloaded model failed its integrity check and was discarded. Try again; if it keeps failing, install the full zip.'],
    ['MPH-N04', 'err.N04', 'This build does not include that model and cannot fetch it. Update Mephisto or install the full zip.'],

    ['MPH-R01', 'err.R01', 'The chess.com review needs a chess.com tab. Open chess.com in this browser and log in, then try again.'],
    ['MPH-R02', 'err.R02', 'chess.com rejected the request (1008). Sign in to chess.com in this browser, then try again.'],
    ['MPH-R03', 'err.R03', 'Could not get an answer from chess.com. Try again; if it repeats, use Copy error & open ticket.'],
    ['MPH-R04', 'err.R04', 'Could not run in the chess.com tab. Reload that tab and try again.'],
    ['MPH-R05', 'err.R05', 'lichess is rate-limiting this. Wait a minute and try again.'],
    ['MPH-R06', 'err.R06', 'lichess did not accept the token. Make a new one in Settings > Beyond the engine > Lichess API token, with the study:write scope ticked.'],
    ['MPH-R07', 'err.R07', 'The token has no study:write scope. Make a new token with study:write ("Create, update, delete studies and broadcasts") ticked and paste it in Settings > Beyond the engine.'],
    ['MPH-R08', 'err.R08', 'lichess found no study with that id that this token can write to. Check the URL, and that the study is yours or you are a contributor.'],
    ['MPH-R09', 'err.R09', 'lichess refused the game ({detail}). Check the PGN and try again later.'],
    ['MPH-R10', 'err.R10', 'Could not reach lichess. Check your internet connection and try again.'],
    ['MPH-R11', 'err.R11', 'Paste the URL of one of your lichess studies first (lichess.org/study/...).'],
    ['MPH-R12', 'err.R12', 'Adding to a study needs a Lichess API token with the study:write scope. Make one at lichess.org/account/oauth/token/create and paste it in Settings > Beyond the engine > Lichess API token.'],

    ['MPH-V01', 'err.V01', 'No board found on the screen. Drag a box around the board.'],
    ['MPH-V02', 'panel.fen.capture_failed', 'Capture failed ({detail})'],
    ['MPH-V03', 'panel.fen.follow_failed', 'Stopped following (the capture failed)'],
    ['MPH-V04', 'err.V04', 'Reading the board failed ({detail}). Drag a box around the board.'],
].map(([code, key, en]) => [code, Object.freeze({code, key, en})])));

const ERROR_CODE_RE = /\bMPH-[A-Z]\d{2}\b/;

// "MPH-U02: <translated message>". `vars` fills the {placeholders}; an unknown code is returned bare so
// a typo at a call site shows up as a bare code rather than as nothing.
function errText(code, vars) {
    const e = ERRORS[code];
    if (!e) return String(code);
    return `${code}: ${t(e.key, e.en, vars)}`;
}

// A throwable that carries its code. `message` is the English line (this is what the console and a
// stack trace show); `detail` is the technical part that must not reach the user -- a file name, an
// HTTP status, the browser's own text -- and is appended to the message for the log only.
function fail(code, vars, detail) {
    const e = ERRORS[code];
    const err = new Error(e ? `${code}: ${format(e.en, vars)}` + (detail ? ` [${detail}]` : '') : String(code));
    err.code = code;
    err.vars = vars || null;
    err.detail = detail || '';
    return err;
}

// What the user is shown for a failure of unknown origin: the translated, coded line when the error
// carries a registered code (thrown here, or crossed a channel as text), otherwise its own message.
function errMsg(e) {
    if (e && e.code && ERRORS[e.code]) return errText(e.code, e.vars || undefined);
    const raw = String((e && e.message) || e || '');
    const m = ERROR_CODE_RE.exec(raw);
    if (m && ERRORS[m[0]]) return errText(m[0]);
    return raw;
}

root.MephistoI18n = {
    LANGUAGES, LANG_CODES, DEFAULT_LANG,
    t, apply, use, setStrings, setFallback, fetchLocale, format,
    ERRORS, errText, errMsg, fail,
    get lang() { return current; },
};

})(typeof self !== 'undefined' ? self : this);
