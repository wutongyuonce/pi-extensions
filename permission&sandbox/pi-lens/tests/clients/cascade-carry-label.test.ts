/**
 * Fix B (#3167) — honest age labels for carried and demoted repeats.
 *
 * Recurrence: a cascade result carried across a turn boundary re-rendered at
 * turn_end indistinguishable from a fresh observation, and demoted (stale)
 * delta rows repeated with the stale marker but no age information — the
 * delivery-gate registry's own `partial` entries named this exactly.
 *
 * Red-first: pre-fix, `cascadeCarrySuffix` does not exist (import fails) and
 * the delta group renders no age line, so every case below fails against the
 * pre-fix production path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

import { cascadeCarrySuffix } from "../../clients/cascade-format.js";
import { DELIVERY_SURFACES } from "../../clients/finding-delivery-gate.js";
import { STALE_LINE_MARKER } from "../../clients/stale-marker.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

describe("cascade carry label (#3167)", () => {
	it("labels a run carried across one turn with its observation age (#3168 F3)", () => {
		const observedAt = Date.now() - 95 * 60_000;
		expect(cascadeCarrySuffix(1, observedAt)).toBe(
			"(carried 1 turn · scanned 1h 35m ago)",
		);
	});

	it("falls to the neutral wording when the run has no stamp (the re-park arm, #3168 F3)", () => {
		expect(cascadeCarrySuffix(1)).toBe("(carried 1 turn · scan age unknown)");
	});

	it("labels multi-turn carries with the plural form (unreachable under the one-turn cap — pins the form should the cap lift, #3168 F8)", () => {
		const observedAt = Date.now() - 10_000;
		expect(cascadeCarrySuffix(3, observedAt)).toBe(
			"(carried 3 turns · scanned <1m ago)",
		);
	});

	it("emits no label for non-carried runs — no label noise", () => {
		expect(cascadeCarrySuffix(undefined)).toBeUndefined();
		expect(cascadeCarrySuffix(0)).toBeUndefined();
	});
});

describe("delivery-gate registry (#3167)", () => {
	it("F2: both cascade entries claim their seam calls as evidence", () => {
		const blocker = DELIVERY_SURFACES["runtime-turn:cascade-blocker"] as {
			evidence?: string[];
		};
		const coverage = DELIVERY_SURFACES[
			"runtime-turn:cascade-coverage-advisory"
		] as { evidence?: string[] };
		expect(blocker.evidence).toContain("cascadeCarrySuffix(");
		expect(coverage.evidence).toContain("withCarryLabel(");
	});

	it("the two carried-cascade entries are no longer partial", () => {
		for (const id of [
			"runtime-turn:cascade-blocker",
			"runtime-turn:cascade-coverage-advisory",
		]) {
			const entry = DELIVERY_SURFACES[id];
			expect(entry, id).toBeDefined();
			expect((entry as { status?: string }).status, id).toBeUndefined();
		}
	});
});

/**
 * The age-label lines each file HEADER owns. F10 is precisely about this
 * pairing: round 2 rendered `src/a.ts`'s label under `src/b.ts`'s header while
 * a.ts's own group carried none, so a count-only assertion could not see it.
 */
function labelsByHeader(text: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	let header: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.startsWith(" ") && line.endsWith(".ts")) {
			header = line;
			out[header] ??= [];
		} else if (
			// #3170's `(re-verify incomplete)` shares the group-label slot with
			// #3167's age label, so the F10 pairing question ("which header owns
			// this label, and how many times") is asked of both.
			/^ {2}\((?:scanned .+ ago|scan age unknown|re-verify incomplete)\)$/.test(
				line,
			)
		) {
			if (header !== undefined) out[header]?.push(line.trim());
		}
	}
	return out;
}

describe("demoted delta rows (#3167)", () => {
	let env: { tmpDir: string; cleanup: () => void };
	let cwd: string;
	let filePath: string;

	beforeEach(() => {
		// #3168: tracked fixture root, so `tests/config/tmp-fixture-hygiene`
		// sees this family's dirs instead of a raw untracked mkdtemp.
		env = setupTestEnvironment("pi-lens-age-label-");
		cwd = env.tmpDir;
		filePath = path.join(cwd, "src", "foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		resetProjectLensConfigCache();
	});

	afterEach(() => {
		env.cleanup();
	});

	function makeTool(cacheData: Record<string, unknown>) {
		return createLensDiagnosticsTool(
			{
				readCache: vi.fn((key: string) =>
					cacheData[key]
						? { data: cacheData[key], meta: { savedAt: "", scanner: key } }
						: undefined,
				),
			} as any,
			() => cwd,
		);
	}

	it("B3: a demoted delta file group renders exactly one age label", async () => {
		fs.writeFileSync(filePath, "const x = 1;\n");
		// The file's mtime must be NEWER than the report's observation stamp so
		// the freshness gate demotes the rows (edited since observed).
		const generatedAt = new Date(Date.now() - 60_000).toISOString();
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath,
						warnings: [
							{
								line: 1,
								rule: "no-unused-vars",
								tool: "eslint",
								message: "x is unused",
							},
						],
					},
				],
				generatedAt,
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).toContain(STALE_LINE_MARKER);
		expect(text).toContain("x is unused");
		// F1 (#3168): the label carries the CONTROLLED stamp's age — the seeded
		// generatedAt is exactly 60s old, so the neutral arm would be a false
		// pass. Mutation: removing the staleAsOf tag reds this assertion.
		expect(text).toContain("(scanned 1m ago)");
		const ageLabels = text.match(/scanned .* ago|scan age unknown/g) ?? [];
		expect(ageLabels.length, text).toBe(1);
	});

	it("F5: a file demoted in both reports renders exactly one age label", async () => {
		fs.writeFileSync(filePath, "const x = 1;\n");
		const generatedAt = new Date(Date.now() - 60_000).toISOString();
		const warning = {
			line: 1,
			rule: "no-unused-vars",
			tool: "eslint",
			message: "x is unused",
		};
		const tool = makeTool({
			"actionable-warnings": {
				files: [{ filePath, warnings: [warning] }],
				generatedAt,
				summary: { warnings: 1 },
			},
			"code-quality-warnings": {
				files: [{ filePath, warnings: [warning] }],
				generatedAt,
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{ cwd },
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		const ageLabels = text.match(/\(scanned 1m ago\)/g) ?? [];
		expect(ageLabels.length, text).toBe(1);
	});

	/**
	 * Recurrence this prevents (#3168 F10, shape (a)): round 2's F5 dedupe
	 * PREDICTED which loop would label, from the file's mere presence in the
	 * quality report, and so skipped the actionable label for `src/a.ts` — but
	 * the quality loop's header suppression renders a.ts's quality rows (and
	 * therefore its label) under `src/b.ts`'s header. a.ts's own group ended up
	 * with ZERO labels while b.ts's carried two. Labelling in the actionable
	 * loop first puts each label under the header it describes.
	 */
	it("F10(a): a file demoted in both reports is labelled under its OWN header, once", async () => {
		const aPath = path.join(cwd, "src", "a.ts");
		const bPath = path.join(cwd, "src", "b.ts");
		fs.writeFileSync(aPath, "const a = 1;\n");
		fs.writeFileSync(bPath, "const b = 1;\n");
		// Both files were last written 5m ago; both reports were observed 10m
		// ago — so the freshness gate demotes every row (edited since observed).
		const editedAtSec = (Date.now() - 5 * 60_000) / 1000;
		fs.utimesSync(aPath, editedAtSec, editedAtSec);
		fs.utimesSync(bPath, editedAtSec, editedAtSec);
		const observedAt = new Date(Date.now() - 10 * 60_000).toISOString();
		const warn = (message: string) => ({
			line: 1,
			rule: "no-unused-vars",
			tool: "eslint",
			message,
		});
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{ filePath: aPath, warnings: [warn("a is unused")] },
					{ filePath: bPath, warnings: [warn("b is unused")] },
				],
				generatedAt: observedAt,
				summary: { warnings: 2 },
			},
			"code-quality-warnings": {
				files: [{ filePath: aPath, warnings: [warn("a quality nit")] }],
				generatedAt: observedAt,
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).toContain(STALE_LINE_MARKER);
		expect(labelsByHeader(text), text).toEqual({
			"src/a.ts": ["(scanned 10m ago)"],
			"src/b.ts": ["(scanned 10m ago)"],
		});
	});

	/**
	 * Recurrence this prevents (#3168 F10, shape (b)): with a.ts demoted in the
	 * actionable report but LIVE in the quality report, an implementation that
	 * predicts which tier supplies the label (rather than recording it as a
	 * fact on the group, #3196's `group.staleRow`) can defer to the quality
	 * tier — which has no stale row here — and never reach the actionable
	 * tier's real one. Mutation: skipping the `if (!group.staleRow)` update in
	 * the actionable tier's loop (`tools/lens-diagnostics.ts`, so only the
	 * quality tier can ever set `group.staleRow`) reproduces exactly this: the
	 * demoted row ships with NO age label — the pre-#3167 defect the issue
	 * exists to remove.
	 */
	it("F10(b): a file demoted in actionable but live in quality still gets its label", async () => {
		const aPath = path.join(cwd, "src", "a.ts");
		fs.writeFileSync(aPath, "const a = 1;\n");
		// Written 5m ago. The actionable report predates the write (demote); the
		// quality report postdates it (live), so the quality loop has no stale
		// row and cannot carry the label for it.
		const editedAtSec = (Date.now() - 5 * 60_000) / 1000;
		fs.utimesSync(aPath, editedAtSec, editedAtSec);
		const warn = (message: string) => ({
			line: 1,
			rule: "no-unused-vars",
			tool: "eslint",
			message,
		});
		const tool = makeTool({
			"actionable-warnings": {
				files: [{ filePath: aPath, warnings: [warn("a is unused")] }],
				generatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
				summary: { warnings: 1 },
			},
			"code-quality-warnings": {
				files: [{ filePath: aPath, warnings: [warn("a quality nit")] }],
				generatedAt: new Date(Date.now() - 60_000).toISOString(),
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		// Premise: the actionable row IS demoted and the quality row is NOT.
		expect(text).toContain(`⚠ ${STALE_LINE_MARKER}`);
		expect(text).toContain("ℹ L1");
		expect(labelsByHeader(text), text).toEqual({
			"src/a.ts": ["(scanned 10m ago)"],
		});
	});

	/**
	 * Recurrence this prevents (#3168 F10, the quality-only shape): the dedupe
	 * must no-op the quality loop only for files the actionable loop ACTUALLY
	 * labelled. Forcing that guard closed drops the label from every file whose
	 * demoted rows exist in the quality report alone — the same silent-age
	 * defect from the other side, and the mutation direction the two shapes
	 * above cannot see.
	 */
	it("F10(c): a file demoted in the quality report alone is labelled under its own header", async () => {
		const aPath = path.join(cwd, "src", "a.ts");
		fs.writeFileSync(aPath, "const a = 1;\n");
		const editedAtSec = (Date.now() - 5 * 60_000) / 1000;
		fs.utimesSync(aPath, editedAtSec, editedAtSec);
		const tool = makeTool({
			"code-quality-warnings": {
				files: [
					{
						filePath: aPath,
						warnings: [
							{
								line: 1,
								rule: "no-unused-vars",
								tool: "eslint",
								message: "a quality nit",
							},
						],
					},
				],
				generatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).toContain(`ℹ ${STALE_LINE_MARKER}`);
		expect(labelsByHeader(text), text).toEqual({
			"src/a.ts": ["(scanned 10m ago)"],
		});
	});

	/**
	 * Recurrence this prevents (#3168 F10, carried onto #3170's second label):
	 * a file present in BOTH reports must contribute exactly one age label and
	 * one re-verify-incomplete label to its group, no matter how many tiers
	 * touched it. #3196's shared group-emit loop (`tools/lens-diagnostics.ts`,
	 * `for (const group of groups.values())`) renders `group.staleRow`/
	 * `group.incomplete` exactly once per file, after every tier has folded in
	 * — round 2 of #3176 instead deduped by PREDICTING the quality loop would
	 * label (`qualityLabeledFiles`), the same prediction #3168 F10 removed.
	 * Mutation: pushing the age-label and incomplete lines a SECOND time
	 * inside the emit loop (as if each tier still rendered its own trailer)
	 * duplicates both labels under `src/a.ts` here.
	 */
	it("#3170: a re-verify-incomplete file demoted in both reports carries both labels ONCE, under its own header", async () => {
		const aPath = path.join(cwd, "src", "a.ts");
		const bPath = path.join(cwd, "src", "b.ts");
		fs.writeFileSync(aPath, "const a = 1;\n");
		fs.writeFileSync(bPath, "const b = 1;\n");
		const editedAtSec = (Date.now() - 5 * 60_000) / 1000;
		fs.utimesSync(aPath, editedAtSec, editedAtSec);
		fs.utimesSync(bPath, editedAtSec, editedAtSec);
		const observedAt = new Date(Date.now() - 10 * 60_000).toISOString();
		const warn = (message: string) => ({
			line: 1,
			rule: "no-unused-vars",
			tool: "eslint",
			message,
		});
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					// The bounded re-verify could not complete for a.ts: the entry
					// is carried verbatim and the gap is labelled, never a false
					// clean (#3170 AC 3).
					{
						filePath: aPath,
						warnings: [warn("a is unused")],
						reVerifyIncomplete: true,
					},
					{ filePath: bPath, warnings: [warn("b is unused")] },
				],
				generatedAt: observedAt,
				summary: { warnings: 2 },
			},
			"code-quality-warnings": {
				files: [{ filePath: aPath, warnings: [warn("a quality nit")] }],
				generatedAt: observedAt,
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(labelsByHeader(text), text).toEqual({
			"src/a.ts": ["(scanned 10m ago)", "(re-verify incomplete)"],
			"src/b.ts": ["(scanned 10m ago)"],
		});
	});

	/**
	 * Recurrence this prevents: the same F10 duplication for a file whose rows
	 * are LIVE (its own file has not moved since the report stamp, so nothing
	 * is demoted) but whose re-verify was cut — the group's only label is the
	 * gap label. Mutation: pushing `"  (re-verify incomplete)"` a second time
	 * in the shared group-emit loop (`tools/lens-diagnostics.ts`, `if
	 * (group.incomplete) lines.push(...)`) duplicates the label under
	 * `src/a.ts`.
	 */
	it("#3170: a LIVE re-verify-incomplete file present in both reports carries the gap label once", async () => {
		const aPath = path.join(cwd, "src", "a.ts");
		fs.writeFileSync(aPath, "const a = 1;\n");
		// Written 10m ago, both reports observed 5m ago: nothing is demoted.
		const editedAtSec = (Date.now() - 10 * 60_000) / 1000;
		fs.utimesSync(aPath, editedAtSec, editedAtSec);
		const observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
		const warn = (message: string) => ({
			line: 1,
			rule: "no-unused-vars",
			tool: "eslint",
			message,
		});
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath: aPath,
						warnings: [warn("a is unused")],
						reVerifyIncomplete: true,
					},
				],
				generatedAt: observedAt,
				summary: { warnings: 1 },
			},
			"code-quality-warnings": {
				files: [{ filePath: aPath, warnings: [warn("a quality nit")] }],
				generatedAt: observedAt,
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).not.toContain(STALE_LINE_MARKER);
		expect(labelsByHeader(text), text).toEqual({
			"src/a.ts": ["(re-verify incomplete)"],
		});
	});

	it("B4: a missing observation stamp renders the neutral label, never a fabricated number", async () => {
		fs.writeFileSync(filePath, "const x = 1;\n");
		// No generatedAt at all: applyDeltaFreshnessGate returns files unchanged
		// when no stamp exists, so the rows render LIVE (not stale) — the label
		// contract here is exercised through the carried/stale arm only when a
		// stamp exists. This case pins the negative: no stamp → no rows demoted
		// → no label noise on a live row.
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath,
						warnings: [
							{
								line: 1,
								rule: "no-unused-vars",
								tool: "eslint",
								message: "x is unused",
							},
						],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = (await tool.execute(
			"1",
			{ mode: "delta" },
			undefined,
			null,
			{
				cwd,
			},
		)) as { content: Array<{ type: "text"; text: string }> };
		const text = result.content.map((part) => part.text).join("\n");
		expect(text).not.toContain(STALE_LINE_MARKER);
		expect(text).not.toContain("scan age unknown");
	});
});
