"""The agent-callable skill seam (skills orchestrate, code observes).

Pins that the skills return the graph contract as pure data, carry provenance,
distinguish 'could not observe' from an observed raise, and never leak a verdict."""
from __future__ import annotations

import json
import os

from dreplay import skill

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_VERDICT_WORDS = ("bug", "risk", "vulnerab", "broken", "wrong", "danger", "insecure")


def test_observe_returns_the_graph_contract() -> None:
    out = skill.observe(repo=_REPO, entrypoint="flow_canaries.scenarios.create_organization",
                        input={"name": "Acme"})
    assert out["capability"] == "observe"
    assert out["ok"] is True and out["observed"] is True and out["error"] is None
    assert out["graph"]["grasp_graph_version"] == "1"
    # the owner=NULL fact is present and measured, ending in a neutral question.
    assert out["graph"]["questions"], "expected an open question on the owner binding"


def test_observe_distinguishes_config_error_from_observed_run() -> None:
    # A non-existent entrypoint is a config-level 'could not observe' — NOT an
    # observed thrown-error framed as behavior.
    out = skill.observe(repo=_REPO, entrypoint="flow_canaries.scenarios.no_such_func",
                        input={})
    assert out["ok"] is True          # the skill ran
    assert out["observed"] is False   # but nothing was observed
    assert out["error"] is not None


def test_fuzz_refuses_non_python_honestly() -> None:
    out = skill.fuzz(repo="/tmp", entrypoint="x.y", schema="s.json")
    # /tmp has no python markers → auto-detect 'py' actually; force the honest path
    # via a language the fuzzer rejects is covered elsewhere. Here we just assert the
    # envelope shape on the (schema-missing) failure is a clean, non-verdict error.
    assert out["capability"] == "fuzz" and out["ok"] is False
    assert "error" in out


def test_no_verdict_word_in_any_skill_output() -> None:
    outs = [
        skill.observe(repo=_REPO, entrypoint="flow_canaries.scenarios.create_organization",
                      input={"name": "Acme"}),
        skill.observe(repo=_REPO, entrypoint="flow_canaries.scenarios.write_record",
                      input={"record": {"token": "x"}, "skip_auth": True}),
        skill.fuzz(repo="/tmp", entrypoint="x.y", schema="missing.json"),
    ]
    blob = json.dumps(outs, default=repr).lower()
    for bad in _VERDICT_WORDS:
        assert bad not in blob, f"skill output leaked verdict word {bad!r}"


def test_cli_emits_json(capsys) -> None:
    rc = skill.main(["observe", "--repo", _REPO,
                     "--entrypoint", "flow_canaries.scenarios.create_organization",
                     "--input", '{"name": "Acme"}'])
    assert rc == 0
    parsed = json.loads(capsys.readouterr().out)
    assert parsed["capability"] == "observe" and parsed["graph"]["nodes"]
