// Where the local Syzygy tablebases LIVE: a File System Access directory handle in the
// extension's IndexedDB. The user picks their tablebase folder ONCE (Settings -> Local
// Tablebases); the handle -- not a copy of the gigabytes -- persists, and the worker reads
// table files lazily, straight from disk. Nothing is duplicated into the extension.
//
// Permission: Chrome may downgrade a stored handle to 'prompt' in a new browser session.
// queryPermission is readable anywhere, but REQUESTING needs a user gesture in a window, so
// the settings page owns re-granting; the worker just answers "not usable right now" and the
// lookup falls back online until the user clicks once.
//
// Classic script (importScripts'd by the worker, <script>-tagged by the options shell).
'use strict';

(() => {

const DB_NAME = 'mephisto-tablebases';
const STORE = 'dir';
const KEY = 'active';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idb(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const out = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(out.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    }));
}

async function saveHandle(handle) {
    await idb('readwrite', s => s.put(handle, KEY));
}

async function getHandle() {
    try { return (await idb('readonly', s => s.get(KEY))) || null; } catch (e) { return null; }
}

async function remove() {
    await idb('readwrite', s => s.delete(KEY));
}

// 'granted' | 'prompt' | 'missing' -- what the worker can do RIGHT NOW without a gesture.
// queryPermission is not guaranteed on handles in a service worker; probing an actual read is
// the fallback signal (NotAllowedError == 'prompt').
async function permission() {
    const handle = await getHandle();
    if (!handle) return 'missing';
    try {
        if (handle.queryPermission) return await handle.queryPermission({mode: 'read'});
        await handle.keys().next();
        return 'granted';
    } catch (e) {
        return e && e.name === 'NotAllowedError' ? 'prompt' : 'missing';
    }
}

// {tables, men: {3: n, ...}, names: Set of filenames} -- counts .rtbw like the host's tbinfo
async function inventory() {
    const handle = await getHandle();
    if (!handle) return null;
    const men = {}, names = new Set();
    let tables = 0;
    for await (const entry of handle.values()) {
        if (entry.kind !== 'file') continue;
        names.add(entry.name);
        if (entry.name.endsWith('.rtbw')) {
            const n = entry.name.slice(0, -5).replace('v', '').length;
            men[n] = (men[n] || 0) + 1;
            tables++;
        }
    }
    return {tables, men, names};
}

// One table file as an ArrayBuffer, read from disk on demand. Throws if absent/unreadable.
async function readTable(filename) {
    const handle = await getHandle();
    if (!handle) throw new Error('no tablebase folder chosen');
    const fh = await handle.getFileHandle(filename);
    const file = await fh.getFile();
    return file.arrayBuffer();
}

self.MephistoTbStore = {saveHandle, getHandle, remove, permission, inventory, readTable};

})();
