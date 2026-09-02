import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSourceTree, measureMaxSyncBlockMs } from "./perf-harness.js";
import { removeTempDirSync } from "../clients/test-utils.js";

describe("measureMaxSyncBlockMs", () => {
	it("reports a large block for a fully non-yielding (synchronous) burst", async () => {
		// The catastrophic case: work that never yields. A naive
		// measure-the-code's-own-yields approach would report ~0 here (false
		// pass); the independent sampler must see the whole block.
		const maxLag = await measureMaxSyncBlockMs(async () => {
			const end = Date.now() + 250;
			// biome-ignore lint/suspicious/noEmptyBlockStatements: deliberate busy-loop
			while (Date.now() < end) {}
		});
		expect(maxLag).toBeGreaterThan(150);
	});

	it("reports a small block for work that yields frequently", async () => {
		const maxLag = await measureMaxSyncBlockMs(async () => {
			for (let i = 0; i < 2000; i++) {
				// trivial work
				Math.sqrt(i);
				if (i % 25 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			}
		});
		expect(maxLag).toBeLessThan(100);
	});
});

describe("generateSourceTree", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-perf-harness-"));
	});
	afterEach(() => {
		removeTempDirSync(tmp);
	});

	it("creates approximately the requested number of source files + ignored noise", () => {
		const made = generateSourceTree(tmp, 150);
		expect(made).toBe(150);
		expect(fs.existsSync(path.join(tmp, ".gitignore"))).toBe(true);
		expect(fs.existsSync(path.join(tmp, "node_modules", "pkg"))).toBe(true);
	});
});
