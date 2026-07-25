# Docker diagnostics matrix

This opt-in smoke matrix runs the real Pi SDK, the local pi-lsp extension, and one real language server in an isolated Linux container. Each profile creates three erroneous and three clean projects and records summarized JSON-RPC timing.

## Run one profile

From the repository root:

```bash
node extensions/pi-lsp/test/docker/run-matrix.mjs rust-analyzer
```

The runner intentionally accepts exactly one profile. Omitting the profile, passing `--all`, or passing multiple profiles fails before Docker starts. Run profiles sequentially; do not run this matrix in parallel.

Raw local evidence is written to `extensions/pi-lsp/test/docker/results/raw/<profile>.json` and is gitignored. The checked-in evidence summary is in [`docs/plans/archived/2026-07-24_pi-lsp-server-profiles-plan.md`](../../../../docs/plans/archived/2026-07-24_pi-lsp-server-profiles-plan.md).

## What a pass proves

A profile passes only when:

- the pinned server installation/version check succeeds;
- all three erroneous cold project runs return at least one matching diagnostic;
- all three clean cold project runs return zero diagnostics; and
- Pi loaded the local extension and invoked `lsp_diagnostics` successfully.

`lsp-trace-proxy.mjs` records advertised pull support, diagnostic pulls and responses, push publications, refresh requests, and progress events. Profile-specific waits in `matrix.json` must match the built-in adapter policy; a repository test enforces this parity.

The default Nix image is pinned by `nixpkgsRevision` in `matrix.json`. SourceKit uses the versioned official Swift image because the pinned Nix Swift derivation is not available as a working binary for this Linux environment.
