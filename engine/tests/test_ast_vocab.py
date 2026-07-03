"""Static (ast-grep) vocabulary extraction — dreplay/ast_vocab.py.

The headline property is SAFETY: the vocabulary is read from source with tree-sitter,
so the repo's code is NEVER executed (the import-based path runs top-level module code
in the host — observation 844). These tests pin no-execution + field coverage +
precision, and the fallback wiring. They skip when the optional binding is absent so
the release gate never depends on it.
"""
from __future__ import annotations

import os

import pytest

from dreplay import ast_vocab
from dreplay.vocabulary import (
    VocabularyResult,
    _derive_vocabulary_by_import,
    derive_vocabulary_detailed,
)

pytestmark = pytest.mark.skipif(
    not ast_vocab.available(), reason="ast-grep-py not installed (optional extra)"
)


# ---- the headline: no repo code is executed -----------------------------------
def test_static_extraction_does_not_execute_repo_code(tmp_path):
    marker = tmp_path / "SIDE_EFFECT_FIRED"
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "models.py").write_text(
        f"open({str(marker)!r}, 'w').write('x')  # top-level side effect\n"
        "from dataclasses import dataclass\n"
        "@dataclass\n"
        "class Invoice:\n"
        "    invoice_number: str\n"
        "    amount_due: float\n"
    )
    result = ast_vocab.derive_python_vocabulary_static([str(tmp_path)])
    assert not marker.exists(), "static extraction MUST NOT execute the module's code"
    assert {"invoice_number", "amount_due"} <= result.fields
    assert result.extractor == "ast_static"

    # Contrast: the import path DOES fire the side effect (documents the hazard).
    marker.unlink(missing_ok=True)
    _derive_vocabulary_by_import([str(tmp_path)])
    assert marker.exists(), "import path executes top-level code (the risk static removes)"


def test_static_extracts_where_import_would_fail(tmp_path):
    """A module that raises on import contributes 0 fields via the import path, but
    its declared fields are still read statically (the false-negative fix)."""
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "models.py").write_text(
        "import a_dependency_that_is_not_installed_xyz  # ImportError at import time\n"
        "from dataclasses import dataclass\n"
        "@dataclass\n"
        "class Account:\n"
        "    account_id: str\n"
        "    balance: float\n"
    )
    static = ast_vocab.derive_python_vocabulary_static([str(tmp_path)])
    assert {"account_id", "balance"} <= static.fields, "static reads fields despite unimportable module"
    imp = _derive_vocabulary_by_import([str(tmp_path)])
    assert not ({"account_id", "balance"} <= imp.fields), "import path yields nothing here (the gap)"


# ---- field-shape coverage (pure, source-only) ---------------------------------
def test_fields_in_source_covers_framework_shapes():
    src = '''
from pydantic import BaseModel
from sqlalchemy import Column, String
from django.db import models
import attr

class Order(BaseModel):
    owner_id: int
    status: str = "active"

class UserRow(Base):
    __tablename__ = "users"
    email = Column(String)
    full_name = Column(String)

class Product(models.Model):
    title = models.CharField(max_length=100)
    price = models.DecimalField()
    supplier = models.ForeignKey("Supplier")

@attr.s
class Point:
    x = attr.ib()
    y = attr.ib()

class Money:
    __slots__ = ("amount", "currency")

class Allocation:
    def __init__(self, gpu_count, memory_gb, cpu_cores):
        pass
'''
    fields, models_found = ast_vocab.fields_in_source(src)
    assert {"owner_id", "status"} <= fields                       # pydantic annotated
    assert {"email", "full_name"} <= fields                       # sqlalchemy Column
    assert {"title", "price", "supplier"} <= fields               # django *Field/ForeignKey
    assert {"x", "y"} <= fields                                   # attrs attr.ib
    assert {"amount", "currency"} <= fields                       # __slots__
    assert {"gpu_count", "memory_gb", "cpu_cores"} <= fields      # plain __init__
    assert models_found >= 6


def test_fields_in_source_precision_skips_constants_and_dunders():
    """A class constant, a plain-literal assign, a logger, and dunders must NOT be
    captured — only real fields. (Over-capture here would flood the default view.)"""
    src = '''
class Config:
    DEFAULT_TZ = "UTC"                 # class constant — not a field
    max_retries = 3                    # plain literal — not a field
    logger = get_logger(__name__)      # a call, but not a field constructor
    __tablename__ = "cfg"              # dunder
    api_key: str                       # annotated field — IS captured
'''
    fields, _ = ast_vocab.fields_in_source(src)
    assert "api_key" in fields
    assert "DEFAULT_TZ" not in fields
    assert "max_retries" not in fields
    assert "logger" not in fields
    assert "__tablename__" not in fields


def test_classvar_is_not_a_field():
    src = (
        "from typing import ClassVar\n"
        "class M:\n"
        "    registry: ClassVar[dict] = {}\n"
        "    name: str\n"
    )
    fields, _ = ast_vocab.fields_in_source(src)
    assert "name" in fields
    assert "registry" not in fields, "ClassVar is not an instance field"


def test_init_params_only_as_last_resort(tmp_path):
    """A class with real declared fields should NOT also pull in __init__ params."""
    src = (
        "from dataclasses import dataclass\n"
        "@dataclass\n"
        "class Order:\n"
        "    total: float\n"
        "    def __init__(self, total, _internal_cache):\n"
        "        self.total = total\n"
    )
    fields, _ = ast_vocab.fields_in_source(src)
    assert "total" in fields
    assert "_internal_cache" not in fields, "declared fields present → __init__ not used"


def test_malformed_source_is_skipped_not_raised():
    fields, models = ast_vocab.fields_in_source("class Broken(:\n  this is not python !!!")
    assert isinstance(fields, set)  # never raises — a parse failure is a skip


# ---- wiring: detailed derive prefers static, threads the extractor tag --------
def test_derive_vocabulary_detailed_uses_static_when_available(tmp_path):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "m.py").write_text(
        "from dataclasses import dataclass\n@dataclass\nclass X:\n    field_a: int\n    field_b: str\n"
    )
    result = derive_vocabulary_detailed([str(tmp_path)])
    assert isinstance(result, VocabularyResult)
    assert result.extractor == "ast_static"
    assert {"field_a", "field_b"} <= result.fields
    assert result.mode == "vocab"


def test_empty_repo_reports_honest_non_vocab_reason(tmp_path):
    (tmp_path / "plain.py").write_text("def f(x):\n    return x + 1\n")
    result = derive_vocabulary_detailed([str(tmp_path)])
    assert result.mode == "non_vocab"
    assert result.fallback_reason and "files parsed" in result.fallback_reason
