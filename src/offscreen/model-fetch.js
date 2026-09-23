// ONE WAY TO GET A NET OR MODEL FILE, whichever archive this install came from.
//
// `lib/engine` is 99% of the full download. The update archive has always excluded it, and the full
// archive stops carrying the nets and models too (tools/release): they live on fixed, versioned
// assets releases instead (`engines-v1` for the Stockfish/Fairy nets, `models-v1` for the ONNX
// models), uploaded once when they change rather than ~690 MB per version.
//
// Order: the bundled file (a full install or a git checkout pays nothing and stays offline), then
// the split parts a >100MB net ships as in git, then the cache, then one download from the release
// the manifest names. Every byte that did NOT come from the extension package is checked against the
// SHA-256 in engine-assets.json, which ships in BOTH archives (it lives in src/, not lib/engine), so
// a truncated download, a corrupted cache entry or a swapped release asset is refused rather than
// handed to the engine. A file's tag only changes when its bytes do, so a URL can only ever mean one
// file and the cache never needs invalidating.
export const MODEL_CACHE = 'mephisto-nets-v1';   // the name the Stockfish net cache always used
const MODEL_REPO = 'IchNukeDichWeg/Mephisto';
const MANIFEST_URL = '/src/offscreen/engine-assets.json';
// A 98 MB net takes long enough that a silent panel reads as a dead engine (and trips the panel's
// silence watchdog); twice a second is enough to look alive without flooding the message channel.
const NOTE_EVERY_MS = 500;

// Narrow on purpose: a file NAME and a tag of the form <word>-v<N>, never a path. Nothing a page or
// a net could say can point this at another host or walk out of the release.
export function releaseUrl(tag, file) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file.includes('..')) return null;
    if (!/^[a-z]+-v\d+$/.test(tag || '')) return null;
    return `https://github.com/${MODEL_REPO}/releases/download/${tag}/${file}`;
}

let manifest = null;
async function assetEntry(file) {
    // a failed read is retried on the next call rather than remembered as "nothing is fetchable"
    manifest ??= fetch(MANIFEST_URL).then(r => r.json()).catch(() => { manifest = null; return {}; });
    return (await manifest).files?.[file] || null;
}

export async function sha256Hex(buf) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

const matches = async (buf, entry) => buf.byteLength === entry.size && await sha256Hex(buf) === entry.sha256;

async function bundled(url) {
    try {
        const r = await fetch(url);
        return r.ok ? await r.arrayBuffer() : null;
    } catch (e) {
        return null;   // not in this archive
    }
}

// Streams into a buffer sized by the MANIFEST, not by the server: the size is known before the first
// byte, so progress is exact and an oversized answer is cut off instead of filling memory.
async function download(urls, entry, file, onNote) {
    const out = new Uint8Array(entry.size);
    let got = 0, shown = 0;
    for (const url of urls) {
        let r;
        try {
            r = await fetch(url);
        } catch (e) {
            // The download host is an OPTIONAL permission (the same pair the self-updater asks for),
            // so "no permission" and "no network" arrive identically here. Say what to do rather
            // than leaving a bare TypeError in the console.
            // Kept under the panel's 120-character error line (on_engine_error in popup.js).
            throw new Error(`${file} is not bundled and could not be downloaded (offline, or permission off in Settings)`);
        }
        if (!r.ok) throw new Error(`${file} could not be downloaded: HTTP ${r.status}`);
        const reader = r.body.getReader();
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            if (got + value.byteLength > entry.size) {
                reader.cancel().catch(() => {});
                throw new Error(`${file} is larger than the ${entry.size} bytes the manifest lists - refused`);
            }
            out.set(value, got);
            got += value.byteLength;
            if (Date.now() - shown >= NOTE_EVERY_MS) {
                shown = Date.now();
                onNote?.(`mephisto-download ${file} ${got} ${entry.size}`);
            }
        }
    }
    if (got !== entry.size) throw new Error(`${file} download stopped at ${got} of ${entry.size} bytes`);
    onNote?.(`mephisto-download ${file} ${got} ${entry.size}`);   // the throttle can swallow 100%
    return out.buffer;
}

export async function fetchModel(dir, file, onNote) {
    const whole = await bundled(`${dir}/${file}`);
    if (whole) return whole;
    // the >100MB split convention git forces, same as the Stockfish nets have always used
    const parts = [];
    for (let i = 0; ; i++) {
        const part = await bundled(`${dir}/${file}.part${i}`);
        if (!part) break;
        parts.push(part);
    }
    if (parts.length) {
        const buf = new Uint8Array(parts.reduce((t, p) => t + p.byteLength, 0));
        parts.reduce((off, p) => { buf.set(new Uint8Array(p), off); return off + p.byteLength; }, 0);
        return buf.buffer;
    }
    const entry = await assetEntry(file);
    const url = entry && releaseUrl(entry.tag, file);
    if (!url) throw new Error(`${file} is not in this build and not in its engine manifest`);
    const cache = await caches.open(MODEL_CACHE).catch(() => null);
    const hit = cache && await cache.match(url);
    if (hit) {
        const buf = await hit.arrayBuffer();
        if (await matches(buf, entry)) return buf;
        // corrupt, or cached before the manifest existed and not the file it names: fetch it again
        await cache.delete(url).catch(() => {});
    }
    onNote?.(`downloading ${file}`);
    // A file over GitHub's 2 GB asset limit is uploaded as <name>.partN (tools/release); none is today.
    const urls = entry.parts ? Array.from({length: entry.parts}, (_, i) => `${url}.part${i}`) : [url];
    const buf = await download(urls, entry, file, onNote);
    if (!await matches(buf, entry)) {
        throw new Error(`${file} failed its SHA-256 check against the engine manifest - not used, not kept`);
    }
    try { await cache?.put(url, new Response(buf.slice(0))); } catch (e) { /* storage full: still usable now */ }
    onNote?.(`${file} downloaded (${(buf.byteLength / 1e6).toFixed(1)} MB), kept for next time`);
    return buf;
}
