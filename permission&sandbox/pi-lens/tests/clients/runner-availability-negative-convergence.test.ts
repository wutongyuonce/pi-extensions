/**
 * #2252: a negative runner-availability (and Vitest-glob) verdict must not
 * latch for the client's whole process lifetime.
 *
 * `TestRunnerClient` is constructed once per extension process
 * (`clients/bootstrap.ts:182`), so any state it memoizes lives as long as the
 * process does. `getRunnerAvailability` already re-validates a POSITIVE
 * verdict by re-statting its `evidencePath`, but a negative verdict carried no
 * evidence path and was written into the same cache unconditionally — so
 * probing an empty directory, then adding `vitest.config.ts` a moment later,
 * kept answering "no runner" for the rest of the client's life.
 *
 * `detectRunner`'s fix follows #2077's precedent (PR #2242): drop the memo
 * write on the failure branch, since a cache miss re-runs the same bounded
 * `fs.existsSync` walk a first probe already pays.
 *
 * `parseVitestTestGlobs`'s `null` ("no config, or nothing this heuristic
 * could read") needed a DIFFERENT fix (fix-round F2): `null` is a common
 * result — most projects have no vitest config at all, or one this
 * text-only heuristic can't scrape — so never caching it made every edit in
 * a non-vitest project re-run the full candidate-file `fs.readFileSync`
 * walk (measured ~1500x cost vs. a cache hit). It IS cached, revalidated on
 * every read the same way `getRunnerAvailability` revalidates a positive
 * verdict: a bounded `fs.existsSync` check against the config file the
 * result came from (or, when none existed, against the candidate list
 * itself) — cheap on every call, and a config file APPEARING (or
 * disappearing) still converges because the existence check catches that.
 *
 * Known boundary, same as `getRunnerAvailability`'s own positive-verdict
 * cache: existence-only revalidation does not detect a config file's
 * CONTENT changing at the same path (an unparseable config fixed in place,
 * without the file being removed and recreated) — that is the identical
 * limitation the positive cache already accepts, not a new one introduced
 * here, and not tested as a convergence case for that reason.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// `vi.spyOn(fs, "readFileSync")` cannot redefine node:fs's ESM namespace
// export directly — wrap it via vi.mock instead, keeping the real
// implementation but letting the caching test assert call counts.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	vi.mocked(fs.readFileSync).mockClear();
});

describe("TestRunnerClient negative-verdict convergence (#2252)", () => {
	it("detects vitest once its config appears, on the SAME client instance", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-2252-runner-");
		cleanups.push(cleanup);

		const client = new TestRunnerClient();

		// Empty project directory: no config, no package.json — genuinely no
		// runner detectable yet.
		expect(client.detectRunner(tmpDir)).toBeNull();

		fs.writeFileSync(
			path.join(tmpDir, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);

		// Same client, same cwd: the config now exists, so detection must
		// converge instead of re-serving the earlier miss.
		expect(client.detectRunner(tmpDir)?.runner).toBe("vitest");
	});

	it("parses Vitest globs once the config appears, on the SAME client instance", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-2252-globs-");
		cleanups.push(cleanup);

		const client = new TestRunnerClient();

		expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();

		fs.writeFileSync(
			path.join(tmpDir, "vitest.config.ts"),
			"export default { test: { include: ['tests/**/*.test.ts'] } }\n",
		);

		expect(client.parseVitestTestGlobs(tmpDir)).toEqual({
			include: ["tests/**/*.test.ts"],
		});
	});

	it("caches a no-config null instead of re-reading the candidates every call (F2)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-2252-globs-cache-",
		);
		cleanups.push(cleanup);

		const client = new TestRunnerClient();

		// First call: genuine miss, pays the candidate-file read attempts.
		expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		vi.mocked(fs.readFileSync).mockClear();

		// Second call, nothing on disk changed: served from cache — zero
		// `fs.readFileSync` calls, only the bounded existence re-check.
		expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		expect(fs.readFileSync).not.toHaveBeenCalled();
	});

	it("caches an unparseable-config null the same way, without re-reading it either (F2)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-2252-globs-unparse-",
		);
		cleanups.push(cleanup);

		const client = new TestRunnerClient();
		// A config file EXISTS but this text-only heuristic can't scrape it
		// (include built from a spread, not a literal array) — a `null` the
		// method's own doc comment names as in-scope, distinct from "no file
		// at all", and the OTHER common shape the F2 fix-round finding named.
		fs.writeFileSync(
			path.join(tmpDir, "vitest.config.ts"),
			"const extra = ['x'];\nexport default { test: { include: [...extra] } }\n",
		);

		expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		vi.mocked(fs.readFileSync).mockClear();

		expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		expect(fs.readFileSync).not.toHaveBeenCalled();
	});
});
