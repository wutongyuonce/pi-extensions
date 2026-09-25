/**
 * #2215 — the napi fallback admitted files it then silently dropped, and
 * dropped whole catalog languages with no record anywhere.
 *
 * Four hand-maintained lists used to describe the in-process language set
 * (`SUPPORTED_EXTS`, `SUPPORTED_RULE_LANGUAGES`, `ruleLanguageForFile`,
 * `getLang`). They were only ever extended reactively, so `.mjs`/`.cjs`/
 * `.mts`/`.cts` — ordinary `jsts` files the addon's own js/ts grammars parse
 * — never ran a single ast-grep rule, and the twelve catalog languages the
 * addon has no grammar for were skipped with nothing saying so. This file is
 * the net for both halves:
 *
 * - Every extension routed to this runner (`KIND_EXTENSIONS` jsts/css/html,
 *   all three reaching it through dispatch `appliesTo` since #2248) is
 *   either served or carries a recorded reason.
 * - Every extension `canHandle` admits resolves a real grammar on the addon
 *   that actually loaded — the "admitted then silently skipped" shape.
 * - Every catalog language with enabled rules is classified: served by napi,
 *   or recorded as ast-grep LSP/CLI-only.
 * - The admitted-but-unparseable case leaves a degradation record.
 *
 * The served set is never asserted from a list — it is read back out of the
 * loaded addon through `canHandle`/`getLang`/`ruleLanguageForFile`, the same
 * three functions the runner and the project scanner call.
 */

import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as napi from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import type { AstGrepNapi } from "../../../../clients/deps/ast-grep-napi.js";
import { loadYamlRulesUncached } from "../../../../clients/dispatch/runners/yaml-rule-parser.js";
import { KIND_EXTENSIONS } from "../../../../clients/file-kinds.js";
import { getAstGrepRuleSources } from "../../../../clients/sgconfig.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import { assertNonEmptyScan } from "../../../support/sweep-kit.js";
import {
	firedRuleIds,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

const DEGRADATION_KIND = "ast-grep-napi-language-unavailable";

/**
 * Every extension that can reach this runner: `jsts` through dispatch
 * (`appliesTo`), plus the `css`/`html` kinds the project scanner hands it.
 * Read out of the registry the issue names as the single source of truth, so
 * a new extension registered there lands in this sweep automatically.
 */
const ROUTED_EXTENSIONS = [
	...new Set([
		...KIND_EXTENSIONS.jsts,
		...KIND_EXTENSIONS.css,
		...KIND_EXTENSIONS.html,
	]),
].sort();

const sampleFileFor = (ext: string): string => path.join("src", `sample${ext}`);

/**
 * Routed extensions deliberately left out of the in-process matrix, each with
 * its reason — the declared-exception half of the coverage contract, in the
 * same shape `tests/config/sweep-floor-coverage.test.ts` uses. A newly
 * registered `KIND_EXTENSIONS` entry that lands in neither this map nor the
 * matrix reds the sweep instead of joining it silently.
 */
const DECLARED_UNSERVED_EXTENSIONS: Readonly<Record<string, string>> = {
	".vue": "single-file component; @ast-grep/napi bundles no vue grammar",
	".svelte": "single-file component; @ast-grep/napi bundles no svelte grammar",
	".less": "the bundled css grammar is not validated against less syntax",
	".sass": "the bundled css grammar is not validated against indented sass",
	".scss": "the bundled css grammar is not validated against scss syntax",
};

/** Rule ids per lowercased `language:` across the shipped ast-grep catalog. */
function catalogRuleIdsByLanguage(): Map<string, string[]> {
	const byLanguage = new Map<string, string[]>();
	for (const source of getAstGrepRuleSources(process.cwd())) {
		for (const rule of loadYamlRulesUncached(source.dir)) {
			const language = rule.language?.toLowerCase();
			if (!language) continue;
			const ids = byLanguage.get(language) ?? [];
			ids.push(rule.id);
			byLanguage.set(language, ids);
		}
	}
	return byLanguage;
}

let sgModule: AstGrepNapi;
let catalog: Map<string, string[]>;

/**
 * The effective in-process language set, derived from the addon that actually
 * loaded rather than declared about it: an extension counts as served only
 * when the production admission gate lets it through AND the production
 * grammar lookup returns something for it.
 */
function servedRuleLanguages(): Set<string> {
	const served = new Set<string>();
	for (const ext of ROUTED_EXTENSIONS) {
		const file = sampleFileFor(ext);
		if (!napi.canHandle(file)) continue;
		if (!napi.getLang(file, sgModule)) continue;
		const language = napi.ruleLanguageForFile(file);
		if (language) served.add(language);
	}
	return served;
}

function routedLanguagesWithoutRules(
	ruleCatalog: ReadonlyMap<string, readonly string[]>,
): string[] {
	return [...servedRuleLanguages()]
		.filter((language) => !ruleCatalog.has(language))
		.sort();
}

beforeAll(async () => {
	// Fail loudly rather than let every assertion below pass on an addon that
	// never loaded — the whole point of this file is that a missing grammar is
	// invisible unless something says so.
	const loaded = await napi.loadSg();
	if (!loaded) {
		throw new Error(
			"@ast-grep/napi did not load; every language-coverage assertion here would be vacuous",
		);
	}
	sgModule = loaded;
	catalog = catalogRuleIdsByLanguage();
	// Population floors, measured 2026-08-26: 17 catalog languages over 470
	// enabled rules (223 napi-served, 247 ast-grep LSP/CLI-only), and 16 routed
	// extensions. Half-population, so the sweep fails on a broken loader
	// instead of reading clean on nothing.
	assertNonEmptyScan("ast-grep catalog languages", catalog.size, 9);
	assertNonEmptyScan("routed runner extensions", ROUTED_EXTENSIONS.length, 8);
});

describe("napi in-process language matrix (#2215)", () => {
	it("exposes the six grammars the addon actually bundles, and no others", () => {
		// An independent oracle for the matrix: read the addon's OWN surface
		// instead of re-deriving it from the table under test. A grammar
		// accessor is exactly the five-method object below; the module itself
		// (and its `default`/`module.exports` aliases) carries `parse` too but
		// has sixteen keys, so the shape comparison excludes it. `Lang` cannot
		// serve as the oracle — the native binding exports it as an empty
		// object at runtime, so the enum in @ast-grep/napi/types/lang.d.ts is
		// type-only. Recorded from a real 0.45.1 load on 2026-08-26; reds when
		// a napi bump moves the bundled set either way.
		const accessorKeys = "findInFiles,kind,parse,parseAsync,pattern";
		const grammarExports = Object.entries(
			sgModule as unknown as Record<string, object | undefined>,
		)
			.filter(
				([, value]) =>
					!!value &&
					typeof value === "object" &&
					Object.keys(value).sort().join(",") === accessorKeys,
			)
			.map(([name]) => name)
			.sort();
		expect(grammarExports).toEqual(["css", "html", "js", "jsx", "ts", "tsx"]);
	});

	it("resolves a real grammar for every extension it admits", () => {
		// The silent-skip shape itself: `canHandle` says yes, `getLang` then
		// hands the caller undefined and every caller reads that as "nothing to
		// do". Nothing may sit in this list.
		const admittedButUnserved = (addon: AstGrepNapi): string[] =>
			ROUTED_EXTENSIONS.filter(
				(ext) =>
					napi.canHandle(sampleFileFor(ext)) &&
					!napi.getLang(sampleFileFor(ext), addon),
			);
		expect(admittedButUnserved(sgModule)).toEqual([]);
		// Other direction, so the empty list above cannot be empty because the
		// detector is broken: an addon that stops shipping one grammar must be
		// caught, and caught for every extension that grammar covered.
		const addonMissingTs = {
			...sgModule,
			ts: undefined,
		} as unknown as AstGrepNapi;
		expect(admittedButUnserved(addonMissingTs)).toEqual([
			".cts",
			".mts",
			".ts",
		]);
	});

	it("classifies every routed extension as served or recorded-unserved", () => {
		const unclassified = ROUTED_EXTENSIONS.filter(
			(ext) =>
				!napi.canHandle(sampleFileFor(ext)) &&
				!(ext in DECLARED_UNSERVED_EXTENSIONS),
		);
		expect(unclassified).toEqual([]);
	});

	it("records no exclusion reason for an extension it does serve", () => {
		// The other direction: a stale reason for a grammar that has since
		// arrived would read as a documented gap that no longer exists.
		const contradictory = Object.keys(DECLARED_UNSERVED_EXTENSIONS)
			.filter((ext) => napi.canHandle(sampleFileFor(ext)))
			.sort();
		expect(contradictory).toEqual([]);
	});
});

describe("catalog language delivery coverage (#2215)", () => {
	it("classifies every catalog language that has enabled rules", () => {
		const served = servedRuleLanguages();
		const lspOnly = new Set(napi.AST_GREP_LSP_ONLY_RULE_LANGUAGES ?? []);
		const unclassified = [...catalog.keys()]
			.filter((language) => !served.has(language) && !lspOnly.has(language))
			.sort();
		expect(unclassified).toEqual([]);
	});

	it("carries no delivery reason for a language with no shipped rules", () => {
		const stale = (napi.AST_GREP_LSP_ONLY_RULE_LANGUAGES ?? [])
			.filter((language) => !catalog.has(language))
			.sort();
		expect(stale).toEqual([]);
	});

	it("ships enabled rules for every napi-routed language (#2325)", () => {
		expect(routedLanguagesWithoutRules(catalog)).toEqual([]);

		// Mutation probe: removing HTML from the enabled catalog must expose the
		// routed lane instead of letting an empty language report as covered.
		const withoutHtml = new Map(catalog);
		withoutHtml.delete("html");
		expect(routedLanguagesWithoutRules(withoutHtml)).toEqual(["html"]);
	});

	it("never claims a napi-served language delivers by LSP/CLI only", () => {
		const served = servedRuleLanguages();
		const contradictory = (napi.AST_GREP_LSP_ONLY_RULE_LANGUAGES ?? [])
			.filter((language) => served.has(language))
			.sort();
		expect(contradictory).toEqual([]);
	});

	it("routes a served, an excluded, and an unknown language distinctly", () => {
		// Two-direction probe on the helper that annotates the skip telemetry:
		// a language it must call napi, one it must call LSP/CLI, and one it
		// must refuse to classify rather than quietly absorb.
		expect(napi.deliveryRouteForRuleLanguage("javascript")).toBe("napi");
		expect(napi.deliveryRouteForRuleLanguage("go")).toBe("ast-grep-lsp-cli");
		expect(napi.deliveryRouteForRuleLanguage("zig")).toBe("unclassified");
	});
});

describe("module-flavored jsts extensions run the catalog (#2215)", () => {
	let env: RealRunnerEnv;
	beforeAll(() => {
		env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
	});
	afterAll(() => env.cleanup());

	it.each([["sample.mjs"], ["sample.cjs"]])(
		"fires a JavaScript rule on %s",
		async (fixture) => {
			const { ctx } = env.addFile(fixture, "const out = eval(input);\n");
			const result = await napi.default.run(ctx);
			expect(firedRuleIds(result)).toContain("no-global-eval-js");
		},
		30_000,
	);

	it.each([["sample.mts"], ["sample.cts"]])(
		"fires a TypeScript rule on %s",
		async (fixture) => {
			const { ctx } = env.addFile(
				fixture,
				"const r = items.map(x => { x + 1 });\n",
			);
			const result = await napi.default.run(ctx);
			expect(firedRuleIds(result)).toContain("array-callback-return");
		},
		30_000,
	);

	it("still refuses the single-file-component extensions napi cannot parse", () => {
		expect(napi.canHandle("App.vue")).toBe(false);
		expect(napi.canHandle("App.svelte")).toBe(false);
		expect(napi.ruleLanguageForFile("App.vue")).toBeUndefined();
	});
});

describe("html edits run the enabled html catalog (#2325)", () => {
	let env: RealRunnerEnv;
	beforeAll(() => {
		env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
	});
	afterAll(() => env.cleanup());

	it("reports a plaintext HTTP link through the napi runner", async () => {
		const { ctx } = env.addFile(
			"index.html",
			'<a href="http://example.com">Example</a>\n',
		);
		const result = await napi.default.run(ctx);
		expect(firedRuleIds(result)).toContain("plaintext-http-link-html");
	});
});

describe("admitted-but-unparseable language is recorded (#2215)", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});
	afterEach(() => {
		resetDegradationLedger();
	});

	function languageGap() {
		return getDegradationSummary().find(
			(group) => group.kind === DEGRADATION_KIND,
		);
	}

	it("records once when the loaded addon has no grammar for an admitted file", () => {
		// The drift this guard exists for: a napi build that stops shipping a
		// grammar the matrix still claims. Pre-#2215 `getLang` returned
		// undefined here and nothing anywhere said the css rules had stopped
		// running.
		const addonWithoutCss = {
			ts: {},
			tsx: {},
			js: {},
			html: {},
		} as unknown as AstGrepNapi;

		expect(napi.getLang("theme.css", addonWithoutCss)).toBeUndefined();
		expect(napi.getLang("other.css", addonWithoutCss)).toBeUndefined();

		const gap = languageGap();
		expect(gap?.count).toBe(1);
		expect(gap?.latestReasons[0]?.subject).toBe("css");
	});

	it("records nothing for an extension the matrix never admitted", () => {
		expect(napi.getLang("main.go", sgModule)).toBeUndefined();
		expect(languageGap()).toBeUndefined();
	});

	// #2248 acceptance criterion 2: the kinds `appliesTo` declares must equal the
	// kinds the napi matrix actually serves, derived from `canHandle` over the
	// registered extensions -- not a hand-written list. Dropping a served kind
	// from `appliesTo` (the pre-#2248 defect) or declaring an unserved one reds
	// this without any per-kind fixture.
	it("appliesTo matches the kinds the napi matrix serves (#2248)", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/ast-grep-napi.js")
		).default;
		const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
		const servedKinds = Object.entries(KIND_EXTENSIONS)
			.filter(([, exts]) => exts.some((ext) => napi.canHandle("probe" + ext)))
			.map(([kind]) => kind)
			.sort(byCodeUnit);
		expect([...runner.appliesTo].sort(byCodeUnit)).toEqual(servedKinds);
	});
});
