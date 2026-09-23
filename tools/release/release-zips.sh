#!/usr/bin/env bash
# PROPOSED replacement for the repo-root release-zips.sh: the full archive stops carrying the nets.
#
#   tools/release/release-zips.sh 3.1.316 [ref]        # ref defaults to master
#
# FULL     mephisto-<v>.zip          ~11 MB   everything EXCEPT the nets/models listed in
#                                             src/offscreen/engine-assets.json. New installs use this.
# UPDATE   mephisto-<v>-update.zip   ~6 MB    unchanged: everything except lib/engine, lib/ort, docs.
#
# The nets (~1 GB of *.nnue / *.onnx) live on fixed assets releases instead -- `engines-v1` for the
# Stockfish/Fairy nets, `models-v1` for the ONNX models -- built ONCE, when a net changes, by
# build-engines-manifest.mjs (see README.md here). The extension resolves each one bundled first,
# then from the Cache API, then from that release, and checks its SHA-256 against the manifest.
#
# THE COST, stated once: a fresh install from the slim zip has no nets on disk, so the first use of
# each engine is a download (98.5 MB for Stockfish 19) and needs the download-host permission. An
# existing install, a git checkout and every update keep working offline, unchanged.
set -euo pipefail
cd "$(dirname "$0")/../.."

V="${1:?usage: tools/release/release-zips.sh <version> [ref]}"
REF="${2:-master}"
OUT="$(cd .. && pwd)"
MANIFEST=src/offscreen/engine-assets.json

# THE HARNESS GATES THE BUILD (v3.1.248): the fixture suite must pass before any archive is cut.
# Skipped ONLY when puppeteer is not resolvable on this machine -- loudly, never silently.
if node -e "require('puppeteer')" 2>/dev/null; then
    echo "fixture harness gate..."
    node test/run-harness.js || { echo "HARNESS FAILED -- no release" >&2; exit 1; }
else
    echo "WARNING: puppeteer not resolvable (set NODE_PATH); the fixture harness gate was SKIPPED" >&2
fi

# THE MANIFEST GATES THE BUILD: a net that changed without a new manifest would ship a slim zip whose
# download fails its SHA check on every fresh install. The check reads the WORKING TREE, so that tree
# must be exactly what $REF archives for these paths.
[ -z "$(git status --porcelain -- lib/engine "$MANIFEST")" ] && git diff --quiet HEAD "$REF" -- lib/engine "$MANIFEST" \
    || { echo "!! lib/engine or $MANIFEST differs from $REF -- check out $REF cleanly first" >&2; exit 1; }
node tools/release/build-engines-manifest.mjs --check | tail -1   # on failure: stale list on stderr, set -e stops here

# One exclude per manifest entry, derived from the manifest itself so the zip and the loader can
# never disagree about which files are remote. The trailing * also drops the git .partN splits.
SLIM_EXCLUDE=()
while IFS= read -r p; do SLIM_EXCLUDE+=(":(exclude,glob)$p*"); done < <(node -e '
    const m = require("./'"$MANIFEST"'");
    for (const [name, e] of Object.entries(m.files)) console.log(`${e.dir}/${name}`);')
UPDATE_EXCLUDE=(':(exclude)lib/engine/*' ':(exclude)lib/ort/*' ':(exclude)docs/*')

echo "full   -> $OUT/mephisto-$V.zip   (slim: ${#SLIM_EXCLUDE[@]} nets/models left to the assets releases)"
git archive --format=zip -9 --prefix="Mephisto-$V/" "$REF" -o "$OUT/mephisto-$V.zip" \
    -- . "${SLIM_EXCLUDE[@]}" ':(exclude)docs/*'

echo "update -> $OUT/mephisto-$V-update.zip"
git archive --format=zip -9 --prefix="Mephisto-$V/" "$REF" -o "$OUT/mephisto-$V-update.zip" \
    -- . "${UPDATE_EXCLUDE[@]}"

# --- verify, because a silently wrong split is worse than no archive at all ------------------------
# List each archive ONCE into a file: `unzip -l | grep -q` under pipefail reports failure on a match
# (grep exits early, unzip takes SIGPIPE).
listing_full="$(mktemp)"; listing_upd="$(mktemp)"
trap 'rm -f "$listing_full" "$listing_upd"' EXIT
unzip -l "$OUT/mephisto-$V.zip"        > "$listing_full"
unzip -l "$OUT/mephisto-$V-update.zip" > "$listing_upd"

need=(manifest.json src/popup/popup.js src/scripts/content-script.js lib/chess.js lib/lru.min.js "$MANIFEST")
for f in "${need[@]}"; do
    grep -Fq "Mephisto-$V/$f" "$listing_upd" \
        || { echo "!! update archive is missing $f -- refusing to ship it"; exit 1; }
    grep -Fq "Mephisto-$V/$f" "$listing_full" \
        || { echo "!! full archive is missing $f -- refusing to ship it"; exit 1; }
done
! grep -Fq "lib/engine/" "$listing_upd" \
    || { echo "!! update archive still contains lib/engine -- the exclusion did not apply"; exit 1; }
# the slim full zip must still boot every engine: glue + wasm + the small tables stay bundled
for f in lib/engine/stockfish-19/sf_19.wasm lib/engine/fairy-stockfish-14/fsf_14.js \
         lib/engine/maia/lc0_policy_index.json lib/ort/ort.wasm.bundle.min.mjs; do
    grep -Fq "Mephisto-$V/$f" "$listing_full" \
        || { echo "!! full archive is missing $f -- the slim exclusion took too much"; exit 1; }
done
! grep -Eq '\.(nnue|onnx)(\.part[0-9]+)?$' "$listing_full" \
    || { echo "!! full archive still contains a net: $(grep -Em1 '\.(nnue|onnx)' "$listing_full")"; exit 1; }

size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }
printf '\n%-10s %s bytes\n' full   "$(size "$OUT/mephisto-$V.zip")"
printf '%-10s %s bytes\n'   update "$(size "$OUT/mephisto-$V-update.zip")"
echo "both archives verified"
