"""The dataflow graph — grasp's primary surface (the post-editor's center pane).

This is the organ→surface seam. :func:`to_graph_json` is the data contract every
front-end (the Electron webview, a skill consumer, an MR attachment) renders from;
:func:`to_graph_html` is a self-contained reference render of that contract.

It carries the moat into the visual layer. The engine enforces principle #1/#2 in
types; the graph must not un-enforce them in pixels — **a beautiful UI is a more
convincing liar** (docs/thesis.md §4, the design law). So the contract makes the
honesty machine-visible:

* every operand keeps its ``provenance`` — ``observed`` / ``declared`` / ``unknown``
  (``unknown`` = *you supply*, a blank, never a fact);
* a node the instrument could NOT see inside (provenance ``unknown``: an
  interior-unobservable note, an endpoints-only gap) is marked ``presence:"ghosted"``
  so the surface can render the **coverage boundary**, never omit it;
* the flow terminates in ``questions`` — neutral, ending in "— intended?" — which the
  surface renders as its terminal state. There is no verdict field, by construction.

Edges are ``observed_order`` (the temporal sequence the instrument recorded), NOT a
claimed data-dependency graph — we surface what we saw, we don't infer a dependency
we didn't trace.
"""
from __future__ import annotations

import html
import json

from .flow import Flow, Node, Operand
from .flow_diff import FlowDiff

GRAPH_VERSION = "1"
GRAPH_DIFF_VERSION = "1"
_QUESTION_SUFFIX = " — intended?"

# Terminal node kinds — the flow's end state (a return or an observed raise).
_TERMINAL_KINDS = ("return", "thrown-error")

_VALUE_CAP = 140


def _display_value(o: Operand) -> str:
    """Human-facing string for an operand value. ``unknown`` provenance has no
    observed value — it is a blank the human supplies, never rendered as a fact."""
    if o.provenance == "unknown":
        return "you supply"
    try:
        s = repr(o.value)
    except Exception:  # a value engine already canonicalized; be defensive anyway
        s = "<unreprable>"
    if len(s) > _VALUE_CAP:
        s = s[:_VALUE_CAP] + "…"
    return s


def _presence(n: Node) -> str:
    """``observed`` (the instrument saw this happen) vs ``ghosted`` (a gap the
    instrument honestly could not see inside — provenance ``unknown``)."""
    return "ghosted" if n.provenance == "unknown" else "observed"


def _operand_dict(o: Operand) -> dict:
    return {
        "name": o.name,
        "value": o.value,
        "display": _display_value(o),
        "provenance": o.provenance,
        "derived_from": o.derived_from,
    }


def graph_model(flow: Flow) -> dict:
    """The graph data contract (a plain dict — :func:`to_graph_json` serializes it).

    Shared by the JSON contract and the HTML render so they can never disagree
    about what was observed."""
    nodes: list[dict] = []
    edges: list[dict] = []
    n = len(flow.nodes)
    for i, node in enumerate(flow.nodes):
        node_id = f"n{i}"
        carries = node.business_objects[0].name if node.business_objects else None
        nodes.append({
            "id": node_id,
            "kind": node.kind,
            "label": node.label,
            "business_meaningful": node.business_meaningful,
            "presence": _presence(node),
            "terminal": node.kind in _TERMINAL_KINDS or i == n - 1,
            "operands": [_operand_dict(o) for o in node.operands],
            "business_objects": [
                {"name": bo.name, "fields": {k: v.shape for k, v in bo.fields.items()}}
                for bo in node.business_objects
            ],
            "question": node.open_question,
            "evidence": node.raw_detail,  # observed stdout/stderr, display-only
        })
        if i > 0:
            edges.append({"from": f"n{i-1}", "to": node_id,
                          "relation": "observed_order", "carries": carries})

    # Deduped terminal questions — the surface's end state. Never a verdict.
    questions: list[str] = []
    seen: set[str] = set()
    for node in flow.nodes:
        if node.open_question and node.open_question not in seen:
            seen.add(node.open_question)
            questions.append(node.open_question)

    return {
        "grasp_graph_version": GRAPH_VERSION,
        "entrypoint": flow.entrypoint,
        "mode": flow.mode,
        "transparency": {
            "classifier_mode": flow.classifier_mode,
            "vocab_size": flow.vocab_size,
            "fallback_reason": flow.fallback_reason,
            "containment_level": flow.containment_level,
        },
        "coverage": {
            "kind": "single-input" if flow.mode == "instant" else flow.mode,
            "inputs_observed": 1,
            "note": (
                "observed for ONE input; paths not exercised are ghosted, not judged"
            ),
        },
        "default_view": [f"n{i}" for i, node in enumerate(flow.nodes)
                         if node.business_meaningful],
        "nodes": nodes,
        "edges": edges,
        "questions": questions,
    }


def to_graph_json(flow: Flow) -> str:
    """The organ→surface data contract, as JSON. What every front-end renders from."""
    return json.dumps(graph_model(flow), indent=2, sort_keys=True)


# --------------------------------------------------------------------------- #
# Reference render — a self-contained HTML instrument readout of the contract.
# The design law lives here: the provenance grammar is rendered in FORM (chip
# style), the coverage boundary is ghosted (never omitted), the terminal state is
# a question. No green/red, no ✓/⚠, no verdict — by construction.
# --------------------------------------------------------------------------- #
_CSS = """
:root{
  --ground:#f4f5f7; --surface:#ffffff; --surface-2:#fbfbfd;
  --ink:#1a1d24; --muted:#606a7b; --hair:#dce0e6;
  --observed:#2563d9; --observed-bg:#eaf0fe;
  --declared:#6b7688; --declared-bg:#eef0f3;
  --unknown:#8a93a3; --question:#9a6410; --question-bg:#fbf1dd; --question-hair:#e6c68a;
  --ghost:#9aa4b2;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#0f1216; --surface:#171b21; --surface-2:#131217;
  --ink:#e6e9ee; --muted:#8b95a5; --hair:#262c34;
  --observed:#5b9bff; --observed-bg:#132139;
  --declared:#8b95a5; --declared-bg:#1b2028;
  --unknown:#7c8494; --question:#e0a852; --question-bg:#241b0e; --question-hair:#4a3a1c;
  --ghost:#5b6472;
}}
:root[data-theme="light"]{
  --ground:#f4f5f7; --surface:#ffffff; --surface-2:#fbfbfd;
  --ink:#1a1d24; --muted:#606a7b; --hair:#dce0e6;
  --observed:#2563d9; --observed-bg:#eaf0fe;
  --declared:#6b7688; --declared-bg:#eef0f3;
  --unknown:#8a93a3; --question:#9a6410; --question-bg:#fbf1dd; --question-hair:#e6c68a;
  --ghost:#9aa4b2;
}
:root[data-theme="dark"]{
  --ground:#0f1216; --surface:#171b21; --surface-2:#131217;
  --ink:#e6e9ee; --muted:#8b95a5; --hair:#262c34;
  --observed:#5b9bff; --observed-bg:#132139;
  --declared:#8b95a5; --declared-bg:#1b2028;
  --unknown:#7c8494; --question:#e0a852; --question-bg:#241b0e; --question-hair:#4a3a1c;
  --ghost:#5b6472;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
  line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:40px 24px 72px}
.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);
  font-weight:600}
h1{font-family:var(--mono);font-size:19px;font-weight:600;margin:6px 0 2px;
  word-break:break-all;text-wrap:balance}
.readout{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:14px;font-size:12.5px;
  color:var(--muted)}
.readout b{color:var(--ink);font-family:var(--mono);font-weight:500;
  font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:8px 14px;margin:22px 0 8px;padding:12px 14px;
  background:var(--surface-2);border:1px solid var(--hair);border-radius:9px;font-size:12px}
.legend .li{display:flex;align-items:center;gap:7px;color:var(--muted)}
.swatch{width:12px;height:12px;border-radius:3px;flex:none}
.swatch.observed{background:var(--observed-bg);border:1.5px solid var(--observed)}
.swatch.declared{background:var(--declared-bg);border:1.5px solid var(--declared)}
.swatch.unknown{background:transparent;border:1.5px dashed var(--unknown)}
.swatch.ghost{background:transparent;border:1.5px dashed var(--ghost);opacity:.8}

.spine{position:relative;margin-top:20px;padding-left:30px}
.spine::before{content:"";position:absolute;left:9px;top:6px;bottom:26px;width:2px;
  background:linear-gradient(var(--hair),var(--hair));border-radius:2px}
.node{position:relative;margin:0 0 14px}
.node::before{content:"";position:absolute;left:-25px;top:20px;width:11px;height:11px;
  border-radius:50%;background:var(--surface);border:2px solid var(--observed)}
.node.ghosted::before{border-color:var(--ghost);border-style:dashed}
.node.plumbing::before{width:7px;height:7px;left:-23px;top:14px;border-color:var(--muted);
  background:var(--muted)}
.card{background:var(--surface);border:1px solid var(--hair);border-radius:11px;
  padding:13px 15px;box-shadow:0 1px 2px rgba(20,25,40,.04)}
.node.business .card{border-color:color-mix(in srgb,var(--observed) 34%,var(--hair))}
.node.ghosted .card{border-style:dashed;border-color:var(--ghost);background:transparent}
.chead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.kind{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;
  color:var(--muted);padding:2px 7px;border:1px solid var(--hair);border-radius:5px;
  flex:none}
.node.business .kind{color:var(--observed);border-color:color-mix(in srgb,var(--observed) 40%,var(--hair))}
.lbl{font-family:var(--mono);font-size:13.5px;font-weight:500;word-break:break-word}
.gtag{margin-left:auto;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--ghost);border:1px dashed var(--ghost);border-radius:20px;padding:1px 9px}
.ops{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
.op{display:inline-flex;align-items:center;gap:0;font-family:var(--mono);font-size:12px;
  border-radius:6px;overflow:hidden;border:1px solid var(--hair);
  font-variant-numeric:tabular-nums}
.op .k{padding:3px 7px;color:var(--muted);background:var(--surface-2)}
.op .v{padding:3px 8px;font-weight:500}
.op.observed{border-color:var(--observed)}
.op.observed .v{color:var(--observed);background:var(--observed-bg)}
.op.declared{border-color:var(--declared)}
.op.declared .v{color:var(--declared);background:var(--declared-bg)}
.op.unknown{border-style:dashed;border-color:var(--unknown)}
.op.unknown .v{color:var(--unknown);font-style:italic}
.qflag{margin-top:10px;font-size:12.5px;color:var(--question)}
.evi{margin-top:10px}
.evi summary{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
  cursor:pointer}
.evi pre{margin:8px 0 0;padding:9px 11px;background:var(--surface-2);border:1px solid var(--hair);
  border-radius:7px;font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;
  overflow-x:auto;max-height:20em}

.qpanel{margin-top:26px;background:var(--question-bg);border:1px solid var(--question-hair);
  border-radius:12px;padding:16px 18px}
.qpanel .eyebrow{color:var(--question)}
.qpanel h2{margin:5px 0 0;font-size:15px;font-weight:600}
.qlist{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:9px}
.qlist li{display:flex;gap:10px;font-size:14px}
.qlist .mark{color:var(--question);font-weight:700;flex:none}
.qlist .mark::before{content:"?"}
.empty{margin-top:12px;color:var(--muted);font-size:13.5px}
.foot{margin-top:34px;padding-top:16px;border-top:1px solid var(--hair);font-size:12px;
  color:var(--muted);line-height:1.65}
@media (prefers-reduced-motion:no-preference){.node{animation:rise .4s ease both}
  @keyframes rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}}
"""


def _op_html(o: dict) -> str:
    prov = o["provenance"]
    return (f"<span class='op {html.escape(prov)}' title='{html.escape(prov)}'>"
            f"<span class='k'>{html.escape(str(o['name']))}</span>"
            f"<span class='v'>{html.escape(o['display'])}</span></span>")


def _node_html(node: dict) -> str:
    classes = ["node"]
    classes.append("business" if node["business_meaningful"] else "plumbing")
    if node["presence"] == "ghosted":
        classes.append("ghosted")
    gtag = ("<span class='gtag'>not observed here</span>"
            if node["presence"] == "ghosted" else "")
    ops = ("<div class='ops'>" + "".join(_op_html(o) for o in node["operands"]) + "</div>"
           if node["operands"] else "")
    qflag = (f"<div class='qflag'>? {html.escape(node['question'])}</div>"
             if node["question"] else "")
    evi = ""
    if node["evidence"]:
        evi = ("<details class='evi'><summary>observed output</summary>"
               f"<pre>{html.escape(node['evidence'])}</pre></details>")
    return (
        f"<div class='{' '.join(classes)}'><div class='card'><div class='chead'>"
        f"<span class='kind'>{html.escape(node['kind'])}</span>"
        f"<span class='lbl'>{html.escape(node['label'])}</span>{gtag}</div>"
        f"{ops}{qflag}{evi}</div></div>"
    )


def to_graph_html(flow: Flow) -> str:
    """Self-contained reference render of the graph contract — an instrument readout.

    Provenance is rendered in form (chip style), the coverage boundary is ghosted
    (never omitted), and the terminal state is a question. No verdict, by construction."""
    g = graph_model(flow)
    t = g["transparency"]
    classifier = (
        f"vocab · {t['vocab_size']} fields" if t["classifier_mode"] == "vocab"
        else f"non-vocab · {html.escape(t['fallback_reason'] or 'no models found')}"
    )
    legend = (
        "<div class='legend'>"
        "<span class='li'><span class='swatch observed'></span>observed — measured this run</span>"
        "<span class='li'><span class='swatch declared'></span>declared — read from source</span>"
        "<span class='li'><span class='swatch unknown'></span>you supply — a blank, not a fact</span>"
        "<span class='li'><span class='swatch ghost'></span>not observed — coverage boundary</span>"
        "</div>"
    )
    body = "".join(_node_html(n) for n in g["nodes"])
    if g["questions"]:
        qitems = "".join(f"<li><span class='mark'></span><span>{html.escape(q)}</span></li>"
                         for q in g["questions"])
        qpanel = (
            "<div class='qpanel'><div class='eyebrow'>you adjudicate</div>"
            "<h2>These are questions, not findings.</h2>"
            f"<ul class='qlist'>{qitems}</ul></div>"
        )
    else:
        qpanel = ("<div class='qpanel'><div class='eyebrow'>you adjudicate</div>"
                  "<p class='empty'>No open question surfaced for this input. "
                  "That is not a pass — it is one observed path.</p></div>")
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>observed dataflow · {html.escape(g['entrypoint'])}</title>"
        f"<style>{_CSS}</style></head><body><div class='wrap'>"
        "<div class='eyebrow'>observed dataflow</div>"
        f"<h1>{html.escape(g['entrypoint'])}</h1>"
        "<div class='readout'>"
        f"<span>mode <b>{html.escape(g['mode'])}</b></span>"
        f"<span>classifier <b>{classifier}</b></span>"
        f"<span>containment <b>{html.escape(t['containment_level'])}</b></span>"
        f"<span>coverage <b>{g['coverage']['inputs_observed']} input</b></span>"
        "</div>"
        f"{legend}"
        f"<div class='spine'>{body}</div>"
        f"{qpanel}"
        "<div class='foot'>Every value above is measured from one real execution or "
        "labelled <i>you supply</i> — nothing is inferred. Unexercised paths are ghosted, "
        "not judged. grasp surfaces what the code did; whether it is intended is yours to say."
        "</div></div></body></html>"
    )


# =========================================================================== #
# The A→B change view — the post-editor's headline. Overlay one graph, mark what
# changed between OLD and NEW behavior, and end in "…changed A→B — expected?".
#
# The honesty grammar holds under a diff too: status is a FACT (added/removed/
# changed), never a verdict. Color is TEMPORAL (before = muted, after = signal),
# NOT evaluative — there is no green=good / red=bad. The terminal state stays a
# question.
# =========================================================================== #
def _display_raw(v) -> str:
    try:
        s = repr(v)
    except Exception:
        s = "<unreprable>"
    return s if len(s) <= _VALUE_CAP else s[:_VALUE_CAP] + "…"


def graph_diff_model(fd: FlowDiff) -> dict:
    """The A→B graph-diff data contract (a plain dict). Every changed node carries
    its old→new operand deltas; the flow terminates in neutral change questions."""
    nodes: list[dict] = []
    questions: list[str] = []
    for k, nd in enumerate(fd.node_diffs):
        node = nd.new_node or nd.old_node
        nodes.append({
            "id": f"d{k}",
            "status": nd.status,  # unchanged | changed | added | removed | moved
            "kind": node.kind if node else "?",
            "label": node.label if node else "?",
            "presence": "ghosted" if nd.status == "removed" else "observed",
            "operands": [_operand_dict(o) for o in (node.operands if node else ())],
            "deltas": [
                {"field": d.field, "old": _display_raw(d.old_value),
                 "new": _display_raw(d.new_value), "provenance": d.provenance}
                for d in nd.operand_deltas
            ],
        })
        if nd.status == "changed":
            for d in nd.operand_deltas:
                questions.append(
                    f"{d.field}: {_display_raw(d.old_value)} → {_display_raw(d.new_value)}"
                    f"{_QUESTION_SUFFIX}")
        elif nd.status == "added":
            questions.append(f"new step '{node.label}' now runs{_QUESTION_SUFFIX}")
        elif nd.status == "removed":
            questions.append(f"step '{nd.old_node.label}' no longer runs{_QUESTION_SUFFIX}")
        elif nd.status == "moved":
            questions.append(f"position of '{node.label}' changed{_QUESTION_SUFFIX}")
        if node is not None and node.open_question and node.open_question not in questions:
            questions.append(node.open_question)

    seen: set[str] = set()
    deduped = [q for q in questions if not (q in seen or seen.add(q))]
    return {
        "grasp_graph_diff_version": GRAPH_DIFF_VERSION,
        "entrypoint": fd.entrypoint,
        "old_ref": fd.old_ref,
        "new_ref": fd.new_ref,
        "transparency": {"classifier_mode": fd.classifier_mode, "vocab_size": fd.vocab_size},
        "changed_count": sum(1 for nd in fd.node_diffs if nd.status != "unchanged"),
        "empty": fd.is_empty(),
        "honest_message": fd.honest_message() if fd.is_empty() else None,
        "nodes": nodes,
        "questions": deduped,
    }


def to_graph_diff_json(fd: FlowDiff) -> str:
    """The A→B graph-diff contract, as JSON."""
    return json.dumps(graph_diff_model(fd), indent=2, sort_keys=True)


_DIFF_CSS = """
.node.added::before{border-color:var(--observed);background:var(--observed)}
.node.added .card{border-color:color-mix(in srgb,var(--observed) 45%,var(--hair))}
.node.removed::before{border-style:dashed;background:transparent}
.node.removed .card{border-style:dashed;opacity:.72}
.node.removed .lbl{text-decoration:line-through;text-decoration-color:var(--ghost)}
.stag{margin-left:auto;font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  padding:1px 8px;border-radius:20px;flex:none}
.stag.added{color:var(--observed);border:1px solid var(--observed)}
.stag.removed{color:var(--ghost);border:1px dashed var(--ghost)}
.stag.changed{color:var(--question);border:1px solid var(--question-hair)}
.stag.unchanged{color:var(--muted);border:1px solid var(--hair)}
.deltas{display:flex;flex-direction:column;gap:6px;margin-top:11px}
.delta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:var(--mono);
  font-size:12px;font-variant-numeric:tabular-nums}
.delta .dk{color:var(--muted);min-width:0}
.delta .old{color:var(--declared);background:var(--declared-bg);padding:2px 7px;
  border-radius:5px;text-decoration:line-through;text-decoration-color:var(--ghost)}
.delta .arrow{color:var(--muted)}
.delta .new{color:var(--observed);background:var(--observed-bg);padding:2px 7px;border-radius:5px;
  font-weight:500}
.delta .prov{color:var(--muted);font-size:10.5px}
.node.unchanged .card{opacity:.6}
"""


def _delta_html(d: dict) -> str:
    return (f"<div class='delta'><span class='dk'>{html.escape(str(d['field']))}</span>"
            f"<span class='old'>{html.escape(d['old'])}</span>"
            f"<span class='arrow'>→</span>"
            f"<span class='new'>{html.escape(d['new'])}</span>"
            f"<span class='prov'>[{html.escape(d['provenance'])}]</span></div>")


def _diff_node_html(node: dict) -> str:
    status = node["status"]
    classes = ["node", status]
    if node["presence"] == "ghosted":
        classes.append("ghosted")
    stag = f"<span class='stag {status}'>{status}</span>"
    if node["deltas"]:
        inner = "<div class='deltas'>" + "".join(_delta_html(d) for d in node["deltas"]) + "</div>"
    elif node["operands"]:
        inner = "<div class='ops'>" + "".join(_op_html(o) for o in node["operands"]) + "</div>"
    else:
        inner = ""
    return (
        f"<div class='{' '.join(classes)}'><div class='card'><div class='chead'>"
        f"<span class='kind'>{html.escape(node['kind'])}</span>"
        f"<span class='lbl'>{html.escape(node['label'])}</span>{stag}</div>"
        f"{inner}</div></div>"
    )


def to_graph_diff_html(fd: FlowDiff) -> str:
    """Self-contained render of the A→B change view — one overlaid graph, changed
    nodes showing old→new deltas, terminating in the neutral change question.
    Color is before/after (temporal), never good/bad. No verdict, by construction."""
    g = graph_diff_model(fd)
    t = g["transparency"]
    classifier = (f"vocab · {t['vocab_size']} fields" if t["classifier_mode"] == "vocab"
                  else "non-vocab")
    legend = (
        "<div class='legend'>"
        "<span class='li'><span class='swatch observed'></span>after — new behavior</span>"
        "<span class='li'><span class='swatch declared'></span>before — old behavior</span>"
        "<span class='li'><span class='swatch ghost'></span>removed — no longer runs</span>"
        "</div>"
    )
    body = "".join(_diff_node_html(n) for n in g["nodes"])
    if g["empty"]:
        qpanel = ("<div class='qpanel'><div class='eyebrow'>you adjudicate</div>"
                  "<p class='empty'>" + html.escape(g["honest_message"] or "") + "</p></div>")
    else:
        qitems = "".join(f"<li><span class='mark'></span><span>{html.escape(q)}</span></li>"
                         for q in g["questions"])
        qpanel = (
            "<div class='qpanel'><div class='eyebrow'>you adjudicate</div>"
            "<h2>The dataflow changed. Is this what you expected?</h2>"
            f"<ul class='qlist'>{qitems}</ul></div>"
        )
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>dataflow change · {html.escape(g['entrypoint'])}</title>"
        f"<style>{_CSS}{_DIFF_CSS}</style></head><body><div class='wrap'>"
        "<div class='eyebrow'>dataflow change</div>"
        f"<h1>{html.escape(g['entrypoint'])}</h1>"
        "<div class='readout'>"
        f"<span>old <b>{html.escape(str(g['old_ref']))}</b></span>"
        f"<span>new <b>{html.escape(str(g['new_ref']))}</b></span>"
        f"<span>classifier <b>{classifier}</b></span>"
        f"<span>changes <b>{g['changed_count']}</b></span>"
        "</div>"
        f"{legend}"
        f"<div class='spine'>{body}</div>"
        f"{qpanel}"
        "<div class='foot'>Old and new were each run for real under the same input; the "
        "deltas above are measured, not inferred. A change surfaced here is for you to "
        "read — grasp does not label it correct or incorrect. That is yours to say."
        "</div></div></body></html>"
    )
