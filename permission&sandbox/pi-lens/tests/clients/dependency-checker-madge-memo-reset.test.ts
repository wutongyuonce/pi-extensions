/**
 * #1276: the madge managed-path memo (`DependencyChecker.resolveMadge`) is
 * keyed only by `projectRoot`, but the memoized resolution reads
 * PATH/PATHEXT, local/global tool discovery, and managed-install state — all
 * of which a mid-session install or PATH change can invalidate, and the
 * memo had no way to observe that on its own (`resolvedCommandIsStale` only
 * catches an absolute path that vanished; a bare command is never
 * revalidated).
 *
 * `resetMadgeManagedPathMemo()` is the reset hook `finishInstallAttempt()`
 * now calls, mirroring `resetSafeSpawnWindowsCommandCache` (see
 * tests/clients/installer/tool-discovery.test.ts's madge-memo test for the
 * wiring half — that a completed install actually triggers this hook). This
 * file proves the hook itself: once called, a memoized resolution is
 * dropped and the NEXT lookup re-resolves instead of serving the pre-install
 * answer for the rest of the process. Pre-fix, this hook didn't exist —
 * `resetMadgeManagedPathMemo` would be undefined and the import below would
 * fail immediately.
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();
const isSpawnableCommand = vi.fn();
// Must be fully qualified under the HOST's semantics (`isFullyQualified` in
// clients/path-utils.ts), not just POSIX-absolute — on win32 a leading "/"
// alone is ambient-drive-relative, not fully qualified, so a POSIX-only fake
// dir silently fails `classifyMadgeKind`'s `isFullyQualified(resolved)` gate
// and every resolution classifies as "path" instead of "managed" (#1498).
// `path.join` (host-native, not `path.posix`) keeps the constructed path
// consistent with `path.relative`'s host semantics too, which the
// managed-vs-local/global classification in `isWithin` relies on.
const MANAGED_TOOLS_DIR = path.join(
	process.platform === "win32" ? String.raw`C:\fake\pi-lens` : "/fake/pi-lens",
	"tools",
);

vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	getManagedToolsDir: () => MANAGED_TOOLS_DIR,
	isSpawnableCommand,
}));

describe("madge managed-path memo reset hook (#1276)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		isSpawnableCommand.mockResolvedValue(true);
		tmp = setupTestEnvironment("pi-lens-madge-memo-reset-").tmpDir;
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	it("re-resolves after resetMadgeManagedPathMemo() instead of serving the memoized answer", async () => {
		const depCheckerMod = await import("../../clients/dependency-checker.js");
		const { DependencyChecker, resetMadgeManagedPathMemo } = depCheckerMod;
		expect(resetMadgeManagedPathMemo).toBeTypeOf("function");

		// Nothing local; installer discovery hands back a bare `madge` found on
		// PATH (allowInstall: false — discovery must never install here).
		findNodeToolBinary.mockResolvedValue(undefined);
		ensureTool.mockResolvedValue("madge");

		const checker = new DependencyChecker() as unknown as {
			resolveMadge(root: string): Promise<{
				cmd: string;
				prefix: string[];
				kind: string;
			}>;
		};

		const first = await checker.resolveMadge(tmp);
		expect(first.kind).toBe("path");
		expect(first.cmd).toBe("madge");
		expect(ensureTool).toHaveBeenCalledTimes(1);
		expect(ensureTool).toHaveBeenCalledWith("madge", { allowInstall: false });

		// Same root, no install/PATH change: the memo does its job and resolution
		// is NOT repeated.
		const second = await checker.resolveMadge(tmp);
		expect(second).toBe(first);
		expect(ensureTool).toHaveBeenCalledTimes(1);

		// A managed install completes mid-session — the memo has no way to
		// observe this by itself, which is exactly the bug. Drive the reset hook
		// directly (this is what `finishInstallAttempt` now calls on success).
		resetMadgeManagedPathMemo();

		const managed = path.join(
			MANAGED_TOOLS_DIR,
			"node_modules",
			".bin",
			"madge",
		);
		ensureTool.mockResolvedValue(managed);

		const third = await checker.resolveMadge(tmp);
		// Fails on pre-fix code two ways: `resetMadgeManagedPathMemo` wouldn't
		// exist (import above throws), and even called manually there'd be no
		// memo-clearing behavior to observe — `ensureTool` would still show 1
		// call and `third` would still be the stale bare "madge" answer.
		expect(ensureTool).toHaveBeenCalledTimes(2);
		expect(third.cmd).toBe(managed);
		expect(third.kind).toBe("managed");
	});
});
