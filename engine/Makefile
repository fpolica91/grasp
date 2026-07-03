.PHONY: venv test clean

venv:
	python3 -m venv .venv
	.venv/bin/pip install -U pip
	.venv/bin/pip install pytest jsonschema pyyaml
	# ast-grep-py: static (no-code-execution) vocabulary extraction. Optional — the
	# code falls back to the import path when absent — but installed by default so the
	# SAFE path is the default and its regression tests run.
	.venv/bin/pip install ast-grep-py || echo "ast-grep-py unavailable; vocab falls back to import path"
	# esprima: JS/TS AST-rewrite for real interior nodes. Optional — adapters degrade to
	# endpoints-only when absent — but installed so the TS/JS interior-trace tests run.
	.venv/bin/pip install esprima || echo "esprima unavailable; JS/TS trace falls back to endpoints-only"

# THE gate: flow contract (FC1–FC8) + conformance moat + every flow test.
# Language-toolchain tests self-skip when go/java/dotnet/g++/node are absent.
test:
	.venv/bin/pytest

clean:
	rm -rf .venv __pycache__ .worktrees .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
