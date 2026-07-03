#!/usr/bin/env bash
# Apply grasp's telemetry rip-out to an extracted ZCode app tree.
#
#   ./apply.sh <path-to-extracted-app>   [<path-to-resources-dir>]
#
# <extracted-app>  = the unpacked app.asar (contains out/, node_modules/, package.json)
# <resources-dir>  = optional; the installed resources/ (sibling of app.asar) holding
#                    app-update.yml — disabling it stops the auto-updater feed.
#
# Idempotent: re-running is a no-op. The guard itself is deny-by-default; set
# GRASP_ALLOW_HOSTS at launch to permit your model provider (e.g. api.z.ai).
set -euo pipefail

APP="${1:?usage: apply.sh <extracted-app> [resources-dir]}"
RES="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="grasp-egress-guard.mjs"
IMPORT_LINE='import "./'"$GUARD"'";'

inject() {
  local dir="$1"
  local entry="$dir/index.js"
  [ -f "$entry" ] || { echo "  skip: $entry not found"; return; }
  cp "$HERE/$GUARD" "$dir/$GUARD"
  if head -n1 "$entry" | grep -qF "$GUARD"; then
    echo "  ok (already injected): $entry"
  else
    printf '%s\n' "$IMPORT_LINE" | cat - "$entry" > "$entry.tmp" && mv "$entry.tmp" "$entry"
    echo "  injected guard FIRST in: $entry"
  fi
}

echo "== injecting deny-by-default egress guard (Node + Chromium layers) =="
inject "$APP/out/main"
inject "$APP/out/host"

echo "== telemetry SDKs: KEPT on disk, denied at the network =="
# Do NOT delete @arms / @larksuiteoapi: the shell IMPORTS them at startup, so removing
# them crashes the app (ERR_MODULE_NOT_FOUND @larksuiteoapi/node-sdk — verified booting
# the fork under Xvfb). The egress guard already denies their network, which is the real
# and sufficient protection. Deleting the package is breaking the plumbing, not securing it.
echo "  (guard denies their egress; packages left intact so the shell still boots)"

echo "== disabling auto-updater feed =="
if [ -n "$RES" ] && [ -f "$RES/app-update.yml" ]; then
  mv "$RES/app-update.yml" "$RES/app-update.yml.disabled"
  echo "  neutralized $RES/app-update.yml"
else
  echo "  (no resources dir passed, or app-update.yml absent — updater hosts are denied by the guard regardless)"
fi

echo "== done. Repack with: npx @electron/asar pack <extracted-app> app.asar =="
echo "== launch with:      GRASP_ALLOW_HOSTS=api.z.ai <electron> =="
