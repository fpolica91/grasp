"""Recipe layer — resolve a runnable environment for an arbitrary repo.

Resolution (detection) is pure/offline and fully gate-tested. Provisioning executes
(venv + pip = network + the repo's build code), so its LOGIC is tested with a mocked
subprocess (offline), and its pure branches (source_import/image/no-cmds/cache) are
tested directly. Real venv+pip provisioning is opt-in, not part of the gate.
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace

from dreplay import recipe
from dreplay.recipe import RunnableEnv, provision, resolve_env


# ---- detection (pure, offline) -------------------------------------------------
def test_requirements_txt_is_declared(tmp_path):
    (tmp_path / "requirements.txt").write_text("flask\n")
    env = resolve_env(str(tmp_path))
    assert env.kind == "declared"
    assert env.install_cmds == ("pip install -r requirements.txt",)
    assert "requirements.txt" in env.detected
    assert not env.provisioned  # resolution does not provision


def test_pyproject_is_declared(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    env = resolve_env(str(tmp_path))
    assert env.kind == "declared"
    assert env.install_cmds == ("pip install .",)


def test_requirements_wins_over_pyproject(tmp_path):
    (tmp_path / "requirements.txt").write_text("flask\n")
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    env = resolve_env(str(tmp_path))
    assert env.install_cmds == ("pip install -r requirements.txt",)
    # pyproject still noted as evidence
    assert "pyproject.toml" in env.detected


def test_markers_only_is_declared_without_installer(tmp_path):
    (tmp_path / "tox.ini").write_text("[tox]\n")
    env = resolve_env(str(tmp_path))
    assert env.kind == "declared"
    assert env.install_cmds == ()
    assert "no venv installer" in env.provenance_note


def test_no_config_falls_back_to_source_import(tmp_path):
    (tmp_path / "app.py").write_text("def f(): return 1\n")
    env = resolve_env(str(tmp_path))
    assert env.kind == "source_import"
    assert env.interpreter_path == sys.executable
    assert env.provisioned  # host interpreter is a concrete interpreter
    assert "no recipe applied" in env.provenance_note


def test_explicit_override_wins(tmp_path):
    (tmp_path / "requirements.txt").write_text("flask\n")  # would be 'declared'
    d = tmp_path / ".dreplay"
    d.mkdir()
    (d / "recipe.json").write_text(json.dumps({
        "image": "ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-1",
        "note": "swe-bench prebuilt image",
    }))
    env = resolve_env(str(tmp_path))
    assert env.kind == "override"
    assert env.image_ref.startswith("ghcr.io/epoch-research/")
    assert env.provenance_note == "swe-bench prebuilt image"


def test_broken_override_falls_through(tmp_path):
    d = tmp_path / ".dreplay"
    d.mkdir()
    (d / "recipe.json").write_text("{ not valid json")
    (tmp_path / "requirements.txt").write_text("flask\n")
    env = resolve_env(str(tmp_path))
    assert env.kind == "declared", "a broken override must not crash — fall through"


def test_repo2run_plan_is_opt_in_and_described_not_run(tmp_path):
    (tmp_path / "app.py").write_text("def f(): return 1\n")
    # without allow_synth → source_import
    assert resolve_env(str(tmp_path)).kind == "source_import"
    # with allow_synth → repo2run plan (described, not provisioned)
    env = resolve_env(str(tmp_path), ref="abc123", allow_synth=True)
    assert env.kind == "repo2run"
    assert not env.provisioned
    assert "Repo2Run" in env.provenance_note
    assert any("build_agent/main.py" in c for c in env.install_cmds)


# ---- provision: pure branches (offline) ---------------------------------------
def test_provision_source_import_is_noop(tmp_path):
    env = RunnableEnv(kind="source_import", interpreter_path=sys.executable)
    assert provision(env, str(tmp_path)) is env


def test_provision_image_recipe_is_left_for_sandbox_layer(tmp_path):
    env = RunnableEnv(kind="override", image_ref="my/image:latest",
                      install_cmds=("pip install .",))
    out = provision(env, str(tmp_path))
    assert out.interpreter_path is None and out.image_ref == "my/image:latest"


def test_provision_no_install_cmds_is_noop(tmp_path):
    env = RunnableEnv(kind="declared", install_cmds=())
    assert provision(env, str(tmp_path)) is env


def test_cache_key_is_deterministic_and_plan_sensitive(tmp_path):
    r = str(tmp_path)
    k1 = recipe._venv_key(r, ("pip install -r requirements.txt",))
    k2 = recipe._venv_key(r, ("pip install -r requirements.txt",))
    k3 = recipe._venv_key(r, ("pip install .",))
    assert k1 == k2 and k1 != k3


# ---- provision: venv logic (subprocess mocked → offline) ----------------------
def test_provision_creates_venv_and_swaps_interpreter(tmp_path, monkeypatch):
    calls = []

    def _fake_run(cmd, **kw):
        calls.append((list(cmd), kw.get("cwd")))
        # emulate `python -m venv <dir>` creating the bin/python the code checks for
        if len(cmd) >= 3 and cmd[1] == "-m" and cmd[2] == "venv":
            vdir = cmd[3]
            os.makedirs(os.path.join(vdir, "bin"), exist_ok=True)
            open(os.path.join(vdir, "bin", "python"), "w").close()
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(recipe.subprocess, "run", _fake_run)
    cache = tmp_path / "cache"
    env = RunnableEnv(kind="declared", install_cmds=("pip install -r requirements.txt",))
    out = provision(env, str(tmp_path), cache_dir=str(cache))

    assert out.interpreter_path and out.interpreter_path.endswith("/bin/python")
    assert "venv provisioned" in out.provenance_note
    # venv created, then pip rewritten to the venv's python, cwd=repo
    assert any(c[0][1:3] == ["-m", "venv"] for c in calls)
    pip_call = next(c for c in calls if "pip" in c[0])
    assert pip_call[0][0].endswith("/bin/python") and pip_call[0][1:3] == ["-m", "pip"]
    assert pip_call[1] == os.path.abspath(str(tmp_path))  # cwd=repo


def test_provision_reuses_cached_venv(tmp_path, monkeypatch):
    calls = []

    def _fake_run(cmd, **kw):
        calls.append(list(cmd))
        if len(cmd) >= 4 and cmd[2] == "venv":
            os.makedirs(os.path.join(cmd[3], "bin"), exist_ok=True)
            open(os.path.join(cmd[3], "bin", "python"), "w").close()
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(recipe.subprocess, "run", _fake_run)
    cache = str(tmp_path / "cache")
    env = RunnableEnv(kind="declared", install_cmds=("pip install .",))
    provision(env, str(tmp_path), cache_dir=cache)
    n_first = len(calls)
    out2 = provision(env, str(tmp_path), cache_dir=cache)  # second time → cached
    assert len(calls) == n_first, "cached venv must not re-run venv/pip"
    assert "cached venv" in out2.provenance_note
