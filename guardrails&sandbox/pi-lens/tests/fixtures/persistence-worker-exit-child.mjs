// This fixture imports the COMPILED `clients/*.js` output (see the dynamic
// `import("../../clients/....js")` calls below), not the `.ts` sources. Run
// `npm run build` before running this file directly or via a focused
// `vitest run tests/clients/persistence-worker-exit.test.ts` — otherwise the
// worker exercises stale compiled code and the test can silently pass/fail
// against a build that predates your edits. CI is unaffected: it always runs
// `npm run build` before `npm test`.
import * as fs from "node:fs";
import * as path from "node:path";

const [kind, tempRoot] = process.argv.slice(2);
if ((kind !== "project-snapshot" && kind !== "review-graph") || !tempRoot) {
	throw new Error(
		"usage: persistence-worker-exit-child.mjs <project-snapshot|review-graph> <temp-root>",
	);
}

const projectRoot = path.join(tempRoot, "project");
fs.mkdirSync(projectRoot, { recursive: true });
process.env.PILENS_DATA_DIR = path.join(tempRoot, "data");
process.env.NODE_ENV = "test";

if (kind === "project-snapshot") {
	delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "1000";
	const snapshot = await import("../../clients/project-snapshot.js");
	const base = {
		version: snapshot.PROJECT_SNAPSHOT_VERSION,
		projectRoot,
		generatedAt: new Date().toISOString(),
		seq: 1,
		files: {},
		symbols: {},
		reverseDeps: {},
		cachedExports: [],
	};
	snapshot.saveProjectSnapshot(projectRoot, base);
	snapshot.saveProjectSnapshot(projectRoot, {
		...base,
		generatedAt: new Date(Date.now() + 1000).toISOString(),
		cachedExports: [["latest", path.join(projectRoot, "latest.ts")]],
	});
	process.stdout.write(
		`snapshot-path:${snapshot.getProjectSnapshotPath(projectRoot)}\n`,
	);
} else {
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
	const sourcePath = path.join(projectRoot, "source.ts");
	fs.writeFileSync(sourcePath, "export const persisted = true;\n");
	const [{ FactStore }, graph] = await Promise.all([
		import("../../clients/dispatch/fact-store.js"),
		import("../../clients/review-graph/builder.js"),
	]);
	await graph.buildOrUpdateGraph(projectRoot, [sourcePath], new FactStore());
	await graph.waitForReviewGraphPersistsForTests();
	if (!fs.existsSync(graph.reviewGraphCachePath(projectRoot))) {
		throw new Error("review graph did not persist");
	}
}

process.stdout.write(`persisted:${kind}\n`);
