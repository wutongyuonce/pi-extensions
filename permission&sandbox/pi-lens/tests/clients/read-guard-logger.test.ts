/**
 * #1913: `read_cap_trimmed` must survive `read-guard-logger`'s verbosity
 * gate at DEFAULT verbosity (PI_LENS_READ_GUARD_VERBOSE unset), while the
 * per-read `read_recorded` event stays gated as before.
 */
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { shouldLogEvent } from "../../clients/read-guard-logger.js";

describe("shouldLogEvent", () => {
	it("always logs read_cap_trimmed, even at default verbosity", () => {
		expect(shouldLogEvent("read_cap_trimmed")).toBe(true);
	});

	// #1918: read_cap_trimmed's population siblings. read-guard.test.ts mocks
	// read-guard-logger.js wholesale, so it can't see this gate at all — this
	// file is the only place a dropped always-on arm reds.
	it("always logs read_file_evicted, even at default verbosity", () => {
		expect(shouldLogEvent("read_file_evicted")).toBe(true);
	});

	it("always logs edits_cap_trimmed, even at default verbosity", () => {
		expect(shouldLogEvent("edits_cap_trimmed")).toBe(true);
	});

	it("keeps read_recorded gated behind verbose mode", () => {
		expect(shouldLogEvent("read_recorded")).toBe(false);
	});

	it("still logs the pre-existing always-on events", () => {
		expect(shouldLogEvent("edit_blocked")).toBe(true);
	});

	it("writes partial-apply outcomes to the real sink at default verbosity", async () => {
		const previous = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		vi.resetModules();
		try {
			const logger = await import("../../clients/read-guard-logger.js");
			for (const event of [
				"edit_partial_apply_rejected",
				"edit_already_applied_retry",
				"edit_post_edit_pipeline_failed",
			]) {
				logger.logReadGuardEvent({
					event,
					filePath: "C:\\workspace\\sample.ts",
					metadata: { editIndex: 2 },
				});
			}
			await logger.flushReadGuardLog();
			const lines = fs
				.readFileSync(logger.getReadGuardLogPath(), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string });
			expect(lines.map((line) => line.event)).toEqual(
				expect.arrayContaining([
					"edit_partial_apply_rejected",
					"edit_already_applied_retry",
					"edit_post_edit_pipeline_failed",
				]),
			);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previous;
			vi.resetModules();
		}
	});
});

/**
 * #2219 (the #2141 class): `logReadGuardEvent`'s `filePath` reaches it from
 * `runtime-tool-result.ts`'s raw `path.resolve()`/`path.isAbsolute()`
 * arithmetic, never `normalizeFilePath`-passed. Mirrors
 * `review-graph-logger.test.ts`'s mock-the-writer pattern.
 */
describe("logReadGuardEvent filePath normalization (#2219)", () => {
	it("normalizes a backslash-supplied filePath to the canonical slash form", async () => {
		vi.resetModules();
		const writerLog = vi.fn();
		vi.doMock("../../clients/env-utils.js", () => ({
			isTestMode: () => false,
		}));
		vi.doMock("../../clients/ndjson-logger.js", () => ({
			createNdjsonLogger: () => ({
				log: writerLog,
				append: vi.fn(),
				truncate: vi.fn(),
				flush: vi.fn().mockResolvedValue(undefined),
				flushSync: vi.fn(),
			}),
		}));

		const mod = await import("../../clients/read-guard-logger.js");
		const { normalizeFilePath } = await import("../../clients/path-utils.js");

		mod.logReadGuardEvent({
			event: "edit_blocked",
			filePath: "C:\\Users\\dev\\pi-free\\src\\a.ts",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0].filePath).toBe(
			normalizeFilePath("C:\\Users\\dev\\pi-free\\src\\a.ts"),
		);

		vi.doUnmock("../../clients/env-utils.js");
		vi.doUnmock("../../clients/ndjson-logger.js");
		vi.resetModules();
	});
});
