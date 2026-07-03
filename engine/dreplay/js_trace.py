"""AST-rewrite JS source to inject call/return trace hooks.

Closes the Node adapter's interior gap: JS has no ``sys.settrace``, but we rewrite the
source so each named function/arrow emits an enter event (with its args) and an exit
event (with its return), then reduce those into real interior
:class:`~dreplay.flow.Node`\\s — no synthesis.

Coverage (top-level AND nested):
* ``function NAME(...) {}`` and ``const NAME = function/arrow`` — **sync and async**,
  block + expression bodies.
* non-simple params (rest/default/destructured) on FUNCTIONS via ``arguments``
  (arrows have no ``arguments`` → arrows with non-simple params are skipped).

Rewrite strategy: one function per pass, **reparse each pass** → offsets are always
fresh, so nested functions rewrite correctly without offset bookkeeping.

NOT rewritten (honest endpoints-only fallback): generators (``yield`` needs
``function*``), object/class methods, anonymous functions, and arrows with non-simple
params. If the source doesn't parse, the caller falls back to endpoints-only — never
a faked node.
"""
from __future__ import annotations

try:
    import esprima  # type: ignore[import-not-found]

    _OK = True
except Exception:  # noqa: BLE001
    _OK = False


def available() -> bool:
    return _OK


def _is_async(fn) -> bool:
    # esprima-python exposes async as `isAsync` (the `async` attr is unused/None).
    return bool(getattr(fn, "isAsync", False) or getattr(fn, "async", False))


def _walk(node):
    """Yield every descendant node (recursive over esprima node attributes)."""
    if not hasattr(node, "__dict__"):
        return
    for val in vars(node).values():
        children = val if isinstance(val, list) else [val]
        for item in children:
            if hasattr(item, "type"):
                yield item
                yield from _walk(item)


def _make_target(fn, name: str, source: str):
    """A splice target for a function/arrow node, or None if not rewriteable."""
    if not name or getattr(fn, "generator", False):
        return None
    ntype = getattr(fn, "type", None)
    if ntype not in ("FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"):
        return None
    body = getattr(fn, "body", None)
    brange = getattr(body, "range", None)
    if not brange:
        return None
    # Already-instrumented? (Avoids re-rewriting a function every pass → infinite
    # loop: a rewritten function is still a named declaration.) Our injected marker
    # is the tell.
    if source[brange[0] : brange[1]].lstrip("{ ").startswith("__dt_enter"):
        return None
    params = list(getattr(fn, "params", []) or [])
    simple = all(getattr(p, "type", None) == "Identifier" for p in params)
    if simple:
        mode, params_repr = "named", ", ".join(p.name for p in params)
    elif ntype != "ArrowFunctionExpression" and params and all(getattr(p, "range", None) for p in params):
        # Functions have `arguments`. Replicate the ORIGINAL param pattern
        # (destructure/default/rest) in the IIFE signature, so the body's bindings
        # survive the IIFE boundary — destructure happens INSIDE the IIFE.
        mode = "args"
        params_repr = source[params[0].range[0] : params[-1].range[1]]
    else:
        # arrow + non-simple params: no `arguments`, and the input has no name to
        # pass through → skip (honest endpoints-only).
        return None
    return {
        "name": name,
        "mode": mode,
        "params_repr": params_repr,
        "body_start": brange[0],
        "body_end": brange[1],
        "is_block": getattr(body, "type", None) == "BlockStatement",
        "is_async": _is_async(fn),
        "start": getattr(fn, "range", [0])[0],  # for "find first" ordering
    }


def _find_first_target(tree, source: str):
    """Find the first (by source position) rewriteable named function in the tree.

    Covers function declarations, var-bound function/arrow expressions, and
    object-literal / class METHODS (named after their key)."""
    cands: list[tuple] = []
    for node in _walk(tree):
        nt = getattr(node, "type", None)
        if nt == "VariableDeclarator":
            init = getattr(node, "init", None)
            if init and getattr(init, "type", None) in ("FunctionExpression", "ArrowFunctionExpression"):
                nm = getattr(node.id, "name", None) if getattr(node.id, "type", None) == "Identifier" else None
                if nm:
                    cands.append((init, nm))
        elif nt == "FunctionDeclaration":
            nm = getattr(getattr(node, "id", None), "name", None)
            if nm:
                cands.append((node, nm))
        elif nt in ("Property", "MethodDefinition"):
            val = getattr(node, "value", None)
            if val and getattr(val, "type", None) in ("FunctionExpression", "ArrowFunctionExpression"):
                key = getattr(node, "key", None)
                nm = getattr(key, "name", None) or (
                    getattr(key, "value", None) if getattr(key, "type", None) == "Literal" else None
                )
                if nm:
                    cands.append((val, nm))
    best = None
    for fn, nm in cands:
        t = _make_target(fn, nm, source)
        if t and (best is None or t["start"] < best["start"]):
            best = t
    return best


def _splice_one(source: str, t: dict) -> str:
    name = t["name"]
    pp = t["params_repr"]
    if t["is_block"]:
        inner = source[t["body_start"] + 1 : t["body_end"] - 1]
    else:  # expression-body arrow → turn into a return
        inner = "return " + source[t["body_start"] : t["body_end"]] + ";"
    # The IIFE replicates the param pattern so bindings (incl. destructure/default/
    # rest in 'args' mode) survive the IIFE boundary. Body-splice keeps the signature
    # (incl. async) intact; .call/.apply(this) preserves this.
    iife = ("(async function(" + pp + "){ " + inner + " })"
            if t["is_async"] else "(function(" + pp + "){ " + inner + " })")
    await_kw = "await " if t["is_async"] else ""
    if t["mode"] == "named":
        enter = "[" + pp + "]"
        call = iife + ".call(this" + (", " + pp if pp else "") + ")"
    else:  # args mode: IIFE replicates the original params; pass arguments through
        enter = "Array.prototype.slice.call(arguments)"
        call = iife + ".apply(this, arguments)"
    new_body = (
        "{ __dt_enter(" + repr(name) + ", " + enter + "); "
        "var __r = " + await_kw + call + "; "
        "__dt_exit(" + repr(name) + ", __r); return __r; }"
    )
    return source[: t["body_start"]] + new_body + source[t["body_end"] :]


def rewrite(source: str) -> tuple[str, bool]:
    """Return ``(rewritten_source, ok)``. ``ok=False`` if esprima is unavailable or
    no rewriteable named function exists — caller falls back to endpoints-only."""
    if not _OK:
        return source, False
    out = source
    changed = False
    # One function per pass, reparse each pass: offsets stay fresh → nesting-safe.
    for _ in range(200):  # bound against pathological input
        tree = None
        for parse in (esprima.parseScript, esprima.parseModule):
            try:
                tree = parse(out, {"range": True})
                break
            except Exception:  # noqa: BLE001
                tree = None
        if tree is None:
            break
        target = _find_first_target(tree, out)
        if target is None:
            break
        out = _splice_one(out, target)
        changed = True
    return out, changed
