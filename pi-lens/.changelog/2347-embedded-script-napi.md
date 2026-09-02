---
section: Fixed
---

- Restore embedded-`<script>` ast-grep coverage under the napi fallback: HTML script bodies are now scanned with `language: JavaScript` rules, matching the ast-grep LSP. (#2347)