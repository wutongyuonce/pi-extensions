# Reviewer contract

## Mission

- Read the issue, full merge-base diff, `AGENTS.md`,
  `docs/pi-lens-subagent.md`, the PR body, and merge state.
- Keep the branch and worktree read-only.
- Reproduce the claimed behavior through the production entry point.
- Report only proven findings; do not repair the author's branch.

## Standard mechanics

- Write `REVIEW.md` as a file at the worktree root, not only in the final
  answer. Two verifies this week (PR #3261 r3 and PR #3264 r3) delivered the
  review only in the answer text.
- When the fixer settled before its evidence pass, run the mutation table
  yourself and say so.

## Verification

- Use `git diff origin/master...HEAD` or the merge-base equivalent.
- For any change involving the pinned retired-synonym identifier population,
  run the exact-pin sweeps on the MERGE of `origin/master` + head, not only on
  the head. `tests/config/glossary-synonym-sweep.test.ts` (#3279) asserts the
  live (term, file) population exactly in both directions; require same-PR
  re-pinning from its `UNPINNED`/`STALE` output. The 2026-09-23 evidence is
  two green PRs merging red (#3279's pins predated #3283, fixed on master by
  #3288), plus #3284's own `path` count red (cue-vet 5→6, dart-analyze 6→4)
  until a trailing re-pin.
- Build and run the targeted and required governance suites.
- Revert or neuter the source fix and verify the red-first test fails.
- Mutate every new guard, filter, cap, fallback, and lifecycle path.
- Probe inversions, concurrency, input channels, trust boundaries, strict
  consumers, durable-record compatibility, and old-record parsing.
- Repeat the pattern and population sweeps.
- Check blast radius, bounded observability, changelog, commit, and PR-body
  requirements.
- For LSP, dispatch, cache, runner, or tool changes, test one non-TypeScript
  registry entry through the same seam.
- On a net-count fold, mutate every predicate the deleted sibling used to
  back; the fold's own tests were written when two guards existed (#3064 F1,
  #3065 F3, #3066 F3, #3068 F2).

## Finding format

Order findings: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `NITPICK`.

Each actionable finding contains:

1. Severity and stable id.
2. File/symbol anchor.
3. Reproduction command or probe output.
4. Expected and observed behavior.
5. Root cause, cost, and concrete remedy.
6. Issue-acceptance or repository-standard classification.

Severity requires a reproduced failure. A high-severity hypothesis without a
failure scenario is at most medium.

## Verdict

Start with one verdict: `merge as-is`, `merge after fixes`, or `redesign`.
Then include:

- `Could not verify`: every blocked or environment-limited check.
- `Named output`: structural insight not closed by the probes.
- `Disposition table`: each prior finding as `fixed`, `not fixed`, `new defect`,
  or `withdrawn (reason)`.
- Cleared categories and exact-head identity.

Use short, active, plain prose. Never merge, push, commit, or silently repair.
