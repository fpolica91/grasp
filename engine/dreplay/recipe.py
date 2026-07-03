"""Runnable-environment recipes — make an arbitrary repo *runnable* so the flow
instrument can observe it (the headline TREX-inspired capability).

The flow instrument runs the target FOR REAL and observes what it does. But today
it can only run code whose dependencies already import in dreplay's own
interpreter — the #1 wall real repos hit (missing deps, a foreign venv). A
"recipe" is how you make an arbitrary repo runnable: which interpreter, which
installed deps, or which container image. This module RESOLVES a recipe for a
repo (pure, offline, deterministic) and — opt-in — PROVISIONS it (creates a venv
and installs deps; container images land in the sandbox layer).

Resolution order (honest, never faked; first hit wins):
  1. **override** — an explicit ``.dreplay/recipe.json`` in the repo. Lets a team
     point at a pre-built image (e.g. a SWE-bench ``ghcr.io/...`` instance image or
     a Repo2Run-cached one) or pin an interpreter/install plan. Most authoritative.
  2. **declared** — the repo's own declared config (``requirements.txt``,
     ``pyproject.toml``, ``setup.py``/``.cfg``, ``Pipfile``, ``environment.yml``,
     ``tox.ini``, ``.devcontainer``, ``Dockerfile``). We derive an install plan.
  3. **repo2run** (opt-in; needs Docker + an LLM key + network) — synthesize a
     Dockerfile with ByteDance Repo2Run. **Never in the release gate**, same
     discipline as ``--llm-fuzz``.
  4. **source_import** — the fallback = today's behavior: assume deps import in the
     host interpreter. Honest last resort, clearly labelled.

Every :class:`RunnableEnv` carries a ``provenance_note`` so a run states *how* the
repo was made runnable (mode transparency — never a hidden guess).

RESOLUTION is pure/offline (detection only). PROVISIONING (:func:`provision`)
executes: it creates a venv and installs the repo's deps. That runs the repo's own
build/setup code and hits the network, so — like the instrument itself — it is
**never run on untrusted code**, and it is not part of the deterministic gate.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Literal

RecipeKind = Literal["override", "declared", "repo2run", "source_import"]

# Config files that make a repo's deps installable, in priority order. Each maps to
# the install command that provisions them (run inside a fresh venv).
_DECLARED_INSTALLERS: tuple[tuple[str, str], ...] = (
    ("requirements.txt", "pip install -r requirements.txt"),
    ("pyproject.toml", "pip install ."),
    ("setup.py", "pip install ."),
    ("setup.cfg", "pip install ."),
    ("Pipfile", "pip install pipenv && pipenv install --system"),
    ("environment.yml", "conda env update -f environment.yml"),
)
# Config files that signal a declared environment even if we don't drive their
# installer directly (they inform provenance + the container layer later).
_DECLARED_MARKERS: tuple[str, ...] = (
    "tox.ini", "Dockerfile", ".devcontainer/devcontainer.json",
    ".devcontainer.json", "poetry.lock", "requirements.in",
)

_OVERRIDE_PATH = ".dreplay/recipe.json"


@dataclass(frozen=True)
class RunnableEnv:
    """How to make a repo runnable. ``interpreter_path`` is the python the worker
    runs under once provisioned (``None`` until then; the host interpreter for
    ``source_import``). ``image_ref`` is a container image (override/repo2run) run
    by the sandbox layer. ``install_cmds`` is the plan that :func:`provision`
    executes. ``provenance_note`` is the human-readable transparency line."""

    kind: RecipeKind
    interpreter_path: str | None = None
    image_ref: str | None = None
    install_cmds: tuple[str, ...] = ()
    provenance_note: str = ""
    detected: tuple[str, ...] = ()

    @property
    def provisioned(self) -> bool:
        """True once the env has a concrete interpreter or image to run against."""
        return self.interpreter_path is not None or self.image_ref is not None


def resolve_env(repo: str, *, ref: str | None = None, allow_synth: bool = False) -> RunnableEnv:
    """Resolve (do not execute) the best runnable-environment recipe for ``repo``.

    Pure/offline: only reads the repo's declared config. Provisioning is a separate,
    opt-in step (:func:`provision`)."""
    repo = os.path.abspath(repo)

    override = _load_override(repo)
    if override is not None:
        return override

    declared = _detect_declared(repo)
    if declared is not None:
        return declared

    if allow_synth:
        return _repo2run_plan(repo, ref)

    return RunnableEnv(
        kind="source_import",
        interpreter_path=sys.executable,
        provenance_note=(
            "no recipe applied — deps assumed importable in the host interpreter "
            "(the repo declares no requirements/pyproject/setup, and no override)"
        ),
    )


def _load_override(repo: str) -> RunnableEnv | None:
    path = os.path.join(repo, _OVERRIDE_PATH)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            spec = json.load(fh)
    except (OSError, ValueError):
        return None  # a broken override is a skip, not a crash — fall through
    if not isinstance(spec, dict):
        return None
    image = spec.get("image") or spec.get("image_ref")
    interp = spec.get("interpreter") or spec.get("python")
    cmds = spec.get("install_cmds") or spec.get("install") or ()
    if isinstance(cmds, str):
        cmds = (cmds,)
    note = spec.get("note") or f"explicit override from {_OVERRIDE_PATH}"
    return RunnableEnv(
        kind="override",
        interpreter_path=interp,
        image_ref=image,
        install_cmds=tuple(cmds),
        provenance_note=note,
        detected=(_OVERRIDE_PATH,),
    )


def _detect_declared(repo: str) -> RunnableEnv | None:
    install_cmds: list[str] = []
    detected: list[str] = []
    for fname, cmd in _DECLARED_INSTALLERS:
        if os.path.isfile(os.path.join(repo, fname)):
            detected.append(fname)  # record every declared file as provenance evidence
            if not install_cmds:
                install_cmds.append(cmd)  # but the FIRST (highest-priority) drives the install
    for marker in _DECLARED_MARKERS:
        if os.path.exists(os.path.join(repo, marker)):
            detected.append(marker)
    if not detected:
        return None
    if not install_cmds:
        # markers only (e.g. a bare Dockerfile/tox.ini) — no venv installer we drive;
        # honest: we detected a declared env but can't provision it here (container
        # layer or override needed). Still better than pretending source_import.
        return RunnableEnv(
            kind="declared",
            install_cmds=(),
            provenance_note=(
                "declared environment detected (" + ", ".join(detected) + ") but no "
                "venv installer derived — supply " + _OVERRIDE_PATH + " or use the "
                "container layer to run it"
            ),
            detected=tuple(detected),
        )
    return RunnableEnv(
        kind="declared",
        install_cmds=tuple(install_cmds),
        provenance_note=(
            "provision a venv and " + " ; ".join(install_cmds)
            + " (from " + ", ".join(detected) + ")"
        ),
        detected=tuple(detected),
    )


def _repo2run_plan(repo: str, ref: str | None) -> RunnableEnv:
    """Describe (not run) a Repo2Run synthesis. Actual synthesis needs Docker + an
    LLM key + network and happens in :func:`provision` — never in the gate."""
    full_name = os.path.basename(repo.rstrip("/"))
    return RunnableEnv(
        kind="repo2run",
        install_cmds=(
            f"python build_agent/main.py --full_name {full_name} "
            f"--sha {ref or 'HEAD'} --root_path {repo} --llm <model>",
        ),
        provenance_note=(
            "Repo2Run Dockerfile synthesis (opt-in; needs Docker + LLM + network) — "
            "NOT yet provisioned"
        ),
    )


# --------------------------------------------------------------------------- #
# Provisioning (EXECUTES — opt-in, never in the gate, never on untrusted code)
# --------------------------------------------------------------------------- #
def _cache_root() -> str:
    base = os.environ.get("DREPLAY_RECIPE_CACHE") or os.path.join(
        os.path.expanduser("~"), ".cache", "dreplay", "venvs"
    )
    os.makedirs(base, exist_ok=True)
    return base


def _venv_key(repo: str, install_cmds: tuple[str, ...]) -> str:
    h = hashlib.sha256()
    h.update(os.path.abspath(repo).encode())
    for c in install_cmds:
        h.update(b"\x00")
        h.update(c.encode())
    return h.hexdigest()[:16]


def provision(env: RunnableEnv, repo: str, *, timeout_s: int = 600,
              cache_dir: str | None = None) -> RunnableEnv:
    """Execute a recipe's install plan and return a provisioned :class:`RunnableEnv`
    whose ``interpreter_path`` points at a ready venv.

    Only the venv-based (``declared``/``override`` with install_cmds) path is
    executed here; ``image_ref`` recipes (override/repo2run) are run by the sandbox
    layer. ``source_import`` and already-provisioned envs are returned unchanged.

    **Executes the repo's build/setup code and hits the network — never on
    untrusted code; not part of the deterministic gate.** Idempotent + cached: a
    venv is keyed by (repo, install plan), so repeated runs reuse it.
    """
    if env.kind == "source_import" or env.provisioned or not env.install_cmds:
        return env
    if env.image_ref:  # container recipe — sandbox layer executes it, not us
        return env

    repo = os.path.abspath(repo)
    cache_dir = cache_dir or _cache_root()
    venv_dir = os.path.join(cache_dir, _venv_key(repo, env.install_cmds))
    py = os.path.join(venv_dir, "bin", "python")
    ready_marker = os.path.join(venv_dir, ".dreplay-ready")

    from dataclasses import replace
    if os.path.isfile(py) and os.path.isfile(ready_marker):
        return replace(env, interpreter_path=py,
                       provenance_note=env.provenance_note + " [cached venv]")

    # Fresh venv (stdlib; offline). pip upgrades + installs run the repo's setup.
    subprocess.run([sys.executable, "-m", "venv", venv_dir], check=True,
                   capture_output=True, text=True, timeout=timeout_s)
    for cmd in env.install_cmds:
        # install_cmds are recipe-derived pip/pipenv strings; run them with the
        # venv's tools, cwd=repo so relative paths (`.`, `-r requirements.txt`) resolve.
        parts = cmd.split()
        if parts and parts[0] == "pip":
            parts = [py, "-m", "pip", *parts[1:]]
        subprocess.run(parts, cwd=repo, check=True, capture_output=True, text=True,
                       timeout=timeout_s)
    with open(ready_marker, "w") as fh:
        fh.write("ok")
    return replace(env, interpreter_path=py,
                   provenance_note=env.provenance_note + " [venv provisioned]")
