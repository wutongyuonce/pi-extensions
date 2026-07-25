# Add `workspace-write` bash policy and dangerous-command controls

Status: needs-triage

## What to build

Extend the sandboxed bash path to fully support the `workspace-write` mode and v0.1 dangerous-command policy. This slice should enforce workspace-only write access for Agent-issued bash, deny bash-based edits to Guard config, direct-block the most dangerous command classes, and require approval for the approved high-risk set.

## Acceptance criteria

- [x] In `workspace-write`, Agent-issued bash can write inside the workspace and sandbox `/tmp`, but cannot write to workspace-external real filesystem paths.
- [x] Bash-based modification of `.pi/pi-guard.json` is rejected rather than routed through approval.
- [x] Commands configured as direct-block in `.pi/pi-guard.json` are rejected immediately.
- [x] Commands configured as require-approval in `.pi/pi-guard.json` prompt for approval when UI is available.
- [x] Approval-required bash commands are denied when no UI is available.
- [x] Guard status and `/guard` output continue to make it explicit that user `!cmd` / `!!cmd` are outside scope.

## Blocked by

- `04-override-bash-with-readonly-sandbox-enforcement.md`

## Comments

- Implemented in `.pi/extensions/pi-guard/`.
- Covered by `npm test` in `.pi/extensions/pi-guard/`.
