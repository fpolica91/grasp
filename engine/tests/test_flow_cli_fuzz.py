"""``--mode fuzz`` CLI wiring (DR-8jg): dispatch, guards, exit codes, output routing.

Before this wiring the flags were parsed but silently ignored — a fuzz request
ran a single instant execution instead (the silent-substitution defect class).
These tests pin: the guards exit 2, walled is the default, --allow-egress is the
explicit real-run opt-in, and the exit code surfaces variation for review.

Plus the instant-mode contract fix that fell out of it: a run that raises exits
1 with the raise surfaced (thrown-error node), per the documented contract.
"""
from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest

from dreplay import containment, flow_cli

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LEVEL = containment.detect().level
_KERNEL = _LEVEL in ("seccomp", "kernel_netns")


def _schema_file(tmp_path) -> str:
    p = tmp_path / "schema.json"
    p.write_text(json.dumps({
        "type": "object",
        "properties": {"token": {"type": "string"}},
        "required": ["token"],
    }))
    return str(p)


def test_fuzz_requires_schema(capsys):
    rc = flow_cli.main(["--entrypoint", "flow_canaries.scenarios.authenticate",
                        "--repo", _REPO, "--mode", "fuzz"])
    assert rc == 2
    assert "--schema" in capsys.readouterr().err


def test_fuzz_rejects_inline_input(tmp_path, capsys):
    rc = flow_cli.main(["--entrypoint", "flow_canaries.scenarios.authenticate",
                        "--repo", _REPO, "--mode", "fuzz",
                        "--schema", _schema_file(tmp_path),
                        "--input", '{"token": "x"}'])
    assert rc == 2
    assert "--input" in capsys.readouterr().err


def test_fuzz_is_python_only(tmp_path, capsys):
    rc = flow_cli.main(["--entrypoint", "main.go:Handle", "--repo", _REPO,
                        "--mode", "fuzz", "--language", "go",
                        "--schema", _schema_file(tmp_path)])
    assert rc == 2
    assert "Python" in capsys.readouterr().err


def test_fuzz_bad_schema_path_exits_2(capsys):
    rc = flow_cli.main(["--entrypoint", "flow_canaries.scenarios.authenticate",
                        "--repo", _REPO, "--mode", "fuzz",
                        "--schema", "/nonexistent/schema.json"])
    assert rc == 2
    assert "could not load schema" in capsys.readouterr().err


@pytest.mark.skipif(not _KERNEL, reason=f"no kernel egress containment (level={_LEVEL})")
def test_fuzz_walled_by_default_varied_exits_1(tmp_path, capsys):
    rc = flow_cli.main(["--entrypoint", "flow_canaries.scenarios.authenticate",
                        "--repo", _REPO, "--mode", "fuzz",
                        "--schema", _schema_file(tmp_path),
                        "--variants", "8", "--seed", "0"])
    cap = capsys.readouterr()
    assert rc == 1, "varied operands must exit 1 (surfaced for review)"
    assert "VARIED" in cap.out
    assert "kernel egress containment" in cap.err
    assert "egress wall:" in cap.out  # mode transparency in the report header


def test_fuzz_allow_egress_runs_real_and_warns(tmp_path, capsys):
    rc = flow_cli.main(["--entrypoint", "flow_canaries.scenarios.authenticate",
                        "--repo", _REPO, "--mode", "fuzz", "--allow-egress",
                        "--schema", _schema_file(tmp_path), "--variants", "6"])
    cap = capsys.readouterr()
    assert rc == 1
    assert "WARNING: --allow-egress" in cap.err
    assert "FULL" in cap.out  # the report header names the real-run stance


def test_fuzz_stable_exits_0(tmp_path, capsys):
    (tmp_path / "constant_target.py").write_text(
        'def constant(x: int) -> dict:\n    return {"status": "ok"}\n')
    schema = tmp_path / "s.json"
    schema.write_text(json.dumps({
        "type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"],
    }))
    rc = flow_cli.main(["--entrypoint", "constant_target.constant",
                        "--repo", str(tmp_path), "--mode", "fuzz", "--allow-egress",
                        "--schema", str(schema), "--variants", "5"])
    cap = capsys.readouterr()
    assert rc == 0, "a stable fuzz pass exits 0"
    assert "stable" in cap.out.lower()


def test_fuzz_json_artifact(tmp_path, capsys):
    rc = flow_cli.main(["--entrypoint", "flow_canaries.scenarios.authenticate",
                        "--repo", _REPO, "--mode", "fuzz", "--allow-egress",
                        "--schema", _schema_file(tmp_path), "--variants", "6", "--json"])
    cap = capsys.readouterr()
    assert rc == 1
    doc = json.loads(cap.out)
    assert doc["mode"] == "fuzz"
    assert doc["egress"] == "full"
    assert any(v["operand"] == "status" for v in doc["varied"])


def test_fuzz_refuses_without_kernel_wall(tmp_path, capsys, monkeypatch):
    import dreplay.flow_fuzz as ff

    monkeypatch.setattr(ff.containment, "detect",
                        lambda: SimpleNamespace(level="python_layer"))
    rc = flow_cli.main(["--entrypoint", "flow_canaries.scenarios.authenticate",
                        "--repo", _REPO, "--mode", "fuzz",
                        "--schema", _schema_file(tmp_path)])
    cap = capsys.readouterr()
    assert rc == 2
    assert "refused" in cap.err
    assert "--allow-egress" in cap.err  # the refusal names the explicit opt-in


def test_instant_run_that_raises_exits_1_and_surfaces(tmp_path, capsys):
    (tmp_path / "boom_target.py").write_text(
        'def boom(x: int) -> dict:\n    raise ValueError("nope")\n')
    rc = flow_cli.main(["--entrypoint", "boom_target.boom", "--repo", str(tmp_path),
                        "--input", '{"x": 1}', "--plain"])
    cap = capsys.readouterr()
    assert rc == 1, "a run that raised must exit 1 (the documented contract)"
    assert "thrown-error" in cap.out
    assert "ValueError" in cap.out
