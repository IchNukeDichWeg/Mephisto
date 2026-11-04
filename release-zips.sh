#!/usr/bin/env bash
# The release builder is tools/release/release-zips.sh. This file was the pre-3.1.316 builder and still
# shipped: run from here, a release skipped every gate the new one has (clean tree, manifest version,
# glue diff and id, logic suite, native-host gate, engine manifest --check) and packed about 600 MB of
# nets into the full zip (audit 3.1.330 NATIVEB-6). It now only forwards, so the old usage line,
# `./release-zips.sh <version> [ref]`, builds through those gates.
exec "$(dirname "$0")/tools/release/release-zips.sh" "$@"
