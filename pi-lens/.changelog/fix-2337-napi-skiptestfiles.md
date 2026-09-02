---
section: Fixed
---

- **Enforce ast-grep-napi's skipTestFiles on the write-group dispatch path (refs #2337)** — the napi runner declared `skipTestFiles: true`, but that flag was only checked in `RunnerRegistry.getForKind`. The jsts write-group path resolves runners by id and runs them through `runGroup`, which never consulted the flag, so the runner still ran and reported findings on `.test.ts`/`.spec.ts` files. `runGroup` now applies the same `isTestFile` gate before invoking a runner, recording a `test_file_skipped` latency status instead of silently dropping the skip. The two consumers that enumerate skip statuses — the coverage notice's `allPrimarySkipped` check and the `lsp.ran` field in `analyze` — now count `test_file_skipped` as a skip, so a file whose only primary runner was gated does not read as clean.
