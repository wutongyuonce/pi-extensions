import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheManager, ModifiedRange } from "./cache-manager.js";
import type { Diagnostic } from "./dispatch/types.js";
import {
	hashText,
	normalizeMessage,
	stableFindingId,
} from "./finding-identity.js";
import type { LSPCodeAction, LSPDiagnostic } from "./lsp/client.js";
import { applyWorkspaceEdit } from "./lsp/edits.js";
import { getLSPService } from "./lsp/index.js";
import { normalizeMapKey } from "./path-utils.js";
import {
	recordLspMutationBatch,
	type LspMutationContext,
} from "./lsp-mutation.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";
import { getProjectDataDir } from "./file-utils.js";
import { commitDurableStore } from "./durable-store.js";

export interface ActionableWarningAction {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	hasEdit: boolean;
	hasCommand: boolean;
	autoFixEligible: boolean;
	skipReason?: string;
}

export interface ActionableWarningRecord {
	id: string;
	filePath: string;
	displayPath: string;
	line?: number;
	column?: number;
	severity: "warning" | "error" | "info" | "hint";
	tool: string;
	source?: string;
	code?: string;
	rule?: string;
	message: string;
	fixSuggestion?: string;
	fixKind?: string;
	autoFixAvailable?: boolean;
	actions: ActionableWarningAction[];
	suppressed: boolean;
	suppressionReason?: string;
	/** #1816 migration-only, internal to `actionable-warnings.ts`'s own
	 * suppression-store bookkeeping — not for display. The id this warning
	 * would have hashed to under the pre-#1816 formula (raw `relativeFile`,
	 * 10-char hash), computed ONCE by `suppressionFor` at record-construction
	 * time and carried here (AGENTS.md shape 5: an enumerable field survives
	 * `mergeWarnings`' spread copies; a WeakMap keyed on object identity would
	 * not, since merging allocates new record objects). `updateWarningState`
	 * reads this field directly and never re-derives a legacy id from
	 * `rule`/`tool`/`source`/`code` — those diverge from the id-construction
	 * args for LSP-origin records (`recordFromLspDiagnostic` passes no `rule`
	 * into `createActionableWarningId`, then sets `rule` afterward to
	 * `${source}:${code}` for display), so re-deriving would silently compute
	 * the wrong legacy id and bifurcate the store. Optional only because a
	 * handful of test/consumer sites construct a synthetic
	 * `ActionableWarningRecord` outside this module's own constructors and
	 * have no real pre-#1816 id to carry; `writeActionableWarningsReport`'s
	 * caller strips this field before persisting the report. */
	legacyId?: string;
	origin: "dispatch" | "lsp" | "merged";
}

export interface ActionableWarningsReport {
	generatedAt: string;
	scope: "turn_delta";
	sessionId: string;
	turnIndex: number;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	deltaOnly: boolean;
	includeLspCodeActions: boolean;
	files: Array<{
		filePath: string;
		displayPath: string;
		fileSeq?: number;
		warnings: ActionableWarningRecord[];
	}>;
	summary: {
		warnings: number;
		unsuppressed: number;
		suppressed: number;
		files: number;
		actions: number;
		autoFixEligible: number;
		/**
		 * Unsuppressed warnings split by tier (#1777). The dispatch path now
		 * preserves a rule's declared severity, so a hint-tier style opinion is
		 * countable instead of arriving indistinguishable from a real warning.
		 *
		 * OPTIONAL on purpose: this report is persisted to
		 * `.pi-lens/cache/actionable-warnings.json` and read back by
		 * `clients/runtime-agent-end.ts` and `tools/lens-diagnostics.ts`, which
		 * can find a file written by a pi-lens build that predates the field.
		 * Every reader must tolerate its absence.
		 *
		 * No `error` tier here (#1799): `recordFromDispatchDiagnostic` (above)
		 * routes `severity === "error"` to the blocking path and never admits it
		 * into `warnings`, so an error-tier count is always 0 and never rendered.
		 * A reader built against an old cache file that still carries `error` is
		 * unaffected — the field is simply absent from the parsed object now,
		 * and nothing here reads it.
		 */
		byTier?: { warning: number; info: number; hint: number };
	};
}

interface WarningSuppressionEntry {
	status?: "suppressed" | "active" | "resolved";
	reason?: string;
	firstSeenAt?: string;
	lastSeenAt?: string;
	resolvedAt?: string;
	seenCount?: number;
}

interface WarningStateFile {
	warnings?: Record<string, WarningSuppressionEntry>;
}

let beforeWarningStateLockForTests: (() => void) | null = null;

/** Test seam for a sibling process commit immediately before lock acquisition. */
export function _setBeforeWarningStateLockForTests(
	hook: (() => void) | null,
): void {
	beforeWarningStateLockForTests = hook;
}

/** #1816: was a local `relativeFile|tool|source|code|rule|normalizedMessage|
 * line` hash, hand-rolled independently of `diagnostic-dispositions.ts`'s
 * canonicalizing version — this is now the shared `finding-identity.js`
 * builder (which DOES canonicalize both `cwd` and `filePath` through
 * `normalizeMapKey` before relativizing, and hashes to 12 chars, matching
 * dispositions). See `legacyActionableWarningId` below for the pre-#1816
 * formula, kept only for on-disk suppression-store migration. */
export function createActionableWarningId(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	source?: string;
	code?: string | number;
	rule?: string;
	message: string;
	line?: number;
}): string {
	return stableFindingId("aw:", {
		cwd: args.cwd,
		filePath: args.filePath,
		parts: [
			args.tool,
			args.source,
			args.code,
			args.rule,
			normalizeMessage(args.message),
			args.line,
		],
	});
}

/** PRE-#1816 id formula (raw, non-canonicalized `relativeFile`; 10-char
 * hash). `actionable-warning-state.json` is a keyed, persisted store — a
 * warning suppressed under the old formula must not silently reappear as
 * unsuppressed just because this module unified onto the canonical,
 * 12-char id. `suppressionFor`/`updateWarningState` use this ONLY to look up
 * and migrate a still-pending old entry forward; nothing ever WRITES under
 * this id. Do not canonicalize this function — that would make it identical
 * to `createActionableWarningId` and silently defeat the migration lookup
 * for every path that actually needed canonicalizing (the #533 class this
 * whole item exists to fix). Review-round F3 (#1816): this guard is only
 * provable under a MIS-CASED path fixture — a fixture whose raw and
 * canonical forms coincide (a bare mkdtempSync path) makes canonicalizing
 * this function a no-op, so the regression test must seed under a mis-cased
 * segment (see `actionable-warnings.test.ts`'s migration describe block) or
 * the guard passes vacuously either way. */
function legacyActionableWarningId(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	source?: string;
	code?: string | number;
	rule?: string;
	message: string;
	line?: number;
}): string {
	const rel = path.relative(args.cwd, args.filePath).replace(/\\/g, "/");
	const legacyRelativeFile =
		rel && !rel.startsWith("..") ? rel : normalizeMapKey(args.filePath);
	const parts = [
		legacyRelativeFile,
		args.tool ?? "",
		args.source ?? "",
		String(args.code ?? ""),
		args.rule ?? "",
		normalizeMessage(args.message),
		String(args.line ?? ""),
	];
	return `aw:${hashText(parts.join("|"), 10)}`;
}

function actionSafety(action: LSPCodeAction): {
	eligible: boolean;
	reason?: string;
} {
	const kind = action.kind ?? "";
	if (!kind.startsWith("quickfix"))
		return { eligible: false, reason: "not_quickfix" };
	if (!action.isPreferred) return { eligible: false, reason: "not_preferred" };
	if (!action.edit) return { eligible: false, reason: "no_edit" };
	if (action.command) return { eligible: false, reason: "has_command" };
	return { eligible: true };
}

function serializeAction(action: LSPCodeAction): ActionableWarningAction {
	const safety = actionSafety(action);
	return {
		title: action.title,
		kind: action.kind,
		isPreferred: action.isPreferred,
		hasEdit: Boolean(action.edit),
		hasCommand: Boolean(action.command),
		autoFixEligible: safety.eligible,
		skipReason: safety.reason,
	};
}

function deserializeSuppressionState(
	contents: string | undefined,
): WarningStateFile {
	try {
		const parsed = JSON.parse(contents ?? "") as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as WarningStateFile)
			: {};
	} catch {
		return {};
	}
}

function readSuppressionState(cwd: string): WarningStateFile {
	const statePath = path.join(
		getProjectDataDir(cwd),
		"cache",
		"actionable-warning-state.json",
	);
	try {
		return deserializeSuppressionState(fs.readFileSync(statePath, "utf8"));
	} catch {
		return {};
	}
}

function updateWarningState(
	cwd: string,
	warnings: ActionableWarningRecord[],
): void {
	const statePath = path.join(
		getProjectDataDir(cwd),
		"cache",
		"actionable-warning-state.json",
	);
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	const hook = beforeWarningStateLockForTests;
	beforeWarningStateLockForTests = null;
	hook?.();
	commitDurableStore({
		path: statePath,
		deserialize: deserializeSuppressionState,
		merge: (state) => {
			const now = new Date().toISOString();
			state.warnings ??= {};
			for (const warning of warnings) {
				// #1816 migration: this warning may still be recorded under the
				// pre-#1816 id (raw relativeFile, 10-char hash) from before this
				// store unified onto the canonical id. Fold that entry forward
				// onto the current id and drop the stale key, so a warning
				// suppressed before the migration stays suppressed, and repeated
				// re-encounters converge the store onto one id per warning
				// instead of accumulating both forever.
				//
				// Review-round F1: this MUST read `warning.legacyId` — the value
				// `suppressionFor` already computed from the exact identity args
				// used at lookup time — and must NEVER re-derive a legacy id from
				// `warning.rule`/`tool`/`source`/`code`. Those fields hold
				// DISPLAY values that diverge from the id-construction args for
				// LSP-origin records (see `ActionableWarningRecord.legacyId`'s
				// doc comment), so a re-derivation here would compute a
				// different legacy id than the one `suppressionFor` checked,
				// permanently bifurcating the store.
				const legacyId = warning.legacyId;
				const legacyEntry =
					legacyId && legacyId !== warning.id
						? state.warnings[legacyId]
						: undefined;
				const existing = state.warnings[warning.id] ?? legacyEntry ?? {};
				state.warnings[warning.id] = {
					...existing,
					status: existing.status ?? "active",
					firstSeenAt: existing.firstSeenAt ?? now,
					lastSeenAt: now,
					seenCount: (existing.seenCount ?? 0) + 1,
				};
				if (legacyEntry && legacyId) delete state.warnings[legacyId];
			}
			return state;
		},
		serialize: (state) => JSON.stringify(state, null, 2),
		waitMs: 2_000,
		retryMs: 10,
		timeoutMessage: "timed out acquiring actionable warning store lock",
		onContention: "skip-log",
		logContention: () =>
			logActionableWarningsEvent({
				event: "warning_state_write_dropped",
				metadata: { reason: "lock_contention" },
			}),
	});
}

/** Looks up suppression under the current id, falling back to the pre-#1816
 * id (see `legacyActionableWarningId`) so a warning suppressed before this
 * migration doesn't silently reappear as unsuppressed. `args` is the exact
 * identity shape both id builders take.
 *
 * Also RETURNS the `legacyId` it computed (review-round F1, #1816): the
 * caller carries it onto the record's `legacyId` field so
 * `updateWarningState` can migrate the SAME legacy id this lookup used,
 * instead of re-deriving one from the record's own `rule`/`tool`/`source`/
 * `code` fields later. Re-deriving is unsound for LSP-origin records —
 * `recordFromLspDiagnostic` passes no `rule` into this function (LSP
 * diagnostics don't have one), then sets `record.rule` afterward to
 * `${source}:${code}` purely for display. Recomputing from that display
 * value would silently compute a DIFFERENT legacy id than the one actually
 * checked here, permanently bifurcating the store: a suppression written
 * this turn under the current id would never be found again next turn. */
function suppressionFor(
	cwd: string,
	id: string,
	args: {
		filePath: string;
		tool?: string;
		source?: string;
		code?: string | number;
		rule?: string;
		message: string;
		line?: number;
	},
): { suppressed: boolean; reason?: string; legacyId: string } {
	const state = readSuppressionState(cwd);
	const legacyId = legacyActionableWarningId({ cwd, ...args });
	const entry =
		state.warnings?.[id] ??
		(legacyId !== id ? state.warnings?.[legacyId] : undefined);
	return {
		suppressed: entry?.status === "suppressed",
		reason: entry?.reason,
		legacyId,
	};
}

export function recordFromDispatchDiagnostic(
	diagnostic: Diagnostic,
	cwd: string,
): ActionableWarningRecord | undefined {
	if (diagnostic.semantic !== "warning") return undefined;
	// #1777: the old gate demanded `severity === "warning"` exactly, which was
	// invisible while the ast-grep runner collapsed every non-error tier to
	// "warning". Now that hint and info survive the dispatch path, admit them:
	// a fix is a fix, and the tier governs how loudly a finding renders, not
	// whether its fix is worth offering. `error` still routes to the blocking
	// path, so it stays out even when a runner leaves `semantic` at "warning".
	if (diagnostic.severity === "error") return undefined;
	if (!diagnostic.fixable && !diagnostic.fixSuggestion) return undefined;
	const filePath = path.resolve(cwd, diagnostic.filePath);
	const identityArgs = {
		filePath,
		tool: diagnostic.tool,
		code: diagnostic.code,
		rule: diagnostic.rule,
		message: diagnostic.message,
		line: diagnostic.line,
	};
	const id = createActionableWarningId({ cwd, ...identityArgs });
	const suppression = suppressionFor(cwd, id, identityArgs);
	return {
		id,
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		line: diagnostic.line,
		column: diagnostic.column,
		severity: diagnostic.severity,
		tool: diagnostic.tool,
		code: diagnostic.code,
		rule: diagnostic.rule,
		message: diagnostic.message,
		fixSuggestion: diagnostic.fixSuggestion,
		fixKind: diagnostic.fixKind,
		autoFixAvailable: diagnostic.autoFixAvailable,
		actions: [],
		suppressed: suppression.suppressed,
		suppressionReason: suppression.reason,
		legacyId: suppression.legacyId,
		origin: "dispatch",
	};
}

function lineInModifiedRanges(
	line: number | undefined,
	ranges: ModifiedRange[],
): boolean {
	if (line === undefined) return true;
	if (ranges.length === 0) return true;
	return ranges.some(
		(range) => line >= range.start - 2 && line <= range.end + 2,
	);
}

function recordFromLspDiagnostic(
	diag: LSPDiagnostic,
	filePath: string,
	cwd: string,
): ActionableWarningRecord {
	const line = diag.range.start.line + 1;
	const column = diag.range.start.character + 1;
	const source = diag.source ?? "lsp";
	const code = diag.code === undefined ? undefined : String(diag.code);
	const identityArgs = {
		filePath,
		tool: "lsp",
		source,
		code,
		message: diag.message,
		line,
	};
	const id = createActionableWarningId({ cwd, ...identityArgs });
	const suppression = suppressionFor(cwd, id, identityArgs);
	return {
		id,
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		line,
		column,
		severity: "warning",
		tool: "lsp",
		source,
		code,
		rule: code ? `${source}:${code}` : source,
		message: diag.message,
		actions: [],
		suppressed: suppression.suppressed,
		suppressionReason: suppression.reason,
		legacyId: suppression.legacyId,
		origin: "lsp",
	};
}

function mergeWarnings(
	records: ActionableWarningRecord[],
): ActionableWarningRecord[] {
	const byId = new Map<string, ActionableWarningRecord>();
	for (const record of records) {
		const existing = byId.get(record.id);
		if (!existing) {
			byId.set(record.id, { ...record, actions: [...record.actions] });
			continue;
		}
		existing.origin =
			existing.origin === record.origin ? existing.origin : "merged";
		existing.fixSuggestion ??= record.fixSuggestion;
		existing.fixKind ??= record.fixKind;
		existing.autoFixAvailable ||= record.autoFixAvailable;
		const seenActions = new Set(
			existing.actions.map((a) => `${a.kind ?? ""}|${a.title}`),
		);
		for (const action of record.actions) {
			const key = `${action.kind ?? ""}|${action.title}`;
			if (!seenActions.has(key)) {
				existing.actions.push(action);
				seenActions.add(key);
			}
		}
	}
	return [...byId.values()].sort(
		(a, b) =>
			a.displayPath.localeCompare(b.displayPath) ||
			(a.line ?? 0) - (b.line ?? 0),
	);
}

export async function buildActionableWarningsReport(args: {
	cwd: string;
	sessionId: string;
	turnIndex: number;
	files: string[];
	modifiedRangesByFile: Map<string, ModifiedRange[]>;
	dispatchWarnings: ActionableWarningRecord[];
	includeLspCodeActions: boolean;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	fileSeqByPath?: Map<string, number>;
	deltaOnly?: boolean;
	dbg?: (msg: string) => void;
}): Promise<ActionableWarningsReport> {
	const cwd = path.resolve(args.cwd);
	const records: ActionableWarningRecord[] = [...args.dispatchWarnings];
	const lspService = getLSPService();

	logActionableWarningsEvent({
		event: "report_started",
		sessionId: args.sessionId,
		metadata: {
			turnIndex: args.turnIndex,
			filesCount: args.files.length,
			dispatchWarningsCount: args.dispatchWarnings.length,
			deltaOnly: args.deltaOnly !== false,
			includeLspCodeActions: args.includeLspCodeActions,
		},
	});

	if (args.includeLspCodeActions) {
		for (const file of args.files) {
			const filePath = path.resolve(cwd, file);
			if (!lspService.supportsLSP(filePath)) {
				logActionableWarningsEvent({
					event: "lsp_file_skipped",
					sessionId: args.sessionId,
					filePath,
					metadata: { reason: "no_lsp_support" },
				});
				continue;
			}
			// Reuse the cache primed by the dispatch pipeline's touchFile earlier in
			// this turn — but only when it is verified current. A second open+wait
			// here costs ~1 s/file with the LSP cold, so we pass the hash of the
			// current file bytes: getLastKnownDiagnostics returns the entry only if
			// it was primed for the SAME content, so a previous turn's diagnostics
			// are never served as current. On any miss (no entry, content drift, or
			// an entry written without content) we fall through to a fresh read.
			let diags: LSPDiagnostic[] | undefined;
			let lspSource: "cache" | "fresh" = "cache";
			const currentContent = fs.existsSync(filePath)
				? fs.readFileSync(filePath, "utf-8")
				: undefined;
			const contentHash =
				currentContent !== undefined
					? createHash("sha256").update(currentContent).digest("hex")
					: undefined;
			const cached =
				contentHash !== undefined
					? lspService.getLastKnownDiagnostics(filePath, contentHash)
					: undefined;
			if (cached !== undefined) {
				diags = cached;
			} else {
				try {
					if (currentContent)
						await lspService.openFile(filePath, currentContent);
					diags = await lspService.getDiagnostics(filePath);
					lspSource = "fresh";
				} catch (err) {
					args.dbg?.(
						`actionable_warnings: LSP diagnostics failed for ${filePath}: ${err}`,
					);
					logActionableWarningsEvent({
						event: "lsp_file_skipped",
						sessionId: args.sessionId,
						filePath,
						metadata: { reason: "lsp_error", error: String(err) },
					});
					continue;
				}
			}
			const ranges =
				args.modifiedRangesByFile.get(normalizeMapKey(filePath)) ?? [];
			const diagsWarning = diags.filter((d) => d.severity === 2);
			let deltaFiltered = 0;
			let enriched = 0;
			for (const diag of diagsWarning) {
				const line = diag.range.start.line + 1;
				if (args.deltaOnly !== false && !lineInModifiedRanges(line, ranges)) {
					deltaFiltered++;
					continue;
				}
				const record = recordFromLspDiagnostic(diag, filePath, cwd);
				try {
					const actions = await lspService.codeAction(
						filePath,
						diag.range.start.line,
						diag.range.start.character,
						diag.range.end.line,
						diag.range.end.character,
					);
					record.actions = actions.map(serializeAction).slice(0, 5);
				} catch (err) {
					args.dbg?.(
						`actionable_warnings: LSP codeAction failed for ${filePath}: ${err}`,
					);
				}
				if (record.actions.length > 0) {
					records.push(record);
					enriched++;
				}
			}
			logActionableWarningsEvent({
				event: "lsp_file_checked",
				sessionId: args.sessionId,
				filePath,
				metadata: {
					diagsTotal: diags.length,
					diagsWarning: diagsWarning.length,
					deltaFiltered,
					enriched,
					modifiedRangesCount: ranges.length,
					lspSource,
				},
			});
		}
	}

	const merged = mergeWarnings(records);
	updateWarningState(cwd, merged);
	// legacyId is #1816 migration bookkeeping for updateWarningState above —
	// strip it before the report leaves this function, so it never lands in
	// the `.pi-lens/cache/actionable-warnings.json` cache file or any
	// agent-facing rendering of a warning record.
	const reportWarnings = merged.map(({ legacyId: _legacyId, ...rest }) => rest);
	const byFile = new Map<string, ActionableWarningRecord[]>();
	for (const warning of reportWarnings) {
		const arr = byFile.get(warning.filePath) ?? [];
		arr.push(warning);
		byFile.set(warning.filePath, arr);
	}
	const files = [...byFile.entries()].map(([filePath, warnings]) => ({
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		fileSeq: args.fileSeqByPath?.get(normalizeMapKey(filePath)),
		warnings,
	}));
	const allActions = merged.flatMap((warning) => warning.actions);
	const unsuppressed = merged.filter((warning) => !warning.suppressed);
	const countTier = (tier: ActionableWarningRecord["severity"]): number =>
		unsuppressed.filter((warning) => warning.severity === tier).length;
	const summary = {
		warnings: merged.length,
		unsuppressed: unsuppressed.length,
		byTier: {
			warning: countTier("warning"),
			info: countTier("info"),
			hint: countTier("hint"),
		},
		suppressed: merged.filter((warning) => warning.suppressed).length,
		files: files.length,
		actions: allActions.length,
		autoFixEligible: allActions.filter((action) => action.autoFixEligible)
			.length,
	};

	logActionableWarningsEvent({
		event: "report_complete",
		sessionId: args.sessionId,
		metadata: { turnIndex: args.turnIndex, summary },
	});

	return {
		generatedAt: new Date().toISOString(),
		scope: "turn_delta",
		sessionId: args.sessionId,
		turnIndex: args.turnIndex,
		projectSeqStart: args.projectSeqStart,
		projectSeqEnd: args.projectSeqEnd,
		deltaOnly: args.deltaOnly !== false,
		includeLspCodeActions: args.includeLspCodeActions,
		files,
		summary,
	};
}

export function writeActionableWarningsReport(
	cacheManager: CacheManager,
	cwd: string,
	report: ActionableWarningsReport,
): void {
	cacheManager.writeCache("actionable-warnings", report, cwd);
}

export interface ActionableWarningsHistoryEntry {
	timestamp: string;
	sessionId: string;
	turnIndex: number;
	projectSeq?: number;
	filePath: string;
	displayPath: string;
	fileSeq?: number;
	line?: number;
	column?: number;
	severity: ActionableWarningRecord["severity"];
	tool: string;
	source?: string;
	rule?: string;
	code?: string;
	message: string;
	fixKind?: string;
	autoFixAvailable?: boolean;
	actionCount: number;
	autoFixEligibleActionCount: number;
	suppressed: boolean;
	suppressionReason?: string;
	origin: ActionableWarningRecord["origin"];
	warningId: string;
}

export function getActionableWarningsHistoryPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "actionable-warnings.jsonl");
}

/**
 * Append every actionable warning from this turn to the project's rolling
 * NDJSON history. Mirrors `appendCodeQualityWarningsHistory` so the two
 * advisory families have the same shape of cross-turn persistence:
 *
 *   - One line per warning (not per turn).
 *   - Carries the stable `aw:<hash>` id so callers can correlate the same
 *     warning across turns / sessions.
 *   - Captures suppression state at write time so historical analyses can
 *     reconstruct what the agent actually saw.
 *   - Captures action counts (and autoFixEligible counts) — the LSP code-
 *     action enrichment is the actionable-warnings-only signal; preserving
 *     it lets later analyses ask "which warnings ship with an autofix?".
 *
 * Skips the write entirely when no warnings exist — matching the code-
 * quality history's no-op-on-empty behaviour and keeping the file from
 * accumulating 0-warning noise.
 */
export function appendActionableWarningsHistory(
	cwd: string,
	report: ActionableWarningsReport,
): void {
	const entries: ActionableWarningsHistoryEntry[] = [];
	for (const file of report.files) {
		for (const warning of file.warnings) {
			entries.push({
				timestamp: report.generatedAt,
				sessionId: report.sessionId,
				turnIndex: report.turnIndex,
				projectSeq: report.projectSeqEnd,
				filePath: warning.filePath,
				displayPath: warning.displayPath,
				fileSeq: file.fileSeq,
				line: warning.line,
				column: warning.column,
				severity: warning.severity,
				tool: warning.tool,
				source: warning.source,
				rule: warning.rule,
				code: warning.code,
				message: warning.message,
				fixKind: warning.fixKind,
				autoFixAvailable: warning.autoFixAvailable,
				actionCount: warning.actions.length,
				autoFixEligibleActionCount: warning.actions.filter(
					(action) => action.autoFixEligible,
				).length,
				suppressed: warning.suppressed,
				suppressionReason: warning.suppressionReason,
				origin: warning.origin,
				warningId: warning.id,
			});
		}
	}
	if (entries.length === 0) return;
	const historyPath = getActionableWarningsHistoryPath(cwd);
	try {
		fs.mkdirSync(path.dirname(historyPath), { recursive: true });
		fs.appendFileSync(
			historyPath,
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"utf8",
		);
	} catch {
		// Non-fatal — history write failure must never surface to the agent.
	}
}

export interface ActionableWarningsAutofixSummary {
	considered: number;
	applied: number;
	changedFiles: string[];
	skipped: Array<{ id: string; reason: string }>;
}

export interface ActionableWarningsFreshnessResult {
	fresh: boolean;
	reason?: string;
	reportProjectSeqEnd?: number;
	currentProjectSeq: number;
	filePath?: string;
	reportFileSeq?: number;
	currentFileSeq?: number;
}

export function checkActionableWarningsReportFresh(args: {
	report: ActionableWarningsReport;
	currentProjectSeq: number;
	getFileSeq?: (filePath: string) => number;
}): ActionableWarningsFreshnessResult {
	const reportProjectSeqEnd = args.report.projectSeqEnd;
	if (typeof reportProjectSeqEnd !== "number") {
		return {
			fresh: false,
			reason: "missing_project_seq",
			currentProjectSeq: args.currentProjectSeq,
		};
	}
	if (reportProjectSeqEnd !== args.currentProjectSeq) {
		return {
			fresh: false,
			reason: "project_seq_mismatch",
			reportProjectSeqEnd,
			currentProjectSeq: args.currentProjectSeq,
		};
	}
	if (args.getFileSeq) {
		for (const file of args.report.files) {
			if (typeof file.fileSeq !== "number") continue;
			const currentFileSeq = args.getFileSeq(file.filePath);
			if (currentFileSeq !== file.fileSeq) {
				return {
					fresh: false,
					reason: "file_seq_mismatch",
					reportProjectSeqEnd,
					currentProjectSeq: args.currentProjectSeq,
					filePath: file.filePath,
					reportFileSeq: file.fileSeq,
					currentFileSeq,
				};
			}
		}
	}
	return {
		fresh: true,
		reportProjectSeqEnd,
		currentProjectSeq: args.currentProjectSeq,
	};
}

export async function applyConservativeActionableWarningFixes(args: {
	cwd: string;
	report: ActionableWarningsReport;
	maxFixes?: number;
	dbg?: (msg: string) => void;
	mutationContext?: LspMutationContext;
}): Promise<ActionableWarningsAutofixSummary> {
	const summary: ActionableWarningsAutofixSummary = {
		considered: 0,
		applied: 0,
		changedFiles: [],
		skipped: [],
	};
	const changedFiles = new Set<string>();
	const appliedResults: Array<Awaited<ReturnType<typeof applyWorkspaceEdit>>> =
		[];
	let failedCount = 0;
	const lspService = getLSPService();
	const maxFixes = Math.max(0, args.maxFixes ?? 5);
	for (const file of args.report.files) {
		if (summary.applied >= maxFixes) break;
		for (const warning of file.warnings) {
			if (summary.applied >= maxFixes) break;
			if (warning.suppressed) continue;
			const eligibleActions = warning.actions.filter(
				(action) => action.autoFixEligible,
			);
			if (eligibleActions.length !== 1) {
				if (eligibleActions.length > 1)
					summary.skipped.push({
						id: warning.id,
						reason: "multiple_eligible_actions",
					});
				continue;
			}
			summary.considered++;
			if (!warning.line || !warning.column) {
				summary.skipped.push({ id: warning.id, reason: "missing_position" });
				continue;
			}
			if (!lspService.supportsLSP(warning.filePath)) {
				summary.skipped.push({ id: warning.id, reason: "no_lsp" });
				continue;
			}
			try {
				const content = fs.existsSync(warning.filePath)
					? fs.readFileSync(warning.filePath, "utf-8")
					: undefined;
				if (content) await lspService.openFile(warning.filePath, content);
				const line = warning.line - 1;
				const character = warning.column - 1;
				const actions = await lspService.codeAction(
					warning.filePath,
					line,
					character,
					line,
					character,
				);
				const title = eligibleActions[0]?.title;
				const selected = actions.find((action) => action.title === title);
				if (!selected) {
					summary.skipped.push({ id: warning.id, reason: "action_not_found" });
					continue;
				}
				const safety = actionSafety(selected);
				if (!safety.eligible) {
					summary.skipped.push({
						id: warning.id,
						reason: safety.reason ?? "not_safe",
					});
					continue;
				}
				const edit = selected.edit as Parameters<typeof applyWorkspaceEdit>[0];
				const applied = await applyWorkspaceEdit(
					edit,
					args.cwd,
					args.mutationContext
						? {
								mutationContext: {
									...args.mutationContext,
									emitSummary: false,
								},
							}
						: undefined,
				);
				appliedResults.push(applied);
				for (const changedFile of applied.files) changedFiles.add(changedFile);
				summary.applied++;
			} catch (err) {
				failedCount++;
				const partial = (
					err as {
						appliedWorkspaceEdit?: Awaited<
							ReturnType<typeof applyWorkspaceEdit>
						>;
					}
				).appliedWorkspaceEdit;
				if (partial) {
					appliedResults.push(partial);
					for (const changedFile of partial.files)
						changedFiles.add(changedFile);
				}
				const message = err instanceof Error ? err.message : String(err);
				args.dbg?.(
					`actionable_warnings_autofix failed for ${warning.id}: ${message}`,
				);
				summary.skipped.push({ id: warning.id, reason: "apply_failed" });
			}
		}
	}
	summary.changedFiles = [...changedFiles];
	if (
		args.mutationContext &&
		(summary.considered > 0 || appliedResults.length > 0)
	) {
		recordLspMutationBatch(args.mutationContext, {
			results: appliedResults,
			considered: summary.considered,
			completed: summary.applied,
			failedCount,
			status:
				failedCount > 0
					? "failed"
					: appliedResults.length > 0
						? "success"
						: "skipped",
			bookkeep: false,
		});
	}
	return summary;
}

export function formatActionableWarningsAdvisory(
	report: ActionableWarningsReport,
): string | undefined {
	if (report.summary.unsuppressed === 0) return undefined;
	const files = report.files.filter((file) =>
		file.warnings.some((warning) => !warning.suppressed),
	);
	const fileList = files
		.slice(0, 5)
		.map(
			(file) =>
				`  ${file.displayPath}: ${file.warnings.filter((warning) => !warning.suppressed).length}`,
		)
		.join("\n");
	const more =
		files.length > 5 ? `\n  ... and ${files.length - 5} more file(s)` : "";
	const safe =
		report.summary.autoFixEligible > 0
			? ` ${report.summary.autoFixEligible} appear to have conservative preferred quickfixes.`
			: "";
	// #1777: hint and info are style opinions, so say how much of the count is
	// opinion. The line appears only when a quiet tier is actually present —
	// an all-warning turn already says everything in the count above.
	const byTier = report.summary.byTier;
	const quiet = byTier ? byTier.hint + byTier.info : 0;
	const tierLine =
		quiet > 0
			? `${quiet} of those are hint/info tier — style opinions, worth fixing only while you are already in that code.`
			: undefined;
	return [
		`🟡 Fixable warnings introduced this turn: ${report.summary.unsuppressed}.${safe}`,
		tierLine,
		`Details written to .pi-lens/cache/actionable-warnings.json`,
		fileList ? `Files:\n${fileList}${more}` : undefined,
		"If continuing in these files, read that JSON and resolve warnings that are safe and relevant. Do not apply broad refactors unless requested.",
	]
		.filter(Boolean)
		.join("\n");
}
