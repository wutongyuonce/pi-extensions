/**
 * ktfmt Gradle-plugin and Spotless style carriage (#2468/#2481).
 *
 * The `com.ncorti.ktfmt.gradle` plugin's `ktfmt { }` extension block lets a
 * project select `googleStyle()` or `kotlinLangStyle()` (verified against
 * `KtfmtExtension.kt` in `cortinico/ktfmt-gradle` at
 * `23bdedc8d5d641731a0cf128f1a386d5a127ce4e` — those two are the only style
 * functions it defines today, and both are plain setters over
 * `blockIndent`/`continuationIndent`/`trailingCommaManagementStrategy`, so a
 * body calling both is LAST-CALL-WINS, not first).
 *
 * Spotless uses a second DSL shape, `spotless { kotlin { ktfmt(...).googleStyle()
 * } }`, with `kotlinlangStyle()` and `dropboxStyle()` as fluent methods.
 *
 * None of these selections are read by ktfmt's own CLI from `build.gradle` —
 * verified against `ParsedArgs.kt` in `facebook/ktfmt` (now mirrored at
 * `Kotlin/ktfmt`) at tag v0.63, the exact version `clients/installer/
 * index.ts` pins for pi-lens's managed ktfmt install. That CLI accepts
 * `--google-style` / `--kotlinlang-style` (plus the default `--meta-style`)
 * — so the Gradle-declared choice has to be translated to the matching CLI
 * flag by something on our side; ktfmt itself never bridges `build.gradle`
 * to argv. Spotless's Dropbox style has no equivalent flag, so that case logs
 * and falls back to bare ktfmt.
 *
 * Reuses the exact lexical pre-pass (`stripGradleCommentsAndStrings` /
 * `gradleBlockRanges`) that `clients/tool-policy.ts`'s
 * `getSpotlessKotlinFormatter` already applies to Gradle files, instead of a
 * second hand-rolled Gradle-block parser (#2468 AC) — same
 * single-source-of-truth reuse `clients/cargo-manifest.ts` did for TOML
 * parsing in `clients/formatters.ts`'s rustfmt `--edition` carriage (#2466).
 *
 * ## Project scoping (#2468 review rounds 2 and 3)
 *
 * A Gradle build file configures more than the directory it sits in, and the
 * multi-module layout the plugin is actually used in puts the style in the
 * ROOT build file while each module's own `build.gradle(.kts)` declares only
 * its plugins. Round 1 stopped the ancestor climb at the first directory
 * holding ANY gradle file and matched `ktfmt {` anywhere in it, which was
 * wrong in both directions: a module inherited nothing (the #2468 defect
 * survived for the common layout) while the ROOT's own sources were handed a
 * `subprojects { }`-scoped style that Gradle never applies to them. This
 * module therefore classifies each `ktfmt { }` block by the block ENCLOSING
 * it — the actual brace nesting on the stripped source, not a single
 * hard-coded name test — and climbs past directories that declare no style
 * for the project being formatted:
 *
 * - no enclosing block (a top-level `ktfmt { }`) → the DECLARING directory
 *   only. Gradle does not inherit here: the plugin gives each project its own
 *   `KtfmtExtension` instance seeded with the plugin conventions (verified at
 *   the SHA above), so a module that applies the plugin and calls no style
 *   function really does format under ktfmt's default — which is exactly the
 *   bare invocation this resolver falls back to. Round 2 spread a top-level
 *   block over style-less descendants as a documented heuristic; that
 *   manufactured a NEW pi-lens/Gradle disagreement (pi-lens writes
 *   `--google-style`, `./gradlew ktfmtCheck` then rejects the file pi-lens
 *   just formatted) which the pre-#2468 bare invocation did not have, so it
 *   is gone. Aligning with `hasKtfmtConfig`'s wider climb does not justify
 *   it: that election answers "is ktfmt the formatter for this file", not
 *   "which style"; where Gradle carries no style down, the bare invocation IS
 *   the correct carriage of `--meta-style`.
 * - `subprojects { ktfmt { … } }` → DESCENDANT directories only, never the
 *   declaring one. `subprojects` configures the children and nothing else.
 * - `allprojects { ktfmt { … } }` → the declaring directory AND descendants.
 * - `spotless { kotlin { … } }` excludes the Spotless DSL wrapper from scope
 *   classification, while any outer project wrapper keeps its existing scope.
 * - anything else enclosing it — `configure(subprojects.filter { … }) { }`,
 *   `project(":app") { }`, `tasks.register(…) { }`, a convention-plugin
 *   wrapper, or more than one nested block — reaches NEITHER scope. pi-lens
 *   cannot evaluate a build script, so a scope it cannot compute fails closed
 *   to the bare invocation rather than being granted to every project.
 *
 * KNOWN GAP (#2468 review round 3, F3): the first gradle directory found by
 * the climb is treated as the project that OWNS the file. A module directory
 * that is `include(…)`d by `settings.gradle(.kts)` but holds NO build file of
 * its own therefore resolves hop 0 to an ANCESTOR, and asks it for `own`
 * scope when `descendants` is what Gradle would apply. Against a root
 * `subprojects { ktfmt { … } }` this is a fail-safe miss — no flag, the
 * pre-#2468 bare invocation — because `subprojects` only ever fills the
 * `descendants` slot, which hop 0 never reads. But against a root's
 * TOP-LEVEL `ktfmt { }` (`own` scope, by the table above) it is a WRONG
 * flag: hop 0 reads `own` regardless of which project it actually belongs
 * to, so the module is handed the ROOT's own style even though Gradle gives
 * the module its own `KtfmtExtension` and applies no style there. Closing it
 * means reading `settings.gradle`'s `include(…)` list to map a directory to
 * a Gradle project, which this module does not do.
 */

import * as os from "node:os";
import * as path from "node:path";
import { readTextFileOrUndefined } from "./cargo-manifest.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import { logExtension } from "./extension-log.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import {
	gradleBlockRanges,
	type NamedGradleBlockRange,
	stripGradleCommentsAndStrings,
} from "./tool-policy.js";

/** Nearest-first: a Kotlin script build file wins over its Groovy sibling. */
const KTFMT_GRADLE_ROOT_FILES = [
	"build.gradle.kts",
	"build.gradle",
	"settings.gradle.kts",
	"settings.gradle",
];

/**
 * Ancestor gradle directories consulted before giving up. Each hop costs at
 * most four small reads, and Gradle builds nest a handful of levels at most;
 * the cap keeps a pathological tree (or a symlink cycle that survives
 * `path.dirname`) from turning one format into an unbounded walk. The
 * `homeDir` ceiling inside `findNearestMarkerRoot` normally ends the climb
 * long before this.
 */
const MAX_GRADLE_ANCESTOR_HOPS = 16;
/** Bound malformed Spotless calls without rejecting ordinary nested arguments. */
const MAX_SPOTLESS_KTFMT_CALL_CHARS = 4096;

type KtfmtGradleStyle = "google" | "kotlinlang";
type ParsedKtfmtStyle = KtfmtGradleStyle | "spotless-dropbox-unsupported";

/** The CLI flags ktfmt v0.63 actually defines (`ParsedArgs.kt`, verified above). */
const KTFMT_STYLE_CLI_FLAG = {
	google: "--google-style",
	kotlinlang: "--kotlinlang-style",
} satisfies Record<KtfmtGradleStyle, string>;

/**
 * The style a single gradle file declares, split by which projects it reaches.
 * `own` is the project whose directory holds the file; `descendants` is every
 * project below it.
 */
interface GradleKtfmtStyles {
	own?: ParsedKtfmtStyle;
	descendants?: ParsedKtfmtStyle;
}

/**
 * Read the style declared by one `ktfmt { }` block body, LAST call wins.
 *
 * `googleStyle()` and `kotlinLangStyle()` both just `.set(...)` the same
 * three extension properties, so in `ktfmt { googleStyle(); kotlinLangStyle() }`
 * the second call is the one whose values survive into the format (verified
 * against `KtfmtExtension.kt`, SHA above). `undefined` means the block
 * declares no recognized style call — including the `dropboxStyle()` that
 * ktfmt-gradle removed in 0.19.0 and ktfmt's CLI never exposed a flag for,
 * which is simply not a style this resolver can carry.
 */
function styleFromKtfmtBlockBody(body: string): KtfmtGradleStyle | undefined {
	let style: KtfmtGradleStyle | undefined;
	let lastIndex = -1;
	for (const [call, candidate] of [
		[/\bgoogleStyle\s*\(\s*\)/g, "google"],
		[/\bkotlinLangStyle\s*\(\s*\)/g, "kotlinlang"],
	] as const) {
		for (const match of body.matchAll(call)) {
			if (match.index > lastIndex) {
				lastIndex = match.index;
				style = candidate;
			}
		}
	}
	return style;
}

/** Find a bounded matching close parenthesis for a Spotless ktfmt call. */
function findBalancedCallEnd(
	source: string,
	openingParen: number,
): number | undefined {
	let depth = 0;
	const limit = Math.min(
		source.length,
		openingParen + MAX_SPOTLESS_KTFMT_CALL_CHARS,
	);
	for (let index = openingParen; index < limit; index += 1) {
		if (source[index] === "(") depth += 1;
		if (source[index] !== ")") continue;
		depth -= 1;
		if (depth === 0) return index + 1;
	}
	return undefined;
}

/** Read a Spotless `ktfmt(...).style()` fluent chain from one kotlin body. */
function styleFromSpotlessKotlinBody(
	body: string,
): ParsedKtfmtStyle | undefined {
	let style: ParsedKtfmtStyle | undefined;
	for (const call of body.matchAll(/\bktfmt\s*(?=\()/g)) {
		const callOpenParen = call.index + call[0].length;
		const closeParen = findBalancedCallEnd(body, callOpenParen);
		if (closeParen === undefined) continue;
		const chain =
			/^\s*((?:\.\s*(?:googleStyle|kotlinlangStyle|dropboxStyle)\s*\(\s*\)\s*)+)/.exec(
				body.slice(closeParen),
			);
		if (!chain) continue;
		const chainBody = chain[1];
		if (!chainBody) continue;
		for (const method of chainBody.matchAll(
			/\.\s*(googleStyle|kotlinlangStyle|dropboxStyle)\s*\(\s*\)/g,
		)) {
			if (method[1] === "googleStyle") style = "google";
			if (method[1] === "kotlinlangStyle") style = "kotlinlang";
			if (method[1] === "dropboxStyle") style = "spotless-dropbox-unsupported";
		}
	}
	return style;
}

/**
 * Which projects a Gradle style block reaches. `undefined` means NEITHER, a
 * scope this resolver cannot compute, which falls back to the bare invocation.
 */
type KtfmtBlockScope = "own" | "descendants" | "both";

/**
 * The Gradle blocks whose scope is exactly expressible here. Every other
 * enclosing block — including one we simply have not heard of — is a scope
 * pi-lens cannot evaluate, and is NOT silently promoted to project-wide.
 */
const SCOPE_BY_ENCLOSING_BLOCK: Readonly<Record<string, KtfmtBlockScope>> = {
	subprojects: "descendants",
	allprojects: "both",
};

/**
 * Classify one Gradle style block by the block that encloses it.
 *
 * `ranges` is every brace pair in the stripped source, so "enclosing" is
 * literal containment, not a guess from a name test: `range` strictly inside
 * `outer` means `outer.start < range.start` (an enclosing body always opens
 * before the body it contains) and `outer.end >= range.end`.
 *
 * More than one enclosing block (`subprojects { afterEvaluate { ktfmt { } } }`)
 * fails closed too. Composing scopes through an arbitrary intermediate is
 * exactly the kind of build-script evaluation this lexical pass cannot do,
 * and the cost of the conservative answer is the pre-#2468 bare invocation.
 */
function scopeOfGradleStyleBlock(
	range: NamedGradleBlockRange,
	ranges: readonly NamedGradleBlockRange[],
): KtfmtBlockScope | undefined {
	const enclosing = ranges.filter(
		(outer) => outer.start < range.start && outer.end >= range.end,
	);
	if (enclosing.length === 0) return "own";
	if (enclosing.length > 1) return undefined;
	return SCOPE_BY_ENCLOSING_BLOCK[enclosing[0].name];
}

interface GradleStyleSelection {
	scope: KtfmtBlockScope;
	style: ParsedKtfmtStyle;
}

function styleSelectionForGradleBlock(
	block: NamedGradleBlockRange,
	source: string,
	allBlockRanges: readonly NamedGradleBlockRange[],
	nonSpotlessRanges: readonly NamedGradleBlockRange[],
): GradleStyleSelection | undefined {
	if (block.name === "ktfmt") {
		const scope = scopeOfGradleStyleBlock(block, allBlockRanges);
		if (!scope) return undefined;
		const style = styleFromKtfmtBlockBody(source.slice(block.start, block.end));
		return style ? { scope, style } : undefined;
	}
	if (block.name !== "kotlin") return undefined;
	const enclosingSpotless: NamedGradleBlockRange[] = [];
	for (const outer of allBlockRanges) {
		if (
			outer.name === "spotless" &&
			outer.start < block.start &&
			outer.end >= block.end
		) {
			enclosingSpotless.push(outer);
		}
	}
	if (enclosingSpotless.length !== 1) return undefined;
	const scope = scopeOfGradleStyleBlock(block, nonSpotlessRanges);
	if (!scope) return undefined;
	const style = styleFromSpotlessKotlinBody(
		source.slice(block.start, block.end),
	);
	return style ? { scope, style } : undefined;
}

function stylesFromGradleContent(content: string): GradleKtfmtStyles {
	const stripped = stripGradleCommentsAndStrings(content);
	const blocks = gradleBlockRanges(stripped);
	// The Spotless block is the target DSL, not a project-scope wrapper.
	const scopeRanges: NamedGradleBlockRange[] = [];
	for (const range of blocks) {
		if (range.name !== "spotless") scopeRanges.push(range);
	}
	const styles: GradleKtfmtStyles = {};
	// Source order, so a later block overwrites an earlier one for the scope
	// it reaches — the same last-call-wins rule that applies inside one body.
	// Each scope is written independently: two blocks that reach DISJOINT sets
	// of projects (a `subprojects { }` one and a top-level one) must not fight
	// over a single slot, or the source order of unrelated scopes decides
	// which project gets the wrong flag.
	for (const range of blocks) {
		const selection = styleSelectionForGradleBlock(
			range,
			stripped,
			blocks,
			scopeRanges,
		);
		if (!selection) continue;
		if (selection.scope !== "descendants") styles.own = selection.style;
		if (selection.scope !== "own") styles.descendants = selection.style;
	}
	return styles;
}

async function stylesForGradleDir(
	gradleDir: string,
): Promise<GradleKtfmtStyles> {
	for (const gradleFile of KTFMT_GRADLE_ROOT_FILES) {
		const content = await readTextFileOrUndefined(
			path.join(gradleDir, gradleFile),
		);
		if (content === undefined) continue;
		const styles = stylesFromGradleContent(content);
		if (styles.own || styles.descendants) return styles;
	}
	return {};
}

/**
 * Resolve the ktfmt CLI style flag (`--google-style` / `--kotlinlang-style`)
 * for the Gradle project that owns `filePath`, so a caller that needs it
 * doesn't have ktfmt silently apply its own default style
 * (`--meta-style`-equivalent) where the project's `ktfmt { }` block picked a
 * different one (#2468 — the same manifest-detected-but-not-carried defect
 * shape #2466 fixed for rustfmt `--edition`).
 *
 * - Finds the nearest directory containing a `build.gradle(.kts)`/
 *   `settings.gradle(.kts)` file via the shared `findNearestMarkerRoot`
 *   walker (home-ceiling guarded, depth-capped — AGENTS.md
 *   walk-confinement; never a private walk-up loop). That first directory is
 *   TAKEN to be the project that OWNS the file, so its `own`-scope
 *   declaration applies; every further hop is an ancestor, so only its
 *   `descendants`-scope declaration does. See the module header's KNOWN GAP
 *   note for the `include(…)`-only module directory where that
 *   identification is wrong — a missed flag against a `subprojects { }` root,
 *   but a WRONG flag (the root's own style) against a root TOP-LEVEL one.
 * - A nested module's OWN style declaration still wins over an ancestor's —
 *   the climb only continues past a gradle directory that declares NO style
 *   applying to this file, so nearest-wins is unchanged where a nearer
 *   declaration exists.
 * - Returns `undefined` on any miss (no gradle file found, no style block, or
 *   no recognized style call): callers fall back to their pre-existing default
 *   argv rather than guessing. Spotless `dropboxStyle()` is recognized as a
 *   standalone-CLI limitation, records a bounded notice, and still falls back
 *   without becoming a guessed flag.
 *
 * `homeDir` defaults to `os.homedir()` and exists as a parameter so tests can
 * inject a nearer ceiling and prove the guard actually stops a climb (mirrors
 * `resolveCargoPackageEdition`'s `homeDir` parameter, #2466 review round 2,
 * F5) — production callers never pass it.
 */
export async function resolveKtfmtGradleStyle(
	filePath: string,
	homeDir: string = os.homedir(),
): Promise<string | undefined> {
	let searchDir = path.dirname(path.resolve(filePath));

	for (let hop = 0; hop < MAX_GRADLE_ANCESTOR_HOPS; hop += 1) {
		const gradleDir = findNearestMarkerRoot(
			searchDir,
			KTFMT_GRADLE_ROOT_FILES,
			{
				homeDir,
			},
		);
		if (!gradleDir) return undefined;

		const styles = await stylesForGradleDir(gradleDir);
		const style = hop === 0 ? styles.own : styles.descendants;
		if (style === "spotless-dropbox-unsupported") {
			const reason =
				"Spotless ktfmt dropboxStyle(): pi-lens standalone CLI cannot express " +
				"the style; falling back to bare ktfmt";
			const firstOccurrence = incrementDegradationCount({
				kind: "formatter-skip",
				subject: "ktfmt:spotless-dropbox",
				reason,
				metadata: { filePath, gradleDir },
			});
			if (firstOccurrence) {
				logExtension({
					subsystem: "format",
					level: "debug",
					message: reason,
					metadata: { filePath, gradleDir },
				});
			}
			return undefined;
		}
		if (style) return KTFMT_STYLE_CLI_FLAG[style];

		const parent = path.dirname(gradleDir);
		if (parent === gradleDir) return undefined;
		searchDir = parent;
	}
	return undefined;
}
