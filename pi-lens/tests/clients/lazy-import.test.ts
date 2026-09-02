/**
 * #1570: `x ??= import(...)`-style promise memos cache a REJECTED promise for
 * the process lifetime — one transient module-load failure (EMFILE, a
 * momentary fs error) permanently poisons the lazy import for every later
 * caller. `createLazyImport` is the shared eviction-on-rejection helper that
 * replaces the five hand-rolled `??= import(...)` sites.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createLazyImport } from "../../clients/lazy-import.js";

describe("createLazyImport (#1570)", () => {
	it("retries the loader after a rejection instead of replaying it forever", async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("EMFILE: transient fs error"))
			.mockResolvedValueOnce({ ok: true });

		const lazy = createLazyImport(load);

		await expect(lazy.get()).rejects.toThrow("EMFILE: transient fs error");
		await expect(lazy.get()).resolves.toEqual({ ok: true });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("memoizes a successful load — a later call does not re-invoke the loader", async () => {
		const load = vi.fn().mockResolvedValue({ ok: true });
		const lazy = createLazyImport(load);

		const first = await lazy.get();
		const second = await lazy.get();

		expect(first).toBe(second);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("coalesces concurrent callers onto the same in-flight promise", async () => {
		let resolveLoad: (value: { ok: true }) => void = () => {};
		const load = vi.fn(
			() =>
				new Promise<{ ok: true }>((resolve) => {
					resolveLoad = resolve;
				}),
		);
		const lazy = createLazyImport(load);

		const a = lazy.get();
		const b = lazy.get();
		// `get()` defers the loader call by one microtask (see the
		// synchronous-throw contract test below), so `load` has not run yet at
		// this point — wait for it before resolving.
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		resolveLoad({ ok: true });
		await Promise.all([a, b]);

		expect(load).toHaveBeenCalledTimes(1);
	});

	it("resetForTests drops the memo even after a successful load", async () => {
		const load = vi.fn().mockResolvedValue({ ok: true });
		const lazy = createLazyImport(load);

		await lazy.get();
		lazy.resetForTests();
		await lazy.get();

		expect(load).toHaveBeenCalledTimes(2);
	});

	it("returns a rejected promise instead of throwing, even if the loader throws synchronously", () => {
		const load = vi.fn(() => {
			throw new Error("sync boom");
		});
		const lazy = createLazyImport(load);

		expect(() => lazy.get()).not.toThrow();
		return expect(lazy.get()).rejects.toThrow("sync boom");
	});
});

describe("createLazyImport against a real ESM loader (#1592)", () => {
	// These use real `import()` of temp files (not mocks) to pin the exact
	// behavior the docstring now describes: a resolution failure recovers
	// once the module appears, but an evaluation failure replays the SAME
	// cached rejection forever, even after the file on disk is fixed —
	// because Node's ESM loader memoizes the module record for a URL, not
	// its content. Each test uses a unique filename so a previous test run
	// in the same worker process can't leave a stale cache entry behind.
	const tmpFile = (label: string) =>
		path.join(
			os.tmpdir(),
			`pi-lens-lazy-import-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
		);

	it("resolution failure recovers once the module appears on disk", async () => {
		const file = tmpFile("resolution");
		const url = pathToFileURL(file).href;
		const lazy = createLazyImport(() => import(url));

		// Nothing at `file` yet — import() fails to RESOLVE the specifier.
		await expect(lazy.get()).rejects.toThrow();

		try {
			fs.writeFileSync(file, "export const ok = true;\n");
			// The eviction on rejection means the next demand re-imports —
			// and this time resolution succeeds.
			await expect(lazy.get()).resolves.toMatchObject({ ok: true });
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("evaluation failure replays the cached rejection even after the file is fixed", async () => {
		const file = tmpFile("evaluation");
		const url = pathToFileURL(file).href;
		try {
			// The module RESOLVES fine but throws while its top-level code runs.
			fs.writeFileSync(file, "throw new Error('boom at eval time');\n");
			const lazy = createLazyImport(() => import(url));

			await expect(lazy.get()).rejects.toThrow("boom at eval time");

			// Fix the file on disk — a resolution failure would recover from
			// this (see the sibling test above). An evaluation failure does
			// not: Node already memoized a module record for this URL that
			// threw, and re-importing the same URL replays that record.
			fs.writeFileSync(file, "export const ok = true;\n");
			await expect(lazy.get()).rejects.toThrow("boom at eval time");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});
});
