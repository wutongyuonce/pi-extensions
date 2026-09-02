/**
 * #1731 sweep findings for vulture (PythonDeadCodeClient):
 *
 * - Discipline B: `ensureAvailable()` probed bare `vulture` / `python -m
 *   vulture` / `python3 -m vulture` on PATH only — no `<root>/.venv/bin/
 *   vulture` check, unlike sqlfluff's venv-first binary resolution
 *   (`runner-helpers.ts` `createVenvFinder`). A project's own venv vulture
 *   (the version its dependency set was actually resolved against) never got
 *   a look-in ahead of whatever `vulture` happened to answer on PATH.
 * - Discipline A: `runAnalyze` always passed `--min-confidence` and
 *   `--exclude`, which override `[tool.vulture]` in the project's own
 *   `pyproject.toml`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.fn(
	async (
		..._args: unknown[]
	): Promise<{
		error: Error | null;
		status: number | null;
		stdout: string;
		stderr: string;
	}> => ({ error: null, status: 0, stdout: "", stderr: "" }),
);
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

describe("PythonDeadCodeClient (vulture) — project-first resolution (#1731)", () => {
	const tmpDirs: string[] = [];

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockImplementation(async () => ({
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		}));
	});

	afterEach(() => {
		while (tmpDirs.length > 0) {
			const dir = tmpDirs.pop();
			if (dir && fs.existsSync(dir)) removeTempDirSync(dir);
		}
	});

	it("probes the project's own .venv vulture before any bare PATH candidate (discipline B)", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-venv-");
		tmpDirs.push(env.tmpDir);
		const isWin = process.platform === "win32";
		const venvBin = isWin
			? path.join(env.tmpDir, ".venv", "Scripts")
			: path.join(env.tmpDir, ".venv", "bin");
		fs.mkdirSync(venvBin, { recursive: true });
		const venvVulture = path.join(venvBin, isWin ? "vulture.exe" : "vulture");
		fs.writeFileSync(venvVulture, "");

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient() as unknown as {
			ensureAvailable(root?: string): Promise<boolean>;
		};

		const ok = await client.ensureAvailable(env.tmpDir);
		expect(ok).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [cmd] = safeSpawnAsync.mock.calls[0] as [string, ...unknown[]];
		expect(cmd).toBe(venvVulture);
	});

	it("omits --min-confidence and --exclude when the project ships [tool.vulture] (discipline A)", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-config-");
		tmpDirs.push(env.tmpDir);
		fs.writeFileSync(
			path.join(env.tmpDir, "pyproject.toml"),
			"[tool.vulture]\nmin_confidence = 80\nexclude = ['migrations/']\n",
		);

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient() as unknown as {
			runAnalyze(root: string): Promise<unknown>;
		};

		await client.runAnalyze(env.tmpDir);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [, args] = safeSpawnAsync.mock.calls[0] as [string, string[]];
		expect(args).not.toContain(
			expect.stringMatching(/^--min-confidence=/) as unknown as string,
		);
		expect(args.some((a) => a.startsWith("--min-confidence="))).toBe(false);
		expect(args.some((a) => a.startsWith("--exclude="))).toBe(false);
	});

	it("still passes --min-confidence and --exclude with no project config", async () => {
		const env = setupTestEnvironment("pi-lens-vulture-noconfig-");
		tmpDirs.push(env.tmpDir);

		const { PythonDeadCodeClient } =
			await import("../../clients/dead-code-client.js");
		const client = new PythonDeadCodeClient() as unknown as {
			runAnalyze(root: string): Promise<unknown>;
		};

		await client.runAnalyze(env.tmpDir);
		const [, args] = safeSpawnAsync.mock.calls[0] as [string, string[]];
		expect(args.some((a) => a.startsWith("--min-confidence="))).toBe(true);
		expect(args.some((a) => a.startsWith("--exclude="))).toBe(true);
	});
});
