import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";

const tempRoots: string[] = [];

function linkAlias(root: string, alias: string): void {
	try {
		fs.symlinkSync(root, alias, "junction");
	} catch {
		fs.symlinkSync(root, alias, "dir");
	}
}

function makeUnlinkedProject(prefix: string): { root: string; alias: string } {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const root = path.join(parent, "project");
	const alias = path.join(parent, "project-alias");
	fs.mkdirSync(root);
	tempRoots.push(parent);
	return { root, alias };
}

function makeProject(): { root: string; alias: string } {
	const { root, alias } = makeUnlinkedProject("pi-lens-2048-");
	linkAlias(root, alias);
	return { root, alias };
}

function existingWindowsAlias(root: string): string | undefined {
	const alias = root
		.replace(/[A-Za-z]/g, (letter) =>
			letter === letter.toLowerCase()
				? letter.toUpperCase()
				: letter.toLowerCase(),
		)
		.replace(/[\\/]/g, "\\");
	return alias !== root && fs.existsSync(alias) ? alias : undefined;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("TestRunnerClient project-root caches (#2048)", () => {
	it("shares availability and Vitest glob state across a real symlink", () => {
		const { root, alias } = makeProject();
		const client = new TestRunnerClient();

		// No config yet through either spelling. #2252: a miss is never
		// memoized, so this is a live check each time, not a cached latch.
		expect(client.detectRunner(alias)).toBeNull();
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		// #2048: a POSITIVE verdict still shares its cache entry across the
		// canonical root, resolving through EITHER spelling.
		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		const firstGlobs = client.parseVitestTestGlobs(alias);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['changed/**/*.test.ts'] } }\n",
		);
		expect(client.parseVitestTestGlobs(root)).toEqual(firstGlobs);
	});

	it("re-resolves an alias first probed before its symlink existed (#2077)", () => {
		const { root, alias } = makeUnlinkedProject("pi-lens-2077-");
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		const client = new TestRunnerClient();

		// The alias does not exist yet, so canonicalization must NOT memoize
		// the fallback key it falls back to — #2077's fix is precisely that
		// this call leaves no memo entry behind for `alias`.
		expect(client.detectRunner(alias)).toBeNull();

		linkAlias(root, alias);

		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		// #2252 fix-round F1: the two assertions above pass even if the alias
		// got pinned to a WRONG (fallback) canonical key here, because a live
		// `fs.existsSync` check through the now-real symlink still finds the
		// config file regardless of which cache bucket the probe lands in —
		// #2252 stopped caching negatives, so a wrong-bucket miss just
		// re-derives the right answer instead of serving a stale wrong one.
		// Pin the ACTUAL contract (alias and root share ONE cache entry) with
		// a positive-verdict content-divergence probe: parseVitestTestGlobs
		// never re-reads a cached HIT (only re-validates the evidence path's
		// existence), so if `alias` were still keyed under the pre-symlink
		// fallback — the #2077 defect this test exists to catch — this call
		// would MISS that bucket, re-read the file fresh, and see the NEW
		// content instead of the stale cached one.
		const rootGlobs = client.parseVitestTestGlobs(root);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['changed/**/*.test.ts'] } }\n",
		);
		expect(client.parseVitestTestGlobs(alias)).toEqual(rootGlobs);
	});

	it("shares caches across a confirmed Windows separator and case alias", (ctx) => {
		const { root } = makeProject();
		const alias = existingWindowsAlias(root);
		if (!alias) {
			ctx.skip();
			return;
		}

		const client = new TestRunnerClient();
		expect(client.detectRunner(alias)).toBeNull();
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);
		// #2048: a POSITIVE verdict still shares its cache entry across the
		// canonical root, resolving through EITHER spelling.
		expect(client.detectRunner(root)?.runner).toBe("vitest");
		expect(client.detectRunner(alias)?.runner).toBe("vitest");

		const firstGlobs = client.parseVitestTestGlobs(alias);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			"export default { test: { exclude: ['changed/**'] } }\n",
		);
		expect(client.parseVitestTestGlobs(root)).toEqual(firstGlobs);
	});
});
