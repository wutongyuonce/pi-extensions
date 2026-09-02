/**
 * #1570: `loadBootstrapClients`'s `bootstrapPromise ??= (async () => {...})()`
 * memo is the same retained-rejected-promise shape as the other four named
 * sites. Every per-client load inside is individually fail-soft (`load`
 * catches a constructor throw and substitutes a `degradedClient` stub), so
 * the memo is not expected to reject in NORMAL operation — but
 * `logExtension` is the one STATIC import in bootstrap.ts, and it is called
 * OUTSIDE any try/catch inside `logBootstrapFailures` once `failures.length
 * > 0`. A throw there propagates out of the async IIFE uncaught and rejects
 * the whole memo, so it is reachable with exactly two mocks: one client
 * constructor throwing (to populate `failures`) and `logExtension` itself
 * throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../clients/extension-log.js", () => ({
	logExtension: vi.fn(() => {
		throw new Error("extension.log write failed");
	}),
}));

vi.mock("../../clients/ruff-client.js", () => ({
	RuffClient: class {
		constructor() {
			throw new Error("ruff binary probe failed");
		}
	},
}));

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.resetModules();
});

describe("loadBootstrapClients memo eviction (#1570)", () => {
	it("retries after a rejected build instead of replaying the same rejection forever", async () => {
		const { loadBootstrapClients } = await import("../../clients/bootstrap.js");

		await expect(loadBootstrapClients()).rejects.toThrow(
			"extension.log write failed",
		);

		// The failing client + logging mock are still in place, so the SECOND
		// call reflects the retry, not a fixed underlying cause — the eviction
		// itself is what's under test, not recovery. It must re-invoke the
		// build rather than replaying the first rejection forever.
		await expect(loadBootstrapClients()).rejects.toThrow(
			"extension.log write failed",
		);

		const { logExtension } = await import("../../clients/extension-log.js");
		expect(logExtension).toHaveBeenCalledTimes(2);
	}, 20_000);
});
