from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from scope.models import Symbol


def cache_dir(repo_path: str) -> Path:
    git_dir = Path(repo_path) / ".git"
    if git_dir.is_dir():
        return git_dir
    fallback = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "repo-baby"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def _cache_path(repo_path: str, filename: str) -> Path:
    return cache_dir(repo_path) / filename


def cache_file(repo_path: str) -> Path:
    return _cache_path(repo_path, "scope-cache-v2.json")


def files_signature(repo_path: str, files: List[str]) -> str:
    from scope.engine.git import git_head

    h = hashlib.sha256()
    h.update(git_head(repo_path).encode())
    for rel_path in files:
        full_path = Path(repo_path) / rel_path
        try:
            stat = full_path.stat()
        except OSError:
            continue
        h.update(rel_path.encode())
        h.update(str(stat.st_mtime_ns).encode())
        h.update(str(stat.st_size).encode())
    return h.hexdigest()


def load_cached_symbols(
    repo_path: str, files: List[str], scope: str, max_files: int
) -> Optional[Dict[str, List[Symbol]]]:
    from scope.engine.discover import normalize_scope

    path = cache_file(repo_path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    if payload.get("signature") != files_signature(repo_path, files):
        return None
    if payload.get("scope") != normalize_scope(scope) or payload.get("max_files") != max_files:
        return None
    return _symbols_from_dict(payload.get("symbols", {}))


def save_cached_symbols(
    repo_path: str, files: List[str], scope: str, max_files: int,
    all_symbols: Dict[str, List[Symbol]],
) -> None:
    from scope.engine.discover import normalize_scope

    payload = {
        "version": 2,
        "signature": files_signature(repo_path, files),
        "scope": normalize_scope(scope),
        "max_files": max_files,
        "symbols": _symbols_to_dict(all_symbols),
    }
    try:
        cache_file(repo_path).write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        pass


_F = Any  # type alias for the transform callable


def _symbols_transform(
    data: Dict[str, List[Any]],
    transform: Callable[[Any], Any],
) -> Dict[str, List[Any]]:
    return {fp: [transform(s) for s in syms] for fp, syms in data.items()}


def _symbols_to_dict(all_symbols: Dict[str, List[Symbol]]) -> Dict[str, List[Dict[str, Any]]]:
    return _symbols_transform(all_symbols, lambda s: s.to_dict())  # type: ignore[return-value]


def _symbols_from_dict(data: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[Symbol]]:
    return _symbols_transform(data, Symbol.from_dict)  # type: ignore[return-value]
