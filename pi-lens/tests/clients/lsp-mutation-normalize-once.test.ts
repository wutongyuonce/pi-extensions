import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const normalizeCalls: string[] = [];

vi.mock("../../clients/path-utils.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/path-utils.js")>();
	return {
		...actual,
		normalizeMapKey: (filePath: string) => {
			normalizeCalls.push(filePath);
			return actual.normalizeMapKey(filePath);
		},
	};
});

import {
	type LspMutationContext,
	recordLspMutation,
} from "../../clients/lsp-mutation.js";
import { setupTestEnvironment } from "./test-utils.js";

/**
 * #2016. `uniqueDetails` normalized every path twice: once building the dedupe
 * map, once looking the result back up. Both loops walk the same paths, so the
 * second pass was a pure `realpathSync.native` per file, measured at ~200
 * microseconds each on Windows and short-circuited on POSIX.
 *
 * Driven through the public `recordLspMutation` seam rather than the private
 * helper, so the test cannot pass by way of a shape the production callers do
 * not use.
 */
describe("lsp-mutation normalizes each path once (#2016)", () => {
	it("does not re-canonicalize a path it already resolved", () => {
		const env = setupTestEnvironment("pi-lens-2016-lsp-mutation-");
		try {
			const files = ["a.ts", "b.ts", "c.ts"].map((name) => {
				const full = path.join(env.tmpDir, name);
				fs.writeFileSync(full, "export const x = 1;\n");
				return full;
			});
			const context: LspMutationContext = {
				cwd: env.tmpDir,
				correlationId: "normalize-once-1",
				tool: "workspace/applyEdit",
				source: "lsp-edit",
				emitSummary: false,
			};

			normalizeCalls.length = 0;
			recordLspMutation(context, {
				results: [
					{
						descriptions: [],
						files,
						operationTotal: files.length,
						appliedOperationTotal: files.length,
						appliedOperationIndexes: files.map((_, index) => index),
						operationCounts: {
							textEdits: files.length,
							create: 0,
							rename: 0,
							delete: 0,
						},
						fileDetails: files.map((filePath) => ({
							filePath,
							range: { start: 1, end: 2 },
							importsChanged: false,
						})),
					},
				],
			});

			const perFile = files.map(
				(filePath) =>
					normalizeCalls.filter(
						(seen) => path.resolve(seen) === path.resolve(filePath),
					).length,
			);
			expect(perFile).toEqual([1, 1, 1]);
		} finally {
			env.cleanup();
		}
	});
});
