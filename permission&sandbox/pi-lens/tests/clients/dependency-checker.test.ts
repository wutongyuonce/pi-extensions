/**
 * Tests for buildMadgeArgs — the madge circular-dependency argv builder.
 *
 * Guards the two correctness levers added in the tool-utilization audit:
 *   - mjs/cjs extensions are always scanned
 *   - `--ts-config` is passed iff a tsconfig.json exists at the project root
 *     (so TS path-alias imports resolve and alias-routed cycles aren't missed)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMadgeArgs } from "../../clients/dependency-checker.js";
import { removeTempDirSync } from "./test-utils.js";

describe("buildMadgeArgs", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pilens-madge-"));
	});
	afterEach(() => {
		removeTempDirSync(tmp);
	});

	it("always scans mjs/cjs alongside ts/tsx/js/jsx", () => {
		const args = buildMadgeArgs(tmp, tmp);
		const ext = args[args.indexOf("--extensions") + 1];
		expect(ext.split(",")).toEqual(
			expect.arrayContaining(["mjs", "cjs", "ts", "tsx", "js", "jsx"]),
		);
		expect(args).toContain("--circular");
		expect(args[args.length - 1]).toBe(tmp); // target is last
	});

	it("passes --ts-config when tsconfig.json exists at the root", () => {
		const tsconfig = path.join(tmp, "tsconfig.json");
		fs.writeFileSync(tsconfig, "{}");
		const args = buildMadgeArgs(tmp, tmp);
		expect(args).toContain("--ts-config");
		expect(args[args.indexOf("--ts-config") + 1]).toBe(tsconfig);
	});

	it("omits --ts-config for a non-TS project (no tsconfig)", () => {
		const args = buildMadgeArgs(tmp, tmp);
		expect(args).not.toContain("--ts-config");
	});

	it("does not request --warning (inert under --json; skip visibility is disclosed by the ledger)", () => {
		// #3436: bin/cli.js:195 gates --warning on `!program.json`, so with the
		// --json this builder always passes it produced nothing on stderr; the
		// lost visibility is recorded once per root by `parseMadgeCycles` (the
		// reader both lanes share), not parsed here.
		expect(buildMadgeArgs(tmp, tmp)).not.toContain("--warning");
	});
});
