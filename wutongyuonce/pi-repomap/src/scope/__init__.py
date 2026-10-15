from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict

from scope.engine.cache import (
    load_cached_symbols,
    save_cached_symbols,
)
from scope.engine.discover import (
    discover_files,
    language_stats,
    pair_tests,
    prioritize_files,
)
from scope.engine.frameworks import detect_frameworks
from scope.engine.rank import compute_importance, suggested_reads
from scope.engine.references import dependency_graph
from scope.engine.symbols import extract_symbols, is_available as ts_available
from scope.models import Symbol
from scope.modes import map as map_mode
from scope.modes import overview as overview_mode
from scope.modes import pairs as pairs_mode

MAX_FILES_DEFAULT = 1000


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Scope — codebase orientation tool",
        epilog=(
            "examples:\n"
            "  scope --path . --mode overview        Project fingerprint\n"
            "  scope --path . --mode map              Ranked symbols by importance\n"
            "  scope --path . --mode pairs            Source-to-test file mapping\n"
            "\n"
            "docs: https://github.com/k3-2o/scope"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--path", required=True, help="Path to repository root")
    ap.add_argument("--scope", default=".", help="Limit to a subdirectory (default: .)")
    ap.add_argument(
        "--token-budget", type=int, default=800,
        help="Approximate token budget for the output (default: 800)",
    )
    ap.add_argument(
        "--mode", choices=("map", "overview", "pairs"), default="map",
        help="Output mode",
    )
    ap.add_argument(
        "--format", choices=("text", "json"), default="text",
        help="Output format (default: text)",
    )
    ap.add_argument(
        "--max-files", type=int, default=MAX_FILES_DEFAULT,
        help=f"Maximum source files to scan (default: {MAX_FILES_DEFAULT})",
    )
    ap.add_argument("--no-cache", action="store_true", help="Disable symbol cache")
    args = ap.parse_args()

    repo_path = os.path.abspath(args.path)
    if not os.path.isdir(repo_path):
        print(f"Error: {repo_path} is not a directory", file=sys.stderr)
        sys.exit(1)

    # --- File discovery ---
    candidates = prioritize_files(discover_files(repo_path, args.scope))
    if not candidates:
        _output(args.format, "No source files found", {})
        sys.exit(0)

    max_files = max(1, args.max_files)
    files = candidates[:max_files]
    truncated = len(candidates) > len(files)

    # --- Modes that need no symbols ---
    if args.mode == "pairs":
        pairs = pair_tests(files)
        text = pairs_mode.render(pairs, args.token_budget)
        data: Dict[str, Any] = {
            "mode": "pairs",
            "pairs": pairs,
        }
        _output(args.format, text, data)
        return

    # --- Symbol extraction ---
    needs_symbols = args.mode in ("map", "overview")
    all_symbols: Dict[str, List[Symbol]] = {}
    cache_hit = False

    if needs_symbols and ts_available():
        if not args.no_cache:
            cached = load_cached_symbols(repo_path, files, args.scope, max_files)
            if cached is not None:
                all_symbols = cached
                cache_hit = True
        if not all_symbols:
            for rel_path in files:
                symbols = extract_symbols(rel_path, repo_path)
                if symbols:
                    all_symbols[rel_path] = symbols
            if not args.no_cache:
                save_cached_symbols(repo_path, files, args.scope, max_files, all_symbols)

    # --- Dependency graph for importance boost ---
    graph = dependency_graph(repo_path, files) if all_symbols else {"internal_counts": {}, "external_counts": {}}

    if all_symbols:
        compute_importance(all_symbols, repo_path, graph.get("internal_counts", {}))

    stats_data = {
        "source_candidates": len(candidates),
        "scanned_files": len(files),
        "truncated": truncated,
        "files_with_symbols": len(all_symbols),
        "symbols": sum(len(s) for s in all_symbols.values()),
        "languages": language_stats(files),
        "cache_hit": cache_hit,
    }

    frameworks = detect_frameworks(repo_path, files)
    reads = suggested_reads(all_symbols, files)

    # --- Output ---
    if args.mode == "map":
        text = map_mode.render(all_symbols, args.token_budget)
        suggestions = map_mode.render_suggestions(reads)
        if suggestions:
            text += suggestions
        data = {
            "mode": "map",
            "stats": stats_data,
            "frameworks": frameworks,
            "suggested_reads": reads,
            "symbols": {fp: [s.to_dict() for s in syms] for fp, syms in all_symbols.items()},
        }

    elif args.mode == "overview":
        meta = {
            "stats": stats_data,
            "frameworks": frameworks,
            "suggested_reads": reads,
        }
        text = overview_mode.render(meta, args.token_budget)
        data = {"mode": "overview", **meta}

    else:
        text = ""
        data = {}

    # Graceful degradation for missing tree-sitter
    if needs_symbols and not ts_available():
        text = "# Tree-sitter dependencies missing\nInstall with: uv sync"
        data["error"] = "Tree-sitter dependencies missing"
    elif needs_symbols and not all_symbols and ts_available():
        text = "# No symbols found\n\nTry narrowing --scope or use --mode pairs for test mapping."
        data["warning"] = "No symbols found"

    _output(args.format, text, data)


def _output(format_str: str, text: str, data: Dict[str, Any]) -> None:
    if format_str == "json":
        print(json.dumps(data, indent=2))
    else:
        print(text)


if __name__ == "__main__":
    main()
