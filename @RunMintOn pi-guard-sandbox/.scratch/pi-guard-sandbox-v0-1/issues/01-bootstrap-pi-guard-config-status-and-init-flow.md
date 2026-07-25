# Bootstrap Pi Guard config, status, and init flow

Status: needs-triage

## What to build

Create the project-local Pi Guard bootstrap flow for v0.1. The extension should load in a clearly visible state, expose a `/guard` command for status, and support `/guard init` to create the project's `.pi/pi-guard.json` template. If the config is missing or invalid, Guard must not silently pretend to be active.

## Acceptance criteria

- [x] When `.pi/pi-guard.json` is missing, the extension loads in an explicit `uninitialized` state, Guard protections are inactive, and the UI clearly shows that state.
- [x] `/guard init` creates a complete v0.1 `.pi/pi-guard.json` template without overwriting an existing file.
- [x] A successful `/guard init` immediately activates Guard without requiring `/reload`.
- [x] If `.pi/pi-guard.json` exists but is invalid, Guard remains inactive, the UI shows `invalid-config`, and `/guard` reports the validation failure.
- [x] `/guard` without arguments shows current status, whether sandbox protection is active, and that scope is limited to agent tools only.

## Blocked by

None - can start immediately.

## Comments

- Implemented in `.pi/extensions/pi-guard/`.
- Covered by `npm test` in `.pi/extensions/pi-guard/`.
