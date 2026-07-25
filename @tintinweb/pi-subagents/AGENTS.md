# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types (`@earendil-works/pi-*`, `@sinclair/typebox`, etc.); don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Match the surrounding code style — it is enforced by biome (`biome.json`).
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- This is a pi extension. Respect the Claude Code-compatible tool names, calling conventions, and UI patterns the extension deliberately mirrors; don't diverge from them without a stated reason.
- When reviewing a diff, favor solutions that are elegant, not overengineered — flag needless abstraction, layering, or defensive code that the change doesn't warrant.

## Commands

- After code changes (not docs), run the full check suite and fix all errors and warnings:
  ```bash
  npm run lint        # biome
  npm run typecheck   # tsc --noEmit
  npm run test        # vitest run
  ```
- `npm run lint:fix` auto-fixes most style issues.
- `npm run test` runs the whole suite, including `*-e2e.test.ts` files. To iterate on a single file, run it directly: `npx vitest run test/<file>.test.ts`.
- If you create or modify a test file, run it and iterate on the test or implementation until it passes.
- `npm run build` compiles with `tsc`; run it only when verifying the build output or when requested.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.

## Git

- **Never commit.** The user commits manually. At most, suggest a concise commit message as text.
- **Never push**, tag, or create branches unless the user explicitly asks.
- Never run history- or worktree-destroying commands: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, or any force push.
- Leave the working tree as the user left it — don't stage, stash, or revert files you didn't change.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor guidelines and quality bar.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, and in the user's tone.

## Changelog

Location: `CHANGELOG.md` (single file, [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format).

- All new entries go under `## [Unreleased]`, in the right subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`, `### Refactored`). Read the section first and append to existing subsections; never duplicate them.
- One bullet per issue/PR. Never combine separate issues or pull requests into a single entry, even when they touch the same or similar components. (A PR together with the issue it closes or that diagnosed it is one change — one bullet citing both.)
- Breaking changes are not a separate subsection. Call them out with a `> **⚠️ Breaking: …**` blockquote at the top of the version section, and/or a bold `**BREAKING:**` bullet under `### Changed`, with a migration note.
- Entries are detailed — a bold lead-in summarizing the change, then prose explaining the behavior, rationale, and any migration. Match the surrounding density.
- Released version sections (e.g. `## [0.12.0]`) are immutable; never modify them.
- Attribute external contributions: `... ([#456](https://github.com/tintinweb/pi-subagents/pull/456) — thanks [@username](https://github.com/username))`.

## Releasing

**Versioning** (all releases are `0.x`, no major bumps):

- `minor` (`0.x.0`) — a notable new feature, or any breaking change.
- `patch` (`0.x.y`) — bug fixes and smaller additions.

Before a release:

- Update `CHANGELOG.md` — move the `## [Unreleased]` entries under a new `## [X.Y.Z]` version section, and add a fresh empty `## [Unreleased]` for the next cycle.
- Update `README.md` if user-facing behavior changed (features list, settings, usage).
- Run the full check suite plus the e2e tests, and fix anything that fails:
  ```bash
  npm run lint
  npm run typecheck
  npm run test:e2e                 # faux/scripted e2e — no network, no keys
  npm run build
  ```
- For a real pre-publish smoke test, run the **live** e2e against an actual model:
  ```bash
  PI_E2E_LIVE=1 npm run test:e2e   # uses your local `pi` login; optional PI_PROVIDER / PI_MODEL
  ```
  `PI_E2E_LIVE=1` swaps the scripted faux suite for the live one (the faux suite is `skipIf(LIVE)`).
  (`prepublishOnly` runs lint + typecheck + test + build; the live e2e is the smoke test to run by hand before publishing.)

**Never publish.** The user runs `npm version` / `npm publish` and any tagging manually. Do not run those commands unless the user explicitly asks.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
