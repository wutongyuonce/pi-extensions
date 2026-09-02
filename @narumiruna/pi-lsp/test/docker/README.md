# Docker diagnostics matrix

This opt-in smoke matrix runs the real Pi SDK, the local pi-lsp extension, and one real language server in an isolated Linux container. Each profile creates three erroneous and three clean projects and records summarized JSON-RPC timing.

## Run one profile

From the repository root:

```bash
node packages/pi-lsp/test/docker/run-matrix.mjs rust-analyzer
```

The runner intentionally accepts exactly one profile. Omitting the profile, passing `--all`, or passing multiple profiles fails before Docker starts. Run profiles sequentially; do not run this matrix in parallel.

Raw local evidence is written to `packages/pi-lsp/test/docker/results/raw/<profile>.json` and is
gitignored. `matrix.json`, the runner, the production adapters, and their parity test are the
maintained executable evidence.

## Recorded matrix interpretation

The complete catalog was measured on 2026-07-24 as 28 separate profile invocations on Docker Desktop
Linux x86_64 with Pi 0.82.0. Each profile ran three fresh erroneous projects followed by three fresh
clean projects. The recorded outcome was 19 default-policy passes, eight customized-policy passes,
no unsupported profiles, and one unresolved profile (`kotlin-lsp`). Package/server pins and current
policy values live in `matrix.json`; do not copy this dated result into production configuration.

Measured customized policies have distinct reasons:

- `rust-analyzer` can answer an initial pull with no diagnostics and publish the real result later, so
  it receives a bounded empty-pull grace.
- Lua, Dart, Terraform, Gleam, Tinymist, and Haskell can publish their first useful diagnostics after
  an initially silent/empty push phase, so they receive bounded first-push grace.
- Intelephense can publish more than once, so it receives a bounded settle window rather than taking
  the first publication as final.

Kotlin remains unresolved for a fresh cold project. Once its Gradle/runtime environment was runnable,
fixed 15 s, 25 s, and 35 s repoll experiments still missed the first erroneous project while later
projects benefited from caches. A larger global/fixed wait would hide project-readiness behavior and
penalize clean calls, so no Kotlin-specific production delay was accepted.

The matrix distinguishes **diagnostic latency** (from `didOpen` to the first correct result) from
**full tool lifecycle** (including server startup and shutdown). ElixirLS and OCaml, for example,
produced correct diagnostics earlier than their slow full lifecycle completed; that is not evidence
for delaying diagnostics.

## What a pass proves

A profile passes only when:

- the pinned server installation/version check succeeds;
- all three fresh erroneous-project runs return at least one matching diagnostic;
- all three fresh clean-project runs return zero diagnostics; and
- Pi loaded the local extension and invoked `lsp_diagnostics` successfully.

`lsp-trace-proxy.mjs` records advertised pull support, diagnostic pulls and responses, push publications, refresh requests, and progress events. Profile-specific waits in `matrix.json` must match the built-in adapter policy; a repository test enforces this parity.

The default Nix image is pinned by `nixpkgsRevision` in `matrix.json`. SourceKit uses the versioned official Swift image because the pinned Nix Swift derivation is not available as a working binary for this Linux environment.
