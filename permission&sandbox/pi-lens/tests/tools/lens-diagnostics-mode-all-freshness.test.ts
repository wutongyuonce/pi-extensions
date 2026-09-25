/**
 * End-to-end `lens_diagnostics mode=all` freshness (#1631, acceptance criterion 3).
 *
 * "mode=all output never contains a blocking entry contradicted by a same-minute
 * mode=full active sweep on the same paths." This drives the REAL lens_diagnostics
 * tool over the REAL widget-state store (no widget mock) and asserts that a blocking
 * finding whose dependency drifted out-of-band is served DEMOTED (`[stale — re-run to
 * confirm]`, zero blocking count) rather than as an authoritative 🔴 blocker.
 *
 * Setup note: the blocker is observed NOW and the dependency is pushed into the
 * future. That keeps the consumer's OWN mtime at-or-before the observation (so the
 * preceding `reconcileStaleWidgetFiles` own-file gate keeps the record) while the
 * dependency reads as drifted — isolating the dependency axis under test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import {
	clearWidgetState,
	markWidgetFileBlockersStale,
	recordDiagnostics,
	retireWidgetDependencyDriftBlockers,
} from "../../clients/widget-state.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

// Avoid constructing real heavyweight analyzer clients / spawning tools; mode=all
// never calls these, but lens-diagnostics imports the seams at module load.
vi.mock("../../clients/project-diagnostics/fresh-fetch.js", () => ({
	fetchFreshProjectDiagnostics: vi.fn().mockResolvedValue({
		diagnostics: [],
		runners: [],
		cold: [],
		timings: {},
	}),
}));
vi.mock("../../clients/bootstrap.js", () => ({
	loadBootstrapClients: vi.fn().mockResolvedValue({}),
}));

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	clearWidgetState();
	resetProjectLensConfigCache();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTool(cwd: string) {
	return createLensDiagnosticsTool(
		{ readCache: () => undefined } as any,
		() => cwd,
		() => undefined as any,
	);
}

function runModeAll(tool: ReturnType<typeof makeTool>, cwd: string) {
	return tool.execute(
		"1",
		{ mode: "all" },
		new AbortController().signal,
		null,
		{ cwd },
	);
}

describe("lens_diagnostics mode=all dependency freshness (#1631 criterion 3)", () => {
	it("does not serve a dependency-drifted blocker as blocking", async () => {
		const dir = makeDir("pi-lens-modeall-fresh-");
		const consumer = path.join(dir, "git-env.test.ts");
		const dep = path.join(dir, "worktree.ts");
		fs.writeFileSync(dep, "export const other = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { gitEnv } from "./worktree.js";\nexport const t = gitEnv;\n',
		);

		// Observed now; the dependency then drifts into the future (out-of-band fix).
		recordDiagnostics(
			consumer,
			[
				{
					severity: "error",
					semantic: "blocking",
					message: "No exported member 'gitEnv'",
					tool: "lsp",
					rule: "ts(2305)",
					line: 1,
				},
			],
			1,
			Date.now(),
		);
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(dep, future, future);

		const tool = makeTool(dir);
		const result = (await runModeAll(tool, dir)) as {
			content: Array<{ text: string }>;
		};
		const text = result.content.map((c) => c.text).join("\n");

		// The stale blocker must not be re-asserted at full authority: no 🔴 marker and
		// the file header renders an error tally (`1E`), not an authoritative blocking
		// count. (The summary line legitimately still says "1 blocking finding demoted".)
		expect(text).toContain("[stale — re-run to confirm]");
		expect(text).not.toContain("🔴");
		expect(text).toMatch(/git-env\.test\.ts\s+1E/);
	});

	it("still serves an un-drifted blocker as blocking (control)", async () => {
		const dir = makeDir("pi-lens-modeall-fresh-keep-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		recordDiagnostics(
			consumer,
			[
				{
					severity: "error",
					semantic: "blocking",
					message: "a real blocker",
					tool: "lsp",
					rule: "ts(2305)",
					line: 1,
				},
			],
			1,
			Date.now(),
		);
		// Pin the dependency in the past — nothing drifted.
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(dep, past, past);

		const tool = makeTool(dir);
		const result = (await runModeAll(tool, dir)) as {
			content: Array<{ text: string }>;
		};
		const text = result.content.map((c) => c.text).join("\n");

		expect(text).toContain("🔴");
		expect(text).toContain("1 blocking");
		expect(text).not.toContain("[stale — re-run to confirm]");
	});

	// #2275 review F2. The widget footer's delivery cap stops RENDERING a
	// demoted row after N unconfirmed deliveries. It must not delete the
	// record: `getFileDiagnosticSummaries` (this surface) and
	// `lens_diagnostic_mark` read the same `allDiagnostics` list, so a spliced
	// entry would make an unconfirmed LSP error read as CLEAN here. The file
	// must still be listed, with its error tally intact and zero blocking, and
	// the agent must be TOLD the footer stopped showing it.
	it("still lists a footer-capped demotion, with an explicit capped note", async () => {
		const dir = makeDir("pi-lens-modeall-capped-");
		const consumer = path.join(dir, "capped.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		recordDiagnostics(
			consumer,
			[
				{
					severity: "error",
					semantic: "blocking",
					message: "No exported member 'gitEnv'",
					tool: "lsp",
					rule: "ts(2305)",
					line: 1,
				},
			],
			1,
			Date.now(),
		);
		// Demote on the drift axis, then reach the footer delivery cap.
		expect(markWidgetFileBlockersStale(consumer, "dependency-drift")).toBe(
			true,
		);
		expect(retireWidgetDependencyDriftBlockers(consumer)).toBe(true);

		const tool = makeTool(dir);
		const result = (await runModeAll(tool, dir)) as {
			content: Array<{ text: string }>;
		};
		const text = result.content.map((c) => c.text).join("\n");

		// Not clean: the file is still listed with its error tally, demoted.
		expect(text).toMatch(/capped\.ts\s+1E/);
		expect(text).toContain("[stale — re-run to confirm]");
		// Never re-asserted at full authority.
		expect(text).not.toContain("🔴");
		// And the agent is told the footer stopped showing it, and that a
		// re-run can still confirm it.
		expect(text).toContain("no longer shown in the pi-lens footer");
		expect(text).toMatch(/1 demoted finding capped/);
	});
});
