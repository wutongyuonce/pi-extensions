// This fixture imports the COMPILED `clients/*.js` output (relative imports
// below), not the `.ts` sources — it deliberately mirrors a real ad-hoc probe
// against the built extension rather than vitest's own hermetic harness. Run
// `npm run build` before running this file directly or via a focused
// `vitest run tests/config/global-dir-probe-redirect.test.ts` — otherwise it
// exercises stale compiled code.
//
// Deliberately spawned with NO `PI_LENS_HOME`/`VITEST`/`PI_LENS_TEST_MODE` in
// its environment (see the parent test's `runChild`) — the exact "forgot to
// pin PI_LENS_HOME" shape #2506 is about. `recordDegradationOnce` here is the
// reviewer's forensic fixture: a `config-ignored` row shaped like the ones
// that leaked into the maintainer's real `~/.pi-lens/latency.log` on
// 2026-09-02.
//
// It reports FOUR facts, because #2506 round 3 split the resolver and the
// split is the thing under test:
//   - `tmpdir:`     what `os.tmpdir()` resolves to IN THIS CHILD. The parent
//                   steers it via TEMP/TMP/TMPDIR (real Node behaviour, not a
//                   mock) so each redirect branch can be made decisive on its
//                   own; the parent asserts on this line to prove a case is
//                   not silently satisfied by a different branch.
//   - `global-dir:` `getGlobalPiLensDir()` — machine-global state (tools, bin,
//                   instances.json). MUST NOT be redirected.
//   - `log-dir:`    `getGlobalPiLensLogDir()` — the log/ledger root, the one
//                   the probe redirect applies to.
//   - `tools-dir:`  `getManagedToolsDir()`, a REAL production consumer of
//                   `getGlobalPiLensDir()` (installer `TOOLS_DIR`, captured at
//                   module scope). Asserting on the resolver alone would not
//                   prove the installer still finds its tools; this does.
import { recordDegradationOnce } from "../../clients/degradation-ledger.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import { getGlobalPiLensLogDir } from "../../clients/probe-home-state.js";
import { getManagedToolsDir } from "../../clients/installer/index.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import * as os from "node:os";

recordDegradationOnce({
	kind: "config-ignored",
	subject: "C:/p/.pi-lens.json/section3/__proto__",
	reason: "probe fixture (#2506 regression test)",
});

await flushLatencyLog();

process.stdout.write(`tmpdir:${os.tmpdir()}\n`);
process.stdout.write(`global-dir:${getGlobalPiLensDir()}\n`);
process.stdout.write(`log-dir:${getGlobalPiLensLogDir()}\n`);
process.stdout.write(`tools-dir:${getManagedToolsDir()}\n`);
