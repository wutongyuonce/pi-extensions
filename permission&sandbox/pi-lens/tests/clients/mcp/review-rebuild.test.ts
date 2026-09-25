/**
 * runRebuild spawns the resolved package manager's `run <script>` — not a
 * hardcoded npm — and surfaces which manager it used. safe-spawn and the
 * resolver are mocked so no real build runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(),
}));
vi.mock("../../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/package-manager.js")
	>()),
	resolveNodePackageManager: vi.fn(),
}));

import { resolveNodePackageManager } from "../../../clients/package-manager.js";
import {
	canRebuildPiLens,
	REBUILD_UNAVAILABLE_MESSAGE,
	runRebuild,
} from "../../../clients/mcp/review.js";
import { safeSpawnAsync } from "../../../clients/safe-spawn.js";

describe("runRebuild", () => {
	let repoRoot: string;

	beforeEach(() => {
		vi.clearAllMocks();
		repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rebuild-"));
		fs.writeFileSync(path.join(repoRoot, "tsconfig.dist.json"), "{}");
	});

	afterEach(() => {
		fs.rmSync(repoRoot, { recursive: true, force: true });
	});

	it("runs the resolved manager's script and reports it", async () => {
		vi.mocked(resolveNodePackageManager).mockResolvedValue("bun");
		vi.mocked(safeSpawnAsync).mockResolvedValue({
			stdout: "done",
			stderr: "",
			status: 0,
		});

		const outcome = await runRebuild(repoRoot, "build");

		expect(resolveNodePackageManager).toHaveBeenCalledWith(repoRoot);
		const [cmd, args] = vi.mocked(safeSpawnAsync).mock.calls[0];
		// pmBinary("bun") is bare `bun` off Windows.
		expect(cmd).toContain("bun");
		expect(args).toEqual(["run", "build"]);
		expect(outcome.ok).toBe(true);
		expect(outcome.packageManager).toBe("bun");
		expect(outcome.script).toBe("build");
	});

	it("uses npm when the resolver picks npm", async () => {
		vi.mocked(resolveNodePackageManager).mockResolvedValue("npm");
		vi.mocked(safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
			status: 0,
		});

		const outcome = await runRebuild(repoRoot, "build:dist");

		const [cmd, args] = vi.mocked(safeSpawnAsync).mock.calls[0];
		expect(cmd).toContain("npm");
		expect(args).toEqual(["run", "build:dist"]);
		expect(outcome.packageManager).toBe("npm");
	});

	it("reports failure on a non-zero exit", async () => {
		vi.mocked(resolveNodePackageManager).mockResolvedValue("pnpm");
		vi.mocked(safeSpawnAsync).mockResolvedValue({
			stdout: "",
			stderr: "boom",
			status: 1,
		});

		const outcome = await runRebuild(repoRoot, "build");
		expect(outcome.ok).toBe(false);
		expect(outcome.packageManager).toBe("pnpm");
	});

	it("refuses an installed package before resolving or spawning", async () => {
		fs.rmSync(path.join(repoRoot, "tsconfig.dist.json"));

		const outcome = await runRebuild(repoRoot, "build:dist");

		expect(outcome).toMatchObject({
			ok: false,
			output: REBUILD_UNAVAILABLE_MESSAGE,
		});
		expect(resolveNodePackageManager).not.toHaveBeenCalled();
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("refuses paths inside node_modules even when a tsconfig is present", () => {
		const installedRoot = path.join(repoRoot, "node_modules", "pi-lens");
		fs.mkdirSync(installedRoot, { recursive: true });
		fs.writeFileSync(path.join(installedRoot, "tsconfig.dist.json"), "{}");

		expect(canRebuildPiLens(installedRoot)).toBe(false);
	});
});
