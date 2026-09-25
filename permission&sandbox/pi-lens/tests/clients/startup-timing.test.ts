import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.resetModules();
});

async function freshModule() {
	vi.resetModules();
	return await import("../../clients/startup-timing.js");
}

describe("startup-timing", () => {
	it("getPiLensLoadMs is undefined until marked", async () => {
		const m = await freshModule();
		expect(m.getPiLensLoadMs()).toBeUndefined();
	});

	it("markPiLensLoaded records a non-negative, finite ms value", async () => {
		const m = await freshModule();
		const ms = m.markPiLensLoaded();
		expect(Number.isFinite(ms)).toBe(true);
		expect(ms).toBeGreaterThanOrEqual(0);
		expect(m.getPiLensLoadMs()).toBe(ms);
	});

	it("is idempotent — repeated marks return the first captured value", async () => {
		const m = await freshModule();
		const first = m.markPiLensLoaded();
		const second = m.markPiLensLoaded();
		expect(second).toBe(first);
	});

	it("reports a known load source", async () => {
		const m = await freshModule();
		expect(["dist", "source"]).toContain(m.PI_LENS_LOADED_FROM);
	});

	it("splits host boot from extension evaluation", async () => {
		const m = await freshModule();
		const total = m.markPiLensLoaded();
		const evaluation = m.getPiLensEvalMs();
		expect(m.PI_LENS_HOST_BOOT_MS).toBeGreaterThanOrEqual(0);
		expect(evaluation).toBeGreaterThanOrEqual(0);
		expect(m.PI_LENS_HOST_BOOT_MS + (evaluation ?? 0)).toBe(total);
	});
});
