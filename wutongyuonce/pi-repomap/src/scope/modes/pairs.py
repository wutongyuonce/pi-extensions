from __future__ import annotations

from typing import Dict, List


def render(pairs: Dict[str, List[str]], token_budget: int) -> str:
    """Test/source pair mapping — which source file likely has which test file.

    Tedious to do in bash (name matching + directory traversal), one call here.
    """
    _ = token_budget

    if not pairs:
        return "# Test/source pairs\nNo likely pairs found"

    lines = ["# Test/source pairs"]
    for source, tests in pairs.items():
        lines.append(f"- {source}")
        for test in tests[:8]:
            lines.append(f"  - {test}")

    return "\n".join(lines)
