/**
 * #2443 — one process-table seam, mechanically.
 *
 * Five hand-rolled snapshotters (Windows `Get-CimInstance Win32_Process`
 * plus POSIX `ps -eo`) had grown across `clients/` and `scripts/`: the
 * instance reaper, both resource-sampler queries, the compat smoke and the
 * worktree-prune hook. Same projection, same "fail to an empty table" shape,
 * five copies — so PR #2438's exit-code hardening reached one of them and
 * not the others.
 *
 * A comment saying "use the seam" is not a guard. This walks the shipped
 * source trees and the scripts tooling for the query fragments themselves
 * and requires that exactly one file spells them: the seam,
 * `scripts/lib/process-scan.mjs`.
 *
 * Comments are BLANKED and string contents are KEPT (`strings: "keep"`), so
 * the sweep matches the query a file actually BUILDS, never prose about it —
 * a module docstring is still free to explain why the platform listing looks
 * the way it does.
 *
 * The seam itself is `registered`, not exempted, which is what keeps the
 * sweep alive: it always flags at least one file, so a walk that silently
 * stopped finding anything reds instead of reading as clean (defect shape
 * 10).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The one file allowed to spell a platform process-table query. */
const SEAM = "scripts/lib/process-scan.mjs";

/**
 * The query fragments themselves. Each is a piece of platform syntax that
 * only a process-table snapshotter has any reason to emit:
 *
 * - `Get-CimInstance` / `Win32_Process`: the Windows CIM listing;
 * - a bare `-eo` argument: `ps`'s "every process, these columns" projection;
 * - a `pid=,` column list: the `-o pid=,args=` header-suppressed projection
 *   used by the pid-filtered `ps` form.
 */
const QUERY_FRAGMENTS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
	{ name: "Get-CimInstance", pattern: /Get-CimInstance/ },
	{ name: "Win32_Process", pattern: /Win32_Process/ },
	{ name: "ps -eo projection", pattern: /(?<![\w-])-eo(?![\w-])/ },
	{ name: "ps -o pid= projection", pattern: /(?<![\w-])pid=,/ },
];

/** The shipped runtime plus the scripts tooling — every tree that could grow
 *  a sixth copy. `clients/` is scanned as TypeScript only: the sibling
 *  `clients/*.js` are gitignored build output of those same sources. */
const SCAN_ROOTS: ReadonlyArray<{ dir: string; extensions: string[] }> = [
	{ dir: "clients", extensions: [".ts"] },
	{ dir: "commands", extensions: [".ts"] },
	{ dir: "mcp", extensions: [".ts"] },
	{ dir: "tools", extensions: [".ts"] },
	{ dir: "scripts", extensions: [".mjs", ".js", ".cjs"] },
];

function scannedFiles(): string[] {
	const files = SCAN_ROOTS.flatMap(({ dir, extensions }) => {
		const root = path.join(REPO_ROOT, dir);
		if (!fs.existsSync(root)) return [];
		return listSourceFiles(root, { extensions, skipTests: true });
	}).map((file) => relativePosix(REPO_ROOT, file));
	const entry = path.join(REPO_ROOT, "index.ts");
	if (fs.existsSync(entry)) files.push("index.ts");
	return files.sort();
}

function fragmentsIn(relativePath: string): string[] {
	const source = stripSource(
		fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
		{ strings: "keep" },
	);
	return QUERY_FRAGMENTS.filter(({ pattern }) => pattern.test(source)).map(
		({ name }) => name,
	);
}

describe("process-table seam (#2443)", () => {
	it("detects each query fragment independently", () => {
		// The sweep is only as good as its needles: pin each one against the
		// literal it exists to catch, so a silently-broken pattern reds here
		// rather than quietly widening the tree.
		const strippedKeepsStrings = stripSource(
			'const q = "Get-CimInstance -Query \\"SELECT ProcessId FROM Win32_Process\\"";',
			{ strings: "keep" },
		);
		expect(/Get-CimInstance/.test(strippedKeepsStrings)).toBe(true);
		expect(/Win32_Process/.test(strippedKeepsStrings)).toBe(true);
		expect(/(?<![\w-])-eo(?![\w-])/.test('["-eo", "pid=,ppid=,args="]')).toBe(
			true,
		);
		expect(/(?<![\w-])pid=,/.test('"pid=,args="')).toBe(true);
		// ...and never on prose, which stripSource blanks.
		expect(
			/Win32_Process/.test(
				stripSource("// POSIX ps and Windows Win32_Process listings\n", {
					strings: "keep",
				}),
			),
		).toBe(false);
	});

	it("keeps the platform process-table query in exactly one file", () => {
		const files = scannedFiles();
		const flagged = files.filter((file) => fragmentsIn(file).length > 0);

		const audit = auditRegistry({
			sweepName: "process-table seam",
			flagged,
			registered: [SEAM],
			scannedCount: files.length,
			// Calibration: 900+ source files across clients/, commands/, mcp/,
			// tools/, scripts/ and index.ts on 2026-09-02. The floor is set well
			// under that so it survives ordinary churn while still failing loud
			// if the walk ever resolves to nothing (defect shape 10).
			minScanned: 300,
			minFlagged: 1,
			remediation:
				`Build the query through ${SEAM} (buildProcessQuery/snapshotProcesses, ` +
				"or clients/process-snapshot.ts for the clients-side spawn rails) " +
				"instead of spelling Get-CimInstance/ps -eo again. Five copies of " +
				"this listing meant PR #2438's exit-code hardening reached one of " +
				"them and not the rest.",
		});

		expect(audit.problems).toEqual([]);
		expect(
			flagged.filter((file) => file !== SEAM),
			`files spelling a process-table query outside ${SEAM}`,
		).toEqual([]);
	});
});
