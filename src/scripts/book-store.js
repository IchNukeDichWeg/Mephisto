// The panel's opening book: ONE loaded Polyglot .bin, stored raw in the EXTENSION's IndexedDB.
//
// Why here and why raw. The panel runs in the page's isolated world, where IndexedDB belongs to
// the SITE -- writing a book there would duplicate it per site and hand the page a readable
// fingerprint (the same reason config left localStorage in N1). So the book lives in the
// extension's own origin, and the PANEL asks the service worker per position -- the exact shape
// the puzzle database already uses. Raw rather than parsed because a .bin is sorted by key:
// MephistoPolyglot.bufferLookup answers one position in O(log n) off the bytes, so a 200MB book
// costs no parse, no Map, and no memory beyond the buffer itself.
//
// A classic script: the service worker importScripts it, the options shell loads it by tag.
// Requires /lib/polyglot-random.js and /src/options/util/polyglot.js first.
(function () {
    const DB_NAME = 'mephisto-books';
    const STORE = 'books';
    const KEY = 'active';       // one book: loading another replaces it

    function openDb() {
        return new Promise((resolve, reject) => {
            const rq = indexedDB.open(DB_NAME, 1);
            rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
            rq.onsuccess = () => resolve(rq.result);
            rq.onerror = () => reject(rq.error);
        });
    }

    function idb(mode, fn) {
        return openDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const rq = fn(tx.objectStore(STORE));
            rq.onsuccess = () => { resolve(rq.result); db.close(); };
            rq.onerror = () => { reject(rq.error); db.close(); };
        }));
    }

    // Reject junk at the door: a .bin is 16-byte entries sorted by key, and a file that is neither
    // would otherwise sit there matching nothing -- indistinguishable from "out of book" forever.
    // The sort check samples pairs rather than scanning 200MB.
    function validate(buffer) {
        if (!buffer || !buffer.byteLength) return 'the file is empty';
        if (buffer.byteLength % 16 !== 0) return 'not a Polyglot book (length is not 16-byte entries)';
        const view = new DataView(buffer);
        const count = buffer.byteLength / 16;
        const step = Math.max(1, Math.floor(count / 512));
        let prev = view.getBigUint64(0);
        for (let i = step; i < count; i += step) {
            const k = view.getBigUint64(i * 16);
            if (k < prev) return 'not a Polyglot book (entries are not sorted by key)';
            prev = k;
        }
        return null;
    }

    async function save(name, buffer) {
        const bad = validate(buffer);
        if (bad) throw new Error(bad);
        await idb('readwrite', s => s.put({name, bytes: buffer.byteLength,
                                           entries: buffer.byteLength / 16, buffer}, KEY));
        return {name, bytes: buffer.byteLength, entries: buffer.byteLength / 16};
    }

    function info() {
        return idb('readonly', s => s.get(KEY)).then(rec =>
            rec ? {name: rec.name, bytes: rec.bytes, entries: rec.entries} : null);
    }

    function remove() { return idb('readwrite', s => s.delete(KEY)); }

    // The probe the service worker answers the panel with. The buffer is cached for the worker's
    // lifetime -- a worker that just woke re-reads it once, which is the price of being killable.
    let cached;         // Promise<ArrayBuffer|null>
    function probe(fen) {
        if (!cached) cached = idb('readonly', s => s.get(KEY)).then(rec => rec ? rec.buffer : null);
        return cached.then(buffer => {
            if (!buffer) return null;                      // no book loaded at all
            return self.MephistoPolyglot.bufferLookup(buffer, fen);
        });
    }
    function dropCache() { cached = undefined; }

    self.MephistoBooks = {save, info, remove, probe, dropCache, validate};
})();
