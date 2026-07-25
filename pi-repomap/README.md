# pi-repomap

Codebase awareness CLI for AI coding agents: ranked symbols by cross-file importance, project overview, and source/test pair mapping.

This repository now contains two implementations of the same product idea:

- Python implementation: the original behavior baseline
- TypeScript implementation: a high-fidelity port with compatibility regression checks

Both implementations provide the same three modes:

```bash
scope --path /some/repo --mode overview
scope --path /some/repo --mode map --token-budget 800
scope --path /some/repo --mode pairs
```

The TypeScript build provides the same experience through:

```bash
node dist/index.js --path /some/repo --mode overview
node dist/index.js --path /some/repo --mode map --token-budget 800
node dist/index.js --path /some/repo --mode pairs
```

Designed for AI agents and developers who need to orient themselves quickly in an unfamiliar codebase. The tool focuses on three things bash does poorly on its own: project overview, cross-file symbol ranking, and source-to-test mapping.

## What It Does

| Mode | What it does | Why not bash |
|---|---|---|
| `overview` | Frameworks, entrypoints, language stats, suggested reads, package scripts | Replaces 3-4 chained exploration commands |
| `map` | Ranked symbols by cross-file reference count, grouped by file | Bash cannot compute cross-file importance |
| `pairs` | Source↔test file mapping | Tedious to do with grep/find name matching |

## Common Flags

| Flag | Default | Purpose |
|---|---|---|
| `--path DIR` | required | Repository root |
| `--scope DIR` | `.` | Limit analysis to a subdirectory |
| `--token-budget N` | 800 | Output size limit in tokens |
| `--max-files N` | 1000 | Maximum source files to scan |
| `--mode MODE` | `map` | `map`, `overview`, or `pairs` |
| `--format FMT` | `text` | `text` or `json` |
| `--no-cache` | false | Bypass symbol cache |

## Example Output

```text
- src/auth/service.py:
  function validate_token (line 45)  ← 12 files
  function refresh_session (line 102)  ← 5 files
  class TokenManager (line 15)

## Suggested next reads
1. src/auth/service.py
2. src/api/handlers.py
```

`← N files` shows how many other files reference each symbol.

## How It Works

1. Discovers source files with `git ls-files` or filesystem walking
2. Parses source with Tree-sitter
3. Extracts symbols with scope tracking such as `Class.method`
4. Builds a lightweight dependency graph from import statements
5. Ranks symbols by cross-file token references plus a few heuristics
6. Caches symbol extraction results in `.git/scope-cache-v2.json`

## Repository Layout

```text
pi-scope/
├── src/scope/            # Python implementation
├── tests/                # Python tests
├── ts-src/               # TypeScript implementation
├── ts-tests/             # TypeScript tests and compatibility fixtures
├── pyproject.toml        # Python package config
├── package.json          # TypeScript package config
└── docs/
```

## Python Version

### Install

```bash
# Requires Python 3.11+ and uv
uv tool install .
```

Then `scope` is available on your PATH.

### Run

```bash
scope --path /some/repo --mode overview
scope --path /some/repo --mode map
scope --path /some/repo --mode pairs
```

Or run directly from the repo:

```bash
uv run python -m scope --path /some/repo --mode overview
```

### Test

```bash
uv run pytest -q
```

## TypeScript Version

### Install

```bash
# Requires Node.js 20+
npm install
```

### Build

```bash
npm run build
```

### Run

```bash
node dist/index.js --path /some/repo --mode overview
node dist/index.js --path /some/repo --mode map
node dist/index.js --path /some/repo --mode pairs
```

For quick local inspection:

```bash
npm run dev
```

### Test

```bash
npm test
```

This runs:

- CLI integration tests
- engine-level tests for discover, symbols, references, rank, frameworks, and cache
- compatibility tests against the Python implementation

## Python/TS Compatibility Checks

The TypeScript port is validated against the Python implementation rather than treated as a separate product.

Run:

```bash
npm run compare:python
```

This command:

1. Builds the TypeScript implementation
2. Runs the Python implementation with `uv run python -m scope`
3. Compares JSON output for `pairs`, `overview`, and `map`
4. Replays the check across fixture repositories in `ts-tests/fixtures/`

Current fixture set covers:

- `mini-python-repo`
- `mini-ts-repo`
- `mini-rust-repo`
- `mini-mixed-repo`
- `edge-cases-repo`

These fixtures help keep the TypeScript port behavior aligned with the Python baseline.

## Tree-sitter Notes

The Python version uses `tree-sitter-language-pack` for broad multi-language support.

The TypeScript version uses per-language grammar packages:

- `tree-sitter-python`
- `tree-sitter-javascript`
- `tree-sitter-typescript`
- `tree-sitter-go`
- `tree-sitter-rust`

This keeps the TS port practical in Node.js while preserving the same high-level architecture.

## Documentation

- Architecture and dual-implementation notes: `docs/ARCHITECTURE.md`
- Pi Agent skill source: `docs/SKILL.md`

## License

MIT
