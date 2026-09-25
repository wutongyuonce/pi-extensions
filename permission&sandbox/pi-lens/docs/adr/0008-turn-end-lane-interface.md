# ADR 0008: one `TurnEndLane` interface, and what stays in the composer

## Status

Accepted — 2026-09-23

## Context

`clients/runtime-turn.ts` was 4,654 lines with fourteen delivery lanes written
inline in `handleTurnEnd`. Each lane read its own store, applied its own
freshness/disposition policy, and formatted its own section into
`blockerParts`/`advisoryParts`, so the composer stated every lane's rules and no
lane could be read, tested or changed on its own. #1892's third slice deepens
the composer into a thin orchestrator over lane modules that share ONE
interface, one lane per round, with no agent-facing change.

The constraint that shapes the interface is #3264's fold: the turn-end scanner
stores share ONE `gateFindingsByPathFreshness` call, so a path two stores cite
is `stat`'d once, spends one stat budget, and writes one bounded decision
record per delivery instead of up to six. A lane that gated itself would
re-split that pass the moment a second lane existed.

The second constraint is the delivery-surface registry
(`clients/finding-delivery-gate.ts`): its `@delivery-surface:` seam scan reads
exactly `clients/runtime-turn.ts` and `tools/lens-diagnostics.ts`. Code that
renders an agent-facing section from a file that scan does not read would be an
unregistered surface, invisible to the mechanism built to enumerate them.

## Decision

**The interface** (`clients/turn-end/lane.ts`) is three stages, and nothing else — no lane id, because nothing would read one:

| Stage | Signature | Owns |
|---|---|---|
| collect | `collect(ctx) → Promise<S>` where `S` maps STORE name → `FindingFreshnessSource` | which caches to read, classification, the per-store `citedPath`/`scannedAt`/`onMissing` policy. Structured rows with source identity, never a rendered string. Calls no gate. |
| gate | `gate(gates: TurnEndLaneGates<S>, ctx) → Kept` | the policy the shared pass cannot apply: dispositions through `filterFindingsByDisposition` (the seam in `clients/dispatch/finding-policy.ts`, ADR 0004), plus any per-store existence/lifecycle contract. `Kept` is lane-private. |
| render | `render(kept, ctx) → TurnEndLaneParts` | the sections, the display cap, the tier each section belongs to, the per-store suppressed counts, and the location keys it delivered. Returns sections; never pushes. `TurnEndLaneParts` carries a field per tier the composer actually pushes and no others — an unread field is a side channel that drops a lane's output, so the advisory tier joins the type with the lane that renders one. |

`TurnEndLaneContext` is the whole window a lane gets onto the turn: `cwd`, the
hook's `signal`, `readScannerCache` (memoized per turn by the composer) and
`peekActionableWarnings`.

**Writers by axis** — what the composer keeps, and why it cannot be a lane's:

| Axis | Owner | Why |
|---|---|---|
| Path-freshness pass (stat memo, stat budget, `finding_dead_path_drop` / `finding_stale_line_demote` rows) | composer | A cross-lane resource. Per-lane gating is #3264 undone: N stat passes, N budgets, N records for one filesystem fact. A lane only DECLARES sources. |
| One read per scanner store per turn | composer (`readScannerCache` memo) | The trivy store is read by the secrets lane and by the CVE/license tiers. Two envelopes of one store in one delivery is the parallel-store shape, and the TTL boundary can fall between the reads. |
| Disposition application | lane | Per-store anchor identity; only the lane knows which `ProjectDiagnostic` adapter anchors its rows. |
| Tier order, `blockerParts`/`staleSecretParts`/`advisoryParts` accumulation, the `@delivery-surface:` tags | composer | The tags are what enumerates the surfaces; the scan reads the composer. |
| Suppressed-by-disposition notice | composer, fed per lane | One bounded notice per turn (#1616), with per-lane attribution. |
| Turn signature dedupe, `turn-end-findings` cache write, git-guard record, message cap, turn telemetry | composer | Delivery-event properties of the whole turn, not of one lane. |
| Delivered location keys | lane produces, composer consumes | One secret is reported once across tiers (#131 Mode 3). |

**Registry evidence.** A surface whose render moved into a lane keeps its
registry `file` as `clients/runtime-turn.ts`, because that is where its tagged
push seam and its gate call live. Its evidence literal is repinned from the
partition it used to read (`gitleaksGate.live,`) to the gated store object the
composer hands the lane (`gitleaksGate,`). That is a weaker pin — it no longer
states which partition feeds which tier — and the loss is recorded rather than
hidden: the live/stale split is a lane rule now, pinned behaviourally by
`tests/clients/runtime-turn-finding-freshness.test.ts` and the witness goldens.
What the pin still proves is what the registry exists for: the rows came out of
a real gate call, not a hand-built object.

**Lanes that do not fit, and are not being made to.** Test-runner findings
(generation/retirement state, a verdict rather than diagnostics, its own
provenance validation at read), the git-guard latch (a durable second
writer/consumer with a commit-gate audience) and the agent nudge (session
read/edit relevance, no findings and no freshness axis at all) stay outside
this interface. So do the package-pinned trivy CVE/license tiers: they have no
cited path, so their `collect` would declare no freshness source and their
honesty mechanism is the age label, not the gate.

**One lane is one delivery contract, not one store.** The secrets lane
(`clients/turn-end/lanes/secrets.ts`) owns BOTH secret stores, because #131
Mode 3 collapses gitleaks, trivy-secrets and ast-grep by LOCATION into one
blocker section with combined provenance, and the demoted tier merges the same
two stores. A "gitleaks-only" lane would leave every rendering rule in the
composer and move only a cache read.

## Amendment — 2026-09-23: the advisory tier joins `TurnEndLaneParts`

`TurnEndLaneParts` gains ONE field, `advisoryParts?: readonly string[]`, with
the govulncheck lane (`clients/turn-end/lanes/govulncheck.ts`). This is the
amendment the Decision above anticipated ("the advisory tier joins the type
with the lane that renders one"), not a widening of the rule.

**Why it was withheld until now.** The rule is "a field per tier the composer
PUSHES, and no others", because a field the composer does not read is a side
channel that silently drops a lane's whole output (AGENTS.md shape 5). The
secrets lane renders no advisory, so an `advisoryParts` shipped with the
interface would have been exactly that: a slot a later lane could fill and lose.
The field, the composer's push and the surface's registry id therefore move
together, in one round, as one claim.

**What the composer pushes it into.** `handleTurnEnd`'s `advisoryParts` array
(`clients/runtime-turn.ts`), under the existing tag
`// @delivery-surface: runtime-turn:govulncheck-advisory`, at the same position
in the tier order the inline block occupied. The tag is what makes the tier a
registered delivery surface rather than a string, and
`tests/config/turn-end-lane-boundaries.test.ts` already listed `advisoryParts`
in the tier-push rule it reds on — so a lane that pushes its own advisory was
forbidden before the field existed, and still is.

**What did NOT change.** Still three stages; still no lane id; still no fourth
method. The `runtime-turn:govulncheck-advisory` registry entry keeps its `file`,
its `gated` mode and its evidence literal `scannerGates.govulncheck` unchanged
— the composer still binds that gate arm itself and hands it to the lane, so
unlike the secrets repin nothing was weakened here.

**The interface question this lane was asked and did not need to answer.** The
brief asked how a lane declares "no freshness source" honestly, since a
package-pinned row (trivy CVE/license) has no path to stat. The state table is:

| Lane's store | has a cited path | honesty mechanism | fits the interface today |
|---|---|---|---|
| govulncheck | yes (first trace frame with a filename) | the shared gate, `onMissing: "demote"` | yes — this round |
| gitleaks / trivy-secrets | yes (`finding.file`) | the shared gate, `onMissing: "drop"` | yes — #3269 |
| trivy CVE / license | no — pinned by package, not by file | `formatCacheAgeLabel`, the registry's `labeled` mode | NO |
| a finding whose `citedPath` returns `undefined` for SOME rows | mixed | the gate leaves the uncited row live and gates the rest | yes — already handled per row |

The last row is the one that matters for "no freshness source": the gate already
takes `citedPath` returning `undefined` as "leave live", per FINDING, so a lane
with a partially-uncited store needs nothing new (the govulncheck witness pins
it: `GO-2026-0103` has an empty trace and renders by module). A store where
EVERY row is uncited is a different animal — it is not a gated lane at all, it
is a `labeled` one, and giving it a `sources: {}` `collect` would let it pass
the composer's gate with an empty declaration and look gated in the registry
while nothing checked anything. That is the second exception the brief said not
to bend the lane around, so it is not added: the labeled lanes need a `label`
stage (an age string the composer renders into the header) before they can be
extracted, and that is the design decision of the round that extracts one.

## Consequences

- The composer no longer states a govulncheck rule (2026-09-23): 4,438 →
  4,403 lines, and the six rules the block held (the `demote`/first-frame
  freshness declaration, the both-arm disposition anchor, the stale-line
  withholding and marker, the module/package fallback, the fix hint and the
  display cap) are stated once, in the lane.
- The composer no longer states a secrets rule: 4,654 → 4,438 lines, and the
  ten rules the block used to hold (cache key, classification budget and
  fail-open, blocking filter, freshness declaration, two disposition anchors
  over both arms, location dedupe, ast-grep enrichment, display cap, both
  preambles, demoted-row identity) are stated once, in the lane.
- Extracting a lane moves code out from under two mechanisms that read only
  `clients/runtime-turn.ts`, so `tests/config/turn-end-lane-boundaries.test.ts`
  walks `clients/turn-end/` and reds if a lane pushes into a tier or calls the
  freshness gate itself. Both rules name the recurrence they prevent.
- Registrations move with the code: the `bounded()` call-site registry entry,
  the one-hop unbounded-await pin, and the delivery-surface marker exemption
  all name the lane file now. A lane is a new file every directory-scanning
  governance suite sees.
- The next lanes are extracted one per round against this interface. A lane
  that needs a stage this interface does not have is a finding to report, not a
  fourth method to add quietly.

## Links

- Umbrella: #1892. Previous slices: #3264 (the shared freshness pass), #3269
  (this interface and the secrets lane).
- Witness convention: docs/adr/0007-end-to-end-witness-per-seam-slice.md.
- Disposition seam: docs/adr/0004-disposition-policy-seam.md.
- Registry and evidence rules: `clients/finding-delivery-gate.ts`.
