"""Go FLOW-mode adapter (spec §2b/§8.8) — observes what Go code does to business objects.

The FLOW instrument observes what code does to business objects and emits an honest
:class:`~dreplay.flow.Flow`. This adapter proves the core/adapter seam extends to Go
for FLOW mode: it runs ONE Go function on a JSON kwargs input and captures the call/
return trace into a Flow.

MECHANISM (spec §2 — source instrumentation via Go's ``go/ast``): the target ``.go``
file is rewritten (:mod:`dreplay.adapter.go_trace`) so each function emits an enter
event (name + arg values) and a deferred exit event (return value). The rewritten
source is concatenated with a tiny trace runtime + a ``main`` harness (templates
below) into a self-contained ``main`` package, then ``go run`` compiles+executes it.
The harness reads kwargs from the ``DREPLAY_INPUT`` env var, calls the entrypoint, and
emits the Flow JSON protocol (events/constants/defined_funcs/return/exception). The
host (:func:`dreplay.instrument._reduce`) reduces that into a Flow of Nodes with
Operands + Provenance.

HONESTY RULE (docs/what-this-is.md §1, principle #7 — do not fake the plumbing):
  * the ``input`` node (kwargs) is OBSERVED;
  * every interior call/return that the rewrite captured is OBSERVED (real interior
    nodes, not synthesized);
  * the ``return`` node (the entrypoint's returned value) is OBSERVED, or an ``other``
    node carries the panic — OBSERVED;
  * if Go is not installed, or the source does not parse/compile, the adapter falls
    back to an honest endpoints-only Flow (input + return/error + an
    ``interior-unobservable`` note labelled ``unknown``). A faked interior node is the
    one unrecoverable failure.

VOCAB: :func:`derive_go_vocabulary` parses Go ``struct`` declarations
(``type Foo struct { Bar int; Baz string }``) → field names, feeding the schema-derived
classifier so a traced call binding a declared field is business-meaningful by
construction (matches :mod:`dreplay.vocabulary` for Python models).

STATUS LINE: :func:`go_flow` prints to stderr which adapter ran, the classifier mode
(vocab/non-vocab), and the vocab count — the reviewer's mode-transparency prerequisite.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any

from ..flow import Flow, Node, Operand
from ..instrument import _reduce  # the language-independent reducer
from . import go_trace

# --------------------------------------------------------------------------- #
# Go trace runtime + harness templates
# --------------------------------------------------------------------------- #
# The runtime the rewritten source calls into. __dtEnter pushes a record; __dtExit
# pops the matching frame and fills its return values (stack-disciplined, so nested
# calls match correctly even when an inner panic unwinds). Values are JSON-canonical
# via fmt's default %v + a small anyMap marshaler so the host's _reduce sees plain
# JSON-able shapes (maps/slices/numbers/strings/bools).
_GO_RUNTIME = r'''
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
)

type goEvent struct {
	Func   string                 `json:"func"`
	Locals map[string]any         `json:"locals"`
	Ret    any                    `json:"return"`
}

var __dtEvents []goEvent
var __dtStack []*goEvent

func __dreplay_traced__(name string, args ...any) {
	loc := map[string]any{}
	// args arrive positionally; the host binds operands from the map values, so we
	// store them under synthetic keys arg0..argN. (Field names come from the call's
	// business-object values, not param names — same as the JS/Python instruments.)
	for i, a := range args {
		loc[fmt.Sprintf("arg%d", i)] = canon(a)
	}
	ev := &goEvent{Func: name, Locals: loc}
	__dtEvents = append(__dtEvents, *ev)
	__dtStack = append(__dtStack, &__dtEvents[len(__dtEvents)-1])
}

func __dtExit(name string, ret []any) {
	if len(__dtStack) == 0 {
		return
	}
	// Pop until we find the frame matching this exit (handles deferred ordering).
	for i := len(__dtStack) - 1; i >= 0; i-- {
		if __dtStack[i].Func == name {
			out := []any{}
			for _, r := range ret {
				out = append(out, canon(r))
			}
			__dtStack[i].Ret = out
			__dtStack = __dtStack[:i]
			break
		}
	}
}

// canon reduces a Go value to a JSON-able shape (map[string]any / []any / scalar).
// struct values marshal to maps; the rest goes through encoding/json.
func canon(v any) any {
	// nil → null
	if v == nil {
		return nil
	}
	// fast path for already-primitives
	switch t := v.(type) {
	case string, bool, int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64, float32, float64:
		return t
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		return string(b)
	}
	return out
}
'''

# The harness main: read kwargs from DREPLAY_INPUT, call the entrypoint, emit the
# Flow JSON. The entrypoint call line is spliced in by go_flow() (it needs the func
# name + how to extract kwargs).
_GO_MAIN_TEMPLATE = r'''
func main() {
	defer func() {
		if r := recover(); r != nil {
			__emit(map[string]any{
				"events":   __dtEvents,
				"constants": __dtConstants,
				"defined_funcs": __dtFuncs,
				"auth_calls": map[string][]string{},
				"outbound": []any{},
				"return": nil,
				"exception": map[string]any{"type": "panic", "message": fmt.Sprintf("%v", r)},
			})
		}
	}()
	in := os.Getenv("DREPLAY_INPUT")
	var kv map[string]any
	_ = json.Unmarshal([]byte(in), &kv)
	__dtCallEntry(kv)
	__emit(map[string]any{
		"events":   __dtEvents,
		"constants": __dtConstants,
		"defined_funcs": __dtFuncs,
		"auth_calls": map[string][]string{},
		"outbound": []any{},
		"return": __dtRet,
		"exception": nil,
	})
}

func __emit(out map[string]any) {
	b, err := json.Marshal(out)
	if err != nil {
		fmt.Println(`{"exception":{"type":"marshal","message":"` + fmt.Sprintf("%v", err) + `"}}`)
		return
	}
	fmt.Println(string(b))
}

var __dtRet any
var __dtConstants = map[string]any{}
var __dtFuncs = []string{}
'''


def _entry_glue(func: str, kwargs: dict[str, Any]) -> str:
    """Generate the __dtCallEntry func that calls the entrypoint reflectively.

    The entrypoint has an unknown typed signature, so we resolve it with ``reflect``
    and coerce the JSON kwargs (in insertion order) to the func's declared parameter
    types before calling. This makes typed funcs (``func classify(x int)``) callable
    from a generic harness without code-generating a per-signature call. Number args
    accept float64/int; the coercion handles the json-number-is-float64 reality.
    """
    keys = list(kwargs.keys())
    lines = ["func __dtCallEntry(kv map[string]any){"]
    lines.append("\tfv := reflect.ValueOf(" + func + ")")
    lines.append("\tft := fv.Type()")
    lines.append("\targs := make([]reflect.Value, ft.NumIn())")
    lines.append("\tfor i := 0; i < ft.NumIn(); i++ {")
    lines.append("\t\tvar raw any")
    lines.append("\t\tif i < len(kv) {")
    lines.append("\t\t\traw = kv[__nthKey(i)]")
    lines.append("\t\t} else {")
    lines.append("\t\t\traw = nil")
    lines.append("\t\t}")
    lines.append("\t\targs[i] = _coerce(raw, ft.In(i))")
    lines.append("\t}")
    lines.append("\tout := fv.Call(args)")
    lines.append("\tres := make([]any, len(out))")
    lines.append("\tfor i, o := range out { res[i] = o.Interface() }")
    lines.append("\tvar ret any")
    lines.append("\tif len(res) == 1 { ret = res[0] } else if len(res) == 0 { ret = nil } else { ret = res }")
    lines.append("\t__dtRet = canon(ret)")
    lines.append("}")
    lines.append(_REFLECT_HELPERS)
    # Provide the ordered kwarg keys to the harness via a generated slice so
    # positional mapping matches insertion order.
    keys_lit = ", ".join(json.dumps(k) for k in keys)
    lines.append("var __dtKeys = []string{" + keys_lit + "}")
    lines.append("func __nthKey(i int) string { if i < len(__dtKeys) { return __dtKeys[i] }; return \"\" }")
    return "\n".join(lines)


# Reflection + coercion helpers emitted into the generated main.go. _coerce converts a
# JSON-decoded value (float64/bool/string/nil/map/slice) into the func's declared
# parameter reflect.Type. Supports the common scalar kinds + string; unknown kinds
# fall back to the zero value (honest: we observed the call, not a fabricated value).
_REFLECT_HELPERS = r'''
func _coerce(v any, t reflect.Type) reflect.Value {
	if v == nil {
		return reflect.Zero(t)
	}
	rv := reflect.ValueOf(v)
	// If already assignable, use directly.
	if rv.Type().ConvertibleTo(t) {
		return rv.Convert(t)
	}
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if f, ok := v.(float64); ok {
			return reflect.ValueOf(f).Convert(t)
		}
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		if f, ok := v.(float64); ok {
			return reflect.ValueOf(f).Convert(t)
		}
	case reflect.Float32, reflect.Float64:
		if f, ok := v.(float64); ok {
			return reflect.ValueOf(f).Convert(t)
		}
	case reflect.String:
		if s, ok := v.(string); ok {
			return reflect.ValueOf(s)
		}
	case reflect.Bool:
		if b, ok := v.(bool); ok {
			return reflect.ValueOf(b)
		}
	}
	return reflect.Zero(t)
}
'''


def _go_ident(k: str) -> str:
    """Make a Go-safe identifier from a key."""
    out = re.sub(r"[^A-Za-z0-9_]", "_", k)
    if not out or out[0].isdigit():
        out = "a" + out
    return "__a_" + out


# --------------------------------------------------------------------------- #
# Vocab deriver — parse Go struct declarations → field names
# --------------------------------------------------------------------------- #
# Matches: type Name struct { Field Type; Field2 Type2 ... }
# Handles multi-line, inline, and embedded fields. Conservative: pulls IDENT field
# names from struct bodies. This is best-effort structural parsing (Go's own parser
# lives in the toolchain; for vocab we only need field names, so a careful regex scan
# of struct bodies suffices and avoids compiling the package).
_STRUCT_RE = re.compile(
    r"type\s+(\w+)\s+struct\s*\{(?P<body>.*?)\}", re.DOTALL,
)
# A struct field line:  Name Type   OR   Name, Name2 Type   OR   *Pkg.Type (embedded).
# We extract leading identifiers that look like field names (capitalized or lowercase,
# not the type). We keep names that are followed by a space+type or a tag.
_FIELD_LINE_RE = re.compile(
    r"^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+([A-Za-z_*\[\]\.{}]+)"
)


def derive_go_vocabulary(source: str) -> set[str]:
    """Read field names out of Go ``struct`` declarations in ``source``.

    Returns the set of declared field names (the domain vocabulary), best-effort: if
    the source has no structs, returns an empty set and the classifier falls back to
    the dominant-name set (graceful degrade, matching :mod:`dreplay.vocabulary`).
    """
    fields: set[str] = set()
    for m in _STRUCT_RE.finditer(source):
        body = m.group("body")
        for line in body.split("\n"):
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            # Strip trailing struct tag (backtick ... ).
            line = re.split(r"`", line)[0].strip()
            fm = _FIELD_LINE_RE.match(line)
            if fm:
                for name in re.split(r"\s*,\s*", fm.group(1)):
                    if name and not name.startswith("_"):
                        fields.add(name)
            else:
                # embedded field like "*Pkg.Type" or "Pkg.Type" → use the last ident.
                emb = re.match(r"^\s*[*]?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)", line)
                if emb:
                    last = emb.group(1).split(".")[-1]
                    if last and not last.startswith("_"):
                        fields.add(last)
    return fields


# --------------------------------------------------------------------------- #
# The adapter entry — run ONE Go function, reduce to an observed Flow
# --------------------------------------------------------------------------- #
def go_flow(
    *,
    module_path: str,
    func: str,
    kwargs: dict[str, Any] | None = None,
    timeout_s: float = 60.0,
    containment_level: str = "none",
) -> Flow:
    """Run ONE Go function and capture its trace as an observed :class:`Flow`.

    Parameters mirror the engine's adapter contract, narrowed for FLOW mode:

    * ``module_path`` — absolute path to a single ``.go`` file (``package main``-free
      functions are fine; we rewrite it into a self-contained main package).
    * ``func`` — the top-level function to call as the entrypoint.
    * ``kwargs`` — values passed as positional arguments in insertion order (Go funcs
      commonly take scalars/structs positionally; we pass the json values through).
    * ``timeout_s`` — ``go run`` subprocess timeout.

    Returns a :class:`Flow` whose nodes are OBSERVED (input, interior calls, return)
    when the toolchain + rewrite succeed; otherwise an honest endpoints-only Flow with
    an ``interior-unobservable`` note (provenance ``unknown``) — never a faked node.
    """
    kwargs = dict(kwargs or {})
    entrypoint = f"{module_path}::{func}"

    # Status line printed to stderr so the reviewer sees adapter + classifier mode.
    status_adapter = "go-flow"

    if not go_trace.available():
        return _endpoints_only(
            entrypoint, func, kwargs, containment_level,
            "go toolchain not installed", status_adapter,
        )

    # 1. Read + rewrite the target source.
    try:
        source = open(module_path, encoding="utf-8").read()
    except OSError as exc:
        return _endpoints_only(
            entrypoint, func, kwargs, containment_level,
            f"cannot read source: {exc}", status_adapter,
        )

    rewritten, ok = go_trace.rewrite(source)
    if not ok:
        return _endpoints_only(
            entrypoint, func, kwargs, containment_level,
            "source instrumentation unavailable (parse/toolchain) — endpoints-only",
            status_adapter,
        )

    # Strip the original package clause + imports + main from the rewritten file,
    # COLLECTING the target's imports so a function using strings/math/sort keeps
    # them (else the concatenated file fails: `undefined: strings`).
    body_only, target_imports = _strip_package_and_imports(rewritten)

    # 2. Assemble the full main.go: package + merged import block (runtime's ∪
    # target's) + runtime body (its own package/import header removed) + harness.
    runtime_body = _strip_runtime_header(_GO_RUNTIME)
    entry_glue = _entry_glue(func, kwargs)
    full = (
        "package main\n"
        + _assemble_imports(target_imports) + "\n"
        + runtime_body + "\n"
        + _GO_MAIN_TEMPLATE + "\n"
        + entry_glue + "\n"
        + body_only
    )

    # 3. Run `go run` in a temp module dir.
    with tempfile.TemporaryDirectory(prefix="dreplay_go_") as tmp:
        main_go = os.path.join(tmp, "main.go")
        with open(main_go, "w", encoding="utf-8") as fh:
            fh.write(full)
        env = dict(os.environ)
        env["DREPLAY_INPUT"] = json.dumps(kwargs)
        env["GO111MODULE"] = "off"  # stdlib-only; no module resolution
        try:
            proc = subprocess.run(
                ["go", "run", main_go],
                env=env, capture_output=True, text=True, timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            return _endpoints_only(
                entrypoint, func, kwargs, containment_level,
                f"go run timed out after {timeout_s}s", status_adapter,
            )
        except FileNotFoundError:
            return _endpoints_only(
                entrypoint, func, kwargs, containment_level,
                "go executable not found on PATH", status_adapter,
            )

        if proc.returncode != 0:
            msg = (proc.stderr or proc.stdout or f"exit {proc.returncode}")[:500]
            return _endpoints_only(
                entrypoint, func, kwargs, containment_level,
                f"go run failed to compile/run: {msg}", status_adapter,
            )

        try:
            data = json.loads(proc.stdout.splitlines()[-1] if proc.stdout else "{}")
        except (json.JSONDecodeError, IndexError):
            msg = (proc.stdout or proc.stderr or "no output")[:500]
            return _endpoints_only(
                entrypoint, func, kwargs, containment_level,
                f"go run produced no JSON: {msg}", status_adapter,
            )

    # 4. Reduce the observed trace into a Flow via the language-independent reducer.
    return _reduce_go(entrypoint, module_path, func, kwargs, source, data,
                      containment_level, status_adapter)


def _strip_package_and_imports(src: str) -> tuple[str, list[str]]:
    """Drop the leading ``package X`` line, top-level import block, AND the user's
    ``func main()`` from src so it can be concatenated after our runtime template
    (which declares the package + its own main harness). Without stripping the user's
    main, Go reports 'main redeclared in this block' — every real Go program has
    func main(), so this is load-bearing.

    Returns ``(body, import_specs)``. The target's imports are COLLECTED (not
    discarded) and returned so the caller can merge them into the single combined
    import block — a real function using ``strings``/``math``/``sort`` must keep
    those imports or the concatenated file will not compile (``undefined: strings``)."""
    lines = src.splitlines()
    out: list[str] = []
    imports: list[str] = []
    in_import = False
    in_main = False
    brace_depth = 0
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("package "):
            continue
        if stripped.startswith("import ") or stripped == "import":
            # Three forms: `import "x"` (single line), `import ("x")` (single-line
            # paren, closed here), and `import (` (multi-line block — gofmt's
            # default). Only the last opens a block to keep stripping; the bug was
            # testing for `{` (never used by Go imports) instead of `(`, so real
            # multi-line blocks leaked their "pkg" lines and broke compilation.
            if stripped.endswith("("):
                in_import = True
            else:
                # single-line: `import "fmt"` or `import ("fmt")` / `import x "y"`
                spec = stripped[len("import"):].strip().strip("()").strip()
                if spec:
                    imports.append(spec)
            continue
        if in_import:
            if stripped in (")", ""):
                if stripped == ")":
                    in_import = False
                continue
            if ")" in stripped:  # e.g. a spec then the closer on one line
                imports.append(stripped.split(")")[0].strip())
                in_import = False
                continue
            imports.append(stripped)  # one import spec per line inside the block
            continue
        # Strip func main() { ... } — the adapter provides its own harness main
        if not in_main and stripped.startswith("func main()"):
            in_main = True
            brace_depth = 0
        if in_main:
            brace_depth += stripped.count("{") - stripped.count("}")
            if brace_depth <= 0:
                in_main = False
            continue
        out.append(line)
    return "\n".join(out), imports


# Imports the runtime template already declares — never re-emit these.
_RUNTIME_IMPORTS = {'"encoding/json"', '"fmt"', '"os"', '"reflect"'}


def _strip_runtime_header(runtime: str) -> str:
    """Drop the runtime template's own ``package main`` + import block so it can be
    concatenated after the single merged package/import header the caller emits."""
    body, _imports = _strip_package_and_imports(runtime)
    return body


def _import_path(spec: str) -> str:
    """The quoted path of an import spec, ignoring any alias (``m "math"`` → ``"math"``)."""
    spec = spec.strip()
    parts = spec.split()
    return parts[-1] if parts else spec


def _assemble_imports(target_imports: list[str]) -> str:
    """The runtime template's fixed import block, augmented with the target's own
    imports (deduped, runtime ones removed). Blank comment/side-effect lines are
    dropped defensively."""
    extra: list[str] = []
    seen = set(_RUNTIME_IMPORTS)
    for spec in target_imports:
        spec = spec.strip()
        if not spec or spec.startswith("//"):
            continue
        path = _import_path(spec)
        if path in seen:
            continue
        seen.add(path)
        extra.append(spec)
    block = ['import (', '\t"encoding/json"', '\t"fmt"', '\t"os"', '\t"reflect"']
    block += [f"\t{s}" for s in extra]
    block.append(')')
    return "\n".join(block)


# --------------------------------------------------------------------------- #
# Reduction — observed trace → Flow (delegates to the shared _reduce)
# --------------------------------------------------------------------------- #
# The shared reducer in instrument._reduce expects the Flow JSON protocol and a
# VocabularyResult. We adapt our Go trace to that protocol and synthesize a
# VocabularyResult from the Go struct declarations in the target source, so the
# classifier runs in VOCAB mode when structs are declared (and non-vocab otherwise).
class _MiniVocab:
    """Minimal stand-in for VocabularyResult passed to _reduce."""
    def __init__(self, fields: set[str]) -> None:
        self.fields = fields
        self.mode = "vocab" if fields else "non_vocab"
        self.fallback_reason = None if fields else "no Go struct declarations found"


def _reduce_go(entrypoint: str, module_path: str, func: str, kwargs: dict,
               source: str, data: dict, containment_level: str,
               status_adapter: str) -> Flow:
    # Derive vocab from the target source's struct declarations.
    vocab_fields = derive_go_vocabulary(source)
    vocab = _MiniVocab(vocab_fields)

    # _reduce takes an ImplSpec; build a minimal stand-in.
    class _Spec:
        pass
    spec = _Spec()
    spec.module = module_path
    spec.func = func

    # The shared _reduce surfaces data["exception"] as an observed thrown-error
    # node (and emits no return node for a run that never returned) — a Go panic
    # rides the same path as a Python raise; nothing adapter-specific left to do.
    flow = _reduce(spec, kwargs, "instant", None, data, containment_level, vocab)

    # Status line (mode transparency): adapter + classifier mode + vocab count.
    _print_status(status_adapter, vocab.mode, len(vocab_fields), func)
    return flow


def _print_status(adapter: str, mode: str, vocab_size: int, func: str) -> None:
    print(
        f"[dreplay] adapter={adapter} classifier_mode={mode} vocab={vocab_size} "
        f"entrypoint={func}",
        file=sys.stderr,
    )


# --------------------------------------------------------------------------- #
# Endpoints-only fallback (toolchain/parse/run failure — never a faked interior node)
# --------------------------------------------------------------------------- #
def _endpoints_only(entrypoint: str, func: str, kwargs: dict,
                    containment_level: str, reason: str, adapter: str) -> Flow:
    """Honest fallback when Go instrumentation can't run AT ALL (toolchain
    missing, source unreadable, parse/compile/run failure, no JSON out). Nothing
    executed, so this is an instrumentation-error — NOT an endpoints-only
    observation and NOT "interior-unobservable" (which would imply the run
    happened and only the interior was invisible). The label drives the CLI's
    non-zero exit and the diff refuse, so a run that observed nothing never reads
    as "clean". No node is synthesized."""
    # func-only label (not the absolute module path) so node identity is stable
    # across a worktree/repo diff — a path-embedded label was phantom-diff noise.
    input_ops = tuple(
        Operand(name=k, value=v, provenance="observed") for k, v in kwargs.items()
    )
    flow = Flow(
        entrypoint=entrypoint, mode="instant",
        nodes=(
            Node(kind="input", label=func, operands=input_ops,
                 business_meaningful=True),
            Node(
                kind="other", label="instrumentation-error", provenance="unknown",
                operands=(Operand(name="error", value=reason, provenance="unknown"),),
                business_meaningful=True,
                open_question=(
                    f"the go adapter could not run this entrypoint ({reason}) — "
                    "nothing was observed. This is a dreplay/toolchain failure, not "
                    "observed target behavior."
                ),
            ),
        ),
        containment_level=containment_level,
        classifier_mode="non_vocab",
        vocab_size=0,
        fallback_reason=reason,
    )
    _print_status(adapter, "non_vocab", 0, func)
    return flow
