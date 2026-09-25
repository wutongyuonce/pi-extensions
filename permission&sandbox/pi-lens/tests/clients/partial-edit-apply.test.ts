import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	applyPartiallyApplicableEdits,
	type EditSnapshotIdentity,
	isExactAppliedRetry,
	MAX_APPLIED_RECORD_FILES,
	PartialApplyRecordStore,
	type PartiallyApplicableEdit,
} from "../../clients/partial-edit-apply.js";
import { createReadGuardEditBatchSummary } from "../../clients/read-guard-logger.js";
import { setupTestEnvironment } from "./test-utils.js";

function snapshotOf(rawContent: string): EditSnapshotIdentity {
	return {
		hash: createHash("sha256").update(rawContent, "utf8").digest("hex"),
	};
}

function spanEdit(args: {
	rawContent: string;
	oldText: string;
	appliedSpanText?: string;
	newText?: string;
	originalIndex?: number;
}): PartiallyApplicableEdit {
	const rawLf = args.rawContent.replace(/\r\n/g, "\n");
	const spanText = args.appliedSpanText ?? args.oldText;
	const spanStart = rawLf.indexOf(spanText);
	return {
		oldText: args.oldText,
		appliedSpanText: spanText,
		newText: args.newText,
		originalIndex: args.originalIndex ?? 0,
		snapshot: snapshotOf(args.rawContent),
		spanStart,
		spanEnd: spanStart + spanText.length,
	};
}

describe("applyPartiallyApplicableEdits", () => {
	it("applies preflight-approved spans and routes through the post-edit callback", async () => {
		const env = setupTestEnvironment("partial-apply-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
			fs.writeFileSync(filePath, raw);
			const afterWrite = vi.fn(async () => "pipeline output");

			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const c = 3;",
						newText: "const c = 30;",
						originalIndex: 2,
					}),
					spanEdit({
						rawContent: raw,
						oldText: "const b = 2;",
						newText: "const b = 20;",
						originalIndex: 1,
					}),
				],
				afterWrite,
			});

			// Spans apply byte-exactly regardless of candidate order (bottom-up).
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\nconst b = 20;\nconst c = 30;\n",
			);
			expect(afterWrite).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({
				appliedCount: 2,
				appliedIndices: "edits[2], edits[1]",
				postEditOutput: "pipeline output",
				postEditStatus: "succeeded",
			});
		} finally {
			env.cleanup();
		}
	});

	it("rejects the whole batch before any write when the snapshot changed", async () => {
		const env = setupTestEnvironment("partial-apply-stale-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\nconst b = 2;\n";
			fs.writeFileSync(filePath, raw);
			const afterWrite = vi.fn(async () => "pipeline output");

			// A same-length change on a DIFFERENT line: the approved span still
			// slice-matches, so ONLY the snapshot-hash guard can reject this
			// batch (the mutation proof for that guard).
			fs.writeFileSync(filePath, "const a = 2;\nconst b = 2;\n");

			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const b = 2;",
						newText: "const b = 20;",
					}),
				],
				afterWrite,
			});

			expect(result.rejected).toMatchObject({
				reason: "stale_snapshot",
			});
			expect(result.appliedCount).toBe(0);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 2;\nconst b = 2;\n",
			);
			expect(afterWrite).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("rejects when a carried span no longer holds its approved text", async () => {
		const env = setupTestEnvironment("partial-apply-span-drift-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\n";
			fs.writeFileSync(filePath, raw);

			const edit = spanEdit({
				rawContent: raw,
				oldText: "const a = 1;",
				newText: "const a = 2;",
			});
			// Simulate a caller passing a span that points elsewhere.
			const drifted = { ...edit, spanStart: 0, spanEnd: 3 };
			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [drifted],
			});

			expect(result.rejected).toMatchObject({ reason: "span_changed" });
			expect(fs.readFileSync(filePath, "utf-8")).toBe(raw);
		} finally {
			env.cleanup();
		}
	});

	it("rejects out-of-bounds spans before any write", async () => {
		const env = setupTestEnvironment("partial-apply-oob-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\n";
			fs.writeFileSync(filePath, raw);
			const edit = spanEdit({
				rawContent: raw,
				oldText: "const a = 1;",
				newText: "const a = 2;",
			});
			// `slice` clamps to the buffer, so an over-long span cannot produce
			// the approved text: one rejection class covers bounds and drift.
			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [{ ...edit, spanEnd: raw.length + 5 }],
			});
			expect(result.rejected).toMatchObject({ reason: "span_changed" });
			expect(fs.readFileSync(filePath, "utf-8")).toBe(raw);
		} finally {
			env.cleanup();
		}
	});

	it("rejects overlapping spans before any write", async () => {
		const env = setupTestEnvironment("partial-apply-overlap-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const abcdef = 1;\n";
			fs.writeFileSync(filePath, raw);
			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "abcdef",
						newText: "X",
						originalIndex: 0,
					}),
					spanEdit({
						rawContent: raw,
						oldText: "cdef",
						newText: "Y",
						originalIndex: 1,
					}),
				],
			});
			expect(result.rejected).toMatchObject({ reason: "span_overlap" });
			expect(fs.readFileSync(filePath, "utf-8")).toBe(raw);
		} finally {
			env.cleanup();
		}
	});

	it("rejects a batch whose edits disagree on snapshot identity", async () => {
		const env = setupTestEnvironment("partial-apply-mixed-snapshots-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: "const a = 1;\n",
						oldText: "const a = 1;",
						newText: "const a = 2;",
						originalIndex: 0,
					}),
					spanEdit({
						rawContent: "const b = 2;\n",
						oldText: "const b = 2;",
						newText: "const b = 20;",
						originalIndex: 1,
					}),
				],
			});
			expect(result.rejected).toMatchObject({ reason: "invalid_batch" });
			expect(fs.readFileSync(filePath, "utf-8")).toBe("const a = 1;\n");
		} finally {
			env.cleanup();
		}
	});

	it("distinguishes a committed write from a failed post-edit pipeline", async () => {
		const env = setupTestEnvironment("partial-apply-pipeline-failure-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\n";
			fs.writeFileSync(filePath, raw);
			const result = await applyPartiallyApplicableEdits({
				filePath,
				correlationId: "tool-pipeline-1",
				summary: createReadGuardEditBatchSummary({
					requestedIndexes: [0],
					resolvedIndexes: [0],
				}),
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const a = 1;",
						newText: "const a = 2;",
					}),
				],
				afterWrite: async () => {
					throw new Error("pipeline failure with source content");
				},
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe("const a = 2;\n");
			expect(result.postEditStatus).toBe("failed");
			expect(result.summary).toMatchObject({
				commitStatus: "committed",
				postEditStatus: "failed",
				appliedCount: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("preserves the existing file mode through the atomic replacement", async () => {
		const env = setupTestEnvironment("partial-apply-mode-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\n";
			fs.writeFileSync(filePath, raw);
			fs.chmodSync(filePath, 0o640);
			const before = fs.statSync(filePath).mode & 0o7777;
			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const a = 1;",
						newText: "const a = 2;",
					}),
				],
			});
			expect(fs.statSync(filePath).mode & 0o7777).toBe(before);
		} finally {
			env.cleanup();
		}
	});

	it.skipIf(process.platform === "win32")(
		"follows a leaf symlink and keeps the link in place",
		async () => {
			const env = setupTestEnvironment("partial-apply-symlink-");
			try {
				const targetPath = path.join(env.tmpDir, "target.ts");
				const linkPath = path.join(env.tmpDir, "link.ts");
				const raw = "const a = 1;\n";
				fs.writeFileSync(targetPath, raw);
				fs.symlinkSync(targetPath, linkPath, "file");
				await applyPartiallyApplicableEdits({
					filePath: linkPath,
					edits: [
						spanEdit({
							rawContent: raw,
							oldText: "const a = 1;",
							newText: "const a = 2;",
						}),
					],
				});
				expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
				expect(fs.readFileSync(targetPath, "utf8")).toBe("const a = 2;\n");
			} finally {
				env.cleanup();
			}
		},
	);

	it("rejects a same-text invalid UTF-8 mutation as snapshot drift", async () => {
		const env = setupTestEnvironment("partial-apply-invalid-utf8-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const rawBytes = Buffer.from([
				...Buffer.from("const a = 1;\n"),
				0xff,
				...Buffer.from("const b = 2;\n"),
			]);
			fs.writeFileSync(filePath, rawBytes);
			const rawText = rawBytes.toString("utf8");
			const spanText = "const b = 2;";
			const spanStart = rawText.indexOf(spanText);
			const edit: PartiallyApplicableEdit = {
				oldText: spanText,
				appliedSpanText: spanText,
				newText: "const b = 20;",
				originalIndex: 0,
				snapshot: { hash: createHash("sha256").update(rawBytes).digest("hex") },
				spanStart,
				spanEnd: spanStart + spanText.length,
			};
			const mutated = Buffer.from([
				...Buffer.from("const a = 1;\n"),
				0xfe,
				...Buffer.from("const b = 2;\n"),
			]);
			fs.writeFileSync(filePath, mutated);
			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [edit],
			});
			expect(result.rejected).toMatchObject({ reason: "stale_snapshot" });
			expect(fs.readFileSync(filePath)).toEqual(mutated);
		} finally {
			env.cleanup();
		}
	});

	it("commit write failure throws and writes no applied-edit record", async () => {
		const env = setupTestEnvironment("partial-apply-commit-fail-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\n";
			fs.writeFileSync(filePath, raw);
			vi.resetModules();
			vi.doMock("node:fs", async () => {
				const actual =
					await vi.importActual<typeof import("node:fs")>("node:fs");
				return {
					...actual,
					renameSync: vi.fn(() => {
						throw new Error("EACCES: simulated write failure");
					}),
				};
			});
			const recordStore = new PartialApplyRecordStore();
			const afterWrite = vi.fn(async () => "pipeline output");
			try {
				const { applyPartiallyApplicableEdits: applyWithFailure } =
					await import("../../clients/partial-edit-apply.js");
				await expect(
					applyWithFailure({
						filePath,
						edits: [
							spanEdit({
								rawContent: raw,
								oldText: "const a = 1;",
								newText: "const a = 2;",
							}),
						],
						afterWrite,
						recordStore,
					}),
				).rejects.toThrow("simulated write failure");
			} finally {
				vi.doUnmock("node:fs");
				vi.resetModules();
			}

			expect(fs.readFileSync(filePath, "utf-8")).toBe(raw);
			expect(afterWrite).not.toHaveBeenCalled();
			expect(recordStore.fileCount).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("records applied pairs for exact-retry recognition", async () => {
		const env = setupTestEnvironment("partial-apply-record-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\n";
			fs.writeFileSync(filePath, raw);
			const recordStore = new PartialApplyRecordStore();

			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const a = 1;",
						newText: "const a = 1;\nconst b = 2;",
					}),
				],
				recordStore,
			});

			// The record keys the SUBMITTED pair, not the span text.
			const record = recordStore.find(
				filePath,
				"const a = 1;",
				"const a = 1;\nconst b = 2;",
			);
			expect(record).toBeDefined();
			expect(recordStore.find(filePath, "other", "x")).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("preserves CRLF files after applying partial edits", async () => {
		const env = setupTestEnvironment("partial-apply-crlf-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\r\nconst b = 2;\r\n";
			fs.writeFileSync(filePath, raw);

			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const b = 2;",
						newText: "const b = 20;",
					}),
				],
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\r\nconst b = 20;\r\n",
			);
		} finally {
			env.cleanup();
		}
	});

	it("normalizes lone-CR files to LF on apply", async () => {
		const env = setupTestEnvironment("partial-apply-lone-cr-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const a = 1;\rconst b = 2;\r";
			fs.writeFileSync(filePath, raw);

			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const b = 2;",
						newText: "const b = 20;",
					}),
				],
			});

			// Lone CR folds to LF like the host edit tool does (#257).
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\nconst b = 20;\n",
			);
		} finally {
			env.cleanup();
		}
	});

	it("preserves a BOM across an atomic partial apply", async () => {
		const env = setupTestEnvironment("partial-apply-bom-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "\uFEFFconst a = 1;\nconst b = 2;\n";
			fs.writeFileSync(filePath, raw);

			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const b = 2;",
						newText: "const b = 20;",
					}),
				],
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"\uFEFFconst a = 1;\nconst b = 20;\n",
			);
		} finally {
			env.cleanup();
		}
	});

	// #505: confusable-hyphen normalization is comparison-only — it folds
	// U+2010/2011/2012/2013/2014/2212 to ASCII '-' when *matching* oldText
	// against file content (clients/host-edit-normalize.ts, consumed by
	// read-guard-tool-lines.ts's resolveOldTextEdits), but must never leak into
	// what actually gets written. This exercises the self-apply write path
	// (used when a partial batch resolves some edits via the preflight
	// comparison) with a newText that intentionally contains an EM DASH
	// (U+2014), confirming the byte written to disk is the caller's literal
	// character, not folded to ASCII.
	it("writes the caller's literal hyphen/dash variant, never normalized (#505)", async () => {
		const env = setupTestEnvironment("partial-apply-confusable-hyphen-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const raw = "const total = a-b;\n";
			fs.writeFileSync(filePath, raw);

			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const total = a-b;",
						// Deliberately an EM DASH (U+2014), not ASCII '-'.
						newText: "const total = a—b; // em dash on purpose",
					}),
				],
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const total = a—b; // em dash on purpose\n",
			);
			expect(result.appliedCount).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("uses host first-occurrence-wins ending detection on mixed files (#257)", async () => {
		const env = setupTestEnvironment("partial-apply-mixed-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			// First newline is LF, a later one is CRLF. The old `includes("\r\n")`
			// rule would rewrite the whole file as CRLF; the host's detectLineEnding
			// resolves LF, so untouched lines keep their LF endings.
			const raw = "const a = 1;\nconst b = 2;\r\nconst c = 3;\n";
			fs.writeFileSync(filePath, raw);

			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					spanEdit({
						rawContent: raw,
						oldText: "const c = 3;",
						newText: "const c = 30;",
					}),
				],
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\nconst b = 2;\nconst c = 30;\n",
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps true batch totals beside bounded index samples", () => {
		const summary = createReadGuardEditBatchSummary({
			requestedIndexes: Array.from({ length: 150 }, (_, index) => index),
			resolvedIndexes: Array.from({ length: 150 }, (_, index) => index),
			appliedIndexes: Array.from({ length: 150 }, (_, index) => index),
			alreadyAppliedIndexes: Array.from({ length: 150 }, (_, index) => index),
			participantIds: Array.from(
				{ length: 150 },
				(_, index) => `call-${index}`,
			),
			requestedTotal: 150,
			resolvedTotal: 150,
			appliedTotal: 150,
			alreadyAppliedTotal: 150,
			participantTotal: 150,
		});

		expect(summary.requestedIndexes).toHaveLength(100);
		expect(summary.requestedTotal).toBe(150);
		expect(summary.appliedTotal).toBe(150);
		expect(summary.alreadyAppliedTotal).toBe(150);
		expect(summary.participantIds).toHaveLength(100);
		expect(summary.indexesTruncated).toBe(true);
		expect(summary.participantIdsTruncated).toBe(true);
	});
});

describe("PartialApplyRecordStore", () => {
	it("requires exact submitted whitespace in the retry pair", () => {
		const store = new PartialApplyRecordStore();
		store.record("/f.ts", "old  ", "new\n");
		expect(store.find("/f.ts", "old  ", "new\n")).toBeDefined();
		expect(store.find("/f.ts", "old", "new\n")).toBeUndefined();
		expect(store.find("/f.ts", "old  ", "new")).toBeUndefined();
	});

	it("finds a record keyed under the other path separator (path-key invariant)", () => {
		// Record with one separator form, look up with the other. The store keys
		// through normalizeMapKey, so a retry whose path arrives back-slashed must
		// still resolve a record written slash-formed (read-guard path-key
		// invariant, #210).
		const forward = new PartialApplyRecordStore();
		forward.record("C:/proj/src/file.ts", "old", "new");
		expect(forward.find("C:\\proj\\src\\file.ts", "old", "new")).toBeDefined();

		const backward = new PartialApplyRecordStore();
		backward.record("C:\\proj\\src\\file.ts", "old", "new");
		expect(backward.find("C:/proj/src/file.ts", "old", "new")).toBeDefined();
	});

	it("stamps an afterWrite hash under the other path separator (path-key invariant)", () => {
		const store = new PartialApplyRecordStore();
		store.record("C:/proj/src/file.ts", "old", "new", "commit-hash");
		// Stamp with the back-slashed spelling; read back the slash spelling.
		store.noteAfterWriteHash(
			"C:\\proj\\src\\file.ts",
			"old",
			"new",
			"format-hash",
		);
		expect(
			store.find("C:/proj/src/file.ts", "old", "new")?.afterWriteContentHash,
		).toBe("format-hash");
	});

	it("bounded per-file and per-store eviction keeps the newest records", () => {
		const store = new PartialApplyRecordStore();
		for (let i = 0; i < 10; i += 1) {
			store.record("/f.ts", `old-${i}`, `new-${i}`);
		}
		// Oldest entries evict; the newest 8 stay.
		expect(store.find("/f.ts", "old-0", "new-0")).toBeUndefined();
		expect(store.find("/f.ts", "old-1", "new-1")).toBeUndefined();
		expect(store.find("/f.ts", "old-2", "new-2")).toBeDefined();
		expect(store.find("/f.ts", "old-9", "new-9")).toBeDefined();

		for (let i = 0; i < 70; i += 1) {
			store.record(`/f${i}.ts`, "old", "new");
		}
		expect(store.fileCount).toBe(MAX_APPLIED_RECORD_FILES);
		expect(store.find("/f0.ts", "old", "new")).toBeUndefined();
		expect(store.find("/f69.ts", "old", "new")).toBeDefined();

		store.clear();
		expect(store.fileCount).toBe(0);
	});

	it("a re-record of a resident file at capacity evicts nothing (#2442)", () => {
		// The hand-rolled `keys().next().value` block this replaced evicted
		// BEFORE inserting whenever `size >= cap`, so re-recording an edit for a
		// file ALREADY in the store dropped an unrelated file and the store
		// silently shrank by one. The bound now lives on the PathKeyedMap
		// itself, which inserts first and evicts only while genuinely over
		// capacity.
		const store = new PartialApplyRecordStore();
		for (let i = 0; i < MAX_APPLIED_RECORD_FILES; i += 1) {
			store.record(`/cap${i}.ts`, "old", "new");
		}
		expect(store.fileCount).toBe(MAX_APPLIED_RECORD_FILES);

		// A second edit to a file already in the store — an UPDATE, not a new key.
		store.record("/cap0.ts", "old-2", "new-2");

		expect(store.fileCount).toBe(MAX_APPLIED_RECORD_FILES);
		// Nothing was displaced: every original file is still findable.
		expect(store.find("/cap1.ts", "old", "new")).toBeDefined();
		expect(store.find("/cap0.ts", "old-2", "new-2")).toBeDefined();
	});

	it("a re-record does not refresh a file's eviction position (FIFO, #2442)", () => {
		const store = new PartialApplyRecordStore();
		for (let i = 0; i < MAX_APPLIED_RECORD_FILES; i += 1) {
			store.record(`/fifo${i}.ts`, "old", "new");
		}
		// Read AND re-write the oldest file, then overflow. `find` is the
		// store's production read (`files.get`); under an LRU-backed store
		// either access would promote fifo0 and fifo1 would be evicted instead.
		expect(store.find("/fifo0.ts", "old", "new")).toBeDefined();
		store.record("/fifo0.ts", "old-again", "new-again");

		store.record("/overflow.ts", "old", "new");

		expect(store.find("/fifo0.ts", "old-again", "new-again")).toBeUndefined();
		expect(store.find("/fifo1.ts", "old", "new")).toBeDefined();
	});
});

describe("isExactAppliedRetry", () => {
	it("confirms the not-contained case: oldText gone, newText present", () => {
		const content = "const b = 20;\nconst tail = 1;\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(true);
	});

	it("refuses the not-contained case when the applied newText vanished", () => {
		const content = "const tail = 1;\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(false);
	});

	it("refuses coincidental newText presence after an intervening change", () => {
		const recordedContent = "const b = 20;\nconst tail = 1;\n";
		const currentContent = "const b = 20;\nconst tail = 2;\n";
		const recordedHash = createHash("sha256")
			.update(recordedContent, "utf8")
			.digest("hex");
		const currentHash = createHash("sha256")
			.update(currentContent, "utf8")
			.digest("hex");
		expect(
			isExactAppliedRetry({
				contentLf: currentContent,
				contentHash: currentHash,
				expectedContentHash: recordedHash,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(false);
	});

	it("accepts the post-afterWrite formatter state as a known applied state", () => {
		// A formatter rewrote the file after the commit, so the current bytes match
		// neither the submitted content nor the post-commit hash — but they DO match
		// the recorded post-afterWrite hash, so recognition holds (#2402).
		const formattedContent = "const b = 20;\nconst tail = 1;\n\n";
		const postCommitHash = createHash("sha256")
			.update("const b = 20;\nconst tail = 1;\n", "utf8")
			.digest("hex");
		const afterWriteHash = createHash("sha256")
			.update(formattedContent, "utf8")
			.digest("hex");
		expect(
			isExactAppliedRetry({
				contentLf: formattedContent,
				contentHash: afterWriteHash,
				expectedContentHash: postCommitHash,
				expectedAfterWriteHash: afterWriteHash,
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(true);
	});

	it("still refuses an unknown third state even with an afterWrite hash on record", () => {
		// Neither the post-commit nor the post-afterWrite hash matches the current
		// bytes: this is an unrecognized third-party change, and the guard stays
		// fail-safe by refusing rather than re-resolving against it.
		const currentContent = "const b = 20;\nconst tail = 2;\n";
		const currentHash = createHash("sha256")
			.update(currentContent, "utf8")
			.digest("hex");
		expect(
			isExactAppliedRetry({
				contentLf: currentContent,
				contentHash: currentHash,
				expectedContentHash: createHash("sha256")
					.update("const b = 20;\nconst tail = 1;\n", "utf8")
					.digest("hex"),
				expectedAfterWriteHash: createHash("sha256")
					.update("const b = 20;\nconst tail = 1;\n\n", "utf8")
					.digest("hex"),
				oldKey: "const b = 2;",
				newKey: "const b = 20;",
			}),
		).toBe(false);
	});

	it("confirms the contained case: every oldText occurrence lies inside newText", () => {
		const content = "import { A } from 'm';\nimport { B } from 'm';\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "import { A } from 'm';",
				newKey: "import { A } from 'm';\nimport { B } from 'm';",
			}),
		).toBe(true);
	});

	it("refuses the contained case when an oldText occurrence escaped newText", () => {
		const content =
			"import { A } from 'm';\nimport { B } from 'm';\nconst a = 1;\n";
		expect(
			isExactAppliedRetry({
				contentLf: content,
				oldKey: "const a = 1;",
				newKey: "const a = 1;\nconst b = 2;",
			}),
		).toBe(false);
	});

	it("models a pure deletion as oldText gone", () => {
		expect(
			isExactAppliedRetry({
				contentLf: "const tail = 1;\n",
				oldKey: "const a = 1;",
				newKey: "",
			}),
		).toBe(true);
	});
});
