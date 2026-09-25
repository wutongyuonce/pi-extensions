import * as fs from "node:fs";
import type { CascadeNeighborResult, CascadeRun } from "./cascade-types.js";
import { retagAuxiliaryDiagnostics } from "./dispatch/auxiliary-lsp.js";
import {
	applyFindingPolicy,
	loadProjectRulePolicyMap,
	renderedRuleIdentities,
} from "./dispatch/finding-policy.js";
import { detectFileRole } from "./file-role.js";
import { logLatency } from "./latency-logger.js";
import { formatCacheAgeLabel } from "./finding-delivery-gate.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import type { Diagnostic } from "./dispatch/types.js";
import { convertLspDiagnostics } from "./dispatch/utils/lsp-diagnostics.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";

export function formatCascadeNeighborDiagnostics(
	cwd: string,
	neighbors: CascadeNeighborResult[],
	options: { noun?: string; includeReason?: boolean } = {},
): string {
	const withErrors = neighbors.filter((n) => n.diagnostics.length > 0);
	const inconclusive = neighbors.filter(
		(n) => n.inconclusive === true && n.diagnostics.length === 0,
	);
	// #1459: a neighbour whose scanner never looked at it is not a clean leaf. It
	// is also not `inconclusive` — the language server answered — so it gets its
	// own honest line instead of being folded into either bucket. Only the
	// zero-diagnostic case needs saying: a neighbour with findings already renders.
	const uncovered = neighbors.filter(
		(n) =>
			n.diagnostics.length === 0 &&
			n.inconclusive !== true &&
			(n.unconfirmedServerIds?.length ?? 0) > 0,
	);
	if (
		withErrors.length === 0 &&
		inconclusive.length === 0 &&
		uncovered.length === 0
	) {
		return "";
	}

	const noun = options.noun ?? "neighbor";
	let out =
		withErrors.length > 0
			? `📐 Cascade errors in ${withErrors.length} ${noun} file(s) — fix before finishing turn:`
			: "";
	for (const neighbor of withErrors) {
		const display = toRunnerDisplayPath(cwd, neighbor.filePath);
		const reason = options.includeReason ? ` reason="${neighbor.reason}"` : "";
		out += `\n<diagnostics file="${display}"${reason}>`;
		for (const d of neighbor.diagnostics) {
			const line = d.line ?? 1;
			const col = d.column ?? 1;
			const rule = d.rule ? ` rule=${d.rule}` : "";
			out += `\n  line ${line}, col ${col}${rule}: ${d.message.split("\n")[0].slice(0, 100)}`;
		}
		out += "\n</diagnostics>";
	}
	if (inconclusive.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade diagnostics inconclusive for ${inconclusive.length} ${noun} file(s) — no clean result was confirmed:`;
		for (const neighbor of inconclusive) {
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)}`;
		}
	}
	if (uncovered.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade scanners did not cover ${uncovered.length} ${noun} file(s) — no findings does NOT mean clean here:`;
		for (const neighbor of uncovered) {
			const servers = (neighbor.unconfirmedServerIds ?? []).join(", ");
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)} (not scanned by ${servers})`;
		}
	}
	return out;
}

/**
 * Build the turn-end `CascadeRun` for a neighbour whose diagnostics landed only
 * AFTER its cascade touch skipped the in-lane wait (#1023's `resolved-found`
 * quiet-window outcome; #1444 made native TS7 take that same path). Returns
 * `undefined` when there is nothing agent-facing to say — no ERROR-severity
 * diagnostics, or nothing the formatter renders.
 *
 * Lives here rather than inline in the quiet-window callback so the delivery
 * path (reconcile → run → turn_end) is testable end to end; index.ts only wires
 * it to `runtime.appendCascadeRun`.
 *
 * #3102: the survivors are what the agent READS, so they go through the same
 * `clients/dispatch/finding-policy.ts` stack — inline `pi-lens-ignore` → stored
 * dispositions → the project's `.pi-lens.json` rule policy — that the per-edit
 * dispatcher, `mode=full` and the `source=lsp` probe lane apply. Without it a
 * cold-neighbour ERROR the agent already marked `false-positive` came back on
 * every quiet-window reconcile.
 */
export function buildResolvedFoundCascadeRun(
	cwd: string,
	neighbor: {
		filePath: string;
		diagnostics: LSPDiagnostic[];
		/** #3168 F3: the #1444 publish stamp, threaded to the run so the carried
		 * age label renders the real observation age. */
		publishedAt?: number;
	},
): CascadeRun | undefined {
	const { filePath } = neighbor;
	const errors = neighbor.diagnostics.filter((d) => d.severity === 1);
	if (errors.length === 0) return undefined;
	const policyStart = Date.now();
	// This lane's roots are one and the same: index.ts hands `runtime.projectRoot`
	// in as `cwd`, so the retag's config lookup and the disposition/rule-policy
	// store read the same directory. The in-lane cascade's do NOT — see
	// `applyCascadeDisplayPolicy`.
	const { diagnostics, suppressed, auxSuppressed, total } =
		applyCascadeDisplayPolicy(errors, {
			cwd,
			policyRoot: cwd,
			filePath,
		});
	// One bounded record per RUN, never one per finding (AGENTS.md "bounded
	// observability"). This is a PUSH surface: silence after a mark is the mark
	// working, not a clean verdict, so the count is recorded here rather than
	// re-announced to the agent on every reconcile. `durationMs` covers the
	// content read too — the latency this fold added to the quiet-window
	// callback, measurable in the same per-phase record as every other cost.
	recordCascadeFindingPolicy({
		filePath,
		durationMs: Date.now() - policyStart,
		suppressed,
		total,
		auxSuppressed,
	});
	// No zero-length early return here: `formatCascadeNeighborDiagnostics`
	// renders "" for a neighbour with no diagnostics and the `!formatted` guard
	// below already returns `undefined` for it — a second check was mutation-
	// inert (M7: deleting it left all 7 cascade cases green).
	const neighbors: CascadeNeighborResult[] = [
		{ filePath, reason: "references", diagnostics, lspTouched: true },
	];
	const rendered = formatCascadeNeighborDiagnostics(cwd, neighbors, {
		noun: "cold neighbor",
	});
	if (!rendered) return undefined;
	// #1616 / #3102 AC 4, round 2 F2: a delivery that still has something to say
	// states what it dropped, once per delivery — the same sentence the
	// late-auxiliary advisory renders (`clients/runtime-turn.ts`). Policy drops
	// only: an aux drop is the file's own suppression comment, which the
	// per-edit dispatch path honours silently too, and it stays in the record
	// above. A delivery with NOTHING left says nothing at all — silence on a
	// push surface is not a claim that the neighbour is clean.
	const formatted =
		suppressed > 0
			? `${rendered}\nsuppressed by disposition: ${suppressed} finding(s) (marked false-positive or won't-fix).`
			: rendered;
	return {
		filePath,
		result: {
			filePath,
			impact: {
				filePath,
				changedSymbols: [],
				directImporters: [],
				directCallers: [],
				neighborFiles: [filePath],
				riskFlags: [],
			},
			neighbors,
			formatted,
		},
		neighborCount: 1,
		diagnosticCount: diagnostics.length,
		// #3168 F3: the #1444 publish stamp — the run's own observation time, so
		// the carried-render age label states the real age instead of claiming
		// no stamp exists.
		...(neighbor.publishedAt !== undefined
			? { observedAt: neighbor.publishedAt }
			: {}),
	};
}

/** What one cascade neighbour's display list looks like after the stack. */
export interface CascadeDisplayPolicyResult {
	/** Survivors — what the cascade block renders, after `displayCap`. */
	diagnostics: Diagnostic[];
	/** Dropped by the policy stack (inline ignore / disposition / rule policy). */
	suppressed: number;
	/** Dropped by the auxiliary profile's OWN native suppression, disjoint from
	 * `suppressed`. */
	auxSuppressed: number;
	/** Converted entries before either drop — the record's denominator. */
	total: number;
}

/**
 * The ONE convert → retag → `applyFindingPolicy` derivation every cascade
 * DISPLAY lane runs before its diagnostics reach the agent (#3102/#3157).
 *
 * Five lanes render `CascadeNeighborResult.diagnostics` through
 * `formatCascadeNeighborDiagnostics`: the quiet-window builder above, and the
 * four in-lane sites in `clients/dispatch/integration.ts` (passive cold
 * snapshot, fresh touch, touch-error fallback, degraded fallback). Each one
 * used to open-code `convertLspDiagnostics(...)` and render the result raw, so
 * a neighbour ERROR the agent had marked `false-positive` was hidden by
 * `mode=delta`/`mode=full`/the per-edit dispatcher/the probe lane and STILL
 * re-reported by the cascade block on every edit that cascaded to it (#3157).
 *
 * TWO ROOTS, deliberately separate (the #1030 rule):
 *  - `cwd` is the LANGUAGE root, and only `retagAuxiliaryDiagnostics` sees it
 *    — `profile.allowBlocking(cwd)` looks for a local opengrep/zizmor/typos
 *    config, exactly as the per-edit runner (`runners/lsp.ts`) passes
 *    `ctx.cwd`.
 *  - `policyRoot` is the PROJECT root, and the disposition store and the
 *    `.pi-lens.json` rule map are read from it — `lens_diagnostic_mark` writes
 *    under `runtime.projectRoot` (`index.ts`), so reading from a nested
 *    language root in a monorepo opens a different
 *    `diagnostic-dispositions.json` and silently no-ops every mark. This is
 *    what `dispatcher.ts` already does with `ctx.projectRoot ?? ctx.cwd`.
 *
 * The auxiliary drop set (native `# nosemgrep`-style comments, `skipTestFiles`)
 * is KEPT: every caller's diagnostics come straight off a client cache or a
 * `touchFile` result, so nothing upstream ran `applyAuxiliarySuppressions`
 * (only the `mode=full` workspace sweep does, `clients/lsp/index.ts`) and this
 * is the FIRST application, not a double-apply — which is why the probe lane
 * ignores it and these lanes do not.
 *
 * No `range.start.line` pre-partition here, unlike the late-auxiliary drain,
 * whose own comment gives the alignment reason (`clients/runtime-turn.ts`,
 * above its `anchored` filter): `convertLspDiagnostics` drops line-less
 * entries, which would break the 1:1 index pairing `retagAuxiliaryDiagnostics`
 * needs. That reason holds here too — it is simply already satisfied. Every
 * caller reads the same `client.getAllDiagnostics()` / `touchFile` map, whose
 * `mergeDiagnosticLists` (`clients/lsp/client.ts`) dereferences
 * `diagnostic.range.start.line` unguarded, so a line-less entry throws long
 * before any builder sees it and `converted` is always 1:1 with `errors`.
 *
 * Reads nothing when there is nothing to render, and never logs: the RECORD is
 * the caller's decision, because the in-lane lane walks up to
 * `CASCADE_NEIGHBOUR_BUDGET` neighbours per edit and must aggregate one row per
 * run rather than one per neighbour.
 */
export function applyCascadeDisplayPolicy(
	/** ERROR-severity raw diagnostics, already capped by the caller's own
	 * display cap (`MAX_PER_FILE` in-lane; uncapped for the single-neighbour
	 * quiet-window run). */
	errors: LSPDiagnostic[],
	options: {
		/** Language root — `retagAuxiliaryDiagnostics` only. */
		cwd: string;
		/** Project root — disposition store and `.pi-lens.json` rule policy. */
		policyRoot: string;
		filePath: string;
		/**
		 * The cited file's current bytes when the caller ALREADY has them (the
		 * in-lane active touch reads the neighbour to feed `touchFile`). Omitted,
		 * this reads the file once — only now that there is something to render.
		 */
		content?: string;
		/**
		 * How many SURVIVORS one neighbour may render. Applied last, after the
		 * policy, so a policy drop can never consume a display slot (#3157 round
		 * 2, F1: with the cap applied first, a neighbour whose first 20 ERRORs
		 * were all marked `false-positive` rendered NOTHING while genuine
		 * unmarked errors sat below the cap — a false clean, and worse than the
		 * unfiltered behaviour for that input). It also has to stay after
		 * `retagAuxiliaryDiagnostics`, which needs `converted` index-aligned 1:1
		 * with `errors`. Omitted → no display cap, which is the quiet-window
		 * lane's single-neighbour case.
		 */
		displayCap?: number;
	},
): CascadeDisplayPolicyResult {
	if (errors.length === 0) {
		return { diagnostics: [], suppressed: 0, auxSuppressed: 0, total: 0 };
	}
	const { cwd, policyRoot, filePath } = options;
	// `undefined` → the fail-open empty string: inline suppression becomes a
	// no-op and a STRICT `false-positive` anchor hashes an empty line, so a
	// finding is never hidden by an I/O error (AGENTS.md shape 48).
	const content = options.content ?? readNeighborContent(filePath);
	const converted = convertLspDiagnostics(errors, filePath);
	// #692/#3046: identity comes from the ONE shared derivation every other
	// surface anchors a mark against — never a hardcoded `tool: "lsp"`.
	const retained = retagAuxiliaryDiagnostics(converted, errors, content ?? "", {
		cwd,
		fileRole: detectFileRole(filePath, content),
	});
	const { kept } = applyFindingPolicy(retained, {
		cwd: policyRoot,
		filePath,
		content: content ?? "",
		policyMap: loadProjectRulePolicyMap(policyRoot),
		identities: renderedRuleIdentities,
	});
	return {
		diagnostics:
			options.displayCap === undefined
				? kept
				: kept.slice(0, options.displayCap),
		// Policy drops only, DISJOINT from `auxSuppressed` — the same split the
		// `late_auxiliary_findings` record uses, so one operator reading both
		// records does not have to know that one nests and the other does not.
		suppressed: retained.length - kept.length,
		auxSuppressed: converted.length - retained.length,
		total: converted.length,
	};
}

/**
 * The ONE `cascade_finding_policy` row both cascade display lanes write.
 *
 * Gated on EITHER counter (#3102 round 2, F1): gating on the policy count alone
 * made an aux-only drop — an ERROR master rendered, removed by the profile's own
 * `# nosemgrep` / `skipTestFiles` rule — vanish with no row at all, the
 * silent-drop shape this record exists to prevent (AGENTS.md shape 10). The
 * `late_auxiliary_findings` twin reports both counters every drain.
 */
export function recordCascadeFindingPolicy(entry: {
	/** The file the RUN is about: the cold neighbour for the quiet-window
	 * builder, the edited primary for an in-lane cascade that aggregates every
	 * neighbour it walked. */
	filePath: string;
	durationMs: number;
	suppressed: number;
	total: number;
	auxSuppressed: number;
	/**
	 * ERRORs the policy never LOOKED at, because the caller's pre-policy input
	 * bound cut them (#3157 round 2). Reported whenever it is non-zero even if
	 * nothing else was dropped: an input bound whose loss is invisible is the
	 * exact shape F1 found in the display cap, and this is the one counter that
	 * keeps `total` from reading as the neighbour's whole error set.
	 */
	inputTruncated?: number;
}): void {
	const inputTruncated = entry.inputTruncated ?? 0;
	if (
		entry.suppressed === 0 &&
		entry.auxSuppressed === 0 &&
		inputTruncated === 0
	)
		return;
	logLatency({
		type: "phase",
		toolName: "cascade",
		filePath: entry.filePath,
		phase: "cascade_finding_policy",
		durationMs: entry.durationMs,
		metadata: {
			suppressed: entry.suppressed,
			total: entry.total,
			auxSuppressed: entry.auxSuppressed,
			...(inputTruncated > 0 && { inputTruncated }),
		},
	});
}

/**
 * The neighbour's current bytes, for the two content-bound halves of the
 * policy stack (inline `pi-lens-ignore` and the STRICT `false-positive`
 * anchor). One synchronous read, paid only once a neighbour actually has ERROR
 * diagnostics to render — the same read `mode=full` pays per flagged file and
 * the probe lane pays per cache replay.
 *
 * SYNC here, while the in-lane cascade's own neighbour read at
 * `clients/dispatch/integration.ts` (the active touch, under its "A6: async
 * read to avoid blocking event loop on network-mounted drives" comment) is
 * ASYNC. The asymmetry is deliberate and measured, not an oversight: that read
 * happens for EVERY actively-touched neighbour in a parallel fan-out, while
 * this one is paid at most once per DELIVERING neighbour — 0.0125 ms per
 * neighbour measured on 40 real 15.6 KiB sources (#3157 AC 3), on loops that
 * already do synchronous fs work (`nodeFs.existsSync` in the degraded
 * fallback, and the `boundToCurrentDisk` verify whenever the producer attached
 * a content hash and its (path, mtime, size) memo misses —
 * `clients/lsp/diagnostic-binding.ts`). An async read here would force the
 * quiet-window builder's synchronous callback to become async for no
 * measurable gain.
 *
 * `undefined` on any failure: the caller degrades to the content-free half
 * rather than hiding a finding it could not identify.
 */
function readNeighborContent(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Fix B (#3167/#3168): the carry label for a cascade run re-rendered at a
 * later turn_end. The carry is bounded to ONE turn (`RuntimeCoordinator.beginTurn`
 * drops anything that would reach 2), so the honest label names the carry
 * count. #3168 F3 corrected this docstring's earlier claim that no stamp
 * exists: the run DOES carry one (`observedAt`, threaded from #1444's
 * `publishedAt` through the resolved-found plumb), so the age half renders
 * from it via `formatCacheAgeLabel`. The deferred-compute re-park arm has no
 * stamp and correctly falls to the neutral wording. Returns `undefined` for
 * non-carried runs: no label noise on fresh observations.
 */
export function cascadeCarrySuffix(
	carriedTurns?: number,
	observedAt?: number | undefined,
): string | undefined {
	if (carriedTurns === undefined || carriedTurns < 1) return undefined;
	const noun = carriedTurns === 1 ? "turn" : "turns";
	return `(carried ${carriedTurns} ${noun} · ${formatCacheAgeLabel(observedAt)})`;
}
