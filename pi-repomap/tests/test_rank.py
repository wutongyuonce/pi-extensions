"""Tests for the ranking module."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Dict, List

from scope.engine.rank import build_symbol_index, compute_importance, suggested_reads
from scope.models import Symbol


def _make_symbol(name: str, kind: str, file: str, line: int) -> Symbol:
    return Symbol(name=name, kind=kind, file=file, line=line)


def test_build_symbol_index():
    symbols: Dict[str, List[Symbol]] = {
        "a.py": [_make_symbol("foo", "function", "a.py", 1)],
        "b.py": [_make_symbol("bar", "function", "b.py", 1)],
    }
    index = build_symbol_index(symbols)
    assert "foo" in index
    assert "bar" in index
    assert len(index["foo"]) == 1
    assert index["foo"][0].file == "a.py"


def test_compute_importance_basic():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)

        # File a defines foo, file b references foo
        (repo / "a.py").write_text("def foo(): pass\n")
        (repo / "b.py").write_text("foo()\n")

        symbols: Dict[str, List[Symbol]] = {
            "a.py": [_make_symbol("foo", "function", "a.py", 1)],
            "b.py": [],
        }

        compute_importance(symbols, str(repo))
        # foo should have ref_count=1 since b.py references it
        assert symbols["a.py"][0].importance > 0
        assert symbols["a.py"][0].ref_count == 1


def test_compute_importance_no_references():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "orphan.py").write_text("def orphan(): pass\n")

        symbols: Dict[str, List[Symbol]] = {
            "orphan.py": [_make_symbol("orphan", "function", "orphan.py", 1)],
        }

        compute_importance(symbols, str(repo))
        assert symbols["orphan.py"][0].importance == 0.0


def test_suggested_reads():
    symbols: Dict[str, List[Symbol]] = {
        "a.py": [
            _make_symbol("foo", "function", "a.py", 1),
            _make_symbol("bar", "function", "a.py", 5),
        ],
        "b.py": [
            _make_symbol("baz", "function", "b.py", 1),
        ],
    }
    # Manually set importance
    symbols["a.py"][0].importance = 10.0
    symbols["a.py"][1].importance = 5.0
    symbols["b.py"][0].importance = 2.0

    files = ["a.py", "b.py"]
    reads = suggested_reads(symbols, files, limit=2)
    assert reads[0] == "a.py"  # total importance 15
    assert reads[1] == "b.py"  # total importance 2
