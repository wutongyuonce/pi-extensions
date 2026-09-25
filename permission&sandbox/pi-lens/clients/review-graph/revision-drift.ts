/**
 * Revision-drift evidence for a served review-graph snapshot, and the one
 * wording every consumer renders it with (#1961).
 *
 * A separate module on purpose. `project-report.ts` and `module-report.ts`
 * import the builder DYNAMICALLY, to keep that large module (and its
 * tree-sitter dependencies) off their eager load path. Both still need this
 * caveat's wording synchronously, and two hand-written copies of a warning
 * sentence drift apart. This file imports nothing, so depending on it costs
 * nothing.
 */

/**
 * Bounded drift evidence: two commit ids, nothing path-shaped.
 *
 * #1961 review F3: this pair is DERIVED PER CALL, never stored. `currentHead`
 * is true only at the instant it is read. A cached copy goes stale the moment
 * HEAD moves again — it would name a commit that is no longer HEAD — and it
 * keeps claiming drift after HEAD returns to the stamped commit, when there is
 * none. Only the snapshot's own `stampedHead` is durable; it lives on the
 * workspace cache entry, and `getReviewGraphRevisionDrift` (builder.ts) pairs
 * it with a freshly resolved HEAD on every call.
 */
export interface ReviewGraphRevisionDrift {
	/** `gitStamp.headCommit` recorded when the snapshot was persisted. */
	stampedHead: string;
	/** The worktree's HEAD at the moment the drift was computed. */
	currentHead: string;
}

/**
 * The one wording for the drift caveat, so `project_report`'s trust note and
 * `module_report`'s warning cannot say different things about the same fact.
 * Short commit ids only.
 */
export function formatReviewGraphRevisionDriftNote(
	drift: ReviewGraphRevisionDrift,
): string {
	return (
		`Graph was built at commit ${drift.stampedHead.slice(0, 8)}; HEAD is now ` +
		`${drift.currentHead.slice(0, 8)}. Results below reflect the earlier ` +
		"revision — run pilens_rebuild or re-analyze to refresh."
	);
}
