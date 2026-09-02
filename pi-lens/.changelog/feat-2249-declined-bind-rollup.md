---
section: Added
---

- **Roll up declined concurrent session starts (refs #2130, closes #2249)** — `logConcurrentSessionBind` (#473) previously wrote one `concurrent_session_bind` record per declined bind with nothing to aggregate them. `index.ts`'s `session_shutdown` handler now also logs one bounded `concurrent_session_bind_rollup` row per primary session, counting declines by classification (`concurrent-secondary` / `secondary-root`), a no-op when none occurred. The counter lives behind `getProcessSingleton` with its own family version, not a module-scope `let` — pi evaluates the pi-lens module graph more than once per process, and a bare `let` would only ever see the binds routed through its own copy. It resets both at the primary's own `session_start` (so a crashed prior primary can't leak a stale tally) and after each emission.
