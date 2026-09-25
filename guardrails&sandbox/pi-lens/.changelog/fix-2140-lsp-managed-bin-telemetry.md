---
section: Fixed
---

- **Emit availability_decision telemetry on the LSP-launch managed-bin fast path (refs #2140)** — `resolveAndLaunch`'s `~/.pi-lens/bin` resolution (clojure-lsp, cue, deno, expert, gleam, marksman, opengrep, rust-analyzer, taplo, terraform-ls, typos-lsp, zizmor, zls) now logs the same `availability_decision` record `SecurityScanClient`'s CLI-scan probe already writes: exactly one `available` row when the managed binary launches directly, and the `unavailable`-then-install-override pair when it doesn't, so the LSP-server launch path stops being invisible in `latency.log`.
