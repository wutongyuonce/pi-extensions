import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

// The NDJSON disposition logger is isTestMode-gated (like every pi-lens
// logger), so asserting the fields markDisposition passes requires mocking
// the module rather than reading the log file.
const logDispositionEvent = vi.hoisted(() => vi.fn());
vi.mock("../../clients/disposition-logger.js", () => ({
	logDispositionEvent: (...args: unknown[]) => logDispositionEvent(...args),
}));

import { _resetForTests as _resetBusPublishForTests } from "../../clients/bus-publish.js";
import {
	_resetDispositionPublishForTests,
	BUS_DISPOSITION_EVENT,
	BUS_DISPOSITION_VERSION,
	wireDispositionBusEmitter,
	type PilensDispositionPayload,
} from "../../clients/disposition-publish.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	_setBeforeDispositionCacheRefreshForTests,
	_setBeforeDispositionCommitForTests,
	_setDispositionStatForTests,
	anchorsForDiagnostic,
	applyDispositions,
	applyDispositionsMultiFile,
	applyWeakDispositions,
	computeStrictAnchor,
	getDisposition,
	isDeferredThisSession,
	markDisposition,
	_setMultiFileReadForTests,
} from "../../clients/diagnostic-dispositions.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

let tmpDir: string;
let previousDataDir: string | undefined;

const originalBusEnv = process.env.PI_LENS_BUS_PUBLISH;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dd-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	_setBeforeDispositionCommitForTests(null);
	_setBeforeDispositionCacheRefreshForTests(null);
	_setDispositionStatForTests(null);
	_setMultiFileReadForTests(null);
	_resetDispositionPublishForTests();
	_resetBusPublishForTests();
	logDispositionEvent.mockClear();
});

afterEach(() => {
	_setBeforeDispositionCommitForTests(null);
	_setBeforeDispositionCacheRefreshForTests(null);
	_setDispositionStatForTests(null);
	_setMultiFileReadForTests(null);
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	if (originalBusEnv === undefined) delete process.env.PI_LENS_BUS_PUBLISH;
	else process.env.PI_LENS_BUS_PUBLISH = originalBusEnv;
	_resetDispositionPublishForTests();
	_resetBusPublishForTests();
	removeTempDirSync(tmpDir);
});

describe("cross-process disposition commits (#1202)", () => {
	it("re-reads disk after a fresh module writer commits", async () => {
		const first = {
			cwd: cwd(),
			filePath: filePath(),
			tool: "eslint",
			rule: "first-rule",
			message: "first finding",
			line: 1,
			content: "const first = bad();\n",
		};
		const interleaved = {
			...first,
			rule: "second-rule",
			message: "second finding",
			content: "const second = bad();\n",
		};

		// Seed writer A's cache with a same-size predecessor. Writer B is loaded
		// through a fresh Vitest module registry and replaces only the reason with
		// an equal-length value. Restoring the old mtime deliberately defeats A's
		// mtime+size memoization, modeling filesystems whose coarse timestamp does
		// not reveal a sibling's atomic replacement.
		const secondAnchor = markDisposition(
			cwd(),
			interleaved,
			"flagged",
			"before!!",
		);
		const cachedStat = fs.statSync(statePath());
		const realStatSync = fs.statSync;
		let maskSiblingReplacement = false;
		_setDispositionStatForTests(((p, options) =>
			maskSiblingReplacement && p === statePath()
				? cachedStat
				: realStatSync(p, options as never)) as typeof fs.statSync);
		vi.resetModules();
		const writerB = await import("../../clients/diagnostic-dispositions.js");
		_setBeforeDispositionCommitForTests(() => {
			writerB.markDisposition(cwd(), interleaved, "flagged", "writer B");
			maskSiblingReplacement = true;
		});
		const firstAnchor = markDisposition(
			cwd(),
			first,
			"false-positive",
			"first",
		);
		_setDispositionStatForTests(null);
		const persisted = JSON.parse(fs.readFileSync(statePath(), "utf8")) as {
			dispositions: Record<string, { disposition: string; reason?: string }>;
		};

		expect(persisted.dispositions[firstAnchor]).toMatchObject({
			disposition: "false-positive",
			reason: "first",
		});
		expect(persisted.dispositions[secondAnchor]).toMatchObject({
			disposition: "flagged",
			reason: "writer B",
		});
	});

	it("refreshes writer A's cache before writer B can commit after lock release (#1212)", async () => {
		const writerATarget = {
			cwd: cwd(),
			filePath: filePath(),
			tool: "eslint",
			rule: "writer-a-rule",
			message: "writer A finding",
			line: 1,
			content: "const writerA = bad();\n",
		};
		const writerBTarget = {
			...writerATarget,
			rule: "writer-b-rule",
			message: "writer B finding",
			content: "const writerB = bad();\n",
		};
		vi.resetModules();
		const writerB = await import("../../clients/diagnostic-dispositions.js");
		let writerBAnchor: string | undefined;
		let committedBetweenReleaseAndRefresh = false;
		_setBeforeDispositionCacheRefreshForTests(() => {
			// With the fix, A still owns the lock here and B cannot interleave.
			// The mutation moves this callback after release, making this branch
			// commit B before A refreshes its stale committed state into the cache.
			if (fs.existsSync(`${statePath()}.lock`)) return;
			writerBAnchor = writerB.markDisposition(
				cwd(),
				writerBTarget,
				"flagged",
				"writer B committed a deliberately longer state",
			);
			committedBetweenReleaseAndRefresh = true;
		});

		markDisposition(cwd(), writerATarget, "flagged", "writer A");
		if (!committedBetweenReleaseAndRefresh) {
			writerBAnchor = writerB.markDisposition(
				cwd(),
				writerBTarget,
				"flagged",
				"writer B committed a deliberately longer state",
			);
		}

		expect(writerBAnchor).toBeDefined();
		expect(getDisposition(cwd(), writerBAnchor!)).toMatchObject({
			disposition: "flagged",
			reason: "writer B committed a deliberately longer state",
		});
	});
});

function cwd(): string {
	return path.join(tmpDir, "project");
}

function filePath(): string {
	return path.join(cwd(), "a.ts");
}

function statePath(): string {
	return path.join(
		getProjectDataDir(cwd()),
		"cache",
		"diagnostic-dispositions.json",
	);
}

describe("computeStrictAnchor (false-positive's site-specific binding)", () => {
	it("is stable when unrelated lines are inserted ABOVE the diagnostic", () => {
		const before = "const a = 1;\nconst target = bad();\n";
		const after = "const inserted = 0;\nconst a = 1;\nconst target = bad();\n";
		const anchorBefore = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			tool: "eslint",
			rule: "no-bad",
			message: "bad call",
			line: 2,
			content: before,
		});
		const anchorAfter = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			tool: "eslint",
			rule: "no-bad",
			message: "bad call",
			line: 3,
			content: after,
		});
		expect(anchorAfter).toBe(anchorBefore);
	});

	it("changes when the flagged line's content changes semantically", () => {
		const a = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "const target = bad();\n",
		});
		const b = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "const target = good();\n",
		});
		expect(b).not.toBe(a);
	});

	it("ignores pure whitespace changes on the flagged line", () => {
		const a = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "const target=bad();\n",
		});
		const b = computeStrictAnchor({
			cwd: cwd(),
			filePath: filePath(),
			rule: "r",
			message: "m",
			line: 1,
			content: "  const   target = bad();  \n",
		});
		expect(b).toBe(a);
	});
});

describe("markDisposition + applyDispositions (#690)", () => {
	const content = "const target = bad();\n";
	const diag = { tool: "eslint", rule: "no-bad", message: "bad call", line: 1 };

	it("persists false-positive/suppress/flagged to the disposition store file under getProjectDataDir", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"false-positive",
		);
		expect(fs.existsSync(statePath())).toBe(true);
		const raw = JSON.parse(fs.readFileSync(statePath(), "utf-8")) as {
			dispositions: Record<string, unknown>;
		};
		expect(Object.keys(raw.dispositions)).toHaveLength(1);
	});

	it("applyDispositions drops false-positive and suppress, but keeps flagged", () => {
		markDisposition(
			cwd(),
			{
				cwd: cwd(),
				filePath: filePath(),
				tool: "eslint",
				rule: "fp-rule",
				message: "m1",
				line: 1,
				content,
			},
			"false-positive",
		);
		markDisposition(
			cwd(),
			{
				cwd: cwd(),
				filePath: filePath(),
				tool: "eslint",
				rule: "sup-rule",
				message: "m2",
				line: 1,
				content,
			},
			"suppress",
		);
		markDisposition(
			cwd(),
			{
				cwd: cwd(),
				filePath: filePath(),
				tool: "eslint",
				rule: "flag-rule",
				message: "m3",
				line: 1,
				content,
			},
			"flagged",
		);

		const diags = [
			{ tool: "eslint", rule: "fp-rule", message: "m1", line: 1 },
			{ tool: "eslint", rule: "sup-rule", message: "m2", line: 1 },
			{ tool: "eslint", rule: "flag-rule", message: "m3", line: 1 },
		];
		const kept = applyDispositions(diags, cwd(), filePath(), content);
		expect(kept.map((d) => d.rule)).toEqual(["flag-rule"]);
	});

	it("defer drops the diagnostic for the session; _resetDeferredForTests restores it", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"defer",
		);
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([]);
		_resetDeferredForTests();
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([
			diag,
		]);
	});

	it("defer survives an edit to the flagged line itself (weak anchor)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"defer",
		);
		const editedContent = "const target = bad(1, 2, 3);\n";
		expect(applyDispositions([diag], cwd(), filePath(), editedContent)).toEqual(
			[],
		);
	});

	it("false-positive RESURFACES after the flagged line's content changes semantically", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"false-positive",
		);
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([]);
		const editedContent = "const target = good();\n";
		expect(applyDispositions([diag], cwd(), filePath(), editedContent)).toEqual(
			[diag],
		);
	});

	it("false-positive survives whitespace-only changes and unrelated-lines-above insertions", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"false-positive",
		);
		const whitespaceOnly = "  const   target = bad();  \n";
		expect(
			applyDispositions([diag], cwd(), filePath(), whitespaceOnly),
		).toEqual([]);

		const shiftedDiag = { ...diag, line: 2 };
		const withInsertedLineAbove = "// unrelated\nconst target = bad();\n";
		expect(
			applyDispositions(
				[shiftedDiag],
				cwd(),
				filePath(),
				withInsertedLineAbove,
			),
		).toEqual([]);
	});

	it("flagged tag survives a line edit (weak-anchor lookup)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
		);
		const editedContent = "const target = bad(1, 2, 3);\n";
		const { weak } = anchorsForDiagnostic(
			cwd(),
			filePath(),
			diag,
			editedContent,
		);
		expect(getDisposition(cwd(), weak)?.disposition).toBe("flagged");
	});

	it("getDisposition returns the entry, including flagged's line/lineText fix context", () => {
		const anchor = markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
			"come back to this",
		);
		const entry = getDisposition(cwd(), anchor);
		expect(entry?.disposition).toBe("flagged");
		expect(entry?.reason).toBe("come back to this");
		expect(entry?.line).toBe(1);
		expect(entry?.lineText).toBe("const target = bad();");
	});

	it("mtime memoization: a write is immediately visible to the next read (write -> read -> mark again -> read sees both)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
		);
		// Populates the read cache from disk.
		expect(applyDispositions([diag], cwd(), filePath(), content)).toEqual([
			diag,
		]);

		const diag2 = { tool: "eslint", rule: "second", message: "m2", line: 1 };
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag2, content },
			"false-positive",
		);
		// Both marks must be visible: diag (flagged) kept, diag2 (false-positive)
		// dropped — proves the cache was refreshed by the second write rather than
		// serving the stale single-entry snapshot from the first read.
		const kept = applyDispositions([diag, diag2], cwd(), filePath(), content);
		expect(kept.map((d) => d.rule)).toEqual(["no-bad"]);
	});
});

describe("applyDispositionsMultiFile (#1617 — cross-file lanes: gitleaks/trivy/govulncheck)", () => {
	it("groups by each diagnostic's own filePath and reads each file's own content, not one shared file", () => {
		const projectDir = cwd();
		fs.mkdirSync(projectDir, { recursive: true });
		const fileA = path.join(projectDir, "a.ts");
		const fileB = path.join(projectDir, "b.ts");
		fs.writeFileSync(fileA, "const secretA = 'aaa';\n");
		fs.writeFileSync(fileB, "const secretB = 'bbb';\n");

		const diagA = {
			filePath: fileA,
			tool: "gitleaks",
			rule: "gitleaks:generic",
			message: "Potential secret: generic",
			line: 1,
		};
		const diagB = {
			filePath: fileB,
			tool: "gitleaks",
			rule: "gitleaks:generic",
			message: "Potential secret: generic",
			line: 1,
		};

		markDisposition(
			projectDir,
			{ ...diagA, cwd: projectDir, content: "const secretA = 'aaa';\n" },
			"false-positive",
		);

		// diagA is marked fp (dropped); diagB is unmarked (kept) — proves each
		// group reads its OWN file's content, not fileA's content applied to
		// both (which would either wrongly drop both or wrongly keep both).
		const kept = applyDispositionsMultiFile(
			[diagA, diagB],
			projectDir,
			(d) => d.filePath,
		);
		expect(kept).toEqual([diagB]);
	});

	it("F2 (#1625 review round): reads NO file content when the disposition store is empty (hoisted early return)", () => {
		// The overwhelmingly common case (a scan with zero marks) used to pay
		// one fs.readFileSync PER FILE GROUP just to discover there was nothing
		// to filter — measured ~270ms/analyzer/run across 9 mode=full lanes.
		// The empty-store check must short-circuit before any per-group read.
		const projectDir = cwd();
		fs.mkdirSync(projectDir, { recursive: true });
		const fileA = path.join(projectDir, "a.ts");
		const fileB = path.join(projectDir, "b.ts");
		fs.writeFileSync(fileA, "const secretA = 'aaa';\n");
		fs.writeFileSync(fileB, "const secretB = 'bbb';\n");
		const diagA = { filePath: fileA, tool: "gitleaks", message: "m", line: 1 };
		const diagB = { filePath: fileB, tool: "gitleaks", message: "m", line: 1 };

		const readSpy = vi.fn(fs.readFileSync);
		_setMultiFileReadForTests(readSpy as unknown as typeof fs.readFileSync);
		try {
			const kept = applyDispositionsMultiFile(
				[diagA, diagB],
				projectDir,
				(d) => d.filePath,
			);
			expect(kept).toEqual([diagA, diagB]);
			expect(readSpy).not.toHaveBeenCalled();
		} finally {
			_setMultiFileReadForTests(null);
		}
	});

	it("preserves the caller's original element order across file groups", () => {
		const projectDir = cwd();
		fs.mkdirSync(projectDir, { recursive: true });
		const fileA = path.join(projectDir, "a.ts");
		const fileB = path.join(projectDir, "b.ts");
		fs.writeFileSync(fileA, "x\n");
		fs.writeFileSync(fileB, "y\n");
		const d1 = { filePath: fileA, message: "m1", line: 1 };
		const d2 = { filePath: fileB, message: "m2", line: 1 };
		const d3 = { filePath: fileA, message: "m3", line: 1 };
		expect(
			applyDispositionsMultiFile([d1, d2, d3], projectDir, (d) => d.filePath),
		).toEqual([d1, d2, d3]);
	});

	it("fails OPEN (still reports) a false-positive check when the file can't be read, but a weak-anchored suppress mark still applies with no content needed", () => {
		const projectDir = cwd();
		fs.mkdirSync(projectDir, { recursive: true });
		const missingFile = path.join(projectDir, "does-not-exist.ts");

		const fpTarget = {
			filePath: missingFile,
			tool: "trivy",
			rule: "trivy:CVE-1",
			message: "vuln",
			line: 1,
		};
		// A false-positive mark made when the file DID exist (real content) —
		// simulates the file having since been deleted before the next scan.
		markDisposition(
			projectDir,
			{ ...fpTarget, cwd: projectDir, content: "package foo v1\n" },
			"false-positive",
		);
		// The strict anchor's line-content hash can't be recomputed without the
		// file, so it can't match the stored mark — fails open (still reported)
		// rather than silently dropping a security finding on a read failure.
		expect(
			applyDispositionsMultiFile([fpTarget], projectDir, (d) => d.filePath),
		).toEqual([fpTarget]);

		// suppress is WEAK-anchored (never looks at content at all — see module
		// doc), so it applies unconditionally even though the file is missing.
		const suppressTarget = {
			filePath: missingFile,
			tool: "trivy",
			rule: "trivy:CVE-2",
			message: "vuln 2",
			line: 1,
		};
		markDisposition(
			projectDir,
			{ ...suppressTarget, cwd: projectDir },
			"suppress",
		);
		expect(
			applyDispositionsMultiFile(
				[suppressTarget],
				projectDir,
				(d) => d.filePath,
			),
		).toEqual([]);
	});
});

describe("F1 (#1625 review round): blocking findings require a STRICT anchor to suppress", () => {
	// Two DISTINCT secrets, same tool/rule/message (the realistic shape: two
	// different AWS keys flagged by the same gitleaks rule) — they share ONE
	// weak anchor (`relativeFile|tool|rule|normalizedMessage`, no line-content
	// hash) but two DIFFERENT strict anchors (each hashes its own line).
	// `cwd()`/`filePath()` read `tmpDir`, which is only set inside `beforeEach`
	// — computed lazily per test, not at describe-body evaluation time, or
	// every one of these would read `tmpDir === undefined`.
	const content =
		"const keyA = 'AKIAABCDEFGHIJKLMNOP';\nconst keyB = 'AKIAQRSTUVWXYZ123456';\n";
	function secret(line: 1 | 2) {
		return {
			cwd: cwd(),
			filePath: filePath(),
			tool: "gitleaks",
			rule: "gitleaks:generic-api-key",
			message: "Potential secret: generic-api-key",
			line,
			semantic: "blocking" as const,
		};
	}

	it("a WEAK-anchor suppress on one does NOT drop either blocking finding (both still block)", () => {
		const finding1 = secret(1);
		const finding2 = secret(2);
		markDisposition(cwd(), { ...finding1, content }, "suppress");
		const kept = applyDispositions(
			[finding1, finding2],
			cwd(),
			filePath(),
			content,
		);
		expect(kept).toEqual([finding1, finding2]);
	});

	it("a WEAK-anchor defer on one does NOT drop either blocking finding (both still block)", () => {
		const finding1 = secret(1);
		const finding2 = secret(2);
		markDisposition(cwd(), { ...finding1, content }, "defer");
		const kept = applyDispositions(
			[finding1, finding2],
			cwd(),
			filePath(),
			content,
		);
		expect(kept).toEqual([finding1, finding2]);
	});

	it("a STRICT-anchor (false-positive) mark on one drops ONLY that one", () => {
		const finding1 = secret(1);
		const finding2 = secret(2);
		markDisposition(cwd(), { ...finding1, content }, "false-positive");
		const kept = applyDispositions(
			[finding1, finding2],
			cwd(),
			filePath(),
			content,
		);
		expect(kept).toEqual([finding2]);
	});

	it("a non-blocking (warning-tier) finding is still suppressible via weak anchor, unchanged", () => {
		const warning1 = { ...secret(1), semantic: "warning" as const };
		const warning2 = { ...secret(2), semantic: "warning" as const };
		markDisposition(cwd(), { ...warning1, content }, "suppress");
		const kept = applyDispositions(
			[warning1, warning2],
			cwd(),
			filePath(),
			content,
		);
		// Weak suppress still collapses both non-blocking findings — F1 only
		// tightens the blocking tier, it doesn't touch existing behavior here.
		expect(kept).toEqual([]);
	});

	it("applyWeakDispositions (the cache-only instant filter) never drops a blocking finding, even with a weak suppress mark", () => {
		const finding1 = secret(1);
		const finding2 = secret(2);
		markDisposition(cwd(), { ...finding1, content }, "suppress");
		const kept = applyWeakDispositions([finding1, finding2], cwd(), filePath());
		expect(kept).toEqual([finding1, finding2]);
	});
});

describe("F3 (#1625 review round): deferredThisSession is scoped per-project, not process-global", () => {
	// `deferredThisSession` is a single module-level Set — but a WEAK anchor
	// only encodes a RELATIVE path (`relativeFile` derives it from
	// `path.relative(cwd, filePath)`) plus tool/rule/normalizedMessage, never
	// the cwd's own identity. Two unrelated projects sharing the same
	// relative path/tool/rule/message therefore compute the IDENTICAL weak
	// anchor string. Uses a non-blocking (no `semantic`) finding so F1's
	// blocking-tier gate doesn't itself block the drop and mask what F3 is
	// actually testing (cwd scoping).
	function projectDirs(): { projectA: string; projectB: string } {
		return {
			projectA: path.join(tmpDir, "project-a"),
			projectB: path.join(tmpDir, "project-b"),
		};
	}
	function finding(projectDir: string) {
		return {
			cwd: projectDir,
			filePath: path.join(projectDir, "a.ts"),
			tool: "eslint",
			rule: "no-bad",
			message: "bad call",
			line: 1,
		};
	}
	const content = "const target = bad();\n";

	it("a defer in project A does not suppress the identical relative-path finding in project B", () => {
		const { projectA, projectB } = projectDirs();
		const findingA = finding(projectA);
		const findingB = finding(projectB);

		markDisposition(projectA, { ...findingA, content }, "defer");

		// Project A's own finding IS deferred.
		expect(
			applyDispositions([findingA], projectA, findingA.filePath, content),
		).toEqual([]);
		// Project B's finding — same relative path, tool, rule, message — must
		// NOT be affected by project A's defer.
		expect(
			applyDispositions([findingB], projectB, findingB.filePath, content),
		).toEqual([findingB]);
	});

	it("isDeferredThisSession requires the SAME cwd the defer was made under", () => {
		const { projectA, projectB } = projectDirs();
		const findingA = finding(projectA);
		const anchor = markDisposition(projectA, { ...findingA, content }, "defer");

		expect(isDeferredThisSession(projectA, anchor)).toBe(true);
		expect(isDeferredThisSession(projectB, anchor)).toBe(false);
	});
});

describe("anchor path-form stability (#1024 — write raw vs read normalized)", () => {
	// The mark tool (lens-diagnostic-mark.ts) anchors a disposition under a RAW
	// cwd / `path.resolve(cwd, arg)` path, while the dispatch read side
	// (dispatcher.ts) looks it up under the `normalizeMapKey`-canonicalized form.
	// Before #1024, `relativeFile` computed `path.relative` on whichever form the
	// caller passed, so a Windows drive/segment case (or symlink/realpath)
	// difference between the two forms silently orphaned the agent's own mark and
	// the "resolved" diagnostic kept re-firing (a #533 dropped-signal). The fix
	// canonicalizes both inputs through `normalizeMapKey` inside `relativeFile`,
	// so write and read derive identical anchors regardless of the form held.
	it("finds a false-positive mark written under a raw (mis-cased) path form when applied via the normalizeMapKey form", (ctx) => {
		const projectDir = cwd();
		// Real on-disk casing: lowercase `sub`.
		const subDirOnDisk = path.join(projectDir, "sub");
		fs.mkdirSync(subDirOnDisk, { recursive: true });
		const fileOnDisk = path.join(subDirOnDisk, "a.ts");
		const content = "const target = bad();\n";
		fs.writeFileSync(fileOnDisk, content);

		// WRITE form: a mis-cased segment (`SUB`), as a raw path.resolve(cwd, arg)
		// that never went through realpath canonicalization would carry.
		const rawFile = path.join(projectDir, "SUB", "a.ts");
		// READ form: the normalizeMapKey-canonicalized cwd/filePath the dispatcher
		// derives in createDispatchContext.
		const normalizedCwd = normalizeMapKey(projectDir);
		const normalizedFile = normalizeMapKey(fileOnDisk);

		// This mis-cased scenario only reproduces the bug on a CASE-INSENSITIVE
		// filesystem, where `SUB/a.ts` and the real `sub/a.ts` are the SAME file —
		// so a raw mis-cased write and a realpath-canonicalized read SHOULD collapse
		// to one anchor. On a case-sensitive FS (Linux CI) they are genuinely
		// DIFFERENT files: realpath of the non-existent `SUB` can't unify them and
		// must not, so there is nothing to regress. Probe the actual filesystem (not
		// the OS name) and skip VISIBLY when mis-casing doesn't alias — a bare
		// return would report a pass (#2089). (The prior `rawRel === normRel` guard
		// mis-fired on Linux — the forms differ textually there but never alias —
		// which surfaced as a CI failure on #1024's PR.)
		ctx.skip(
			!fs.existsSync(rawFile),
			"case-sensitive filesystem: SUB/a.ts does not alias sub/a.ts",
		);

		const diag = {
			tool: "eslint",
			rule: "no-bad",
			message: "bad call",
			line: 1,
		};
		markDisposition(
			projectDir,
			{ cwd: projectDir, filePath: rawFile, ...diag, content },
			"false-positive",
		);

		// Pre-fix: the raw-form write anchored under `SUB/a.ts` while this
		// normalized-form read derives `sub/a.ts`, so the mark is not found and the
		// diagnostic survives (kept === [diag]). Post-fix both derive the same
		// canonical anchor, so the mark is found and the diagnostic is suppressed.
		const kept = applyDispositions(
			[diag],
			normalizedCwd,
			normalizedFile,
			content,
		);
		expect(kept).toEqual([]);
	});
});

describe("writeState atomicity (#690 — cross-process reader safety)", () => {
	const content = "const target = bad();\n";
	const diag = { tool: "eslint", rule: "no-bad", message: "bad call", line: 1 };

	it("leaves no tmp file behind after a successful mark", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
		);
		const dir = path.dirname(statePath());
		const leftovers = fs
			.readdirSync(dir)
			.filter((name) => name.includes(".tmp-"));
		expect(leftovers).toEqual([]);
	});

	it("state survives a write -> fresh-process-style read round-trip", () => {
		const anchor = markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
			"round trip",
		);
		// Simulate a separate process: reset the module cache and re-read purely
		// from disk rather than the in-memory stateCache.
		_resetStateCacheForTests();
		const entry = getDisposition(cwd(), anchor);
		expect(entry?.disposition).toBe("flagged");
		expect(entry?.reason).toBe("round trip");
	});

	it("a large write is never observable as truncated/partial JSON (tmp+rename exercised)", () => {
		// Write a big state, then read the raw bytes back off disk directly
		// (bypassing the module's own cache) — it must fully parse every time,
		// never fail partway as it would from a torn direct-writeFileSync.
		for (let i = 0; i < 200; i++) {
			markDisposition(
				cwd(),
				{
					cwd: cwd(),
					filePath: filePath(),
					tool: "eslint",
					rule: `rule-${i}`,
					message: `message number ${i} `.repeat(20),
					line: 1,
					content,
				},
				"flagged",
			);
		}
		const raw = fs.readFileSync(statePath(), "utf-8");
		const parsed = JSON.parse(raw) as { dispositions: Record<string, unknown> };
		expect(Object.keys(parsed.dispositions)).toHaveLength(200);
	});
});

describe("mark telemetry (#690 — NDJSON log + pilens:diagnostic:disposition)", () => {
	const content = "const target = bad();\n";
	const diag = { tool: "eslint", rule: "no-bad", message: "bad call", line: 1 };

	function mark(
		disposition: "false-positive" | "suppress" | "defer" | "flagged",
		reason?: string,
	) {
		return markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			disposition,
			reason,
		);
	}

	it("markDisposition logs a mark entry with the full field set (project-relative path)", () => {
		const anchor = mark("false-positive", "rule misfires on generics");
		expect(logDispositionEvent).toHaveBeenCalledTimes(1);
		expect(logDispositionEvent).toHaveBeenCalledWith({
			event: "mark",
			disposition: "false-positive",
			tool: "eslint",
			rule: "no-bad",
			filePath: "a.ts",
			line: 1,
			reason: "rule misfires on generics",
			anchor,
			previousDisposition: undefined,
		});
	});

	it("logs previousDisposition when a re-mark overwrites an existing store entry", () => {
		mark("flagged");
		logDispositionEvent.mockClear();
		mark("suppress");
		expect(logDispositionEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				disposition: "suppress",
				previousDisposition: "flagged",
			}),
		);
	});

	it("logs defer marks too — the log is their only durable trace", () => {
		mark("defer");
		expect(logDispositionEvent).toHaveBeenCalledWith(
			expect.objectContaining({ event: "mark", disposition: "defer" }),
		);
	});

	it("publishes the v1 bus payload when an emitter is wired", () => {
		const emit = vi.fn();
		wireDispositionBusEmitter(emit);

		const anchor = mark("flagged", "fix later");

		expect(emit).toHaveBeenCalledTimes(1);
		const [channel, payload] = emit.mock.calls[0] as [
			string,
			PilensDispositionPayload,
		];
		expect(channel).toBe(BUS_DISPOSITION_EVENT);
		expect(payload.v).toBe(BUS_DISPOSITION_VERSION);
		expect(payload.source).toBe("pi-lens");
		expect(payload.disposition).toBe("flagged");
		expect(payload.tool).toBe("eslint");
		expect(payload.rule).toBe("no-bad");
		expect(payload.line).toBe(1);
		expect(payload.anchor).toBe(anchor);
		expect(payload.reason).toBe("fix later");
		// filePath is absolute + normalized (forward slashes), unlike the log's
		// project-relative one.
		expect(payload.filePath).not.toContain("\\");
		expect(payload.filePath.endsWith("/a.ts")).toBe(true);
	});

	it("is a silent no-op (mark still succeeds) when no emitter is wired", () => {
		expect(() => mark("flagged")).not.toThrow();
		expect(getDisposition(cwd(), mark("flagged"))?.disposition).toBe("flagged");
	});

	it("respects the PI_LENS_BUS_PUBLISH=0 kill switch", () => {
		process.env.PI_LENS_BUS_PUBLISH = "0";
		_resetBusPublishForTests();
		const emit = vi.fn();
		wireDispositionBusEmitter(emit);

		mark("false-positive");

		expect(emit).not.toHaveBeenCalled();
		// The NDJSON log is independent of the bus kill switch — still records.
		expect(logDispositionEvent).toHaveBeenCalledTimes(1);
	});

	it("attributes the mark to model/provider when an identity is supplied (#1448)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
			undefined,
			{ model: "claude-sonnet-4-5", provider: "anthropic" },
		);
		expect(logDispositionEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-sonnet-4-5",
				provider: "anthropic",
			}),
		);
	});

	it("leaves model/provider blank when no identity is supplied", () => {
		mark("flagged");
		expect(logDispositionEvent).toHaveBeenCalledWith(
			expect.objectContaining({ model: undefined, provider: undefined }),
		);
	});

	it("swallows an emit throw — the mark itself must never fail on telemetry", () => {
		wireDispositionBusEmitter(() => {
			throw new Error("bus explosion");
		});
		expect(() => mark("flagged")).not.toThrow();
		expect(getDisposition(cwd(), mark("flagged"))?.disposition).toBe("flagged");
	});
});

describe("applyWeakDispositions (#755 — instant cache-only filter)", () => {
	const content = "const target = bad();\n";
	const diag = { tool: "eslint", rule: "no-bad", message: "bad call", line: 1 };
	const other = { tool: "eslint", rule: "keep", message: "keep me", line: 2 };

	it("drops a suppress-marked finding WITHOUT being given any file content", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"suppress",
		);
		// No content argument — proves the weak filter needs zero file I/O.
		const kept = applyWeakDispositions([diag, other], cwd(), filePath());
		expect(kept.map((d) => d.rule)).toEqual(["keep"]);
	});

	it("drops a finding deferred this session", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"defer",
		);
		const kept = applyWeakDispositions([diag, other], cwd(), filePath());
		expect(kept.map((d) => d.rule)).toEqual(["keep"]);
	});

	it("does NOT drop a false-positive — that is strict-anchored and only filters where content is available", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"false-positive",
		);
		// Deliberate: false-positive re-derivation needs the flagged line's
		// content, which the instant modes don't read. It still filters via
		// applyDispositions (content in hand) on the next dispatch / in mode=full.
		const kept = applyWeakDispositions([diag, other], cwd(), filePath());
		expect(kept.map((d) => d.rule)).toEqual(["no-bad", "keep"]);
		// ...and the content-based filter DOES drop it, confirming the mark itself
		// is sound and it's only the weak filter that intentionally skips it.
		const strictKept = applyDispositions(
			[diag, other],
			cwd(),
			filePath(),
			content,
		);
		expect(strictKept.map((d) => d.rule)).toEqual(["keep"]);
	});

	it("keeps a flagged finding (flagged is surfaced, not hidden)", () => {
		markDisposition(
			cwd(),
			{ cwd: cwd(), filePath: filePath(), ...diag, content },
			"flagged",
		);
		const kept = applyWeakDispositions([diag, other], cwd(), filePath());
		expect(kept.map((d) => d.rule)).toEqual(["no-bad", "keep"]);
	});

	it("passes everything through when the store is empty (fast path)", () => {
		const input = [diag, other];
		const kept = applyWeakDispositions(input, cwd(), filePath());
		expect(kept).toBe(input);
	});
});
