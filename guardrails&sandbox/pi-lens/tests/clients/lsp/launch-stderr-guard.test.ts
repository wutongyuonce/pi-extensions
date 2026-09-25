/**
 * #2095 fix-round F1 — the launch.ts sibling guard was reviewed as vacuous:
 * no test actually drove `readWindowsRegistryPath`'s failure path, so
 * reverting the `stdio` override there redded nothing.
 *
 * `runStderrGuardedProbe` (the extracted seam `readWindowsRegistryPath` calls
 * with the fixed `powershell.exe` command) is exported so a test can pass a
 * command guaranteed to fail with real stderr output, with no real Windows or
 * powershell.exe required. This spawns a REAL child Node process (no mocking
 * of `node:child_process`) that requires the compiled `clients/lsp/launch.js`
 * and calls `runStderrGuardedProbe("git", ["not-a-real-subcommand"])`, which
 * genuinely fails and genuinely writes to stderr. The child's own stderr is
 * inherited straight from the grandchild `git` process pre-fix, so this test
 * observes the real leak rather than asserting on mocked call arguments.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitFixtureEnv, hasGit } from "../../support/git-fixture-env.js";

const LAUNCH_JS = path.resolve(__dirname, "../../../clients/lsp/launch.js");

describe("launch.ts runStderrGuardedProbe stderr suppression (#2095)", () => {
	it.skipIf(!hasGit())(
		"does not leak the probed command's stderr when it fails",
		() => {
			const script = [
				`const { runStderrGuardedProbe } = require(${JSON.stringify(LAUNCH_JS)});`,
				'const result = runStderrGuardedProbe("git", ["not-a-real-subcommand"]);',
				// Print the resolved value so the test can prove the failure path
				// was actually taken (the empty-string fallback), not skipped.
				'process.stdout.write("RESULT:" + JSON.stringify(result));',
			].join("\n");

			const result = spawnSync(process.execPath, ["-e", script], {
				encoding: "utf-8",
				env: gitFixtureEnv(process.cwd()),
			});

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			// Proves the probe actually ran its failure path — not that the
			// child silently crashed or the require target was missing.
			expect(result.stdout).toContain('RESULT:""');
			// The bug: git's raw "not a git command" line lands on the child's
			// own stderr, unfiltered by any try/catch inside the probe.
			expect(result.stderr).not.toMatch(/not a git command/i);
		},
	);
});
