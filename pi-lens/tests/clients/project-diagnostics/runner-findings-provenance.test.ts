import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotAdvisoryProvenance } from "../../../clients/advisory-provenance.js";
import { CacheManager } from "../../../clients/cache-manager.js";
import { testRunnerFindingsToProjectDiagnostics } from "../../../clients/project-diagnostics/runner-adapters/runner-findings.js";
import { peekTestFindings } from "../../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { removeTempDirSync } from "../test-utils.js";

describe("test finding provenance adapter (#1413)", () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach(removeTempDirSync));

	function fixture() {
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-runner-provenance-"),
		);
		dirs.push(cwd);
		const file = path.join(cwd, "src", "foo.test.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "test('foo', () => {});\n");
		const provenance = snapshotAdvisoryProvenance({
			cwd,
			runtime: { telemetrySessionId: "adapter", projectSeq: 0, turnIndex: 0 },
			generation: 2,
			files: [{ path: file, role: "test" }],
		});
		const result = {
			file,
			sourceFile: file,
			runner: "vitest",
			passed: 0,
			failed: 1,
			skipped: 0,
			failures: [],
			duration: 1,
		};
		return { cwd, file, provenance, result };
	}

	it("keeps validated failures blocking", () => {
		const { cwd, provenance, result } = fixture();
		expect(
			testRunnerFindingsToProjectDiagnostics(
				{ content: "fail", results: [result], provenance },
				cwd,
			)[0],
		).toMatchObject({ severity: "error", semantic: "blocking" });
	});

	it("makes superseded and legacy failures non-blocking", () => {
		const { cwd, provenance, result } = fixture();
		for (const cache of [
			{ content: "fail", results: [result], provenance, superseded: true },
			{ content: "fail", results: [result] },
		]) {
			expect(
				testRunnerFindingsToProjectDiagnostics(cache, cwd)[0],
			).toMatchObject({ severity: "info", semantic: "none" });
		}
	});

	it("classifies a session-mismatched record identically on context and project surfaces", () => {
		const { cwd, provenance, result } = fixture();
		const cache = { content: "fail", results: [result], provenance };
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "different-session" });
		const cacheManager = new CacheManager(false);
		cacheManager.writeCache("test-runner-findings", cache, cwd);
		expect(
			peekTestFindings(cacheManager, cwd, runtime)?.messages[0]?.content,
		).toContain("Historical finding");
		expect(
			testRunnerFindingsToProjectDiagnostics(cache, cwd, runtime)[0],
		).toMatchObject({ severity: "info", semantic: "none" });
	});

	it("drops deleted targets and returns none after consumption", () => {
		const { cwd, file, provenance, result } = fixture();
		fs.unlinkSync(file);
		expect(
			testRunnerFindingsToProjectDiagnostics(
				{ content: "fail", results: [result], provenance },
				cwd,
			),
		).toEqual([]);
		expect(
			testRunnerFindingsToProjectDiagnostics({ content: "" }, cwd),
		).toEqual([]);
	});
});
