import { afterEach, describe, expect, it, vi } from "vitest";
import type { LSPClientInfo } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";

process.env.PI_LENS_TEST_MODE = "1";

function fakeClient(busy: boolean) {
	return {
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => busy),
		shutdown: vi.fn(async () => undefined),
	} as unknown as LSPClientInfo;
}

type CeilingHarness = {
	state: {
		clients: Map<string, LSPClientInfo>;
		inFlight: Map<string, Promise<unknown>>;
		clientSpawnedAt: Map<string, number>;
		demonstratedReady: Set<string>;
		demonstratedCold: Set<string>;
	};
	clientLastUsedAt: Map<string, number>;
	makeCapacityForClient(key: string): Promise<boolean>;
};

afterEach(() => {
	delete process.env.PI_LENS_LSP_CLIENT_CEILING;
	vi.restoreAllMocks();
});

describe("LSP per-session client ceiling (#1325)", () => {
	it("evicts the least-recently-used idle client first", async () => {
		process.env.PI_LENS_LSP_CLIENT_CEILING = "2";
		const service = new LSPService() as unknown as CeilingHarness;
		const oldest = fakeClient(false);
		const newest = fakeClient(false);
		service.state.clients.set("json:/old", oldest);
		service.state.clients.set("yaml:/new", newest);
		service.clientLastUsedAt.set("json:/old", 10);
		service.clientLastUsedAt.set("yaml:/new", 20);

		await expect(service.makeCapacityForClient("go:/next")).resolves.toBe(true);
		expect(vi.mocked(oldest.shutdown)).toHaveBeenCalledWith({
			reason: "client_ceiling_lru",
		});
		expect(vi.mocked(newest.shutdown)).not.toHaveBeenCalled();
		expect(service.state.clients.has("json:/old")).toBe(false);
	});

	it("never evicts in-use clients and declines the new spawn", async () => {
		process.env.PI_LENS_LSP_CLIENT_CEILING = "1";
		const service = new LSPService() as unknown as CeilingHarness;
		const inUse = fakeClient(true);
		service.state.clients.set("kotlin:/active", inUse);

		await expect(service.makeCapacityForClient("json:/next")).resolves.toBe(
			false,
		);
		expect(vi.mocked(inUse.shutdown)).not.toHaveBeenCalled();
		expect(service.state.clients.has("kotlin:/active")).toBe(true);
	});
});
