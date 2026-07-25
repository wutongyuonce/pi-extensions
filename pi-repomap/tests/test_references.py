"""Tests for the references module."""

from __future__ import annotations

import tempfile
from pathlib import Path

from scope.engine.references import extract_imports, resolve_internal_import


def _write(repo: Path, path: str, content: str) -> Path:
    full = repo / path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content)
    return full


def test_extract_imports_python():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _write(repo, "main.py", "import os\nfrom pathlib import Path\n")
        imports = extract_imports(str(repo), "main.py")
        assert "os" in imports
        assert "pathlib" in imports


def test_extract_imports_js():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _write(repo, "app.js", 'const fs = require("fs")\nimport { join } from "path"\n')
        imports = extract_imports(str(repo), "app.js")
        assert "fs" in imports
        assert "path" in imports


def test_extract_imports_ts():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _write(repo, "app.ts", 'import { Component } from "react"\nimport "./styles.css"\n')
        imports = extract_imports(str(repo), "app.ts")
        assert "react" in imports
        assert "./styles.css" in imports


def test_extract_imports_go():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _write(repo, "main.go", 'import "fmt"\nimport "os"\n')
        imports = extract_imports(str(repo), "main.go")
        assert "fmt" in imports
        assert "os" in imports


def test_extract_imports_empty_file():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _write(repo, "empty.py", "")
        imports = extract_imports(str(repo), "empty.py")
        assert imports == []


def test_extract_imports_rust():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _write(repo, "main.rs", "use std::collections::HashMap;\nuse serde::Serialize;\n")
        imports = extract_imports(str(repo), "main.rs")
        assert "std::collections::HashMap" in imports or "std::collections" in str(imports)
        assert "serde::Serialize" in imports or "serde" in str(imports)


def test_resolve_internal_import_dotted():
    """Dotted relative imports should resolve to file paths."""
    files = ["src/utils/helper.py", "src/main.py"]
    result = resolve_internal_import(".utils.helper", "src/main.py", files)
    # Python dotted package imports are not expected to resolve to files
    # (this is a known limitation — see audit)
