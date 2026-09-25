import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixturePath = path.resolve(
	process.cwd(),
	"tests/fixtures/jscpd/jscpd-5.3.0-report.json",
);
const scanRoots: string[] = [];

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return {
		...actual,
		safeSpawnAsync: vi.fn(async (_command: string, args: string[]) => {
			if (args.includes("--version")) {
				return { stdout: "jscpd 5.3.0\n", stderr: "", status: 0 };
			}
			const outputIndex = args.indexOf("--output");
			if (outputIndex < 0 || !args[outputIndex + 1]) {
				throw new Error("fixture probe did not receive --output");
			}
			const outputDir = args[outputIndex + 1];
			copyFileSync(fixturePath, path.join(outputDir, "jscpd-report.json"));
			return { stdout: "", stderr: "", status: 0 };
		}),
	};
});

import { JscpdClient } from "../../clients/jscpd-client.js";

afterEach(() => {
	for (const root of scanRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("JscpdClient report compatibility", () => {
	it("parses a captured jscpd 5.3.0 JSON report through scan", async () => {
		// Regression: #3430 must not move the installer to a version whose report
		// shape the client cannot consume.
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-lens-jscpd-client-"));
		scanRoots.push(root);
		writeFileSync(path.join(root, "source.ts"), "const source = 1;\n");

		const result = await new JscpdClient().scan(root, 5, 50, false, {
			homeDir: path.dirname(root),
		});

		expect(result.success).toBe(true);
		expect(result.clones).toEqual([
			{
				fileA: "index.ts",
				startA: 2,
				fileB: "second.ts",
				startB: 3,
				lines: 80,
				tokens: 1280,
			},
		]);
		expect(result.duplicatedLines).toBe(79);
		expect(result.totalLines).toBe(163);
		expect(result.percentage).toBe(48.466257668711656);
	});
});
