"""C# / .NET FLOW-mode adapter (spec §2a/§8.8 — the C# mirror of node_flow).

The FLOW instrument observes what code does to business objects and emits an honest
:class:`~dreplay.flow.Flow`. This adapter proves the core/adapter seam extends to C# /
.NET: it runs ONE method on a JSON-kwargs input and captures **interior** call/return
state into a Flow — real instrumentation, NOT endpoints-only.

TRACER MECHANISM (the load-bearing choice — do not fake the plumbing):
C# / .NET has no ``sys.settrace`` wireable from outside the runtime, and
``dotnet-trace`` / EventPipe capture runtime ETW events (method entry/exit) but do
NOT yield bound local/parameter VALUES (the adjudicable quantities a Flow needs).
So we use **source instrumentation via Roslyn** (the .NET team's own compiler, restored
from NuGet — NOT a dreplay/Python dependency). The mechanism:

  1. This adapter generates a throwaway console project in a temp dir, copies in
     ``dreplay/csharp_tracer.cs`` (the Program.cs), and adds the NuGet package
     ``Microsoft.CodeAnalysis.CSharp``.
  2. It runs ``dotnet run`` with env vars naming the target source path, the owning
     TYPE, the METHOD, and the JSON kwargs.
  3. At runtime the tracer uses Roslyn's ``CSharpSyntaxRewriter`` to wrap EVERY
     method body in the target source with enter/exit hooks that snapshot
     (paramName → value) on entry and the return value on exit — the C# analogue of
     ``sys.settrace`` with bound values.
  4. It compiles the rewritten source in-memory (``CSharpCompilation``), invokes the
     target method via reflection, and emits the **Flow JSON protocol** (identical
     shape to the Python worker: events / constants / defined_funcs / auth_calls /
     outbound / return / exception) to stdout.
  5. This adapter parses that JSON and calls ``instrument._reduce`` → an observed
     :class:`~dreplay.flow.Flow` of :class:`~dreplay.flow.Node`\\s.

HONESTY RULE (docs/what-this-is.md §1, principle #7 — do not fake the plumbing):
  * every event is observed (the method really ran; params/return were snapshotted);
  * a method that did not run produces NO event (no synthesis);
  * if ``dotnet`` is unavailable, the target won't compile, or the method can't be
    resolved, the adapter emits an ``instrumentation-error`` Flow (provenance
    ``unknown``, business-meaningful so the human sees it) — NEVER a fake clean flow;
  * limitations are NAMED, never papered: async methods (state machine) and iterators
    (``yield``) are left unrewritten — their interior is unobservable via this seam
    and that is surfaced honestly, not invented.

VOCABULARY: :func:`derive_csharp_vocabulary` reads C# ``class``/``record``
declarations (auto-properties + primary-constructor parameters) from the target's
own source — the domain's declared field names — and feeds them to ``_reduce`` so
the classifier operates in vocab mode (schema-derived precision, not name-guessing).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any

from ..flow import Flow, Node, Operand
from ..instrument import _reduce
from ..types import ImplSpec
from ..vocabulary import VocabularyResult

_DREPLAY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TRACER_CS = os.path.join(_DREPLAY_ROOT, "csharp_tracer.cs")

# The .csproj template for the throwaway tracer project. Targets net8.0 (the SDK we
# require); restores the Roslyn compiler package from NuGet (the only network need,
# and it's the .NET team's OWN package, not a Python dep). Invariant globalization
# sidesteps ICU/locale warnings on minimal hosts.
_CSPROJ = """\
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <InvariantGlobalization>true</InvariantGlobalization>
    <RestoreAdditionalProjectSources></RestoreAdditionalProjectSources>
    <NoWarn>$(NoWarn);NETSDK1188;CS8619;CS8604;CS8602;CS8600</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="4.8.0" />
  </ItemGroup>
</Project>
"""


def csharp_flow(
    *,
    source_path: str,
    type_name: str,
    method: str,
    kwargs: dict[str, Any] | None = None,
    timeout_s: float = 120.0,
) -> Flow:
    """Run ONE C# method and capture its interior as an observed :class:`Flow`.

    Parameters mirror the engine's adapter contract, narrowed for FLOW mode:

    * ``source_path`` — absolute path to a ``.cs`` file containing the target type.
    * ``type_name`` — the class/struct that owns ``method`` (``Name`` or
      ``Namespace.Name``; falls back to the first public class).
    * ``method`` — the instance or static method to invoke.
    * ``kwargs`` — values passed positionally, in insertion order, mapped onto the
      method's parameter list (the documented kwarg→positional mapping shared with
      the JS adapter).
    * ``timeout_s`` — ``dotnet run`` timeout (the first run restores NuGet packages,
      hence the generous default).

    Returns an observed :class:`Flow` whose default (business-meaningful) view
    includes the input node, one node per traced in-scope call (interior + return,
    with bound operands), the return node, and any auth-check-not-executed node.

    If ``dotnet`` is not on PATH, the target won't compile, or the method can't be
    resolved, returns an ``instrumentation-error`` Flow (honest — never a fake clean
    run).
    """
    kwargs = dict(kwargs or {})
    entrypoint = f"{os.path.basename(source_path)}::{type_name}.{method}"

    if shutil.which("dotnet") is None:
        return _error_flow(entrypoint, kwargs, "dotnet executable not found on PATH")
    if not os.path.isfile(_TRACER_CS):
        return _error_flow(entrypoint, kwargs, "csharp_tracer.cs missing from dreplay package")
    if not os.path.isfile(source_path):
        return _error_flow(entrypoint, kwargs, f"target source not found: {source_path}")

    project_dir = tempfile.mkdtemp(prefix="dreplay_cs_")
    try:
        shutil.copy(_TRACER_CS, os.path.join(project_dir, "Program.cs"))
        with open(os.path.join(project_dir, "tracer.csproj"), "w", encoding="utf-8") as fh:
            fh.write(_CSPROJ)

        env = dict(os.environ)
        env.update({
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
            "DOTNET_NOLOGO": "1",
            "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1",
            "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT": "1",
            "DREPLAY_CS_SOURCE": os.path.abspath(source_path),
            "DREPLAY_CS_TYPE": type_name,
            "DREPLAY_CS_METHOD": method,
            "DREPLAY_CS_KWARGS": json.dumps(kwargs, default=str),
        })

        try:
            proc = subprocess.run(
                ["dotnet", "run", "--project", project_dir],
                env=env, capture_output=True, text=True, timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            return _error_flow(entrypoint, kwargs, f"dotnet run timed out after {timeout_s}s")
    finally:
        shutil.rmtree(project_dir, ignore_errors=True)

    # Parse the Flow JSON the tracer emitted on stdout. The tracer writes ONLY the
    # JSON payload to stdout (all diagnostics go to stderr), so stdout is the payload.
    stdout = (proc.stdout or "").strip()
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        msg = stdout or (proc.stderr or f"exit {proc.returncode}")[:500]
        return _error_flow(entrypoint, kwargs, f"dotnet tracer produced no JSON: {msg}")

    # If the tracer itself reported a top-level failure (compile error, missing
    # method), surface it honestly.
    exc = data.get("exception")
    if exc is not None and not data.get("events") and not data.get("rewritten"):
        return _error_flow(
            entrypoint, kwargs,
            f"tracer failure: {exc.get('type')}: {exc.get('message')}",
        )

    spec = ImplSpec(module=f"csharp:{type_name}", func=method)

    # Derive vocab from the target's OWN C# declarations → classifier in vocab mode.
    vocab = derive_csharp_vocabulary(source_path)

    # The status line (spec §2d): which adapter + classifier mode + vocab count.
    # Printed to stderr so it never pollutes a captured stdout payload.
    import sys as _sys
    _sys.stderr.write(
        f"[dreplay] adapter=csharp_flow  classifier={vocab.mode}  "
        f"vocab_size={len(vocab.fields)}  "
        f"fallback={vocab.fallback_reason or 'none'}\n"
    )

    # The shared _reduce surfaces data["exception"] as an observed thrown-error
    # node (and emits no fabricated return node for a run that threw) — a thrown
    # C# exception rides the same path as a Python raise. Tracer-level failures
    # (no events, not rewritten) were already returned as _error_flow above.
    return _reduce(spec, kwargs, "instant", seed=None, data=data,
                   containment_level="none", vocab_result=vocab)


# --------------------------------------------------------------------------- #
# C# vocabulary deriver — read class/record declarations → field names
# --------------------------------------------------------------------------- #
# Regex-based: Roslyn is a runtime dep (only available inside the tracer's .NET
# process), so the vocab deriver parses C# source with a conservative regex that
# covers the common declaration shapes (auto-properties, primary-constructor params,
# plain field declarations). Best-effort: malformed source yields an empty vocab and
# the classifier degrades to non-vocab mode (graceful, never raises).

# public/protected/internal/private/static/readonly/const modifiers (optional), then a
# type, then an identifier, then ` { get; set; }` (auto-property) — the dominant shape.
_AUTO_PROP_RE = re.compile(
    r"\b(?:public|private|protected|internal|static|readonly|virtual|override|sealed|new|abstract|async|required|\s)+"
    r"[\w\.\?\<\>,\[\]]+\s+(\w+)\s*\{\s*(?:get|set)[^}]*\}",
    re.MULTILINE,
)
# Record primary constructor: `record Foo(Type1 A, Type2 B)` → A, B.
_RECORD_PRIMARY_RE = re.compile(
    r"\brecord\s+(?:sealed\s+|abstract\s+)?(\w+)\s*<[^>]*>\s*\(([^)]*)\)|"
    r"\brecord\s+(?:sealed\s+|abstract\s+)?(\w+)\s*\(([^)]*)\)",
    re.MULTILINE,
)
# Plain instance field: `<modifiers> <Type> <name>;` (excludes const/static seed tables).
_FIELD_RE = re.compile(
    r"\b(?:public|private|protected|internal|readonly|virtual|override|new|required|\s)+"
    r"[\w\.\?\<\>,\[\]]+\s+(\w+)\s*[=;]",
    re.MULTILINE,
)

# Names that are never business fields in C# — framework plumbing / noise.
_PLUMBING = {
    "value",  # setter implicit param
    "Item",
    "Count",
    "Length",
    "Equals",
    "GetHashCode",
    "ToString",
    "Dispose",
    "PropertyChanged",
    "Binding",
    "Backing",
}


def derive_csharp_vocabulary(source_path: str) -> VocabularyResult:
    """Read C# class/record field declarations from ``source_path``.

    Returns a :class:`~dreplay.vocabulary.VocabularyResult` whose ``fields`` are the
    business field names the target's own models declare. Best-effort: unparseable
    source yields an empty result (the classifier degrades to non-vocab mode, named
    via ``fallback_reason`` — never raises, never fakes).
    """
    fields: set[str] = set()
    models = 0
    errors: list[str] = []
    try:
        source = open(source_path, encoding="utf-8", errors="replace").read()
    except OSError as exc:
        return VocabularyResult(set(), 0, 0, 0, (f"OSError: {exc}",))

    try:
        # A "model" heuristic: a class/record whose name does NOT end in a service-y
        # suffix. We count classes/records, and collect fields from all of them.
        class_names = re.findall(
            r"\b(?:class|record|struct)\s+(\w+)", source)
        models = len(class_names)

        # Auto-properties (the dominant C# model shape).
        for m in _AUTO_PROP_RE.finditer(source):
            name = m.group(1)
            if _is_business_field(name):
                fields.add(name)

        # Record primary-constructor parameters.
        for m in _RECORD_PRIMARY_RE.finditer(source):
            params = m.group(2) or m.group(4) or ""
            for param in _split_params(params):
                pname = param.strip().split()[-1] if param.strip() else ""
                pname = pname.lstrip("@").split("=")[0].strip()
                if _is_business_field(pname):
                    fields.add(pname)

        # Plain instance fields (structs/POCOs without auto-props).
        if not fields:
            for m in _FIELD_RE.finditer(source):
                name = m.group(1)
                if _is_business_field(name):
                    fields.add(name)
    except Exception as exc:  # noqa: BLE001 — best-effort; never raise
        errors.append(f"{type(exc).__name__}: {exc}")

    return VocabularyResult(
        fields=fields,
        modules_scanned=1,
        modules_imported=1,
        models_found=models,
        import_errors=tuple(errors),
    )


def _split_params(params: str) -> list[str]:
    """Split a C# parameter list on top-level commas (respecting nested <>)."""
    out: list[str] = []
    depth = 0
    cur = []
    for ch in params:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        out.append("".join(cur))
    return out


def _is_business_field(name: str) -> bool:
    if not name or len(name) < 2:
        return False
    if name in _PLUMBING:
        return False
    if name.startswith("_") or name.startswith("__"):
        return False
    # All-caps (constants) are not fields.
    if name.isupper():
        return False
    return True


# --------------------------------------------------------------------------- #
# Error Flow (honest: instrumentation-error, never a fake clean run)
# --------------------------------------------------------------------------- #
def _error_flow(entrypoint: str, kwargs: dict, message: str) -> Flow:
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
                open_question=(
                    f"C# FLOW adapter could not observe this run: {message} — "
                    f"supply a runnable entrypoint?"
                ),
            ),
        ),
        containment_level="none",
    )
