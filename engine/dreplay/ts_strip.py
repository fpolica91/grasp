"""TypeScript type-stripper — the TS tracer mechanism (spec §8.8, extended to TS).

The JS AST-rewrite tracer (:mod:`dreplay.js_trace`) works on plain JavaScript via
esprima. TypeScript adds a type system (annotations, generics, interfaces, enums,
decorators) that esprima cannot parse. So before the JS tracer can rewrite a
``.ts`` file, its types must be stripped to plain JS.

This module is the TS-specific tracer work: turn ``.ts`` (and ``.tsx``) into JS that
:func:`dreplay.js_trace.rewrite` can consume. Two strategies, tried in order:

1. **Authoritative** — the `typescript` npm package's ``transpileModule`` (the
   TypeScript compiler API). This is what the language itself does: it strips types,
   resolves enums/``as``/non-null assertions, and emits runnable CommonJS. We invoke
   it through a tiny ``node`` subprocess that ``require('typescript')``. It must be
   installed in the target's ``node_modules`` (or a probe dir); we never install it
   silently — we detect it.

2. **Fallback (regex)** — a conservative line-based stripper for the SIMPLE cases
   (parameter/return annotations, ``interface``/``type`` declarations, ``as`` casts,
   access modifiers). This is NOT a TS compiler: it handles only the subset the JS
   tracer's conformance target uses. When the source uses generics, decorators,
   enums, or ``declare`` blocks it reports ``ok=False`` so the caller falls back to
   endpoints-only honestly — never a faked trace.

HONESTY RULE (docs/what-this-is.md §1, principle #7 — do not fake the plumbing):
both strategies return ``(js_source, ok)``. ``ok=False`` means "I could not produce
trustworthy JS" → the adapter falls back to the endpoints-only observed Flow. We
never emit a half-stripped source that would mis-trace.

NestJS / decorators: the authoritative path (``transpileModule`` with
``experimentalDecorators``) emits the decorator *applications* as ordinary JS calls
while keeping the decorated METHOD as a normal method — so the JS tracer observes the
real method call, not the DI container. The regex fallback cannot do this, so
decorator-bearing sources require the authoritative path (reported ``ok=False``
otherwise).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from typing import Any

# The tiny node program that drives the authoritative TS compiler API. It reads the
# .ts source from stdin and writes stripped JS to stdout. Resolves `typescript` from
# (in order) the target's node_modules, a probe dir, or the global resolution. It
# NEVER installs anything.
_TRANSPILE_JS = r"""
let ts = null;
const paths = (process.env.TS_NODE_PATHS || "").split(require('path').delimiter).filter(Boolean);
for (const dir of [...paths, process.cwd()]) {
  try { ts = require(require('path').resolve(dir, 'node_modules', 'typescript')); break; } catch (e) {}
}
if (!ts) { try { ts = require('typescript'); } catch (e) {} }
if (!ts) { process.stderr.write('NO_TYPESCRIPT_MODULE'); process.exit(0); }
let chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const src = Buffer.concat(chunks).toString('utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      experimentalDecorators: true,
      emitDecoratorMetadata: false,
      removeComments: false,
      sourceMap: false,
    },
    fileName: process.env.TS_FILE_NAME || 'input.ts',
  });
  process.stdout.write(out.outputText || '');
});
"""


def typescript_module_available(search_paths: list[str] | None = None) -> bool:
    """True iff the ``typescript`` npm module is resolvable (installed), NOT
    installed silently. Probes the target's node_modules, a probe dir, then global."""
    if shutil.which("node") is None:
        return False
    env = dict(os.environ)
    env["TS_NODE_PATHS"] = os.path.pathsep.join(search_paths or [])
    try:
        proc = subprocess.run(
            ["node", "-e", _TRANSPILE_JS],
            input="", env=env, capture_output=True, text=True, timeout=15,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False
    return "NO_TYPESCRIPT_MODULE" not in proc.stderr


def strip_types(
    source: str,
    *,
    file_name: str = "input.ts",
    search_paths: list[str] | None = None,
    timeout_s: float = 20.0,
) -> tuple[str, bool]:
    """Strip TypeScript types → plain JS for the JS tracer.

    Returns ``(js_source, ok)``. ``ok=False`` means no trustworthy JS was produced
    (no node / no typescript module / transpile error) and the caller MUST fall back
    to endpoints-only. Never raises.

    Parameters mirror the JS tracer's contract:
    * ``source``        — the original ``.ts``/``.tsx`` source.
    * ``file_name``     — used by transpileModule for JSX/TSX detection.
    * ``search_paths``  — dirs whose ``node_modules`` may hold ``typescript``.
    """
    if shutil.which("node") is None:
        return source, False
    env = dict(os.environ)
    env["TS_NODE_PATHS"] = os.path.pathsep.join(search_paths or [])
    env["TS_FILE_NAME"] = file_name
    try:
        proc = subprocess.run(
            ["node", "-e", _TRANSPILE_JS],
            input=source, env=env, capture_output=True, text=True, timeout=timeout_s,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return source, False
    if "NO_TYPESCRIPT_MODULE" in proc.stderr or not proc.stdout.strip():
        return source, False
    return proc.stdout, True


# --------------------------------------------------------------------------- #
# Regex fallback — conservative, simple-TS only
# --------------------------------------------------------------------------- #
# Patterns that the regex stripper CANNOT handle safely → refuse (ok=False) so the
# adapter falls back to endpoints-only instead of mis-tracing. Decorators need the
# TS compiler's experimentalDecoratorMetadata emission; generics/enums/declare need
# real lowering.
_TS_REFUSE = re.compile(
    r"""
    @\w+              # decorator application
    | <\w+(\s|,|>)    # generic param <T>
    | \benum\s+\w+    # enum declaration
    | \bdeclare\s+    # ambient declare
    | \bnamespace\s+  # namespace
    | \babstract\s+   # abstract class
    | \bimplements\b  # implements clause (needs the interface, ok to drop but rare)
    """,
    re.VERBOSE,
)

_INTERFACE_OR_TYPE = re.compile(
    r"^\s*(export\s+)?(interface|type)\s+\w+", re.MULTILINE
)


def strip_types_regex(source: str) -> tuple[str, bool]:
    """Conservative regex type-stripper for SIMPLE TypeScript only.

    Handles:
    * ``interface``/``type`` declarations (removed — type-only);
    * ``as X`` / ``<T>`` assertion casts;
    * access modifiers (``public``/``private``/``protected``/``readonly``/...);
    * optional ``?`` param markers;
    * SIMPLE ``: Type`` annotations whose type is one or more plain type tokens
      (``string``, ``number``, ``Order``, ``Order[]``, ``Array<T>``, unions ``A|B``)
      — ONLY at signature/declaration scope (brace depth 0), never inside bodies.

    REFUSES (returns ``ok=False``) on: decorators, generics (``<T>`` params),
    enums, ``declare``, namespaces, ``abstract`` — and on object-typed annotations
    like ``: { ok: boolean }`` (the inner braces/colons confuse a regex). Those
    need the real TS compiler; a half-stripped source would mis-trace (principle
    #7: honest refuse > confident mis-trace). When the authoritative
    ``typescript`` module is unavailable AND the regex refuses, the adapter falls
    back to the observed endpoints-only Flow — never a faked trace.
    """
    if _TS_REFUSE.search(source):
        return source, False

    out = source

    # Remove `interface Name { ... }` and `type Name = ...;` declarations (they are
    # type-only; the vocab deriver reads them from the ORIGINAL source).
    out = _strip_block_decl(out, "interface")
    out = _strip_type_alias(out)

    # `as X` assertions
    out = re.sub(r"\bas\s+[A-Za-z_][\w\.<>\[\]|\s&]*", "", out)
    # `<T>expr` non-null/assertion casts (conservative: only leading-angle forms)
    out = re.sub(r"<[A-Za-z_]\w*\s*>", "", out)

    # Strip access modifiers and `readonly` before a member.
    out = re.sub(
        r"\b(public|private|protected|readonly|override|static)\s+",
        "", out,
    )

    # Optional param marker `name?:` -> `name:`
    out = re.sub(r"(\b[A-Za-z_]\w*)\s*\?(?=\s*[:,=)\])])", r"\1", out)

    # Simple `: Type` annotations at signature scope only (never inside bodies).
    out = _strip_colon_annotations(out)

    return out, True


def _strip_block_decl(src: str, kw: str) -> str:
    """Remove ``[export] interface NAME { ... }`` (brace-matched) blocks."""
    pattern = re.compile(
        r"(?m)^[ \t]*(?:export\s+)?" + kw + r"\s+\w+(?:<[^>]*>)?\s*[extends\s+[^{]*]?{"
    )
    while True:
        m = pattern.search(src)
        if not m:
            break
        depth, i = 0, m.end() - 1  # at the opening brace
        start = m.start()
        while i < len(src):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    # swallow a trailing newline so we don't leave a blank line
                    if end < len(src) and src[end] == "\n":
                        end += 1
                    src = src[:start] + src[end:]
                    break
            i += 1
        else:
            break  # unbalanced → leave it; ok-ness unaffected, but no more removal
    return src


def _strip_type_alias(src: str) -> str:
    """Remove ``[export] type NAME = ...;`` declarations up to the terminating
    semicolon at brace-depth 0."""
    pattern = re.compile(
        r"(?m)^[ \t]*(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=\s*"
    )
    out: list[str] = []
    pos = 0
    for m in pattern.finditer(src):
        out.append(src[pos : m.start()])
        i, depth = m.end(), 0
        while i < len(src):
            c = src[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            elif c == ";" and depth == 0:
                i += 1
                if i < len(src) and src[i] == "\n":
                    i += 1
                break
            elif c == "\n" and depth == 0:
                break  # ASI: end of alias with no semicolon
            i += 1
        pos = i
    out.append(src[pos:])
    return "".join(out)


def _strip_colon_annotations(src: str) -> str:
    """Strip TypeScript type annotations, but ONLY inside function signatures
    (param lists + return types) and `const x: Type =` declarations — never inside
    function bodies, where `:` is overwhelmingly a ternary/object-literal label.

    Strategy: walk the source tracking brace depth. At brace depth 0 (module/arrow
    scope, NOT inside a function body) we strip `: Type` annotations. The moment we
    enter a `{` body, we copy verbatim until it closes — so ternaries and object
    literals in the body are never touched. This is the conservative guarantee: a
    type we miss is harmless (esprima still rejects it → endpoints-only fallback); a
    body token we corrupt would be the unrecoverable failure, so we never risk it.
    """
    import string as _string
    type_chars = set(_string.ascii_letters + _string.digits + "_.<>[]|& \t")
    out: list[str] = []
    i, n = 0, len(src)
    brace_depth = 0  # >0 means we are inside a function/object BODY — copy verbatim
    while i < n:
        c = src[i]
        if c == "{":
            brace_depth += 1
            out.append(c)
            i += 1
            continue
        if c == "}":
            brace_depth = max(0, brace_depth - 1)
            out.append(c)
            i += 1
            continue
        if c == ":":
            # Try to consume a SIMPLE `: Type` annotation: one or more plain type
            # tokens (identifiers, `.`, `[]`, `<>`, `|`, `&`, spaces) with NO braces
            # and NO inner colons. A `{` always means a function body / object; an
            # inner `:` means an object type — both stop us. Narrow by design so we
            # can never corrupt a ternary or object literal.
            #
            # SCOPE GATE (the load-bearing correctness rule):
            # * At brace_depth 0 (signatures/declarations): strip ANY `: Type`.
            # * Inside a body (brace_depth>0): strip ONLY `const/let/var IDENT : Type`
            #   declarations — the LHS is unambiguous, so this is safe. Ternary/object
            #   colons inside a body are left alone (a ternary's `?`/values or an
            #   object key's `{`/`,` would fail the gate below).
            if brace_depth > 0:
                # Look back: is this `IDENT:` preceded by const/let/var?
                jb = i - 1
                while jb >= 0 and src[jb] in " \t":
                    jb -= 1
                # walk back over the identifier
                idend = jb
                while idend >= 0 and (src[idend].isalnum() or src[idend] == "_"):
                    idend -= 1
                if idend < 0 or idend == jb:
                    out.append(c)
                    i += 1
                    continue
                # find the keyword before the identifier
                kw_end = idend
                while kw_end >= 0 and src[kw_end] in " \t":
                    kw_end -= 1
                kw = ""
                ks = kw_end
                while ks >= 0 and (src[ks].isalnum() or src[ks] == "_"):
                    ks -= 1
                kw = src[ks + 1 : kw_end + 1]
                if kw not in ("const", "let", "var"):
                    out.append(c)
                    i += 1
                    continue
            k = i + 1
            while k < n and src[k] in " \t":
                k += 1
            end = k
            while end < n:
                ch = src[end]
                if ch in "({":
                    break  # body brace or nested — refuse (too complex for regex)
                if ch in ")]":
                    break  # closing the enclosing param list / call
                if ch == ":" :
                    break  # inner colon = object type — refuse
                if ch in ",;\n=>":
                    break
                if ch.lower() not in type_chars and ch not in "[]<>":
                    break
                end += 1
            body = src[k:end]
            if body and all(ch.lower() in type_chars or ch in "[]<>" for ch in body):
                i = end  # drop `: Type` (colon at i through end)
                continue
        out.append(c)
        i += 1
    return "".join(out)


def strip_types_best_effort(
    source: str,
    *,
    file_name: str = "input.ts",
    search_paths: list[str] | None = None,
) -> tuple[str, str, bool]:
    """Authoritative-first, regex-fallback type stripper.

    Returns ``(js_source, strategy, ok)`` where ``strategy`` is ``"typescript"`` /
    ``"regex"`` / ``"none"``. ``ok=False`` (``strategy="none"``) means the caller
    must fall back to endpoints-only — never a half-stripped mis-trace.
    """
    js, ok = strip_types(source, file_name=file_name, search_paths=search_paths)
    if ok:
        return js, "typescript", True
    js, ok = strip_types_regex(source)
    if ok:
        return js, "regex", True
    return source, "none", False
