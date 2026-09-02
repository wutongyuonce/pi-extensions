/**
 * Subagent light mode (#449 slice 0; broadened #507).
 *
 * Two known subagent-spawning ecosystems set different env vocabularies in
 * every spawned child's environment:
 *
 * - nicobailon/pi-subagents sets `PI_SUBAGENT_CHILD=1` unconditionally (plus
 *   `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_CHILD_AGENT` for best-effort identity).
 * - avtc-pi-subagent (the spawn engine under avtc-pi-feature-flow) is the same
 *   execution model — real child-process `pi --mode rpc` / `--mode json -p`
 *   spawns, full env inheritance — but never sets `PI_SUBAGENT_CHILD`. It sets
 *   `PI_SUBAGENT_CHILD_AGENT` + `PI_SUBAGENT_PARENT_PID` instead (#507,
 *   grep-verified against avtc-pi-subagent@1.0.3).
 *
 * Every child currently loads pi-lens fully by default, so a fan-out of N
 * subagents pays N full LSP pre-warms + N sets of heavyweight startup scans
 * in the same cwd — mostly wasted on short-lived task agents.
 *
 * Detection requires the avtc PAIR (`PI_SUBAGENT_CHILD_AGENT` AND
 * `PI_SUBAGENT_PARENT_PID`, both non-empty) rather than either var alone —
 * deliberate false-positive protection, since a lone var set by some
 * unrelated tool must not trigger light mode.
 *
 * This module only classifies the session; it does not change any behavior
 * itself. Callers (`runtime-session.ts`) gate the LSP pre-warm and the seven
 * heavyweight external-CLI startup scans on `isSubagentSession()`. Per-edit
 * LSP dispatch is untouched — light mode must not disable diagnostics.
 *
 * Escape hatch: `PI_LENS_SUBAGENT_FULL=1` forces full (non-light) behavior
 * even inside a detected subagent session, for either vocabulary.
 *
 * Follows the lazy-memoized-config house style (see `runtime-config.ts` /
 * `slow-fs.ts`): env values are read lazily at call time, not module load.
 */

/** Which vocabulary matched when classifying the session as a subagent. */
export type SubagentMarker = "pi-subagents" | "avtc-pi-subagent";

interface SubagentClassification {
	isSubagent: boolean;
	marker?: SubagentMarker;
}

/** Lazily computed once per process (until `_resetSubagentModeForTests`),
 * matching the memoized-getter house style. */
let cachedClassification: SubagentClassification | undefined;

function classifySubagentSession(): SubagentClassification {
	if (cachedClassification !== undefined) return cachedClassification;

	if (process.env.PI_SUBAGENT_CHILD === "1") {
		cachedClassification = { isSubagent: true, marker: "pi-subagents" };
		return cachedClassification;
	}

	const childAgent = process.env.PI_SUBAGENT_CHILD_AGENT || undefined;
	const parentPid = process.env.PI_SUBAGENT_PARENT_PID || undefined;
	if (childAgent !== undefined && parentPid !== undefined) {
		cachedClassification = { isSubagent: true, marker: "avtc-pi-subagent" };
		return cachedClassification;
	}

	cachedClassification = { isSubagent: false };
	return cachedClassification;
}

/** True iff pi-lens is running inside a detected subagent child `pi` process
 * (nicobailon/pi-subagents' `PI_SUBAGENT_CHILD=1`, or avtc-pi-subagent's
 * `PI_SUBAGENT_CHILD_AGENT` + `PI_SUBAGENT_PARENT_PID` pair), and the caller
 * has not forced full behavior via the escape hatch. */
export function isSubagentSession(): boolean {
	if (process.env.PI_LENS_SUBAGENT_FULL === "1") return false;
	return classifySubagentSession().isSubagent;
}

export interface SubagentIdentity {
	runId?: string;
	agentName?: string;
	marker?: SubagentMarker;
	parentPid?: number;
}

/**
 * Best-effort identity of the current subagent, read from the env vars the
 * detected extension sets alongside its subagent marker. Returns `undefined`
 * when neither identity var is present (e.g. not a subagent session, or a
 * future extension that doesn't set them).
 */
export function getSubagentIdentity(): SubagentIdentity | undefined {
	const runId = process.env.PI_SUBAGENT_RUN_ID || undefined;
	const agentName = process.env.PI_SUBAGENT_CHILD_AGENT || undefined;
	const parentPidRaw = process.env.PI_SUBAGENT_PARENT_PID || undefined;
	const parsedParentPid =
		parentPidRaw === undefined ? undefined : Number(parentPidRaw);
	const parentPid =
		parsedParentPid !== undefined &&
		Number.isSafeInteger(parsedParentPid) &&
		parsedParentPid > 0
			? parsedParentPid
			: undefined;
	const classification = classifySubagentSession();
	if (
		runId === undefined &&
		agentName === undefined &&
		parentPid === undefined &&
		!classification.isSubagent
	) {
		return undefined;
	}
	return { runId, agentName, marker: classification.marker, parentPid };
}

/** Human-readable degradation notice surfaced once per session when subagent
 * light mode engages, so a subagent never sees a silently-empty scan result. */
export function subagentLightModeNotice(): string {
	return "subagent session — skipped background code-quality scans (set PI_LENS_SUBAGENT_FULL=1 to override)";
}

/** Test-only: clears the memoized classification so tests can flip env vars
 * between cases (matching the `_resetForTests` convention used by
 * `runtime-config.ts` / `slow-fs.ts`). */
export function _resetSubagentModeForTests(): void {
	cachedClassification = undefined;
}
