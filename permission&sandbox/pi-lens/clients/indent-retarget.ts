import {
	blockCommentInteriorMask,
	templateLiteralInteriorMask,
} from "./dispatch/indent-detect.js";

/**
 * Anchors the interior-mask lexer to the real file instead of the agent's
 * oldText fragment. `content` is the file's full text (LF-normalized,
 * covering lines before and after the fragment); `startLine` is the
 * 1-indexed line, within `content`, where `correctedOldText`'s first line
 * begins — i.e. the same line-range a caller resolves via
 * `findUniqueMatchLineRange` before it knows the correction is safe to
 * apply. Without this, a fragment that starts or ends INSIDE a multi-line
 * template literal is lexically ambiguous on its own — a template's CLOSER
 * appearing without its opener reads as an opener, and vice versa, so the
 * mask can invert (real code masked as template interior, or the reverse)
 * wherever the fragment crosses a template boundary the surrounding file
 * would have resolved correctly (#3116 review round 2, F1/F4).
 */
export interface IndentRetargetFileContext {
	content: string;
	startLine: number;
}

/**
 * Computes both interior masks for `oldLines`, anchored to the real file
 * when `fileContext` resolves cleanly, falling back to the fragment alone
 * otherwise. `blockCommentInteriorMask` has no fragment-ambiguity to correct
 * (a lone `*\/` cannot be mistaken for an opener the way a lone backtick
 * can), so it always runs file-anchored when a file is available — this is
 * about `templateLiteralInteriorMask` specifically, but both take the same
 * path for one lexing pass over consistent line numbers.
 */
function computeInteriorMasks(
	oldLines: string[],
	fileContext: IndentRetargetFileContext | undefined,
): { commentInterior: boolean[]; templateInterior: boolean[] } {
	if (fileContext) {
		const fileLines = fileContext.content.replace(/\r\n/g, "\n").split("\n");
		const start = fileContext.startLine - 1;
		const end = start + oldLines.length;
		if (start >= 0 && end <= fileLines.length) {
			return {
				commentInterior: blockCommentInteriorMask(fileLines).slice(start, end),
				templateInterior: templateLiteralInteriorMask(fileLines).slice(
					start,
					end,
				),
			};
		}
		// startLine/length don't fit inside content — the caller resolved a
		// stale or mismatched range; fall through to the fragment-only path
		// rather than slicing out of bounds.
	}
	return {
		commentInterior: blockCommentInteriorMask(oldLines),
		templateInterior: templateLiteralInteriorMask(oldLines),
	};
}

/**
 * Retargets the leading-whitespace style of newText to match the indentation
 * correction that was applied to oldText.
 *
 * Builds a mapping from oldText indentation strings to their corrected forms,
 * then extends it to cover deeper nesting levels (n × baseUnit → n × correctedUnit).
 * Returns undefined — leaving newText unchanged — when any non-blank line in
 * newText has indentation that cannot be resolved, to avoid producing
 * mixed-indentation output.
 *
 * A line inside a terminated `/* … *\/` block comment, or inside a
 * multi-line template literal, still gets an exact entry in the map — a
 * replacement that reintroduces that SAME indent (adding another JSDoc
 * continuation, or another template line, say) still resolves by direct
 * lookup — but that indent is never eligible to be picked as the shortest
 * ("base") unit and extrapolated to a deeper level `newText` adds that
 * oldText never showed: its leading space is alignment (on the comment
 * opener's `*` column, or on the template string's own content), not a
 * nesting unit, and that alignment's ratio can differ from the code's own
 * indentation ratio, silently mis-scaling every such deeper line (#3052,
 * #3116). Uses the same lexer as `clients/dispatch/indent-detect.ts`'s
 * `detectIndentation` (#3039, #3059) rather than a second one.
 *
 * `fileContext`, when the caller has it, anchors that lexer to the real file
 * (see {@link IndentRetargetFileContext}) so a template boundary the
 * oldText fragment crosses is read correctly instead of ambiguously. Without
 * it (match position unknown — the caller never found a unique file span,
 * or is calling with a synthetic fragment that has no backing file), the
 * masks fall back to running over the fragment alone, which is exact for a
 * block comment (`*\/` cannot be mistaken for an opener) but can misread a
 * template literal whose opener or closer lies outside the fragment.
 */
export function retargetReplacementIndentation(
	newText: string,
	oldText: string,
	correctedOldText: string,
	fileContext?: IndentRetargetFileContext,
): string | undefined {
	const newline = newText.includes("\r\n") ? "\r\n" : "\n";
	const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
	const correctedLines = correctedOldText.replace(/\r\n/g, "\n").split("\n");
	if (oldLines.length !== correctedLines.length) return undefined;
	const { commentInterior, templateInterior } = computeInteriorMasks(
		oldLines,
		fileContext,
	);

	const indentMap = new Map<string, string>();
	// oldIndent keys backed by at least one line OUTSIDE a comment or
	// template-literal interior — the only keys eligible to be picked as the
	// base unit below. An interior line still lands in indentMap (exact-width
	// lookups must still resolve, #3052 F1), it just cannot anchor the
	// extrapolation.
	const structuralIndents = new Set<string>();
	const ambiguousIndents = new Set<string>();
	for (const [i, oldLine] of oldLines.entries()) {
		// oldLines.length === correctedLines.length is checked above; the "" is
		// unreachable, only satisfying noUncheckedIndexedAccess.
		const correctedLine = correctedLines[i] ?? "";
		const oldIndent = oldLine.match(/^[\t ]*/)?.[0] ?? "";
		const correctedIndent = correctedLine.match(/^[\t ]*/)?.[0] ?? "";
		if (oldIndent === correctedIndent) continue;
		const previous = indentMap.get(oldIndent);
		if (previous !== undefined && previous !== correctedIndent) {
			indentMap.delete(oldIndent);
			structuralIndents.delete(oldIndent);
			ambiguousIndents.add(oldIndent);
			continue;
		}
		if (!ambiguousIndents.has(oldIndent)) {
			indentMap.set(oldIndent, correctedIndent);
			if (!commentInterior[i] && !templateInterior[i]) {
				structuralIndents.add(oldIndent);
			}
		}
	}
	if (indentMap.size === 0) return undefined;

	// Find the shortest structurally-backed mapped key as the base unit so
	// that nesting levels in newText that are deeper than anything in
	// oldText can be remapped as n × baseFrom → n × baseTo. A key backed
	// only by comment- or template-interior lines is skipped here (but stays
	// in indentMap for direct lookups above).
	let baseFrom = "";
	let baseTo = "";
	for (const [from, to] of indentMap) {
		if (
			from.length > 0 &&
			structuralIndents.has(from) &&
			(baseFrom === "" || from.length < baseFrom.length)
		) {
			baseFrom = from;
			baseTo = to;
		}
	}

	function resolveIndent(indent: string): string | undefined {
		if (indent === "") return "";
		const direct = indentMap.get(indent);
		if (direct !== undefined) return direct;
		if (
			baseFrom.length > 0 &&
			indent.length % baseFrom.length === 0 &&
			baseFrom.repeat(indent.length / baseFrom.length) === indent
		) {
			return baseTo.repeat(indent.length / baseFrom.length);
		}
		return undefined;
	}

	let changed = false;
	const newLines = newText.replace(/\r\n/g, "\n").split("\n");
	const retargetedLines: string[] = [];

	for (const line of newLines) {
		const indent = line.match(/^[\t ]*/)?.[0] ?? "";
		if (indent === line) {
			// Blank / whitespace-only line — preserve as-is.
			retargetedLines.push(line);
			continue;
		}
		const resolved = resolveIndent(indent);
		if (resolved === undefined) {
			// Indentation can't be resolved — abort to avoid mixed-indentation output.
			return undefined;
		}
		if (resolved !== indent) {
			changed = true;
			retargetedLines.push(resolved + line.slice(indent.length));
		} else {
			retargetedLines.push(line);
		}
	}

	return changed ? retargetedLines.join(newline) : undefined;
}
