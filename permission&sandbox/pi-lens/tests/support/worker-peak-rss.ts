/**
 * The `[mem-file]` per-file peak-RSS record, and the registered-or-fail
 * ceiling it is measured against (#2042 record, #3058 gate).
 *
 * `WORKER_PEAK_RSS_BUDGET_MB` is what `resolveTestWorkerBudget` divides the
 * runner's memory by to pick `maxWorkers`. Nothing checked that any file
 * honoured it. `tests/config/bounded-container-guard.test.ts` landed on
 * 2026-09-14 at 9,226 MB — 4.5x the budget, 58% of the CI runner — and the
 * only symptom was the Unit job's SIGKILL rate climbing from 7.1% to 30.4%
 * over five days while the suite's memory low-water fell 8,532 MB. Nobody
 * could see it, because the budget was an assumption and not a gate.
 *
 * This is the gate, and it sits where the number is already MEASURED: the
 * `afterAll` hook in `vitest-setup.ts` reads `process.resourceUsage().maxRSS`
 * for the fork that just finished its file and hands it to `reportPeakRss`
 * below. A file over its ceiling fails its own suite, naming itself, on the
 * first run that carries it — not five days later in a kill cluster.
 *
 * The admission is the registry below, and it is two-part (AGENTS.md shape
 * 38): an entry raises a file's ceiling to a number that was actually
 * measured, AND states why the file cannot come under the budget. Because the
 * measured number IS the admission, a file may only ever shrink under its own
 * entry — growing past the admitted peak reds exactly as an unadmitted file
 * over the budget does.
 *
 * Empty in steady state, like `FINITE_REASONS` in
 * `tests/config/bounded-container-guard.test.ts` and `LATENCY_ADMITTED` in
 * `tests/config/vi-mock-export-sweep.test.ts`: as of this commit the suite's
 * two heaviest files measure 812 MB and 1,800 MB, both under the budget, so
 * there is nothing to admit.
 */

import { WORKER_PEAK_RSS_BUDGET_MB } from "../../scripts/lib/worker-budget.mjs";

export interface PeakRssAdmission {
	/** The file's measured `[mem-file]` peak, in MB. Its ceiling. */
	peakRssMb: number;
	/** Why it cannot come under the budget, naming the issue that tracks it. */
	reason: string;
}

/**
 * Keys are repo-relative POSIX paths, exactly as `[mem-file]` prints them.
 *
 * #3067 (#3062 review L1): `Object.freeze`, not just the `Readonly<>` type.
 * The type only stops the TypeScript compiler; `peakRssProblem`'s default
 * parameter reads this exact live object at call time, so without a real
 * runtime freeze a test file could mutate it in its own fork and admit
 * itself past the budget — `PEAK_RSS_ADMISSIONS["self"] = {...}` compiled
 * and ran clean. Every module here runs in ES module strict mode, so
 * mutating a frozen object throws a `TypeError` instead of silently
 * succeeding.
 */
export const PEAK_RSS_ADMISSIONS: Readonly<Record<string, PeakRssAdmission>> =
	Object.freeze({});

/**
 * The failure text for a file that exceeded its ceiling, or `undefined`.
 * `reportPeakRss` and `tests/config/worker-peak-rss-budget.test.ts` both call
 * this, so the guard has one implementation and one directly tested seam.
 */
export function peakRssProblem(
	file: string,
	peakRssMb: number,
	admissions: Readonly<Record<string, PeakRssAdmission>> = PEAK_RSS_ADMISSIONS,
): string | undefined {
	const admitted = admissions[file];
	const ceiling = admitted?.peakRssMb ?? WORKER_PEAK_RSS_BUDGET_MB;
	if (peakRssMb <= ceiling) return undefined;
	return admitted
		? `${file} peaked at ${peakRssMb} MB, above its admitted ${admitted.peakRssMb} MB ceiling in tests/support/worker-peak-rss.ts. An admission is a measured number, not a licence to grow: bring the file back down, or re-measure and raise the entry with its reason.`
		: `${file} peaked at ${peakRssMb} MB, over the ${WORKER_PEAK_RSS_BUDGET_MB} MB per-worker budget that scripts/lib/worker-budget.mjs divides the runner's memory by to pick maxWorkers (#3058). Cut the file's footprint, or add a measured admission with a reason to tests/support/worker-peak-rss.ts.`;
}

export interface PeakRssReport {
	/** Repo-relative POSIX path of the file that just finished. */
	file: string;
	peakRssMb: number;
	heapUsedMb: number;
	externalMb: number;
	/** Where the record goes. Production passes the fork's raw stderr write. */
	write: (line: string) => void;
	platform?: NodeJS.Platform;
	admissions?: Readonly<Record<string, PeakRssAdmission>>;
}

/**
 * Emit the record, then enforce the ceiling. Throws for a file over its
 * ceiling, which fails that file's own suite.
 *
 * The record is written BEFORE the check, so an over-budget file still leaves
 * its own `[mem-file]` line in the log — the number the reader needs in order
 * to cut or admit it. Its text is the shape
 * `scripts/lib/ci-failure-classifier.mjs` parses (`MEM_FILE_PEAK`), pinned by
 * the governance test.
 *
 * `platform` gates the ENFORCEMENT, never the record, and linux is the lane
 * that matters: `resolveTestWorkerBudget`'s CI branch governs the ubuntu
 * "Unit tests" job (the gating lane, and the one #2042's SIGKILLs land in),
 * while worker-budget.mjs's own provenance note records the constant as
 * UNVALIDATED against the ~3x heavier Windows profile, whose CI job is
 * advisory and runs a 40-file subset.
 */
export function reportPeakRss(report: PeakRssReport): void {
	const { file, peakRssMb, heapUsedMb, externalMb, write } = report;
	write(
		`[mem-file] peakRssMb=${peakRssMb} heapUsedMb=${heapUsedMb} externalMb=${externalMb} ${file}\n`,
	);
	if ((report.platform ?? process.platform) !== "linux") return;
	const problem = peakRssProblem(file, peakRssMb, report.admissions);
	if (problem) throw new Error(problem);
}
