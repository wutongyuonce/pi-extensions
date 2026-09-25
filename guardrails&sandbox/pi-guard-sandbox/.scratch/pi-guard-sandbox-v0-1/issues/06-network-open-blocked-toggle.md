# Network open/blocked toggle

Status: ready-for-human

## What to build

Add a `network` toggle to Pi Guard that controls whether the sandbox blocks all outbound network access. The setting is orthogonal to mode (read-only / workspace-write) — both modes respect the same network state. Default is `"open"` (network unrestricted), matching the design doc's explicit non-goal of network isolation for v0.1.

## Acceptance criteria

- [x] `.pi/pi-guard.json` supports a top-level `"network"` field with values `"open"` or `"blocked"`. `/guard init` generates it with default `"open"`.
- [x] When `"open"`, `buildSandboxRuntimeConfig` omits `allowedDomains` from the network config, so `SandboxManager` does not apply `--unshare-net` — network traffic flows normally inside the sandbox.
- [x] When `"blocked"`, `allowedDomains` is set to an empty array, triggering `--unshare-net` without any proxy sockets — all network access fails inside the sandbox.
- [x] `/guard network on` / `/guard non` switches to `"open"`, `/guard network off` / `/guard noff` switches to `"blocked"`. Both immediately rewrite `.pi/pi-guard.json` and refresh the sandbox.
- [x] Footer status line always shows the current network state, e.g. `Guard: workspace-write · network: open` or `Guard: read-only · network: blocked`.
- [x] Network state applies equally under `readonly` and `workspace-write` modes — changing mode does not affect the network setting.

## Blocked by

None — can start immediately.
