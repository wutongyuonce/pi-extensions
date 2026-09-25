import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalPiLensDir } from "../../../clients/file-utils.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);

let previousTestMode: string | undefined;
let flushLatencyLog: (() => Promise<void>) | undefined;

beforeEach(() => {
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	fs.rmSync(path.join(getGlobalPiLensDir(), "latency.log"), { force: true });
});

afterEach(async () => {
	if (flushLatencyLog) await flushLatencyLog();
	flushLatencyLog = undefined;
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
});

describe("document notification telemetry (#2357)", () => {
	it("emits the coalesced count through the real latency sink", async () => {
		vi.resetModules();
		const [{ handleNotifyChange }, latencyLogger] = await Promise.all([
			import("../../../clients/lsp/client.js"),
			import("../../../clients/latency-logger.js"),
		]);
		flushLatencyLog = latencyLogger.flushLatencyLog;
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await Promise.all([
			handleNotifyChange(state, TEST_FILE, "v1"),
			handleNotifyChange(state, TEST_FILE, "v2"),
			handleNotifyChange(state, TEST_FILE, "v3"),
		]);
		await latencyLogger.flushLatencyLog();

		const records = fs
			.readFileSync(path.join(getGlobalPiLensDir(), "latency.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const record = records.find(
			(entry) => entry.phase === "lsp_document_send",
		) as { metadata?: { coalescedCount?: number } } | undefined;
		expect(record?.metadata?.coalescedCount).toBe(2);
	});
});
