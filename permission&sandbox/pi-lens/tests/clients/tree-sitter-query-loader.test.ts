import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// #2626 review round 2, F4 pattern, extended: `getBundledQueriesRootHealth`
// (#2636 review F6's memo) is called by `ruleFilesForLanguage` as a SAME-FILE
// internal reference, not a namespace-import call — empirically confirmed
// `vi.spyOn(moduleNamespace, "getBundledQueriesRootHealth")` does NOT
// intercept that internal call (unlike `clients/cache/rule-cache.ts`'s
// CROSS-module import of the same function, spied successfully in
// `rule-cache.test.ts`). Exercising the real "bundled root gone" path here
// therefore mocks `node:fs`'s `readdirSync` for the ONE real, known
// `BUNDLED_QUERIES_ROOT` path, delegating every other call (this file's own
// temp rule dirs) to the real implementation.
const actualFsRef = vi.hoisted(() => {
	return {
		readdirSync: undefined as unknown as typeof import("node:fs").readdirSync,
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	actualFsRef.readdirSync = actual.readdirSync;
	return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

import * as fs from "node:fs";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetBundledQueriesRootHealthForTests,
	BUNDLED_QUERIES_ROOT,
	getQueryLanguageKey,
	isDisabledQueryFilePath,
	queriesForLanguage,
	ruleFilesForLanguage,
	ruleSourceLanguages,
	type TreeSitterQuery,
	TreeSitterQueryLoader,
} from "../../clients/tree-sitter-query-loader.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeRule(root: string, relPath: string, content: string): void {
	const filePath = path.join(root, relPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function makeTempRulesRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-query-loader-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

describe("tree-sitter query loader metadata parsing", () => {
	it("parses cwe/owasp/confidence in inline arrays", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/meta-inline.yml",
			`id: meta-inline
name: Meta Inline
severity: warning
category: security
language: typescript
message: test
query: |
  (identifier) @X
metavars: [X]
cwe: [CWE-327, CWE-330]
owasp: [A02]
confidence: high
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-inline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-327", "CWE-330"]);
		expect(query?.owasp).toEqual(["A02"]);
		expect(query?.confidence).toBe("high");
	});

	it("parses multiline arrays with comments and quoted confidence", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python/meta-multiline.yml",
			`id: meta-multiline
name: Meta Multiline
severity: warning
category: security
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
cwe:
  - CWE-89 # SQLi
  - CWE-22
owasp:
  - A03
  - A01
confidence: "medium"
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-multiline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-89", "CWE-22"]);
		expect(query?.owasp).toEqual(["A03", "A01"]);
		expect(query?.confidence).toBe("medium");
	});

	it("preserves tree-sitter predicates in query blocks", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/predicate-preserve.yml",
			`id: predicate-preserve
name: Predicate Preserve
severity: warning
category: correctness
language: typescript
message: test
query: |
  (call_expression
    function: (member_expression
      object: (identifier) @OBJ
      property: (property_identifier) @FN))
  (#eq? @OBJ "Math")
  (#eq? @FN "random")
metavars:
  - OBJ
  - FN
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("predicate-preserve");
		expect(query).toBeTruthy();
		expect(query?.query).toContain('#eq? @OBJ "Math"');
		expect(query?.query).toContain('#eq? @FN "random"');
	});

	it("loads disabled-directory rules for tests but excludes them from production language queries", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python-disabled/disabled-example.yml",
			`id: disabled-example
name: Disabled Example
severity: warning
category: correctness
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(loader.getAllQueries().map((q) => q.id)).toContain(
			"disabled-example",
		);
		expect(
			loader.getQueriesForLanguage("python").map((q) => q.id),
		).not.toContain("disabled-example");
	});

	it("detects disabled query paths independent of path separator", () => {
		expect(getQueryLanguageKey("typescript-disabled")).toBe("typescript");
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript-disabled/ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules\\tree-sitter-queries\\typescript-disabled\\ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript/console-statement.yml",
			),
		).toBe(false);
	});
});

describe("scalar values drop trailing YAML comments", () => {
	it("keeps a commented post_filter usable as a filter name", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/commented-scalar.yml",
			`id: commented-scalar
name: Commented Scalar
severity: warning
category: quality
language: typescript
message: "uses # in a quoted message"
post_filter: not_in_test_block  # skip test blocks
query: |
  (identifier) @X
metavars: [X]
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("commented-scalar");
		// Carrying the comment into the name meant the filter never resolved and
		// the rule reported every raw match unfiltered.
		expect(query?.post_filter).toBe("not_in_test_block");
		expect(query?.message).toBe("uses # in a quoted message");
	});
});

// #3054: the hand-rolled line-regex scanner (its own inline-comment stripper,
// its own inline `[a, b]` array branch, its own multi-line `- item` branch,
// its own nested-object branch) is gone; `yaml.load` — the same real parser
// `clients/dispatch/runners/yaml-rule-parser.ts` already used for ast-grep
// rules (#206) — parses the whole document now. One fixture exercises every
// construct the deleted scanner special-cased, in the shape #3046 showed
// disagreeing: an inline array, a multi-line list, BOTH multi-line quote
// spellings (the exact defect: the inline-array branch unquoted, the
// multi-line branch didn't, so `console-statement.yml`'s quoted
// `ignore_paths` glob carried its quote marks and the #965 carve-out never
// matched a path), a nested object, and both an inline comment on an
// unquoted scalar and a literal `#` preserved inside a quoted one.
describe("fold onto js-yaml (#3054)", () => {
	it("parses inline arrays, multi-line lists in both quote spellings, nested objects, and inline/quoted comments in one document", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/all-constructs.yml",
			`id: all-constructs
name: All Constructs
severity: warning
category: correctness
language: typescript
message: "keeps a # inside a quoted string"
post_filter: not_in_test_block  # trailing comment stripped
query: |
  (identifier) @X
metavars: [X, Y]
tags:
  - alpha
  - beta
ignore_paths:
  - "scripts/**"
  - 'bin/**'
post_filter_params:
  KEY: "value"
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("all-constructs");
		expect(query).toBeTruthy();
		expect(query?.message).toBe("keeps a # inside a quoted string");
		expect(query?.post_filter).toBe("not_in_test_block");
		expect(query?.metavars).toEqual(["X", "Y"]);
		expect(query?.tags).toEqual(["alpha", "beta"]);
		expect(query?.ignore_paths).toEqual(["scripts/**", "bin/**"]);
		expect(query?.post_filter_params).toEqual({ KEY: "value" });
	});
});

// #3054 review F1: `yaml.load` throws on realistic authoring mistakes the
// deleted hand-rolled scanner tolerated (a colon in an unquoted scalar, a
// duplicate key, an unclosed quote, …), which widened the skip surface with
// no observability — the only sink was `dbg()`, gated behind `verbose`, and
// both production instantiations construct with the `verbose = false`
// default. A malformed rule must now leave a durable signal.
describe("malformed query files are recorded once per file (#3054 review F1)", () => {
	beforeEach(() => resetDegradationLedger());
	afterEach(() => resetDegradationLedger());

	function parseFailureGroup() {
		return getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-query-parse-failed",
		);
	}

	it("records a degradation for a rule file yaml.load rejects, even with verbose:false (the production default)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/broken-colon.yml",
			`id: broken-colon
name: Broken Colon
severity: warning
category: quality
language: typescript
message: some: unquoted colon breaks YAML
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader(); // verbose defaults to false
		await loader.loadQueries(root);

		expect(loader.getQueryById("broken-colon")).toBeUndefined();
		const group = parseFailureGroup();
		expect(group?.count).toBe(1);
		expect(
			group?.latestReasons.some((r) => r.subject.endsWith("broken-colon.yml")),
		).toBe(true);
	});

	it("records a degradation for a syntactically valid document with a mapping-valued query (#3054 review F2)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/mapping-query.yml",
			`id: mapping-query
name: Mapping Query
severity: warning
category: quality
language: typescript
message: forgot the block-scalar pipe
query:
  not: a string
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);

		// The old truthy-only check let this sail through as the literal
		// string "[object Object]"; the type-checked guard skips it instead.
		expect(loader.getQueryById("mapping-query")).toBeUndefined();
		const group = parseFailureGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.reason).toContain("'query'");
	});

	// #3070 N1: `loadQueries` short-circuits on `this.loaded && this.loadedRoot
	// === resolvedRoot` before `parseQueryFile` runs, so a memoized (no
	// `force`) return in a LATER session never re-parses and never replays the
	// `tree-sitter-query-parse-failed` record for this session's generation.
	// `handleSessionStart` -> `resetDegradationLedger()` clears the once-keys
	// every session, but the loader's shared client (`clients/tree-sitter-shared.ts:39`)
	// and its `loaded`/`loadedRoot` memo are deliberately kept across
	// sessions, so the SECOND session's health summary silently loses the row
	// the first session recorded — the exact "silently drops to zero" shape
	// `getBundledQueriesRootHealth` (this file, generation-keyed) already
	// solves correctly.
	it("replays the parse-failure record on a memoized (no-force) reload after a session boundary (#3070 N1)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/broken-colon.yml",
			`id: broken-colon
name: Broken Colon
severity: warning
category: quality
language: typescript
message: some: unquoted colon breaks YAML
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(parseFailureGroup()?.count).toBe(1);

		// Session boundary: handleSessionStart's resetDegradationLedger() call,
		// simulated directly. The loader instance itself is NOT recreated —
		// tree-sitter-shared.ts deliberately keeps the client across sessions.
		resetDegradationLedger();
		expect(parseFailureGroup()).toBeUndefined();

		// No `force`: this is the memoized return path every non-RuleCache-miss
		// call takes. It must still carry the row in the NEW session's ledger.
		await loader.loadQueries(root);
		const group = parseFailureGroup();
		expect(group?.count).toBe(1);
		expect(
			group?.latestReasons.some((r) => r.subject.endsWith("broken-colon.yml")),
		).toBe(true);
	});

	// #3070 N2: `str()` (clients/tree-sitter-query-loader.ts) refuses a
	// mapping-valued scalar field so `message` falls back to the id-derived
	// default rather than stringifying to the literal text "[object Object]"
	// a user would otherwise read in the diagnostic. Unlike the `id`/`query`
	// mapping cases above (both load-blocking), a mapping-valued `message` is
	// non-fatal — the rule still loads — so this pins the FALLBACK behavior on
	// a field no other test in this file exercises with a non-scalar value.
	it("falls back to the id-derived message for a mapping-valued `message` field (#3070 N2)", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/mapping-message.yml",
			`id: mapping-message
name: Mapping Message
severity: warning
category: quality
language: typescript
message:
  not: a string
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);

		const query = loader.getQueryById("mapping-message");
		expect(query).toBeTruthy();
		// A loosened guard would stringify the mapping to "[object Object]".
		expect(query?.message).toBe("Pattern: mapping-message");
	});

	// #3070 N1 companion: a FIXED rule must stop replaying once a fresh
	// (`force`) load re-parses it clean — the per-file memo the replay draws
	// on is repopulated on every non-memoized load, not merely appended to,
	// or a file corrected on disk keeps reporting its stale failure forever
	// across every later session boundary.
	it("stops replaying a parse failure once the rule file is fixed and force-reloaded", async () => {
		const root = makeTempRulesRoot();
		const relPath = "rules/tree-sitter-queries/typescript/fixable.yml";
		writeRule(
			root,
			relPath,
			`id: fixable
name: Fixable
severity: warning
category: quality
language: typescript
message: some: unquoted colon breaks YAML
query: |
  (identifier) @X
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(parseFailureGroup()?.count).toBe(1);

		// Fix the file on disk, then force-reload (the RuleCache-miss path).
		writeRule(
			root,
			relPath,
			`id: fixable
name: Fixable
severity: warning
category: quality
language: typescript
message: "no more colon problem"
query: |
  (identifier) @X
`,
		);
		await loader.loadQueries(root, { force: true });
		expect(loader.getQueryById("fixable")).toBeTruthy();

		// A later session must not resurrect the stale failure for a file
		// that is clean now.
		resetDegradationLedger();
		await loader.loadQueries(root);
		expect(parseFailureGroup()).toBeUndefined();
	});
});

// #3054 review F2: pins the corpus-wide equivalence claim in CI, not only in
// the PR body — a bundled rule that silently fails to parse (thrown syntax
// error, or a shape the type-checked `id`/`query` guard now rejects) shows up
// as a count mismatch here.
describe("bundled corpus loads in full (#3054 review F2)", () => {
	it("loads every .yml under rules/tree-sitter-queries/ — count mismatch means a bundled rule silently failed to parse", async () => {
		const fileCount = fs
			.readdirSync(BUNDLED_QUERIES_ROOT, { recursive: true })
			.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.endsWith(".yml"),
			).length;
		expect(fileCount).toBeGreaterThan(0);

		// An isolated, empty project root: loadQueries also scans
		// `rootDir/rules/tree-sitter-queries` when it exists, which would
		// double-count or shadow the bundled directory this test pins.
		const root = makeTempRulesRoot();
		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(loader.getAllQueries().length).toBe(fileCount);
	});
});

describe("queriesForLanguage", () => {
	const rule = (id: string, filePath: string): TreeSitterQuery =>
		({ id, filePath }) as TreeSitterQuery;

	const map = new Map<string, TreeSitterQuery[]>([
		[
			"typescript",
			[
				rule("ts-on", "rules/tree-sitter-queries/typescript/on.yml"),
				rule("ts-off", "rules/tree-sitter-queries/typescript-disabled/off.yml"),
			],
		],
		["tsx", [rule("tsx-own", "rules/tree-sitter-queries/tsx/own.yml")]],
		[
			"javascript",
			[rule("js-own", "rules/tree-sitter-queries/javascript/own.yml")],
		],
	]);

	it("never returns a rule from a -disabled directory", () => {
		expect(queriesForLanguage(map, "typescript").map((q) => q.id)).toEqual([
			"ts-on",
		]);
	});

	it("gives tsx the typescript rule set on top of its own", () => {
		expect(queriesForLanguage(map, "tsx").map((q) => q.id)).toEqual([
			"tsx-own",
			"ts-on",
		]);
	});

	it("does NOT give javascript the typescript rule set", () => {
		// Those rules are written against the typescript grammar: on a javascript
		// tree `duplicate-function-arg` alone reported 59 phantom duplicates.
		expect(queriesForLanguage(map, "javascript").map((q) => q.id)).toEqual([
			"js-own",
		]);
	});
});

describe("ruleSourceLanguages / ruleFilesForLanguage (#878)", () => {
	it("mirrors the rule-set composition queriesForLanguage applies", () => {
		// tsx is the one typescript-rule heir; javascript is deliberately not.
		expect(ruleSourceLanguages("tsx")).toEqual(["tsx", "typescript"]);
		expect(ruleSourceLanguages("typescript")).toEqual(["typescript"]);
		expect(ruleSourceLanguages("javascript")).toEqual(["javascript"]);
		expect(ruleSourceLanguages("python")).toEqual(["python"]);
	});

	it("enumerates project-local rule files across every rule-source language", () => {
		const root = makeTempRulesRoot();
		writeRule(root, "rules/tree-sitter-queries/tsx/own.yml", "id: tsx-own\n");
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/inherited.yml",
			"id: ts-rule\n",
		);
		writeRule(
			root,
			"rules/tree-sitter-queries/python/unrelated.yml",
			"id: py-rule\n",
		);
		// Non-.yml files never load, so they must not fingerprint either.
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/notes.txt",
			"not a rule\n",
		);

		const files = ruleFilesForLanguage("tsx", root).map((f) =>
			f.replaceAll("\\", "/"),
		);
		expect(files.some((f) => f.endsWith("tsx/own.yml"))).toBe(true);
		expect(files.some((f) => f.endsWith("typescript/inherited.yml"))).toBe(
			true,
		);
		expect(files.some((f) => f.endsWith("python/unrelated.yml"))).toBe(false);
		expect(files.some((f) => f.endsWith("notes.txt"))).toBe(false);

		// A non-heir language fingerprints only its own directory.
		const pyFiles = ruleFilesForLanguage("python", root).map((f) =>
			f.replaceAll("\\", "/"),
		);
		expect(pyFiles.some((f) => f.endsWith("python/unrelated.yml"))).toBe(true);
		expect(pyFiles.some((f) => f.endsWith("typescript/inherited.yml"))).toBe(
			false,
		);
	});
});

/**
 * #2636 (the #2626 class sweep's tree-sitter leg): `ruleFilesForLanguage`
 * resolving zero files is NORMAL for a language nobody has authored bundled
 * queries for by design — seven REACHABLE grammars have none:
 * bash, dart, elixir, lua, ocaml, swift, zig (`.sh`/`.bash`, `.dart`,
 * `.ex`/`.exs`, `.lua`, `.ml`/`.mli`, `.swift`, `.zig` — see
 * `language-registry.ts`'s `EXTENSION_TO_GRAMMAR`). cobol/plsql are NOT in
 * that registry at all (only their `-disabled` query directories exist), so
 * `ruleFilesForLanguage` never actually resolves those two languageIds in
 * production — `bash`/`lua` below are the REAL examples (#2636 review F2).
 * The two must never be confused: a record fires only when the shared ROOT
 * is unhealthy, never merely because ONE language's own subdirectory is
 * empty.
 */
describe("ruleFilesForLanguage — bundled root health (#2636)", () => {
	const notified: Array<{ message: string; level: string | undefined }> = [];

	beforeEach(() => {
		notified.length = 0;
		resetDegradationLedger();
		_resetBundledQueriesRootHealthForTests();
		vi.mocked(fs.readdirSync).mockClear();
		vi.mocked(fs.readdirSync).mockImplementation(actualFsRef.readdirSync);
		wireUserNotifier(() => (message, level) => {
			notified.push({ message, level });
		});
	});

	afterEach(() => {
		resetUserNotifier();
		resetDegradationLedger();
		_resetBundledQueriesRootHealthForTests();
		vi.mocked(fs.readdirSync).mockImplementation(actualFsRef.readdirSync);
		vi.restoreAllMocks();
	});

	function degradationGroup() {
		return getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-queries-dir-missing",
		);
	}

	/**
	 * Makes the ONE real `BUNDLED_QUERIES_ROOT` directory read as absent
	 * (ENOENT), while every OTHER `readdirSync` call (this file's own temp
	 * rule dirs) still hits the real filesystem — same-file internal calls
	 * to `getBundledQueriesRootHealth` cannot be `vi.spyOn`-intercepted (see
	 * the file-header comment), so the memoized fact underneath it is forced
	 * unhealthy at the real fs layer instead.
	 */
	function mockBundledQueriesRootAbsent(): void {
		vi.mocked(fs.readdirSync).mockImplementation(((
			dir: Parameters<typeof actualFsRef.readdirSync>[0],
			...rest: unknown[]
		) => {
			if (dir === BUNDLED_QUERIES_ROOT) {
				throw Object.assign(new Error("no such directory"), {
					code: "ENOENT",
				});
			}
			// biome-ignore lint/suspicious/noExplicitAny: passthrough to the real overload set
			return (actualFsRef.readdirSync as any)(dir, ...rest);
		}) as typeof fs.readdirSync);
	}

	it("records nothing for bash: zero files, but the REAL bundled root is healthy (no queries authored by design)", () => {
		const root = makeTempRulesRoot();
		expect(ruleFilesForLanguage("bash", root)).toEqual([]);
		expect(degradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	// #2636 review F6: getBundledQueriesRootHealth's memo — a real,
	// measured per-call `readdirSync` cost paid on every dispatched file by
	// BOTH this cold branch and RuleCache's constructor — must survive
	// repeated calls across DIFFERENT by-design-empty languages, not just
	// repeated calls for the SAME one.
	it("memoizes the bundled root's health across calls, even for different languages", () => {
		const root = makeTempRulesRoot();
		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		ruleFilesForLanguage("bash", root);
		const bundledRootCalls = vi
			.mocked(fs.readdirSync)
			.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT);
		expect(bundledRootCalls).toHaveLength(1);
	});

	// #2636 review round 2, F3: the memo must re-probe once per SESSION
	// (never once forever) — a managed-cache relocation of a LIVE install is
	// exactly the failure #2587/#2626 investigated, so a permanently-cached
	// "absent" verdict from the first probe would never notice the directory
	// coming back (or a healthy root going away) later in the same process.
	it("re-probes exactly once after a session boundary (resetDegradationLedger), not on every call within it", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		expect(
			vi
				.mocked(fs.readdirSync)
				.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT),
		).toHaveLength(1);

		// Session boundary — runtime-session.ts's handleSessionStart calls
		// this first thing in production.
		resetDegradationLedger();

		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		expect(
			vi
				.mocked(fs.readdirSync)
				.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT),
		).toHaveLength(2);
	});

	it("never touches the bundled root's own readdirSync on the common, non-empty path (typescript)", () => {
		const root = makeTempRulesRoot();
		expect(ruleFilesForLanguage("typescript", root).length).toBeGreaterThan(0);
		const bundledRootCalls = vi
			.mocked(fs.readdirSync)
			.mock.calls.filter(([dir]) => dir === BUNDLED_QUERIES_ROOT);
		expect(bundledRootCalls).toHaveLength(0);
	});

	it("records a bounded degradation + notify when the bundled root is actually gone", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		expect(ruleFilesForLanguage("bash", root)).toEqual([]);

		const group = degradationGroup();
		expect(group).toBeDefined();
		expect(group?.latestReasons.at(-1)?.subject).toBe(BUNDLED_QUERIES_ROOT);
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain(
			"bundled tree-sitter query rules unavailable",
		);
	});

	it("collapses every zero-file language into ONE ledger row, not one per language", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		ruleFilesForLanguage("bash", root);
		ruleFilesForLanguage("lua", root);
		ruleFilesForLanguage("bash", root);

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(3);
		expect(
			getDegradationSummary().filter(
				(g) => g.kind === "tree-sitter-queries-dir-missing",
			),
		).toHaveLength(1);
	});

	// #2636 review round 2, F2: the ONLY observability record for this branch
	// is the degradation ledger row — no separate phase/latency record (see
	// the source comment). `incrementDegradationCount` bounds durable writes
	// to power-of-two milestones on its own; this pins that MANY occurrences
	// of the same failure still write exactly ONE bounded row (not one raw
	// row per dispatched file), directly answering "what would 200 touches
	// of a broken root cost" — the ledger's in-memory `count` is the exact
	// total regardless of how many of those are durably persisted.
	it("tallies many occurrences into the ledger's exact count, never a raw per-call record", () => {
		mockBundledQueriesRootAbsent();
		const root = makeTempRulesRoot();

		for (let i = 0; i < 200; i++) {
			ruleFilesForLanguage("bash", root);
		}

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(200);
		expect(
			getDegradationSummary().filter(
				(g) => g.kind === "tree-sitter-queries-dir-missing",
			),
		).toHaveLength(1);
	});
});
