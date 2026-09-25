import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LENS_EVENT_NAMES } from "../../clients/lens-events.js";

const clientsDir = path.resolve(process.cwd(), "clients");

/**
 * Files that own the shared live-emitter seam itself, not a producer that
 * routes THROUGH it. `live-bus-emitter.ts` defines `resolveLiveBusEmitter`
 * and calls `logBusEvent` directly for the `skipped_stale_session` outcome —
 * it is not expected to contain a `resolveLiveBusEmitter(` call site.
 * `bus-events-logger.ts` is the NDJSON sink every producer (and the resolver)
 * imports; it emits nothing itself.
 */
const SEAM_FILES = new Set(["live-bus-emitter.ts", "bus-events-logger.ts"]);

/**
 * M3 (#1415 review): the producer list used to be hand-maintained (a
 * third-copy antipattern per the single-source-of-truth discipline) — derive
 * it instead by sweeping `clients/*.ts` for files that import
 * `bus-events-logger.js`, the shared NDJSON trace every real producer writes
 * to on every publish attempt. A new producer that starts emitting bus
 * events but forgets to route through `resolveLiveBusEmitter` is caught
 * automatically, without anyone remembering to add it to a list here.
 */
function discoverProducerFiles(): string[] {
	return fs
		.readdirSync(clientsDir)
		.filter((file) => file.endsWith(".ts") && !SEAM_FILES.has(file))
		.filter((file) => {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			return /from\s+["']\.\/bus-events-logger\.js["']/.test(source);
		})
		.sort();
}

/**
 * Allowlist for a literal `.emit(` call site inside a producer file (M3b,
 * #1415 review). The ONLY sanctioned shape is `resolution.emit(...)` — the
 * value `resolveLiveBusEmitter` itself returned, already probed for a stale
 * ctx. Every other `.emit(` (a raw getter invoked and called directly, a
 * captured `pi.events` reference, a bus/target local dereferenced without
 * going through the resolver) bypasses the stale-session guard entirely,
 * which is exactly the shape the reviewer's planted `rawGetter?.().emit(...)`
 * bypass exploited while the file-existence sweep above stayed green.
 *
 * If a producer ever legitimately needs a non-bus `EventEmitter`-typed local
 * (unrelated to the pi.events bus), extend this allowlist with that
 * identifier explicitly — do not widen the regex.
 */
const SANCTIONED_EMIT_CALLERS = new Set(["resolution"]);

/**
 * Find every `<expr>.emit(` call site in `source` and return the identifier
 * (or other token) immediately before `.emit(`, so callers can check it
 * against `SANCTIONED_EMIT_CALLERS`. Returns `null` for a call site whose
 * preceding token isn't a simple identifier (e.g. `().emit(`) — those are
 * always violations since no allowlisted caller can produce that shape.
 */
function findEmitCallSites(
	source: string,
): Array<{ caller: string | null; index: number }> {
	const sites: Array<{ caller: string | null; index: number }> = [];
	const pattern = /\.emit\(/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: exec-loop is the standard idiom
	while ((match = pattern.exec(source))) {
		const before = source.slice(0, match.index);
		const callerMatch = before.match(/([A-Za-z_$][A-Za-z0-9_$]*)$/);
		sites.push({
			caller: callerMatch ? callerMatch[1] : null,
			index: match.index,
		});
	}
	return sites;
}

describe("bus producer guarded-seam coverage", () => {
	it("routes every event producer through the shared live emitter resolver", () => {
		const producers = discoverProducerFiles();
		// Sanity: the sweep must actually find the known producer family, not
		// silently discover zero files (a discovery bug would make every
		// assertion below vacuously pass on an empty list).
		expect(producers).toEqual([
			"bus-publish.ts",
			"diagnostics-publish.ts",
			"disposition-publish.ts",
			"format-events-publish.ts",
			"lens-events.ts",
		]);

		for (const file of producers) {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			expect(source, file).toContain("resolveLiveBusEmitter(");
			expect(source, file).not.toMatch(/liveEmitter\.resolve\s*\(/);
			expect(source, file).not.toMatch(
				/(?:lensEventBusGetter|busEmitterGetter)\?\.\(/,
			);
		}

		const productionSources = fs
			.readdirSync(clientsDir)
			.filter((file) => file.endsWith(".ts"))
			.map(
				(file) =>
					[file, fs.readFileSync(path.join(clientsDir, file), "utf8")] as const,
			);
		const directResolvers = productionSources.filter(
			([file, source]) =>
				file !== "live-bus-emitter.ts" &&
				/liveEmitter\.resolve\s*\(/.test(source),
		);
		expect(directResolvers).toEqual([]);
	});

	it("has no bare .emit( call outside the resolveLiveBusEmitter path", () => {
		const producers = discoverProducerFiles();
		const violations: string[] = [];
		for (const file of producers) {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			for (const { caller, index } of findEmitCallSites(source)) {
				if (caller && SANCTIONED_EMIT_CALLERS.has(caller)) continue;
				const line = source.slice(0, index).split("\n").length;
				violations.push(
					`${file}:${line} — unsanctioned \`.emit(\` call (caller: ${caller ?? "<non-identifier>"})`,
				);
			}
		}
		expect(violations).toEqual([]);
	});

	it("carries ctxSource on every producer's emit_failed row", () => {
		// #1432 review (S2c): lens-events.ts's emit_failed row was missing
		// ctxSource while the other four producers already carried it — a
		// static source scan (not a runtime assertion) so a future producer
		// that copy-pastes the emit_failed shape without ctxSource fails loud
		// instead of silently dropping the field like this one did.
		const producers = discoverProducerFiles();
		for (const file of producers) {
			const source = fs.readFileSync(path.join(clientsDir, file), "utf8");
			const failedIndex = source.indexOf('outcome: "emit_failed"');
			expect(
				failedIndex,
				`${file}: no emit_failed outcome found`,
			).toBeGreaterThanOrEqual(0);
			const blockEnd = source.indexOf("});", failedIndex);
			const block = source.slice(
				failedIndex,
				blockEnd === -1 ? undefined : blockEnd,
			);
			expect(block, `${file}: emit_failed row missing ctxSource`).toMatch(
				/ctxSource:\s*resolution\.ctxSource/,
			);
		}
	});

	it("keeps the complete lens producer family in the guarded producer set", () => {
		expect(Object.values(LENS_EVENT_NAMES)).toEqual([
			"pi-lens/analysis-complete",
			"pi-lens/findings",
			"pi-lens/turn-findings",
		]);
	});
});
