#!/usr/bin/env bash
# Graft the grasp dataflow-graph window into an extracted ZCode app tree.
#
#   ./graft.sh <path-to-extracted-app>
#
# Adds our graph window + engine bridge WITHOUT editing any of ZCode's minified
# bundles: it copies grasp's bridge/preload/renderer into out/main/ and prepends one
# import to out/main/index.js (kept BELOW the egress guard, which must stay first).
#
# Run apply.sh (telemetry guard) FIRST, then this. Then repack + launch with
# GRASP_ENGINE pointing at the engine dir. Idempotent.
set -euo pipefail

APP="${1:?usage: graft.sh <extracted-app>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"           # shell/
MAIN="$APP/out/main"
ENTRY="$MAIN/index.js"
[ -f "$ENTRY" ] || { echo "error: $ENTRY not found (extract app.asar first)"; exit 1; }

echo "== copying grasp graph window into the shell =="
cp "$HERE/grasp-bridge.mjs" "$MAIN/grasp-bridge.mjs"
mkdir -p "$MAIN/grasp/renderer"
cp "$ROOT/app/preload.js" "$MAIN/grasp/preload.js"
cp -r "$ROOT/app/renderer/." "$MAIN/grasp/renderer/"
echo "  copied grasp-bridge.mjs + grasp/preload.js + grasp/renderer/"

echo "== wiring the bridge into out/main/index.js (below the egress guard) =="
BRIDGE='import "./grasp-bridge.mjs";'
if grep -qF 'grasp-bridge.mjs' "$ENTRY"; then
  echo "  ok (already grafted)"
else
  if head -n1 "$ENTRY" | grep -qF 'grasp-egress-guard.mjs'; then
    # keep the guard on line 1; insert the bridge as line 2
    { head -n1 "$ENTRY"; printf '%s\n' "$BRIDGE"; tail -n +2 "$ENTRY"; } > "$ENTRY.tmp"
  else
    printf '%s\n' "$BRIDGE" | cat - "$ENTRY" > "$ENTRY.tmp"
  fi
  mv "$ENTRY.tmp" "$ENTRY"
  echo "  grafted"
fi

echo "== done =="
echo "Repack:  npx @electron/asar pack '$APP' app.asar"
echo "Launch:  GRASP_ENGINE=/path/to/grasp/engine GRASP_ALLOW_HOSTS=api.z.ai <electron-or-zcode-binary> ."
