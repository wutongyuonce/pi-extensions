/**
 * #1679: scripts/playground-verify-rule.mjs's runCdp/runChrome helpers used
 * to `spawn(...)` the CDP/Chrome helper scripts and wait on the child's
 * 'close' event with NO timeout at all. A wedged/daemonized child (Chrome or
 * playground-cdp.mjs left in a bad state that never exits on its own) hung
 * the whole script forever.
 *
 * This proves the bounded fix: pointed at a never-closing fixture child
 * (tests/fixtures/never-closing-child.mjs, which ignores SIGTERM and keeps
 * the event loop alive), both helpers must still settle — via
 * safeSpawnAsync's timeout+kill — well inside the test's own timeout,
 * instead of hanging until vitest's runner kills the whole process.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCdp, runChrome } from "../../scripts/playground-verify-rule.mjs";

const NEVER_CLOSING_FIXTURE = path.join(
	process.cwd(),
	"tests",
	"fixtures",
	"never-closing-child.mjs",
);

// Bound the fixture's own spawn timeout well under the test timeout, so a
// regression back to the unbounded wait shows up as a test TIMEOUT (still a
// failure) rather than hanging the whole suite.
const FIXTURE_TIMEOUT_MS = 1_500;
const TEST_TIMEOUT_MS = 20_000;

describe("playground-verify-rule.mjs bounded child wait (#1679)", () => {
	it(
		"runCdp times out and kills a never-closing child instead of hanging forever",
		async () => {
			const start = Date.now();
			await expect(
				runCdp(["list"], {
					scriptPath: NEVER_CLOSING_FIXTURE,
					timeoutMs: FIXTURE_TIMEOUT_MS,
				}),
			).rejects.toThrow(/cdp list failed/);
			// Generous slack over FIXTURE_TIMEOUT_MS for the kill escalation itself;
			// still far short of TEST_TIMEOUT_MS / an unbounded hang.
			expect(Date.now() - start).toBeLessThan(10_000);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runChrome times out and kills a never-closing child instead of hanging forever",
		async () => {
			const start = Date.now();
			await expect(
				runChrome("launch", {
					scriptPath: NEVER_CLOSING_FIXTURE,
					timeoutMs: FIXTURE_TIMEOUT_MS,
				}),
			).rejects.toThrow(/chrome launch failed/);
			expect(Date.now() - start).toBeLessThan(10_000);
		},
		TEST_TIMEOUT_MS,
	);
});
