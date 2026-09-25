"""Tool-smoke fixture (#1937) — mypy flags the int/str return mismatch."""


def greet(name: str) -> int:
    return "hello " + name


greet(42)
