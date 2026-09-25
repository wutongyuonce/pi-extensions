/**
 * Call-shaped scanner for latency-record emission sites (#1743).
 *
 * The #1692 lesson: a sweep that greps for a bare token flags comments, type
 * declarations, and unrelated string literals, then gets exemptions bolted on
 * until it means nothing. So this scanner does not grep for `phase:` — it
 * finds CALLS, balances their parentheses, and reads the phase out of the
 * call's own argument text. One seam per finding, and the evidence a finding
 * reports is the call itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { stripSource } from "./sweep-kit.js";

export interface EmissionSite {
	/** Repo-relative path, forward slashes, so findings read the same on any OS. */
	file: string;
	line: number;
	/** `"logLatency"` (raw) or `"emitBounded"`/`"admitBounded"` (helper). */
	callee: "logLatency" | "emitBounded" | "admitBounded";
	/** The phase name, when the call names it with a string literal. */
	phase: string | undefined;
}

const CALLEES = ["logLatency", "emitBounded", "admitBounded"] as const;

/** Directories scanned. Compiled output and tests are not sources of truth. */
export const SCAN_ROOTS = ["clients", "tools", "index.ts"];

/**
 * A phase name whose shape says the record is written on a FAILURE or
 * DEGRADATION path — the only paths this sweep governs.
 *
 * State the predicate honestly, because it decides what the sweep can and
 * cannot see:
 *
 * - It reads the phase NAME, not control flow. The repo names failure-path
 *   records after what went wrong (`..._timeout`, `..._failed`, `..._drop`),
 *   and that convention is what makes a cheap check possible at all.
 * - It therefore MISSES a failure-path record named after its subject rather
 *   than its outcome (`lsp_client_wait` on a give-up path would not match).
 *   That is a known blind spot, not a claim of completeness.
 * - It deliberately does NOT flag the ~140 throughput phases (`dispatch_
 *   complete`, `graph_build`, `memory_sample`). Those fire once per unit of
 *   real work, so their volume is bounded by the work itself; bounding them
 *   would be noise, and flagging them would bury the paths that matter.
 */
export function isFailureShapedPhase(phase: string): boolean {
	return OUTCOME_SUFFIX.test(phase) || OUTCOME_INFIX.test(phase);
}

/**
 * The outcome the record names, at the END of the phase name. This is the
 * repo's dominant convention: `lsp_pull_diagnostic_timeout`,
 * `project_snapshot_persist_failed`, `review_graph_size_skip`.
 */
const OUTCOME_SUFFIX =
	/(?:_timeout|_failure|_failed|_error|_drop|_dropped|_discarded|_unavailable|_unsupported|_abort|_abandoned|_stall|_exhausted|_late_answer|_unresolved|_degraded|_refused|_denied|_evicted|_corrupt|_orphan|_mismatch|_blocked|_broken|_leak|_leaked|_missing|_exit|_skip|_skipped)$/;

/**
 * The outcome NAMED MID-PHASE, with the reason trailing it:
 * `lsp_client_skipped_unavailable_command` says what happened (skipped) and
 * then why (the command was unavailable). A suffix-anchored rule alone cannot
 * see those, and #1743's review found two real unbounded records hiding there.
 *
 * Kept to `skip`/`skipped` deliberately. Those are the outcomes this repo
 * qualifies with a trailing reason; a general "outcome word anywhere" rule
 * would match a throughput phase whose SUBJECT happens to be a failure
 * concept. No such phase exists today — `lsp_timeout_budget_resolved` in the
 * sweep's self-test is a hypothetical name, written to pin the boundary
 * before a real one arrives.
 */
const OUTCOME_INFIX = /_skipped?_/;

/** Collect every emission site under `SCAN_ROOTS`, relative to `repoRoot`. */
export function scanEmissionSites(repoRoot: string): EmissionSite[] {
	const sites: EmissionSite[] = [];
	for (const root of SCAN_ROOTS) {
		for (const file of listTypeScriptFiles(path.join(repoRoot, root))) {
			const relative = path.relative(repoRoot, file).split(path.sep).join("/");
			sites.push(...scanSource(fs.readFileSync(file, "utf8"), relative));
		}
	}
	return sites;
}

/** Exported for the sweep's own self-test: scan one source string. */
export function scanSource(raw: string, file: string): EmissionSite[] {
	// #1755's shared kit owns the comment/string stripper, so this sweep gets
	// the comment-laundering defense instead of re-deriving it. `strings:
	// "keep"` is the deliberate half: a phase name IS a string literal, so
	// blanking string contents would blind the scanner to every phase it
	// exists to read. Blanking preserves offsets and newlines, so the line
	// numbers this reports still point at the real source.
	const source = stripSource(raw, { strings: "keep" });
	const sites: EmissionSite[] = [];
	for (const callee of CALLEES) {
		// `\b` alone would let `recordLogLatency(` match; require the callee to
		// start at a non-identifier boundary on BOTH sides.
		const opener = new RegExp(`(?<![A-Za-z0-9_$.])${callee}\\s*\\(`, "g");
		let match = opener.exec(source);
		while (match !== null) {
			const openIndex = source.indexOf("(", match.index);
			const argsText = readBalancedArgs(source, openIndex);
			sites.push({
				file,
				line: source.slice(0, match.index).split("\n").length,
				callee,
				phase: extractPhase(callee, argsText),
			});
			match = opener.exec(source);
		}
	}
	return sites.sort((a, b) => a.line - b.line);
}

/**
 * The phase a call names, or `undefined` when it is computed rather than
 * literal. `logLatency` names it in a `phase:` property; the helpers take it
 * as the first positional argument, which is typed to the registry union, so
 * a non-literal there is a compile error rather than a scanner blind spot.
 */
function extractPhase(callee: string, argsText: string): string | undefined {
	if (callee === "logLatency") {
		return /(?:^|[\s{,])phase\s*:\s*"([A-Za-z0-9_]+)"/.exec(argsText)?.[1];
	}
	return /^\s*"([A-Za-z0-9_]+)"/.exec(argsText)?.[1];
}

/** Argument text between `(` at `openIndex` and its matching `)`. */
function readBalancedArgs(source: string, openIndex: number): string {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(openIndex + 1, i);
		}
	}
	return source.slice(openIndex + 1);
}

function listTypeScriptFiles(target: string): string[] {
	const stat = fs.statSync(target);
	if (stat.isFile()) return target.endsWith(".ts") ? [target] : [];
	const found: string[] = [];
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "deps" || entry.name === "node_modules") continue;
			found.push(...listTypeScriptFiles(child));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			found.push(child);
		}
	}
	return found;
}

/**
 * Failure-shaped phases that stay on a raw `logLatency`, each with the reason
 * its volume is already bounded. This is the "or a stated reason" half of the
 * registered-or-fail rule: a NEW failure-path record must either route through
 * `emitBounded` or land here with an argument.
 *
 * The reasons name a MECHANISM, not an intention. Three shapes recur:
 * the site keeps its own first-seen set (already a rising edge); the record is
 * batched, one per pass over N subjects; or the emitting operation itself is
 * rare enough that its cadence is the bound.
 *
 * The sweep also checks these keys are still live sites, so a phase that gets
 * migrated or deleted turns this map red instead of leaving a stale claim.
 */
export const UNBOUNDED_FAILURE_PHASE_REASONS: Record<string, string> = {
	agent_end_concurrent_secondary_skip:
		"One record per `agent_end`, which fires at most once per turn.",
	astgrep_napi_unsupported_rules_skipped:
		"The site already holds a first-seen-per-language set (`unsupportedLanguageLog`) and returns early when it admits nothing, so this is a rising edge per language.",
	helm_render_scratch_leak:
		"One record per helm-render scratch-directory discard, so one per render run.",
	lsp_notify_backpressure_broken:
		"One record per client demotion, and the demoted client is torn down on the same path, so the same key cannot re-emit until a replacement spawns.",
	lsp_server_unexpected_exit:
		"One record per server process exit, which is a per-child lifecycle event.",
	lsp_sweep_group_skipped_warmup:
		"One record per sweep group whose primary server failed warm-up, and sweeps are already cadence-limited.",
	lsp_sync_abandoned:
		"One record per autofix resync the caller bailed on, so at most one per edit.",
	path_attribution_missing:
		"One record per `tool_result` with no recorded resolution basis, bounded by the turn's tool calls.",
	cascade_tier3_reconcile_error:
		"One record per tier-3 reconcile pass, and the cascade budget already caps those per turn.",
	cross_process_lsp_budget_degraded:
		"One record per cross-process budget evaluation, which runs on the LSP spawn path rather than per file.",
	finding_dead_path_drop:
		"One batched record per delivery-gate call listing every dropped finding, so volume follows scans, not findings.",
	lsp_client_unavailable:
		"The site already holds a first-seen set keyed by (server, root) (`unavailableLogged`) and returns early when it admits nothing.",
	lsp_client_wait_timeout:
		"One record per client wait, and a wait that times out has already spent its full budget, so the cadence is the bound.",
	lsp_client_wait_skipped:
		"The budget_skipped_known_slow verdict fires at most once per touch, so touch volume bounds this raw record.",
	lsp_diagnostics_timeout:
		"One batched record per touch's diagnostics wait; the per-server exact counts already go to the ledger via `incrementDegradationCount` immediately above it.",
	lsp_launch_candidate_failed:
		"Launch path only: one record per failed candidate per spawn attempt, and spawn attempts are already rate-limited by the LSP breaker.",
	lsp_launch_install_blocked:
		"Launch path only, same bound as `lsp_launch_candidate_failed`.",
	lsp_launch_managed_failed:
		"Launch path only, same bound as `lsp_launch_candidate_failed`.",
	lsp_notify_timeout:
		"One batched record per notify write, naming every server that timed out; the write has already spent its budget.",
	lsp_rename_resync_failed:
		"One batched record per rename, and renames are user-driven edits, not a server-driven loop.",
	lsp_registry_write_failed:
		"One record per instance-registry write failure, and those writes are per-child lifecycle events (spawn, shutdown).",
	module_report_extract_error:
		"One record per module-report extraction of one file, so volume follows the files the agent asks about.",
	dispatch_skipped_generated:
		"Deduplicated to one record per file per process by `generatedSkipRecorded`; repeated dispatches of the same generated file aggregate in the `dispatch-skipped-generated` degradation ledger, which is already bounded per kind and subject.",
	module_report_callback_extract_error:
		"Same bound as `module_report_extract_error`: once per extraction of one file.",
	module_report_import_resolve_error:
		"One record per unresolvable import in one file's report, bounded by that file's import count.",
	read_symbol_callback_extract_error:
		"One record per `read_symbol` call, which is one agent tool call.",
	read_enclosing_callback_extract_error:
		"One record per `read_enclosing` call, which is one agent tool call.",
	path_attribution_refused:
		"One record per `tool_result` whose attribution diverges from the resolved path, so it is bounded by the turn's tool calls.",
	project_snapshot_body_corrupt:
		"One record per snapshot load, and a load happens at session start or after an invalidation.",
	project_snapshot_persist_failed: "One record per snapshot persist attempt.",
	review_graph_cwd_worktree_mismatch:
		"The site already holds a first-seen-per-cwd set (`_cwdWorktreeCheckedCwds`) and returns early when it admits nothing.",
	review_graph_size_skip:
		"One record per graph build, which is already the coarsest unit of review-graph work.",
	session_start_skipped_steps:
		"One record per session_start, and only on the quick-mode path — the same once-per-lifecycle-event cadence as `agent_end_concurrent_secondary_skip` above, pinned by tests/clients/runtime-session-quick-mode-observability.test.ts.",
};
