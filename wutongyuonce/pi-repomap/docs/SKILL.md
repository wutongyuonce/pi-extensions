---
name: scope
description: "Codebase exploration for unfamiliar repos — finds entry points, maps important symbols (functions/classes) across 25+ languages, and pairs source files with tests. Use when: dropped into a project you've never seen and need to find where to start, verifying your edits didn't break the structure, looking for test files that match a source file, or generating a compact codebase summary for an AI prompt. Not for: measuring code quality (use prism). Trigger words: orient, explore, codebase, navigate, unfamiliar, what's here, entry points, onboarding, map, overview."
compatibility: "Requires `scope` CLI on PATH. Install from github.com/k3-2o/scope."
---

# Scope

## Setup

Check if scope is available:

```bash
which scope
```

If not found, ask the user: **"scope is not installed. Install it from github.com/k3-2o/scope?"**
If they agree, clone and install:

```bash
git clone https://github.com/k3-2o/scope ~/scope && cd ~/scope && uv tool install .
```

Then verify:

```bash
which scope
```

## Workflow

### Step 1: Orient (first time in a repo)

```bash
scope --path <repo-root> --mode overview --token-budget 400
```

This tells you:
- What frameworks/languages are used
- Which files are the likely entrypoints
- How many files and symbols exist
- Which 5 files you should read first

**Read the suggested next reads.** They are ranked by cross-file importance.

### Step 2: Get the map (for structural understanding)

```bash
scope --path <repo-root> --mode map --token-budget 800
```

This returns every function, class, and method ranked by how many other files reference them. Your next actions depend on what you're doing:

- **Looking for entry points** — find symbols with `main`, `handler`, `start`, `serve` in the name
- **Tracing a feature** — find related symbols by scanning the ranked list
- **General understanding** — read the files with the most symbols first

### Step 3: Find tests (before editing)

```bash
scope --path <repo-root> --mode pairs
```

Shows which test files map to which source files. Before editing a source file, run its paired tests after the change.

### Step 4: Verify (after edits)

After renaming/moving a shared function, class, or interface, re-run the map:

```bash
scope --path <repo-root> --mode map --token-budget 400
```

Check that:
- The renamed symbol appears at the expected importance level
- No symbols unexpectedly disappeared
- The structure makes sense with your changes

## When to Skip

Do not use scope when:
- You already know the top 3 relevant files
- The user specified a file and line number
- The task is purely mechanical (formatting, comments, versions)
- You ran scope within the last 3 turns and nothing changed
- You are in "execute" mode — you already know where to edit and just need to write code

## Tips

- Use `--scope src/` to focus on a subdirectory instead of the whole repo
- Use `--no-cache` if you suspect stale data (or wait — cache auto-invalidates on file changes)
- Use `--format json` if you need structured data for programmatic reasoning
- The `← N files` annotation tells you how many other files reference each symbol — higher means more central to the codebase
