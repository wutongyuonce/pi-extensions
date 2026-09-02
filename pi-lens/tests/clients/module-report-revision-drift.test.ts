/**
 * #1961 review F4 — the drift caveat must reach `module_report`, not only
 * `project_report`.
 *
 * Both tools read through `getCachedReviewGraph`, which now SERVES a snapshot
 * stamped at a different commit instead of dropping it. `project_report` says
 * so in its trust notes. Without this, `module_report` would present the other
 * branch's importers, blast radius, and call edges as current, under a
 * `builtAt` that looks fresh — the same claim, made silently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { moduleReport } from "../../clients/module-report.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
} from "../../clients/review-graph/builder.js";
import { _resetGitIdentityCacheForTests } from "../../clients/review-graph/git-identity.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];
let previousDataDir: string | undefined;

/** Minimal hand-built `.git` — no git binary needed. */
function makeFakeRepo(root: string, headSha: string, branch = "main"): void {
	const gitDir = path.join(root, ".git");
	fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	fs.writeFileSync(path.join(gitDir, "refs", "heads", branch), `${headSha}\n`);
}

function setHead(root: string, headSha: string, branch = "main"): void {
	fs.writeFileSync(
		path.join(root, ".git", "refs", "heads", branch),
		`${headSha}\n`,
	);
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!fs.existsSync(filePath)) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timed out waiting for ${filePath}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A two-file project so the report has real graph-derived sections. */
function makeProject(): { root: string; target: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mr-drift-"));
	dirs.push(root);
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	const target = path.join(root, "src", "hub.ts");
	fs.writeFileSync(target, "export function hubFn() {\n\treturn 1;\n}\n");
	fs.writeFileSync(
		path.join(root, "src", "consumer.ts"),
		"import { hubFn } from './hub';\nexport const used = hubFn();\n",
	);
	return { root, target };
}

beforeEach(() => {
	clearReviewGraphWorkspaceCache();
	_resetGitIdentityCacheForTests();
	resetDegradationLedger();
	previousDataDir = process.env.PILENS_DATA_DIR;
});

afterEach(() => {
	clearReviewGraphWorkspaceCache();
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("module_report revision drift (#1961 review F4)", () => {
	it("warns that the served graph was built at another commit", async () => {
		const { root, target } = makeProject();
		process.env.PILENS_DATA_DIR = path.join(root, "data");
		makeFakeRepo(root, "a".repeat(40));

		await buildOrUpdateGraph(root, [], new FactStore());
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(root), "cache", "review-graph.json.gz"),
		);

		// A plain commit: HEAD moves, files are untouched. The snapshot is served
		// (that is #1961's fix) and the caveat must travel with it.
		_resetGitIdentityCacheForTests();
		setHead(root, "b".repeat(40));
		clearReviewGraphWorkspaceCache();

		const report = await moduleReport(target, root);
		expect(getCachedReviewGraph(root)).toBeDefined();
		const warning = report.warnings?.find((w) =>
			w.includes("Graph was built at commit"),
		);
		expect(warning).toBeDefined();
		expect(warning).toContain("aaaaaaaa");
		expect(warning).toContain("bbbbbbbb");
	});

	it("emits no drift warning when the snapshot matches HEAD", async () => {
		const { root, target } = makeProject();
		process.env.PILENS_DATA_DIR = path.join(root, "data");
		makeFakeRepo(root, "a".repeat(40));

		await buildOrUpdateGraph(root, [], new FactStore());
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(root), "cache", "review-graph.json.gz"),
		);

		clearReviewGraphWorkspaceCache();
		_resetGitIdentityCacheForTests();
		const report = await moduleReport(target, root);
		expect(getCachedReviewGraph(root)).toBeDefined();
		expect(
			report.warnings?.some((w) => w.includes("Graph was built at commit")),
		).not.toBe(true);
	});
});
