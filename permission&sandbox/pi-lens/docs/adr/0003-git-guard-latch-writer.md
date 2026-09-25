# ADR 0003: git-guard latch is a separate writer

## Status

Accepted — 2026-09-23. Amended 2026-09-23 (#3248 remainder 2): the identity
rule below is decided and implemented.

## Context

The turn-end disposition policy can change the survivor set while the
git-guard latch is read first by the commit gate. Existing edit-time code writes
the latch and synchronizes the `turn-end-findings` record; turn-end policy was a
separate actor that did neither.

### Writers by axis, re-verified against the tree at `5f5d847f9`

| Actor | Axis / timing | Latch | Durable record | Site |
|---|---|---|---|---|
| `handleToolResult` | per edit, after each dispatch | `updateGitGuardStatus(result.hasBlockers, result.output)` | `syncGitGuardRecord(…, filePath)` | `clients/runtime-tool-result.ts:2546-2549` |
| `retireInlineBlockerAndResyncGuard` | confirmed-clean verdict from `lsp_diagnostics` | `updateGitGuardStatus(false, "")` | `syncGitGuardRecord(…, filePath)` | `clients/git-guard.ts:864` |
| `markGitGuardCacheUnknown` | cache/session mismatch, untrusted provenance, pipeline error | — | marks the record unreadable | `clients/git-guard.ts:749`, `clients/runtime-tool-result.ts:928` |
| turn-end composer, blocker sections | per turn, after policy | — | `writeGitGuardRecord` (dedupe path `:4231`, main path `:4287`) | `clients/runtime-turn.ts` |
| turn-end composer, clean session | per turn, when nothing survives | — | `clearCache("turn-end-findings")`, gated on the LATCH | `clients/runtime-turn.ts:829`, `:4379` |
| turn-end disposition policy (#3246) | per turn, per finding | **nothing — the gap** | nothing | `clients/runtime-turn.ts:1068` |
| `evaluateGitGuard` | read (commit gate) | reads the LATCH first and short-circuits | read second | `clients/git-guard.ts:1164` |

PR #3254's table named five actors; re-verification adds the composer's own two
record writers, which is what decides the rule below.

### State table

Axes: blockers on the file pre-policy / post-policy · record demoted by the
freshness sweep · persisted record freshness · which reader the gate uses ·
session identity.

| # | State | Latch | Record | Gate |
|---|---|---|---|---|
| 1 | every blocker on the only file suppressed | clear | cleared by the composer's clean-session clear (now reachable) | allow |
| 2 | 2 of 4 suppressed | set | blocker sections of the survivors | block |
| 3 | file X fully suppressed, file Y still blocking | set (Y) | Y only; X's summary gone | block |
| 4 | record demoted (`stale`) by the freshness sweep | set | untouched | block |
| 5 | every blocker suppressed, test failures in the record | clear | `hasBlockers` stays true via `testFailures` | block |
| 6 | suppressed, then an unrelated clean edit next turn | stays clear (the verdict rides the record the per-edit writer re-derives from) | not rewritten with the suppressed file | allow |
| 7 | suppressed, then a NEW blocker dispatched on the same file | set again | lists the new blocker | block |
| 8 | policy ran, suppressed nothing, changed no verdict | untouched | untouched | unchanged |
| 9 | record for a file that no longer exists (snapshot drops it) | untouched | untouched | unchanged |

## Decision

The latch is an aggregate over the inline-blocker MAP, and the map carries the
policy verdict. One identity rule, no second clause:

> A record is in the gate's blocking set unless the LAST turn-end policy pass
> found every blocker it carries suppressed.

- One writer for the verdict: the turn-end composer, at the point where the
  post-policy survivor set per file is final, calls
  `resyncGitGuardAfterInlinePolicy`, which stamps
  `InlineBlockerRecord.policySuppressed` on every live record (true for a fully
  suppressed file, false for every other, so a verdict cannot outlive its pass)
  and re-derives the latch through `updateGitGuardStatus(false, "")` — the same
  re-derivation the retire path uses.
- Two readers, both deriving from the map: the latch
  (`RuntimeCoordinator.updateGitGuardStatus`) and the persisted record
  (`syncGitGuardRecord`'s `blockerContent`). The per-edit writer therefore
  honors the verdict too, without a second identity clause.
- The record keeps the suppressed entry. The policy is content-bound and
  re-derived every turn end, so retiring the entry would be silencing rather
  than filtering (AGENTS.md shape 10), and a fresh dispatch replaces the record
  wholesale, so a new blocker is never born pre-suppressed (#1198 ordering).
- No third durable writer at turn end. The composer rewrites or clears the
  record later in the SAME turn end from the same survivor set, and its clear is
  gated on the latch this pass just recomputed.

### Amendment, review round 2 (GG-3283-01): the verdict is content-bound

Round 1's rule said a verdict "cannot outlive the pass that made it" because
`applyInlineBlockerPolicyVerdicts` rewrites the whole axis each turn end. The
review probe showed that is only true while every byte change enters pi-lens
dispatch: `handleTurnEnd` returns before the policy loop when no file was
touched, and a commit can arrive with no turn end after the change at all.

Second state table, axes: did a turn end judge this record · how the bytes moved
since the verdict · is the durable record present.

| # | judged | bytes since verdict | record | gate | case |
|---|---|---|---|---|---|
| 1 | yes | unchanged | cleared | allow | `clears the latch and the record when every blocker on the file is marked` |
| 2 | yes | unchanged | present | block | `keeps the gate closed when only two of four blockers are marked` |
| 3 | yes, then an unrelated edit | unchanged | cleared | allow | `stays clear when the NEXT turn edits an unrelated clean file` |
| 4 | yes, then a dispatch of the same file | changed by dispatch | rewritten | block | `re-latches when a NEW blocker is dispatched on the same file after the mark` |
| 5 | no (no-file turn end) | unchanged | cleared | allow | `still allows the commit after an unjudged turn end that changed nothing` |
| 6 | no (no-file turn end) | changed outside dispatch | cleared | **unknown** | `keeps the gate closed when the suppressed file's bytes moved outside dispatch` |
| 7 | no turn end at all after the change | changed outside dispatch | cleared | **unknown** | same case, and `does not allow the commit after an external change to a marked file` (pi host) |
| 8 | yes, after an outside change | changed outside dispatch | re-rendered | block | the freshness sweep demotes the record before the policy loop, so it is never a survivor and the verdict is cleared |
| 9 | yes | unverifiable (no content baseline) | either | **unknown** | `keeps the gate closed for a suppressed record with no content baseline` |

One clause, added to the rule above rather than replacing it: **a suppression
verdict is a statement about BYTES, so it stands only while the file still
matches the content baseline the record carries** (`recordedHash`, the #2982
baseline the freshness sweep already compares against — and which the sweep
guarantees matched at stamping time, since a self-drifted record is demoted
before the policy loop can suppress it). The gate — the one reader that can let
a verdict OPEN a commit — confirms that before allowing, and an unverifiable
record (no baseline) fails closed. Rejected alternatives, from the table:

- a TURN generation on the stamp: reds cell 3, which is the defect #3248 is
  about (an unrelated edit must not re-block).
- invalidating verdicts at every unjudged turn end (the review's suggestion):
  leaves cells 7 and 9 open, because no turn end runs between the change and the
  commit — and reds cell 5, re-blocking a commit after a read-only turn.
  Mutation P1 in PR #3283 quotes both.
- clearing the verdict in the freshness sweep only: covers cell 8, which the
  existing rewrite already covers, and none of 6, 7 or 9.

### Amendment 3 (#3282): the record's attribution contract

Written before the first edit of #3282's fix. `blockerContent` is the rendered
blocker text the gate may quote back; it is NOT the gate's source of truth about
which files block — `blockingFiles` is (`clients/git-guard.ts:31`). The parse of
that text exists for one consumer, `syncGitGuardRecord`'s
`clearedLastKnownBlocker`, which drops `blockerContent` when the file that just
dispatched clean owns everything left in it.

Writers of `blockerContent`, re-verified at `f8fef5f72`:

| Actor | Axis / timing | Shape it writes | Site |
|---|---|---|---|
| `syncGitGuardRecord` | per edit, after each dispatch | `<path>: <formatDiagnostics(…,"blocking").trim()>` per live entry, joined `"\n"` | `clients/git-guard.ts:1013` |
| turn-end composer, main path | per turn, after the policy | `capTurnEndMessage(blockerParts.join("\n\n"))` | `clients/runtime-turn.ts:4291` |
| turn-end composer, dedupe path | per turn, duplicate signature | the same expression | `clients/runtime-turn.ts:4234` |
| `mergeGitGuardTestFailure` / `clearGitGuardTestFailure` | test-runner edges | pass `existing.blockerContent` through | `clients/git-guard.ts:1068`, `:1113` |
| `resyncGitGuardAfterInlinePolicy` | per turn, before the composer | nothing durable — the latch only | `clients/git-guard.ts:919` |

Neither of the two real writers emits one line per file, and `blockerParts` is
multi-lane: only `Unresolved from this turn — <path>:` sections
(`clients/runtime-turn.ts:1085`) name a file at all — knip (`:2147`), trivy
CRITICAL (`:2141`), the secrets lane (`:2099`) and cascade (`:1340`) do not.

> **Contract.** `blockerContent` is a sequence of per-file blocker SECTIONS. A
> section is opened by an attribution line at column 0 — `<path>: <text>` or
> `Unresolved from this turn — <path>[ (suppressed by disposition: N
> finding(s))]:` — and every following line up to the next attribution line or
> the next ZERO-LENGTH line is its rendered body, attributing nothing. The text
> is attributable iff at least one line opens a section, no line precedes the
> first section, and every section's file is named in `blockingFiles`. A clean
> per-file dispatch may clear the text iff every section in it is that file's.
>
> Zero sections is UNATTRIBUTED, never clean (#3287 round 2, HIGH-3287-1): text
> that is non-empty but all-blank opens nothing, and reading that as "nothing
> left to attribute" let a clean dispatch of an unrelated file delete a record
> whose `blockingFiles` named a different file. A record with no blocker text at
> all never reaches the parse — `syncGitGuardRecord` gates on
> `existing?.blockerContent` being truthy — so the genuine clean case is decided
> before this contract applies.

One-directional on purpose. A bijection between sections and `blockingFiles` was
#3282's second cause: the composer persists `blockingFiles: affectedFiles`
(`:4292`) — every file the turn touched plus every cascade neighbour with
diagnostics — so any turn that edited a clean file alongside a blocking one was
judged untrusted for the rest of the session. The extra direction guarded
nothing either: the clear now asks about the sections themselves, so a
`blockingFiles` entry with no section, a duplicate section and a duplicate
`blockingFiles` entry cannot make it drop a blocker another file owns. Requiring
`blockingFiles` to be NON-EMPTY is subsumed for the same reason once at least
one section is required, so that clause is gone too: an empty provenance list
cannot own a section.

Fail direction (AGENTS.md shape 48): an unattributable line keeps `unknown`. The
harm it prevents is a live CVE or leaked secret being cleared out of the gate by
a clean dispatch of the file beside it; the harm it causes is a refused commit
whose stated remedy ("re-run pi-lens checks or start a fresh session") does not
clear it, which is why the reason must be reachable only for text no writer
produces for a single file. `TurnEndFindingsCache` is unchanged by #3282 as
well: parser-side only, no field added, no writer altered.

## Consequences

The latch cannot be treated as a read-only projection of the blocker map.
Old-record parsing, the latch-first consumer, and the paired resynchronization
remain strict consumers of the next fix. `TurnEndFindingsCache` is unchanged by
this slice — the verdict is in-memory only, so a 4.2.1 commit hook reads records
written after a policy pass with no new field.

The gate now reads the blocker map itself, not only the latch memo: one content
hash per suppressed record on a commit/push attempt, and nothing when no verdict
is live. `logDecision`'s existing `git-guard` `decision` record carries the new
`inline_policy_stale` reason category with the file and tier.

Clearing the latch exposed the gate's SECOND reader, which had its own defect:
`hasCompleteBlockingProvenance` parsed `blockerContent` line by line while both
writers of that field render multi-line blocker text, so the gate answered
`blocking_provenance_untrusted` once a session had recorded any blocker —
measured on `origin/master`, independent of dispositions, filed as #3282 and
fixed under amendment 3 above. The witness golden's turns 2 and 3 flip from that
reason to `block: false`, as this slice committed them to do.

## Links

- Catalog shape: `AGENTS.md` shape 24.
- Issue: #3248.
- PR: #3254, “The git-guard latch” remainder and writers-by-axis table.
- Follow-up: #3282 (record provenance parse) — amendment 3.
