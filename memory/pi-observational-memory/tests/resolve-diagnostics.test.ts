import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { DEBUG_LOG_RELATIVE_PATH, withDebugLogContext } from "../src/debug-log.js";
import { Runtime } from "../src/runtime.js";

/**
 * The ambient-credential outage was invisible for eight weeks partly because the
 * only breadcrumb was `observer.model_unavailable` with a reason string that reads
 * identically for `auth.ok === false` and for `auth.ok === true` with nothing to
 * carry. Diagnosing it needed an out-of-band probe of pi's ModelRegistry. These
 * tests pin the decision inputs into the debug log — and pin that no credential
 * material ever goes in with them.
 */
describe("resolveModel debug diagnostics", () => {
	let root: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-resolve-diag-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		mkdirSync(join(root, "agent"), { recursive: true });
		mock.agentDir = join(root, "agent");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function events(): any[] {
		return readFileSync(join(root, "agent", DEBUG_LOG_RELATIVE_PATH), "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	async function resolve(registry: unknown, model: unknown) {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		return withDebugLogContext({ enabled: true }, () =>
			runtime.resolveModel({ model, modelRegistry: registry as any, hasUI: false }),
		);
	}

	it("records why a resolve was rejected, not just the reason string", async () => {
		const result = await resolve(
			{
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "" } }),
				hasConfiguredAuth: () => false,
				isUsingOAuth: () => false,
			},
			{ provider: "anthropic", id: "claude" },
		);

		expect(result.ok).toBe(false);
		const rejected = events().filter((entry) => entry.event === "resolve.rejected");
		expect(rejected).toHaveLength(1);
		expect(rejected[0].data).toMatchObject({
			provider: "anthropic",
			authOk: true,
			hasApiKey: false,
			resolvedEmptyApiKey: false,
			headerCount: 1,
			usableHeaderCount: 0,
			isOAuth: false,
			providerCredentialConfigured: false,
			signsAtRequestTime: false,
		});
	});

	it("distinguishes a stored-but-empty key from an unconfigured provider", async () => {
		await resolve(
			{
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "" }),
				hasConfiguredAuth: () => true,
				isUsingOAuth: () => false,
			},
			{ provider: "xai", id: "grok-4" },
		);

		const [rejected] = events().filter((entry) => entry.event === "resolve.rejected");
		expect(rejected.data).toMatchObject({
			provider: "xai",
			resolvedEmptyApiKey: true,
			providerCredentialConfigured: true,
			signsAtRequestTime: false,
		});
	});

	it("records the request-time-signing acceptance path", async () => {
		const result = await resolve(
			{
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true }),
				hasConfiguredAuth: () => true,
				isUsingOAuth: () => false,
			},
			{ provider: "amazon-bedrock", id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" },
		);

		expect(result.ok).toBe(true);
		const accepted = events().filter((entry) => entry.event === "resolve.request_time_signing");
		expect(accepted).toHaveLength(1);
		expect(accepted[0].data).toMatchObject({ provider: "amazon-bedrock", providerCredentialConfigured: true });
		expect(events().some((entry) => entry.event === "resolve.rejected")).toBe(false);
	});

	it("never writes credential material into the debug log", async () => {
		await resolve(
			{
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-secret-key", headers: { Authorization: "Bearer secret-token" } }),
				hasConfiguredAuth: () => true,
				isUsingOAuth: () => false,
			},
			{ provider: "anthropic", id: "claude" },
		);

		// A successful resolve with usable auth logs nothing at all; assert the file
		// either does not exist or contains no secret, without depending on which.
		let contents = "";
		try {
			contents = readFileSync(join(root, "agent", DEBUG_LOG_RELATIVE_PATH), "utf-8");
		} catch {
			contents = "";
		}
		expect(contents).not.toContain("sk-secret-key");
		expect(contents).not.toContain("secret-token");
	});
});
