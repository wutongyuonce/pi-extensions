import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
} from "../../scripts/lib/scratch-dir.mjs";
import { createRealPiProject, withRealPi } from "../support/real-pi-harness.js";

/**
 * Read the cross-session project-diagnostics snapshot both sessions share.
 *
 * It lives under the `getProjectDataDir` slug for the project root inside the
 * shared `PI_LENS_HOME`, so this walks the one `projects/*` entry that home
 * has. Returning the raw text is deliberate: the assertions below are about
 * what the DURABLE record still says at the moment the second session reads
 * it, not about the shape the loader parses it into.
 */
function inheritedProjectSnapshots(home: string): string[] {
	const projects = path.join(home, "projects");
	if (!existsSync(projects)) return [];
	const found: string[] = [];
	for (const slug of readdirSync(projects)) {
		const file = path.join(projects, slug, "cache", "project-diagnostics.json");
		if (existsSync(file)) found.push(readFileSync(file, "utf8"));
	}
	return found;
}

// flake-shape: real-process-spawn — this sequence must cross the registered pi tool boundary
describe("real pi harness: diagnostic provenance", () => {
	it("retires a clean runner finding after an out-of-band line shift", async () => {
		await withRealPi(
			{ fixture: "diagnostic-provenance", script: "script.json" },
			async (pi) => {
				await pi.prompt("record the diagnostic");
				const before = await pi.awaitToolResult("lens_diagnostics");
				const beforeText = JSON.stringify(before);
				expect(beforeText).toContain("staleExport");
				expect(beforeText).toContain("L41");

				const file = path.join(pi.projectPath(), "src", "moved.ts");
				const source = readFileSync(file, "utf8");
				writeFileSync(
					file,
					`// out-of-band 01\n// out-of-band 02\n// out-of-band 03\n${source.replace("export const staleExport = 2;\n", "")}`,
				);

				await pi.awaitAssistantTurn();
				await pi.prompt("recheck after the external clean edit");
				const after = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(after)).not.toContain("staleExport");

				await pi.awaitAssistantTurn();
				await pi.prompt("compare delta");
				const delta = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(delta)).not.toContain("staleExport");

				await pi.awaitAssistantTurn();
				await pi.prompt("compare session view");
				const all = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(all)).not.toContain("staleExport");
			},
		);
	}, 60_000);

	/**
	 * The clean change every two-session case below makes, out of band, while
	 * session A is still live: the export knip reported and the statement the
	 * cheap tier reported are both removed, and three lines are prepended so a
	 * replayed row cannot coincidentally still match its old coordinates (the
	 * #2868 line-movement axis, now across a session boundary).
	 *
	 * `preserveMtime` restores the file's timestamps afterwards. That is not a
	 * contrivance: `scanProjectDiagnostics` stamps one `scannedAt` AFTER its
	 * file loop has read every file, so an ordinary edit that lands while the
	 * scan is in flight produces exactly this state — new bytes, an mtime at or
	 * before `scannedAt` — and mtime is the only content axis the cheap-tier
	 * snapshot carries. `utimesSync` reproduces it deterministically instead of
	 * racing a real scan.
	 */
	function makeCleanChange(
		file: string,
		{ preserveMtime = false }: { preserveMtime?: boolean } = {},
	): void {
		const before = statSync(file);
		const source = readFileSync(file, "utf8");
		writeFileSync(
			file,
			`// out-of-band 01\n// out-of-band 02\n// out-of-band 03\n${source
				.replace("export const staleExport = 2;\n", "")
				.replace("\tdebugger;\n", "")}`,
		);
		if (preserveMtime) utimesSync(file, before.atime, before.mtime);
	}

	/**
	 * Drive the four `lens_diagnostics` modes of `two-sessions-b.json` in a
	 * second live session and assert what the session may and may not serve.
	 *
	 * Anti-vacuity is the `trip` half: a session that reported nothing at all
	 * would satisfy the two `not.toContain` assertions. `trip` survived the
	 * edit, so every scanning mode must still name it — at its POST-edit line,
	 * never the line session A recorded. `delta` is exempt because a fresh
	 * session's turn delta is legitimately empty.
	 */
	async function expectSessionBClean(
		sessionB: Awaited<Parameters<Parameters<typeof withRealPi>[1]>[0]>,
	): Promise<void> {
		for (const mode of ["cached full", "delta", "fresh full", "session view"]) {
			await sessionB.prompt(`session B ${mode}`);
			const served = JSON.stringify(
				await sessionB.awaitToolResult("lens_diagnostics"),
			);
			expect(served, mode).not.toContain("staleExport");
			expect(served, mode).not.toContain("debugger-statement");
			if (mode !== "delta") {
				expect(served, mode).toContain("trip");
				expect(served, mode).toContain("L45");
			}
			await sessionB.awaitAssistantTurn();
		}
	}

	/**
	 * #2154 AC1, second half — the reported incident's own shape, which the
	 * single-session case above cannot reach: TWO LIVE `pi` sessions in one
	 * repository, the finding recorded by one and the condition removed while
	 * the other is running.
	 *
	 * Both children resolve the SAME project root (one `createRealPiProject`
	 * tree) and the SAME `PI_LENS_HOME`, so they share every store keyed by
	 * those two — in particular `cache/project-diagnostics.json`, the snapshot
	 * `clients/project-diagnostics/scanner.ts` calls "the authoritative
	 * cross-session cache". That store is the delivery channel AC2 is about:
	 * its key carries the project root (the data-dir slug) and nothing about
	 * the session or the content generation.
	 *
	 * Session A records both producer arms in one call — the cheap tier's
	 * blocking `debugger-statement`, which is what lands in that shared
	 * snapshot, and knip's `staleExport`, the reporter's own "Unused export"
	 * shape.
	 */
	it("does not serve a second live session the findings the first recorded before a clean edit", async () => {
		const project = createRealPiProject("diagnostic-provenance");
		const home = claimScratchDir(SCRATCH_DIR_ROOT, "real-pi-home");
		try {
			await withRealPi(
				{
					fixture: "diagnostic-provenance",
					script: "two-sessions-a.json",
					project,
					home,
				},
				async (sessionA) => {
					await sessionA.prompt("session A records the findings");
					const recorded = JSON.stringify(
						await sessionA.awaitToolResult("lens_diagnostics"),
					);
					expect(recorded).toContain("staleExport");
					expect(recorded).toContain("debugger-statement");

					makeCleanChange(path.join(project, "src", "moved.ts"));

					// Anti-vacuity: the stale row session B could serve is really on
					// disk in the shared store when B starts. Without this the "B is
					// clean" assertions would also pass if nothing had ever been
					// persisted for B to inherit.
					const snapshots = inheritedProjectSnapshots(home);
					expect(snapshots.length).toBe(1);
					expect(snapshots[0]).toContain("debugger-statement");

					await withRealPi(
						{
							fixture: "diagnostic-provenance",
							script: "two-sessions-b.json",
							project,
							home,
						},
						async (sessionB) => {
							expect(sessionB.projectPath()).toBe(sessionA.projectPath());
							await expectSessionBClean(sessionB);
						},
					);
				},
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);

	/**
	 * #3060 review F1 — the same two sessions, with the clean change's mtime
	 * left at its pre-edit value.
	 *
	 * This is the state an edit that lands DURING a cheap-tier scan produces on
	 * its own (see `makeCleanChange`), and before this round it made session B
	 * render session A's removed `debugger` statement as a current blocking
	 * error, with no stale marker, for that session and every later one: the
	 * snapshot's only content axis is `mtime <= scannedAt`, which such a file
	 * satisfies forever. The fix gives the snapshot's rows the second content
	 * axis the LSP store has carried since #2300/#1095, so the row is judged by
	 * the bytes it was computed from, not by a timestamp comparison the
	 * producer cannot make safe.
	 */
	it("does not serve a second live session a finding whose file changed without an mtime bump", async () => {
		const project = createRealPiProject("diagnostic-provenance");
		const home = claimScratchDir(SCRATCH_DIR_ROOT, "real-pi-home");
		try {
			await withRealPi(
				{
					fixture: "diagnostic-provenance",
					script: "two-sessions-a.json",
					project,
					home,
				},
				async (sessionA) => {
					await sessionA.prompt("session A records the findings");
					const recorded = JSON.stringify(
						await sessionA.awaitToolResult("lens_diagnostics"),
					);
					expect(recorded).toContain("debugger-statement");

					const file = path.join(project, "src", "moved.ts");
					const scannedMtimeMs = statSync(file).mtimeMs;
					makeCleanChange(file, { preserveMtime: true });
					// `utimesSync` restores at millisecond granularity, so the value
					// can land a fraction either side of the original. What matters
					// is that it did not advance to NOW the way an ordinary write
					// does — the snapshot's only content axis is `mtime <= scannedAt`
					// (with a 50 ms drift tolerance), and this file still satisfies
					// it while its bytes no longer match.
					expect(
						Math.abs(statSync(file).mtimeMs - scannedMtimeMs),
					).toBeLessThan(1);

					const snapshots = inheritedProjectSnapshots(home);
					expect(snapshots.length).toBe(1);
					expect(snapshots[0]).toContain("debugger-statement");

					await withRealPi(
						{
							fixture: "diagnostic-provenance",
							script: "two-sessions-b.json",
							project,
							home,
						},
						async (sessionB) => {
							await expectSessionBClean(sessionB);
							// The retirement is observable, not silent: one bounded
							// latency row per mode=full call that actually dropped
							// rows, in the shared home both sessions write to.
							const retired = sessionB.lens
								.latencyRows()
								.filter((row) => row.phase === "project_snapshot_rows_retired");
							expect(retired.length).toBeGreaterThan(0);
							expect(
								(retired[0]?.metadata as { files?: number } | undefined)?.files,
							).toBeGreaterThan(0);
						},
					);
				},
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);

	/**
	 * #3060 review F2 — the reporter's own configuration: two sessions in two
	 * WORKTREES of one repository, not two sessions in one tree. Two project
	 * roots under one `PI_LENS_HOME` resolve to two `getProjectDataDir` slugs,
	 * so the worktree session must never name the parent tree's root or serve
	 * its rows. `tests/clients/project-diagnostics.test.ts` pins that key
	 * derivation at the store seam; this pins the whole delivery path with two
	 * live children, which is the configuration the report describes.
	 */
	it("does not serve a session in a sibling worktree the other worktree's findings", async () => {
		const parent = createRealPiProject("diagnostic-provenance");
		const worktree = createRealPiProject("diagnostic-provenance");
		const home = claimScratchDir(SCRATCH_DIR_ROOT, "real-pi-home");
		try {
			await withRealPi(
				{
					fixture: "diagnostic-provenance",
					script: "two-sessions-a.json",
					project: parent,
					home,
				},
				async (parentSession) => {
					await parentSession.prompt("parent worktree records the findings");
					const recorded = JSON.stringify(
						await parentSession.awaitToolResult("lens_diagnostics"),
					);
					expect(recorded).toContain("debugger-statement");
					expect(recorded).toContain(parent);

					await withRealPi(
						{
							fixture: "diagnostic-provenance",
							script: "two-sessions-b.json",
							project: worktree,
							home,
						},
						async (worktreeSession) => {
							expect(worktreeSession.projectPath()).toBe(worktree);
							// The load-bearing turn (#3060 round 2 F2): this session's
							// FIRST call is `refreshRunners=cached`, and this worktree
							// has never been scanned, so its own snapshot store is
							// empty. Anything the cached read serves can only have come
							// from the sibling root's store. A rescanning turn could
							// not make that claim — it would find its own copy of the
							// same fixture and pass either way.
							await worktreeSession.prompt("worktree session cached read");
							const cached = JSON.stringify(
								await worktreeSession.awaitToolResult("lens_diagnostics"),
							);
							// The parent's ROOT is never named — the stronger claim than
							// "no matching row", since both trees hold a same-named file
							// with the same finding.
							expect(cached).not.toContain(parent);
							expect(cached).toContain(worktree);

							// Then let this worktree populate its OWN store, so the
							// two-stores assertion below is about two real records.
							await worktreeSession.awaitAssistantTurn();
							await worktreeSession.prompt("worktree session delta");
							await worktreeSession.awaitToolResult("lens_diagnostics");
							await worktreeSession.awaitAssistantTurn();
							await worktreeSession.prompt("worktree session scans");
							const scanned = JSON.stringify(
								await worktreeSession.awaitToolResult("lens_diagnostics"),
							);
							expect(scanned).not.toContain(parent);
							expect(scanned).toContain("debugger-statement");
						},
					);
					// Two roots, two stores: the parent's own snapshot is still there
					// beside the worktree's, which is what "keyed by root" means.
					expect(inheritedProjectSnapshots(home).length).toBe(2);
				},
			);
		} finally {
			rmSync(parent, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);
});
