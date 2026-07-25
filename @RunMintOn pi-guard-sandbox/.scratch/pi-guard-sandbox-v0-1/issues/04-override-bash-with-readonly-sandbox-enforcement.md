# Override `bash` with readonly sandbox enforcement

Status: needs-triage

## What to build

Override the built-in `bash` tool so Agent-issued bash commands run through `@anthropic-ai/sandbox-runtime`. This slice should deliver the readonly sandbox path end to end, including fail-closed sandbox startup behavior, practical readonly temp space, and sensitive read denial through sandbox filesystem rules.

## Acceptance criteria

- [x] Agent-issued `bash` runs through the sandbox backend instead of the host's unrestricted local bash implementation.
- [x] In `readonly`, bash can run normal commands but cannot write to the real workspace, real home, or other real persistent filesystem paths.
- [x] In `readonly`, bash can still write to sandbox-local temporary runtime locations such as `/tmp`, temporary HOME, and cache directories.
- [x] Sensitive read deny paths from `.pi/pi-guard.json` are enforced for bash reads via sandbox configuration.
- [x] If sandbox initialization or activation fails, Guard does not silently fall back to unrestricted bash and instead enters an explicit inactive/error state.

## Blocked by

- `01-bootstrap-pi-guard-config-status-and-init-flow.md`
- `02-add-runtime-mode-switching-backed-by-pi-guard-config.md`

## Comments

- Implemented in `.pi/extensions/pi-guard/`.
- Covered by `npm test` in `.pi/extensions/pi-guard/`.
