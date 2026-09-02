---
name: merge-train
description: Run the pi-lens review → verify → merge policy over one or more open PRs. Use when asked to land a PR, babysit the merge queue, or process review backlogs. Encodes the standing quality gates so any session applies the same discipline.
---

# Merge train

The policy that landed the 2026-08-17 arc (11 PRs, every one adversarially
reviewed, zero unreviewed merges). Apply it to each PR in the queue.

## The loop, per PR

1. **Review.** Spawn `pi-lens-reviewer` (worktree isolation) with the PR
   number, a one-paragraph summary of the claim, and any PR-specific attack
   angles. Self-authored and small PRs get reviewed too — no exceptions.
2. **Fix rounds.** Send findings back to the PR's original author agent when
   its worktree survives (SendMessage — cheapest context); otherwise spawn
   `pi-lens-fixer` on the branch with the findings inlined. Reviewer
   worktrees may be pruned after their report; **fixer worktrees stay until
   the PR merges** (pruning breaks resume).
3. **Verify.** The SAME reviewer verifies each fix round with its own probes.
   Do not take the fixer's word; do not swap reviewers mid-PR.
4. **Merge gate.** Merge only when: verdict is merge-ready; Unit tests and
   Lint genuinely EXECUTED and passed on the exact head SHA (read check-runs —
   a DIRTY PR silently skips them, absent is not green); every failing check
   was read and judged (infra failures — codeload 429/503, SARIF-upload
   errors, Initialize-CodeQL outages — may be waved through only with the
   log read and the judgment recorded).
5. **Merge.** `gh pr merge <N> --merge` (merge commit, repo convention).
   If "not up to date", `gh api -X PUT .../pulls/<N>/update-branch`, wait for
   CI, re-gate, merge. On GitHub 503s: retry with backoff, never switch to
   raw-API merge endpoints.
   Alternative, once the verdict is in: apply the `train:approved` label (add
   `train:squash` for a squash merge) and let the merge-train lane workflow
   land it (#2185). The lane merges only when both required checks have
   CONCLUDED success on the exact current head, so a fix round pushed after
   labeling re-gates itself. Removing the label aborts. Steps 1 through 4 are
   unchanged: only the maintainer applies the label, and only after the
   review verdict.
6. **After each merge.** Master moved: check other open PRs for BEHIND/DIRTY,
   check in-flight agents for file overlap with the merged diff and nudge
   affected ones to merge origin/master before their next push.

## Queue ordering

Order by dependency, not age: a PR whose schema/API another PR must consume
merges first (the consumer then rebases and wires the new surface). Two PRs
editing the same file get an explicit order decided up front. Log-schema
changes must extend exact-key pins (`BASELINE_KEYS`-style), never loosen them.

## Honesty rules

- A finding is real when a probe proves it; a fix is real when the same probe
  passes and the regression test was red first.
- `closes` vs `refs` follows delivery, not optimism; leftovers get an issue
  comment before anything closes.
- Report what ran, what was skipped, and what CI must still confirm.
