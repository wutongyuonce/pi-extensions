/**
 * Shared "finding identity" primitive (#1816 item 2, unifying the #533
 * canonicalization fix that only reached one of three copies).
 *
 * Three call sites independently hand-rolled the same shape — a hash over
 * `relativeFile|tool|rule|...|normalizedMessage` — to derive a stable id for
 * a diagnostic/finding: `diagnostic-dispositions.ts` (dd:/ddw:),
 * `actionable-warnings.ts` (aw:), and `code-quality-warnings.ts` (cq:). Only
 * `diagnostic-dispositions.ts`'s `relativeFile` routed both `cwd` and
 * `filePath` through `normalizeMapKey` before computing the relative path
 * (see the #1024/#210-class comment this module's `relativeFile` carries
 * forward) — the other two hashed the RAW inputs, so a drive-letter-case or
 * slash-variant `filePath` produced a different id in the warning stores
 * than dispositions would compute for the identical file. This module is the
 * single source for all three: one canonicalizing `relativeFile`, one
 * `normalizeMessage`, one `hashText`, and one hash length.
 *
 * Hash length: dispositions used 12 hex chars, the two warning builders used
 * 10. This module picks 12 (dispositions' length — dispositions is the older,
 * more heavily-audited call site) for every finding id going forward.
 * Callers that persist ids in a keyed on-disk store (only
 * `actionable-warnings.ts` does; see its own module doc) are responsible for
 * back-compat lookups against ids computed under their PRE-#1816 formula —
 * this module does not attempt migration itself, since it has no way to know
 * which callers persist and which are ephemeral-per-turn.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { normalizeMapKey } from "./path-utils.js";

/** Every finding id in this codebase truncates its sha256 hex digest to this
 * many characters. Single source so the three call sites this module
 * unifies (and any future one) can't drift back apart the way the pre-#1816
 * 10-vs-12 split did. */
export const FINDING_ID_HASH_LENGTH = 12;

/** Exported so a cross-check against a live diagnostic's message (e.g.
 * lens-diagnostic-mark's widget match) folds whitespace/case the same way id
 * derivation does — a second, slightly different normalizer would make a
 * real match invisible. */
export function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashText(
	value: string,
	length: number = FINDING_ID_HASH_LENGTH,
): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Canonicalize BOTH `filePath` and `cwd` through `normalizeMapKey` (realpath
 * + case-fold on Windows) BEFORE computing the relative path, so two callers
 * holding different path FORMS of the same file (raw vs. already-normalized,
 * a Windows drive/segment case difference, a slash variant) converge on the
 * identical relative-path component instead of silently diverging into two
 * different finding ids for the same file (the #533 orphaned-record class).
 * `normalizeMapKey` is idempotent, so an already-canonical caller pays no
 * behavior change, only the realpath I/O — acceptable here because finding
 * ids are computed far less often than a per-write hot-path map key.
 */
export function relativeFile(filePath: string, cwd: string): string {
	const canonicalCwd = normalizeMapKey(cwd);
	const canonicalFile = normalizeMapKey(filePath);
	const rel = path.relative(canonicalCwd, canonicalFile).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") ? rel : canonicalFile;
}

/**
 * Shared finding-id builder. `prefix` carries the caller's own namespace
 * (`"dd:"`, `"ddw:"`, `"aw:"`, `"cq:"`, ...) so distinct finding families
 * never collide in a shared store. `parts` is the caller's own ordered,
 * domain-specific identity fields (tool/rule/code/normalizedMessage/line/
 * lineContentHash/...) — this function only supplies the canonical
 * `relativeFile` component and the hash/prefix wiring.
 *
 * Both `undefined` AND `null` entries fold to `""` (review-round F4,
 * #1816), matching the `String(x ?? "")` idiom every pre-#1816 id builder
 * used. `null` is in the parts type despite every caller's field being
 * declared `T | undefined` in TypeScript: those fields (`Diagnostic.code`,
 * `.rule`, etc.) are frequently assigned straight from `JSON.parse`'d tool
 * output, which defeats the static type at runtime — a runner that emits
 * `"code": null` produces a real `null`, not `undefined`. Folding only
 * `undefined` would silently hash that as the string `"null"` instead of
 * `""`, diverging from every other id-construction path for the exact same
 * finding — a fresh, narrower instance of the #533 divergence class this
 * module exists to eliminate.
 */
export function stableFindingId(
	prefix: string,
	args: {
		cwd: string;
		filePath: string;
		parts: Array<string | number | null | undefined>;
	},
): string {
	const joined = [
		relativeFile(args.filePath, args.cwd),
		...args.parts.map((part) =>
			part === undefined || part === null ? "" : String(part),
		),
	].join("|");
	return `${prefix}${hashText(joined)}`;
}
