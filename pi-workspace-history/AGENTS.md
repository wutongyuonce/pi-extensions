# Repository Guidelines

## Project Structure & Module Organization

The package is a TypeScript Pi extension. Its implementation is concentrated in `.pi/extensions/workspace-history.ts`; `.pi/settings.json` loads that file during local development. Integration tests live in `tests/workspace-history.test.ts`, while `tests/benchmark-first-turn.ts` measures initial snapshot overhead. User documentation is in `README.md` and `README.zh-CN.md`; keep both aligned when behavior or configuration changes. `demo.gif` is the repository's user-facing media asset. Runtime history under `.pi/workspace-history/`, dependencies, and build output are intentionally ignored.

## Build, Test, and Development Commands

- `npm ci`: install the exact dependencies recorded in `package-lock.json`.
- `npm run typecheck`: run strict TypeScript checking with no emitted files.
- `npm test`: execute the async integration suite through `tsx`.
- `npm run bench:first-turn -- 2000 256`: benchmark a 2,000-file workspace with 256-byte payloads.
- `pi` (or `/reload` in an existing Pi session): load the extension directly from `.pi/extensions/` for manual testing.

There is no compilation artifact or separate production build; Pi consumes the TypeScript entry point directly.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, double quotes, and trailing commas in multiline structures. Keep TypeScript strict and prefer explicit domain types over `any`. Use `camelCase` for functions and variables, `PascalCase` for interfaces and type aliases, and `UPPER_SNAKE_CASE` for module constants. Name async helpers by their action, such as `createSnapshotCommit` or `restoreSnapshotCommitSafely`. No formatter or linter is configured, so match surrounding code and rely on `npm run typecheck`.

## Testing Guidelines

Tests use `node:assert/strict` and a custom sequential runner, not Jest or Vitest. Add focused `async function test...()` cases, register each in the `tests` array in `main()`, and use isolated temporary workspaces with cleanup in `finally`. Cover both workspace contents and shadow Git state for snapshot or restore changes. Run `npm test` and `npm run typecheck` before submitting; no numeric coverage threshold is defined.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style: `feat: ...`, `fix: ...`, or `chore: ...`. Keep commits narrowly scoped and use imperative, lowercase summaries. Pull requests should explain user-visible behavior, note configuration or storage compatibility, link relevant issues, and include test results. Add screenshots or an updated `demo.gif` only for visible interaction changes.

## Security & Configuration

Never commit `.env*`, generated history, or user workspace data. Preserve ignore filtering and dirty-workspace guards when changing restore logic; destructive Git behavior requires regression tests.
