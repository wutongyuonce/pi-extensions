# ADR 0009: reported-path attribution is one seam, based on the runner cwd

## Status

Accepted — 2026-09-23

## Context

Every runner that parses a tool's textual or JSON output has to answer one
question per reported line: *is this diagnostic about the file the dispatcher
ran me for?* Twelve sites answered it with their own predicate — a bare `===` or
`!==` over two `path.resolve` results, a `path.resolve` with NO base argument, a
`path.posix.basename` compare, and two `endsWith` compares. #209 and #3277 are
the shipped defects of the first two shapes: a spelling that differs only in
case is the SAME file on Windows and on a case-folding POSIX mount, so the
compare dropped every finding for the edited file and the run reported clean.
#3278 measured the population at ~11 and #1193 recorded the fold verdict.

The state space, written before the first edit. Left = the path the tool
printed. Right = `path.resolve(ctx.filePath)`, which is
`normalizeMapKey`-canonical and absolute by the #2016 invariant.

| axis | value | consequence |
|---|---|---|
| host folds case | win32 always; POSIX only on a case-folding mount (APFS, `nocase` vfat/ntfs3/cifs) | a `process.platform === "win32"` test is wrong in both directions on APFS. Only the filesystem knows, so the predicate must ask it. |
| reported spelling | absolute (the tool echoes our argv), relative to the tool's own cwd, relative to a package/base directory it chose, or basename-only | only the tool's OWN cwd is a base the caller can supply; `process.cwd()` is the extension's and is a different directory whenever `resolveRunnerCwd` returns a nested language root. |
| separators after `path.resolve` | host-native on both sides; a foreign separator survives only embedded in the reported string | separator folding can only MERGE, never split. |
| symlinked project dir | `pathsEqual` does NOT resolve symlinks on POSIX (`clients/path-utils.ts:181`, deliberate) | a project entered through a directory symlink can still mis-match; that is a property of the shared seam, unchanged by this decision (#3276's recorded output). |
| purpose | identity test of ONE file, per reported line — not a stored key, not set membership | asks for an equality predicate, not a key derivation. |

Candidate seams: `normalizeEphemeralMapKey` is rejected by its own contract
(`clients/path-utils.ts:488-490` — "never … compared against externally-supplied
paths where symlink / real-casing resolution actually matters"; the left side is
literally an external process's output, and it folds case on
`process.platform === "win32"` only). `normalizeFilePath`/`normalizeMapKey` are
the right rule in the wrong shape: the caller would still hold the comparison
and re-derive both keys. A NEW `reportedPathMatchesTarget(reported, { cwd,
target })` helper fails the deletion test — removing it would put back the same
single expression at each call site rather than concentrating anything — and it
would hide the comparison from the #1193 sweep's call-site walk while raising
the helper count.

## Decision

The predicate is `pathsEqual(path.resolve(<the cwd the tool ran in>, reported),
absTarget)`, written INLINE at each call site. It is not a new helper: it is the
call shape `clients/dispatch/runners/terragrunt.ts:90`,
`elixir-check.ts:63` (#3276) and `go-vet.ts:107` (#3277) already use, so this
decision migrates the remaining members onto an existing seam and adds nothing.
A parse function that does not receive the runner cwd takes it as a parameter;
no parse function resolves a reported path against `process.cwd()`.

Absence is enforced by `tests/config/reported-path-attribution-sweep.test.ts`, a
shrink-only census of runner sites that still hold their own predicate.
`tests/config/path-key-fold-sweep.test.ts` counts folds that EXIST and therefore
structurally cannot see a member with no fold at all — measured on #3277, where
mutating `go-vet.ts` to a hand-rolled case fold left that sweep green.

A member's fold is admitted only with its premise established: what spelling
does this tool really emit under OUR invocation? Where the tool echoes the
absolute path we hand it as argv, the fold is behaviour-preserving and its tests
say so, rather than feeding a spelling the tool never emits.

## Consequences

The path-case rule exists once, in `clients/path-utils.ts`; no runner holds a
`process.platform` test or a `toLowerCase` for this question. `pathsEqual` costs
a `realpathSync.native`/`existsSync` per reported line, which is bounded by the
tool's own output size on a parse path that already allocates per line.

Two directions are now pinned per member: the tool's real spelling attaches, and
a different file's finding does not. On a case-folding host the case-variant
spelling attaches too, and on a case-sensitive host it must not — asserted from
the filesystem's own answer, never from `process.platform`.

The predicate still cannot see through a directory symlink on POSIX, and a
runner that needs that must say so at its own call site rather than re-deriving
a local rule. It also cannot SPLIT a separator: `pathsEqual` folds `\` to `/` on
every platform (`clients/path-utils.ts:231`), so a POSIX file literally named
`a\b.gleam` stays merged with `a/b.gleam` after a member's own hand-rolled fold
is deleted. Deleting the local fold removes a second, divergent copy of the rule;
it does not change that answer.

Two amendments from #3285 / #3286, the two remainders:

1. The CAPTURE is part of this decision, not a detail before it. A tool renders
   its location line however it likes, and `gleam` renders through
   `codespan_reporting`, whose locus line wraps the path in a `┌─` gutter. A
   suffix compare tolerates that decoration and an equality predicate cannot, so
   a member whose reported path arrives decorated moves the decoration out of the
   captured group in the same change — and its premise is a vector generated by
   the upstream RENDERER (`tests/fixtures/gleam-codespan/`), not a transcription
   of it. The same rule covers colour: a tool that may emit SGR codes goes
   through `stripAnsi` before an anchored capture.
2. The population is runners AND tool clients (`clients/*-client.ts`). The autofix
   half of a tool lives in its client, `ruff-client.ts` held the same bare `!==`,
   and a detector scoped to `clients/dispatch/runners/**` structurally could not
   see it. Widening cost exactly one non-member registration
   (`clients/test-runner-client.ts`, two self-derived directories).

## Links

- Umbrella: #1193 (P3 fold), #3278 (the population).
- Precedents: #3276 (`elixir-check`), #3277 / PR #3281 (`go-vet`).
- Shipped defects: #209, #3277.
- Detector: `tests/config/reported-path-attribution-sweep.test.ts`.
- Cells: `tests/clients/dispatch/runners/reported-path-attribution.test.ts`.
- Witness (ADR 0007): `tests/fixtures/witness/runner-outcome-eslint-golangci/golangci-lint-relative-path.txt`.
- Remainders, both now closed: `gleam-check.ts` (#3285 — its `endsWith` was
  load-bearing for `codespan_reporting`'s gutter) and `clients/ruff-client.ts`
  (#3286 — outside the runner population).
- Upstream vectors: `tests/fixtures/gleam-codespan/` (gleam v1.18.1 +
  codespan-reporting 0.13.1), `tests/fixtures/ruff-json/` (ruff 0.16.8).
- Cells for the client half: `tests/clients/ruff-client-reported-path.test.ts`.
