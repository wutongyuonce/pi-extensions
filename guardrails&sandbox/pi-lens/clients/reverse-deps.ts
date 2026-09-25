import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeMapKey } from "./path-utils.js";
import {
	loadProjectSnapshot,
	saveProjectSnapshot,
	type ProjectSnapshot,
	type ProjectSnapshotFile,
} from "./project-snapshot.js";
import type { GraphFileImportChange } from "./review-graph/builder.js";
import type { ReviewGraph } from "./review-graph/types.js";

export interface ReverseDependencyIndex {
	projectRoot: string;
	generatedAt: string;
	seq?: number;
	imports: Record<string, string[]>;
	importedBy: Record<string, string[]>;
	source: "review-graph" | "project-snapshot";
}

/**
 * Rank files by the reverse-dependency centrality used throughout discovery:
 * most importers first, then most outgoing dependencies, then stable path.
 */
export function rankFilesByReverseDependencyCentrality(
	index: ReverseDependencyIndex,
): string[] {
	const files = new Set([
		...Object.keys(index.imports),
		...Object.keys(index.importedBy),
	]);
	return [...files].sort((a, b) => {
		const fanIn =
			(index.importedBy[b]?.length ?? 0) - (index.importedBy[a]?.length ?? 0);
		if (fanIn !== 0) return fanIn;
		const fanOut =
			(index.imports[b]?.length ?? 0) - (index.imports[a]?.length ?? 0);
		return fanOut || a.localeCompare(b);
	});
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set([...values].map((value) => normalizeMapKey(value)))].sort(
		(a, b) => a.localeCompare(b),
	);
}

function addEdge(
	index: ReverseDependencyIndex,
	fromFile: string,
	toFile: string,
) {
	const from = normalizeMapKey(fromFile);
	const to = normalizeMapKey(toFile);
	if (from === to) return;
	(index.imports[from] ??= []).push(to);
	(index.importedBy[to] ??= []).push(from);
}

function normalizeIndex(index: ReverseDependencyIndex): ReverseDependencyIndex {
	// #1814 F2: `imports[file]` asserts "we know file's complete import
	// list" — true only when `index.imports` already has a raw entry for
	// `file` (from a real per-file scan). `importedBy[file]` asserts "we
	// know SOME importer of file", which holds regardless of whether `file`
	// itself was ever scanned. Materializing `imports[file] = []` for every
	// key in their UNION (the pre-fix behavior) fabricated the first claim
	// for a file that is only an `importedBy` target — imported by
	// something, never itself scanned — indistinguishable downstream from a
	// file the scan confirmed has zero imports.
	// `clients/lsp/workspace-diagnostics-cache.ts`'s `getImports` reads this
	// map directly and relies on `undefined` meaning "not covered". Only
	// `importedBy` keeps the union treatment: "who imports me" has no
	// equivalent "was I scanned" precondition to fabricate.
	const importFileKeys = [...new Set(Object.keys(index.imports))].sort((a, b) =>
		a.localeCompare(b),
	);
	const allFileKeys = new Set([
		...importFileKeys,
		...Object.keys(index.importedBy),
	]);
	const imports: Record<string, string[]> = {};
	for (const file of importFileKeys) {
		imports[file] = sortedUnique(index.imports[file] ?? []);
	}
	const importedBy: Record<string, string[]> = {};
	for (const file of [...allFileKeys].sort((a, b) => a.localeCompare(b))) {
		importedBy[file] = sortedUnique(index.importedBy[file] ?? []);
	}
	return { ...index, imports, importedBy };
}

function filePathForNode(
	graph: ReviewGraph,
	nodeId: string,
): string | undefined {
	const filePath = graph.nodes.get(nodeId)?.filePath;
	return filePath ? normalizeMapKey(filePath) : undefined;
}

export function buildReverseDependencyIndexFromGraph(args: {
	cwd: string;
	graph: ReviewGraph;
	seq?: number;
}): ReverseDependencyIndex {
	const index: ReverseDependencyIndex = {
		projectRoot: normalizeMapKey(path.resolve(args.cwd)),
		generatedAt: new Date().toISOString(),
		seq: args.seq,
		imports: {},
		importedBy: {},
		source: "review-graph",
	};

	for (const filePath of args.graph.fileNodes.keys()) {
		const normalized = normalizeMapKey(filePath);
		index.imports[normalized] ??= [];
		index.importedBy[normalized] ??= [];
	}

	for (const edge of args.graph.edges) {
		if (edge.kind !== "imports") continue;
		const fromFile = filePathForNode(args.graph, edge.from);
		const toFile = filePathForNode(args.graph, edge.to);
		if (!fromFile || !toFile) continue;
		addEdge(index, fromFile, toFile);
	}

	return normalizeIndex(index);
}

/** Apply per-file import-target deltas without walking the full review graph. */
export function patchReverseDependencyIndex(
	index: ReverseDependencyIndex,
	changes: readonly GraphFileImportChange[],
): ReverseDependencyIndex {
	const imports = { ...index.imports };
	const importedBy = { ...index.importedBy };

	for (const change of changes) {
		const file = normalizeMapKey(change.filePath);
		for (const target of sortedUnique(change.priorTargets)) {
			importedBy[target] = sortedUnique(
				(importedBy[target] ?? []).filter(
					(importer) => normalizeMapKey(importer) !== file,
				),
			);
		}
		if (change.existsAfter) {
			const newTargets = sortedUnique(change.newTargets);
			imports[file] = newTargets;
			importedBy[file] ??= [];
			for (const target of newTargets) {
				importedBy[target] = sortedUnique([
					...(importedBy[target] ?? []),
					file,
				]);
			}
		} else {
			delete imports[file];
			delete importedBy[file];
		}
	}

	return normalizeIndex({
		...index,
		generatedAt: new Date().toISOString(),
		imports,
		importedBy,
	});
}

export function buildReverseDependencyIndexFromSnapshot(
	snapshot: ProjectSnapshot,
): ReverseDependencyIndex | null {
	const reverseDeps = snapshot.reverseDeps ?? {};
	const hasReverseDeps = Object.keys(reverseDeps).length > 0;
	const fileEntries = Object.entries(snapshot.files ?? {});
	const hasFileImports = fileEntries.some(([, file]) =>
		Array.isArray(file.imports),
	);
	if (!hasReverseDeps && !hasFileImports) return null;

	const index: ReverseDependencyIndex = {
		projectRoot: normalizeMapKey(snapshot.projectRoot),
		generatedAt: snapshot.generatedAt,
		seq: snapshot.seq,
		imports: {},
		importedBy: {},
		source: "project-snapshot",
	};

	for (const [filePath, file] of fileEntries) {
		const normalized = normalizeMapKey(file.path || filePath);
		// #1814 F2: only materialize `imports[normalized]` when this
		// snapshot entry genuinely recorded an import list. `file.imports`
		// absent means this file was captured in the snapshot (e.g. a
		// lightweight touch) but never had its own imports scanned —
		// defaulting to `[]` here fabricated the "covered, zero imports"
		// claim `getImports` (workspace-diagnostics-cache.ts) distinguishes
		// from "not covered". `hasFileImports` above already anticipates a
		// mixed snapshot with entries in both states; this closes the gap
		// per entry.
		if (Array.isArray(file.imports)) {
			const imports = sortedUnique(file.imports);
			index.imports[normalized] = imports;
			for (const imported of imports) {
				index.importedBy[imported] ??= [];
				index.importedBy[imported].push(normalized);
			}
		}
		index.importedBy[normalized] ??= [];
	}
	for (const [filePath, importers] of Object.entries(reverseDeps)) {
		const normalized = normalizeMapKey(filePath);
		index.importedBy[normalized] = sortedUnique([
			...(index.importedBy[normalized] ?? []),
			...importers,
		]);
		// #1814 F2 (class sweep): do NOT fabricate `imports[normalized] = []`
		// here — `reverseDeps` records who imports `normalized`, not what
		// `normalized` itself imports. Leave `imports[normalized]` exactly
		// as the fileEntries loop above established it: present and real
		// from a scan, or absent because this file was never scanned.
		for (const importer of index.importedBy[normalized]) {
			// #1814 F2: only record this edge on `importer`'s own imports
			// list when that list is already genuinely known (a real
			// per-file scan from the fileEntries loop above) — appending to
			// an absent list would silently promote "we know ONE edge from
			// reverseDeps" into "we know importer's COMPLETE import list",
			// the same false-coverage claim closed above.
			if (index.imports[importer] === undefined) continue;
			if (!index.imports[importer].includes(normalized)) {
				index.imports[importer].push(normalized);
			}
		}
	}

	return normalizeIndex(index);
}

export function loadReverseDependencyIndexFromSnapshot(args: {
	cwd: string;
	currentProjectSeq?: number;
}): ReverseDependencyIndex | null {
	const snapshot = loadProjectSnapshot(args.cwd);
	if (!snapshot) return null;
	if (
		typeof args.currentProjectSeq === "number" &&
		snapshot.seq !== args.currentProjectSeq
	) {
		return null;
	}
	return buildReverseDependencyIndexFromSnapshot(snapshot);
}

export function getReverseDepsFromIndex(
	index: ReverseDependencyIndex,
	filePath: string,
): string[] {
	return sortedUnique(
		index.importedBy[normalizeMapKey(path.resolve(filePath))] ?? [],
	);
}

export function getAffectedFilesFromIndex(
	index: ReverseDependencyIndex,
	filePath: string,
	depth = 1,
	maxFiles = 50,
): string[] {
	const start = normalizeMapKey(path.resolve(filePath));
	const maxDepth = Math.max(1, Math.floor(depth));
	const queue: Array<{ filePath: string; depth: number }> = [
		{ filePath: start, depth: 0 },
	];
	const seen = new Set([start]);
	const affected: string[] = [];
	while (queue.length > 0 && affected.length < maxFiles) {
		const current = queue.shift();
		if (!current || current.depth >= maxDepth) continue;
		for (const importer of getReverseDepsFromIndex(index, current.filePath)) {
			if (seen.has(importer)) continue;
			seen.add(importer);
			affected.push(importer);
			if (affected.length >= maxFiles) break;
			queue.push({ filePath: importer, depth: current.depth + 1 });
		}
	}
	return affected;
}

function snapshotFileFor(
	filePath: string,
	imports: string[],
): ProjectSnapshotFile {
	try {
		const stat = fs.statSync(filePath);
		return {
			path: filePath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			imports,
			lastSeq: 0,
		};
	} catch {
		return { path: filePath, mtimeMs: 0, size: 0, imports, lastSeq: 0 };
	}
}

export function writeReverseDependencyIndexToSnapshot(args: {
	cwd: string;
	index: ReverseDependencyIndex;
	dbg?: (msg: string) => void;
}): boolean {
	try {
		const snapshot = loadProjectSnapshot(args.cwd);
		if (!snapshot) return false;
		const reverseDeps: Record<string, string[]> = {};
		for (const [filePath, importers] of Object.entries(args.index.importedBy)) {
			reverseDeps[normalizeMapKey(filePath)] = sortedUnique(importers);
		}
		const files: Record<string, ProjectSnapshotFile> = { ...snapshot.files };
		for (const [filePath, imports] of Object.entries(args.index.imports)) {
			const normalized = normalizeMapKey(filePath);
			files[normalized] = {
				...(files[normalized] ??
					snapshotFileFor(normalized, sortedUnique(imports))),
				path: normalized,
				imports: sortedUnique(imports),
			};
		}
		saveProjectSnapshot(args.cwd, {
			...snapshot,
			generatedAt: new Date().toISOString(),
			files,
			reverseDeps,
		});
		args.dbg?.(
			`reverse_deps: saved ${Object.keys(reverseDeps).length} entries to project snapshot`,
		);
		return true;
	} catch (err) {
		args.dbg?.(`reverse_deps: snapshot save failed: ${err}`);
		return false;
	}
}
