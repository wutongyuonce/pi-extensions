/**
 * The project scan must not read a file no consumer can use (#2424 review, F2).
 *
 * Before #2424 the scanner's ext -> grammar map only listed languages that also
 * shipped a `rules/tree-sitter-queries/<lang>/` dir, so `if (!langId &&
 * !factEligible && !astGrepLang) continue` doubled as a "has any consumer" gate.
 * Widening the map to the registry's full grammar column (bash, dart, elixir,
 * lua, ocaml, swift, zig — grammars with no rule dir) turned that gate into
 * "has a grammar": every such file was then `readFileSync`'d on every scan and
 * counted into the cache-stats `fileCount` that the code beside it claims stays
 * "comparable to the historical phase-major scans".
 *
 * Red on the pre-fix head: `helper.lua` IS read, and fileCount is 2.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import { _resetSharedTreeSitterClientForTests } from "../../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "../test-utils.js";

/**
 * Every path `readFileSync` was called with anywhere in the scan's module
 * graph. `vi.spyOn(fs, ...)` cannot patch a node builtin's ESM namespace, so
 * the wrapper is installed at module-mock level instead — the scanner imports
 * `* as fs from "node:fs"` and calls `fs.readFileSync`, so it resolves through
 * this mock.
 */
const reads = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
		if (typeof args[0] === "string") reads.push(args[0]);
		return actual.readFileSync(...args);
	}) as typeof actual.readFileSync;
	return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const calls = vi.hoisted(
	() =>
		[] as Array<
			Parameters<
				typeof import("../../../clients/tree-sitter-logger.js").logTreeSitterCacheStats
			>[0]
		>,
);

vi.mock("../../../clients/tree-sitter-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/tree-sitter-logger.js")
		>();
	return {
		...actual,
		logTreeSitterCacheStats: (
			options: Parameters<typeof actual.logTreeSitterCacheStats>[0],
		) => {
			calls.push(options);
			return actual.logTreeSitterCacheStats(options);
		},
	};
});

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scanner-consumerless-"));
	calls.length = 0;
	reads.length = 0;
});

afterEach(() => {
	removeTempDirSync(tmp);
	_resetSharedTreeSitterClientForTests();
});

const readCountFor = (filePath: string): number =>
	reads.filter((p) => path.resolve(p) === path.resolve(filePath)).length;

describe("project scan skips files no consumer can use (#2424 review F2)", () => {
	it("neither reads nor counts a .lua file in a project with no lua rules dir", async () => {
		fs.writeFileSync(path.join(tmp, "a.ts"), "export const v = 1;\n");
		const lua = path.join(tmp, "helper.lua");
		fs.writeFileSync(lua, "local function f() return 1 end\n");
		reads.length = 0;

		await scanProjectDiagnostics({ cwd: tmp, tier: "all" });

		// The .lua file has a loadable grammar but no rule dir, no fact-rule
		// eligibility and no ast-grep binding — nothing in the pass can consume
		// its bytes, so the pass must not spend the read.
		// Soft so a pre-fix run prints BOTH halves of the defect (the wasted read
		// and the skewed count) instead of stopping at the first.
		expect
			.soft(
				readCountFor(lua),
				"helper.lua was read by a scan that has no consumer for it",
			)
			.toBe(0);

		const scan = calls.find((c) => c.scope === "project_diagnostics_scan");
		expect
			.soft(scan?.fileCount, "phase-one fileCount counted the .lua file")
			.toBe(1);
	}, 60000);

	it("still reads and counts a file whose language HAS a shipped rule dir", async () => {
		fs.writeFileSync(path.join(tmp, "a.ts"), "export const v = 1;\n");
		const java = path.join(tmp, "Main.java");
		fs.writeFileSync(java, "class Main { void go() {} }\n");
		reads.length = 0;

		await scanProjectDiagnostics({ cwd: tmp, tier: "all" });

		expect(
			readCountFor(java),
			"a java file with a shipped rule dir must still be scanned",
		).toBeGreaterThan(0);
		const scan = calls.find((c) => c.scope === "project_diagnostics_scan");
		expect(scan?.fileCount).toBe(2);
	}, 60000);
});
