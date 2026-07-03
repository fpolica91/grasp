"""Node.js FLOW-mode adapter (proof-of-seam, spec §8.8).

The FLOW instrument observes what code does to business objects and emits an
honest :class:`~dreplay.flow.Flow`. This adapter proves the core/adapter seam
extends to JavaScript for FLOW mode: it runs ONE CommonJS function on a JSON
kwargs input and captures the **endpoints** of that execution into a Flow.

HONESTY RULE (docs/what-this-is.md §1, principle #7 — do not fake the plumbing):
JavaScript has no ``sys.settrace`` equivalent wireable here, so this adapter
CANNOT observe interior call/return state the way the Python instrument does.
Therefore:

* the ``input`` node (the kwargs) is **observed**;
* the ``return`` node (the returned value's business fields) is **observed**, or
  an ``other`` node carrying the thrown error is **observed**;
* an ``external_call`` node is **observed** when the JS calls ``fetch``/``http``/
  ``https`` (url + method captured when available);
* NO interior node is synthesized. Endpoints-only is an acceptable proof-of-seam
  *because it is labelled honestly*. A faked interior node would be the one
  unrecoverable failure.

The returned Flow carries an ``interior_unobservable`` note (an ``other`` node,
``business_meaningful=False``, ``provenance="unknown"``) so the human can see
*why* there are no interior nodes — the gap is surfaced, never papered over.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from typing import Any

from .. import js_trace
from ..flow import BusinessObject, Flow, Node, Operand

# The JS worker for FLOW mode: require the module, call the fn with kwargs as a
# single object (the common JS shape), and capture endpoints. A fetch/http hook
# records the outbound call (url/method) WITHOUT throwing — in FLOW mode the
# instrument observes real behavior; the egress wall belongs to the fuzzer/differ
# (Mode B), not the instrument (Mode A). See docs/what-this-is.md "Safety stance".
_FLOW_WORKER_JS = r"""
const path = require('path');
const input = JSON.parse(process.env.DREPLAY_INPUT);
const out = {return_value: null, has_return: false, exception: null,
             outbound_calls: []};
function canon(v){ try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }
                   catch(e){ return String(v); } }
// Observe (do not block) outbound calls — Mode A observes REAL behavior.
const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  let host='', method='GET'; try { const u=new URL(String(url)); host=u.host; } catch(e){ host=String(url); }
  if (opts && opts.method) method = opts.method;
  out.outbound_calls.push({kind:'fetch', host:host, method:method, url:String(url),
                           body:(opts&&opts.body)?canon(opts.body):null});
  if (typeof origFetch === 'function') return origFetch.apply(null, arguments);
};
for (const name of ['http','https']) {
  try {
    const m = require('node:'+name);
    const origReq = m.request;
    m.request = (...a) => {
      const o=a[0]||{}; let host='', method='GET';
      try { host = o.host||o.hostname||(o.headers&&o.headers.host)||'unknown'; } catch(e){ host='unknown'; }
      if (o.method) method = o.method;
      out.outbound_calls.push({kind:name, host:host, method:method, url:(o.protocol||'')+'//'+host+(o.path||''), body:null});
      return origReq.apply(m, a);
    };
  } catch(e){}
}
(async () => {
  try {
    const mod = require(path.resolve(input.module));
    // Resolve the fn across CommonJS shapes: `module.exports = function name()`,
    // `module.exports = {name: fn}`, and ESM-interop `mod.default` (fn or obj).
    let fn = null;
    if (typeof mod === 'function') fn = mod;                       // module.exports = function
    else if (typeof mod === 'object' && mod !== null) {
      fn = mod[input.func] || (mod.default && (typeof mod.default === 'function'
           ? mod.default : mod.default[input.func])) || null;
    }
    if (typeof fn !== 'function') throw new Error('entrypoint not a function: '+input.func);
    let ret = fn.apply(null, input.args);  // positional, in kwarg insertion order
    if (ret && typeof ret.then === 'function') ret = await ret;
    out.return_value = canon(ret); out.has_return = true;
  } catch (e) {
    out.exception = {type:(e&&e.constructor&&e.constructor.name)||'Error',
                     message:String((e&&e.message)||e)};
  }
  process.stdout.write(JSON.stringify(out));
})();
"""


def node_flow(
    *,
    module_path: str,
    func: str,
    kwargs: dict[str, Any] | None = None,
    timeout_s: float = 30.0,
) -> Flow:
    """Run ONE JS function and capture its endpoints as an observed :class:`Flow`.

    Parameters mirror the engine's adapter contract, narrowed for FLOW mode:

    * ``module_path`` — absolute path to a CommonJS module (``module.exports``)
      that exports ``func``.
    * ``func`` — the exported function name to call.
    * ``kwargs`` — values passed to the function as positional arguments in
      insertion order (matching the documented differ-adapter mapping; the
      common JS positional case).
    * ``timeout_s`` — subprocess timeout.

    Returns a :class:`Flow` whose default (business-meaningful) view includes:

    * the ``input`` node (kwargs, observed);
    * the ``return`` node (returned value's business fields, observed) — or an
      ``other`` node carrying a thrown error (observed) when the function throws;
    * an ``external_call`` node (observed) per outbound fetch/http call, when any.

    No interior node is synthesized; an ``other`` note node
    (``business_meaningful=False``, ``provenance="unknown"``) records *why*.
    """
    kwargs = dict(kwargs or {})
    entrypoint = f"{os.path.basename(module_path)}::{func}"

    # Try the AST-traced path FIRST (real interior nodes for top-level sync funcs).
    # Falls back to endpoints-only on any failure (parse/rewrite/worker) — never fakes.
    traced = _node_flow_traced(module_path, func, kwargs, timeout_s)
    if traced is not None:
        return traced

    env = dict(os.environ)
    env["DREPLAY_INPUT"] = json.dumps(
        {"module": module_path, "func": func, "args": list(kwargs.values())}
    )
    env["DREPLAY_WORKER_JS"] = _FLOW_WORKER_JS

    try:
        proc = subprocess.run(
            ["node", "-e", _FLOW_WORKER_JS],
            env=env, capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return _flow_from_error(entrypoint, f"node worker timed out after {timeout_s}s", kwargs)
    except FileNotFoundError:
        return _flow_from_error(entrypoint, "node executable not found on PATH", kwargs)

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        msg = (proc.stdout or proc.stderr or f"exit {proc.returncode}")[:500]
        return _flow_from_error(entrypoint, f"node worker produced no JSON: {msg}", kwargs)

    return _flow_from_observed(entrypoint, kwargs, data)


# --------------------------------------------------------------------------- #
# Traced path — real interior nodes via AST-rewrite (closes the §8.8 gap)
# --------------------------------------------------------------------------- #
_TRACING_HEADER_JS = r"""
const input = JSON.parse(process.env.DREPLAY_INPUT);
var __DT_LOG = [];
function canon(v){ try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch(e){ return String(v); } }
function __dt_enter(n, a){ try { __DT_LOG.push({t:"enter", n:n, args: canon(Array.prototype.slice.call(a || []))}); } catch(e){ __DT_LOG.push({t:"enter", n:n, args: []}); } }
function __dt_exit(n, v){ try { __DT_LOG.push({t:"exit", n:n, v: canon(v)}); } catch(e){ __DT_LOG.push({t:"exit", n:n, v: null}); } }
var __OUT = [];
const __origFetch = global.fetch;
global.fetch = async function(u, o){ let h="", m="GET"; try { h = new URL(String(u)).host; } catch(e){ h = String(u); } if (o && o.method) m = o.method; __OUT.push({kind:"fetch", host:h, method:m, url:String(u), body:(o && o.body) ? canon(o.body) : null}); if (typeof __origFetch === "function") return __origFetch.apply(null, arguments); };
"""

_TRACING_HARNESS_JS = r"""
(async () => {
  try {
    const mod = module.exports;
    let fn = (typeof mod === "function") ? mod : (mod ? mod[input.func] : null);
    if (typeof fn !== "function") throw new Error("entrypoint not a function: " + input.func);
    let r = fn.apply(null, input.args);
    if (r && typeof r.then === "function") r = await r;
    process.stdout.write(JSON.stringify({log: __DT_LOG, outbound: __OUT, result: canon(r), error: null}));
  } catch (e) {
    process.stdout.write(JSON.stringify({log: __DT_LOG, outbound: __OUT, result: null,
      error: {type: (e && e.constructor && e.constructor.name) || "Error",
              message: String((e && e.message) || e)}}));
  }
})();
"""


def _node_flow_traced(module_path: str, func: str, kwargs: dict, timeout_s: float) -> Flow | None:
    """Run the JS entrypoint with AST-injected trace hooks → real interior nodes.
    Returns None to signal 'fall back to endpoints-only' (rewrite unavailable, source
    unparseable, or worker failure). Never raises, never fakes."""
    try:
        source = open(module_path, encoding="utf-8").read()
    except OSError:
        return None
    rewritten, ok = js_trace.rewrite(source)
    if not ok:
        return None

    worker = _TRACING_HEADER_JS + "\n" + rewritten + "\n;\n" + _TRACING_HARNESS_JS
    env = dict(os.environ)
    env["DREPLAY_INPUT"] = json.dumps(
        {"module": module_path, "func": func, "args": list(kwargs.values())}
    )
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
        tf.write(worker)
        tmp_path = tf.name
    try:
        proc = subprocess.run(
            ["node", tmp_path], env=env, capture_output=True, text=True, timeout=timeout_s,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None  # worker failed under rewrite → fall back to clean endpoints-only

    return _flow_from_traced(f"{os.path.basename(module_path)}::{func}", kwargs, data, func)


def _classify_js(name: str) -> str:
    n = name.lower()
    if any(s in n for s in ("auth", "permission", "login", "token", "verify")):
        return "auth_check"
    if any(s in n for s in ("save", "write", "insert", "create", "persist", "post", "store")):
        return "db_write"
    if any(s in n for s in ("fetch", "request", "http", "call", "charge", "send")):
        return "external_call"
    return "transform"


def _extract_js_operands(args_list: list, ret: Any) -> list[Operand]:
    ops: list[Operand] = []
    for container in (args_list, [ret] if ret is not None else []):
        if not isinstance(container, list):
            continue
        for v in container:
            if isinstance(v, dict):
                for fk, fv in v.items():
                    if fk in _BUSINESS_FIELDS:
                        ops.append(Operand(name=str(fk), value=fv, provenance="observed"))
    return ops


def _flow_from_traced(entrypoint: str, kwargs: dict, data: dict, func: str) -> Flow:
    """Reduce the AST-traced enter/exit log into a Flow with REAL interior nodes."""
    nodes: list[Node] = []

    input_ops = tuple(Operand(name=k, value=v, provenance="observed") for k, v in kwargs.items())
    nodes.append(Node(kind="input", label=entrypoint, operands=input_ops, business_meaningful=True))

    # outbound (observed)
    for call in data.get("outbound", []) or []:
        host = call.get("host")
        nodes.append(Node(
            kind="external_call", label=f"{call.get('kind','call')} {call.get('method','')} {host or ''}".strip(),
            operands=tuple(_js_outbound_ops(call)),
            business_meaningful=True,
            open_question=f"JS called out to {host or 'an external host'} — intended?",
        ))

    # interior nodes: match enter/exit by stack discipline; skip the entrypoint frame.
    stack: list[dict] = []
    for ev in data.get("log", []) or []:
        if ev.get("n") == func:  # the entrypoint's own frame is covered by input/return
            continue
        if ev.get("t") == "enter":
            stack.append(ev)
        elif ev.get("t") == "exit" and stack:
            enter = stack.pop()
            name = enter.get("n", "?")
            kind = _classify_js(name)
            ops = _extract_js_operands(enter.get("args", []) or [], ev.get("v"))
            meaningful = bool(ops) or kind in ("db_write", "external_call", "auth_check")
            nodes.append(Node(
                kind=kind, label=name, operands=tuple(ops),
                business_meaningful=meaningful,
                open_question=_js_question(kind, ops),
            ))

    exc = data.get("error")
    if exc:
        nodes.append(Node(
            kind="other", label="thrown-error", provenance="observed",
            operands=(Operand(name="type", value=exc.get("type"), provenance="observed"),
                      Operand(name="message", value=exc.get("message"), provenance="observed")),
            business_meaningful=True,
            open_question=f"JS function threw {exc.get('type')}: {exc.get('message')} — intended?",
        ))
    else:
        nodes.append(Node(kind="return", label=entrypoint, operands=_return_operands(data.get("result")),
                          business_meaningful=True))

    return Flow(entrypoint=entrypoint, mode="instant", nodes=tuple(nodes), containment_level="none")


def _js_outbound_ops(call: dict) -> list[Operand]:
    ops = [Operand(name="host", value=call.get("host"), provenance="observed"),
           Operand(name="method", value=call.get("method"), provenance="observed")]
    if call.get("url"):
        ops.append(Operand(name="url", value=call.get("url"), provenance="observed"))
    return ops


def _js_question(kind: str, ops: list[Operand]) -> str | None:
    if kind == "db_write":
        nulls = [o.name for o in ops if o.value is None]
        if nulls:
            return f"write binds {', '.join(nulls)} = NULL — intended?"
    return None


# --------------------------------------------------------------------------- #
# Reduction — observed endpoints → Flow (no synthesis)
# --------------------------------------------------------------------------- #
# Business-field names shared with the Python instrument so endpoints bind the
# adjudicable quantities a domain expert reads. Kept narrow on purpose.
_BUSINESS_FIELDS = {
    "owner", "name", "status", "amount", "token", "id", "email", "tenant",
    "role", "price", "qty", "quantity", "currency", "user", "user_id", "org",
    "organization", "saved", "paid", "active", "enabled", "plan", "tier", "ok",
    "tag", "type", "kind", "code", "result", "value",
}


def _flow_from_observed(entrypoint: str, kwargs: dict, data: dict) -> Flow:
    nodes: list[Node] = []

    # input node — the kwargs, observed.
    input_ops = tuple(
        Operand(name=k, value=v, provenance="observed") for k, v in kwargs.items()
    )
    nodes.append(Node(kind="input", label=entrypoint, operands=input_ops,
                      business_meaningful=True))

    # external_call nodes — observed outbound fetch/http calls.
    for call in data.get("outbound_calls", []) or []:
        host = call.get("host")
        method = call.get("method")
        ops = [
            Operand(name="host", value=host, provenance="observed"),
            Operand(name="method", value=method, provenance="observed"),
        ]
        if call.get("url"):
            ops.append(Operand(name="url", value=call.get("url"), provenance="observed"))
        if call.get("body") is not None:
            ops.append(Operand(name="body", value=call.get("body"), provenance="observed"))
        nodes.append(Node(
            kind="external_call", label=f"{call.get('kind','call')} {method or ''} {host or ''}".strip(),
            operands=tuple(ops), business_meaningful=True,
            open_question=f"JS called out to {host or 'an external host'} ({method}) — intended?",
        ))

    # return node OR error node — observed endpoints.
    exc = data.get("exception")
    if exc is not None:
        nodes.append(Node(
            kind="other", label="thrown-error", provenance="observed",
            operands=(
                Operand(name="type", value=exc.get("type"), provenance="observed"),
                Operand(name="message", value=exc.get("message"), provenance="observed"),
            ),
            business_meaningful=True,
            open_question=f"JS function threw {exc.get('type')}: {exc.get('message')} — intended?",
        ))
    else:
        ret = data.get("return_value")
        ret_ops = _return_operands(ret)
        nodes.append(Node(kind="return", label=entrypoint, operands=ret_ops,
                          business_meaningful=True))

    # Honest gap note: interior state is unobservable from JS without settrace.
    # Surface it (NOT in the default view) so the gap is named, never papered.
    nodes.append(Node(
        kind="other", label="interior-unobservable", provenance="unknown",
        operands=(Operand(name="interior_calls", value=None, provenance="unknown"),),
        business_meaningful=False,
        open_question=(
            "JavaScript has no sys.settrace equivalent wired here, so interior "
            "call/return nodes were not observed — supply them? (endpoints-only "
            "proof-of-seam, labelled unknown)"
        ),
    ))

    return Flow(entrypoint=entrypoint, mode="instant", nodes=tuple(nodes),
                containment_level="none")


def _return_operands(ret: Any) -> tuple[Operand, ...]:
    """Business fields on the returned value (observed). For a dict/object,
    bind its adjudicable fields; for a scalar, bind the whole value."""
    if isinstance(ret, dict):
        ops = []
        for k, v in ret.items():
            if k in _BUSINESS_FIELDS or not str(k).startswith("_"):
                ops.append(Operand(name=str(k), value=v, provenance="observed"))
        return tuple(ops) if ops else (Operand(name="<return>", value=ret, provenance="observed"),)
    if ret is None:
        return (Operand(name="<return>", value=None, provenance="observed"),)
    return (Operand(name="<return>", value=ret, provenance="observed"),)


def _flow_from_error(entrypoint: str, message: str, kwargs: dict) -> Flow:
    """Worker-level failure (no JS ran, or no JSON came back). Honest: an
    instrumentation-error node, business-meaningful so the human sees it."""
    input_ops = tuple(
        Operand(name=k, value=v, provenance="observed") for k, v in kwargs.items()
    )
    return Flow(
        entrypoint=entrypoint, mode="instant",
        nodes=(
            Node(kind="input", label=entrypoint, operands=input_ops,
                 business_meaningful=True),
            Node(
                kind="other", label="instrumentation-error", provenance="unknown",
                operands=(Operand(name="error", value=message, provenance="unknown"),),
                business_meaningful=True,
                open_question=f"node FLOW adapter could not observe this run: {message} — supply a runnable entrypoint?",
            ),
        ),
        containment_level="none",
    )
