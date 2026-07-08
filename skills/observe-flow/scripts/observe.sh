#!/usr/bin/env bash
# Run the grasp engine's flow skill (observe | diff | fuzz) and print the graph
# contract as JSON. Locates the engine in this order:
#   1. $GRASP_PY                  — an explicit python that can import dreplay
#   2. $GRASP_ENGINE/.venv/bin/python  — a provisioned engine checkout
#   3. python3                    — assumes `grasp-engine` is pip-installed
# See INSTALL.md for one-time setup.
set -euo pipefail

PY="${GRASP_PY:-}"
if [ -z "$PY" ] && [ -n "${GRASP_ENGINE:-}" ] && [ -x "$GRASP_ENGINE/.venv/bin/python" ]; then
  PY="$GRASP_ENGINE/.venv/bin/python"
fi
PY="${PY:-python3}"

if ! "$PY" -c "import dreplay" 2>/dev/null; then
  echo '{"ok":false,"error":"grasp engine not importable. See INSTALL.md: pip install the engine, or set GRASP_ENGINE=/path/to/grasp/engine (with a .venv) or GRASP_PY."}' >&2
  exit 2
fi

exec "$PY" -m dreplay.skill "$@"
