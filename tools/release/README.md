# Release process: slim zips + assets releases

The nets and models (every `*.nnue` and `*.onnx` under `lib/engine`, about 1 GB) no longer ride in
each version's zip. They live on fixed assets releases, uploaded once when they change:

| release      | holds                                   | size     |
|--------------|-----------------------------------------|----------|
| `models-v1`  | Maia, Maia-2, Maia-3, Elite Leela, vision ONNX (already published) | 314.3 MB |
| `engines-v1` | Stockfish 18 / 19 / 19-small nets, the 12 Fairy-Stockfish nets | 706.5 MB |

`src/offscreen/engine-assets.json` lists each file with its size, sha256 and release tag. It ships in
both zips. The loader (`src/offscreen/model-fetch.js`) tries the bundled file first, then the git
`.partN` split, then the Cache API, then the release, and refuses anything that fails the sha256.

## Every release

1. Check the manifest still matches `lib/engine` (release-zips.sh does this and stops if not):

       node tools/release/build-engines-manifest.mjs --check

2. Build and verify both zips from a clean checkout of the tag:

       tools/release/release-zips.sh 3.1.316

   | zip                          | before  | after   |
   |------------------------------|---------|---------|
   | `mephisto-<v>.zip` (full)    | 689.7 MB | 11.4 MB |
   | `mephisto-<v>-update.zip`    | 6.8 MB  | 6.8 MB (unchanged) |

3. Upload both zips to the version's release as before.

## Only when a net or model changes

1. Rebuild the manifest. A file whose bytes are already on an existing assets release keeps that
   tag, and everything else gets the new one. Never re-upload different bytes under an old tag:
   installs have that tag's sha256 pinned, and a cached file is never fetched again.

       node tools/release/build-engines-manifest.mjs --tag engines-v2 --reuse models-v1,engines-v1 --out ../engines-v2

2. Commit the new `src/offscreen/engine-assets.json` together with the `lib/engine` change.
3. Publish the staged files once (the script prints the exact command):

       gh release create engines-v2 ../engines-v2/* --title engines-v2 --notes "..."

   This has to be done BEFORE the version that needs it ships. A slim install asking for a tag
   that does not exist yet gets HTTP 404 and no engine.

The first run, for `engines-v1`, is:

    node tools/release/build-engines-manifest.mjs --tag engines-v1 --reuse models-v1 --out ../engines-v1

A file over GitHub's 2 GiB asset limit is staged as `<name>.partN` (1 GiB parts) and the manifest
records `parts`, so the loader fetches and joins them. No file is anywhere near that today (the largest
is 109 MB).

## The trade-off

A fresh install from the slim zip has no nets on disk. The first time each engine runs, it downloads
its net and keeps it in the Cache API. The panel's move line shows the progress. The download
needs the optional download-host permission (Settings, Updates), the same one the self-updater uses.
Without it, or offline, that engine does not start and the panel says why.

| engine / feature            | first-use download |
|-----------------------------|--------------------|
| Stockfish 19                | 98.5 MB |
| Stockfish 19 small          | 1.2 MB |
| Stockfish 18                | 112.4 MB (both of its nets) |
| Fairy-Stockfish, per variant | 1.0 to 80.2 MB (47.7 MB for standard chess) |
| Maia, per rating band       | 3.5 MB |
| Maia-2 / Maia-3             | 93.2 / 92.2 MB |
| Elite Leela                 | 19.2 MB |
| read-from-screen (vision)   | 74.8 MB |

A git checkout and every install that started from a pre-slim full zip (including those that have
only taken update zips since) keep their bundled files and never download anything.
