/**
 * #348 phase 2 — the word index's debounced persist, generalized from the
 * review graph's #260 circuit-breaker discipline via the shared
 * `createDebounceScheduler` (clients/persist-debounce.ts). Covers: coalescing
 * a burst of updates into one write, the `PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS`
 * env override, and the flush-for-tests hook.
 */

import * as fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildWordIndex,
	flushWordIndexPersistsForTests,
	scheduleWordIndexPersist,
} from "../../clients/word-index.js";
import { getProjectSnapshotPath } from "../../clients/project-snapshot.js";
import { setupTestEnvironment } from "./test-utils.js";

/** Read the (now gzip, #958) snapshot body a persist wrote. */
function readSnapshotBody(snapshotPath: string): {
	wordIndex: { files: string[] };
} {
	return JSON.parse(
		gunzipSync(fs.readFileSync(snapshotPath)).toString("utf-8"),
	);
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
	// #958: the snapshot body is written by a worker thread by default; force
	// the synchronous writer so a flushed debounce lands the gz body on disk
	// deterministically (this suite tests the WORD-INDEX debounce, not the
	// snapshot worker offload).
	process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
});
afterEach(() => {
	flushWordIndexPersistsForTests();
	while (cleanups.length) cleanups.pop()?.();
	process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "0";
	delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
});

function makeEnv() {
	const env = setupTestEnvironment("pi-lens-word-index-persist-");
	cleanups.push(env.cleanup);
	return env;
}

async function waitForFile(p: string, attempts = 40): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		if (fs.existsSync(p)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return fs.existsSync(p);
}

describe("word-index debounced persist (#348 phase 2)", () => {
	it("writes synchronously when the debounce is 0 (test default)", async () => {
		const env = makeEnv();
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
		]);
		scheduleWordIndexPersist(env.tmpDir, index);

		const snapshotPath = getProjectSnapshotPath(env.tmpDir);
		expect(await waitForFile(snapshotPath)).toBe(true);
		const raw = readSnapshotBody(snapshotPath);
		expect(raw.wordIndex).toBeDefined();
	});

	it("coalesces a burst of updates into one write after the debounce window", async () => {
		const env = makeEnv();
		process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "200";

		const snapshotPath = getProjectSnapshotPath(env.tmpDir);
		for (let i = 0; i < 5; i += 1) {
			const index = buildWordIndex([
				{ path: `a${i}.ts`, content: `export function alpha${i}() {}` },
			]);
			scheduleWordIndexPersist(env.tmpDir, index);
		}
		// Immediately after scheduling, nothing should be written yet (debounced).
		expect(fs.existsSync(snapshotPath)).toBe(false);

		flushWordIndexPersistsForTests();
		expect(await waitForFile(snapshotPath)).toBe(true);
		const raw = readSnapshotBody(snapshotPath);
		// Only the LAST scheduled index should have been written (coalesced).
		expect(raw.wordIndex.files.some((f: string) => f.includes("a4.ts"))).toBe(
			true,
		);
		expect(raw.wordIndex.files.some((f: string) => f.includes("a0.ts"))).toBe(
			false,
		);
	});

	it("respects the PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS override", async () => {
		const env = makeEnv();
		process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "5000";
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
		]);
		scheduleWordIndexPersist(env.tmpDir, index);

		const snapshotPath = getProjectSnapshotPath(env.tmpDir);
		// Should NOT have written yet — well under the 5s debounce.
		await new Promise((r) => setTimeout(r, 100));
		expect(fs.existsSync(snapshotPath)).toBe(false);

		flushWordIndexPersistsForTests();
		expect(await waitForFile(snapshotPath)).toBe(true);
	});
});
