/**
 * The one reading of `SpawnResult.outputTruncated` (#2100), the one output-cap
 * number (#3375), and the bounded accumulator the `data` handlers that never
 * reach `safeSpawnAsync` use instead of `+=` (#3383).
 *
 * Its own module for the same reason `ledger-bounds.ts` is: `spawn-outcome.ts`
 * is on the shared runner path that dozens of test files reach with a bare
 * `vi.mock("safe-spawn.js")`, and importing a VALUE from safe-spawn there makes
 * every one of those mocks have to re-export it. This module has no imports, so
 * nobody has to mock it.
 */

/**
 * The cap `safeSpawnAsync` applies when a caller passes no `maxOutputBytes`
 * (#3375).
 *
 * Before this existed, an omitted cap meant NO cap: `appendOutput` fell
 * through to `current + text` and grew one JS string until V8 refused the next
 * concatenation with `RangeError: Invalid string length`. That throw is raised
 * inside a stdout/stderr `data` handler, where the awaiting caller's
 * `try`/`catch` cannot reach it, so it left the Pi host as an uncaught
 * exception (field report: Pi 0.86.1, 2026-09-22).
 *
 * 32 MiB is chosen against the tree's own deliberate ceilings, not invented:
 * the most generous explicit cap any caller asks for is 16 MiB
 * (`MAX_GIT_STATUS_OUTPUT_BYTES` in `clients/shared-checkout-guard.ts` and
 * `clients/opaque-mutation-scan.ts`, `MAX_LS_FILES_OUTPUT_BYTES` in
 * `clients/git-tracked-ignore.ts` — a monorepo's whole tracked-file list), and
 * the rest sit at 8 MiB or 64 KiB. Doubling that ceiling means no consumer
 * whose legitimate volume is within the most generous allowance a maintainer
 * has ever justified can be truncated by the DEFAULT, while the retained
 * string stays 16x below V8's max string length (2^29-24 bytes of ASCII), so
 * the concatenation that crashed the host is now unreachable rather than
 * merely less likely. A caller that genuinely needs more passes its own
 * `maxOutputBytes`; it always wins.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** A byte-bounded text accumulator. See {@link createBoundedOutputSink}. */
export interface BoundedOutputSink {
	/**
	 * Append one chunk. TOTAL: the only statements are a byte count, a compare
	 * and a concatenation that provably stays under the bound, so this never
	 * throws — which is the whole point, because every caller runs it inside a
	 * stream `data` handler where a throw reaches the process, not the awaiting
	 * caller.
	 */
	append(chunk: string | Buffer): void;
	/** What was retained: at most `maxBytes` bytes of it. */
	readonly text: string;
	/** True once a chunk was dropped. */
	readonly truncated: boolean;
	/** Bytes the producer emitted, dropped ones included. */
	readonly observedBytes: number;
}

/**
 * The bound for a stream `data` handler that accumulates a string OUTSIDE
 * `safeSpawnAsync` (#3383).
 *
 * #3375 capped the shared spawn seam, which covered 98 of 110 call sites; the
 * class sweep for it found five accumulators that never reach that seam — a
 * forked analyze worker (`clients/mcp/review.ts`), the unref'd one-shot
 * collector (`clients/child-unref.ts`, which cannot import the seam at all: it
 * is what `safe-spawn.ts` itself depends on) and two installer interpreter
 * probes. Each grew one JS string per chunk with no ceiling, so each could
 * reach the identical ending: V8 refusing the next concatenation with
 * `RangeError: Invalid string length` INSIDE a `data` handler, which is an
 * uncaught exception that terminated the Pi host on 2026-09-22.
 *
 * Retention is HEAD-ONLY and whole-chunk: the first chunk that would cross the
 * bound is dropped entire, not byte-prefixed. `safeSpawnAsync`'s own
 * `appendOutput` keeps a head, a marker and a tail because its callers parse
 * tool output where the tail carries the summary; every caller here wants a
 * prefix (a JSON document, a `ps` table, one path line) and a whole-chunk drop
 * cannot split a multi-byte character.
 *
 * `maxBytes` defaults to {@link DEFAULT_MAX_OUTPUT_BYTES} so every bounded
 * accumulator in the tree answers to ONE reviewed number. NO production caller
 * passes it; it is a parameter so the retention arithmetic can be pinned at a
 * readable size (`createBoundedOutputSink(10)`) instead of only at 32 MiB.
 * There is deliberately no sanitizing of it either: nothing passes a value that
 * would need it, so a `Number.isFinite` arm would be mutation-inert.
 */
export function createBoundedOutputSink(
	maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): BoundedOutputSink {
	let text = "";
	let retained = 0;
	let truncated = false;
	let observed = 0;
	return {
		append(chunk: string | Buffer): void {
			const part = typeof chunk === "string" ? chunk : chunk.toString();
			const bytes = Buffer.byteLength(part);
			observed += bytes;
			if (retained + bytes <= maxBytes) {
				retained += bytes;
				text += part;
				return;
			}
			truncated = true;
		},
		get text(): string {
			return text;
		},
		get truncated(): boolean {
			return truncated;
		},
		get observedBytes(): number {
			return observed;
		},
	};
}

/**
 * True when `outputTruncated` is the OUTPUT CAP's own verdict about this run,
 * and not a detail of some other ending.
 *
 * A timeout or an abort can carry `outputTruncated` too. Those endings own
 * their own classification, so they are excluded here rather than reported as
 * truncation.
 *
 * Typed structurally so `SpawnResult` and runner-level result shapes that
 * re-spell `failure` can both use it.
 */
export function truncatedByOutputCap(result: {
	outputTruncated?: boolean;
	failure?: string;
}): boolean {
	return (
		result.outputTruncated === true &&
		result.failure !== "timeout" &&
		result.failure !== "aborted"
	);
}

/**
 * True when `stopForOutputLimit` started terminating the child.
 *
 * Windows reports that termination as status 1 without a signal or failure,
 * while POSIX commonly reports SIGTERM. This field avoids reconstructing our
 * action from either platform's exit shape.
 */
export function killedForOutputCap(result: {
	killedForOutputCap?: boolean;
	failure?: string;
}): boolean {
	return (
		result.killedForOutputCap === true &&
		result.failure !== "timeout" &&
		result.failure !== "aborted"
	);
}
