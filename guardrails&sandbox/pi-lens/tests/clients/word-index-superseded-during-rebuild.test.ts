/**
 * #1227 matrix row: a rebuild is superseded while it is in progress.
 *
 * The first build is paused at the real cooperative-budget yield seam. The
 * yield hook starts generation 2 before generation 1 resumes, so the older
 * builder's continuation observes supersession deterministically. Generation
 * 1 must reject without exposing its private partial index; generation 2 must
 * publish only its complete replacement.
 *
 * Invariant lock: the generation/continuation guard and staged builder state
 * already enforce this contract in current code. If the guard is disabled,
 * the first expectation below fails because the superseded build completes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { suspendAt } from "./interleaving-kit.js";

const yieldPoint = vi.hoisted(() => vi.fn());

vi.mock("../../clients/cooperative-budget.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/cooperative-budget.js")
		>();
	return {
		...actual,
		// Keep the test deterministic: every long-line checkpoint yields, without
		// depending on how much CPU time happened to elapse before it.
		yieldIfOverBudget: yieldPoint,
	};
});

import {
	buildWordIndexAsync,
	type WordIndex,
	wordIndexPostingHits,
} from "../../clients/word-index.js";

function document(path: string, identifier: string) {
	return {
		path,
		// A long line guarantees that buildWordIndexAsync reaches the real
		// cooperative yield seam even on a fast or lightly loaded CI machine.
		content: `${"x ".repeat(2_100)}export const ${identifier} = 1;`,
		mtimeMs: 1,
		size: 4_300,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("word-index rebuild supersession (#1227)", () => {
	it("never publishes a partial superseded result", async () => {
		const oldDocs = Object.assign(
			[
				document("src/old-a.ts", "oldGenerationAlpha"),
				document("src/old-b.ts", "oldGenerationBeta"),
			],
			{ truncated: false },
		);
		const newDocs = Object.assign(
			[
				document("src/new-a.ts", "newGenerationAlpha"),
				document("src/new-b.ts", "newGenerationBeta"),
			],
			{ truncated: false },
		);

		let generation = 0;
		let secondBuild: Promise<WordIndex> | undefined;
		const suspension = suspendAt(yieldPoint, async () => {
			// Preserve the production checkpoint's macrotask yield. A microtask-only
			// mock would stop exercising continuation ordering after release.
			await new Promise<void>((resolve) => setImmediate(resolve));
			return true;
		});
		try {
			const firstBuild = buildWordIndexAsync(oldDocs, () => generation === 0);
			await suspension.admitted;
			// This is the deterministic interleaving: generation 2 starts while
			// generation 1 is suspended at its cooperative yield.
			generation = 1;
			secondBuild = buildWordIndexAsync(newDocs, () => generation === 1);
			suspension.release();
			await expect(firstBuild).rejects.toThrow("word index build superseded");
			expect(secondBuild).toBeDefined();

			const replacement = await secondBuild!;
			// Atomic publish: the replacement is complete, and none of generation 1's
			// postings escaped from its private staged index.
			expect(replacement.docCount).toBe(newDocs.length);
			expect(wordIndexPostingHits(replacement, "newgenerationalpha")).toEqual([
				{ file: "src/new-a.ts", line: 1 },
			]);
			expect(replacement.postings.get("oldgenerationalpha")).toBeUndefined();
			// Multiple real checkpoints ran, including after the held one resumed.
			expect(yieldPoint.mock.calls.length).toBeGreaterThan(1);
		} finally {
			suspension.release();
			suspension.restore();
		}
	});
});
