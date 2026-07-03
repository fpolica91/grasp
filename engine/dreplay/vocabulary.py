"""Schema-derived business vocabulary — the structural fix for name-based guessing.

The business objects ARE the things the app declares in its data models (Pydantic,
dataclasses, attrs, SQLAlchemy, Django, TypedDict). Their field names ARE the domain
vocabulary. So instead of heuristically guessing "business-meaningful" from names
(allowlist OR denylist — both a perpetual guessing game on unseen domains), we read
the vocabulary from the repo's OWN model declarations: a traced call binding a
vocabulary field is business-meaningful by construction.

Best-effort: modules that fail to import (missing deps, side effects, Django settings)
are skipped — never raises. If the repo exposes no importable models, the vocabulary
is empty and the classifier falls back to the name-based denylist (graceful degrade).
"""
from __future__ import annotations

import importlib
import inspect
import os
import pkgutil
from dataclasses import dataclass, field
from types import ModuleType


@dataclass(frozen=True)
class VocabularyResult:
    """What happened during vocabulary derivation — for mode transparency.

    Without this, a vocab=0 silent degrade looks identical to a clean run (the
    false-negative-disguised-as-clean risk). Every run prints mode + vocab_size +
    fallback_reason so the reviewer knows whether they're seeing the schema-derived
    classifier (the real product) or the 23-name conservative fallback.
    """

    fields: set[str]
    modules_scanned: int
    modules_imported: int
    models_found: int
    import_errors: tuple[str, ...] = ()
    # Which mechanism produced this vocabulary: "ast_static" (ast-grep, no code
    # executed — the safe default when the binding is installed) or "import"
    # (legacy: imports+introspects, executing repo code). Mode transparency: a
    # reviewer can tell whether the vocab was read from source or from a live import.
    extractor: str = "import"

    @property
    def mode(self) -> str:
        return "vocab" if self.fields else "non_vocab"

    @property
    def fallback_reason(self) -> str | None:
        if self.fields:
            return None
        unit = "files parsed" if self.extractor == "ast_static" else "imported modules"
        verb = "parsed" if self.extractor == "ast_static" else "imported"
        if self.modules_scanned == 0:
            return "no target source files found to scan"
        if self.modules_imported == 0:
            errs = "; ".join(self.import_errors[:3]) if self.import_errors else "unknown"
            return f"0/{self.modules_scanned} {verb} ({errs})"
        if self.models_found == 0:
            return (f"no model declarations found in {self.modules_imported} {unit} "
                    f"(repo may use plain classes/dicts)")
        return None


def derive_vocabulary_detailed(python_path: list[str], max_modules: int = 400) -> VocabularyResult:
    """Scan + derive, returning diagnostic info alongside the vocabulary.

    Prefers the SAFE static extractor (ast-grep, no code executed) when the optional
    ``ast-grep-py`` binding is installed; otherwise falls back to the legacy
    import+introspect path. The static path never runs the repo's code, works even
    when a module can't be imported here, and is what the product should use by
    default — see :mod:`dreplay.ast_vocab`."""
    from . import ast_vocab
    if ast_vocab.available():
        return ast_vocab.derive_python_vocabulary_static(python_path, max_files=max_modules)
    return _derive_vocabulary_by_import(python_path, max_modules)


def _derive_vocabulary_by_import(python_path: list[str], max_modules: int = 400) -> VocabularyResult:
    """Legacy fallback: import each module and introspect its model classes. EXECUTES
    the repo's top-level code — used only when ast-grep-py is unavailable."""
    import sys

    for p in python_path:
        if p and p not in sys.path:
            sys.path.insert(0, p)

    vocab: set[str] = set()
    scanned: set[str] = set()
    imported = 0
    models = 0
    errors: list[str] = []
    for base in python_path:
        if not base or not os.path.isdir(base):
            continue
        for _finder, modname, _ispkg in pkgutil.walk_packages([base], onerror=lambda _e: None):
            if len(scanned) >= max_modules:
                break
            # Install/test SCRIPTS, not model declarations — importing setup.py
            # EXECUTES setuptools.setup() (no __main__ guard by convention).
            if modname.rsplit(".", 1)[-1] in ("setup", "conftest"):
                continue
            scanned.add(modname)
            try:
                mod = importlib.import_module(modname)
            except BaseException as exc:  # noqa: BLE001 — catches SystemExit too
                if len(errors) < 5:
                    msg = str(exc)[:120]
                    errors.append(f"{type(exc).__name__}: {msg}" if msg else type(exc).__name__)
                continue
            imported += 1
            fields_found, model_count = _model_fields_in_module(mod, scanned)
            vocab |= fields_found
            models += model_count

    return VocabularyResult(
        fields=vocab,
        modules_scanned=len(scanned),
        modules_imported=imported,
        models_found=models,
        import_errors=tuple(errors),
    )


def derive_vocabulary(python_path: list[str], max_modules: int = 400) -> set[str]:
    """Back-compat wrapper — returns just the field set."""
    return derive_vocabulary_detailed(python_path, max_modules).fields


def _model_fields_in_module(mod: ModuleType, repo_modules: set[str]) -> tuple[set[str], int]:
    """Field names + count of model CLASSES DEFINED IN THIS MODULE."""
    fields: set[str] = set()
    model_count = 0
    try:
        members = inspect.getmembers(mod, inspect.isclass)
    except Exception:  # noqa: BLE001
        return fields, 0
    for _name, cls in members:
        if getattr(cls, "__module__", "") not in repo_modules and \
           getattr(cls, "__module__", "") != getattr(mod, "__name__", ""):
            continue
        cls_fields = _extract_fields(cls)
        if cls_fields:
            model_count += 1
        fields |= cls_fields
    return ({f for f in fields if f and not f.startswith("_")}, model_count)


def _extract_fields(cls: type) -> set[str]:
    """Field names from one model class, across the frameworks it might use."""
    fields: set[str] = set()

    # Pydantic v2
    mf = getattr(cls, "model_fields", None)
    if isinstance(mf, dict):
        fields.update(mf.keys())
    # Pydantic v1
    f1 = getattr(cls, "__fields__", None)
    if isinstance(f1, dict):
        fields.update(f1.keys())

    # dataclasses
    dcf = getattr(cls, "__dataclass_fields__", None)
    if isinstance(dcf, dict):
        fields.update(dcf.keys())

    # attrs
    attrs = getattr(cls, "__attrs_attrs__", None)
    if attrs:
        try:
            fields.update(a.name for a in attrs)
        except Exception:  # noqa: BLE001
            pass

    # SQLAlchemy declarative
    table = getattr(cls, "__table__", None)
    if table is not None and hasattr(table, "columns"):
        try:
            fields.update(c.name for c in table.columns)
        except Exception:  # noqa: BLE001
            pass

    # Django models
    meta = getattr(cls, "_meta", None)
    if meta is not None and hasattr(meta, "get_fields"):
        try:
            for f in meta.get_fields():
                if getattr(f, "concrete", False) and getattr(f, "name", None):
                    fields.add(f.name)
        except Exception:  # noqa: BLE001 — Django needs configured settings sometimes
            pass

    # TypedDict (PEP 585 / typing_extensions)
    if hasattr(cls, "__total__") and hasattr(cls, "__annotations__"):
        try:
            fields.update(cls.__annotations__.keys())
        except Exception:  # noqa: BLE001
            pass

    # __slots__ classes — hand-rolled value objects (Money, TaxedMoney, etc.) that
    # aren't dataclass/attrs/pydantic but declare their fields via __slots__. Walk
    # the MRO to collect inherited slots too.
    for klass in getattr(cls, "__mro__", (cls,)):
        slots = getattr(klass, "__slots__", None)
        if not slots:
            continue
        if isinstance(slots, str):
            slots = (slots,)
        try:
            fields.update(s for s in slots if isinstance(s, str) and not s.startswith("__"))
        except Exception:  # noqa: BLE001
            pass

    # Plain classes (no model marker, no __slots__): extract __init__ params as a
    # last resort. Conservative: only positional-or-keyword params, not self/cls,
    # not private, ≤12 total (framework classes have many; business objects have few).
    # This catches infra code like `class Allocation: def __init__(self, gpu_count,
    # memory_gb, cpu_cores): ...` — the reviewer's "the one that will bite on your repos."
    if not fields:
        try:
            sig = inspect.signature(cls.__init__)
            params = [p for p in sig.parameters.values()
                      if p.kind == inspect.Parameter.POSITIONAL_OR_KEYWORD
                      and p.name not in ("self", "cls")
                      and not p.name.startswith("_")]
            if 0 < len(params) <= 12:
                fields.update(p.name for p in params)
        except Exception:  # noqa: BLE001 — many builtins/frameworks have exotic __init__
            pass

    return fields
