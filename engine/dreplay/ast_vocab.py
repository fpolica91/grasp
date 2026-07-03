"""Static business-vocabulary extraction via ast-grep — the SAFE, no-execution path.

:mod:`dreplay.vocabulary` derives the domain vocabulary (a repo's own model field
names) so the classifier can mark a traced call business-meaningful by construction.
Its original mechanism **imports every module** in the repo and introspects the model
classes — which *executes* the repo's top-level code in the dreplay host process
(outside the observation subprocess, with no wall). That is a real hazard (import-time
side effects, ``setup.py`` running ``setuptools.setup()``, ×N under fuzz) and a common
false-negative source (a module that fails to import — Django settings, a missing dep —
contributes nothing, so a real domain silently degrades to the 23-name fallback).

This module reads the SAME field names **statically from source** with ast-grep
(tree-sitter): no import, no execution, and it works even when the module could never
be imported here. The extracted names are *declared* facts (literally in the source),
which is exactly what a vocabulary is.

Optional dependency (``pip install dreplay[ast-grep]`` → ``ast-grep-py``). When it is
absent, :func:`available` returns False and :mod:`dreplay.vocabulary` falls back to the
import-based path — the release gate never depends on it (principle #7: honest
fallback, never a faked result).

Recognized field shapes (Python):
  * annotated fields — ``name: type`` / ``name: type = default`` (Pydantic v1/v2,
    dataclasses, attrs-with-annotation, TypedDict, SQLAlchemy ``Mapped[...]``);
  * ORM/model assignments — ``name = Column(...)`` / ``models.XField(...)`` /
    ``attr.ib(...)`` / ``relationship(...)`` / ``field(...)`` (RHS is a known field
    constructor — a bare ``name = 3`` class constant or ``logger = getLogger()`` is
    NOT a field and is skipped);
  * ``__slots__`` string members;
  * plain-class ``__init__`` parameters (last resort, ≤12, mirrors the import path).
"""
from __future__ import annotations

import os
import re

# Callee (last dotted component) of an assignment RHS that marks the target a model
# field. `models.CharField` → `CharField` (endswith Field); `attr.ib` → `ib`; etc.
_FIELD_CTORS = frozenset({
    "Column", "mapped_column", "relationship", "deferred", "composite", "synonym",
    "field", "ib", "attrib", "ForeignKey", "association_proxy",
})

_PYCACHE_SKIP = ("__pycache__", "site-packages", "dist-packages", ".git", ".tox",
                 ".venv", "node_modules")


def available() -> bool:
    """True iff the optional ``ast-grep-py`` binding is importable."""
    try:
        import ast_grep_py  # noqa: F401
        return True
    except Exception:  # noqa: BLE001 — any import failure = unavailable, degrade honestly
        return False


def _is_field_call(callee: str) -> bool:
    last = callee.rsplit(".", 1)[-1]
    return last.endswith("Field") or last in _FIELD_CTORS


def _param_name(node) -> str | None:
    """The bound name of a function parameter node, or None for splats/self/cls."""
    k = node.kind()
    if k == "identifier":
        name = node.text()
    elif k in ("default_parameter", "typed_parameter", "typed_default_parameter"):
        # `x=1` / `x: int` / `x: int = 1` — the name is the leading identifier child.
        ident = next((c for c in node.children() if c.kind() == "identifier"), None)
        name = ident.text() if ident else None
    else:  # list_splat_pattern (*args), dictionary_splat_pattern (**kw), punctuation
        return None
    if not name or name in ("self", "cls") or name.startswith("_"):
        return None
    return name


def _strip_str(lit: str) -> str:
    return lit.strip().strip("'\"")


def fields_in_source(source: str) -> tuple[set[str], int]:
    """Extract ``(field_names, model_class_count)`` from one Python source string.

    Pure and side-effect-free (parses text; never imports). ``model_class_count`` is
    the number of classes that yielded at least one field — the same diagnostic the
    import path reports, for mode transparency."""
    from ast_grep_py import SgRoot

    try:
        root = SgRoot(source, "python").root()
    except Exception:  # noqa: BLE001 — a parse failure is a skip, never a raise
        return set(), 0

    all_fields: set[str] = set()
    model_count = 0
    for cls in root.find_all(kind="class_definition"):
        body = cls.field("body")
        if body is None:
            continue
        fields: set[str] = set()
        init_params: list[str] = []
        for stmt in body.children():
            kind = stmt.kind()
            if kind == "function_definition":
                nm = stmt.field("name")
                if nm is not None and nm.text() == "__init__":
                    params = stmt.field("parameters")
                    if params is not None:
                        for p in params.children():
                            pn = _param_name(p)
                            if pn:
                                init_params.append(pn)
                continue
            if kind != "expression_statement":
                continue
            for assign in stmt.children():
                if assign.kind() != "assignment":
                    continue
                left = assign.field("left")
                if left is None or left.kind() != "identifier":
                    continue
                name = left.text()
                if name == "__slots__":
                    for s in assign.find_all(kind="string"):
                        val = _strip_str(s.text())
                        if val and not val.startswith("_"):
                            fields.add(val)
                    continue
                if name.startswith("_"):
                    continue
                annotated = assign.field("type") is not None
                if annotated:
                    ann = assign.field("type")
                    # ClassVar is not an instance field (Pydantic/dataclass exclude it).
                    if ann is not None and ann.text().lstrip().startswith("ClassVar"):
                        continue
                    fields.add(name)
                    continue
                # plain assignment: a field only if the RHS is a known field ctor
                right = assign.field("right")
                if right is not None and right.kind() == "call":
                    fn = right.field("function")
                    if fn is not None and _is_field_call(fn.text()):
                        fields.add(name)
        if not fields and 0 < len(init_params) <= 12:
            fields.update(init_params)  # last-resort plain-class shape
        if fields:
            model_count += 1
            all_fields |= fields
    return {f for f in all_fields if f and not f.startswith("_")}, model_count


def _iter_py_files(python_path: list[str], max_files: int):
    seen = 0
    for base in python_path:
        if not base or not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames
                           if d not in _PYCACHE_SKIP and not d.startswith(".")]
            for fn in filenames:
                if not fn.endswith(".py") or fn == "setup.py":
                    continue
                if seen >= max_files:
                    return
                seen += 1
                yield os.path.join(dirpath, fn)


def derive_python_vocabulary_static(python_path: list[str], max_files: int = 400):
    """Static Python vocabulary: parse .py files under ``python_path``, extract model
    field names WITHOUT importing anything. Returns a
    :class:`dreplay.vocabulary.VocabularyResult` (``extractor="ast_static"``)."""
    from .vocabulary import VocabularyResult

    vocab: set[str] = set()
    files_scanned = 0
    files_parsed = 0
    models = 0
    errors: list[str] = []
    for path in _iter_py_files(python_path, max_files):
        files_scanned += 1
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                source = fh.read()
        except OSError as exc:
            if len(errors) < 5:
                errors.append(f"{type(exc).__name__}: {str(exc)[:80]}")
            continue
        files_parsed += 1
        fields, model_count = fields_in_source(source)
        vocab |= fields
        models += model_count

    return VocabularyResult(
        fields={f for f in vocab if f and not f.startswith("_")},
        modules_scanned=files_scanned,
        modules_imported=files_parsed,
        models_found=models,
        import_errors=tuple(errors),
        extractor="ast_static",
    )
