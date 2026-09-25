/**
 * The front door of the config pipeline: validate every source, then merge.
 *
 * It lives in its OWN module rather than in `index.ts` (#2426). `index.ts` is
 * the barrel, so anything importing it also pulls `process-spec.js` and, with
 * it, `project-trust.js` and the degradation ledger. That was harmless while
 * nothing downstream of `file-utils.ts` imported the core — and #2426 wires
 * three loaders that all sit downstream of it, which turned the barrel's width
 * into three extra import cycles that had nothing to do with what the loaders
 * actually use. A caller that only needs to resolve a config now imports only
 * the halves that resolve one.
 *
 * `index.ts` re-exports everything here, so the PUBLIC surface is unchanged and
 * `resolveConfig` is still the one supported way in.
 */
import { errorClassName } from "../error-class.js";
import { type ConfigSource, merge } from "./merge.js";
import { validate } from "./normalize.js";
import type { Resolved } from "./provenance.js";
import {
	MigrationRecordCollector,
	type MigrationRecord,
	migrationSubject,
} from "./records.js";
import type { SourceTier } from "./provenance.js";
import type { ConfigSchemaNode } from "./schema.js";

/** One source as the caller has it: parsed, not yet validated. */
export interface RawConfigSource extends Omit<ConfigSource, "value"> {
	/** Whatever the parser produced. */
	readonly value: unknown;
}

export interface ResolveConfigOptions {
	readonly sources: readonly RawConfigSource[];
	readonly schema: ConfigSchemaNode;
	/**
	 * Cap on records across the WHOLE resolution, not per source. Ten broken
	 * files must not multiply the bound by ten.
	 */
	readonly maxRecords?: number;
}

export interface ConfigResolution<T> {
	readonly resolved: Resolved<T>;
	readonly records: readonly MigrationRecord[];
	readonly droppedRecordCount: number;
}

/**
 * Validate every source, then merge them.
 *
 * One collector spans the whole resolution, so the record bound is per
 * resolution rather than per file. Sources are handed to `merge` in the order
 * given; `merge` sorts them by tier precedence itself.
 *
 * NEVER THROWS, and that is a contract rather than an observation (#2440
 * review). `validate` already promised it and enforced it with its own guard,
 * but the front door called `merge` outside any guard, so a value that reached
 * the merger in a shape it could not survive — the review's probe was a
 * 4000-deep blob under an opaque schema node — turned a config load into a
 * `RangeError` that took the session with it. The bounds inside both halves are
 * the real fix; this guard is the floor under them, so a future bug in either
 * half degrades a config to absent instead of failing a session.
 */
/**
 * The highest-precedence source's file and tier — the one whose values would
 * have won, and so the file a user looking at a failed resolution should open.
 *
 * Read DEFENSIVELY because its only caller is a catch block: whatever made the
 * resolution throw may equally make reading a source's own fields throw, and a
 * guard that throws while explaining a throw is no guard at all.
 */
function anchorSource(
	sources: readonly RawConfigSource[] | undefined,
): { readonly file: string; readonly tier: SourceTier } | undefined {
	try {
		const last = sources?.[sources.length - 1];
		return last === undefined || typeof last.file !== "string"
			? undefined
			: { file: last.file, tier: last.tier };
	} catch {
		// pi-lens-ignore: missing-error-propagation — the anchor is best-effort
		return undefined;
	}
}

export function resolveConfig<T = unknown>(
	options: ResolveConfigOptions,
): ConfigResolution<T> {
	const collector = new MigrationRecordCollector(options.maxRecords);
	try {
		const normalized: ConfigSource[] = options.sources.map((source) => ({
			tier: source.tier,
			...(source.file === undefined ? {} : { file: source.file }),
			...(source.trust === undefined ? {} : { trust: source.trust }),
			value: validate(source.value, options.schema, {
				file: source.file ?? "",
				tier: source.tier,
				collector,
			}).value,
		}));
		return {
			resolved: merge<T>(normalized, options.schema, { collector }),
			records: collector.records,
			droppedRecordCount: collector.droppedCount,
		};
	} catch (error) {
		// The error CLASS only, never its message, which could quote the file.
		// `errorClassName` (#2451) — never `config-warn.ts`'s own
		// `normalizeParseErrorReason`, which this module must not import: that
		// would reopen the sink-import cycle #2426 removed from `config-core/`.
		//
		// ANCHORED to the resolution's highest-precedence source (#2426 review
		// round 4, S1). This record used to carry `file: ""` and no tier, which
		// rendered as `ignoring invalid LSP config : …` — no path for the user to
		// open — and, naming neither a key nor a tier, was reported by every
		// config subsystem at once, so one internal failure became three notices.
		// The sources are right here; nothing downstream can recover them.
		//
		// `PILENS_CFG_0008`, not `0005` (#2426 review round 6, S1): 0005 is
		// registered and documented as a per-FIELD rejection, so a user matching
		// on it expects to have lost one setting. This record means the WHOLE
		// configuration was dropped, which is a different thing to do about it.
		//
		// SURVIVES THE BOUND (#2426 review round 7, F1). The per-field records
		// fill this same bounded collector, so a resolution that had already
		// produced `MAX_MIGRATION_RECORDS` of them used to swallow this record
		// into the anonymous suppression count — and the user then read "19 keys
		// rejected, 11 further notices suppressed" about a resolution that
		// applied NOTHING. That is the round-6 inversion arriving through the
		// bound rather than through the prose round 6 fixed.
		//
		// The rule that keeps it lives in `MigrationRecordCollector.add`
		// (`UNBOUNDED_RECORD_CODES`), not here, because appending it at THIS call
		// site fixes only this call site: `config-resolve.ts` re-bounds the very
		// list this function returns through `finalizeRecords`, whose collector
		// would drop it a second time. One rule at the one choke point covers
		// both bounds.
		const anchor = anchorSource(options.sources);
		const file = anchor?.file ?? "";
		collector.add({
			code: "PILENS_CFG_0008",
			file,
			key: "",
			subject: migrationSubject(file, ""),
			reason: `config resolution failed internally (${errorClassName(error)}); configuration ignored`,
			...(anchor ? { tier: anchor.tier } : {}),
		});
		return {
			// The empty resolution, built by the merger from no sources rather than
			// asserted into existence: `merge([])` is already "nothing resolved".
			resolved: merge<T>([], options.schema),
			records: collector.records,
			droppedRecordCount: collector.droppedCount,
		};
	}
}
