#!/usr/bin/env bash
# Strip ZCode's z.ai account auth from a fork. We do not use their accounts — this
# replaces the OAuth session-restore with a synthetic LOCAL session so the app boots
# straight into the workspace. Model calls use the API key in ~/.zcode/v2/config.json
# (the provider's options.apiKey), not a z.ai account.
#
#   ./strip-auth.sh <path-to-extracted-app>
#
# Patches out/host/index.js: restoreCachedSession() -> return a synthetic user
# (Ub({id,username,displayName})) + set our key provider active. Idempotent.
# Verified: boots past "Welcome to ZCode / Connect your account" into the workspace,
# user shows as "grasp", session created on GLM-5.2.
set -euo pipefail

APP="${1:?usage: strip-auth.sh <extracted-app>}"
HOST="$APP/out/host/index.js"
PROVIDER="${GRASP_PROVIDER:-builtin:zai}"   # which config.json provider to make active
[ -f "$HOST" ] || { echo "error: $HOST not found"; exit 1; }

GRASP_PROVIDER="$PROVIDER" python3 - "$HOST" <<'PY'
import sys, os
p = sys.argv[1]
s = open(p, encoding="utf-8", errors="replace").read()
if "grasp-local" in s:
    print("  ok (already stripped)"); sys.exit(0)
i = s.find("restoreCachedSession(){")
if i < 0:
    print("  WARN: restoreCachedSession not found — ZCode version drift; skipping"); sys.exit(0)
start = s.find("{", i); depth = 0; end = start
for j in range(start, len(s)):
    if s[j] == "{": depth += 1
    elif s[j] == "}":
        depth -= 1
        if depth == 0: end = j + 1; break
prov = os.environ["GRASP_PROVIDER"]
patch = ('restoreCachedSession(){try{await this.repo.setActiveProvider(%r)}catch{}'
         'return Ub({id:"grasp-local",username:"grasp",displayName:"grasp"})}' % prov)
open(p, "w", encoding="utf-8").write(s[:i] + patch + s[end:])
print("  stripped restoreCachedSession -> synthetic local session (provider %s)" % prov)
PY
echo "== auth stripped. The app boots to the workspace; set your model key in"
echo "   ~/.zcode/v2/config.json under provider['$PROVIDER'].options.apiKey =="
