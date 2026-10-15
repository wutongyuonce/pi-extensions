from __future__ import annotations

import os
import re
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

from scope.engine.discover import is_test_file as _is_test_file
from scope.models import Symbol

_IDENTIFIER_RE = re.compile(r"[a-zA-Z_]\w+")


def build_symbol_index(all_symbols: Dict[str, List[Symbol]]) -> Dict[str, List[Symbol]]:
    """Build a token → symbols lookup for fast reference scanning."""
    index: Dict[str, List[Symbol]] = defaultdict(list)
    for symbols in all_symbols.values():
        for sym in symbols:
            for token in _reference_tokens(sym.name):
                index[token].append(sym)
    return dict(index)


def _reference_tokens(name: str) -> Set[str]:
    base = name.rsplit(".", 1)[-1]
    tokens = {base}
    if "." not in name:
        tokens.add(name)
    return {token for token in tokens if _IDENTIFIER_RE.fullmatch(token)}


def compute_importance(
    all_symbols: Dict[str, List[Symbol]],
    repo_path: str,
    file_inrefs: Optional[Dict[str, int]] = None,
) -> None:
    """Rank symbols by cross-file reference count.

    Reads every source file once, scans for identifier tokens that match known
    symbol base names, and counts how many *other* files reference each symbol.
    """
    index = build_symbol_index(all_symbols)
    token_set = frozenset(index.keys())
    if not token_set:
        return

    ref_count: Dict[Tuple[str, str], int] = defaultdict(int)

    for file_path, symbols in all_symbols.items():
        full_path = os.path.join(repo_path, file_path)
        try:
            with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except (OSError, IOError):
            continue

        words_in_file: Set[str] = set()
        for word in _IDENTIFIER_RE.finditer(content):
            token = word.group(0)
            if token in token_set and token not in words_in_file:
                words_in_file.add(token)
                for sym in index[token]:
                    if sym.file != file_path:
                        ref_count[(sym.file, sym.name)] += 1

    for file_path, symbols in all_symbols.items():
        is_test = _is_test_file(file_path)

        for sym in symbols:
            score = float(ref_count.get((sym.file, sym.name), 0))
            sym.ref_count = int(score)

            # Boost important symbol kinds
            if sym.kind in ("class", "interface"):
                score *= 1.5
            elif sym.kind in ("resource", "module", "data"):
                score *= 2.0
            elif sym.kind == "key":
                score = -1.0

            # Boost well-known entry point names
            base_name = sym.name.rsplit(".", 1)[-1]
            if base_name in ("main", "index", "App", "Server",
                             "setup", "configure", "create_app", "handler"):
                score += 5.0

            # Boost files with high incoming import counts
            if file_inrefs:
                score += min(file_inrefs.get(file_path, 0), 25) * 0.35

            # Penalize test files
            if is_test or base_name.startswith("test_") or base_name.startswith("it("):
                score *= 0.05

            sym.importance = score


def suggested_reads(all_symbols: Dict[str, List[Symbol]], files: List[str], limit: int = 5) -> List[str]:
    """Rank files by total accumulated symbol importance."""
    scored: List[Tuple[float, str]] = []
    for file_path, symbols in all_symbols.items():
        total = sum(sym.importance for sym in symbols)
        scored.append((total, file_path))
    if not scored:
        return files[:limit]
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [file_path for _score, file_path in scored[:limit]]
