from __future__ import annotations

from pathlib import Path
from typing import Dict, List

from scope.engine.discover import SUPPORTED_EXTENSIONS

MAX_FILE_SIZE = 500_000


def read_text(repo_path: str, rel_path: str, max_bytes: int = MAX_FILE_SIZE) -> str:
    """Read file contents safely with size limit."""
    try:
        full_path = Path(repo_path) / rel_path
        if full_path.stat().st_size > max_bytes:
            return ""
        return full_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
