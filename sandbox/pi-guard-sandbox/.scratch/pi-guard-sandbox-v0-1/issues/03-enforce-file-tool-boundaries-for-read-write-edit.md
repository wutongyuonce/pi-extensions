# Enforce file-tool boundaries for `read`, `write`, and `edit`

Status: needs-triage

## What to build

Implement Pi Guard policy enforcement for the built-in `read`, `write`, and `edit` tools. This slice should enforce the v0.1 file boundary model: permissive external reads with a minimal sensitive deny list, strict readonly behavior, workspace-local writes by default in `workspace-write`, and one-shot approval for explicit external writes.

## Acceptance criteria

- [x] In `readonly`, `write` and `edit` are rejected without approval.
- [x] In `workspace-write`, `write` and `edit` succeed for workspace-local paths.
- [x] In `workspace-write`, workspace-external `write` and `edit` require allow-once approval per concrete target path.
- [x] External reads are allowed by default, but reads to configured sensitive paths are denied.
- [x] Protected paths are enforced for `write` and `edit` according to `.pi/pi-guard.json`.
- [x] Editing or writing `.pi/pi-guard.json` through `write` or `edit` requires approval.
- [x] Approval-required operations are denied when no UI is available.

## Blocked by

- `01-bootstrap-pi-guard-config-status-and-init-flow.md`
- `02-add-runtime-mode-switching-backed-by-pi-guard-config.md`

## Comments

- Implemented in `.pi/extensions/pi-guard/`.
- Covered by `npm test` in `.pi/extensions/pi-guard/`.
