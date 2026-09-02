# @narumitw/pi-lsp

## 0.49.6

### Patch Changes

- c23e604: Key published diagnostics by a canonical file path so equivalent URI encodings are matched, and wait for each LSP process to exit before completing shutdown.

## 0.49.5

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.49.4

### Patch Changes

- 9b96a71: Use Pi's host-provided coding-agent and TypeBox runtimes instead of installing duplicate copies.
