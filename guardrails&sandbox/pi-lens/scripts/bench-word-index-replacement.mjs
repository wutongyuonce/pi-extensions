#!/usr/bin/env node
/**
 * Per-edit word-index replacement bench (#2067).
 *
 * Measures the cost the cascade seam pays for ONE document replacement, on a
 * corpus read from a real source tree (this repository by default), so the
 * posting-entry count is in the same range as the issue's field measurement
 * rather than a synthetic fixture's. Run after `npm run build`:
 *
 *   node scripts/bench-word-index-replacement.mjs \
 *     [--corpus <dir>] [--edits N] [--target-bytes N]
 *
 * It reports, for both replacement primitives:
 *   - latency distribution per edit (wall clock)
 *   - the longest synchronous stretch the edit held the event loop
 *
 * The synchronous column is what the cascade seam used to call; the cooperative
 * column is what it calls now. It also reports the share of CPU samples
 * attributed to `normalizeEphemeralMapKey` (acceptance criterion 2) and checks
 * that both primitives leave a byte-identical index and identical BM25 output
 * for a fixed query set (acceptance criterion 5).
 *
 * The inspector profile is self-sample based, so the attribution reproduces
 * without a machine-specific `--prof-process` installation.
 */
import * as inspector from "node:inspector";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const readArg = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const corpusRoot = path.resolve(readArg("--corpus", root));
const editCount = Number(readArg("--edits", "60"));

const wordIndexUrl = pathToFileURL(
	path.join(root, "clients", "word-index.js"),
).href;
const {
	buildWordIndex,
	collectWordIndexDocs,
	countWordIndexPostingEntries,
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
	updateWordIndexDocumentForEdit,
	estimateWordIndexResidentBytes,
} = await import(wordIndexUrl);

const { getDegradationSummary, resetDegradationLedger } = await import(
	pathToFileURL(path.join(root, "clients", "degradation-ledger.js")).href
);
const recompactionCount = () =>
	getDegradationSummary().find(
		(group) => group.kind === "word-index-arena-recompact",
	)?.count ?? 0;

const QUERIES = [
	"word index posting",
	"cascade neighbour budget",
	"availability policy latch",
	"normalize map key",
	"degradation ledger",
	"tree sitter grammar",
	"lsp diagnostics",
	"persist debounce",
];

const docs = await collectWordIndexDocs(corpusRoot);
if (docs.length < 500) {
	throw new Error(
		`corpus ${corpusRoot} yielded only ${docs.length} documents; pass --corpus <larger tree>`,
	);
}
// Acceptance criterion 1 names a 20 KB document, and the issue's per-size table
// shows replacement cost rising with document size, so edit the documents
// closest to that size rather than an arbitrary slice of the corpus.
//
// The default run reproduces the 20 KB row. For the large-document row, raise
// the target past every document in the corpus so the largest ones are picked:
//
//   node scripts/bench-word-index-replacement.mjs --target-bytes 500000 --edits 30
//
// Absolute numbers vary by machine, OS, and event-loop load. The block-time
// columns are the comparable ones; caller-return latency inflates for the
// cooperative path on a loaded loop, because yielding lets competing work in.
const targetBytes = Number(readArg("--target-bytes", "20480"));
const sizeOf = (doc) => Buffer.byteLength(doc.content, "utf8");
const targets = [...docs]
	.sort(
		(a, b) =>
			Math.abs(sizeOf(a) - targetBytes) - Math.abs(sizeOf(b) - targetBytes),
	)
	.slice(0, editCount);

function ranked(index) {
	return QUERIES.map((query) => [
		query,
		searchWordIndex(index, query, { limit: 5 }).map((result) => [
			result.file,
			Number(result.score.toFixed(6)),
			result.hits,
			result.lines,
		]),
	]);
}

/**
 * Replace every target document, sampling the event loop from an independent
 * self-rescheduling tick so the longest synchronous stretch is measured rather
 * than inferred from wall-clock duration.
 */
async function run(label, replace) {
	const index = buildWordIndex(docs);
	resetDegradationLedger();
	let peakResidentBytes = estimateWordIndexResidentBytes?.(index) ?? 0;
	const durations = [];
	const blocks = [];
	let maxBlockMs = 0;
	let running = true;
	let last = process.hrtime.bigint();
	const tick = () => {
		const now = process.hrtime.bigint();
		const lagMs = Number(now - last) / 1e6;
		if (lagMs > maxBlockMs) maxBlockMs = lagMs;
		last = now;
		if (running) setImmediate(tick);
	};
	setImmediate(tick);
	for (const target of targets) {
		const content = `${target.content}\nexport const benchMarker = 1;`;
		// Turn the event loop between edits: a real session never lands two edits
		// inside one loop turn, and without this the synchronous variant's queued
		// recompactions never get to run, which flatters it.
		await new Promise((resolve) => setImmediate(resolve));
		maxBlockMs = 0;
		const started = performance.now();
		if (!(await replace(index, { path: target.path, content }))) {
			throw new Error(`${label}: replacement was not available`);
		}
		durations.push(performance.now() - started);
		await new Promise((resolve) => setImmediate(resolve));
		blocks.push(maxBlockMs);
		const resident = estimateWordIndexResidentBytes?.(index) ?? 0;
		if (resident > peakResidentBytes) peakResidentBytes = resident;
	}
	running = false;
	await new Promise((resolve) => setImmediate(resolve));
	const stats = (values) => {
		const sorted = [...values].sort((a, b) => a - b);
		return {
			mean: values.reduce((sum, value) => sum + value, 0) / values.length,
			p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
			p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
			max: sorted[sorted.length - 1],
		};
	};
	return {
		label,
		index,
		latency: stats(durations),
		block: stats(blocks),
		recompactions: recompactionCount(),
		peakResidentBytes,
	};
}

const probe = buildWordIndex(docs);
console.log(`corpus root: ${corpusRoot}`);
console.log(`corpus documents: ${docs.length}`);
console.log(`posting entries: ${countWordIndexPostingEntries(probe)}`);
console.log(`distinct tokens: ${probe.postings.size}`);
console.log(
	`fresh-build resident: ${(
		(estimateWordIndexResidentBytes?.(probe) ?? 0) /
		(1024 * 1024)
	).toFixed(1)} MB`,
);
console.log(`edits: ${targets.length}`);
console.log(
	`target bytes: mean ${Math.round(
		targets.reduce((sum, doc) => sum + sizeOf(doc), 0) / targets.length,
	)}, min ${Math.min(...targets.map(sizeOf))}, max ${Math.max(
		...targets.map(sizeOf),
	)}`,
);

const session = new inspector.Session();
session.connect();
function post(method, params = {}) {
	return new Promise((resolve, reject) => {
		session.post(method, params, (error, result) =>
			error ? reject(error) : resolve(result),
		);
	});
}

const syncRun = await run("synchronous", (index, doc) =>
	updateWordIndexDocument(index, doc),
);

await post("Profiler.enable");
await post("Profiler.start");
const asyncRun = await run("cooperative", (index, doc) =>
	updateWordIndexDocumentForEdit(index, doc),
);
const { profile } = await post("Profiler.stop");
session.disconnect();

const row = (name, s) =>
	`${name}: mean ${s.mean.toFixed(1)} ms, p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms`;
for (const result of [syncRun, asyncRun]) {
	console.log(row(`${result.label} latency per edit`, result.latency));
	console.log(row(`${result.label} sync block per edit`, result.block));
	console.log(
		`${result.label} arena recompactions: ${result.recompactions} over ${targets.length} edits, peak resident ${(
			result.peakResidentBytes /
			(1024 * 1024)
		).toFixed(1)} MB`,
	);
}

const samples = profile.samples ?? [];
const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]));
const parents = new Map();
for (const node of nodes.values()) {
	for (const childId of node.children ?? []) parents.set(childId, node.id);
}
const normalizerSamples = samples.filter((sample) => {
	let nodeId = sample;
	while (nodeId !== undefined) {
		const node = nodes.get(nodeId);
		if (!node) break;
		if (node.callFrame?.functionName === "normalizeEphemeralMapKey")
			return true;
		nodeId = parents.get(nodeId);
	}
	return false;
}).length;
console.log(
	`normalizeEphemeralMapKey: ${(
		(100 * normalizerSamples) /
		Math.max(1, samples.length)
	).toFixed(3)}% of ${samples.length} samples`,
);

const selfByFrame = new Map();
for (const sample of samples) {
	const node = nodes.get(sample);
	if (!node) continue;
	const frame = node.callFrame ?? {};
	const where = `${frame.functionName || "(anonymous)"} ${path.basename(
		frame.url || "",
	)}:${(frame.lineNumber ?? -1) + 1}`;
	selfByFrame.set(where, (selfByFrame.get(where) ?? 0) + 1);
}
console.log("top self-time frames (cooperative run):");
for (const [where, count] of [...selfByFrame]
	.sort((a, b) => b[1] - a[1])
	.slice(0, 12)) {
	console.log(
		`  ${((100 * count) / Math.max(1, samples.length)).toFixed(1).padStart(5)}%  ${where}`,
	);
}

const identicalIndex =
	JSON.stringify(serializeWordIndex(syncRun.index)) ===
	JSON.stringify(serializeWordIndex(asyncRun.index));
const identicalRanking =
	JSON.stringify(ranked(syncRun.index)) ===
	JSON.stringify(ranked(asyncRun.index));
console.log(`serialized index identical: ${identicalIndex}`);
console.log(
	`BM25 output identical over ${QUERIES.length} queries: ${identicalRanking}`,
);
if (!identicalIndex || !identicalRanking) process.exitCode = 1;
