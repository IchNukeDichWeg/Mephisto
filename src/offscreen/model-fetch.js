// ONE WAY TO GET A MODEL FILE, whichever archive this install came from.
//
// `lib/engine` is 99% of the full download and is EXCLUDED from the update archive (release-zips.sh)
// -- which is the archive most people actually use, and the one the self-updater applies. So an
// install that has only ever taken updates has the code for Maia, Maia-3 and the screen reader and
// none of their weights: the bare `fetch('/lib/engine/...')` those modules used simply failed, and
// the feature looked broken rather than un-downloaded.
//
// Order: the bundled file (a full install pays nothing and stays offline), then the split parts a
// >100MB net ships as, then the cache, then one download from the models release -- which is a
// SEPARATE, fixed tag rather than the current version's, because a model file changes far less often
// than the code and re-uploading 200MB per release would be absurd. Cached permanently after that:
// the filename identifies the weights, so a name can only ever mean one file.
export const MODEL_CACHE = 'mephisto-nets-v1';   // shared with the Stockfish net cache, same purpose
const MODEL_REPO = 'IchNukeDichWeg/Mephisto';
const MODEL_RELEASE = 'models-v1';

// Narrow on purpose: a file NAME, never a path. The caller's directory is fixed in code, so nothing
// a page or a net could say can point this at another host or walk out of the release.
export function remoteModelUrl(file) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file.includes('..')) return null;
    return `https://github.com/${MODEL_REPO}/releases/download/${MODEL_RELEASE}/${file}`;
}

async function bundled(url) {
    try {
        const r = await fetch(url);
        return r.ok ? await r.arrayBuffer() : null;
    } catch (e) {
        return null;   // not in this archive
    }
}

export async function fetchModel(dir, file, onNote) {
    const whole = await bundled(`${dir}/${file}`);
    if (whole) return whole;
    // the >100MB split convention, same as fetchNnue
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
    const url = remoteModelUrl(file);
    if (!url) throw new Error(`model not bundled and not fetchable: ${file}`);
    const cache = await caches.open(MODEL_CACHE).catch(() => null);
    const hit = cache && await cache.match(url);
    if (hit) return hit.arrayBuffer();
    onNote?.(`downloading ${file}`);
    let r;
    try {
        r = await fetch(url);
    } catch (e) {
        // The download host is an OPTIONAL permission (the same pair the self-updater asks for), so
        // "no permission" and "no network" arrive identically here. Say what to do rather than
        // leaving a bare TypeError in the console.
        throw new Error(`${file} is not in this build and could not be downloaded `
            + `(offline, or the update permission is off in Settings)`);
    }
    if (!r.ok) throw new Error(`${file} could not be downloaded: HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    try { await cache?.put(url, new Response(buf.slice(0))); } catch (e) { /* storage full: still usable now */ }
    onNote?.(`${file} downloaded (${(buf.byteLength / 1e6).toFixed(1)} MB), kept for next time`);
    return buf;
}
