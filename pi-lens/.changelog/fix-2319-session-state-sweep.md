---
section: Fixed
---

- **Session-state sweep flags process-singleton-backed state and accepts closure-located resets (refs #2319)** — the session-state conformance scan now detects `getProcessSingleton` cells and the registry accepts a reset that lives in `index.ts`'s `session_start` closure, so the declined-bind rollup, the verified-attribution tally, and the in-flight-phase bracket map register honestly instead of hiding in a blind spot. The verified-attribution tally now rides `getProcessSingleton` (the same shape its sibling rollup chose), so module re-evaluation can no longer undercount it.