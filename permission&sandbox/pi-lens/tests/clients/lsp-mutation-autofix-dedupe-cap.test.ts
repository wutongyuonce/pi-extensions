import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	type LspMutationContext,
	recordLspMutation,
} from "../../clients/lsp-mutation.js";
import { setupTestEnvironment } from "./test-utils.js";

/**
 * #2460 substitution-style proof: `bookkeepLspMutation`'s per-batch autofix
 * dedupe used to hand-roll its eviction over a bare `Set<string>`
 * (`context.autofixRecordedPaths`), capped at `MAX_SAMPLES` (100). It now
 * goes through `BoundedSet` (`clients/bounded-cache.ts`). This drives the
 * cap through the real `recordLspMutation` seam — never a hand-fed
 * `BoundedSet` — so it proves the WIRING: the seam actually reads
 * `MAX_SAMPLES`, actually calls `BoundedSet`, and a path genuinely evicted by
 * the cap is treated as a new observation (re-fires) rather than a
 * still-deduped one.
 *
 * What it does NOT prove (#2460 review T2 — checked by mutation, not
 * inspection): an off-by-one on `MAX_SAMPLES` (99 or 101 in place of 100)
 * leaves this test green, because it only asserts eviction eventually
 * happens by the time all 100 fillers have gone through, not the exact
 * count at which it happens. An LRU-instead-of-FIFO swap (a `.has()` that
 * promotes recency) also leaves this test green, because the one dedup-check
 * on `first` happens before any filler is inserted, when `first` is the only
 * member — promoting it then is a no-op on insertion order. Both axes ARE
 * covered, just not here: `bounded-cache.test.ts`'s `BoundedSet` suite
 * (`has() does not refresh recency`, `setMaxEntries() shrinks immediately`)
 * catches the LRU swap directly, and is the right place for cap-boundary
 * precision — this test's job is only the seam wiring above.
 */
function record(context: LspMutationContext, filePath: string): void {
	recordLspMutation(context, {
		bookkeep: true,
		results: [
			{
				descriptions: [],
				files: [filePath],
				operationTotal: 1,
				appliedOperationTotal: 1,
				appliedOperationIndexes: [0],
				operationCounts: {
					textEdits: 1,
					create: 0,
					rename: 0,
					delete: 0,
				},
				fileDetails: [
					{ filePath, range: { start: 1, end: 2 }, importsChanged: false },
				],
			},
		],
	});
}

describe("lsp-mutation autofix dedupe cap (#2460)", () => {
	it("dedupes within the cap and re-fires for a path evicted FIFO past it", () => {
		const env = setupTestEnvironment("pi-lens-2460-autofix-cap-");
		try {
			const recorded: string[] = [];
			const context: LspMutationContext = {
				cwd: env.tmpDir,
				correlationId: "autofix-cap-1",
				tool: "workspace/applyEdit",
				source: "autofix",
				emitSummary: false,
				recordAutofix: (filePath) => recorded.push(filePath),
			};

			const first = path.join(env.tmpDir, "first.ts");
			fs.writeFileSync(first, "export const x = 1;\n");

			// First mutation: recorded once.
			record(context, first);
			expect(recorded).toHaveLength(1);

			// A second mutation to the SAME path within the cap is deduped — the
			// per-batch autofix publisher fires once per path, not once per write.
			record(context, first);
			expect(recorded).toHaveLength(1);

			// Push 100 (MAX_SAMPLES) distinct NEW paths through. FIFO order makes
			// `first` (inserted before all of them) the one the cap evicts.
			for (let index = 0; index < 100; index += 1) {
				const filler = path.join(env.tmpDir, `filler-${index}.ts`);
				fs.writeFileSync(filler, "export const y = 1;\n");
				record(context, filler);
			}
			expect(recorded).toHaveLength(101); // first + 100 fillers, all new

			// `first` was evicted by the cap, so mutating it again is a genuinely
			// new observation from the dedupe set's point of view and re-fires.
			record(context, first);
			expect(recorded).toHaveLength(102);
			expect(recorded[0]).toBe(first);
			expect(recorded[101]).toBe(first);
		} finally {
			env.cleanup();
		}
	});
});
