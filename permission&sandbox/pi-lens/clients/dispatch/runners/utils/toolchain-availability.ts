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
import { createGenerationSource } from "../../../generation-guard.js";
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
	/**
	 * Forget the memoized path and the latched verdict. #2455 fix round 2: a
	 * "missing" verdict for a probe-class failure never expires
	 * (`isLatchingOutcome` — anything but `transient`), so without this a
	 * toolchain installed mid-process stayed invisible for the rest of the
	 * process's life, the same #1496/#1535 shape `resetZizmorTokenAvailability`
	 * exists for. Callers wire this per session, not per process.
	 *
	 * It also supersedes any probe already in flight (#2455 fix round 3, F2):
	 * a sweep that started before the reset answers the previous session, so it
	 * is neither joinable by a post-reset caller nor allowed to write its
	 * verdict into the cleared latch when it settles.
	 */
	reset: () => void;
}

/**
 * Session generation for toolchain-availability resets (#2455 fix round 3, F2).
 *
 * `reset()` clears the memo and the latch, but a probe that was ALREADY in
 * flight when it ran knows nothing about that. Without a generation, a
 * post-reset caller joins the pre-reset flight and, worse, that flight's own
 * settlement writes its stale verdict back into the freshly cleared latch — so
 * a tool installed between sessions still read "missing" for the whole new
 * session. That is #1674's defect read from both the sharing side and the
 * settle side, and the reason `SingleFlightOptions.generation` exists.
 *
 * This is the repo's extracted primitive (`clients/generation-guard.ts`, #1754)
 * rather than a hand-rolled counter (#2455 fix round 4, F1). Two things come
 * with it that the hand-rolled form did not have: the source is declared by
 * construction, so the #1754 ratchet can see it; and `guardedWrite` puts every
 * superseded write in the degradation ledger as a bounded
 * `generation-guard-stale-write` record per (source, subject), so a dogfood
 * session can tell "the guard is working" from "the guard never fires" instead
 * of watching superseded writes vanish silently (F4).
 *
 * A module-level source rather than a per-instance one, deliberately. It is a
 * counter, so nothing has to be hand-maintained and no flight is retained for
 * the sake of superseding it. And `toolchainProbeFlights` is itself shared
 * ACROSS instances (#2131: two clients probing the same candidate list run one
 * sweep), so its supersede signal cannot live on any one instance. The cost is
 * that resetting one toolchain also supersedes another's in-flight sweep; that
 * is at worst one extra probe, never a wrong verdict, and every registered
 * reset fires in the same `session_start` block anyway.
 */
const toolchainGenerations = createGenerationSource("toolchain-availability");

const toolchainProbeFlights = createAvailabilityProbeFlight<
	Awaited<ReturnType<typeof probeAvailabilityCandidates>>
>({ generation: toolchainGenerations.current });

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
	const ensureFlight = createSingleFlight<boolean>({
		generation: toolchainGenerations.current,
	});

	async function findPath(): Promise<string | null> {
		if (toolPath) return toolPath;

		const paths =
			process.platform === "win32" ? config.windowsPaths : config.unixPaths;
		const handle = toolchainGenerations.capture();
		const shared = toolchainProbeFlights.run(
			`toolchain:${config.tool}|${config.probeArgs.join("|")}|${config.windowsPaths.join("|")}|${config.unixPaths.join("|")}`,
			() =>
				probeAvailabilityCandidates(paths, config.probeArgs, config.budgetMs),
		);
		const sweep = await shared.promise;
		// A reset may have landed while this sweep was running. Its answer then
		// describes the session that just ended, so it must not write itself back
		// into the memo `reset()` just cleared, nor into the classification fields
		// the replacement flight reads to build ITS verdict. The memo is the
		// sharper half: a superseded sweep that writes `foundPath` latches a path
		// the reset may have been called BECAUSE it went away, so the seam that
		// exists to un-latch a false "missing" would instead latch a false
		// "found". Callers already holding this promise still get what the sweep
		// actually found.
		handle.guardedWrite(`findPath:${config.tool}`, () => {
			sweepSawTransient = sweep.sawTransient;
			sweepTransientCause = sweep.transientCause;
			sweepHostStallMs = sweep.hostStallMs;
			sweepEvidence = sweep.evidence;
			if (sweep.foundPath) toolPath = sweep.foundPath;
		});
		return sweep.foundPath;
	}

	async function resolveAvailability(): Promise<boolean> {
		const startedAt = Date.now();
		const handle = toolchainGenerations.capture();
		const resolvedPath = await findPath();
		const found = resolvedPath !== null;
		// #2455 fix round 3, F2: a reset during the probe opened a NEW session.
		// This flight answers the OLD one, so writing its verdict into the
		// freshly cleared latch would re-latch a stale "missing" for the whole
		// new session — the bug the reset exists to prevent, reintroduced by the
		// reset's own timing. Report the verdict to this flight's own callers;
		// do not latch it, and say so in the decision record's `latched`.
		const superseded = !handle.isCurrent();
		if (found) {
			handle.guardedWrite(`latch:${config.tool}`, () =>
				availabilityLatch.noteAvailable(),
			);
			// The RESOLVED path, not the memo (#2455 fix round 4, F6). A superseded
			// sweep is forbidden from writing `toolPath`, so reading the memo here
			// logged `Go found: null` on exactly the branch this line exists to
			// explain.
			config.log(`${config.label} found: ${resolvedPath}`);
			logAvailabilityDecision({
				tool: config.tool,
				verdict: "available",
				outcome: "success",
				cause: "ok",
				elapsedMs: Date.now() - startedAt,
				latched: !superseded,
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
		const retryAfterMs =
			handle.guardedWrite(`latch:${config.tool}`, () =>
				availabilityLatch.noteUnavailable(outcome, cause),
			) ?? 0;
		logAvailabilityDecision({
			tool: config.tool,
			verdict: "unavailable",
			outcome,
			cause,
			elapsedMs: Date.now() - startedAt,
			latched: !superseded && outcome !== "transient",
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

	function reset(): void {
		toolPath = null;
		availabilityLatch.reset();
		// Supersede every sweep and availability flight already running, in this
		// instance and in the shared registry. No `clear()`: the generation bump
		// is what makes a stale flight unjoinable and unable to re-latch, and
		// `SingleFlight.release`'s identity check already stops it from evicting
		// its successor. Clearing the SHARED registry here would additionally
		// drop another toolchain's live claim and cost it a duplicate sweep.
		toolchainGenerations.bump();
	}

	return { findPath, isAvailable, reset };
}
