from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

IGNORE_DIRS: FrozenSet[str] = frozenset({
    ".git", "__pycache__", "node_modules", ".venv", "venv", "env",
    "dist", "build", "target", ".terraform", ".idea", ".vscode",
    "vendor", "bin", "obj", "out", ".next", ".nuxt", ".cache",
    "coverage", "htmlcov", ".tox", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".hypothesis", ".hg", ".svn", "site-packages",
})

SUPPORTED_EXTENSIONS: FrozenSet[str] = frozenset({
    ".py", ".js", ".ts", ".tsx",
    ".go", ".rs", ".rb", ".java",
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx",
    ".cs", ".php", ".kt", ".kts", ".swift",
    ".scala", ".sc", ".sh", ".bash", ".sql", ".lua",
    ".tf", ".tfvars", ".hcl",
})

SKIP_FILE_PATTERNS: List[re.Pattern] = [
    re.compile(r"package-lock\.json$", re.IGNORECASE),
    re.compile(r"yarn\.lock$", re.IGNORECASE),
    re.compile(r"pnpm-lock\.yaml$", re.IGNORECASE),
    re.compile(r"\.min\.(js|css)$", re.IGNORECASE),
    re.compile(r"go\.sum$"),
    re.compile(r"Gemfile\.lock$"),
    re.compile(r"poetry\.lock$"),
    re.compile(r"uv\.lock$"),
    re.compile(r"\.d\.ts$"),
]

ENTRYPOINT_NAMES: FrozenSet[str] = frozenset({
    "main", "index", "app", "server", "cli", "cmd", "handler", "manage",
    "wsgi", "asgi", "router", "routes",
})

CONFIG_FILENAMES: FrozenSet[str] = frozenset({
    "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
    "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "settings.gradle",
    "composer.json", "Gemfile", "Makefile", "Dockerfile", "docker-compose.yml",
    "terraform.tf", "main.tf", "variables.tf", "outputs.tf",
})

TEST_MARKERS: Tuple[str, ...] = ("/test/", "/tests/", "/__tests__/", ".test.", ".spec.")


def git_tracked_files(repo_path: str) -> List[str]:
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return [f for f in result.stdout.strip().split("\n") if f]
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return []


def normalize_scope(scope: str) -> str:
    scope = (scope or ".").strip().replace("\\", "/")
    if scope in ("", "."):
        return "."
    scope = scope.lstrip("/")
    normalized = os.path.normpath(scope).replace("\\", "/")
    if normalized.startswith("..") or normalized == ".":
        return "."
    return normalized.rstrip("/")


def walk_files(repo_path: str, scope: str = ".") -> List[str]:
    files: List[str] = []
    scope = normalize_scope(scope)
    scope_path = Path(repo_path) / scope

    if not scope_path.exists():
        return files

    for root, dirs, filenames in os.walk(scope_path):
        dirs[:] = sorted(
            d for d in dirs
            if d not in IGNORE_DIRS and not d.startswith(".")
        )

        for filename in filenames:
            if filename.startswith("."):
                continue

            full_path = Path(root) / filename
            rel_path = str(full_path.relative_to(repo_path))

            if not _should_include_file(rel_path):
                continue

            files.append(rel_path)

    return files


def discover_files(repo_path: str, scope: str = ".") -> List[str]:
    scope = normalize_scope(scope)
    git_files = git_tracked_files(repo_path)
    if git_files:
        result = []
        for f in git_files:
            if scope != "." and not f.startswith(scope.rstrip("/") + "/") and f != scope.rstrip("/"):
                continue
            if _should_include_file(f):
                result.append(f)
        return result

    return walk_files(repo_path, scope)


def _should_include_file(rel_path: str) -> bool:
    base = Path(rel_path).name
    ext = Path(rel_path).suffix

    for pattern in SKIP_FILE_PATTERNS:
        if pattern.search(rel_path):
            return False

    if base in CONFIG_FILENAMES or base.lower().startswith("readme."):
        return True

    if ext not in SUPPORTED_EXTENSIONS:
        return False

    return True


def is_test_file(rel_path: str) -> bool:
    p = rel_path.replace("\\", "/")
    base = os.path.basename(p)
    return (
        any(marker in f"/{p}" for marker in TEST_MARKERS)
        or base.startswith("test_")
        or base.endswith("_test.py")
        or base.endswith("_test.go")
    )


def is_config_or_entrypoint(rel_path: str) -> bool:
    path = Path(rel_path)
    base = path.name
    stem = path.stem.lower()
    return base in CONFIG_FILENAMES or stem in ENTRYPOINT_NAMES


def _file_priority(rel_path: str) -> Tuple[int, int, int, str]:
    """Lower sorts earlier. Keeps entry points visible and large-repo caps from
    being consumed by generated/test files first."""
    path = rel_path.replace("\\", "/")
    parts = path.split("/")
    score = 50
    if is_config_or_entrypoint(path):
        score -= 25
    if parts[0] in ("src", "lib", "app", "packages", "cmd", "internal"):
        score -= 10
    if is_test_file(path):
        score += 25
    if any(part in IGNORE_DIRS for part in parts):
        score += 50
    depth = path.count("/")
    return (score, depth, len(path), path)


def prioritize_files(files: Iterable[str]) -> List[str]:
    return sorted(files, key=_file_priority)


_EXT_TO_LANG: Dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".cs": "csharp",
    ".php": "php",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".swift": "swift",
    ".scala": "scala",
    ".sc": "scala",
    ".sh": "bash",
    ".bash": "bash",
    ".sql": "sql",
    ".lua": "lua",
    ".tf": "hcl",
    ".tfvars": "hcl",
    ".hcl": "hcl",
}


def language_stats(files: Iterable[str]) -> Dict[str, int]:
    stats: Dict[str, int] = {}
    for file_path in files:
        lang = _EXT_TO_LANG.get(Path(file_path).suffix, "other")
        stats[lang] = stats.get(lang, 0) + 1
    return dict(sorted(stats.items(), key=lambda item: (-item[1], item[0])))


def pair_tests(files: List[str]) -> Dict[str, List[str]]:
    tests = [f for f in files if is_test_file(f)]
    sources = [f for f in files if not is_test_file(f) and Path(f).suffix in SUPPORTED_EXTENSIONS]
    pairs: Dict[str, List[str]] = {}
    for source in sources:
        stem = Path(source).stem
        source_parts = set(Path(source).parts)
        matched: List[str] = []
        for test in tests:
            test_stem = Path(test).stem.replace(".test", "").replace(".spec", "")
            if stem == test_stem or stem in test or source_parts.intersection(Path(test).parts):
                matched.append(test)
        if matched:
            pairs[source] = sorted(matched)
    return dict(sorted(pairs.items()))
