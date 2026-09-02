import { logLatency } from "./latency-logger.js";
import { getProcessSingleton } from "./process-singletons.js";

// Verified guesses are expected host behavior, not degradations. Keep their
// exact session count in memory and publish one bounded row at session end.
// This tally is intentionally memory-only: a process crash loses its count.
// The rollup is best-effort session telemetry, not durable accounting.
//
// Process-singleton backed (AGENTS.md catalog shape 25), NOT a module-scope
// `let` like `bus-events-logger.ts`'s rollup: a `let` here exists once per
// module EVALUATION, not once per process, and #2146 measured one pid
// evaluating this graph nine times — a bare `let` would only ever count the
// guesses routed through its own copy, undercounting every rollup that is not
// reached through the first evaluation. This is the same decision its sibling
// `session-start-observability.ts`'s bind rollup made in #2249.
const VERIFIED_GUESS_FAMILY = "path-attribution-verified-guess-count";
const VERIFIED_GUESS_VERSION = 1;

function verifiedGuessCount(): { count: number } {
	return getProcessSingleton(
		VERIFIED_GUESS_FAMILY,
		VERIFIED_GUESS_VERSION,
		() => ({
			count: 0,
		}),
	);
}

export function recordVerifiedPathAttributionGuess(): void {
	verifiedGuessCount().count += 1;
}

export function getVerifiedPathAttributionGuessCount(): number {
	return verifiedGuessCount().count;
}

export function emitVerifiedPathAttributionRollup(filePath: string): void {
	const cell = verifiedGuessCount();
	if (cell.count === 0) return;
	logLatency({
		type: "phase",
		phase: "path_attribution_verified_rollup",
		filePath,
		durationMs: 0,
		metadata: { count: cell.count },
	});
	cell.count = 0;
}

export function resetVerifiedPathAttributionGuessCount(): void {
	verifiedGuessCount().count = 0;
}
