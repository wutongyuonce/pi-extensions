import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDispatchContext } from "../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	stripSource,
} from "../support/sweep-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

/**
 * #2016. Two halves of one invariant.
 *
 * Half one: `createDispatchContext` normalizes `filePath`, `cwd`, and
 * `projectRoot`, so re-normalizing them downstream is a pure syscall.
 *
 * Half two: no call site re-normalizes them. That half is a source scan,
 * because the waste is invisible to a behavioral assertion: on POSIX the
 * redundant call short-circuits and returns the same string, so a value test
 * passes either way. Only the source can tell the difference on CI.
 */
describe("dispatch context normalization invariant (#2016)", () => {
	it("normalizes filePath, cwd, and projectRoot at construction", () => {
		const env = setupTestEnvironment("pi-lens-2016-ctx-");
		try {
			const target = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			const pi = {
				getFlag: () => undefined,
			} as unknown as Parameters<typeof createDispatchContext>[2];

			const ctx = createDispatchContext(
				target,
				env.tmpDir,
				pi,
				new FactStore(),
				false,
				undefined,
				env.tmpDir,
			);

			// Idempotence is the property the call sites rely on: normalizing an
			// already-normalized value must be a no-op, or dropping the redundant
			// call would change a key.
			expect(normalizeMapKey(ctx.filePath)).toBe(ctx.filePath);
			expect(normalizeMapKey(ctx.cwd)).toBe(ctx.cwd);
			expect(ctx.projectRoot).toBeDefined();
			expect(normalizeMapKey(ctx.projectRoot as string)).toBe(ctx.projectRoot);
		} finally {
			env.cleanup();
		}
		// Generous budget: this drives the real constructor, which loads project
		// config and reads a file prefix. Under a loaded parallel run the default
		// 5s budget is a flake, not a signal.
	}, 30_000);

	it("has no call site that re-normalizes an already-normalized context field", () => {
		const repoRoot = path.resolve(import.meta.dirname, "..", "..");
		const roots = ["clients", "tools", "mcp", "index.ts"];

		// A DispatchContext arrives under one of these receiver names.
		const RECEIVERS = "ctx|context|dispatchContext";
		const FIELDS = "filePath|cwd|projectRoot";
		const receiverCall = new RegExp(
			`normalizeMapKey\\(\\s*(?:${RECEIVERS})\\.(?:${FIELDS})\\b`,
		);
		// A local bound to a context field INHERITS the invariant, and the four
		// `projectRoot` sites this PR fixed read exactly such a local
		// (`const projectRoot = ctx.projectRoot ?? ctx.cwd`, dispatcher.ts:815).
		// A receiver-only pattern cannot see them: the fix-round reviewer restored
		// the call on that local and all 61 tests stayed green. Resolve the
		// aliases per file and forbid the call on them too.
		const aliasDeclaration = new RegExp(
			`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*?` +
				`\\b(?:${RECEIVERS})\\.(?:${FIELDS})\\b`,
			"g",
		);

		const sourceFiles = roots.flatMap((root) => {
			const full = path.join(repoRoot, root);
			if (!fs.existsSync(full)) return [];
			return fs.statSync(full).isDirectory()
				? listSourceFiles(full, { extensions: [".ts"] })
				: [full];
		});

		const offenders: string[] = [];
		let aliasesResolved = 0;
		for (const file of sourceFiles) {
			// Strip first. This test names the forbidden form in its own comments
			// and so does the DispatchContext doc block, which is the kit's
			// comment-laundering attack in miniature. `stripSource` replaces the
			// hand-rolled comment skip this test used to carry.
			//
			// `strings: "keep"` is REQUIRED here, not a default worth inheriting.
			// Five of the seven sites this PR fixed are interpolations inside
			// template literals (`` `${ctx.kind}:${ctx.filePath}` ``), and the
			// kit's default `"blank"` policy blanks template CONTENTS — the known
			// limit documented at the top of sweep-kit.ts. Under the default this
			// scan went silently blind: the reviewer's own F2 probe, plus a
			// restored `normalizeMapKey(ctx.filePath)`, both stayed green. Keeping
			// strings means a call named inside a plain string would read as code;
			// that is the safe direction for a guard, and the empty offender list
			// below shows no such string exists in this tree.
			const stripped = stripSource(fs.readFileSync(file, "utf-8"), {
				strings: "keep",
			});
			const aliases = new Set<string>();
			for (const match of stripped.matchAll(aliasDeclaration)) {
				if (match[1]) aliases.add(match[1]);
			}
			aliasesResolved += aliases.size;
			const aliasCall =
				aliases.size > 0
					? new RegExp(
							`normalizeMapKey\\(\\s*(?:${[...aliases].join("|")})\\s*[),]`,
						)
					: undefined;
			const relative = path.relative(repoRoot, file).split(path.sep).join("/");
			const lines = stripped.split("\n");
			lines.forEach((line, index) => {
				if (receiverCall.test(line) || aliasCall?.test(line)) {
					offenders.push(`${relative}:${index + 1}`);
				}
			});
		}

		// Floors, per AGENTS.md defect shape 10. A scan that walked nothing, or
		// that resolved no aliases, reports clean while seeing nothing. The alias
		// half is the half the reviewer proved was missing, so it carries its own
		// floor rather than sharing the file floor.
		assertNonEmptyScan(
			"dispatch-context normalization scan (files walked)",
			sourceFiles.length,
			200,
		);
		assertNonEmptyScan(
			"dispatch-context normalization scan (context aliases resolved)",
			aliasesResolved,
			5,
		);

		expect(offenders, offenders.join("\n")).toEqual([]);
	});
});
