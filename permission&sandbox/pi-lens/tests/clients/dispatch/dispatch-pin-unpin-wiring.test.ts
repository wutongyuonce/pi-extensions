/**
 * #2243 review round 3 (F3): production wiring of `endDispatchFor` was
 * untested. Every existing FactStore test drives `endDispatchFor` directly
 * against a store the test constructed, and every existing integration test
 * mocks `dispatchForFile`/`runProviders` without checking what the finally
 * block around them does — so no-opping all four production call sites
 * (`dispatchLint`, `dispatchLintWithResult`, `dispatchLintDetailed`,
 * `runAstGrepWarningScan`) left 1552 tests green. A caller that pins a file
 * (`clearFileFactsFor`/`beginDispatchFor`) but never reaches its matching
 * `endDispatchFor` leaks the pin: the file stays exempt from capacity
 * eviction long after its dispatch settled, at the cost of some OTHER file's
 * record — the same silent-misattribution shape as F1, one layer down.
 *
 * This spies on `FactStore.prototype.endDispatchFor` — a real instance
 * method on the shared module-scope `sessionFacts` singleton in
 * integration.ts, which the module never exports — so it observes exactly
 * what each production entry point calls, without reaching into private
 * module state or re-implementing the wiring by hand.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	dispatchLint,
	dispatchLintDetailed,
	dispatchLintWithResult,
	resetDispatchBaselines,
	runAstGrepWarningScan,
} from "../../../clients/dispatch/integration.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const pi = { getFlag: () => false };
const logContext = {
	sessionId: "test-session",
	turnIndex: 0,
	writeIndex: 0,
} as never;

describe("dispatch entry points release their FactStore pin (#2243 review round 3, F3)", () => {
	let dir: string;

	beforeEach(async () => {
		resetDispatchBaselines();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-2243-f3-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	// An unrecognized extension makes `ctx.kind` undefined, which returns
	// from inside the try block — AFTER the pin, BEFORE the finally — so this
	// still exercises the pin/unpin pair without spawning real runners.
	it("dispatchLint calls endDispatchFor for the file it pinned", async () => {
		const endSpy = vi.spyOn(FactStore.prototype, "endDispatchFor");
		const filePath = path.join(dir, "unsupported.xyz");
		await dispatchLint(filePath, dir, pi);
		expect(endSpy).toHaveBeenCalledWith(normalizeMapKey(filePath));
		endSpy.mockRestore();
	});

	it("dispatchLintWithResult calls endDispatchFor for the file it pinned", async () => {
		const endSpy = vi.spyOn(FactStore.prototype, "endDispatchFor");
		const filePath = path.join(dir, "unsupported.xyz");
		await dispatchLintWithResult(filePath, dir, pi);
		expect(endSpy).toHaveBeenCalledWith(normalizeMapKey(filePath));
		endSpy.mockRestore();
	});

	it("dispatchLintDetailed calls endDispatchFor for the file it pinned", async () => {
		const endSpy = vi.spyOn(FactStore.prototype, "endDispatchFor");
		const filePath = path.join(dir, "unsupported.xyz");
		await dispatchLintDetailed(filePath, dir, pi);
		expect(endSpy).toHaveBeenCalledWith(normalizeMapKey(filePath));
		endSpy.mockRestore();
	});

	it("runAstGrepWarningScan calls endDispatchFor for the file it pinned", async () => {
		const endSpy = vi.spyOn(FactStore.prototype, "endDispatchFor");
		const filePath = path.join(dir, "sample.ts");
		await fs.writeFile(filePath, "export const x = 1;\n", "utf-8");
		await runAstGrepWarningScan(filePath, dir, pi, logContext).catch(() => {
			// Background scan swallows runner/provider errors.
		});
		expect(endSpy).toHaveBeenCalledWith(normalizeMapKey(filePath));
		endSpy.mockRestore();
	});
});
