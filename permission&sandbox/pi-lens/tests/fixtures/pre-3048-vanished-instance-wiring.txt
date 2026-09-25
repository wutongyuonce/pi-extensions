import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

/**
 * End-to-end wiring guard for the #1123 item 2 vanished-instance marker: a
 * REAL session_start (registerInstance/sweepOrphans path untouched) against a
 * registry file seeded with a dead-pid entry must log the marker line BEFORE
 * sweepOrphans prunes that same entry — the two must not race the other way,
 * or the vanished set would already be empty by the time the marker runs.
 *
 * `logSessionStart` is spied (not the real writer, which no-ops under
 * `isTestMode()` — see clients/sessionstart-logger.ts) so the exact line is
 * observable without depending on real sessionstart.log I/O.
 *
 * The synthetic pid below is made dead deterministically by the test's
 * process.kill(pid, 0) seam; it never relies on the runner's process table.
 */

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: { recordToolCall: () => {}, formatWarnings: () => "" },
		complexityClient: { isSupportedFile: () => false, analyzeFile: () => null },
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async () => {},
}));

const { logSessionStartSpy } = vi.hoisted(() => ({
	logSessionStartSpy: vi.fn(),
}));
vi.mock("../clients/sessionstart-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/sessionstart-logger.js")>();
	return {
		...actual,
		logSessionStart: (msg: string) => logSessionStartSpy(msg),
	};
});

// #2512: the session_start handler kicks off registerInstance/
// logVanishedInstances/sweepOrphans fire-and-forget (session_start must not
// block on registry I/O — see index.ts's own comment at the call site) and
// this test used to bridge the gap with a fixed 50ms sleep, hoping the real
// fs read-modify-write chain landed by then. Under shared-slot contention
// (#2509 round 4's 47-file batch) it sometimes did not, and the assertions
// below raced ahead of the write. `sweepOrphans` is the LAST step of that
// chain (index.ts's `.finally(() => { void sweepOrphans(); })`), so wrapping
// it to notify a listener after it settles gives an exact, awaitable signal
// for "the whole chain has landed" instead of a wall-clock guess — the same
// shape as instance-registry.ts's own `_settleRegistryMutationsForTests`,
// just for the reaper's independent (non-tail-queued) prune write.
const { onSweepOrphansSettled, notifySweepOrphansSettled } = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	return {
		onSweepOrphansSettled: (cb: () => void): (() => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		notifySweepOrphansSettled: () => {
			for (const cb of listeners) cb();
		},
	};
});
vi.mock("../clients/instance-reaper.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/instance-reaper.js")>();
	return {
		...actual,
		sweepOrphans: async (): Promise<void> => {
			try {
				await actual.sweepOrphans();
			} finally {
				notifySweepOrphansSettled();
			}
		},
	};
});

/** Resolves the NEXT time the wrapped `sweepOrphans` above completes. Must be
 * called (to register the listener) BEFORE the action that triggers it, so
 * the completion can never be missed racing the listener's own registration. */
function waitForSweepOrphansSettled(): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = onSweepOrphansSettled(() => {
			unsubscribe();
			resolve();
		});
	});
}

function registryFilePath(): string {
	return path.join(process.env.PI_LENS_HOME as string, "instances.json");
}

describe("index session_start vanished-instance wiring (#1123 item 2)", () => {
	let tmp: string;
	let prevDataDir: string | undefined;

	beforeEach(() => {
		logSessionStartSpy.mockClear();
		// The #473 concurrent-session guard's classifier state is process-module-
		// scope (by design — it detects an in-process subagent bind sharing the
		// SAME module instance as its parent). Reset it so each test's
		// session_start is classified "primary", not a false "concurrent-
		// secondary" left over from a previous test's ctx in this same file.
		_resetSessionLifecycleForTests();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-vanished-wiring-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
	});

	afterEach(() => {
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		removeTempDirSync(tmp);
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("logs the marker for a dead-pid registry entry, then the reaper still prunes it", async () => {
		const deadPid = process.pid + 100_000;
		const realProcessKill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === deadPid && signal === 0) {
				throw Object.assign(new Error("synthetic dead pid"), { code: "ESRCH" });
			}
			return realProcessKill(pid, signal);
		});
		fs.mkdirSync(process.env.PI_LENS_HOME as string, { recursive: true });
		fs.writeFileSync(
			registryFilePath(),
			JSON.stringify({
				instances: [
					{
						pid: deadPid,
						startedAt: "2026-08-06T20:00:00.000Z",
						projectRoot: "/dead-project",
						rssBytes: 512 * 1024 * 1024,
						heartbeatAt: "2026-08-06T22:30:00.000Z",
						lspChildCount: 0,
						lspChildren: [],
					},
				],
			}),
			"utf-8",
		);

		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		// Registered BEFORE emit so the settle notification can never fire
		// before this listener exists to catch it.
		const settled = waitForSweepOrphansSettled();
		await pi.emit("session_start", {}, makeCtx({ cwd: tmp }));
		// registerInstance/logVanishedInstances/sweepOrphans are fire-and-forget
		// (session_start must not block on registry I/O); sweepOrphans is the
		// LAST step of that chain, so awaiting its settle signal proves the
		// marker log (which runs strictly before it) has already landed too.
		await settled;

		// logSessionStart (via dbg()) also carries plenty of other session_start
		// trace lines — isolate the marker line specifically.
		const markerLines = logSessionStartSpy.mock.calls
			.map((call) => call[0] as string)
			.filter((line) => line.includes("previous instance pid"));
		expect(markerLines).toHaveLength(1);
		const line = markerLines[0];
		expect(line).toContain(`previous instance pid ${deadPid}`);
		expect(line).toContain("2026-08-06T22:30:00.000Z");
		expect(line).toContain("512MB");
		expect(line).toContain("exited without shutdown");

		// The reaper's own dead-pid prune still ran afterward — the marker read
		// must not have swallowed or blocked it.
		const raw = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(raw.instances.map((i: { pid: number }) => i.pid)).not.toContain(
			deadPid,
		);
	});

	it("logs nothing when the registry has no dead entries", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		const settled = waitForSweepOrphansSettled();
		await pi.emit("session_start", {}, makeCtx({ cwd: tmp }));
		await settled;

		const markerLines = logSessionStartSpy.mock.calls
			.map((call) => call[0] as string)
			.filter((line) => line.includes("previous instance pid"));
		expect(markerLines).toHaveLength(0);
	});
});
