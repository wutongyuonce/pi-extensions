/**
 * Widget-store dependency-axis freshness gate (#1631, acceptance criterion 3).
 *
 * `lens_diagnostics mode=all` re-serves the session diagnostics store
 * (`widget-state`'s `allDiagnostics`). Before this gate, a BLOCKING finding on a
 * file F whose cause lived in a dependency G replayed on every `mode=all` after G was
 * fixed out-of-band — because `reconcileStaleWidgetFiles` only checks F's OWN mtime,
 * and F was never touched. This is the store-level half of the fix; the inline-blocker
 * (turn-end) half lives in `blocker-freshness.ts`. Both share the forward-import drift
 * detection and DEMOTE (mark stale) rather than drop (#1419).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearWidgetState,
	getFileDiagnosticSummaries,
	getFileDiagnostics,
	isBlocking,
	reconcileStaleWidgetDependencyBlockers,
	recordDiagnostics,
} from "../../clients/widget-state.js";

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	clearWidgetState();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function driftIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
}

function pushIntoPast(filePath: string): void {
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(filePath, past, past);
}

function recordBlocking(
	filePath: string,
	message: string,
	observedAt: number,
): void {
	recordDiagnostics(
		filePath,
		[
			{
				severity: "error",
				semantic: "blocking",
				message,
				tool: "lsp",
				rule: "ts(2305)",
				line: 1,
			},
		],
		1,
		observedAt,
	);
}

describe("widget-store dependency freshness gate (#1631)", () => {
	it("demotes a blocking finding whose dependency drifted out-of-band", async () => {
		const dir = makeDir("pi-lens-widget-fresh-caseb-");
		const consumer = path.join(dir, "git-env.test.ts");
		const dep = path.join(dir, "worktree.ts");
		fs.writeFileSync(dep, "export const other = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { gitEnv } from "./worktree.js";\nexport const t = gitEnv;\n',
		);

		// The verdict was observed 60s ago; the dependency is fixed AFTER that.
		recordBlocking(
			consumer,
			"No exported member 'gitEnv'",
			Date.now() - 60_000,
		);
		expect(
			(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
		).toBe(true);

		driftIntoFuture(dep);

		const { demoted } = await reconcileStaleWidgetDependencyBlockers(dir);
		expect(demoted).toBe(1);

		// Demoted, not dropped: the finding survives but is no longer blocking.
		const diags = getFileDiagnostics(consumer) ?? [];
		expect(diags).toHaveLength(1);
		expect(diags.some((d) => d.stale === true)).toBe(true);
		expect(diags.some((d) => isBlocking(d))).toBe(false);

		// The summary mode=all serves reflects zero blocking for the file.
		const summary = getFileDiagnosticSummaries().find(
			(s) => path.resolve(s.filePath) === path.resolve(consumer),
		);
		expect(summary?.blocking).toBe(0);
	});

	it("keeps a blocking finding whose imports did not drift", async () => {
		const dir = makeDir("pi-lens-widget-fresh-keep-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		recordBlocking(consumer, "a real blocker", Date.now() - 60_000);
		pushIntoPast(dep);

		const { demoted } = await reconcileStaleWidgetDependencyBlockers(dir);
		expect(demoted).toBe(0);
		expect(
			(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
		).toBe(true);
	});

	it("does not demote when only the file's own content drifted (that reconcile owns it)", async () => {
		// Own-file staleness is `reconcileStaleWidgetFiles`' job; the dependency gate
		// keys on imports only, so an untouched-imports file is left alone here even if
		// the file itself moved.
		const dir = makeDir("pi-lens-widget-fresh-own-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		recordBlocking(consumer, "blocker", Date.now() - 60_000);
		pushIntoPast(dep);
		driftIntoFuture(consumer); // own file drifts, dep does not

		const { demoted } = await reconcileStaleWidgetDependencyBlockers(dir);
		expect(demoted).toBe(0);
	});

	it("leaves a record with no blocking findings untouched (cheap path)", async () => {
		const dir = makeDir("pi-lens-widget-fresh-nonblocking-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		// A non-blocking warning only.
		recordDiagnostics(
			consumer,
			[{ severity: "warning", message: "a warning", tool: "eslint", line: 1 }],
			1,
			Date.now() - 60_000,
		);
		driftIntoFuture(dep);

		const { demoted } = await reconcileStaleWidgetDependencyBlockers(dir);
		expect(demoted).toBe(0);
	});

	it("is idempotent — an already-demoted finding is not re-counted", async () => {
		const dir = makeDir("pi-lens-widget-fresh-idem-");
		const consumer = path.join(dir, "consumer.ts");
		const dep = path.join(dir, "dep.ts");
		fs.writeFileSync(dep, "export const x = 1;\n");
		fs.writeFileSync(
			consumer,
			'import { x } from "./dep.js";\nexport const y = x;\n',
		);

		recordBlocking(consumer, "blocker", Date.now() - 60_000);
		driftIntoFuture(dep);

		expect((await reconcileStaleWidgetDependencyBlockers(dir)).demoted).toBe(1);
		expect((await reconcileStaleWidgetDependencyBlockers(dir)).demoted).toBe(0);
	});

	// #1631 review F4: a BLOCKING finding from a non-language-server tool (an
	// ast-grep hardcoded-secret rule, a govulncheck CVE) doesn't stop being true
	// because a file it imports changed — only a language-server verdict is
	// invalidated by that shape of drift.
	it("does not demote a non-LSP blocking finding on dependency drift", async () => {
		const dir = makeDir("pi-lens-widget-fresh-nonlsp-");
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
					message: "hardcoded secret",
					tool: "ast-grep",
					line: 1,
				},
			],
			1,
			Date.now() - 60_000,
		);
		driftIntoFuture(dep);

		const { demoted } = await reconcileStaleWidgetDependencyBlockers(dir);
		expect(demoted).toBe(0);
		expect(
			(getFileDiagnostics(consumer) ?? []).some((d) => isBlocking(d)),
		).toBe(true);
	});
});
