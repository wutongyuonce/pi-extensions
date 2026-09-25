/**
 * #2455 fix round 3 — behavioral coverage for `createToolchainAvailability`'s
 * `reset()` seam and its in-flight boundary.
 *
 * Round 2 shipped `reset()` (and the `resetGoAvailability` /
 * `resetRustAvailability` production wiring on top of it) with ZERO behavioral
 * coverage: the review neutered its body to a no-op and nine suites / 223 tests
 * stayed green, because the only thing asserting the seam existed was the
 * session-state sweep's symbol-count pin, which reads the EXPORT and never
 * calls it.
 *
 * These tests use no spawn and no module mock. `candidate-probe.ts` resolves a
 * candidate containing a path separator with `fs.existsSync`, so "the toolchain
 * appears between two calls" is a real temp file created between them — the
 * exact transition `reset()` exists for (a go/cargo install landing mid-process
 * after a probe-class `missing` verdict latched, which `isLatchingOutcome`
 * never expires).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolchainAvailability } from "../../clients/dispatch/runners/utils/toolchain-availability.js";

const tmpDirs: string[] = [];

/** A path-separator candidate that does not exist yet. `install()` creates it. */
function pendingToolchain(slug: string): {
	candidatePath: string;
	install: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-tc-${slug}-`));
	tmpDirs.push(dir);
	const candidatePath = path.join(dir, "toolchain-bin");
	return {
		candidatePath,
		install: () => fs.writeFileSync(candidatePath, "#!/bin/sh\n"),
	};
}

/**
 * A toolchain whose ONLY candidate is `candidatePath`. Both platform lists get
 * it so the test exercises the same branch on Windows and POSIX, and the tool
 * name is unique per test so the module-level probe-flight registry — shared
 * across instances by key (#2131) — cannot alias two tests together.
 */
function availabilityFor(tool: string, candidatePath: string) {
	return createToolchainAvailability({
		tool,
		label: tool,
		windowsPaths: [candidatePath],
		unixPaths: [candidatePath],
		probeArgs: ["--version"],
		budgetMs: 3_000,
		log: () => {},
	});
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("createToolchainAvailability reset (#2455 fix round 3, F1)", () => {
	it("re-probes a toolchain installed after a latched 'missing' verdict", async () => {
		const { candidatePath, install } = pendingToolchain("f1");
		const availability = availabilityFor("f1-toolchain", candidatePath);

		// Session A: genuinely absent, and a probe-class miss latches forever.
		expect(await availability.isAvailable()).toBe(false);

		install();

		// Still session A: the latch is the point, so the install is invisible.
		expect(await availability.isAvailable()).toBe(false);

		// Session B. Without `reset()`'s body this stays false for the life of
		// the process — the #1496/#1535 shape the seam was added for.
		availability.reset();
		expect(await availability.isAvailable()).toBe(true);
		expect(await availability.findPath()).toBe(candidatePath);
	});
});

describe("createToolchainAvailability reset across an in-flight probe (#2455 fix round 3, F2)", () => {
	it("does not let a pre-reset probe re-latch its verdict after the reset", async () => {
		const { candidatePath, install } = pendingToolchain("f2-latch");
		const availability = availabilityFor("f2-latch-toolchain", candidatePath);

		// Start the sweep, then reset while it is still in flight: the probe
		// promise is pending across the reset, exactly as a real sweep spanning a
		// session boundary is.
		const inFlight = availability.isAvailable();
		availability.reset();
		install();

		// The pre-reset flight settles LAST. Its verdict answers the session that
		// already ended; without the generation guard it writes "missing" into
		// the latch `reset()` just cleared, and session B inherits it.
		expect(await inFlight).toBe(false);

		expect(await availability.isAvailable()).toBe(true);
	});

	it("does not let a post-reset caller join the pre-reset flight", async () => {
		const { candidatePath, install } = pendingToolchain("f2-join");
		const availability = availabilityFor("f2-join-toolchain", candidatePath);

		// No await between these four statements, so the pre-reset sweep AND the
		// pre-reset availability flight are both still registered when the
		// post-reset caller arrives. Joining either one serves it the stale
		// "missing" answer.
		const preReset = availability.isAvailable();
		availability.reset();
		install();
		const postReset = availability.isAvailable();

		expect(await preReset).toBe(false);
		expect(await postReset).toBe(true);
	});
});

describe("createToolchainAvailability findPath across a reset (#2455 fix round 4, F3)", () => {
	it("does not memoize a path found before a reset that removed it", async () => {
		const { candidatePath, install } = pendingToolchain("f3-removed");
		install();
		const availability = availabilityFor("f3-removed-toolchain", candidatePath);

		// A separator-bearing candidate is resolved with `fs.existsSync`, so this
		// sweep is already committed to "found" when the two synchronous
		// statements below run; only its post-await WRITE is still pending.
		const inFlight = availability.findPath();
		availability.reset();
		fs.rmSync(candidatePath);

		// The pre-reset flight answers its own callers honestly: at the moment it
		// looked, the toolchain was there.
		expect(await inFlight).toBe(candidatePath);

		// It must not write that path into the memo `reset()` just cleared.
		// Without findPath's supersede guard the superseded sweep latches a path
		// that no longer exists, and `if (toolPath) return toolPath` serves it
		// forever — an INVERSION: the reset that exists to un-latch a false
		// "missing" instead latches a false "found" for a toolchain that is gone.
		expect(await availability.findPath()).toBeNull();
		expect(await availability.isAvailable()).toBe(false);
	});
});
