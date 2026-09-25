# Architecture decision records

Each record is `NNNN-title.md` and uses the same short shape: number/title,
status, date, Context, Decision, Consequences, and Links. Records capture a
settled design decision; observations without a decision remain in the defect
catalog or issue history.

The catalog is the index for defect shapes. A shape that records a decision
links its ADR in `AGENTS.md`; ADR links point to the catalog shape, the issue
that supplied the question, and the PR or brief that settled it. Use `refs`
for work that remains open and `closes` only when its acceptance criteria are
complete.

## Seed catalog

| ADR | Decision | Catalog shape | Status |
|---|---|---:|---|
| [0001](0001-stale-advisory-live-arm.md) | Stale advisory arm skips disposition policy; live arm applies it. | 10 | Accepted |
| [0002](0002-workspace-hash-rendezvous.md) | `workspaceHash` is pure cross-process rendezvous derivation. | 1, 2 | Accepted |
| [0003](0003-git-guard-latch-writer.md) | Git-guard latch is a separate writer on the durable record. | 24 | Accepted |
| [0004](0004-disposition-policy-seam.md) | Dispositions fold onto `applyFindingPolicy`; no new store before measured #1892 work. | 10, 26 | Accepted |
| [0005](0005-tool-availability-enforcement-seam.md) | Tool availability is one seam by enforcement, with migrate-on-touch. | 52 | Accepted |
| [0006](0006-derived-state-benchmark-first.md) | No cross-request derived-state cache without a fresh-process benchmark. | 51 | Accepted |
| [0007](0007-end-to-end-witness-per-seam-slice.md) | Every seam slice commits an end-to-end host witness and degradation ledger artifact. | #1605 umbrella; #1892, #1816, #1193, #1894, #1844 | Accepted |
| [0009](0009-reported-path-attribution.md) | Reported-path attribution is `pathsEqual` against the runner cwd, inline at each call site. | 2, 34, 38; #1193, #3278 | Accepted |
| [0008](0008-turn-end-lane-interface.md) | One `TurnEndLane` interface; `handleTurnEnd` stays a thin orchestrator over lane modules. | #1892 umbrella; #3264, #3269 | Accepted |
