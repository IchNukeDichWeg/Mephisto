#!/usr/bin/env node
// Build the engine-assets manifest (src/offscreen/engine-assets.json) from lib/engine, and optionally
// stage the files a new assets release has to carry.
//
//   node tools/release/build-engines-manifest.mjs --check
//        verify the committed manifest still matches lib/engine, AND that every tag it names is published
//        and holds each file under that name with that sha256 (release-zips.sh gates on this)
//   node tools/release/build-engines-manifest.mjs --tag engines-v1 --reuse models-v1
//        rewrite the manifest; files already on a --reuse release with the SAME sha256 keep that tag
//   node tools/release/build-engines-manifest.mjs --tag engines-v1 --reuse models-v1 --out ../engines-v1
//        ...and copy/join/split every file that needs the NEW tag into ../engines-v1 for upload
//
// Options: --root <extension dir> (default: two levels above this file). Nothing here writes to
// GitHub: --check, --reuse and the --tag guard only READ a release's asset list (name, size, digest)
// from the public API.
//
// A --tag that is already published is refused unless it already holds every file the rewrite would
// pin to it: the manifest would otherwise name new bytes under a tag whose asset is the old file, and
// every fresh slim install would fail that engine on its sha256 (MPH-N03). Releases are never re-tagged.
//
// What goes remote: every *.nnue and *.onnx under lib/engine -- the data. The engine .js/.wasm
// glue stays bundled: a pthread build starts its workers from its own script URL, which must be the
// extension's, and a .wasm fetched apart from the glue it was built with is a mismatch waiting to
// happen. Together they are ~3 MB, so there is nothing worth moving.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO = 'IchNukeDichWeg/Mephisto';
const ENGINE_DIR = 'lib/engine';
const MANIFEST = 'src/offscreen/engine-assets.json';
const REMOTE = /^(.+\.(?:nnue|onnx))(?:\.part(\d+))?$/;
// GitHub: every file in a release must be under 2 GiB. The biggest net today is 109 MB, so this
// splits nothing -- it exists so a future net cannot produce a release that fails at upload time.
const ASSET_LIMIT = 2 * 1024 ** 3 - 1;
const PART_BYTES = 1024 ** 3;   // plain byte splits, the same .partN convention git already forces

function args(argv) {
    const o = {tag: 'engines-v1', reuse: [], out: null, check: false,
               root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
        if (a === '--check') o.check = true;
        else if (a === '--tag') o.tag = v();
        else if (a === '--reuse') o.reuse = v().split(',').filter(Boolean);
        else if (a === '--out') o.out = path.resolve(v());
        else if (a === '--root') o.root = path.resolve(v());
        else throw new Error(`unknown option ${a}`);
    }
    if (!/^[a-z]+-v\d+$/.test(o.tag)) throw new Error(`--tag must look like engines-v1, got ${o.tag}`);
    // staging replaces files in --out; inside the tree that could be lib/engine itself, and would
    // also land the staged copies in the next `git archive`
    if (o.out && !path.relative(o.root, o.out).startsWith('..')) throw new Error('--out must be outside the extension tree');
    return o;
}

function walk(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

// name -> {dir, sources: [absolute paths in byte order]}. The whole file wins over git parts.
function collect(root) {
    const found = {};
    for (const abs of walk(path.join(root, ENGINE_DIR))) {
        const m = REMOTE.exec(path.basename(abs));
        if (!m) continue;
        const dir = path.relative(root, path.dirname(abs)).split(path.sep).join('/');
        const f = found[m[1]] ??= {dir, whole: null, parts: []};
        // release assets are one flat namespace, and the manifest is keyed by name
        if (f.dir !== dir) throw new Error(`${m[1]} exists in both ${f.dir} and ${dir}`);
        if (m[2] === undefined) f.whole = abs; else f.parts[+m[2]] = abs;
    }
    for (const [name, f] of Object.entries(found)) {
        // Array.from: a missing part is a hole in the sparse array, which .some() never visits, so the
        // check passed and hashing died on createReadStream(undefined) (audit 3.1.331 RELEASETOOLS-3)
        const gap = Array.from(f.parts).findIndex(p => !p);
        if (!f.whole && gap >= 0) throw new Error(`${name}: .partN files are not contiguous (no .part${gap})`);
        f.sources = f.whole ? [f.whole] : f.parts;
    }
    return found;
}

async function hashFiles(sources) {
    const h = crypto.createHash('sha256');
    let size = 0;
    for (const s of sources) {
        for await (const chunk of fs.createReadStream(s)) { h.update(chunk); size += chunk.length; }
    }
    return {size, sha256: h.digest('hex')};
}

// name -> sha256 of a published release's assets, or null when the tag is not published
async function releaseAssets(tag) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`,
        {headers: {Accept: 'application/vnd.github+json'}});
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub API ${r.status} reading ${tag}`);
    return Object.fromEntries((await r.json()).assets.map(a => [a.name, (a.digest || '').replace(/^sha256:/, '')]));
}
const releaseDigests = async (tag) => (await releaseAssets(tag)) || {};   // --reuse: unpublished = nothing to reuse
// the tag of the repository's "Latest" release, or null when it has none
async function latestTag() {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {headers: {Accept: 'application/vnd.github+json'}});
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub API ${r.status} reading the latest release`);
    return String((await r.json()).tag_name || '');
}

// Does `assets` hold manifest entry `e` under `name`? A split file is checked part by part for presence
// only: the manifest pins the joined bytes, which no single asset carries.
function holds(assets, name, e) {
    if (e.parts) return Array.from({length: e.parts}, (_, p) => `${name}.part${p}`).every(a => a in assets);
    return assets[name] === e.sha256;
}

const mb = (n) => (n / 1e6).toFixed(1).padStart(8) + ' MB';

async function main() {
    const o = args(process.argv.slice(2));
    const found = collect(o.root);
    const names = Object.keys(found).sort((a, b) =>
        (found[a].dir + '/' + a).localeCompare(found[b].dir + '/' + b));
    const reuse = {};
    for (const t of o.reuse) reuse[t] = await releaseDigests(t);
    const manifestPath = path.join(o.root, MANIFEST);
    const have = o.check ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || {} : {};

    const files = {};
    const started = Date.now();
    for (const [i, name] of names.entries()) {
        const {size, sha256} = await hashFiles(found[name].sources);
        const kept = o.check ? have[name]?.tag : o.reuse.find(t => reuse[t][name] === sha256);
        const e = {dir: found[name].dir, size, sha256, tag: kept || o.tag};
        if (size > ASSET_LIMIT) e.parts = Math.ceil(size / PART_BYTES);
        files[name] = e;
        // one line per file: hashing ~1 GB takes a few seconds, and a silent script reads as hung
        console.log(`[${String(i + 1).padStart(2)}/${names.length}] ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s `
            + `${mb(size)}  ${e.tag.padEnd(11)} ${e.dir}/${name}${e.parts ? `  SPLIT x${e.parts}` : ''}`);
    }

    if (o.check) {
        const bad = [];
        for (const n of new Set([...Object.keys(have), ...names])) {
            const a = have[n], b = files[n];
            if (!a) bad.push(`${n}: on disk, not in the manifest`);
            else if (!b) bad.push(`${n}: in the manifest, not on disk`);
            else if (a.size !== b.size || a.sha256 !== b.sha256 || a.dir !== b.dir) bad.push(`${n}: bytes differ from the manifest`);
            else if (!/^[a-z]+-v\d+$/.test(a.tag || '')) bad.push(`${n}: bad tag ${a.tag}`);
        }
        if (bad.length) {
            console.error(`\n!! ${MANIFEST} is stale -- rebuild it (see tools/release/README.md):\n  ` + bad.join('\n  '));
            process.exit(1);
        }
        // THE BYTES MUST BE ON THE TAG. Matching the disk proves nothing about the release a fresh
        // slim install downloads from: a rebuilt net pinned under an old tag, or a tag not published
        // yet, passed here and then failed every install with MPH-N03 or a 404.
        const tags = [...new Set(Object.values(have).map(e => e.tag))].sort();
        const published = {};
        for (const t of tags) published[t] = await releaseAssets(t);
        const missing = [];
        for (const [n, e] of Object.entries(have)) {
            if (!published[e.tag]) missing.push(`${n}: release ${e.tag} is not published`);
            else if (!holds(published[e.tag], n, e)) missing.push(`${n}: release ${e.tag} has no asset of that name with this sha256`);
        }
        if (missing.length) {
            console.error(`\n!! ${MANIFEST} names bytes its releases do not hold -- publish them, or rebuild with a new --tag:\n  ` + missing.join('\n  '));
            process.exit(1);
        }
        // "LATEST" MUST BE A VERSION RELEASE (audit 3.1.330 BOUNDARY-5). Every install's update check
        // reads /releases/latest and takes its tag as the newest version. An assets release published
        // without --latest=false becomes "Latest", `engines-v2` is no newer than anything, and every
        // install sees no update (and caches that for 12 h) until a version release takes it back.
        const latest = await latestTag();
        if (latest !== null && !/^v\d+(\.\d+)*$/.test(latest)) {
            console.error(`\n!! the repository's "Latest" release is ${latest}, not a version, and every install's update check reads it.`
                + `\n   Mark the newest version release Latest: gh release edit v<newest> --repo ${REPO} --latest`);
            process.exit(1);
        }
        console.log(`\n${MANIFEST} matches lib/engine (${names.length} files) and ${tags.join(', ')} hold every one; Latest is ${latest || 'none'}`);
        return;
    }

    // Never pin new bytes to a tag that is already out: its assets are what installs download.
    const target = await releaseAssets(o.tag);
    if (target) {
        const absent = names.filter(n => files[n].tag === o.tag && !holds(target, n, files[n]));
        if (absent.length) throw new Error(`--tag ${o.tag} is already published and does not hold ${absent.length} of these files `
            + `(${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', ...' : ''}) -- pass a new --tag, e.g. ${o.tag.replace(/\d+$/, d => +d + 1)}`);
    }

    fs.writeFileSync(manifestPath, JSON.stringify({
        _comment: 'Generated by tools/release/build-engines-manifest.mjs -- do not edit by hand. '
            + 'Nets and models not bundled are fetched from the named release and must match size + sha256.',
        repo: REPO,
        files: Object.fromEntries(names.map(n => [n, files[n]])),
    }, null, 2) + '\n');

    const sum = (pred) => names.filter(n => pred(files[n])).reduce((t, n) => t + files[n].size, 0);
    console.log(`\nwrote ${MANIFEST}`);
    console.log(`all remote files   ${mb(sum(() => true))}  (${names.length} files)`);
    for (const t of [...new Set(names.map(n => files[n].tag))].sort()) {
        console.log(`  on ${t.padEnd(15)}${mb(sum(e => e.tag === t))}${t === o.tag ? '  <- to upload' : '  (already published, same sha256)'}`);
    }
    console.log('per directory (what a fresh slim install downloads the first time that engine runs, at most):');
    for (const d of [...new Set(names.map(n => files[n].dir))]) console.log(`  ${d.padEnd(34)}${mb(sum(e => e.dir === d))}`);
    const split = names.filter(n => files[n].parts);
    console.log(`over the 2 GiB asset limit (uploaded as .partN): ${split.length ? split.join(', ') : 'none'}`);

    if (!o.out) return;
    fs.mkdirSync(o.out, {recursive: true});
    let staged = 0;
    for (const n of names.filter(x => files[x].tag === o.tag)) {
        const e = files[n], src = found[n].sources;
        if (e.parts) {
            // re-split the joined bytes at PART_BYTES, whatever the git split was
            const all = Buffer.concat(src.map(s => fs.readFileSync(s)));
            for (let p = 0; p < e.parts; p++) fs.writeFileSync(path.join(o.out, `${n}.part${p}`), all.subarray(p * PART_BYTES, (p + 1) * PART_BYTES));
        } else if (src.length === 1) {
            const dst = path.join(o.out, n);
            fs.rmSync(dst, {force: true});
            try { fs.linkSync(src[0], dst); } catch (err) { fs.copyFileSync(src[0], dst); }   // hardlink: no second GB on disk
        } else {
            fs.writeFileSync(path.join(o.out, n), Buffer.concat(src.map(s => fs.readFileSync(s))));   // git parts -> one asset
        }
        staged += e.size;
        console.log(`staged ${mb(e.size)}  ${n}`);
    }
    console.log(`\n${mb(staged)} staged in ${o.out} for release ${o.tag}. Publish (by hand, once):`);
    // --latest=false: a new release is made "Latest" by default, and the update check reads Latest (BOUNDARY-5)
    console.log(`  gh release create ${o.tag} ${o.out}/* --repo ${REPO} --title "${o.tag}" --latest=false --notes "Engine nets for the slim install. Never re-tag: the extension pins these bytes by sha256."`);
}

main().catch(e => { console.error('build-engines-manifest:', e.message); process.exit(1); });
