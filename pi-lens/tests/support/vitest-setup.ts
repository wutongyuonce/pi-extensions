// Per-worker test environment defaults (vitest `setupFiles`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect } from "vitest";
import { installGitFixtureEnv } from "./git-fixture-env.js";

// The review-graph persist is debounced in production (#260 circuit-breaker) so
// a burst of edits collapses to one write. In tests that would race disk-snapshot
// assertions, so default the debounce to 0 (synchronous write, the pre-#260
// behaviour). Tests that exercise the throttle override this in their own body
// and call `flushReviewGraphPersistsForTests()`.
process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";

// Same rationale, word index (#348 phase 2): per-edit updates schedule a
// debounced persist through the shared project-snapshot file. Default to a
// synchronous write in tests; tests exercising the throttle itself override
// this in their own body and call `flushWordIndexPersistsForTests()`.
process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "0";

// Pin the log rotation threshold to its default. It also bounds /lens-perf's
// read window, so an ambient value would resize what the perf tests parse.
process.env.PI_LENS_MAX_LOG_SIZE_MB = "10";

// Hermeticity: never let the developer's PERSONAL ~/.pi-lens/config.json leak
// into test behavior. Seen live 2026-07-11: opting into `turnSummary.enabled`
// on this machine flipped the #484 "default off-by-default" integration test
// red — the flag's default resolution consults the real global config unless
// PI_LENS_CONFIG_PATH points elsewhere. Point it at a path that never exists;
// tests that exercise config loading write their own file and set this
// themselves (loadPiLensGlobalConfig takes an explicit path parameter too).
process.env.PI_LENS_CONFIG_PATH = "/nonexistent-pi-lens-tests/config.json";

// Hermeticity (#525, same class as #515 above): never let a test write into
// the developer's REAL machine-global ~/.pi-lens (instances.json, logs,
// probe-cache.json, managed tool/bin dirs, ...). Dogfooded live 2026-07-11: a
// test-fixture instance (`Temp/pi-lens-turn-summary-*` projectRoot) from a
// test run survived in the real ~/.pi-lens/instances.json for ~17h. Every
// writer of machine-global state routes through the single helper
// `getGlobalPiLensDir()` (clients/file-utils.ts), which now respects
// PI_LENS_HOME — point it at a per-worker temp dir. Unlike PI_LENS_CONFIG_PATH
// above, a NONEXISTENT path is not fine here: the instance registry and
// loggers actively mkdir+write into this root during normal operation (e.g.
// registerInstance on session_start), so it must be a real, writable
// directory. Tests that deliberately exercise the real resolver (if any)
// should construct their own explicit override rather than unsetting this
// back to the real homedir.
process.env.PI_LENS_HOME = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-test-home-"),
);
installGitFixtureEnv(process.env.PI_LENS_HOME);

// Hand this worker the suite-wide tool template's probe cache (built once by
// prewarm-tool-home.ts globalSetup). ensureTool's probe-cache fast path then
// resolves the template's already-installed binaries instead of paying a cold
// npm install per worker. Entries point INTO the template dir — validated by
// path+mtime on every read, and executed read-only, so sharing is safe.
const toolTemplate = process.env.PI_LENS_TEST_TOOLS_TEMPLATE;
if (toolTemplate) {
	try {
		fs.copyFileSync(
			path.join(toolTemplate, "probe-cache.json"),
			path.join(process.env.PI_LENS_HOME, "probe-cache.json"),
		);
	} catch {
		// missing template file — worker simply runs cold, as before
	}
}

// #2042: per-file peak memory, for the files big enough to matter.
//
// Vitest's forks pool with `isolate: true` gives every test FILE its own child
// process (verified 2026-08-25: 20 files at `maxWorkers: 1` produced 20 distinct
// pids), so `process.resourceUsage().maxRSS` at the end of a file is that
// file's own peak, uncontaminated by its neighbours. Measured over all 740
// files of the default project: p50 93 MB, p90 389 MB, p99 1405 MB, max
// 2267 MB. The heavy tail is NATIVE memory — tree-sitter wasm grammar compiles
// and @ast-grep/napi arenas — which no V8 flag bounds and no reporter shows.
//
// What this record can and cannot say. It is an `afterAll` hook, so it only
// fires for a file that FINISHED. The file that was mid-run when the OS killed
// the job never reports its own peak. What the last lines before a kill name is
// the completed co-residents -- the memory profile of the phase the run died
// in, not the culprit. That is still far better than the nothing there was
// before, but it is circumstantial evidence, not attribution, and the
// `[mem-watch]` low-water mark is the record that says how close the run
// actually came.
//
// `maxRSS` is kilobytes on every platform: libuv normalizes the Win32 peak
// working set for `uv_getrusage`, so no per-platform scaling is needed.
const memReportThresholdMb = Number(
	process.env.PI_LENS_TEST_MEM_REPORT_MB ?? (process.env.CI ? "512" : "0"),
);
if (memReportThresholdMb > 0) {
	afterAll(() => {
		const usage = process.memoryUsage();
		const peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
		if (peakMb < memReportThresholdMb) return;
		const file = String(expect.getState().testPath ?? "unknown")
			.replace(/\\/g, "/")
			.split("/tests/")
			.pop();
		// Straight to the fork's stderr, not `console.log`: vitest intercepts
		// worker console output and routes it through the reporter, which
		// attributes it to a task and can drop it entirely for a hook that runs
		// after the last test (verified 2026-08-25 — the console form printed
		// nothing). A raw write lands in the job log unconditionally, which is the
		// whole point of a line whose only reader is a post-mortem.
		process.stderr.write(
			`[mem-file] peakRssMb=${peakMb} heapUsedMb=${Math.round(usage.heapUsed / 1048576)} externalMb=${Math.round(usage.external / 1048576)} tests/${file}\n`,
		);
	});
}
