import * as path from "node:path";
import {
	parseSymbolKey,
	type ImpactResult,
	type SymbolKey,
} from "../../call-graph.js";
import { isTestRoleCollateral } from "../../collateral-test-role.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * One `impact()` call's worth of results (`clients/call-graph.ts`), scoped to
 * a single edited symbol (`calleeKey`) — mirrors how `runtime-turn.ts` invokes
 * it: once per changed-symbol callee key found in a file the agent just
 * edited.
 */
export interface CallGraphImpactFinding {
	/** The edited symbol whose callers are (potentially) impacted. */
	calleeKey: SymbolKey;
	results: ImpactResult[];
}

function resolveImpactFile(cwd: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

/**
 * #883 single-source-of-truth: reuses `parseSymbolKey` (`call-graph.ts`)
 * rather than re-implementing symbol-key parsing here. Note this is stricter
 * than `formatImpact`'s inline `.split(":").pop()`: `parseSymbolKey` splits at
 * the LAST colon (drive-letter-safe on Windows) and understands the `file:`
 * module-level fallback shape, neither of which the `formatImpact` shortcut
 * handles — so this is the canonical parser, not merely a shared copy of it.
 */
function displayName(key: SymbolKey): string {
	return parseSymbolKey(key).symbolName ?? key;
}

/**
 * Severity mapping (#533 honesty): `impact()`'s BFS depth is a *heuristic*
 * name-resolution signal, not a verified break — it has no type information,
 * so an edited symbol's direct caller ("WillBreak") is NOT guaranteed to
 * actually break; the edit could be behavior-preserving (a doc fix, an
 * internal-only change). Escalating that to `semantic:"blocking"` (this
 * codebase's hard-stop tier — see `widget-state.ts`'s `isBlocking`) would be
 * exactly the over-confident false-block #533 exists to prevent, so NEITHER
 * tier reaches "blocking" here — both are advisory, differentiated only by
 * how strongly the agent should double-check:
 *   - WillBreak (depth 1, direct caller)  → severity "warning" — a real,
 *     resolved cross-file call site into code that just changed; worth an
 *     active nudge to verify the call site still matches.
 *   - MayBreak  (depth 2, one hop removed) → severity "info" — indirect,
 *     softer signal, purely a "you might want to check this" note.
 * `Review` (depth 3+, `impact()`'s own catch-all transitive tier) is
 * deliberately NOT emitted as individual diagnostics: `formatImpact` itself
 * only ever surfaces it as a bare count ("3 Review callers"), never
 * itemized, because at that BFS depth the fan-out is large and the signal is
 * too diluted to attribute to specific callers without drowning the more
 * actionable WillBreak/MayBreak findings.
 */
function severityFor(
	severity: ImpactResult["severity"],
): { severity: ProjectDiagnostic["severity"]; message: string } | null {
	if (severity === "WillBreak") {
		return {
			severity: "warning",
			message:
				"Direct caller of a symbol edited this turn — verify this call site still matches its new signature/behavior.",
		};
	}
	if (severity === "MayBreak") {
		return {
			severity: "info",
			message:
				"Indirect caller (one hop) of a symbol edited this turn — worth a quick check.",
		};
	}
	return null;
}

/**
 * Maps call-graph impact findings — WillBreak/MayBreak callers of symbols
 * edited this turn (`impact()`, `clients/call-graph.ts`) — into structured
 * `ProjectDiagnostic`s, attributed to the CALLER's file (the thing that might
 * need updating), one per affected caller symbol.
 *
 * No line number is set: `impact()`'s `ImpactResult` carries only a
 * `symbolKey` (file + symbol name), never a line — the underlying call-graph
 * symbol table itself only ever has a placeholder `line: 1` for graph-derived
 * symbols (`review-graph/builder.ts`'s `extractSymbolsAndRefsFromGraph`), so
 * inventing a line here would be a fake `L1`, not a real one. `line` is
 * left `undefined` (honest omission) rather than reporting a location that
 * doesn't correspond to anything real (#533).
 */
/** Higher rank = surfaced preferentially when the same caller is deduped. */
const SEVERITY_RANK: Record<ProjectDiagnostic["severity"], number> = {
	error: 3,
	warning: 2,
	info: 1,
	hint: 0,
};

export function callGraphImpactToProjectDiagnostics(
	cwd: string,
	findings: CallGraphImpactFinding[],
): ProjectDiagnostic[] {
	// Dedupe: the same caller can be reached via more than one edited symbol
	// in a turn (multiple callees in the same edited file). Keyed by
	// resolved-file + caller symbolKey, keeping the highest-severity hit.
	const byKey = new Map<string, ProjectDiagnostic>();

	for (const { calleeKey, results } of findings) {
		const calleeName = displayName(calleeKey);
		for (const result of results) {
			const mapped = severityFor(result.severity);
			if (!mapped) continue; // Review tier — see severityFor's doc comment.

			const { filePath } = parseSymbolKey(result.symbolKey);
			if (!filePath) continue; // Nothing real to attribute this to.
			const resolvedFile = resolveImpactFile(cwd, filePath);

			// #1080: the call graph is derived from the tests-free review graph and is
			// normally tests-free, but this adapter accepts arbitrary caller
			// symbol keys — an old/fixture/expanded graph could supply a test-file
			// caller. A KNOWN test-role caller must not be persisted as collateral
			// call-graph impact. Fail-open: a classifier error retains the finding.
			if (isTestRoleCollateral(resolvedFile)) continue;

			const dedupeKey = `${resolvedFile}:${result.symbolKey}`;
			const existing = byKey.get(dedupeKey);
			if (
				existing &&
				SEVERITY_RANK[existing.severity] >= SEVERITY_RANK[mapped.severity]
			) {
				continue;
			}

			const callerName = displayName(result.symbolKey);
			byKey.set(dedupeKey, {
				filePath: resolvedFile,
				severity: mapped.severity,
				semantic: "warning",
				tool: "call-graph",
				runner: "call-graph",
				rule: `call-graph:${result.severity.toLowerCase()}`,
				message: `${mapped.message} (${callerName} calls edited symbol '${calleeName}')`,
				source: "project-scan",
			});
		}
	}

	return [...byKey.values()];
}
