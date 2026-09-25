import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../file-utils.js";
import { writeFileAtomic } from "../atomic-write.js";
import { readJsonCache } from "../json-cache-read.js";
import { freshnessFromMtime } from "../freshness.js";
import { hashDiagnosticContent } from "../lsp/diagnostic-binding.js";
import type {
	ProjectDiagnosticsDeltaReport,
	ProjectDiagnosticsSnapshot,
} from "./types.js";

// v3 (#2154, #3060 review F1): rows carry `fileFingerprints` — the size and
// sha256 of the bytes the scan actually read. A v2 snapshot has no content
// axis at all; its rows can only be judged by `mtime <= scannedAt`, the test
// that let an edit landing mid-scan read as fresh forever. Every row here is
// a POSITIVE claim, so v2 records are rejected by the version guard and the
// project is re-scanned rather than served under the axis that failed — the
// same clean break `WORKSPACE_DIAGNOSTICS_CACHE_VERSION` v3 (#2776) made.
// v2: cheap-tier scan now also runs ast-grep-napi (#308); invalidate older
// snapshots so a pre-ast-grep cache isn't served as complete via refreshRunners=cached.
export const PROJECT_DIAGNOSTICS_CACHE_VERSION = 3;
const SNAPSHOT_CACHE_FILE = "project-diagnostics.json";
const DELTA_CACHE_FILE = "project-diagnostics-delta.json";

function cachePath(cwd: string, fileName: string): string {
	return path.join(getProjectDataDir(cwd), "cache", fileName);
}

export function loadProjectDiagnosticsSnapshot(
	cwd: string,
): ProjectDiagnosticsSnapshot | undefined {
	return readJsonCache<ProjectDiagnosticsSnapshot>(
		cachePath(cwd, SNAPSHOT_CACHE_FILE),
		(parsed) => {
			if (!parsed || typeof parsed !== "object") return undefined;
			const snapshot = parsed as ProjectDiagnosticsSnapshot;
			if (snapshot.version !== PROJECT_DIAGNOSTICS_CACHE_VERSION)
				return undefined;
			if (!Array.isArray(snapshot.diagnostics)) return undefined;
			return snapshot;
		},
	);
}

export function saveProjectDiagnosticsSnapshot(
	cwd: string,
	snapshot: ProjectDiagnosticsSnapshot,
): void {
	const filePath = cachePath(cwd, SNAPSHOT_CACHE_FILE);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileAtomic(filePath, JSON.stringify(snapshot, null, 2));
}

export function loadProjectDiagnosticsDeltaReport(
	cwd: string,
): ProjectDiagnosticsDeltaReport | undefined {
	return readJsonCache<ProjectDiagnosticsDeltaReport>(
		cachePath(cwd, DELTA_CACHE_FILE),
		(parsed) => {
			if (!parsed || typeof parsed !== "object") return undefined;
			const report = parsed as ProjectDiagnosticsDeltaReport;
			if (report.version !== PROJECT_DIAGNOSTICS_CACHE_VERSION)
				return undefined;
			if (!Array.isArray(report.diagnostics)) return undefined;
			return report;
		},
	);
}

export function writeProjectDiagnosticsDeltaReport(
	cwd: string,
	report: ProjectDiagnosticsDeltaReport,
): void {
	const filePath = cachePath(cwd, DELTA_CACHE_FILE);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileAtomic(filePath, JSON.stringify(report, null, 2));
}

/**
 * Drop diagnostics whose underlying file changed on disk after the snapshot was
 * taken (`mtimeMs > scannedAt + MTIME_DRIFT_TOLERANCE_MS`) or no longer
 * exists. The persisted snapshot is a
 * cross-session cache served by `lens_diagnostics mode=full refreshRunners=cached`;
 * without this it replays diagnostics the agent has since fixed or for files that
 * were deleted (#298 — "the cache needs to be cleaned before running diagnostics
 * because it became stale"). This mirrors `reconcileStaleWidgetFiles` for the
 * in-memory widget, applied at the consumer so `loadProjectDiagnosticsSnapshot`
 * stays a pure reader. Synchronous (a `statSync` per *distinct* file, memoised),
 * since the cached full-mode path is already off the typing hot loop.
 *
 * The boundary is `mtime > scannedAt + MTIME_DRIFT_TOLERANCE_MS`
 * (`blocker-freshness.ts`), not a bare `mtime > scannedAt`: #1711 found this
 * consumer's old +1ms slack did not cover the measured Windows host skew
 * between a file's mtime and the `Date.now()` read that produces `scannedAt`
 * (up to ~11.4ms, #1491/#1498) — a same-tick write-then-scan silently
 * dropped a live finding here, worse than `findingPathFreshness`'s sibling
 * gate (#1708) since this arm DROPS rather than demotes. Reusing the shared
 * constant keeps one source of truth for the measured skew.
 *
 * Fail-safe on an unparseable `scannedAt`: return the snapshot untouched rather
 * than risk dropping live findings on a clock/format anomaly.
 */
export function reconcileProjectDiagnosticsSnapshot(
	snapshot: ProjectDiagnosticsSnapshot,
): { snapshot: ProjectDiagnosticsSnapshot; staleDropped: number } {
	const scannedAtMs = Date.parse(snapshot.scannedAt);
	if (!Number.isFinite(scannedAtMs)) return { snapshot, staleDropped: 0 };

	const staleByFile = new Map<string, boolean>();
	const isStale = (filePath: string): boolean => {
		const cached = staleByFile.get(filePath);
		if (cached !== undefined) return cached;
		let stale: boolean;
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(filePath);
		} catch {
			stat = undefined; // deleted / unreadable -> indeterminate -> drop
		}
		// #2154: when the scan recorded what this file's bytes WERE, that answers
		// the question directly and the timestamp comparison below cannot — a
		// file edited while the scan was still running carries an mtime at or
		// before `scannedAt` while holding bytes no rule here ever saw. Size is
		// the cheap reject; only a same-size file is read and hashed. An exact
		// content match is stronger evidence than any mtime ordering, so it
		// settles the verdict on its own: these are per-file syntax rules, so
		// identical bytes mean identical findings no matter what the clock says.
		const fingerprint = snapshot.fileFingerprints?.[filePath];
		if (fingerprint && stat) {
			stale = true;
			if (stat.size === fingerprint.sizeBytes) {
				try {
					stale =
						hashDiagnosticContent(fs.readFileSync(filePath, "utf-8")) !==
						fingerprint.contentHash;
				} catch {
					stale = true; // unreadable now -> indeterminate -> drop
				}
			}
			staleByFile.set(filePath, stale);
			return stale;
		}
		const verdict = freshnessFromMtime({
			mtimeMs: stat?.mtimeMs,
			referenceMs: scannedAtMs,
		});
		// Pre-kernel policy: an unreadable/missing file is stale (dropped).
		stale = verdict.verdict !== "fresh";
		staleByFile.set(filePath, stale);
		return stale;
	};

	const kept = snapshot.diagnostics.filter((d) => !isStale(d.filePath));
	if (kept.length === snapshot.diagnostics.length) {
		return { snapshot, staleDropped: 0 };
	}
	const staleDropped = [...staleByFile.values()].filter(Boolean).length;
	return { snapshot: { ...snapshot, diagnostics: kept }, staleDropped };
}
