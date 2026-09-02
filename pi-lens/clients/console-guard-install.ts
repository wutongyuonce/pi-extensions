// Capture this before the guard's other module initialization so host boot is
// not charged to extension evaluation (#1374). Lives in its own
// side-effect-free module (#1434 S3d) — see eval-timestamp.ts's docstring for
// why: `startup-timing.ts` needs this constant but must never trigger a
// console-guard install merely by importing it.
import { PI_LENS_EVAL_STARTED_MS } from "./eval-timestamp.js";

// #1333: install the console guard as an import side-effect so it runs before
// any other module's initialization code. Installing inside the extension
// factory is too late — by the time the factory runs, every static/transitive
// import has already evaluated, so a dependency writing to console during
// module init would still hit the TUI raw (#1338 review finding). This module
// MUST remain the first import of index.ts; the enforcement test pins that.
// installConsoleGuard() itself is idempotent and no-ops under test mode and
// PI_LENS_CONSOLE_GUARD=0.
// #1434: the guard captures only while pi-lens owns execution, so the module
// window must be open for the rest of the import graph. index.ts closes it on
// its last line; an unref'd backstop closes it if that never runs.
import {
	installConsoleGuard,
	openModuleLoadConsoleWindow,
} from "./extension-log.js";

installConsoleGuard();
openModuleLoadConsoleWindow();

// Not re-exported: nothing should import the timestamp from this module.
// `clients/startup-timing.ts` imports it straight from `eval-timestamp.ts`,
// which is what keeps that import side-effect-free (S3d). The `void` keeps
// the import from looking unused to lint while documenting that this module
// only needs the ordering (evaluate eval-timestamp.ts first), not the value.
void PI_LENS_EVAL_STARTED_MS;
