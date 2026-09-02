/**
 * #2243 item 1: the debounced ast-grep warning scan is a dispatch entry point,
 * but on the PR head it never pinned its file and never re-derived content — it
 * trusted the `file.content` a prior dispatch left in the module-scope store.
 *
 * That store is shared with the review-graph project walk (`buildOrUpdateGraph`),
 * which seeds a fact for every file it visits. During the scan's 2 s debounce the
 * walk can evict the scanned file's content. `dispatcher.ts` then reads it back
 * with `?? ""`, so inline `pi-lens-ignore` suppressions silently stop applying.
 *
 * The fix makes the scan follow the same discipline as the other dispatch
 * callers: pin the file for the dispatch, and re-derive `file.content` from disk
 * via `runProviders`. This test drives the real exported scan worker with an
 * injected store whose content was evicted, and asserts the content is present
 * (re-derived) after the scan — the exact fact `dispatcher.ts:1084` reads back.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { runAstGrepWarningScan } from "../../../clients/dispatch/integration.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const pi = { getFlag: () => false };
const logContext = {
	sessionId: "test-session",
	turnIndex: 0,
	writeIndex: 0,
} as never;

describe("ast-grep warning scan — content survives eviction (#2243 item 1)", () => {
	let dir: string;
	let filePath: string;
	const diskContent = "export const answer = 42; // pi-lens-ignore\n";

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-2243-"));
		filePath = path.join(dir, "sample.ts");
		await fs.writeFile(filePath, diskContent, "utf-8");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("re-derives file.content when a prior dispatch's cached content was evicted", async () => {
		const facts = new FactStore();

		// A prior dispatch cached this file's content, then the project walk
		// evicted it by flooding the store past its 1024-record cap.
		facts.setFileFact(
			filePath,
			"file.content",
			"// stale pre-eviction content",
		);
		for (let i = 0; i < 1100; i++) {
			facts.setFileFact(`/repo/walk/file-${i}.ts`, "file.content", "x");
		}
		// Precondition: the scanned file's content is gone.
		expect(facts.getFileFact(filePath, "file.content")).toBeUndefined();

		await runAstGrepWarningScan(filePath, dir, pi, logContext, facts).catch(
			() => {
				// Background scan swallows runner/provider errors; the fact we assert
				// on is set by runProviders' file-content provider, which runs first.
			},
		);

		// The fix re-derived the real content from disk, so the read-back at
		// dispatcher.ts:1084 sees the true bytes, not "".
		expect(facts.getFileFact(filePath, "file.content")).toBe(diskContent);
	});

	// #2243 review round 3 (F2): the previous test only proves content is
	// re-derived when it was ALREADY missing before the scan started — that
	// stays green even if the pin at integration.ts:291 (`beginDispatchFor`,
	// née `clearFileFactsFor`) is swapped for the unpinned `dropFileFacts`,
	// because `runProviders` re-derives on any miss regardless of pinning.
	// This test instead lets the walk land WHILE the dispatch is in flight —
	// the instant `runProviders` sets this file's `file.content` (the same
	// moment a concurrent review-graph walk could observe it and race past
	// it) — and proves the record is still there afterward. Without the pin,
	// the flood evicts it via ordinary LRU (it's now the oldest-touched
	// record), and the read-back at dispatcher.ts:1084 sees "" instead.
	it("keeps file.content pinned when the project walk lands mid-dispatch", async () => {
		const walkPaths = Array.from(
			{ length: 1100 },
			(_, i) => `/repo/mid-walk/file-${i}.ts`,
		);

		class FloodOnContentSetFactStore extends FactStore {
			private flooded = false;
			setFileFact(fp: string, factId: string, value: unknown): void {
				super.setFileFact(fp, factId, value);
				if (
					!this.flooded &&
					factId === "file.content" &&
					normalizeMapKey(fp) === normalizeMapKey(filePath)
				) {
					this.flooded = true;
					// Simulate the fire-and-forget project walk landing in the
					// exact instant this file's content becomes available.
					for (const p of walkPaths) super.setFileFact(p, "file.content", "x");
				}
			}
		}

		const facts = new FloodOnContentSetFactStore();

		await runAstGrepWarningScan(filePath, dir, pi, logContext, facts).catch(
			() => {
				// Background scan swallows runner/provider errors.
			},
		);

		// The pin must have exempted this file from the flood's capacity
		// eviction, so the content set by runProviders is still readable —
		// the exact fact dispatcher.ts:1084 reads back for inline suppressions.
		expect(facts.getFileFact(filePath, "file.content")).toBe(diskContent);
	});
});
