from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Set

try:
    import tomllib
except ImportError:
    tomllib = None  # type: ignore[assignment]

from scope.engine._utils import read_text


def detect_frameworks(repo_path: str, files: List[str]) -> Dict[str, Any]:
    """Detect frameworks, entrypoints, and package scripts from config files."""
    frameworks: Set[str] = set()
    entrypoints: Set[str] = set()
    scripts: Dict[str, str] = {}

    file_set = set(files)
    package = _read_json_file(repo_path, "package.json") if "package.json" in file_set else {}
    if package:
        deps = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
        scripts = {str(k): str(v) for k, v in package.get("scripts", {}).items()}
        for name, label in (
            ("next", "Next.js"), ("vite", "Vite"), ("react", "React"),
            ("vue", "Vue"), ("svelte", "Svelte"), ("express", "Express"),
            ("@nestjs/core", "NestJS"), ("electron", "Electron"),
        ):
            if name in deps:
                frameworks.add(label)
        for candidate in ("src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx", "index.ts", "server.ts"):
            if candidate in file_set:
                entrypoints.add(candidate)

    if "pyproject.toml" in file_set and tomllib is not None:
        try:
            data = tomllib.loads(read_text(repo_path, "pyproject.toml"))
            raw_deps = data.get("project", {}).get("dependencies", [])
            deps_text = "\n".join(str(d).lower() for d in raw_deps)
            for name, label in (("fastapi", "FastAPI"), ("django", "Django"), ("flask", "Flask"), ("pytest", "pytest")):
                if name in deps_text:
                    frameworks.add(label)
        except Exception:
            pass

    if "requirements.txt" in file_set:
        deps_text = read_text(repo_path, "requirements.txt").lower()
        for name, label in (("fastapi", "FastAPI"), ("django", "Django"), ("flask", "Flask")):
            if name in deps_text:
                frameworks.add(label)

    for candidate in ("main.py", "app.py", "manage.py", "src/main.py"):
        if candidate in file_set:
            entrypoints.add(candidate)

    if "go.mod" in file_set:
        frameworks.add("Go module")
        for candidate in ("main.go", "cmd/main.go"):
            if candidate in file_set:
                entrypoints.add(candidate)

    if "Cargo.toml" in file_set:
        frameworks.add("Rust crate")
        for candidate in ("src/main.rs", "src/lib.rs"):
            if candidate in file_set:
                entrypoints.add(candidate)

    if any(Path(f).suffix in (".tf", ".tfvars", ".hcl") for f in files):
        frameworks.add("Terraform/HCL")
        for candidate in ("main.tf", "variables.tf", "outputs.tf"):
            if candidate in file_set:
                entrypoints.add(candidate)

    return {
        "frameworks": sorted(frameworks),
        "entrypoints": sorted(entrypoints),
        "package_scripts": scripts,
    }


def _read_json_file(repo_path: str, rel_path: str) -> Dict[str, Any]:
    text = read_text(repo_path, rel_path)
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}
