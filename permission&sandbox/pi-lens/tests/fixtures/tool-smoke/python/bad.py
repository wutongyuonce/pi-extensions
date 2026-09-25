"""Tool-smoke fixture for #209 — ruff must flag the unused import (F401)."""

import os


def add(a, b):
    return a + b


result = add(1, 2)

# LSP gate seed (#3217): pyright reports the incompatible assignment through
# `lsp_diagnostics`; the F401 above is a ruff finding, not an LSP one.
gate_seed: int = "not a number"
