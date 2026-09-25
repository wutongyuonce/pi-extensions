/**
 * Shared toolchain-availability lifecycle (#1476 Sonar follow-up).
 *
 * `candidate-probe.ts` factored out the PATH sweep the Go and Rust clients ran,
 * but the LIFECYCLE around it stayed written twice: the transient-aware latch,
 * the in-flight dedupe that keeps concurrent first-time callers to one sweep,
 * the path memo, and the two `availability_decision` records. Two copies of one
 * rule is how #1467's fix missed seven sites, so the rule lives here once and
 * each client contributes only its configuration.
 *
 * Callers keep their own public method names — `isGoAvailableAsync`,
 * `findCargoPathAsync` — because other modules call them; only the body moves.
 */

import {
	type AvailabilityCause,
	type ProbeEvidence,
	createAvailabilityLatch,
	logAvailabilityDecision,
} from "./availability-policy.js";
import { probeAvailabilityCandidates } from "./candidate-probe.js";
import { createAvailabilityProbeFlight } from "../../../availability-probe-flight.js";
import { createSingleFlight } from "../../../single-flight.js";

export interface ToolchainAvailabilityConfig {
	/** Tool name as it appears in the `availability_decision` record. */
	tool: string;
	/** Human label for the "found" log line, e.g. `Go`, `Cargo`. */
	label: string;
	/** Candidates probed on Windows, in order. */
	windowsPaths: readonly string[];
	/** Candidates probed everywhere else, in order. */
	unixPaths: readonly string[];
	/** Version-probe arguments for the bare PATH candidate. */
	probeArgs: readonly string[];
	/** Host-side budget for one probe, ms. */
	budgetMs: number;
	/** Verbose-mode logger; a no-op when the client is quiet. */
	log: (msg: string) => void;
}

export interface ToolchainAvailability {
	/** Resolved executable path, memoized once a candidate answers. */
	findPath: () => Promise<string | null>;
	/** Availability verdict, behind the transient-aware latch. */
	isAvailable: () => Promise<boolean>;
}

const toolchainProbeFlights =
	createAvailabilityProbeFlight<
		Awaited<ReturnType<typeof probeAvailabilityCandidates>>
	>();

/**
 * Own one toolchain's availability: sweep the platform candidate list, memoize
 * the path that answered, and park the verdict behind the shared latch so a
 * timed-out probe expires instead of latching "the toolchain is not installed"
 * for the life of the process.
 */
export function createToolchainAvailability(
	config: ToolchainAvailabilityConfig,
): ToolchainAvailability {
	const availabilityLatch = createAvailabilityLatch();
	let toolPath: string | null = null;
	/** Classification of the candidate sweep, for the retry decision. */
	let sweepSawTransient = false;
	let sweepTransientCause: AvailabilityCause = "probe-timeout";
	let sweepHostStallMs = 0;
	/** What the last classified candidate returned, for the decision record. */
	let sweepEvidence: ProbeEvidence | undefined;
	const ensureFlight = createSingleFlight<boolean>();

	async function findPath(): Promise<string | null> {
		if (toolPath) return toolPath;

		const paths =
			process.platform === "win32" ? config.windowsPaths : config.unixPaths;
		const shared = toolchainProbeFlights.run(
			`toolchain:${config.tool}|${config.probeArgs.join("|")}|${config.windowsPaths.join("|")}|${config.unixPaths.join("|")}`,
			() =>
				probeAvailabilityCandidates(paths, config.probeArgs, config.budgetMs),
		);
		const sweep = await shared.promise;
		sweepSawTransient = sweep.sawTransient;
		sweepTransientCause = sweep.transientCause;
		sweepHostStallMs = sweep.hostStallMs;
		sweepEvidence = sweep.evidence;
		if (sweep.foundPath) toolPath = sweep.foundPath;
		return sweep.foundPath;
	}

	async function resolveAvailability(): Promise<boolean> {
		const startedAt = Date.now();
		const found = (await findPath()) !== null;
		if (found) {
			availabilityLatch.noteAvailable();
			config.log(`${config.label} found: ${toolPath}`);
			logAvailabilityDecision({
				tool: config.tool,
				verdict: "available",
				outcome: "success",
				cause: "ok",
				elapsedMs: Date.now() - startedAt,
				latched: true,
				hostStallMs: sweepHostStallMs,
				budgetMs: config.budgetMs,
				classifiedBy: "probe",
				...(sweepEvidence !== undefined && { evidence: sweepEvidence }),
			});
			return true;
		}
		// A timed-out version probe is evidence about this moment, not about
		// whether the toolchain is installed; it expires instead of latching.
		const outcome = sweepSawTransient ? "transient" : "missing";
		const cause = sweepSawTransient ? sweepTransientCause : "not-found";
		const retryAfterMs = availabilityLatch.noteUnavailable(outcome, cause);
		logAvailabilityDecision({
			tool: config.tool,
			verdict: "unavailable",
			outcome,
			cause,
			elapsedMs: Date.now() - startedAt,
			latched: outcome !== "transient",
			hostStallMs: sweepHostStallMs,
			...(retryAfterMs > 0 && { retryAfterMs }),
			budgetMs: config.budgetMs,
			// Derived from the sweep's own candidate probes, and carrying what the
			// last of them returned (#1500).
			classifiedBy: "probe",
			...(sweepEvidence !== undefined && { evidence: sweepEvidence }),
		});
		return false;
	}

	async function isAvailable(): Promise<boolean> {
		// `read()` returns null when the last verdict was transient and its
		// cooldown expired, which re-enters the candidate sweep (#1476).
		const memo = availabilityLatch.read();
		if (memo !== null) return memo;
		return ensureFlight.run("availability", resolveAvailability);
	}

	return { findPath, isAvailable };
}
