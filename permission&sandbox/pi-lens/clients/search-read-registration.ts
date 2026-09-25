/**
 * Register the lines a *search* tool revealed to the agent as reads, so a
 * follow-up edit to those lines is not blocked by the read-guard (#169).
 *
 * Search → edit is a common flow: the agent finds where something must change
 * (ast_grep_search / lsp_navigation / grep), then edits exactly those lines.
 * Those lines were genuinely shown, so they count as read — but ONLY the lines
 * the search actually DELIVERED, never the whole file and never a blanket
 * margin, so editing an unseen region is still guarded (#1904).
 */
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { isPathIgnoredByProject } from "./file-utils.js";
import { isExternalOrVendorFile } from "./path-utils.js";
import type { ReadRecord, SearchCreditReason } from "./read-guard.js";

/** Clamp a delivered-context count to a usable non-negative integer. */
function normalizeMargin(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

export interface SearchReadLocation {
	/** Absolute or project-relative file path. */
	file: string;
	/** 1-based first line shown. */
	startLine: number;
	/** 1-based last line shown (defaults to startLine). */
	endLine?: number;
	/**
	 * Lines of context the search tool actually PRINTED above the hit (grep
	 * `-B`/`-C`). Only set this when the lines were delivered to the model.
	 */
	contextBefore?: number;
	/** Lines of context actually printed below the hit (grep `-A`/`-C`). */
	contextAfter?: number;
}

interface RegisterOpts {
	projectRoot: string;
	turnIndex: number;
	writeIndex: number;
	/**
	 * Fallback slack for locations that carry no delivered-context counts.
	 * Defaults to 0: a bare hit credits the match line only (#1904).
	 */
	contextMargin?: number;
}

/**
 * #1904 item 2: this was 2, which credited every search hit as a 5-line read
 * even though most searches print ONE line. The guard then let edits pass
 * against lines the model never saw. Credit only delivered lines; callers that
 * DID deliver context pass `contextBefore`/`contextAfter` per location.
 *
 * Note this is not the only slack in the system: `readCoversRange` in
 * read-guard.ts still widens every read record by `config.contextLines` when it
 * tests coverage, so a bare hit remains editable within that configured band.
 */
const DEFAULT_CONTEXT_MARGIN = 0;

/**
 * Record each shown location as a read (± context margin). Resolves project-
 * relative paths, skips external/vendor/ignored/non-existent files, and dedupes
 * identical spans. Returns how many reads were recorded.
 */
export function registerSearchReads(
	readGuard: { recordRead: (record: ReadRecord) => void },
	locations: SearchReadLocation[],
	opts: RegisterOpts,
): number {
	const margin = opts.contextMargin ?? DEFAULT_CONTEXT_MARGIN;
	const seen = new Set<string>();
	let recorded = 0;

	for (const loc of locations) {
		if (!loc?.file || !Number.isFinite(loc.startLine)) continue;
		const abs = path.isAbsolute(loc.file)
			? loc.file
			: path.resolve(opts.projectRoot, loc.file);
		if (isExternalOrVendorFile(abs, opts.projectRoot)) continue;
		if (isPathIgnoredByProject(abs, opts.projectRoot, false)) continue;
		try {
			if (!nodeFs.statSync(abs).isFile()) continue;
		} catch {
			continue;
		}

		const marginBefore = normalizeMargin(loc.contextBefore) ?? margin;
		const marginAfter = normalizeMargin(loc.contextAfter) ?? margin;
		const creditReason: SearchCreditReason =
			marginBefore === 0 && marginAfter === 0
				? "match-lines-only"
				: loc.contextBefore !== undefined || loc.contextAfter !== undefined
					? "delivered-context-flags"
					: "caller-margin";

		const start = Math.max(1, Math.floor(loc.startLine) - marginBefore);
		const endLine = Number.isFinite(loc.endLine)
			? (loc.endLine as number)
			: loc.startLine;
		const end = Math.max(start, Math.floor(endLine) + marginAfter);
		const limit = end - start + 1;

		const key = `${abs}:${start}:${limit}`;
		if (seen.has(key)) continue;
		seen.add(key);

		readGuard.recordRead({
			filePath: abs,
			requestedOffset: start,
			requestedLimit: limit,
			effectiveOffset: start,
			effectiveLimit: limit,
			expandedByLsp: false,
			searchCredit: {
				marginBefore,
				marginAfter,
				reason: creditReason,
			},
			turnIndex: opts.turnIndex,
			writeIndex: opts.writeIndex,
			timestamp: Date.now(),
		});
		recorded++;
	}

	return recorded;
}
