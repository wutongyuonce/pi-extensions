/**
 * Shared "nearest strictly-containing owner" computation (refs #655 phase 2).
 *
 * `module-report.ts`'s outline nesting (`nestEntries`, #301) and its callback
 * owner attribution (`findNearestSymbolName`) both already answer "which
 * declaration owns this line range" for a SINGLE file's flat symbol list, each
 * with a slightly different signature tuned to its own caller. Rather than add
 * a THIRD bespoke containment loop for the review graph's qualified-name
 * computation, this factors out the shared algorithm those two already use
 * (strict range containment, smallest-span-wins) so new consumers — the graph
 * builder's owner-chain computation, and function-facts.ts's jsts
 * receiver-type resolution — reuse the identical semantics instead of
 * drifting into a fourth slightly-different definition of "owner".
 *
 * `nestEntries` and `findNearestSymbolName` are left as-is rather than
 * refactored onto this helper: both are stable, already-tested code on a
 * read-substitute hot path, and a symmetry-only refactor of working code isn't
 * worth the regression risk for this scoped slice. New callers use this
 * helper directly; `read_symbol`'s own qualified-name resolution
 * (`resolveQualifiedMatch` in module-report.ts) works the other direction —
 * name lookup, not containment search — and is unaffected.
 *
 * Lives at the top level of `clients/` (not under `review-graph/`) because
 * `dispatch/facts/function-facts.ts` — a lower layer that `review-graph/`
 * already depends on — is also a caller; a `review-graph`-nested location
 * would invert that dependency direction.
 */
export interface OwnerCandidate {
	name: string;
	startLine: number;
	endLine: number;
}

/**
 * Returns the name of the smallest entry in `candidates` whose range strictly
 * contains [targetStart, targetEnd]. Undefined when nothing contains the
 * target (a top-level declaration).
 */
export function findOwnerName(
	candidates: OwnerCandidate[],
	targetStart: number,
	targetEnd: number,
): string | undefined {
	let best: OwnerCandidate | undefined;
	for (const candidate of candidates) {
		const span = candidate.endLine - candidate.startLine;
		const targetSpan = targetEnd - targetStart;
		const contains =
			candidate.startLine <= targetStart &&
			candidate.endLine >= targetEnd &&
			span > targetSpan;
		if (!contains) continue;
		if (!best || span < best.endLine - best.startLine) best = candidate;
	}
	return best?.name;
}

/** Build a dotted qualified name from an owner (if any) and the symbol's own name. */
export function buildQualifiedName(
	ownerName: string | undefined,
	symbolName: string,
): string | undefined {
	return ownerName ? `${ownerName}.${symbolName}` : undefined;
}
