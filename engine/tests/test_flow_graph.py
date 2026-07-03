"""The graph surface contract + its visual grammar (docs/thesis.md §4, the design law).

The engine enforces the moat in types; these pins ensure the graph serializers do
not un-enforce it: provenance survives, the coverage boundary is ghosted (not
omitted), the terminal state is a question, and no verdict word leaks into either
the JSON contract or the HTML render."""
from __future__ import annotations

import json
import os

from dreplay.flow import Flow, Node, Operand, BusinessObject, observe_flow
from dreplay.flow_graph import graph_model, to_graph_json, to_graph_html
from dreplay.types import CanonicalValue, ImplSpec

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_VERDICT_WORDS = ("bug", "risk", "vulnerab", "broken", "wrong", "danger", "insecure")

_CASES = [
    ("create_organization", {"name": "Acme"}),
    ("write_record", {"record": {"token": "x"}, "skip_auth": True}),
    ("run_migration", {}),
    ("authenticate", {"token": "tok"}),
]


def _observe(func, kwargs) -> Flow:
    return observe_flow(spec=ImplSpec(module="flow_canaries.scenarios", func=func),
                        kwargs=kwargs, python_path=[_REPO])


# ---- contract shape --------------------------------------------------------- #
def test_graph_json_is_valid_and_versioned() -> None:
    g = json.loads(to_graph_json(_observe("create_organization", {"name": "Acme"})))
    assert g["grasp_graph_version"] == "1"
    for key in ("entrypoint", "nodes", "edges", "questions", "coverage",
                "transparency", "default_view"):
        assert key in g, f"contract missing {key!r}"
    # edges chain the observed order: N nodes -> N-1 edges.
    assert len(g["edges"]) == max(0, len(g["nodes"]) - 1)
    for e in g["edges"]:
        assert e["relation"] == "observed_order"  # we do not claim data-dependency


def test_every_graph_operand_keeps_valid_provenance() -> None:
    for func, kwargs in _CASES:
        g = graph_model(_observe(func, kwargs))
        for node in g["nodes"]:
            for o in node["operands"]:
                assert o["provenance"] in ("observed", "declared", "unknown"), (
                    f"{func}: operand {o['name']!r} bad provenance {o['provenance']!r}"
                )


# ---- the moat carried into the surface -------------------------------------- #
def test_no_verdict_word_in_graph_json_or_html() -> None:
    for func, kwargs in _CASES:
        flow = _observe(func, kwargs)
        for text in (to_graph_json(flow).lower(), to_graph_html(flow).lower()):
            for bad in _VERDICT_WORDS:
                assert bad not in text, f"{func}: graph leaked verdict word {bad!r}"


def test_unknown_operand_renders_as_blank_never_a_value() -> None:
    # An unknown-provenance operand is a blank the human supplies — the surface must
    # show "you supply", never fabricate a value.
    flow = Flow(
        entrypoint="x.y", mode="instant",
        nodes=(Node(kind="external_call", label="charge()", provenance="observed",
                    operands=(Operand(name="amount", value=None, provenance="unknown"),)),),
    )
    g = graph_model(flow)
    op = g["nodes"][0]["operands"][0]
    assert op["display"] == "you supply"
    assert "you supply" in to_graph_html(flow)


def test_ghosted_node_marks_the_coverage_boundary() -> None:
    # A node the instrument could not see inside (provenance unknown) must be ghosted,
    # never omitted — the eye must see the coverage boundary.
    flow = Flow(
        entrypoint="x.y", mode="instant",
        nodes=(
            Node(kind="controller", label="handler", provenance="observed",
                 business_meaningful=True),
            Node(kind="other", label="interior-unobservable", provenance="unknown"),
        ),
    )
    g = graph_model(flow)
    assert g["nodes"][1]["presence"] == "ghosted"
    assert g["nodes"][0]["presence"] == "observed"
    html_out = to_graph_html(flow)
    assert "ghosted" in html_out and "not observed here" in html_out


def test_terminal_state_is_a_question() -> None:
    flow = Flow(
        entrypoint="x.y", mode="instant",
        nodes=(Node(kind="db_write", label="save", provenance="observed",
                    business_meaningful=True,
                    open_question="owner defaulted to NULL — intended?"),),
    )
    g = graph_model(flow)
    assert g["questions"] == ["owner defaulted to NULL — intended?"]
    html_out = to_graph_html(flow)
    assert "you adjudicate" in html_out
    assert "questions, not findings" in html_out


def test_html_is_self_contained() -> None:
    out = to_graph_html(_observe("create_organization", {"name": "Acme"}))
    assert out.startswith("<!doctype html>")
    # no external network resources — the render must be a standalone artifact.
    assert "http://" not in out and "https://" not in out


def test_business_object_fields_carry_through() -> None:
    flow = Flow(
        entrypoint="x.y", mode="instant",
        nodes=(Node(kind="db_write", label="save", provenance="observed",
                    business_objects=(BusinessObject(
                        name="organization",
                        fields={"owner": CanonicalValue(None)}),)),),
    )
    g = graph_model(flow)
    assert g["nodes"][0]["business_objects"][0]["name"] == "organization"
    # the edge into a node carries the business object name it binds.
