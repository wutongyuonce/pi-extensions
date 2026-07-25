# Add optional DCG command policy engine

Status: needs-triage

## Product direction

Support `destructive_command_guard` (DCG) as an optional enhancement for Bash command risk analysis.

Pi Guard does not install, upgrade, or manage the DCG binary. Users install and maintain DCG themselves. Pi Guard may detect whether `dcg` is available and expose that status.

## Agreed direction

- DCG is optional, not a required dependency.
- Pi Guard continues to work when DCG is unavailable.
- Keep a simpler built-in Bash policy for users who do not use DCG.
- Users can continue customizing or clearing the built-in Bash policy through configuration.
- A DCG indeterminate result may be presented for explicit user approval rather than silently treated as safe.
- DCG installation and upgrades remain the user's responsibility.
- Runtime controls should distinguish the whole Guard system, the OS sandbox, and DCG.
- Product philosophy prioritizes uninterrupted flow: a missing, crashed, timed-out, or unreadable DCG result should notify the user and continue rather than suppress the Agent command.
- Each DCG outcome should have independently configurable handling so users can choose a looser or stricter posture. Defaults are discussed separately from the available configuration space.
- Default for DCG `deny`: require TUI confirmation. A human may approve the command; the Agent cannot grant its own bypass.
- Default for DCG `indeterminate`: notify and continue because this is not a confirmed dangerous finding.
- Default for a DCG runtime failure: notify once per failure episode and continue so the optional component cannot wedge the workflow.
- When DCG is enabled and healthy, it replaces the built-in Bash policy rather than running alongside it.
- Slash-command state changes are temporary for the current Pi run. Project configuration defines the defaults restored on the next start.
- Scope remains Agent tool calls only; user `!cmd` and `!!cmd` are not checked.
- The initial target is the Agent `bash` tool. Additional shell-like tool names may be configurable if their command input can be extracted safely.
- Users need visible runtime state for the Guard master switch, sandbox, DCG availability/enabled state, and active policy fallback.
- Product scope is interactive TUI use. Non-interactive confirmation behavior is not a supported product concern; the exact enforcement behavior outside TUI must be made explicit before implementation.
- Normal state may stay in a compact footer; a one-time post-message notice is only needed for reduced, overridden, or degraded protection.
- Outside interactive TUI mode, Pi Guard is completely inactive: it does not initialize or enforce the sandbox, invoke DCG, apply Guard policy, or render Guard UI.
- The first footer version uses square brackets to make extension-owned status visually distinct, for example `[Guard: workspace-write · DCG]`.
- Footer information is progressively disclosed: omit default network-open state, show `net:blocked` when relevant, show `[Guard: sandbox-off · DCG]` when the sandbox is temporarily disabled, and collapse to `[Guard: OFF]` when the master switch is off.
- Footer polish is intentionally iterative; ship a simple first version and refine it through real TUI use rather than trying to finalize every UI detail upfront.

## Intended responsibility split

- DCG: classify destructive Bash commands.
- Pi Guard: invoke the selected policy engine, present decisions to the user, and enforce the result.
- OS sandbox: constrain filesystem and network effects after a command is allowed.
- Existing path policy: protect read/write/edit tool access.

## Open product questions

- Confirm the common action vocabulary available per outcome (proposed: `allow`, `notify`, `confirm`, `block`) and the default outcome-to-action matrix.
- Which state deserves persistent footer space versus on-demand `/guard status` output?
- How should custom shell tool configuration describe command extraction when a tool does not use the standard Bash `{ command }` input shape?

## References

- `docs/research/dcg.md`
- `docs/research/dcg-pi-guard-facts.md`
- `.references/destructive_command_guard/docs/pi-integration.md`

## Comments

- Initial integration should stay small and use DCG's documented external decision interface rather than embedding DCG implementation details.
