#!/usr/bin/env bash
# OPTIONAL: enable full-power NATIVE Stockfish / Fairy-Stockfish in Mephisto.
#
# The bundled WASM engines work with NO setup. This script is only for users who want native
# full-strength engines (all CPU cores, real RAM). It registers a Chrome native-messaging host so
# the browser AUTO-LAUNCHES a local Stockfish -- there is NO server to run.
#
#   ./install-native.sh --ext-id <EXTENSION_ID> [--stockfish /path/to/stockfish] [--fairy /path/to/fairy-stockfish]
#
# --ext-id : your Mephisto extension ID from chrome://extensions (Developer mode on). It changes
#            when an unpacked extension is reloaded -- re-run this script if native engines stop working.
# --stockfish / --fairy : engine binaries. Auto-detected from PATH if omitted. Install one via:
#            macOS: brew install stockfish fairy-stockfish   |   Linux: apt/pacman, or download from
#            stockfishchess.org and fairy-stockfish releases. Pick the build matching your CPU.
#
# Requires python3 with python-chess:  python3 -m pip install chess
set -euo pipefail
cd "$(dirname "$0")"
SRC_DIR="$(pwd)"

EXT_ID=""; SF_BIN=""; FAIRY_BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ext-id) EXT_ID="$2"; shift 2 ;;
    --stockfish) SF_BIN="$2"; shift 2 ;;
    --fairy) FAIRY_BIN="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done
[ -n "$EXT_ID" ] || { echo "!! --ext-id is required (copy it from chrome://extensions)"; exit 1; }

# a python3 that can import chess (Chrome launches hosts with a minimal PATH -> pin an absolute one)
PYBIN=""
for cand in "$(command -v python3 || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  if "$cand" -c "import chess.engine" 2>/dev/null; then PYBIN="$cand"; break; fi
done
[ -n "$PYBIN" ] || { echo "!! no python3 with python-chess found -- run:  python3 -m pip install chess"; exit 1; }

# auto-detect engine binaries if not given
[ -n "$SF_BIN" ]    || SF_BIN="$(command -v stockfish 2>/dev/null || true)"
[ -n "$FAIRY_BIN" ] || FAIRY_BIN="$(command -v fairy-stockfish 2>/dev/null || true)"

# runtime dir OUTSIDE TCC-protected folders (macOS blocks a Chrome-spawned host from reading
# ~/Desktop, ~/Documents, ~/Downloads); binaries + nets are copied here so Chrome can launch them.
case "$(uname -s)" in
  Darwin) RUNTIME_DIR="$HOME/Library/Application Support/Mephisto"
    BASE="$HOME/Library/Application Support"
    DIRS=(
      "$BASE/Google/Chrome/NativeMessagingHosts"
      "$BASE/Google/Chrome Canary/NativeMessagingHosts"
      "$BASE/Chromium/NativeMessagingHosts"
      "$BASE/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$BASE/Microsoft Edge/NativeMessagingHosts"
      "$BASE/Vivaldi/NativeMessagingHosts"
    ) ;;
  Linux) RUNTIME_DIR="$HOME/.local/share/mephisto"
    DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/vivaldi/NativeMessagingHosts"
    ) ;;
  *) echo "!! this installer supports macOS/Linux. On Windows, see the README (registry setup)."; exit 1 ;;
esac
mkdir -p "$RUNTIME_DIR/engines"

pin_shebang() { local f="$1" tmp; tmp="$(mktemp)"; { printf '#!%s\n' "$PYBIN"; tail -n +2 "$f"; } > "$tmp"; cat "$tmp" > "$f"; rm -f "$tmp"; }

# slug | binary | nnue-dir ("" = none). Fairy switches EvalFile per variant from the bundled nets.
NNUE_SRC="$SRC_DIR/../lib/engine/fairy-stockfish-14/nnue"
SPECS=("sf-native|$SF_BIN|" "fairy-native|$FAIRY_BIN|$NNUE_SRC")

installed=0
for spec in "${SPECS[@]}"; do
  slug="${spec%%|*}"; rest="${spec#*|}"; bin="${rest%%|*}"; nnue="${rest#*|}"
  if [ -z "$bin" ] || [ ! -x "$bin" ]; then
    echo "-- skipping $slug (no binary; pass --${slug%-native} /path or install it)"; continue
  fi
  runbin="$RUNTIME_DIR/engines/$slug.bin"; rm -f "$runbin"; cp "$bin" "$runbin"; chmod +x "$runbin"
  host="$RUNTIME_DIR/$slug-host.py"; rm -f "$host"; cp "$SRC_DIR/uci-native-host.py" "$host"; pin_shebang "$host"; chmod +x "$host"
  echo "$runbin" > "$RUNTIME_DIR/$slug.path"
  if [ -n "$nnue" ] && [ -d "$nnue" ]; then
    runnnue="$RUNTIME_DIR/engines/$slug-nnue"; rm -rf "$runnnue"; mkdir -p "$runnnue"
    cp "$nnue"/*.nnue "$runnnue"/ 2>/dev/null || true
    echo "$runnnue" > "$RUNTIME_DIR/$slug.nnue-dir"
  fi
  for d in "${DIRS[@]}"; do
    parent="$(dirname "$d")"; [ -d "$parent" ] || continue; mkdir -p "$d"
    cat > "$d/com.$slug.host.json" <<JSON
{
  "name": "com.$slug.host",
  "description": "Mephisto native UCI engine ($slug)",
  "path": "$host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  done
  echo "-> enabled native engine: $slug  (binary: $(basename "$bin"))"
  installed=$((installed + 1))
done
xattr -cr "$RUNTIME_DIR" 2>/dev/null || true  # strip web-download quarantine (macOS) so Chrome can launch

[ "$installed" -gt 0 ] || { echo "!! no engines enabled -- install stockfish/fairy-stockfish, or pass --stockfish/--fairy"; exit 1; }
echo
echo "Done. Reload the extension + the page, then pick a '(native)' engine. Chrome launches it -- no server."
echo "If native engines stop working after reloading the unpacked extension, re-run this with the new --ext-id."
