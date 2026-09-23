#!/usr/bin/env bash
# Build Rodent IV (GPL-3.0, Pawel Koziol / Bernhard C. Maerz, https://github.com/nescitus/rodent-iv)
# natively and stage it where install-native.sh looks for it:
#
#   native-host/engines/rodent-iv/rodent-iv          the engine
#   native-host/engines/rodent-iv/personalities/     basic.ini + the personality .txt files
#
#   ./build-rodent.sh            (~16 s on an M-series Mac, clang++, no dependencies)
#
# Pinned to one upstream commit so a rebuild is the same engine. TWO local changes, in the patch below:
#
# 1. rodent.h StartThinkThread captured its `p` parameter BY REFERENCE into the search thread, and
#    returns at once -- so the thread read the position pointer out of a dead stack frame. MEASURED on
#    arm64 macOS, unpatched: `go depth 5` from the start position segfaulted (exit -11) at depth 1, or
#    answered the illegal `bestmove a1b1`; lldb put the crash in SearchRoot on a POS full of ASCII.
#    Captured by value it searches normally. Undefined behaviour on every platform, not a Mac quirk.
# 2. rodenthome.cpp: upstream's macOS branch of SetRodentHomeDir is an empty TODO, so personalities/
#    resolved against the CURRENT directory (wherever Chrome started the host), and after the first
#    chdir into it not even that -- basic.ini was never read, the Personality option was never
#    declared, and every personality silently played as the default. Filled with
#    _NSGetExecutablePath, the macOS twin of what the Linux branch does with /proc/self/exe.
#
# The opening books (books/, 68 MB) are NOT staged: in an analysis panel a book move arrives with
# no score and no line. Copy upstream's books/ beside the binary to get them back.
set -euo pipefail
cd "$(dirname "$0")"
REPO=https://github.com/nescitus/rodent-iv.git
COMMIT=e8d84c8c8c189a1cf4eb27c578fc573af3b916d2   # 2021-04-29, Rodent IV 0.33
OUT="$(pwd)/engines/rodent-iv"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git -C "$WORK" init -q
git -C "$WORK" fetch -q --depth 1 "$REPO" "$COMMIT"
git -C "$WORK" checkout -q FETCH_HEAD

patch -d "$WORK" -p1 -l <<'PATCH'
--- a/sources/src/rodent.h
+++ b/sources/src/rodent.h
@@ -981,7 +981,7 @@
     std::thread mWorker;
     void StartThinkThread(POS *p) {
         mDpCompleted = 0;
-        mWorker = std::thread([&] { Think(p); });
+        mWorker = std::thread([this, p] { Think(p); }); // p BY VALUE: it dies with this frame
     }

     ~cEngine() { WaitThinkThread(); };  // should fix crash on windows on console closing
--- a/sources/src/rodenthome.cpp
+++ b/sources/src/rodenthome.cpp
@@ -22,6 +22,11 @@
     #include <sys/stat.h>
     #include <unistd.h>
 #endif
+#if defined(__APPLE__)
+    #include <mach-o/dyld.h>
+    #include <climits>
+    #include <cstdlib>
+#endif

 #include "rodent.h"

@@ -174,8 +179,13 @@
     }

 #elif defined (__APPLE__)
-    // #error something should be done here, look for _NSGetExecutablePath(path, &size)
-    // RodentHomeDirWStr = ...
+    // the executable's own directory, as the Linux branch does with /proc/self/exe
+    char exe_path[1024], real_path[PATH_MAX];
+    uint32_t exe_size = sizeof(exe_path);
+    if (_NSGetExecutablePath(exe_path, &exe_size) == 0 && realpath(exe_path, real_path)) {
+        *(strrchr(real_path, '/') + 1) = '\0';
+        RodentHomeDirWStr = CStr2WStr(real_path);
+    }
PATCH

# the Makefile's flags minus the gcc-only ones (-fprefetch-loop-arrays) and -g
( cd "$WORK/sources" && c++ -std=c++14 -O3 -DNDEBUG -fno-rtti -w -pipe src/*.cpp -o "$WORK/rodent-iv" )

rm -rf "$OUT"; mkdir -p "$OUT/personalities"
cp "$WORK/rodent-iv" "$OUT/rodent-iv"
cp "$WORK"/personalities/*.txt "$WORK/personalities/basic.ini" "$OUT/personalities/"
cp "$WORK/LICENSE" "$OUT/LICENSE"
echo "-> $OUT/rodent-iv ($(wc -c < "$OUT/rodent-iv" | tr -d ' ') bytes) + $(ls "$OUT/personalities" | wc -l | tr -d ' ') personality files"
