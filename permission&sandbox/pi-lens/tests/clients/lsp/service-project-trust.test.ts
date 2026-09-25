import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE_ROOT = path.join(process.cwd(), "project-trust-fixture");
const FIXTURE_FILE = path.join(FIXTURE_ROOT, "main.py");

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logExtension = vi.fn();

vi.mock("../../../clients/extension-log.js", () => ({ logExtension }));

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

/**
 * #1334 S5 — the LSP service must not launch a server child process for a
 * project the pi host said is NOT trusted. Spy-based: `server.spawn` is the
 * exact seam that would exec a project-resolved binary.
 */
describe("LSPService project-trust gate (#1334 S5)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logExtension.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function setup() {
		const trust = await import("../../../clients/project-trust.js");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				// biome-ignore lint/suspicious/noExplicitAny: inert stdio stubs
				stdin: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: inert stdio stubs
				stdout: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: inert stdio stubs
				stderr: {} as any,
				pid: 4242,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => FIXTURE_ROOT,
				spawn,
			},
		]);
		return { trust, service: new LSPService(), spawn };
	}

	it("refuses to spawn a server when the host denied project trust", async () => {
		const { trust, service, spawn } = await setup();
		trust.setProjectTrustState("untrusted");

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).not.toHaveBeenCalled();
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(client).toBeUndefined();
		expect(logExtension).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "warn",
				message: "install/materialization blocked: lsp install: python",
				metadata: expect.objectContaining({ context: "lsp install: python" }),
			}),
		);
		trust.resetProjectTrust();
	});

	it("spawns normally when the host granted project trust", async () => {
		const { trust, service, spawn } = await setup();
		trust.setProjectTrustState("trusted");

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(client?.client).toBeTruthy();
		trust.resetProjectTrust();
	});

	it("spawns normally on a host with no trust surface at all", async () => {
		const { trust, service, spawn } = await setup();
		// "unknown" is the default — an older pi that never exposed
		// ctx.isProjectTrusted must behave exactly as before.
		expect(trust.getProjectTrustState()).toBe("unknown");

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(client?.client).toBeTruthy();
	});

	it("forces allowInstall=false for the spawn options under denial", async () => {
		// Trust denial short-circuits before spawn, so the install policy is
		// asserted on the granted path: the gate must not leak into it.
		const { trust, service, spawn } = await setup();
		trust.setProjectTrustState("trusted");

		await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).toHaveBeenCalledWith(
			FIXTURE_ROOT,
			expect.objectContaining({ allowInstall: true }),
		);
		trust.resetProjectTrust();
	});
});
