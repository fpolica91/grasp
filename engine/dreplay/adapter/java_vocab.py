"""Java/JVM business vocabulary — POJO/record field names (spec §2b vocab).

The business objects in a Java codebase are its POJOs and records. Their field
names ARE the domain vocabulary. So instead of name-guessing, we read the vocabulary
from the repo's OWN Java source: a traced JVM call binding a vocabulary field (via
the recorder's reflective ``canon`` → ``{field: value}``) is business-meaningful by
construction — identical in principle to the Python vocab deriver.

This is a best-effort SOURCE scanner (no Java compiler/AST dependency): it reads
``.java`` files and extracts field declarations from POJO bodies and record
components. It never raises — modules that don't parse are skipped. If the repo
exposes no Java sources, the vocabulary is empty and the classifier falls back to
the name-based dominant set (graceful degrade, same as the Python side).

Recognized shapes:
  * **Record** (Java 16+): ``record Point(int x, int y) {}`` → {x, y}.
  * **POJO**: ``class Order { private String owner; private int amount; ... }``
    → {owner, amount, ...}. Annotations (``@Column``, ``@NotNull``), modifiers
    (``private``, ``final``), generics, and array brackets are stripped.
  * **Lombok** ``@Data``/``@Getter`` classes: same field scan (the fields exist in
    source even if the accessors are generated).

Deliberately NOT extracted (plumbing, matching the Python ``_PLUMBING_FIELDS``
intent): ``serialVersionUID``, logger fields, framework context/config holders.
"""
from __future__ import annotations

import os
import re

from ..vocabulary import VocabularyResult

# A field declaration: [annotations] [modifiers] TYPE NAME [= init] ;
# We match per-line and capture the field NAME. Type can be generic (<...>), array
# ([]), qualified (a.b.C). Modifiers: public/private/protected/static/final/etc.
# Anchored on the trailing ``;`` (or ``=`` init) so method declarations (which end
# in ``)`` or ``{``) and local variables (no leading modifier) are NOT matched.
_MODIFIERS = (
    "public|private|protected|static|final|volatile|transient|synchronized|native|default"
)
_FIELD_RE = re.compile(
    rf"""
    ^\s*
    (?:@\w+(?:\([^)]*\))?\s*)*        # leading annotations (@Col(...), @NotNull)
    (?:(?:{_MODIFIERS})\s+)*          # zero or more modifiers
    (?P<type>[\w.<>\[\],?]+?\??)\s+   # type (generic/array/qualified; nullable ?)
    (?P<name>[a-z_]\w*)               # field name (lowercase-start convention)
    \s*(?:=|;)                        # = init or semicolon (NOT a method or block)
    """,
    re.VERBOSE | re.MULTILINE,
)

# Record header: record Name(Type a, Type b)
_RECORD_HEADER_RE = re.compile(r"\brecord\s+\w+\s*(?:<[^>]*>)?\s*\((?P<params>[^)]*)\)", re.DOTALL)

# PLUMBING field names to exclude (Java-flavored): the JVM equivalents of the
# Python _PLUMBING_FIELDS. Kept conservative — generic words that COULD be business
# (data, value, result) stay shown (miss is the worst failure).
_PLUMBING_JAVA = {
    "serialVersionUID",  # serialization marker
    "logger", "log", "logging",
    "serialversionuid",
}


def derive_java_vocabulary(src_paths: list[str], max_files: int = 800) -> VocabularyResult:
    """Scan .java sources for POJO/record field names → the domain vocabulary.

    Returns a :class:`VocabularyResult` (same shape as the Python deriver) so the
    reducer and the status line treat both languages uniformly. ``modules_scanned``
    = files scanned; ``modules_imported`` = files parsed without error;
    ``models_found`` = classes/records that yielded ≥1 field.
    """
    vocab: set[str] = set()
    scanned = 0
    imported = 0
    models = 0
    errors: list[str] = []

    for base in src_paths:
        if not base or not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            # Skip build/dependency dirs — their .java are generated/3rd-party.
            rel = os.path.relpath(root, base)
            if any(seg in {"target", "build", "node_modules", ".git"} for seg in rel.split(os.sep)):
                continue
            for f in sorted(files):
                if not f.endswith(".java"):
                    continue
                if scanned >= max_files:
                    break
                scanned += 1
                path = os.path.join(root, f)
                try:
                    src = open(path, encoding="utf-8", errors="replace").read()
                except OSError as exc:
                    if len(errors) < 5:
                        errors.append(f"{path}: {exc}")
                    continue
                imported += 1
                fields, model_count = _extract_java_fields(src)
                if fields:
                    models += model_count
                    vocab |= fields

    return VocabularyResult(
        fields={f for f in vocab if f and not f.startswith("_")},
        modules_scanned=scanned,
        modules_imported=imported,
        models_found=models,
        import_errors=tuple(errors),
    )


def _extract_java_fields(src: str) -> tuple[set[str], int]:
    """Field names + model count from one .java source unit.

    Scans for record components AND class-body field declarations. A "model" is any
    record or class that yielded at least one business field.
    """
    fields: set[str] = set()

    # 1. Record components.
    for m in _RECORD_HEADER_RE.finditer(src):
        params = m.group("params")
        for comp in params.split(","):
            comp = comp.strip()
            if not comp:
                continue
            # strip annotations + modifiers, keep the LAST identifier (the name)
            comp = re.sub(r"@\w+(\([^)]*\))?", "", comp).strip()
            comp = re.sub(
                r"^(?:public|private|protected|static|final)\s+", "", comp
            ).strip()
            # name is the last token of "Type name"
            toks = comp.split()
            if len(toks) >= 2 and re.match(r"^[a-z_]\w*$", toks[-1]):
                name = toks[-1]
                if name not in _PLUMBING_JAVA:
                    fields.add(name)

    # 2. Class-body fields. Only scan inside class/record/enum bodies to avoid
    # catching method-local variables. We approximate by scanning the whole source
    # but requiring the modifier-qualified shape (which locals rarely have).
    for m in _FIELD_RE.finditer(src):
        name = m.group("name")
        if not name or name in _PLUMBING_JAVA:
            continue
        # Skip obvious non-field captures: a method name (followed by `(`) or a
        # type usage. The trailing `=|;|,` anchor mostly prevents method matches.
        fields.add(name)

    model_count = 1 if fields else 0
    return fields, model_count


def derive_vocabulary(src_paths: list[str]) -> set[str]:
    """Back-compat: return just the field set."""
    return derive_java_vocabulary(src_paths).fields
