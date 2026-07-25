"""Tests for caching module."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Dict, List

from scope.engine.cache import (
    _symbols_to_dict,
    _symbols_from_dict,
    cache_dir,
    cache_file,
    files_signature,
)
from scope.models import Symbol


def test_symbols_to_dict_roundtrip():
    """Symbol dict → JSON dict → Symbol dict should preserve data."""
    symbols: Dict[str, List[Symbol]] = {
        "src/main.py": [
            Symbol(name="main", kind="function", file="src/main.py", line=10),
            Symbol(name="App", kind="class", file="src/main.py", line=42, ref_count=3, importance=5.0),
        ],
        "src/utils.py": [
            Symbol(name="helper", kind="function", file="src/utils.py", line=5),
        ],
    }

    # Convert to dict
    as_dict = _symbols_to_dict(symbols)
    assert "src/main.py" in as_dict
    assert len(as_dict["src/main.py"]) == 2

    # Convert back
    restored = _symbols_from_dict(as_dict)
    assert "src/main.py" in restored
    assert restored["src/main.py"][0].name == "main"
    assert restored["src/main.py"][0].kind == "function"
    assert restored["src/main.py"][0].line == 10
    assert restored["src/main.py"][1].importance == 5.0
    assert restored["src/main.py"][1].ref_count == 3


def test_cache_dir_uses_git():
    """cache_dir should return .git subdirectory when .git exists."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        (repo / ".git").mkdir()
        result = cache_dir(str(repo))
        assert result == repo / ".git"


def test_files_signature_consistency():
    """Same files should produce the same signature."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        # Init a git repo so git_head returns something
        import subprocess
        subprocess.run(["git", "init"], cwd=repo, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@test"], cwd=repo, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True)

        (repo / "a.py").write_text("x = 1")
        (repo / "b.py").write_text("y = 2")
        subprocess.run(["git", "add", "."], cwd=repo, capture_output=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=repo, capture_output=True)

        files = ["a.py", "b.py"]
        sig1 = files_signature(str(repo), files)
        sig2 = files_signature(str(repo), files)
        assert sig1 == sig2
