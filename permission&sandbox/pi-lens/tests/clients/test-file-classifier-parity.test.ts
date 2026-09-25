import { describe, expect, it } from "vitest";
import { detectFileRole } from "../../clients/file-role.js";
import { isTestFile } from "../../clients/file-utils.js";
import { SOURCE_TO_TEST_PATTERNS } from "../../clients/test-runner-client.js";
import {
	buildWordIndex,
	searchWordIndex,
	type RankedFile,
} from "../../clients/word-index.js";

// #2928 and #2925: three filename predicates disagreed. Iterate the real
// discovery table so a new convention or a divergent consumer turns this red.
// Directory discovery and Rust's in-file tests are separate contracts.

const PKG = "/repo/pkg";
const BASE = "Widget";
const DOC_CONTENT = "function quux() {}";

interface DerivedRow {
	/**
	 * Concrete test-file basename the runner's discovery accepts, or none
	 * when the row carries no filename convention.
	 */
	testName: string | undefined;
	/** Co-located source basename the same convention must NOT claim. */
	sourceName: string;
}

function deriveFromRow(row: { ext: string; testExts: string[] }): DerivedRow[] {
	// A row whose every testExt equals the source extension (Rust: tests
	// live in tests/ or behind #[cfg(test)] in-file) carries NO filename
	// convention — a filename classifier cannot see it without content, so
	// the derived row keeps only the source twin and the loop below pins
	// that twin as the honest fallback (source).
	if (row.testExts.every((testExt) => testExt === row.ext)) {
		return [{ testName: undefined, sourceName: `${BASE}${row.ext}` }];
	}
	return row.testExts.map((testExt) => ({
		// Glob rows (pytest `test_*.py`, `*_test.py`) substitute the base at
		// the `*`; plain rows (`_test.go`, `Test.php`, `.test.ts`) are
		// suffixes.
		testName: testExt.includes("*")
			? testExt.replace(/\*/g, BASE)
			: `${BASE}${testExt}`,
		sourceName: `${BASE}${row.ext}`,
	}));
}

const rows = SOURCE_TO_TEST_PATTERNS.flatMap(deriveFromRow);

function scoreOf(results: RankedFile[], file: string): number {
	const result = results.find((result) => result.file === file);
	expect(result, file).toBeDefined();
	return result!.score;
}

describe("test-file classifier parity (refs #2928, #2925)", () => {
	it("agrees with the test-runner discovery table on every filename convention it dispatches on", () => {
		// One index over every derived test file, every co-located source
		// twin, and a vendor-directory control. Identical content makes the
		// BM25 base scores equal, so the demote prior is the ONLY thing that
		// can separate a test file's score from its source twin's — the
		// production relevance seam (`searchWordIndex`) is driven directly,
		// both with the prior on and with it off.
		const docs = [
			...rows.flatMap((row) =>
				[
					row.testName ? `${PKG}/${row.testName}` : undefined,
					`${PKG}/${row.sourceName}`,
				].filter((file): file is string => file !== undefined),
			),
			"/repo/vendor/Widget.ts",
		].map((file) => ({ path: file, content: DOC_CONTENT }));
		const index = buildWordIndex(docs);
		const demoted = searchWordIndex(index, "quux", {
			demoteTestVendor: true,
			limit: 100,
		});
		const plain = searchWordIndex(index, "quux", {
			demoteTestVendor: false,
			limit: 100,
		});

		for (const row of rows) {
			const sourcePath = `${PKG}/${row.sourceName}`;
			// The co-located source twin is the nearest wrong shape: no
			// classifier may claim it (reject twin of every accept row).
			expect(detectFileRole(sourcePath), sourcePath).toBe("source");
			expect(isTestFile(sourcePath), sourcePath).toBe(false);
			expect(scoreOf(demoted, sourcePath), sourcePath).toBe(
				scoreOf(plain, sourcePath),
			);

			// The Rust row's twin is asserted above and carries no test name —
			// the honest fallback for an in-file convention.
			if (row.testName === undefined) continue;
			const testPath = `${PKG}/${row.testName}`;
			expect(detectFileRole(testPath), testPath).toBe("test");
			expect(isTestFile(testPath), testPath).toBe(true);
			// The word-index relevance path must demote the test file, at the
			// unchanged 0.3 penalty (#2928 kept the relevance semantics).
			expect(scoreOf(demoted, testPath), testPath).toBeLessThan(
				scoreOf(plain, testPath),
			);
			expect(scoreOf(demoted, testPath), testPath).toBeCloseTo(
				0.3 * scoreOf(plain, testPath),
			);
		}

		// Vendor-directory demotion is the word-index's own half of the old
		// alternation and must survive the fold unchanged.
		expect(scoreOf(demoted, "/repo/vendor/Widget.ts")).toBeCloseTo(
			0.3 * scoreOf(plain, "/repo/vendor/Widget.ts"),
		);
	});

	it.each(["foo_test.go", "FooTest.php", "foo_spec.rb"])(
		"classifies and demotes the formerly divergent %s",
		(name) => {
			const file = `${PKG}/${name}`;
			const index = buildWordIndex([{ path: file, content: DOC_CONTENT }]);
			const plain = searchWordIndex(index, "quux", { demoteTestVendor: false });
			const demoted = searchWordIndex(index, "quux", {
				demoteTestVendor: true,
			});
			expect(detectFileRole(file)).toBe("test");
			expect.soft(isTestFile(file)).toBe(true);
			expect(scoreOf(demoted, file)).toBeCloseTo(0.3 * scoreOf(plain, file));
		},
	);

	it("preserves vendor penalties and fixture-only skip gates with source controls", () => {
		const vendors = [
			"test",
			"tests",
			"__tests__",
			"spec",
			"specs",
			"__mocks__",
			"vendor",
			"node_modules",
			"example",
			"examples",
			"fixture",
			"fixtures",
			".git",
			"dist",
			"build",
			"coverage",
			"VENDOR",
		];
		const paths = vendors.flatMap((dir) => [
			`/repo/${dir}/Widget.ts`,
			`/repo/x${dir}x/Widget.ts`,
			`C:\\repo\\${dir}\\Widget.ts`,
		]);
		const index = buildWordIndex(
			paths.map((path) => ({ path, content: DOC_CONTENT })),
		);
		const plain = searchWordIndex(index, "quux", {
			demoteTestVendor: false,
			limit: 100,
		});
		const demoted = searchWordIndex(index, "quux", {
			demoteTestVendor: true,
			limit: 100,
		});
		for (let i = 0; i < paths.length; i++) {
			expect(scoreOf(demoted, paths[i])).toBeCloseTo(
				scoreOf(plain, paths[i]) * (i % 3 === 1 ? 1 : 0.3),
			);
		}
		for (const file of [
			"/repo/test-utils.ts",
			"test-helper.ts",
			"/repo/data.fixture.ts",
			"/repo/data.mock.ts",
		]) {
			expect(detectFileRole(file)).toBe("source");
			expect(isTestFile(file)).toBe(true);
		}
		expect(isTestFile("/repo/Widget.ts")).toBe(false);
	});

	it("keeps test-looking Windows directories out of filename demotion", () => {
		// #2928: the exported adapter must retain file-role's Windows basename seam.
		const paths = ["C:\\repo.test.dir\\Widget.ts", "C:\\repo\\test_Widget.py"];
		const index = buildWordIndex(
			paths.map((path) => ({ path, content: DOC_CONTENT })),
		);
		const plain = searchWordIndex(index, "quux", { demoteTestVendor: false });
		const demoted = searchWordIndex(index, "quux", { demoteTestVendor: true });
		expect(scoreOf(demoted, paths[0])).toBe(scoreOf(plain, paths[0]));
		expect(scoreOf(demoted, paths[1])).toBeCloseTo(
			0.3 * scoreOf(plain, paths[1]),
		);
	});

	it("the skip-gate and the classifier agree on __tests__ directories the table does not name", () => {
		// A fold-prerequisite divergence the table cannot see: a file
		// DIRECTLY under __tests__ classified as source pre-fix (`dirname`
		// yields no trailing slash, so the old `dir.includes("/__tests__/")`
		// arm only matched when a deeper subdirectory followed) while
		// file-utils' substring arm and word-index's directory alternation
		// both said test. Delegating `isTestFile` to the classifier without
		// the full-segment arm would have silently narrowed the
		// secrets-scanner skip-gate.
		for (const filePath of [
			"/proj/__tests__/foo.ts",
			"/proj/__tests__/unit/foo.ts",
			"__tests__/unit/foo.ts",
		]) {
			expect(detectFileRole(filePath), filePath).toBe("test");
			expect(isTestFile(filePath), filePath).toBe(true);
		}
		// Anchor precision: a directory merely CONTAINING the token is not
		// the __tests__ convention.
		expect(detectFileRole("/proj/x__tests__/foo.ts")).toBe("source");
		expect(detectFileRole("/proj/__tests__x/foo.ts")).toBe("source");
	});

	it("isTestFile now inherits file-role's broader directory policy (refs #3078 review F1)", () => {
		// file-utils' deleted arms only matched `/test/`, `/tests/` and
		// `__tests__/`. Delegating to `detectFileRole` (#2928) also pulls in
		// its `/spec/`, `/specs/` and bare `[/_-]tests?|specs?$` directory
		// arms on a neutral basename — a direction file-utils never had.
		// Every `isTestFile` consumer now skips these directories too:
		// project-diagnostics/scanner's secrets scan, dispatch/dispatcher's
		// two gates, dispatch/runners/tree-sitter's per-rule skip, and the
		// pass-through-wrappers/async-noise/placeholder-comments rule gates.
		for (const filePath of [
			"/repo/spec/Widget.ts",
			"/repo/specs/Widget.ts",
			"/repo/my-test/Widget.ts",
			"/repo/integration-test/Widget.ts",
			"/repo/e2e_tests/Widget.ts",
		]) {
			expect(detectFileRole(filePath), filePath).toBe("test");
			expect(isTestFile(filePath), filePath).toBe(true);
		}
		// Control: a neutral directory is unaffected by the inherited policy.
		expect(detectFileRole("/repo/src/Widget.ts")).toBe("source");
		expect(isTestFile("/repo/src/Widget.ts")).toBe(false);
	});
});
