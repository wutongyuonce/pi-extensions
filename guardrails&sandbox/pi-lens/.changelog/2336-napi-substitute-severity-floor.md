---
section: Fixed
---

- **The ast-grep napi fallback now reports at the LSP's severity floor (closes #2336)** — when `ast-grep-napi` stands in for the ast-grep auxiliary LSP, it evaluates the whole bundled catalog instead of only `severity: error` rules. The per-edit `blockingOnly` floor was a leftover from the runner's pre-#239 always-on role; it dropped 380 of the 481 bundled rules, so the substitute delivered a fifth of the coverage the server it replaces delivers. The runner had reported zero diagnostics in all 255 retained dispatch records, which also left #2329's napi-versus-late-LSP dedupe path with no production validation. Outside the substitute role the floor is unchanged. This narrows an earlier claim: "#2324 findings survive a silent aux LSP" previously held only for error-severity rules.
