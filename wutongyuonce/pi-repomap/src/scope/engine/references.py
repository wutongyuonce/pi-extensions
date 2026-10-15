from __future__ import annotations

import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set

from scope.engine._utils import read_text
from scope.engine.discover import SUPPORTED_EXTENSIONS

IMPORT_RE = re.compile(r"(?:from\s+([\w\.\/\-@]+)\s+import|import\s+([\w\.\/\-@]+)|require\(['\"]([^'\"]+)['\"]\)|use\s+([\w:]+))")
FROM_STRING_RE = re.compile(r"\bfrom\s+['\"]([^'\"]+)['\"]")
SIDE_EFFECT_IMPORT_RE = re.compile(r"^import\s+['\"]([^'\"]+)['\"]")


def extract_imports(repo_path: str, rel_path: str) -> List[str]:
    text = read_text(repo_path, rel_path)
    if not text:
        return []
    ext = Path(rel_path).suffix
    imports: Set[str] = set()
    for line in text.splitlines()[:2000]:
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "//", "*")):
            continue
        if ext in (".js", ".ts", ".tsx"):
            match = FROM_STRING_RE.search(stripped) or SIDE_EFFECT_IMPORT_RE.search(stripped)
            if match:
                imports.add(match.group(1))
            require = re.search(r"require\(['\"]([^'\"]+)['\"]\)", stripped)
            if require:
                imports.add(require.group(1))
            continue
        if ext == ".py" and not stripped.startswith(("import ", "from ")):
            continue
        if ext == ".rs" and not stripped.startswith("use "):
            continue
        if ext == ".go":
            if not (stripped.startswith("import ") or stripped.startswith('"')):
                continue
            # Handle `import "fmt"` style
            go_match = re.match(r'import\s+"([^"]+)"', stripped)
            if go_match:
                imports.add(go_match.group(1))
                continue
            # For grouped imports `"fmt"` on its own line
            if stripped.startswith('"') and stripped.endswith('"'):
                imports.add(stripped.strip('"'))
                continue
        for match in IMPORT_RE.finditer(stripped):
            target = next((g for g in match.groups() if g), "")
            if target:
                imports.add(target)
    return sorted(imports)


def resolve_internal_import(import_name: str, importer: str, files: List[str]) -> Optional[str]:
    file_set = set(files)
    candidates: List[str] = []
    if import_name.startswith("."):
        base = Path(importer).parent / import_name
        candidates.extend(str(base.with_suffix(ext)).replace("\\", "/") for ext in SUPPORTED_EXTENSIONS)
        candidates.extend(str(base / f"index{ext}").replace("\\", "/") for ext in (".ts", ".tsx", ".js"))
    dotted = import_name.replace(".", "/").replace("::", "/")
    candidates.extend(f"{dotted}{ext}" for ext in SUPPORTED_EXTENSIONS)
    candidates.extend(f"src/{dotted}{ext}" for ext in SUPPORTED_EXTENSIONS)
    for candidate in candidates:
        normalized = os.path.normpath(candidate).replace("\\", "/")
        if normalized in file_set:
            return normalized
    return None


def dependency_graph(repo_path: str, files: List[str]) -> Dict[str, any]:
    """Build a dependency map: internal imports (who imports whom) and external packages."""
    imports_by_file: Dict[str, List[str]] = {}
    imported_by: Dict[str, Set[str]] = defaultdict(set)
    external: Dict[str, int] = defaultdict(int)

    for rel_path in files:
        if Path(rel_path).suffix not in SUPPORTED_EXTENSIONS:
            continue
        imports = extract_imports(repo_path, rel_path)
        imports_by_file[rel_path] = imports
        for item in imports:
            internal = resolve_internal_import(item, rel_path, files)
            if internal:
                imported_by[internal].add(rel_path)
            else:
                root = item.split("/", 1)[0].split(".", 1)[0].split("::", 1)[0]
                if root and not root.startswith("."):
                    external[root] += 1

    internal_counts = {file: len(importers) for file, importers in imported_by.items()}
    return {
        "internal_counts": dict(sorted(internal_counts.items(), key=lambda item: (-item[1], item[0]))),
        "external_counts": dict(sorted(external.items(), key=lambda item: (-item[1], item[0]))),
    }
