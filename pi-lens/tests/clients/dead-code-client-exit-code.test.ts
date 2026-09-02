/**
 * #1736 class-sweep: vulture's runAnalyze() must never read a silent
 * nonzero-exit failure as "No dead code found". A separate file from
 * dead-code-client.test.ts (which spawns the REAL vulture binary) because
 * this suite mocks safe-spawn.js at the module level and the two must not
 * share a test process.
 */
import { describe, expect, it, vi } from "vitest";
import { PythonDeadCodeClient } from "../../clients/dead-code-client.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: vi.fn(async () => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

describe("PythonDeadCodeClient.runAnalyze exit-code discipline (#1736 sweep)", () => {
	it("reports a nonzero exit with empty stdout AND empty stderr as errored, never clean", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-vulture-silent-crash-",
		);
		try {
			const client = new PythonDeadCodeClient(false) as unknown as {
				resolved: { cmd: string; prefix: string[] } | null;
				runAnalyze: (root: string) => Promise<{
					success: boolean;
					summary: string;
					unusedExports: unknown[];
				}>;
			};
			client.resolved = { cmd: "vulture", prefix: [] };

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "",
				stderr: "",
			} as never);

			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(false);
			expect(result.summary).not.toMatch(/no dead code found/i);
			expect(result.unusedExports).toHaveLength(0);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("still reports a genuine clean run (exit 0, empty stdout) as clean", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-vulture-genuine-clean-",
		);
		try {
			const client = new PythonDeadCodeClient(false) as unknown as {
				resolved: { cmd: string; prefix: string[] } | null;
				runAnalyze: (
					root: string,
				) => Promise<{ success: boolean; summary: string }>;
			};
			client.resolved = { cmd: "vulture", prefix: [] };

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			} as never);

			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(true);
			expect(result.summary).toMatch(/no dead code found/i);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});
});
