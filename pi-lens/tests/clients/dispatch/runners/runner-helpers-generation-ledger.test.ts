/**
 * #1754 review F6: the runner-helpers stale-write ledger SUBJECTS.
 *
 * `guardedWrite`'s whole justification is that a dropped write stays
 * identifiable — "which shim", "which tool in which cwd" — rather than
 * collapsing into one anonymous counter. That claim was proven only at the
 * workspace-cache site. These pin it at the two dispatch-availability sites.
 *
 * Kept in its own file so `runner-helpers.test.ts`, whose #1674 straddle
 * regression is the behavior proof for this migration, stays untouched.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import {
	resetDispatchAvailabilityState,
	resolveAvailableOrInstall,
	findManagedNodeToolBinary,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { setupTestEnvironment } from "../../test-utils.js";

vi.mock("../../../../clients/installer/index.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../../clients/installer/index.js")
		>();
	return { ...actual, verifyToolBinary: vi.fn().mockResolvedValue(true) };
});

function staleWrites(): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary().find(
			(entry) => entry.kind === "generation-guard-stale-write",
		)?.latestReasons ?? []
	);
}

const originalHome = process.env.PI_LENS_HOME;

beforeEach(() => {
	resetDegradationLedger();
	resetDispatchAvailabilityState();
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalHome;
	resetDispatchAvailabilityState();
});

describe("dispatch-availability stale-write subjects (#1754 review F6)", () => {
	it("names the (tool, cwd) pair when a resolve/install transaction straddles a reset", async () => {
		const env = setupTestEnvironment("pi-lens-genguard-resolve-");
		try {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const checker = {
				isAvailableAsync: async (): Promise<boolean> => {
					await gate;
					return true;
				},
				getCommand: (): string | null => "toolbin",
			};

			const pending = resolveAvailableOrInstall(
				checker,
				"ledgersubjecttool",
				env.tmpDir,
			);
			// The session boundary falls inside the transaction, so its eviction
			// guard must drop rather than delete a fresh session's entry.
			resetDispatchAvailabilityState();
			release?.();
			await pending;

			const subjects = staleWrites().map((entry) => entry.subject);
			expect(subjects).toHaveLength(1);
			expect(subjects[0]).toContain("dispatch-availability:");
			// The discriminating identity: which tool, in which cwd.
			expect(subjects[0]).toContain("ledgersubjecttool@");
			expect(subjects[0]?.toLowerCase()).toContain(
				path.basename(env.tmpDir).toLowerCase(),
			);
		} finally {
			env.cleanup();
		}
	});

	it("names the shim stamp when a managed verification straddles a reset", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-genguard-managed-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			resetDegradationLedger();
			const shim =
				process.platform === "win32"
					? path.join(
							env.tmpDir,
							"tools",
							"node_modules",
							".bin",
							"subjtool.cmd",
						)
					: path.join(env.tmpDir, "tools", "node_modules", ".bin", "subjtool");
			fs.mkdirSync(path.dirname(shim), { recursive: true });
			fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");

			let boundaryCrossed = false;
			vi.mocked(installerMod.verifyToolBinary).mockImplementation(
				async (_bin, _onVersion, onTransient) => {
					if (!boundaryCrossed) {
						boundaryCrossed = true;
						resetDispatchAvailabilityState();
					}
					onTransient?.();
					return false;
				},
			);

			await findManagedNodeToolBinary("subjtool");

			const subjects = staleWrites().map((entry) => entry.subject);
			// Two drops, one identity: the verdict memo write and the in-flight
			// eviction, both for THIS shim. `incrementDegradationCount` keeps one
			// entry per subject, so a stuck shim cannot storm the ledger.
			expect(subjects).toHaveLength(1);
			expect(subjects[0]).toContain("dispatch-availability:");
			expect(subjects[0]).toContain("subjtool");
			// The stamp is `<path>:<mtimeMs>:<size>` — the size tail proves the
			// whole stamp survived, not just the path.
			expect(subjects[0]).toMatch(/subjtool(\.cmd)?:[\d.]+:\d+$/);
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});

	it("stays silent when no reset straddles the transaction", async () => {
		const env = setupTestEnvironment("pi-lens-genguard-quiet-");
		try {
			await resolveAvailableOrInstall(
				{
					isAvailableAsync: async (): Promise<boolean> => true,
					getCommand: (): string | null => "toolbin",
				},
				"quiettool",
				env.tmpDir,
			);
			expect(staleWrites()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
