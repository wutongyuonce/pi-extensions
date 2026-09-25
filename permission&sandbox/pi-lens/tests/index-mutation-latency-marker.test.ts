import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logLatency } from "../clients/latency-logger.js";
import { hashlineFixture } from "./support/hashline-anchor-vectors.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

vi.mock("../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/latency-logger.js")>()),
	logLatency: vi.fn(),
}));

import extension from "../index.js";

/**
 * #2423 review round 1, finding F4.
 *
 * `index.ts` gated the `tool_result_received` latency marker on
 * `rtToolName === "edit" || rtToolName === "write"` — the sixteenth literal
 * comparison, missed by the class sweep because the grep guard walked only
 * `clients/`. The marker is the row that says "pi-lens received this edit"; its
 * absence is what made a wedged edit invisible in `latency.log`, and a
 * third-party edit tool got no row at all.
 */
describe("#2423 the tool_result latency marker asks the seam", () => {
	let tmpDir: string;
	let filePath: string;

	beforeEach(() => {
		vi.mocked(logLatency).mockClear();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2423-marker-"));
		filePath = path.join(tmpDir, "edited.ts");
		fs.writeFileSync(filePath, hashlineFixture("simple").content, "utf8");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function markers(): unknown[] {
		return vi
			.mocked(logLatency)
			.mock.calls.filter(
				([entry]) =>
					(entry as { phase?: string }).phase === "tool_result_received",
			)
			.map(([entry]) => entry);
	}

	it("marks a third-party edit tool's result", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"tool_result",
			{
				toolName: "replace",
				toolCallId: "call-marker-1",
				input: {
					path: filePath,
					remove_from: hashlineFixture("simple").anchorFor(2),
					remove_to: hashlineFixture("simple").anchorFor(3),
					replacement_lines: ["const b = 20;"],
				},
				content: [],
			},
			makeCtx({ cwd: tmpDir }),
		);

		expect(markers()).toEqual([
			expect.objectContaining({
				phase: "tool_result_received",
				filePath,
				metadata: expect.objectContaining({
					toolName: "replace",
					mutationKind: "edit",
				}),
			}),
		]);
	});

	it("still marks pi's own edit tool, and still ignores a read", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				toolCallId: "call-marker-2",
				input: { path: filePath },
				content: [],
			},
			makeCtx({ cwd: tmpDir }),
		);
		expect(markers()).toHaveLength(1);

		await pi.emit(
			"tool_result",
			{
				toolName: "read",
				toolCallId: "call-marker-3",
				input: { path: filePath },
				content: [],
			},
			makeCtx({ cwd: tmpDir }),
		);
		expect(markers()).toHaveLength(1);
	});
});
