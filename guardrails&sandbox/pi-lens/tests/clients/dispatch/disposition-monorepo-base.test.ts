/**
 * #1030 regression — monorepo disposition base-directory divergence.
 *
 * The mark tool (lens-diagnostic-mark) writes dispositions keyed on the PROJECT
 * ROOT (`runtime.projectRoot`). The per-edit dispatch read path used to key the
 * disposition filter on `ctx.cwd`, which `createDispatchContext` resolves to the
 * nearest LANGUAGE ROOT (`resolveLanguageRootForFile` — a nested `tsconfig.json`/
 * `package.json` dir in a monorepo). Because both the anchor AND the store
 * location (`getProjectDataDir`) are keyed on that base, write and read hit
 * DIFFERENT `diagnostic-dispositions.json` files with DIFFERENT anchors, so every
 * false-positive/flagged/defer mark on a file under a nested marker silently
 * no-op'd (#533 invisible-mark class).
 *
 * These tests drive the real dispatch pipeline (dispatchForFile) against a nested
 * language-root fixture and assert the mark is honored. Pre-fix the diagnostic
 * reappears (different anchor + different store); with the fix (read from
 * `ctx.projectRoot`) it is filtered. The single-project case (language root ==
 * project root) is asserted unchanged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	markDisposition,
} from "../../../clients/diagnostic-dispositions.js";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerGroup } from "../../../clients/dispatch/types.js";
import { createMockRunner } from "../../mocks/runner-factory.js";
import { removeTempDirSync } from "../test-utils.js";

let tmpDir: string;
let previousDataDir: string | undefined;

const FILE_CONTENT = "export const target = bad();\n";
const DIAG = {
	tool: "eslint",
	rule: "no-bad",
	message: "bad call",
	line: 1,
};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1030-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	// Isolated store so the test never touches the real disposition state.
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearCoverageNoticeState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetStateCacheForTests();
	removeTempDirSync(tmpDir);
});

/** A runner that always reports the single diagnostic the mark targets. */
function reporterFor(fileAbs: string): RunnerRegistry {
	const registry = new RunnerRegistry();
	registry.register(
		createMockRunner({
			id: "eslint",
			appliesTo: ["jsts"],
			runResult: {
				status: "succeeded",
				diagnostics: [
					{
						id: "diag-1",
						message: DIAG.message,
						filePath: fileAbs,
						line: DIAG.line,
						severity: "warning",
						semantic: "warning",
						tool: DIAG.tool,
						rule: DIAG.rule,
					},
				],
				semantic: "warning",
			},
		}),
	);
	return registry;
}

async function runDispatch(
	fileAbs: string,
	projectRoot: string,
): Promise<{ ctx: ReturnType<typeof createDispatchContext>; count: number }> {
	const facts = new FactStore();
	const ctx = createDispatchContext(
		fileAbs,
		projectRoot,
		{ getFlag: () => false },
		facts,
	);
	// The strict (false-positive) anchor hashes the diagnostic's own line from
	// the file content the dispatcher reads out of the fact store — seed it with
	// the same content the mark was recorded against.
	facts.setFileFact(ctx.filePath, "file.content", FILE_CONTENT);
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["eslint"] }];
	const result = await dispatchForFile(ctx, groups, reporterFor(fileAbs));
	return { ctx, count: result.diagnostics.length };
}

describe("#1030 disposition base divergence (monorepo nested language root)", () => {
	it("honors a project-root false-positive mark on a file under a nested language root", async () => {
		const projectRoot = path.join(tmpDir, "project");
		const appRoot = path.join(projectRoot, "packages", "app");
		const srcDir = path.join(appRoot, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		// Nested marker → resolveLanguageRootForFile picks packages/app, not root.
		fs.writeFileSync(path.join(appRoot, "tsconfig.json"), "{}\n");
		const fileAbs = path.join(srcDir, "x.ts");
		fs.writeFileSync(fileAbs, FILE_CONTENT);

		// WRITE exactly as the mark tool does: base = project root.
		markDisposition(
			projectRoot,
			{ cwd: projectRoot, filePath: fileAbs, ...DIAG, content: FILE_CONTENT },
			"false-positive",
		);
		_resetStateCacheForTests();

		const { ctx, count } = await runDispatch(fileAbs, projectRoot);

		// The divergence the bug rides on must actually be present in this fixture:
		// dispatch resolves cwd to the nested language root, distinct from the root.
		expect(ctx.projectRoot).toBeDefined();
		expect(ctx.cwd).not.toBe(ctx.projectRoot);
		expect(ctx.cwd.toLowerCase()).toContain("packages/app");
		expect((ctx.projectRoot ?? "").toLowerCase().endsWith("/project")).toBe(
			true,
		);

		// Fix: dispatch reads dispositions from the project root, so the mark is
		// found and the diagnostic is filtered. Pre-fix this is 1 (mark invisible).
		expect(count).toBe(0);
	});

	it("still honors the mark when the language root IS the project root (single-project unchanged)", async () => {
		const projectRoot = path.join(tmpDir, "solo");
		const srcDir = path.join(projectRoot, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		// Marker at the project root → language root == project root.
		fs.writeFileSync(path.join(projectRoot, "tsconfig.json"), "{}\n");
		const fileAbs = path.join(srcDir, "x.ts");
		fs.writeFileSync(fileAbs, FILE_CONTENT);

		markDisposition(
			projectRoot,
			{ cwd: projectRoot, filePath: fileAbs, ...DIAG, content: FILE_CONTENT },
			"false-positive",
		);
		_resetStateCacheForTests();

		const { ctx, count } = await runDispatch(fileAbs, projectRoot);

		// language root == project root here (no nested marker).
		expect(ctx.cwd).toBe(ctx.projectRoot);
		expect(count).toBe(0);
	});
});
