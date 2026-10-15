"""Tests for the file discovery module."""

from __future__ import annotations

import tempfile
from pathlib import Path

from scope.engine.discover import (
    _EXT_TO_LANG,
    is_test_file,
    is_config_or_entrypoint,
    language_stats,
    normalize_scope,
    pair_tests,
    prioritize_files,
)


def test_normalize_scope():
    assert normalize_scope(".") == "."
    assert normalize_scope("") == "."
    assert normalize_scope("src") == "src"
    assert normalize_scope("/src") == "src"
    assert normalize_scope("src/") == "src"
    assert normalize_scope("src/api") == "src/api"


def test_is_test_file():
    assert is_test_file("tests/test_foo.py")
    assert is_test_file("src/foo/test_bar.py")
    assert is_test_file("foo.test.ts")
    assert is_test_file("bar.spec.js")
    assert is_test_file("test_main.go")
    assert is_test_file("foo_test.go")
    assert is_test_file("foo/tests/bar.py")
    assert is_test_file("/project/tests/test_a.py")
    assert not is_test_file("src/main.py")
    assert not is_test_file("src/utils/helper.ts")


def test_is_config_or_entrypoint():
    assert is_config_or_entrypoint("package.json")
    assert is_config_or_entrypoint("pyproject.toml")
    assert is_config_or_entrypoint("Makefile")
    assert is_config_or_entrypoint("src/main.py")
    assert is_config_or_entrypoint("app.ts")
    assert is_config_or_entrypoint("Dockerfile")
    assert not is_config_or_entrypoint("src/utils/helper.py")


def test_prioritize_files():
    files = [
        "tests/test_main.py",
        "src/main.py",
        "src/utils/helper.py",
        "README.md",
        "node_modules/pkg/index.js",
    ]
    prioritized = prioritize_files(files)
    # src/main.py should be first or early (entrypoint + src prefix)
    assert prioritized.index("src/main.py") < prioritized.index("node_modules/pkg/index.js")
    # test file should not be first
    assert prioritized[0] != "tests/test_main.py"


def test_language_stats():
    files = [
        "a.py",
        "b.py",
        "c.js",
        "d.ts",
        "e.go",
        "f.rs",
    ]
    stats = language_stats(files)
    assert stats["python"] == 2
    assert stats["javascript"] == 1
    assert stats["typescript"] == 1
    assert stats["go"] == 1
    assert stats["rust"] == 1


def test_language_stats_unknown_extension():
    files = ["foo.xyz", "bar.abc"]
    stats = language_stats(files)
    assert stats.get("other") == 2


def test_pair_tests_basic():
    files = [
        "src/main.py",
        "src/utils/helper.py",
        "tests/test_main.py",
        "tests/test_helper.py",
    ]
    pairs = pair_tests(files)
    assert "src/main.py" in pairs
    assert "src/utils/helper.py" in pairs
    # each source should have at least one test
    assert len(pairs["src/main.py"]) >= 1
    assert len(pairs["src/utils/helper.py"]) >= 1


def test_pair_tests_no_matches():
    files = ["src/main.py", "src/worker.js"]
    pairs = pair_tests(files)
    assert pairs == {}


def test_ext_to_lang_constant():
    """_EXT_TO_LANG should have all supported extensions."""
    assert _EXT_TO_LANG[".py"] == "python"
    assert _EXT_TO_LANG[".js"] == "javascript"
    assert _EXT_TO_LANG[".rs"] == "rust"
    assert _EXT_TO_LANG[".tf"] == "hcl"
    assert ".txt" not in _EXT_TO_LANG
