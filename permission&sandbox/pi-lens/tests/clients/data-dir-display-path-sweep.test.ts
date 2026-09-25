/**
 * #2521 — no agent-facing string may hardcode a `.pi-lens/` project-data path.
 *
 * `getProjectDataDir(cwd)` picks the store at runtime: `<cwd>/.pi-lens` only
 * when that legacy directory already exists, otherwise
 * `~/.pi-lens/projects/<slug>` or a `PILENS_DATA_DIR` location. Any string
 * that TELLS an agent (or a human reading the transcript) where a file lives
 * must therefore be built by `displayProjectDataPath` — a literal is a claim
 * the resolver is free to contradict, and did: two turn-end advisories shipped
 * `Details written to .pi-lens/cache/<name>.json`, which in a project with no
 * legacy directory names a path that does not exist. @Stark-X reported the
 * resulting `cat: ...: No such file or directory` from a live session.
 *
 * The inventory is DERIVED from the source at test-run time — every shipped
 * `.ts` under `clients/`, `tools/` and `mcp/`, comment-stripped through
 * sweep-kit's lexer (`strings: "keep"`, because the evidence IS the string)
 * and searched for the substring `.pi-lens/` inside a literal — so a NEW
 * hardcoded path fails here without anyone updating a parallel list first.
 * Clearance is per FILE, by name, with a reason (see `EXEMPT`), following
 * `tests/clients/delivery-surface-ratchet.test.ts`'s convention;
 * `auditRegistry` supplies the registered-or-fail semantics, the reason-length
 * floor, the stale-exemption check and both emptiness floors (defect shape 10:
 * a sweep that scans nothing must fail, not read as clean).
 *
 * Known limitation (documented, accepted floor, same shape as the
 * delivery-surface ratchet's): the needle is the literal substring
 * `.pi-lens/`. A path assembled at runtime from pieces (`".pi-lens" + "/cache"`)
 * is invisible here, as is a wrong path that never spells `.pi-lens` at all.
 * This closes the shape that actually recurred, not every conceivable one.
 * Clearance is also per FILE, not per line: once a file is in `EXEMPT` (e.g.
 * `clients/config-locations.ts`), a new offending literal planted anywhere in
 * that same file passes silently, since the sweep only asks "is this file
 * cleared", never "is this specific literal the one the reason describes".
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
const SCAN_DIRS = ["clients", "tools", "mcp"];

/**
 * Files whose `.pi-lens/` literals are NOT a project-data location claim.
 *
 * Keyed by repo-relative posix path. Every entry must still name a file the
 * scan flags — `auditRegistry` reports a stale one — so an exemption added for
 * a line that later moves or disappears fails loudly instead of quietly
 * widening.
 */
const EXEMPT: Readonly<Record<string, string>> = {
	"clients/config-locations.ts":
		"config FILE locations, not project data: `.pi-lens/lsp.json` genuinely " +
		"lives at the project root and `~/.pi-lens/` is the machine-global config " +
		"root — both are resolved by this module, not claimed by it",
	"clients/config-diagnostic-codes.ts":
		"diagnostic `surface` labels naming those same legacy config files, so a " +
		"user can find the file the code is complaining about",
	"clients/lens-flag-registry.ts":
		"CLI-flag help text pointing at `~/.pi-lens/config.json`, the ONE canonical " +
		"machine-global config file (getPiLensGlobalConfigPath) — a fixed location, " +
		"not a per-project store getProjectDataDir is free to move",
	"clients/runtime-tool-call.ts":
		'a path-MATCHING predicate (`normalized.includes("/.pi-lens/")` skips LSP ' +
		"auto-touch for pi-lens's own files); it claims no location and is never " +
		"rendered to anyone",
};

interface Hit {
	file: string;
	line: number;
	snippet: string;
}

/**
 * Lines carrying `.pi-lens/` inside a quote/backtick-delimited literal.
 *
 * `source` must already be comment-stripped by {@link stripSource} with
 * `strings: "keep"`, which preserves line and column layout — so the line
 * numbers reported here index the RAW file. Comments are out of scope
 * deliberately: this sweep is about text that reaches a reader, and a JSDoc
 * line describing the legacy layout misleads a maintainer at worst.
 */
export function findHardcodedDataPaths(
	file: string,
	strippedSource: string,
	rawSource = strippedSource,
): Hit[] {
	const hits: Hit[] = [];
	const rawLines = rawSource.split(/\r?\n/);
	strippedSource.split(/\r?\n/).forEach((line, index) => {
		if (!line.includes(".pi-lens/")) return;
		// Require the needle to sit inside a literal: `"…"`, `'…'` or a
		// backtick template (which may run past the end of the line).
		const inLiteral =
			/["'`][^"'`\n]*\.pi-lens\/[^"'`\n]*["'`]/.test(line) ||
			/["'`][^"'`\n]*\.pi-lens\//.test(line);
		if (!inLiteral) return;
		hits.push({
			file,
			line: index + 1,
			snippet: (rawLines[index] ?? line).trim().slice(0, 160),
		});
	});
	return hits;
}

interface Scan {
	scannedFiles: number;
	/** One entry per FILE, so a file-level exemption clears exactly one key. */
	flagged: Array<{ key: string; detail: string }>;
}

function scanRepo(): Scan {
	const byFile = new Map<string, Hit[]>();
	let scannedFiles = 0;
	for (const dir of SCAN_DIRS) {
		const root = path.join(REPO_ROOT, dir);
		if (!fs.existsSync(root)) continue;
		for (const full of listSourceFiles(root, {
			extensions: [".ts"],
			skipTests: true,
			// Vendored dependency shims are not pi-lens's own agent-facing text.
			exclude: (rel) => rel.startsWith("deps/"),
		})) {
			scannedFiles += 1;
			const rel = relativePosix(REPO_ROOT, full);
			const raw = fs.readFileSync(full, "utf8");
			const hits = findHardcodedDataPaths(
				rel,
				stripSource(raw, { strings: "keep" }),
				raw,
			);
			if (hits.length > 0) byFile.set(rel, hits);
		}
	}
	return {
		scannedFiles,
		flagged: [...byFile.entries()].map(([file, hits]) => ({
			key: file,
			detail: hits.map((h) => `L${h.line}: ${h.snippet}`).join(" | "),
		})),
	};
}

describe("project-data display-path sweep (#2521)", () => {
	it("no shipped string literal hardcodes a `.pi-lens/` project-data path", () => {
		const scan = scanRepo();
		const audit = auditRegistry({
			sweepName: "project-data display-path sweep",
			flagged: scan.flagged,
			// There is no registry to be ON here: a file either stops claiming a
			// project-data location, or it carries a reasoned exemption.
			registered: [],
			exemptions: EXEMPT,
			scannedCount: scan.scannedFiles,
			// Calibration, measured 2026-09-03: the walk sees 451 shipped .ts
			// files under clients/+tools/+mcp/. Half, rounded down to a round
			// number, is the floor — it catches a broken walk without breaking on
			// ordinary growth. Recalibrate from this test's OWN measured number.
			minScanned: 225,
			// Calibration, measured 2026-09-03: 4 files carry a `.pi-lens/`
			// literal, all four exempt config-file/predicate uses. Half is 2. If
			// this drops below 2, the DETECTOR broke — a sweep matching nothing
			// reads as clean while guarding nothing (defect shape 10).
			minFlagged: 2,
			minReasonLength: 40,
			remediation:
				"A project's data directory is resolved by getProjectDataDir(cwd) — it " +
				"is only `<cwd>/.pi-lens` when that legacy directory already exists. " +
				"Build the displayed path with displayProjectDataPath(cwd, ...segments) " +
				"from clients/file-utils.ts, or add a reasoned EXEMPT entry here if the " +
				"literal genuinely names a fixed config file rather than project data.",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});

	// The scanner's own correctness, pinned against synthetic source so a
	// regression here cannot silently empty the sweep above.
	describe("scanner probes", () => {
		const scan = (source: string): Hit[] =>
			findHardcodedDataPaths(
				"probe.ts",
				stripSource(source, { strings: "keep" }),
				source,
			);

		it("flags a literal on a code line", () => {
			const hits = scan('return "Details written to .pi-lens/cache/x.json";\n');
			expect(hits).toHaveLength(1);
			expect(hits[0]?.line).toBe(1);
		});

		it("flags a template literal too", () => {
			expect(scan("return `see .pi-lens/cache/${name}.json`;\n")).toHaveLength(
				1,
			);
		});

		it("ignores a line comment, a JSDoc line, and a block comment body", () => {
			const source = [
				"// writes .pi-lens/cache/x.json",
				"/**",
				" * persisted to `.pi-lens/cache/x.json`",
				" */",
				"/* inline .pi-lens/cache/x.json */",
				"const ok = 1;",
			].join("\n");
			expect(scan(source)).toEqual([]);
		});

		it("ignores a code line with no literal around the needle", () => {
			expect(scan("const p = joinParts(dotPiLens, cacheDir);\n")).toEqual([]);
		});

		it("does not fire on the probe-home or CSS-class spellings", () => {
			const source = [
				'return path.join(cwd, ".pi-lens-probe-home");',
				'css: { source: ".pi-lens { color: black; }" },',
			].join("\n");
			expect(scan(source)).toEqual([]);
		});

		// The reported defect, verbatim. Deleting the fix must red this.
		it("flags the exact string #2521 shipped", () => {
			const hits = scan(
				"\t\t`Details written to .pi-lens/cache/actionable-warnings.json`,\n",
			);
			expect(hits).toHaveLength(1);
			expect(hits[0]?.snippet).toContain("actionable-warnings.json");
		});
	});
});
