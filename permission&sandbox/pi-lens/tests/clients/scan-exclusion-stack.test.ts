/**
 * #262 — every file-walker must respect the full exclusion stack.
 *
 * Table-driven guard: one fixture project carrying a default dependency dir
 * (node_modules), a build dir (dist), a `.gitignore` entry, a `.pi-lens.json`
 * `ignore` entry (both a glob and a bare filename), a real source file, and a
 * test file. Each major scan surface is asserted against the same fixture so a
 * regression in ANY surface (one that stops routing through the shared
 * exclusion helpers) fails here.
 *
 * Surfaces covered:
 *   - collectSourceFiles            (the canonical collector; no role filter)
 *   - TreeSitterClient.collectFiles (structural search walk; no role filter)
 *
 * Global-ignore precedence is exercised indirectly (getProjectIgnoreMatcher
 * merges global + .gitignore + .pi-lens.json); we assert the project-config
 * layers here to keep the fixture hermetic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { collectSourceFiles } from "../../clients/source-filter.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;

function write(rel: string, body = "export const x = 1;\n"): void {
	const full = path.join(tmpDir, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, body);
}

function relUnix(files: string[]): string[] {
	return files.map((f) => path.relative(tmpDir, f).replace(/\\/g, "/"));
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scan-exclude-"));
	resetProjectLensConfigCache();

	// The fixture every surface scans — deliberately multi-language so the
	// exclusion guarantee is shown to be language-agnostic, not TS-only (#262).
	write("src/real.ts");
	write("src/real.go");
	write("src/real.rs");
	write("src/real.test.ts");
	write("src/util_test.go"); // Go-style test naming
	write("node_modules/dep/index.ts");
	write("dist/out.ts");
	write("gitignored/x.ts");
	write("gitignored/x.go"); // ignored, non-TS
	write("lensignored/y.ts");
	write("lensignored/y.rs"); // ignored, non-TS
	write("noise.ts");
	fs.writeFileSync(path.join(tmpDir, ".gitignore"), "gitignored/\n");
	fs.writeFileSync(
		path.join(tmpDir, ".pi-lens.json"),
		JSON.stringify({ ignore: ["lensignored/**", "noise.ts"] }),
	);
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	resetProjectLensConfigCache();
});

// Paths that NO compliant surface may ever emit.
const ALWAYS_EXCLUDED = [
	"node_modules/",
	"dist/",
	"gitignored/",
	"lensignored/",
	"noise.ts",
];

// Test files in the fixture (every role-filtered surface must drop all of them).
const TEST_FILES = ["src/real.test.ts", "src/util_test.go"];

interface Surface {
	name: string;
	collect: () => string[];
	/** Real (non-test) source files this surface must surface. */
	mustInclude: string[];
	/** Whether this surface applies the test/generated role filter. */
	excludesTests: boolean;
}

function surfaces(): Surface[] {
	return [
		{
			name: "collectSourceFiles (canonical collector)",
			collect: () => collectSourceFiles(tmpDir),
			// No role filter, multi-language default extension set.
			mustInclude: ["src/real.ts", "src/real.go", "src/real.rs"],
			excludesTests: false,
		},
		{
			name: "TreeSitterClient.collectFiles (structural search)",
			collect: () =>
				// collectFiles is private; the walk needs no grammars loaded.
				// biome-ignore lint/suspicious/noExplicitAny: private method under test
				(getSharedTreeSitterClient()! as any).collectFiles(
					tmpDir,
					"typescript",
				),
			// Language-scoped by design — only the requested language's files.
			mustInclude: ["src/real.ts"],
			excludesTests: false,
		},
	];
}

describe("#262 — exclusion stack is respected by every scan surface", () => {
	for (const s of surfaces()) {
		describe(s.name, () => {
			it("includes the real source file(s)", () => {
				const rel = relUnix(s.collect());
				for (const inc of s.mustInclude) expect(rel).toContain(inc);
			});

			it("excludes dependency/build dirs + .gitignore + .pi-lens.json ignores (any language)", () => {
				const rel = relUnix(s.collect());
				for (const excluded of ALWAYS_EXCLUDED) {
					expect(
						rel.some((f) => f === excluded || f.startsWith(excluded)),
						`${s.name} must exclude ${excluded}, got: ${rel.join(", ")}`,
					).toBe(false);
				}
			});

			it(
				s.excludesTests
					? "excludes test files of every language (role filter)"
					: "retains the TS test file (no role filter by design)",
				() => {
					const rel = relUnix(s.collect());
					if (s.excludesTests) {
						for (const t of TEST_FILES) expect(rel).not.toContain(t);
					} else {
						// Non-filtered surfaces keep tests; assert at least the TS one
						// (language-scoped surfaces won't carry the Go test file).
						expect(rel).toContain("src/real.test.ts");
					}
				},
			);
		});
	}

	it("excludes ignored files regardless of language (.go/.rs under ignored dirs)", () => {
		// The exclusion stack keys on path/dir, not extension — a non-TS file
		// under an ignored dir must be dropped just like a TS one.
		for (const collect of [() => collectSourceFiles(tmpDir)]) {
			const rel = relUnix(collect());
			expect(rel).not.toContain("gitignored/x.go");
			expect(rel).not.toContain("lensignored/y.rs");
			// ...while real non-TS sources outside ignored paths survive.
			expect(rel).toContain("src/real.go");
			expect(rel).toContain("src/real.rs");
		}
	});
});
