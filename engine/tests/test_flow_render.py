"""flow_render + flow_cli (Mode A) tests."""
from __future__ import annotations

import io
import json
import os
from contextlib import redirect_stdout, redirect_stderr

from dreplay.flow import BusinessObject, Flow, Node, Operand
from dreplay.flow_render import render_flow, to_json
from dreplay.flow_cli import main as flow_main

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _sample_flow() -> Flow:
    return Flow(
        entrypoint="app.create_org",
        mode="instant",
        nodes=(
            Node(kind="input", label="create_org",
                 operands=(Operand(name="name", value="x", provenance="observed"),),
                 business_meaningful=True),
            Node(kind="transform", label="_normalize", operands=(), business_meaningful=False),
            Node(kind="db_write", label="_save",
                 operands=(Operand(name="owner", value=None, provenance="observed"),),
                 business_meaningful=True,
                 open_question="write binds owner = NULL — intended?"),
            Node(kind="return", label="create_org",
                 operands=(Operand(name="owner", value=None, provenance="observed"),),
                 business_meaningful=True),
        ),
        containment_level="none",
    )


def test_render_collapses_plumbing_by_default() -> None:
    out = render_flow(_sample_flow())
    assert "_save" in out and "owner=None" in out
    assert "_normalize" not in out, "plumbing must be collapsed in the default view"
    assert "⋯" in out, "collapsed plumbing must be summarized as a count line"
    assert "intended?" in out


def test_render_expand_all_shows_plumbing() -> None:
    out = render_flow(_sample_flow(), expand_all=True)
    assert "_normalize" in out, "expand-all must reveal collapsed plumbing"


def test_to_json_artifact_roundtrips() -> None:
    data = json.loads(to_json(_sample_flow()))
    assert data["entrypoint"] == "app.create_org"
    assert "_save" in data["default_view"]
    assert "_normalize" not in data["default_view"]


def test_flow_cli_mode_a_runs_and_surfaces_owner_null(capsys) -> None:
    rc = flow_main([
        "--entrypoint", "flow_canaries.scenarios.create_organization",
        "--input", '{"name": "test"}',
        "--repo", _REPO,
    ])
    out = capsys.readouterr()
    assert rc == 0
    assert "owner=None" in out.out, "Mode A must surface the observed owner=NULL"
    assert "intended?" in out.out


def test_flow_cli_json_artifact(capsys) -> None:
    rc = flow_main([
        "--entrypoint", "flow_canaries.scenarios.run_migration",
        "--repo", _REPO, "--json",
    ])
    out = capsys.readouterr()
    assert rc == 0
    data = json.loads(out.out)
    assert data["mode"] == "instant"


def test_flow_cli_usage_error_on_missing_entrypoint() -> None:
    assert flow_main([]) == 2
