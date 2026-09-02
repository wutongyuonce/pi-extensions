// Regression guard for #2347: the napi runner had no embedded-`<script>`
// coverage where the ast-grep LSP/CLI did. The ast-grep 0.45.1 CLI resolves
// every HTML `<script>` body as JavaScript and runs `language: JavaScript`
// rules inside it (verified by direct CLI repro: a `no-global-eval-js`
// violation inside a script block fires at its file line/column). The napi
// fallback simply skipped every JS/TS/TSX rule as a `language` mismatch on an
// HTML file, returning zero embedded findings while the LSP returned hundreds.
//
// The fix reparses each inline script body with the addon's js grammar in
// `evaluateAstGrepRules` and runs `language: JavaScript` rules there,
// translating findings back to file coordinates. This file drives the REAL
// seams: the loaded addon, the real html and js grammars, the real bundled
// rule catalog, a real `.html` fixture on disk, and (for telemetry pins) the
// real latency sink and the real degradation ledger.
//
// Review-round 2 additions (#2347 review F1-F3): UTF-16 position mapping,
// the bounded script budget, and bounded degradation records for the silent
// failure modes.

import * as fs from "node:fs";
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
import astGrepNapiRunner, {
	collectHtmlScriptInjections,
	evaluateAstGrepRules,
	loadSg,
	MAX_SCRIPT_BODIES_EVALUATED,
	MAX_SCRIPT_BODY_BYTES_EVALUATED,
	resetAstGrepUnsupportedLanguageLog,
} from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../../../../clients/dispatch/types.js";
import type { AstGrepNapi } from "../../../../clients/deps/ast-grep-napi.js";
import { getGlobalPiLensDir } from "../../../../clients/file-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import {
	linesFor,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

let sgModule: AstGrepNapi;
let env: RealRunnerEnv;

beforeAll(async () => {
	env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
	// Fail loudly rather than let every assertion pass on an addon that never
	// loaded — a missing native binding turns "does not fire" into a vacuous
	// green (the #448 rule).
	const loaded = await loadSg();
	if (!loaded) {
		throw new Error(
			"@ast-grep/napi did not load; every embedded-script assertion here would be vacuous",
		);
	}
	sgModule = loaded;
});

afterAll(() => env.cleanup());

afterEach(() => {
	resetAstGrepUnsupportedLanguageLog();
	resetDegradationLedger();
});

/** Evaluate against a real on-disk `.html` fixture through the shared seam. */
function evaluateHtml(content: string): Diagnostic[] {
	const { ctx } = env.addFile("embed.html", content, { kind: "html" });
	const rootNode = sgModule.html.parse(content).root();
	return evaluateAstGrepRules(ctx.filePath, rootNode, env.cwd, "html", {
		content,
		sgModule,
		log: () => {},
	});
}

/** Collection-only convenience returning the parsed injections. */
function collected(content: string) {
	const rootNode = sgModule.html.parse(content).root();
	return collectHtmlScriptInjections(rootNode, sgModule);
}

describe("embedded <script> coverage (#2347)", () => {
	it("runs a language: JavaScript rule inside an inline script (red on pre-fix)", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<head></head>",
			"<body>",
			"<script>",
			"function run(code) {",
			"  eval(code);",
			"}",
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		const finding = diagnostics.find((d) => d.rule === "no-global-eval-js");

		expect(finding).toBeDefined();
		// File-absolute, not body-relative: `eval` sits on line 7 of the file
		// (0-based body line 2 inside the script body), column 3.
		expect(finding?.line).toBe(7);
		expect(finding?.column).toBe(3);
	});

	it("translates a same-line inline script back to the file column", () => {
		const content = '<!doctype html>\n<script>eval("x=1")</script>\n';

		const diagnostics = evaluateHtml(content);
		const finding = diagnostics.find((d) => d.rule === "no-global-eval-js");

		expect(finding).toBeDefined();
		// `eval` begins after the 8-character `<script>` tag on line 2.
		expect(finding?.line).toBe(2);
		expect(finding?.column).toBe(9);
	});

	it("runs JS rules in every script block with per-block positions", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<head></head>",
			"<body>",
			"<script>",
			'  eval("a");',
			"</script>",
			"<script>",
			'  eval("b");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const lines = linesFor(evaluateHtml(content), "no-global-eval-js");

		expect(lines).toEqual([6, 9]);
	});

	it("injects a src-bearing script body, matching the CLI (unconditional)", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			'<script src="extern.js">',
			'  eval("x");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		expect(diagnostics.some((d) => d.rule === "no-global-eval-js")).toBe(true);
	});

	it("injects a type=application/json body, matching the CLI (type-agnostic)", () => {
		// Verified against the ast-grep 0.45.1 CLI: a duplicate-key JSON object
		// inside a `type="application/json"` script fires `no-dupe-keys-js`.
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			'<script type="application/json">',
			'{"a": 1, "a": 2}',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		const finding = diagnostics.find((d) => d.rule === "no-dupe-keys-js");
		expect(finding).toBeDefined();
		expect(finding?.line).toBe(5);
		expect(finding?.column).toBe(2);
	});

	it("does not run TypeScript rules inside scripts, matching the CLI", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>",
			'console.log("hi");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const ruleIds = new Set(evaluateHtml(content).map((d) => d.rule));

		// The JS twin fires; the TypeScript twin (`no-console-except-error`)
		// must not — ast-grep 0.45.1 runs only `language: JavaScript` rules
		// inside script bodies.
		expect(ruleIds.has("no-console-except-error-js")).toBe(true);
		expect(ruleIds.has("no-console-except-error")).toBe(false);
	});

	it("produces no embedded finding for an HTML file without scripts", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			'<body><div class="btn">Go</div></body>',
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		expect(diagnostics.some((d) => d.rule === "no-global-eval-js")).toBe(false);

		// The skip path (not injection) is the countable state.
		expect(collected(content).injections).toHaveLength(0);
	});

	it("drives the full runner against the real fixture", async () => {
		const { ctx } = env.addFile(
			"embed-runner.html",
			[
				"<!doctype html>",
				"<html>",
				"<body>",
				"<script>",
				'  eval("x");',
				"</script>",
				"</body>",
				"</html>",
			].join("\n"),
			{ kind: "html" },
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(result.diagnostics.some((d) => d.rule === "no-global-eval-js")).toBe(
			true,
		);
		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
	});
});

describe("embedded <script> coordinates are UTF-16 (#2347 review F1)", () => {
	// @ast-grep/napi's `Pos.index`/`column` are UTF-16 code-unit offsets. The
	// first review round mixed them with a UTF-8 byte line table, shifting every
	// coordinate that follows a multibyte character by
	// (utf8Bytes - utf16Units) per multibyte char on earlier lines. Each case
	// below pins a finding's exact file line/column with multibyte text before
	// and inside the script.

	it("maps a finding after a multibyte char on the previous line (é)", () => {
		// `é` is 1 UTF-16 unit / 2 UTF-8 bytes. A byte-based table reports
		// column 8 here; the UTF-16 table reports the correct 9.
		const content = '<p>é</p>\n<script>eval("x")</script>\n';

		const finding = evaluateHtml(content).find(
			(d) => d.rule === "no-global-eval-js",
		);
		expect(finding).toBeDefined();
		expect(finding?.line).toBe(2);
		expect(finding?.column).toBe(9);
	});

	it("maps a finding after an emoji on the previous line (surrogate pair)", () => {
		// `😀` is 2 UTF-16 units / 4 UTF-8 bytes — the widest divergence. A
		// byte-based table reports column 7 here.
		const content = '<p>😀</p>\n<script>eval("x")</script>\n';

		const finding = evaluateHtml(content).find(
			(d) => d.rule === "no-global-eval-js",
		);
		expect(finding).toBeDefined();
		expect(finding?.line).toBe(2);
		expect(finding?.column).toBe(9);
	});

	it("maps a finding after multibyte text INSIDE the script body (café)", () => {
		const content = [
			"<script>",
			'const café = "ok";',
			'eval("x");',
			"</script>",
			"",
		].join("\n");

		const finding = evaluateHtml(content).find(
			(d) => d.rule === "no-global-eval-js",
		);
		expect(finding).toBeDefined();
		// `eval` opens file line 3, column 1. `é` is 2 UTF-8 bytes but 1 UTF-16
		// unit, so the byte table shifts `eval`'s line2-start to byte 29 and
		// mis-resolves the match to line 2, column 20; the UTF-16 table lands
		// exactly (line 3, column 1).
		expect(finding?.line).toBe(3);
		expect(finding?.column).toBe(1);
	});

	it("reports UTF-16 start indexes from the collector", () => {
		const content = "<p>é</p>\n<script>const a = 1;</script>\n";
		const { injections } = collected(content);
		expect(injections).toHaveLength(1);
		// 9 UTF-16 units to the `<script>` tag's end (é counts 1, not 2).
		expect(injections[0].startIndex).toBe(17);
	});
});

describe("embedded <script> evaluation budget (#2347 review F2)", () => {
	it("caps the number of script bodies evaluated and counts the truncation", () => {
		const scripts: string[] = [];
		for (let i = 0; i < MAX_SCRIPT_BODIES_EVALUATED + 6; i++) {
			scripts.push(`<script>const v${i} = ${i};</script>`);
		}
		const content = scripts.join("\n");

		const result = collected(content);

		expect(result.injections).toHaveLength(MAX_SCRIPT_BODIES_EVALUATED);
		expect(result.scriptElementCount).toBe(MAX_SCRIPT_BODIES_EVALUATED + 6);
		expect(result.bodiesEvaluated).toBe(MAX_SCRIPT_BODIES_EVALUATED);
		expect(result.truncatedBodies).toBe(6);
		expect(result.parseFailures).toBe(0);
	});

	it("caps the cumulative script-body bytes and reports the truncation", () => {
		// Two bodies each just under the byte cap sum past it; only the first
		// is evaluated. Body sizes derive from the cap constant so the pin
		// survives a future cap change without going silent.
		const bigBody = `const s = '${"a".repeat(
			Math.floor(MAX_SCRIPT_BODY_BYTES_EVALUATED * 0.6),
		)}';`;
		const content = `<script>${bigBody}</script>\n<script>${bigBody}</script>\n`;

		const result = collected(content);

		expect(result.scriptElementCount).toBe(2);
		expect(result.bodiesEvaluated).toBe(1);
		expect(result.truncatedBodies).toBe(1);
		expect(result.injections).toHaveLength(1);
	});

	it("keeps evaluating the in-budget scripts and records the budget cut", () => {
		const scripts: string[] = [];
		for (let i = 0; i < MAX_SCRIPT_BODIES_EVALUATED + 6; i++) {
			scripts.push(`<script>const v${i} = ${i};</script>`);
		}
		// Put a guaranteed eval at the front so at least one finding must fire.
		const content = ['<script>eval("budgeted");</script>', ...scripts].join(
			"\n",
		);

		const diagnostics = evaluateHtml(content);
		expect(diagnostics.some((d) => d.rule === "no-global-eval-js")).toBe(true);

		const summary = getDegradationSummary();
		const budgetGroup = summary.find(
			(g) => g.kind === "ast-grep-napi-html-script-budget",
		);
		expect(budgetGroup).toBeDefined();
		expect(budgetGroup?.count).toBe(1);
		const reason = budgetGroup?.latestReasons[0]?.reason ?? "";
		expect(reason).toContain("64/71 bodies evaluated");
	});

	it("omits a single oversized FIRST body and records the budget cut (red on pre-fix, #2347 F4)", () => {
		// The reviewer's HIGH finding: the first body used to bypass the byte
		// cap, so a single ~1 MiB inline body under the file gate ran the whole
		// catalog synchronously (measured 19.5 s on this seam). The byte cap now
		// binds every body, including the first; the omission follows the
		// existing budget-record path.
		const oversized = `const s = '${"a".repeat(
			MAX_SCRIPT_BODY_BYTES_EVALUATED + 4096,
		)}';`;
		const content = `<script>${oversized}</script>\n`;

		const result = collected(content);
		expect(result.scriptElementCount).toBe(1);
		expect(result.bodiesEvaluated).toBe(0);
		expect(result.truncatedBodies).toBe(1);
		expect(result.injections).toHaveLength(0);

		const diagnostics = evaluateHtml(content);
		expect(diagnostics).toHaveLength(0);

		const summary = getDegradationSummary();
		const budgetGroup = summary.find(
			(g) => g.kind === "ast-grep-napi-html-script-budget",
		);
		expect(budgetGroup).toBeDefined();
		expect(budgetGroup?.count).toBe(1);
		const reason = budgetGroup?.latestReasons[0]?.reason ?? "";
		expect(reason).toContain("0/1 bodies evaluated");
	});

	it("still evaluates a sole body under the byte cap (boundary preserved)", () => {
		// The hard first-body cap must not over-restrict: a single body that
		// fits is evaluated in full, and no budget record is emitted.
		const inBudget = `const s = '${"a".repeat(
			MAX_SCRIPT_BODY_BYTES_EVALUATED - 4096,
		)}';`;
		const content = `<script>${inBudget}</script>\n`;

		const result = collected(content);
		expect(result.scriptElementCount).toBe(1);
		expect(result.bodiesEvaluated).toBe(1);
		expect(result.truncatedBodies).toBe(0);
		expect(result.injections).toHaveLength(1);

		const diagnostics = evaluateHtml(content);
		expect(getDegradationSummary()).toEqual([]);
		expect(diagnostics).toEqual([]);
	});
});

describe("embedded <script> failure records (#2347 review F3)", () => {
	// The addon is a native process boundary, so these failure modes cannot be
	// produced by the real installed addon (it always has a `js` grammar, and a
	// real parse rarely throws). The ledger assertions exercise the REAL
	// emission seam against a deliberately broken addon/root shape — the same
	// boundary-mock legitimacy as ast-grep-napi-language-coverage.test.ts's
	// `addonWithoutCss`.

	it("records a missing js grammar instead of silently dropping coverage", () => {
		const content = '<script>eval("x")</script>\n';
		const rootNode = sgModule.html.parse(content).root();
		const addonWithoutJs = {
			js: undefined,
		} as unknown as AstGrepNapi;

		const collection = collectHtmlScriptInjections(rootNode, addonWithoutJs);
		expect(collection.missingJsGrammar).toBe(true);
		expect(collection.injections).toEqual([]);

		const { ctx } = env.addFile("no-js-grammar.html", content, {
			kind: "html",
		});
		evaluateAstGrepRules(ctx.filePath, rootNode, env.cwd, "html", {
			content,
			sgModule: addonWithoutJs,
			log: () => {},
		});

		const summary = getDegradationSummary();
		const group = summary.find(
			(g) => g.kind === "ast-grep-napi-html-js-grammar-missing",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
	});

	it("records an HTML script-element scan failure instead of silencing it", () => {
		const failingRoot = {
			findAll: () => {
				throw new Error("boost: script_element scan failed");
			},
		};
		const collection = collectHtmlScriptInjections(
			failingRoot as never,
			sgModule,
		);
		expect(collection.htmlScanFailure).toBe(true);
		expect(collection.injections).toEqual([]);

		const { ctx } = env.addFile("scan-failure.html", "<p>hi</p>\n", {
			kind: "html",
		});
		evaluateAstGrepRules(ctx.filePath, failingRoot as never, env.cwd, "html", {
			content: "<p>hi</p>\n",
			sgModule,
			log: () => {},
		});

		const summary = getDegradationSummary();
		const group = summary.find(
			(g) => g.kind === "ast-grep-napi-html-script-scan-failed",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
	});

	it("counts script bodies the JS grammar refuses to parse", () => {
		const content = "<script>a();</script>\n<script>b();</script>\n";
		const rootNode = sgModule.html.parse(content).root();
		const throwingAddon = {
			js: {
				parse: () => {
					throw new Error("js grammar refused");
				},
			},
		} as unknown as AstGrepNapi;

		const collection = collectHtmlScriptInjections(rootNode, throwingAddon);
		expect(collection.parseFailures).toBe(2);
		expect(collection.injections).toEqual([]);

		const { ctx } = env.addFile("parse-refusals.html", content, {
			kind: "html",
		});
		evaluateAstGrepRules(ctx.filePath, rootNode, env.cwd, "html", {
			content,
			sgModule: throwingAddon,
			log: () => {},
		});

		const summary = getDegradationSummary();
		const group = summary.find(
			(g) => g.kind === "ast-grep-napi-html-script-parse-failed",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		const metadata = group?.latestReasons[0]?.reason ?? "";
		expect(metadata).toContain("2 of 2 script bodies refused to parse");
	});
});

describe("collectHtmlScriptInjections (#2347)", () => {
	it("extracts each script body with its file UTF-16 start index", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>const a = 1;</script>",
			"<script>const b = 2;</script>",
			"</body>",
			"</html>",
		].join("\n");
		const { injections, scriptElementCount } = collected(content);

		expect(scriptElementCount).toBe(2);
		expect(injections).toHaveLength(2);
		expect(injections[0].body).toBe("const a = 1;");
		expect(injections[1].body).toBe("const b = 2;");
		// UTF-16 indexes strictly increasing and inside the file's code units.
		expect(injections[0].startIndex).toBeLessThan(injections[1].startIndex);
		expect(injections[1].startIndex).toBeLessThan(content.length);
	});

	it("skips whitespace-only and empty script bodies", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>   </script>",
			"<script></script>",
			"</body>",
			"</html>",
		].join("\n");
		const result = collected(content);
		expect(result.injections).toHaveLength(0);
		// The raw element count still names both <script> tags.
		expect(result.scriptElementCount).toBe(2);
	});

	it("handles an HTML file with no script elements at all", () => {
		const content = "<!doctype html>\n<html><body>plain</body></html>\n";
		const result = collected(content);
		expect(result.injections).toHaveLength(0);
		expect(result.scriptElementCount).toBe(0);
		expect(result.truncatedBodies).toBe(0);
		expect(result.parseFailures).toBe(0);
	});
});

describe("embedded-script skip-record observability (#2347)", () => {
	// The real latency sink (hermetic worker PI_LENS_HOME) — the #1742
	// real-sinks rule. Scoped PI_LENS_TEST_MODE=0 turns the latency logger's
	// test-mode no-op off for this test only.
	let previousTestMode: string | undefined;
	let flushLatencyLog: (() => Promise<void>) | undefined;

	beforeEach(() => {
		previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		fs.rmSync(path.join(getGlobalPiLensDir(), "latency.log"), {
			force: true,
		});
	});
	afterEach(async () => {
		if (flushLatencyLog) await flushLatencyLog();
		flushLatencyLog = undefined;
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
	});

	async function readSkippedRecord(): Promise<
		Record<string, { htmlInlineScriptCount?: number }>
	> {
		vi.resetModules();
		const latencyLogger = await import("../../../../clients/latency-logger.js");
		flushLatencyLog = latencyLogger.flushLatencyLog;
		await latencyLogger.flushLatencyLog();
		const logPath = path.join(getGlobalPiLensDir(), "latency.log");
		const records = fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const record = records.find(
			(entry) => entry.phase === "astgrep_napi_unsupported_rules_skipped",
		);
		return (
			(
				record?.metadata as {
					skippedByLanguage?: Record<
						string,
						{ htmlInlineScriptCount?: number }
					>;
				}
			)?.skippedByLanguage ?? {}
		);
	}

	it("marks a scriptless HTML file's javascript mismatch with htmlInlineScriptCount 0", async () => {
		const { filePath } = env.addFile(
			"scriptless.html",
			"<!doctype html>\n<html><body>plain</body></html>\n",
			{ kind: "html" },
		);
		const rootNode = sgModule.html
			.parse("<!doctype html>\n<html><body>plain</body></html>\n")
			.root();

		evaluateAstGrepRules(filePath, rootNode, env.cwd, "html", {
			sgModule,
			content: "<!doctype html>\n<html><body>plain</body></html>\n",
			log: () => {},
			unsupportedLanguageLog: new Set<string>(),
		});

		const skipped = await readSkippedRecord();
		expect(skipped["mismatch:javascript->html"]?.htmlInlineScriptCount).toBe(0);
	});

	it("emits javascript->html mismatch only when no script ran, and counts scripts otherwise", async () => {
		const withScripts = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>",
			'  eval("x");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");
		const { filePath } = env.addFile("with-scripts.html", withScripts, {
			kind: "html",
		});
		const rootNode = sgModule.html.parse(withScripts).root();

		evaluateAstGrepRules(filePath, rootNode, env.cwd, "html", {
			sgModule,
			content: withScripts,
			log: () => {},
			unsupportedLanguageLog: new Set<string>(),
		});

		const skipped = await readSkippedRecord();
		// JS rules RAN inside the script, so no mismatch entry for javascript->html.
		expect(skipped["mismatch:javascript->html"]).toBeUndefined();
		// TS/TSX rules still mismatch, and the record names the script count.
		const ts = skipped["mismatch:typescript->html"];
		expect(ts).toBeDefined();
		expect(ts.htmlInlineScriptCount).toBe(1);
		expect(skipped["mismatch:tsx->html"]?.htmlInlineScriptCount).toBe(1);
	});
});
