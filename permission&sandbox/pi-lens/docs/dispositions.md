# Diagnostic Dispositions (Triage)

pi-lens diagnostics can be *triaged* instead of just read: the agent (and, in a
future release, the user via a review window — #690) can mark any finding as a
false positive, suppress it, defer it, or flag it for a fix. Marks are recorded
once, in one store, and honored by every surface that renders diagnostics — the
per-edit feedback, `lens_diagnostics` (all modes), and the widget counts.

## The tool

`lens_diagnostic_mark` is a *situational* tool (activated on demand via
`pi_lens_activate_tools` on hosts with dynamic tool loading; statically active
elsewhere). Arguments:

- `filePath` — the file the diagnostic is in
- `line` — the flagged line
- `message` — the diagnostic message (used for anchoring; a distinctive prefix
  is enough)
- `disposition` — one of `false-positive` | `suppress` | `defer` | `flagged`
- `rule` — the rule/check id exactly as shown (e.g. `no-floating-promises`,
  an LSP code); optional, but required for `suppress` (it names the rule in
  the written comment)
- `tool` — the producing tool, if known (optional)
- `reason` — optional short reason, kept alongside the disposition and logged
  for rule-tuning telemetry

## The four dispositions

| Disposition | Meaning | Lifetime | Mechanism |
|---|---|---|---|
| `false-positive` | the rule misfired here | project-persistent | store entry, **strict** anchor |
| `suppress` | real finding, deliberate policy not to fix | project-persistent, git-visible | inline `pi-lens-ignore` comment written into the source + store mirror |
| `defer` | not now, maybe later | **session-only** (in-memory) | resurfaces next session |
| `flagged` | should be fixed | persistent until the fix is observed | store entry; rendered as `📌 flagged-to-fix` in `lens_diagnostics` with the stored fix context (line, line text, reason) |

There is deliberately **no manual "fixed"** disposition: a fix is *observed*
(the finding disappears from a fresh scan), never asserted — otherwise an agent
could self-report a fix that didn't land.

## Anchor strength (what survives edits)

Marks are content-anchored to the *finding*, not to a line number, with
per-disposition binding strength:

- `false-positive` uses a **strict** anchor: rule + normalized message + a
  content hash of the flagged line itself. If that line is later rewritten,
  the mark stops matching and the rule gets a fresh chance to re-fire — a
  "false positive" verdict shouldn't outlive the code it was judged against.
  Whitespace-only changes don't break it.
- `suppress` / `defer` / `flagged` use a **weak** anchor: rule + normalized
  message only. These express intent about the *finding*, so they survive
  edits to the line and drift elsewhere in the file. (`suppress` is enforced
  by the inline comment anyway; the store entry is an audit mirror.)

Both anchors also hash the producing `tool`, so a finding that changes hands
between tools gets a fresh anchor. One such change shipped in #3041: `mode:
"full"` used to render auxiliary-scanner findings (ast-grep, opengrep, zizmor,
typos) under the generic `tool: "lsp"` while every other surface already showed
them under their real tool id. It now shows the real id everywhere, so a mark
recorded against the old `lsp`-labelled copy no longer matches and the finding
gets one fresh chance to be re-marked — under the same `tool` the per-edit path
has always used.

## Which surfaces honor a mark

Every model-facing surface that renders a diagnostic applies the same filter
stack, in the same order: inline `pi-lens-ignore` comments, then the stored
dispositions, then the project's `.pi-lens.json` `rules.<id>.disable`/`select`
policy (`clients/dispatch/finding-policy.ts`). That covers the per-edit
feedback, `lens_diagnostics` `mode=delta`/`mode=all`/`mode=full`, and — since
#3088 — the `lens_diagnostics` `source=lsp` probe lane together with the legacy
`lsp_diagnostics` tool and the MCP `pilens_lsp_diagnostics` shim that share it.
Since #3102 it also covers the two PUSH surfaces that were still unfiltered:
the turn-end **late-auxiliary advisory** (findings an auxiliary LSP published
after its grace window, drained at the next `turn_end`) and the **cold-neighbour
cascade run** (`buildResolvedFoundCascadeRun`, built in the quiet-window
reconcile). Both are pushed rather than asked for, so when a mark suppresses
everything they had to say they say nothing at all — silence on a push surface
is not a claim that the file is clean, and the drop count is recorded in the
lane's own `late_auxiliary_findings` / `cascade_finding_policy` latency row. A
delivery that still has something to say states what it dropped inline.

Before #3088 the probe lane was the one exception: it returned the raw LSP
result, so a finding marked `false-positive` stayed hidden in `delta`/`full`
and re-appeared on every probe — the lane
`skills/pi-lens-lsp-navigation` steers agents to as PRIMARY. It now filters
like every other surface, its footer reconcile writes the FILTERED set (so a
probe can no longer re-arm a finding the mark demoted), and a drop is always
stated as a count:

```text
suppressed by disposition: 1 finding(s) dropped from this result …
```

Two properties of the probe lane are worth knowing:

- **A mark converges whichever surface you made it from.** The probe renders a
  finding as `[<source>] (<code>)` while the widget footer and `mode=full`
  render the canonical `tool: "lsp"` / `rule: "<source>:<code>"`, and `tool` is
  optional on the mark tool. The probe filter matches every one of those
  spellings, so a mark made from the probe's own output works, and so does one
  made from any other surface.
- **A blocking finding still needs a strict mark.** `semantic: "blocking"`
  findings are dropped only by a content-bound `false-positive` match, never by
  a weak `suppress`/`defer` — on this lane too (#1625 F1).

## Suppression comments

`suppress` writes a pi-lens-owned ignore comment on the line immediately
**above** the flagged line (comment syntax chosen by file type,
indentation-matched, appended to an existing `pi-lens-ignore` comment when one
is already there):

```ts
// pi-lens-ignore: no-floating-promises
const x = risky();
```

This is the same convention every runner/profile honors, so a suppression is
portable, git-tracked, and visible in review — not private pi-lens metadata.

## Dual-scanner secrets need two marks

gitleaks and trivy scan for secrets independently. When both flag the same
credential on the same line, each finding gets its own anchor (`tool` +
`rule` differ: `gitleaks:<ruleId>` vs `trivy-secret:<ruleId>`), so one
`lens_diagnostic_mark` call clears only one of the two copies. The 🔴 STOP
blocker stays up, citing the still-unmarked copy, until both are marked
false-positive.

This is deliberate defense-in-depth, not a bug: a real credential that one
scanner misses still blocks. It is also strictly better than before #1691,
when the trivy copy of a corroborated finding had no anchor at all and could
never be cleared. Expect to call `lens_diagnostic_mark` twice — once per
`tool` — when `lens_diagnostics` shows the same line flagged under both
`gitleaks` and `trivy`.

The 🔴 STOP line's own bracket names which scanners still hold the finding —
`[gitleaks + trivy]` before either mark, narrowing to `[trivy]` after the
gitleaks copy clears — so a shrinking bracket, not a vanished blocker, is the
signal that one copy remains.

## Telemetry

Every mark (including in-memory `defer`) is appended as NDJSON to
`~/.pi-lens/dispositions.log` with the tool, rule, disposition, reason, and any
`previousDisposition` on re-marks — the raw signal for per-rule false-positive
rates and rule tuning. Each mark is also published on pi's shared event bus as
`pilens:diagnostic:disposition` (v1, additive-only payload; disable all bus
publishing with `PI_LENS_BUS_PUBLISH=0`).

## Storage

Persistent marks live in `diagnostic-dispositions.json` under the project data
directory (see `PILENS_DATA_DIR` in
[environment-variables.md](environment-variables.md)). Deleting the file
clears all persistent dispositions; suppression comments in source are
unaffected (they're the enforcement, not the record).
