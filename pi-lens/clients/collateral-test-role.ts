/**
 * Shared test-role predicate for COLLATERAL cascade/impact surfaces (#1080).
 *
 * The review graph is already tests-free (`review-graph/builder.ts` applies
 * `detectFileRole(file) !== "test"` at its walk/incremental chokepoints), but
 * several collateral surfaces re-derive neighbors from OTHER sources that never
 * saw that filter — LSP reference expansion, module-level downstream expansion,
 * the reverse-dependency index, and the passive-diagnostics fallback — so an
 * unignored `*.test.*` / `tests/` file can still leak into cascade neighbor
 * output, the formatted impact header/counts, the turn-end call-graph advisory,
 * and the persisted call-graph-impact diagnostics.
 *
 * This composes the SINGLE existing structural classifier (`detectFileRole`) —
 * no second matcher, no private test-filename list, no duplicated patterns. The
 * project ignore matcher (`getProjectIgnoreMatcher`) is applied separately and
 * unchanged at each surface; this predicate only adds the test-ROLE half of the
 * display policy the review graph already enforces.
 *
 * Honesty (#1080 acceptance criteria):
 *  - A KNOWN `"test"` role is filtered from the collateral surface.
 *  - If role classification cannot be obtained (an unexpected throw), the
 *    candidate is RETAINED (`false`) rather than dropped — filtering must never
 *    invent a heuristic or silently drop a potentially actionable file, and must
 *    never convert an incomplete/indeterminate computation into a clean result.
 */
import { detectFileRole } from "./file-role.js";

/**
 * True when `filePath` is a KNOWN test-role file that must not surface as a
 * collateral cascade/impact neighbor. Path-based only (no content needed for
 * the test-role branch of `detectFileRole`). Fail-open: any classifier error
 * returns `false` (retain the candidate).
 */
export function isTestRoleCollateral(filePath: string): boolean {
	try {
		return detectFileRole(filePath) === "test";
	} catch {
		return false;
	}
}
