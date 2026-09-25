import { performance } from "node:perf_hooks";

/**
 * The moment pi-lens's module graph started evaluating, captured as this
 * module's first statement (#1374 host-boot vs extension-eval split).
 *
 * This module is otherwise side-effect-free by design (#1434 S3d review): it
 * does nothing but capture a timestamp. `clients/console-guard-install.ts`
 * imports it as its FIRST import so the capture happens before the guard's
 * own install work, and `clients/startup-timing.ts` imports it too, for the
 * constant alone. Before this split, `startup-timing.ts` imported the
 * constant FROM `console-guard-install.ts` — which meant importing
 * startup-timing anywhere (e.g. a test measuring load time) silently
 * installed the console guard as a side effect. Splitting the constant out
 * means importing this module, or `startup-timing.ts`, never installs
 * anything.
 */
export const PI_LENS_EVAL_STARTED_MS = performance.now();
