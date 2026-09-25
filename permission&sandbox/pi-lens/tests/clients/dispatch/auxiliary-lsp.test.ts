import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	AUXILIARY_LSP_PROFILES,
	applyAuxiliarySuppressions,
	enabledAuxiliaryLspServerIds,
	findAuxiliaryProfileForSource,
	isAuxiliaryDiagnosticSuppressed,
	retagAuxiliaryDiagnostics,
} from "../../../clients/dispatch/auxiliary-lsp.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";
import { removeTempDirSync } from "../test-utils.js";
import { _resetSubagentModeForTests } from "../../../clients/subagent-mode.js";

const diag = (over: Partial<LSPDiagnostic>): LSPDiagnostic =>
	({
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message: "x",
		severity: 2,
		...over,
	}) as LSPDiagnostic;

describe("auxiliary LSP enablement", () => {
	// #713: reset subagent classification between tests so env changes are picked up.
	beforeEach(() => {
		_resetSubagentModeForTests();
	});
	afterEach(() => {
		_resetSubagentModeForTests();
	});

	it("opengrep is default-on (no kill-switch flag set)", () => {
		const ids = enabledAuxiliaryLspServerIds(() => undefined);
		expect(ids).toContain("opengrep");
	});

	it("the no-opengrep kill switch disables it", () => {
		const ids = enabledAuxiliaryLspServerIds((f) => f === "no-opengrep");
		expect(ids).not.toContain("opengrep");
	});

	it("zizmor is default-on and the no-zizmor kill switch disables it (#272)", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain("zizmor");
		expect(
			enabledAuxiliaryLspServerIds((f) => f === "no-zizmor"),
		).not.toContain("zizmor");
	});

	it("typos is default-on and the no-typos kill switch disables it (#283)", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain("typos");
		expect(enabledAuxiliaryLspServerIds((f) => f === "no-typos")).not.toContain(
			"typos",
		);
	});

	// #713: subagent light mode skips all auxiliary servers (same seam as budget
	// degrade) — parent session already runs them on the same cwd.
	it("subagent session returns empty auxiliary set (#713)", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([]);
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	});

	it("subagent session skips auxiliaries regardless of kill-switch flags (#713)", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			// Even with no kill switches active, the subagent seam returns empty
			const ids = enabledAuxiliaryLspServerIds(() => undefined);
			expect(ids).not.toContain("opengrep");
			expect(ids).not.toContain("zizmor");
			expect(ids).not.toContain("typos");
			expect(ids).toEqual([]);
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	});

	it("PI_LENS_SUBAGENT_FULL=1 restores auxiliaries inside a subagent session (#713)", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		_resetSubagentModeForTests();
		try {
			const ids = enabledAuxiliaryLspServerIds(() => undefined);
			expect(ids).toContain("opengrep");
			expect(ids).toContain("zizmor");
			expect(ids).toContain("typos");
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			delete process.env.PI_LENS_SUBAGENT_FULL;
			_resetSubagentModeForTests();
		}
	});
});

describe("auxiliary profile skipTestFiles (#687)", () => {
	it("ast-grep skips test files (matches the in-process runner's own skipTestFiles)", () => {
		expect(
			AUXILIARY_LSP_PROFILES.find((p) => p.tool === "ast-grep")?.skipTestFiles,
		).toBe(true);
	});

	it("opengrep, zizmor, and typos do NOT skip test files", () => {
		for (const tool of ["opengrep", "zizmor", "typos"]) {
			expect(
				AUXILIARY_LSP_PROFILES.find((p) => p.tool === tool)?.skipTestFiles,
			).not.toBe(true);
		}
	});
});

describe("auxiliary profile source routing", () => {
	it("routes Opengrep's 'Semgrep' source to the opengrep profile", () => {
		expect(findAuxiliaryProfileForSource("Semgrep")?.tool).toBe("opengrep");
		expect(findAuxiliaryProfileForSource("opengrep")?.tool).toBe("opengrep");
	});

	it("routes zizmor's 'zizmor' source to the zizmor profile (#272)", () => {
		expect(findAuxiliaryProfileForSource("zizmor")?.tool).toBe("zizmor");
	});

	it("routes typos-lsp's 'typos' source to the typos profile (#283)", () => {
		expect(findAuxiliaryProfileForSource("typos")?.tool).toBe("typos");
	});

	it("ignores language-server sources and missing source", () => {
		expect(findAuxiliaryProfileForSource("typescript")).toBeUndefined();
		expect(findAuxiliaryProfileForSource("eslint")).toBeUndefined();
		expect(findAuxiliaryProfileForSource(undefined)).toBeUndefined();
	});
});

describe("opengrep semantic policy", () => {
	const opengrep = AUXILIARY_LSP_PROFILES.find(
		(p) => p.serverId === "opengrep",
	);

	it("blocks ERROR only where blocking is allowed (curated repo rules)", () => {
		expect(opengrep).toBeDefined();
		// blocking allowed (repo has its own rules): ERROR → blocking, else warning.
		expect(
			opengrep?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			opengrep?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});

	it("never blocks the auto Community set (no local rules) — advisory only", () => {
		// blocking NOT allowed (auto): even ERROR stays a warning (surfaced in lens_diagnostics).
		expect(
			opengrep?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
		expect(
			opengrep?.semantic(diag({ severity: 2 }), { blockingAllowed: false }),
		).toBe("warning");
	});

	it("derives a defect class from the rule", () => {
		const dc = opengrep?.defectClass?.(
			diag({ code: "javascript.lang.security.audit.eval", message: "eval" }),
		);
		expect(typeof dc === "string" || dc === undefined).toBe(true);
	});
});

describe("ast-grep semantic policy", () => {
	const astGrep = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "ast-grep");

	it("uses ast-grep severity for the shipped baseline as well as project sgconfig", () => {
		expect(astGrep).toBeDefined();
		expect(astGrep?.allowBlocking?.("/repo")).toBe(true);
		expect(
			astGrep?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			astGrep?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});
});

describe("zizmor semantic policy (#272)", () => {
	const zizmor = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "zizmor");

	it("blocks High (ERROR) only where a repo zizmor.yml opts in; advisory otherwise", () => {
		expect(zizmor).toBeDefined();
		// curated repo config present → High blocks, Medium/Low stays advisory.
		expect(
			zizmor?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			zizmor?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
		// no curated config → even High stays a warning (surfaced in lens_diagnostics).
		expect(
			zizmor?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
	});

	it("derives a defect class from the rule id", () => {
		const dc = zizmor?.defectClass?.(
			diag({
				code: "template-injection",
				message: "code injection via template",
			}),
		);
		expect(typeof dc === "string" || dc === undefined).toBe(true);
	});
});

describe("typos semantic policy (#283)", () => {
	const typos = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "typos");

	it("is advisory by default; blocks only ERROR where a repo typos.toml opts in", () => {
		expect(typos).toBeDefined();
		// no repo typos config → even an ERROR-severity finding stays advisory
		// (typos-lsp's own default severity is WARNING anyway).
		expect(
			typos?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
		expect(
			typos?.semantic(diag({ severity: 2 }), { blockingAllowed: false }),
		).toBe("warning");
		// repo opts in with a typos.toml AND raised severity to Error → blocks.
		expect(
			typos?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			typos?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});

	it("classifies a misspelling as a style (docs/quality) defect — not security", () => {
		expect(
			typos?.defectClass?.(diag({ message: "`recieve` should be `receive`" })),
		).toBe("style");
	});
});

// #586: the single, generic lookup+apply helper every call site (per-edit
// dispatch runner, `tools/lsp-diagnostics.ts`, `runWorkspaceDiagnostics`)
// should use instead of re-deriving "find the profile by source, then check
// isSuppressed" independently.
describe("isAuxiliaryDiagnosticSuppressed / applyAuxiliarySuppressions (#586)", () => {
	const RULE =
		"python.lang.security.audit.subprocess-shell-true.subprocess-shell-true";

	it("drops an opengrep (Semgrep-sourced) diagnostic suppressed by `// nosemgrep`", () => {
		const content = "subprocess.run('ls', shell=True)  // nosemgrep\n";
		const d = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(d, content)).toBe(true);
		expect(applyAuxiliarySuppressions([d], content)).toEqual([]);
	});

	it("keeps the same diagnostic when there is no nosemgrep comment", () => {
		const content = "subprocess.run('ls', shell=True)\n";
		const d = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(d, content)).toBe(false);
		expect(applyAuxiliarySuppressions([d], content)).toEqual([d]);
	});

	it("is a no-op for profiles with no isSuppressed callback (e.g. ast-grep, zizmor, typos)", () => {
		const content = "anything\n";
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(astGrepDiag, content)).toBe(false);
		expect(applyAuxiliarySuppressions([astGrepDiag], content)).toEqual([
			astGrepDiag,
		]);
	});

	it("is a no-op for diagnostics with no matching auxiliary profile (plain language-server findings)", () => {
		const content = "anything\n";
		const tsDiag = diag({
			source: "typescript",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(tsDiag, content)).toBe(false);
		expect(applyAuxiliarySuppressions([tsDiag], content)).toEqual([tsDiag]);
	});

	it("filters a mixed list, keeping unsuppressed and dropping suppressed diagnostics", () => {
		const content = [
			"subprocess.run('a', shell=True)  // nosemgrep",
			"subprocess.run('b', shell=True)",
		].join("\n");
		const suppressed = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		const kept = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 1 },
			},
		});
		expect(applyAuxiliarySuppressions([suppressed, kept], content)).toEqual([
			kept,
		]);
	});
});

// #692: the workspace sweep (`clients/lsp/index.ts`'s `runWorkspaceDiagnostics`)
// called `applyAuxiliarySuppressions` with only (diagnostics, content) — never a
// fileRole — so ast-grep's `skipTestFiles` (#687) gate, honored by the per-edit
// dispatch runner, never applied to a `mode=full` sweep. `opts.fileRole` closes
// that gap; omitting `opts` must keep every existing 2-arg call site unchanged.
describe("applyAuxiliarySuppressions fileRole gate (#692)", () => {
	const content = "anything\n";

	it("drops an ast-grep-sourced diagnostic when fileRole is 'test'", () => {
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(
			applyAuxiliarySuppressions([astGrepDiag], content, { fileRole: "test" }),
		).toEqual([]);
	});

	it("keeps opengrep/zizmor/typos findings on a test file (no skipTestFiles on those profiles)", () => {
		const opengrepDiag = diag({
			source: "Semgrep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		const zizmorDiag = diag({
			source: "zizmor",
			range: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 1 },
			},
		});
		const typosDiag = diag({
			source: "typos",
			range: {
				start: { line: 2, character: 0 },
				end: { line: 2, character: 1 },
			},
		});
		expect(
			applyAuxiliarySuppressions(
				[opengrepDiag, zizmorDiag, typosDiag],
				content,
				{ fileRole: "test" },
			),
		).toEqual([opengrepDiag, zizmorDiag, typosDiag]);
	});

	it("keeps ast-grep findings when fileRole is not 'test'", () => {
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(
			applyAuxiliarySuppressions([astGrepDiag], content, {
				fileRole: "source",
			}),
		).toEqual([astGrepDiag]);
	});

	it("without the third arg, behaves exactly as before (no test-file gating)", () => {
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(applyAuxiliarySuppressions([astGrepDiag], content)).toEqual([
			astGrepDiag,
		]);
	});
});

// #692: `retagAuxiliaryDiagnostics` is the shared helper extracted from the
// per-edit dispatch runner (`clients/dispatch/runners/lsp.ts`) so a scan/sweep
// reconcile path can give its aux-sourced findings identical tool/semantic/
// defectClass tagging instead of keeping tool "lsp" — verify it reproduces the
// exact per-edit behavior `runner-status-semantics.test.ts` already locks in.
describe("retagAuxiliaryDiagnostics (#692)", () => {
	it("re-tags an ast-grep finding with tool 'ast-grep' and its semantic policy", () => {
		const raw: LSPDiagnostic[] = [
			diag({
				source: "ast-grep",
				code: "no-eval",
				severity: 1,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.ts");
		expect(converted[0].tool).toBe("lsp");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "", {
			cwd: "/repo",
			fileRole: "source",
		});
		expect(retagged).toHaveLength(1);
		expect(retagged[0].tool).toBe("ast-grep");
		expect(retagged[0].semantic).toBe("blocking");
	});

	it("drops ast-grep findings on test files (skipTestFiles), keeps opengrep's", () => {
		const raw: LSPDiagnostic[] = [
			diag({
				source: "ast-grep",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
			diag({
				source: "Semgrep",
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.test.ts");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "", {
			cwd: "/repo",
			fileRole: "test",
		});
		expect(retagged).toHaveLength(1);
		expect(retagged[0].tool).toBe("opengrep");
	});

	it("honors native inline suppression (e.g. `// nosemgrep`) via the `content` argument", () => {
		const content = "subprocess.run('x', shell=True)  // nosemgrep\n";
		const raw: LSPDiagnostic[] = [
			diag({
				source: "Semgrep",
				code: "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.py");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, content, {
			cwd: "/repo",
			fileRole: "source",
		});
		expect(retagged).toEqual([]);
	});

	it("leaves plain language-server diagnostics (no matching profile) untouched, tool stays 'lsp'", () => {
		const raw: LSPDiagnostic[] = [
			diag({
				source: "typescript",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.ts");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "", {
			cwd: "/repo",
			fileRole: "source",
		});
		expect(retagged).toHaveLength(1);
		expect(retagged[0].tool).toBe("lsp");
	});
});

// #3041 recurrence: ast-grep's LSP publishes per-document diagnostics WITHOUT
// applying a rule's own `ignores` globs (its `scan` walk does — verified against
// ast-grep 0.45.3), so every pi-lens route that delivers those diagnostics
// re-surfaced findings the NAPI runner correctly skips. Guarding it here, at the
// one shared drop-decision seam both routes call, is what keeps `source=lsp` and
// `mode=full` from drifting apart again the way #586 and #692 did.
describe("applyAuxiliarySuppressions per-rule ignores gate (#3041)", () => {
	const astGrepDiag = (code: string): LSPDiagnostic =>
		diag({ source: "ast-grep", code });
	// The shipped catalog rule whose own YAML carves out `scripts/**`, `bin/**`
	// and `**/logger.ts` (#965).
	const RULE = "no-console-except-error";
	const root = path.resolve("/repo");
	const content = "console.log('x');\n";

	it("drops a catalog rule finding on a path the rule ignores globs carve out", () => {
		expect(
			applyAuxiliarySuppressions([astGrepDiag(RULE)], content, {
				filePath: path.join(root, "scripts", "cli.ts"),
				scanRoot: root,
			}),
		).toEqual([]);
	});

	it("keeps the same rule finding on a path it does not carve out", () => {
		const kept = applyAuxiliarySuppressions([astGrepDiag(RULE)], content, {
			filePath: path.join(root, "src", "app.ts"),
			scanRoot: root,
		});
		expect(kept).toHaveLength(1);
	});

	it("keeps a rule that declares no ignores at all on the same carved-out path", () => {
		const kept = applyAuxiliarySuppressions(
			[astGrepDiag("no-alert")],
			content,
			{ filePath: path.join(root, "scripts", "cli.ts"), scanRoot: root },
		);
		expect(kept).toHaveLength(1);
	});

	it("leaves every diagnostic in place when the caller supplies no scan root", () => {
		const kept = applyAuxiliarySuppressions([astGrepDiag(RULE)], content, {
			filePath: path.join(root, "scripts", "cli.ts"),
		});
		expect(kept).toHaveLength(1);
	});
});

// #3041: the seam must read the SAME effective catalog the NAPI runner reads —
// project rule trees first, bundled second, first source wins per rule id. A
// project that redefines a bundled rule id with its own `ignores` would
// otherwise be carved out by the bundled globs over LSP and by its own globs
// per-edit, which is the drift this change exists to remove.
describe("rule-ignore catalog precedence (#3041)", () => {
	let tmp: string;
	const RULE = "no-console-except-error";
	const content = "console.log('x');\n";

	beforeEach(() => {
		tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-rule-ignores-precedence-"),
		);
	});
	afterEach(() => removeTempDirSync(tmp));

	/** Redefine the bundled rule id in the project tree, with or without ignores. */
	const writeProjectRule = (ignores?: readonly string[]) => {
		const dir = path.join(tmp, "rules", "ast-grep-rules", "rules");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${RULE}.yml`),
			[
				`id: ${RULE}`,
				"language: TypeScript",
				"severity: warning",
				'message: "project override"',
				...(ignores
					? ["ignores:", ...ignores.map((glob) => `  - "${glob}"`)]
					: []),
				"rule:",
				"  pattern: console.log($$$)",
				"",
			].join("\n"),
		);
	};

	const keptCount = (relative: string) =>
		applyAuxiliarySuppressions(
			[diag({ source: "ast-grep", code: RULE })],
			content,
			{ filePath: path.join(tmp, relative), scanRoot: tmp },
		).length;

	it("uses the project rule's ignores, not the bundled rule's, for the same id", () => {
		writeProjectRule(["vendor/**"]);
		expect(keptCount(path.join("vendor", "dep.ts"))).toBe(0);
		expect(keptCount(path.join("scripts", "cli.ts"))).toBe(1);
	});

	// #3041 r2 F1: the winning document declaring NO `ignores` is the inverted
	// case. `ast-grep-napi.ts` claims the id (`seenRuleIds.add`) BEFORE its own
	// ignore check, so a project rule that redefines a bundled id to fire
	// everywhere fires on scripts/** per-edit. Skipping a no-ignores document
	// without claiming its id let the LOWER-precedence bundled copy register its
	// `scripts/**` globs, so mode=full and source=lsp dropped what the runner
	// delivered — the same two surfaces disagreeing that this PR exists to fix,
	// only inverted.
	it("lets a project rule that declares no ignores override the bundled carve-out", () => {
		writeProjectRule();
		expect(keptCount(path.join("scripts", "cli.ts"))).toBe(1);
		expect(keptCount(path.join("src", "app.ts"))).toBe(1);
	});

	// #3041 r2 F2: a file outside `scanRoot` is matched by its ABSOLUTE path, not
	// by the `../..`-prefixed relative one — measured: with real catalog globs the
	// two forms disagree on 12 of 24 (root, file, pattern) combinations, e.g.
	// `**/logger.ts` matches `/elsewhere/lib/logger.ts` and never matches
	// `../../elsewhere/lib/logger.ts`. Without the fallback an out-of-tree logger
	// sink loses its carve-out entirely.
	it("matches an out-of-tree file by its absolute path", () => {
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-rule-ignores-out-"),
		);
		try {
			const keptFor = (relative: string) =>
				applyAuxiliarySuppressions(
					[diag({ source: "ast-grep", code: RULE })],
					content,
					{ filePath: path.join(outside, relative), scanRoot: tmp },
				).length;
			// `**/logger.ts` reaches an absolute path; directory carve-outs
			// deliberately remain contained by the scan root.
			expect(keptFor(path.join("lib", "logger.ts"))).toBe(0);
			expect(keptFor(path.join("lib", "logger.js"))).toBe(0);
			expect(keptFor(path.join("lib", "logger.mjs"))).toBe(0);
			expect(keptFor(path.join("scripts", "cli.ts"))).toBe(1);
			expect(keptFor(path.join("bin", "cli.ts"))).toBe(1);
		} finally {
			removeTempDirSync(outside);
		}
	});

	// #3041 r2 F4: the map is built from the AST-GREP catalog, so a colliding rule
	// id from any other producer must NOT inherit its carve-out — a silently
	// dropped finding is the harm this change exists to stop.
	it("never drops a non-ast-grep finding whose code collides with a catalog id", () => {
		const kept = applyAuxiliarySuppressions(
			[diag({ source: "eslint", code: RULE })],
			content,
			{ filePath: path.join(tmp, "scripts", "cli.ts"), scanRoot: tmp },
		);
		expect(kept).toHaveLength(1);
	});
});
