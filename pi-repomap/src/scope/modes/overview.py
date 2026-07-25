from __future__ import annotations

from typing import Any, Dict, List


def render(meta: Dict[str, Any], _token_budget: int) -> str:
    """Project overview — frameworks, entrypoints, language stats, suggested reads, scripts.

    Designed for first-contact orientation: one call replaces 3-4 exploration commands.
    """

    lines: List[str] = ["# Repo overview"]

    frameworks = meta.get("frameworks", {}).get("frameworks", [])
    entrypoints = meta.get("frameworks", {}).get("entrypoints", [])
    if frameworks:
        lines.append("- detected: " + ", ".join(frameworks))
    if entrypoints:
        lines.append("- likely entrypoints: " + ", ".join(entrypoints[:8]))

    stats = meta.get("stats", {})
    lines.append(
        f"- files: {stats.get('scanned_files', 0)} scanned / "
        f"{stats.get('source_candidates', 0)} candidates; "
        f"symbols: {stats.get('symbols', 0)}"
    )
    langs = stats.get("languages", {})
    if langs:
        lines.append("- languages: " + ", ".join(f"{k} {v}" for k, v in langs.items()))

    reads = meta.get("suggested_reads", [])
    if reads:
        lines.append("\n## Suggested next reads")
        for i, path in enumerate(reads, start=1):
            lines.append(f"{i}. {path}")

    scripts = meta.get("frameworks", {}).get("package_scripts", {})
    if scripts:
        lines.append("\n## Package scripts")
        for name, command in list(scripts.items())[:12]:
            lines.append(f"- {name}: {command}")

    return "\n".join(lines)
