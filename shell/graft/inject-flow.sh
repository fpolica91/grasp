#!/usr/bin/env bash
# Inject the grasp dataflow surface into an extracted ZCode fork. Copies grasp-flow.mjs
# into out/main and prepends its import (below the egress guard). Idempotent.
#   ./inject-flow.sh <path-to-extracted-app>
set -euo pipefail
APP="${1:?usage: inject-flow.sh <extracted-app>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAIN="$APP/out/main"; ENTRY="$MAIN/index.js"
[ -f "$ENTRY" ] || { echo "error: $ENTRY not found"; exit 1; }
cp "$HERE/grasp-flow.mjs" "$MAIN/grasp-flow.mjs"
LINE='import "./grasp-flow.mjs";'
if grep -qF 'grasp-flow.mjs' "$ENTRY"; then
  echo "  ok (already injected)"
else
  if head -n1 "$ENTRY" | grep -qF 'grasp-egress-guard.mjs'; then
    { head -n1 "$ENTRY"; printf '%s\n' "$LINE"; tail -n +2 "$ENTRY"; } > "$ENTRY.tmp"
  else
    printf '%s\n' "$LINE" | cat - "$ENTRY" > "$ENTRY.tmp"
  fi
  mv "$ENTRY.tmp" "$ENTRY"; echo "  injected grasp-flow surface"
fi