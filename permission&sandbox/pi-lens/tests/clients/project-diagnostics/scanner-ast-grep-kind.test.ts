import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2217: the scanner hard-coded kind "jsts" for every napi-evaluated file,
// including .css/.html — mislabeling non-JS lanes and diverging from the
// per-edit dispatch path, which derives kind from detectFileKind (#2296
// review: css/html now reach the napi runner via dispatch too, so the two
// paths can disagree on the SAME file). Wrap evaluateAstGrepRules to record
// the `kind` argument the scanner actually passes.
const state = vi.hoisted(() => ({
	kinds: [] as (string | undefined)[],
}));

vi.mock(
	"../../../clients/dispatch/runners/ast-grep-napi.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../clients/dispatch/runners/ast-grep-napi.js")
			>();
		return {
			...actual,
			evaluateAstGrepRules: (
				...args: Parameters<typeof actual.evaluateAstGrepRules>
			) => {
				state.kinds.push(args[3]);
				return actual.evaluateAstGrepRules(...args);
			},
		};
	},
);

import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import { removeTempDirSync } from "../test-utils.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scanner-kind-"));
	state.kinds.length = 0;
});

afterEach(() => {
	removeTempDirSync(tmp);
});

describe("project scan ast-grep kind derivation (#2217)", () => {
	it("evaluates a .css file under its own kind, not jsts", async () => {
		const cssFile = path.join(tmp, "style.css");
		fs.writeFileSync(cssFile, "a { color: red; }\n");

		await scanProjectDiagnostics({ cwd: tmp, tier: "all", files: [cssFile] });

		expect(state.kinds.length).toBeGreaterThan(0);
		for (const kind of state.kinds) {
			expect(kind).not.toBe("jsts");
		}
		expect(state.kinds).toContain("css");
	});

	it("still evaluates a .ts file under kind jsts", async () => {
		const tsFile = path.join(tmp, "index.ts");
		fs.writeFileSync(tsFile, "export const x = 1;\n");

		await scanProjectDiagnostics({ cwd: tmp, tier: "all", files: [tsFile] });

		expect(state.kinds).toContain("jsts");
	});
});
