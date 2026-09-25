/**
 * #1640 unit coverage for the inferred-project demotion seam.
 *
 * The contract under test, in one line: demote ONLY on a confirmed "inferred"
 * verdict from tsserver, never on silence.
 */
import { describe, expect, it, vi } from "vitest";
import {
	INFERRED_PROJECT_MARKER,
	INFERRED_PROJECT_PROBE_BUDGET,
	applyInferredProjectDemotion,
	demoteInferredProjectDiagnostics,
	demoteInferredProjectSweepResults,
	inferredProjectNotice,
	isTsProjectFile,
	suggestTsconfigInclude,
} from "../../../clients/lsp/inferred-project.js";
import { classifyProjectInfo } from "../../../clients/lsp/tsserver-sync.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";

const CWD = "/proj";

function tsError(message = "Cannot find name 'describe'."): LSPDiagnostic {
	return {
		severity: 1,
		message,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
		source: "typescript",
		code: 2582,
	};
}

function makeService(identity: unknown, hasProbeChannel = true) {
	const executeReadOnlyCommandOnLiveClient = vi.fn(async () => ({
		executed: true,
		result: { success: true, body: identity },
	}));
	return hasProbeChannel
		? { executeReadOnlyCommandOnLiveClient }
		: ({ executeReadOnlyCommandOnLiveClient: undefined } as unknown as {
				executeReadOnlyCommandOnLiveClient: typeof executeReadOnlyCommandOnLiveClient;
			});
}

const INFERRED_BODY = { configFileName: "/dev/null/inferredProject1*" };

describe("classifyProjectInfo (#1640 detection contract)", () => {
	it("names tsserver's synthetic inferred project", () => {
		expect(classifyProjectInfo(INFERRED_BODY).projectKind).toBe("inferred");
	});

	it("names a real tsconfig project configured", () => {
		expect(
			classifyProjectInfo({ configFileName: "/proj/tsconfig.json" })
				.projectKind,
		).toBe("configured");
	});

	it("does not guess when tsserver names no project at all", () => {
		expect(classifyProjectInfo({}).projectKind).toBe("unassociated");
		expect(classifyProjectInfo(undefined).projectKind).toBe("unassociated");
	});
});

describe("suggestTsconfigInclude", () => {
	it("names the top-level directory a user would add", () => {
		expect(suggestTsconfigInclude("/proj/tests/unit/a.test.ts", CWD)).toBe(
			"tests/**",
		);
	});

	it("names the file itself when it sits in the project root", () => {
		expect(suggestTsconfigInclude("/proj/vitest.config.ts", CWD)).toBe(
			"vitest.config.ts",
		);
	});
});

describe("applyInferredProjectDemotion", () => {
	it("keeps the finding, drops the blocking severity, and labels it", () => {
		const [d] = applyInferredProjectDemotion(
			[tsError()],
			"/proj/tests/unit/a.test.ts",
			CWD,
		);
		expect(d.severity).toBe(2);
		expect(d.message).toContain("Cannot find name 'describe'.");
		expect(d.message).toContain(INFERRED_PROJECT_MARKER);
		expect(d.message).toContain("add tests/** to a tsconfig");
	});

	it("leaves auxiliary-sourced findings alone — a tsconfig gap is not their problem", () => {
		const aux: LSPDiagnostic = { ...tsError(), source: "Semgrep" };
		const out = applyInferredProjectDemotion(
			[aux],
			"/proj/tests/unit/a.test.ts",
			CWD,
		);
		expect(out[0].severity).toBe(1);
		expect(out[0].message).not.toContain(INFERRED_PROJECT_MARKER);
	});

	it("returns the same array reference when nothing is demotable", () => {
		const input = [{ ...tsError(), severity: 2 as const }];
		expect(applyInferredProjectDemotion(input, "/proj/a.ts", CWD)).toBe(input);
	});
});

describe("demoteInferredProjectDiagnostics", () => {
	it("demotes on a confirmed inferred verdict", async () => {
		const service = makeService(INFERRED_BODY);
		const out = await demoteInferredProjectDiagnostics([tsError()], {
			filePath: "/proj/tests/unit/a.test.ts",
			cwd: CWD,
			service,
		});
		expect(out[0].severity).toBe(2);
		expect(out[0].message).toContain(INFERRED_PROJECT_MARKER);
	});

	it("does NOT demote when the file belongs to a real project", async () => {
		const service = makeService({ configFileName: "/proj/tsconfig.json" });
		const out = await demoteInferredProjectDiagnostics([tsError()], {
			filePath: "/proj/src/a.ts",
			cwd: CWD,
			service,
		});
		expect(out[0].severity).toBe(1);
	});

	it("does NOT demote when the probe is unavailable — silence is not a verdict", async () => {
		const service = makeService(INFERRED_BODY, false);
		const out = await demoteInferredProjectDiagnostics([tsError()], {
			filePath: "/proj/tests/unit/a.test.ts",
			cwd: CWD,
			service,
		});
		expect(out[0].severity).toBe(1);
		expect(service.executeReadOnlyCommandOnLiveClient).toBeUndefined();
	});

	it("does NOT demote when tsserver names no project at all", async () => {
		const service = makeService({});
		const out = await demoteInferredProjectDiagnostics([tsError()], {
			filePath: "/proj/tests/unit/a.test.ts",
			cwd: CWD,
			service,
		});
		expect(out[0].severity).toBe(1);
	});

	it("never probes a file with no TypeScript error on it", async () => {
		const service = makeService(INFERRED_BODY);
		await demoteInferredProjectDiagnostics([], {
			filePath: "/proj/tests/unit/a.test.ts",
			cwd: CWD,
			service,
		});
		await demoteInferredProjectDiagnostics([{ ...tsError(), severity: 2 }], {
			filePath: "/proj/tests/unit/a.test.ts",
			cwd: CWD,
			service,
		});
		expect(service.executeReadOnlyCommandOnLiveClient).not.toHaveBeenCalled();
	});

	it("never probes a non-TypeScript file", async () => {
		const service = makeService(INFERRED_BODY);
		await demoteInferredProjectDiagnostics(
			[{ ...tsError(), source: "typescript" }],
			{ filePath: "/proj/tests/a.py", cwd: CWD, service },
		);
		expect(service.executeReadOnlyCommandOnLiveClient).not.toHaveBeenCalled();
	});

	it("swallows a throwing probe and keeps the diagnostic as-is", async () => {
		const service = {
			executeReadOnlyCommandOnLiveClient: vi.fn(async () => {
				throw new Error("No Project.");
			}),
		};
		const out = await demoteInferredProjectDiagnostics([tsError()], {
			filePath: "/proj/tests/unit/a.test.ts",
			cwd: CWD,
			service,
		});
		expect(out[0].severity).toBe(1);
	});

	it("isTsProjectFile covers the extensions tsserver owns", () => {
		expect(isTsProjectFile("/a/b.mts")).toBe(true);
		expect(isTsProjectFile("/a/b.tsx")).toBe(true);
		expect(isTsProjectFile("/a/b.cjs")).toBe(true);
		expect(isTsProjectFile("/a/b.go")).toBe(false);
	});

	it("builds the notice from the file's own location", () => {
		expect(inferredProjectNotice("/proj/tests/unit/a.test.ts", CWD)).toContain(
			"add tests/** to a tsconfig for authoritative checking",
		);
	});
});

describe("demoteInferredProjectSweepResults", () => {
	it("probes each file once and rebuilds only the demoted results", async () => {
		const service = makeService(INFERRED_BODY);
		const untouched = {
			filePath: "/proj/tests/unit/b.test.ts",
			diagnostics: [],
		};
		const results = [
			{ filePath: "/proj/tests/unit/a.test.ts", diagnostics: [tsError()] },
			untouched,
		];
		const out = await demoteInferredProjectSweepResults(results, CWD, service);
		expect(out[0].diagnostics[0].severity).toBe(2);
		expect(out[1]).toBe(untouched);
		expect(service.executeReadOnlyCommandOnLiveClient).toHaveBeenCalledTimes(1);
	});

	it("stops demoting past the probe budget instead of guessing", async () => {
		const service = makeService(INFERRED_BODY);
		const results = Array.from(
			{ length: INFERRED_PROJECT_PROBE_BUDGET + 5 },
			(_, i) => ({
				filePath: `/proj/tests/unit/a${i}.test.ts`,
				diagnostics: [tsError()],
			}),
		);
		const out = await demoteInferredProjectSweepResults(results, CWD, service);
		expect(service.executeReadOnlyCommandOnLiveClient).toHaveBeenCalledTimes(
			INFERRED_PROJECT_PROBE_BUDGET,
		);
		expect(out.at(-1)?.diagnostics[0].severity).toBe(1);
	});

	it("is a no-op for a service with no command channel", async () => {
		const results = [
			{ filePath: "/proj/tests/unit/a.test.ts", diagnostics: [tsError()] },
		];
		expect(await demoteInferredProjectSweepResults(results, CWD, {})).toBe(
			results,
		);
	});
});
