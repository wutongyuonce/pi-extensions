/**
 * The two migrated sites emit the primitive's telemetry (#1754).
 *
 * The migration is behavior-identical by design, so the sites' own suites
 * (`tests/clients/dispatch/runners/runner-helpers.test.ts`,
 * `tests/clients/lsp/workspace-diagnostics-cache.test.ts`) stay green
 * unchanged and remain the proof that the GUARDS still work. What is new is
 * that a dropped straddling write is now OBSERVABLE — the thing whose absence
 * let two hand-rolled copies of this guard reach review vacuous.
 *
 * These assertions are red on pre-migration code: the hand-rolled guards
 * dropped their writes silently, so the ledger held no such record.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	clearWorkspaceDiagnosticsCache,
	createWorkspaceDiagnosticsCacheContext,
	loadWorkspaceDiagnosticsCache,
} from "../../clients/lsp/workspace-diagnostics-cache.js";
import { listDeclaredGenerationSources } from "../../clients/generation-guard.js";
import { removeTempDirSync } from "./test-utils.js";

function staleWriteSubjects(): string[] {
	return (
		getDegradationSummary()
			.find((entry) => entry.kind === "generation-guard-stale-write")
			?.latestReasons.map((entry) => entry.subject) ?? []
	);
}

let tmp: string;

beforeEach(() => {
	resetDegradationLedger();
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-genguard-"));
	fs.mkdirSync(path.join(tmp, ".pi-lens"));
});

afterEach(() => removeTempDirSync(tmp));

describe("workspace-diagnostics-cache epochs on the shared primitive", () => {
	it("records the dropped persist when a clear races the sweep", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		clearWorkspaceDiagnosticsCache(tmp);
		ctx.record(filePath, "all|", [], mtimeMs);
		ctx.persist();

		// The behavior is unchanged: the clear still wins.
		expect(
			Object.keys(loadWorkspaceDiagnosticsCache(tmp)?.entries ?? {}),
		).toHaveLength(0);
		// What is new: the drop names the cwd it dropped, so a dogfood session
		// can tell a working guard from a guard that never fires.
		const subjects = staleWriteSubjects();
		expect(subjects).toHaveLength(1);
		expect(subjects[0]).toContain("workspace-diagnostics-cache[");
	});

	it("stays silent when no clear raced the sweep", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], mtimeMs);
		ctx.persist();

		expect(staleWriteSubjects()).toHaveLength(0);
	});

	it("a clear for ANOTHER cwd does not drop this sweep's persist", () => {
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-genguard-b-"));
		fs.mkdirSync(path.join(other, ".pi-lens"));
		try {
			const filePath = path.join(tmp, "a.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const mtimeMs = fs.statSync(filePath).mtimeMs;

			const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
			clearWorkspaceDiagnosticsCache(other);
			ctx.record(filePath, "all|", [], mtimeMs);
			ctx.persist();

			expect(
				Object.keys(loadWorkspaceDiagnosticsCache(tmp)?.entries ?? {}),
			).toHaveLength(1);
			expect(staleWriteSubjects()).toHaveLength(0);
		} finally {
			removeTempDirSync(other);
		}
	});

	it("a stale lookup is refused as before, without recording a write drop", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], mtimeMs);
		expect(ctx.lookup(filePath, "all|")).toBeDefined();

		clearWorkspaceDiagnosticsCache(tmp);

		// #1669 review N4: lookup checks on EVERY call, not just at load time.
		expect(ctx.lookup(filePath, "all|")).toBeUndefined();
		// A refused READ is not a dropped write, so the write ledger stays clean.
		expect(staleWriteSubjects()).toHaveLength(0);
	});
});

describe("declaration registry covers both migrated stores", () => {
	it("both stores declare themselves by construction", async () => {
		await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		const declared = listDeclaredGenerationSources();
		expect(declared).toContain("dispatch-availability");
		expect(declared).toContain("workspace-diagnostics-cache");
	});
});
