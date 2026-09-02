import { describe, expect, it } from "vitest";

import { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { Runtime } from "../src/runtime.js";

/**
 * Regression coverage for providers that authenticate at request time.
 *
 * Amazon Bedrock with ambient AWS credentials (AWS_PROFILE / SSO) and Google
 * Vertex with ADC expose no apiKey and no auth header: pi signs each request
 * itself. Before this fix, resolveModel treated "nothing to carry" as "not
 * authenticated" and skipped every consolidation, so observational memory
 * produced no records at all on such hosts — silently, since the model was
 * never called and nothing failed.
 *
 * THE SHAPES BELOW ARE MEASURED, NOT IMAGINED. An earlier version of this file
 * modelled the ambient host as `getAuth -> undefined, hasConfiguredAuth ->
 * false`; the fix passed its tests and still skipped every consolidation on a
 * real Bedrock/SSO host. Probing pi 0.84.2's own ModelRuntime there, with
 * `AWS_PROFILE` exported, gives:
 *
 *   checkAuth("amazon-bedrock")            -> { source: "AWS_PROFILE", type: "api_key" }
 *   hasConfiguredAuth(bedrockModel)        -> true
 *   getCompatibilityRequestConfig(model)   -> { authHeader: false }
 *   getApiKeyAndHeaders(bedrockModel)      -> { ok: true, apiKey: undefined, headers: undefined }
 *
 * i.e. pi resolves a credential *source* and hands back an *empty* auth —
 * `bedrockAuth.resolve()` returns `{ auth: {}, source: "AWS_PROFILE" }`, so
 * `hasConfiguredAuth` is TRUE, not false. `googleVertexProvider`'s ADC branch
 * returns the same empty resolution. Doubles here therefore drive the REAL
 * `ModelRegistry` over a runtime that returns those measured values, so the
 * facade's own logic (not a hand-written imitation of it) is under test.
 */

/** Runtime shaped like Bedrock with AWS_PROFILE: a resolved source, empty auth. */
function ambientCredentialRegistry(): any {
	return new ModelRegistry({
		// `bedrockAuth.resolve()` / vertex ADC: a resolution with nothing to carry.
		getAuth: async () => ({ auth: {}, source: "AWS_PROFILE" }),
		getCompatibilityRequestConfig: () => ({ headers: undefined, authHeader: false }),
		// checkAuth resolved a source, so pi counts the provider as configured.
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
	} as any);
}

/** No credential at all: pi resolves nothing and reports the provider unconfigured. */
function unauthenticatedRegistry(): any {
	return new ModelRegistry({
		getAuth: async () => undefined,
		getCompatibilityRequestConfig: () => ({ headers: undefined, authHeader: false }),
		hasConfiguredAuth: () => false,
		isUsingOAuth: () => false,
	} as any);
}

/** Same empty-resolution shape, but the provider is OAuth — empty means expired. */
function expiredOAuthRegistry(): any {
	return new ModelRegistry({
		getAuth: async () => ({ auth: {}, source: "stored credential" }),
		getCompatibilityRequestConfig: () => ({ headers: undefined, authHeader: false }),
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => true,
	} as any);
}

/** A provider pi DOES hold a credential for, which resolves to an empty key. */
function misconfiguredRegistry(): any {
	return {
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "" }),
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
	};
}

const bedrockModel = { provider: "amazon-bedrock", id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" };

describe("resolveModel with request-time-signed providers", () => {
	it("resolves when pi reports a credential source but hands over nothing to attach", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;

		const registry = ambientCredentialRegistry();
		// Guard the premise: if pi's facade ever stops reporting this shape, fail here
		// rather than silently testing a fiction (the original bug in this file).
		const auth = await registry.getApiKeyAndHeaders(bedrockModel);
		expect(auth).toMatchObject({ ok: true });
		expect(auth.apiKey).toBeUndefined();
		expect(registry.hasConfiguredAuth(bedrockModel)).toBe(true);

		const result = await runtime.resolveModel({
			model: bedrockModel,
			modelRegistry: registry,
			hasUI: false,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model).toBe(bedrockModel);
			// Nothing to forward: pi signs the request itself.
			expect(result.apiKey).toBeUndefined();
			expect(result.headers).toBeUndefined();
		}
	});

	it("still fails when pi reports no credential source for the provider", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;

		const result = await runtime.resolveModel({
			model: bedrockModel,
			modelRegistry: unauthenticatedRegistry(),
			hasUI: false,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('no API key or auth headers for provider "amazon-bedrock"');
	});

	it("still fails for OAuth providers whose credentials no longer resolve", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;

		const result = await runtime.resolveModel({
			model: { provider: "openai-codex", id: "gpt-5-codex" },
			modelRegistry: expiredOAuthRegistry(),
			hasUI: false,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("/login openai-codex");
	});

	it("still fails when a stored credential exists but resolves to an empty key", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;

		const result = await runtime.resolveModel({
			model: { provider: "xai", id: "grok-4" },
			modelRegistry: misconfiguredRegistry(),
			hasUI: false,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('no API key or auth headers for provider "xai"');
	});

	it("does not accept an unconfigured provider just because auth.ok is true", async () => {
		// The blunt version of this fix (accept any ok:true with nothing to carry) let
		// every unauthenticated provider through. `hasConfiguredAuth` is what separates
		// "pi signs this itself" from "pi has nothing at all".
		const runtime = new Runtime();
		runtime.configLoaded = true;

		for (const hasConfiguredAuth of [false, undefined]) {
			const result = await runtime.resolveModel({
				model: { provider: "anthropic", id: "claude" },
				modelRegistry: {
					find: () => undefined,
					getApiKeyAndHeaders: async () => ({ ok: true }),
					hasConfiguredAuth: hasConfiguredAuth === undefined ? undefined : () => hasConfiguredAuth,
					isUsingOAuth: () => false,
				},
				hasUI: false,
			});
			expect(result.ok).toBe(false);
		}
	});
});

/**
 * Second half of pi's gate: a stale availability snapshot must not be fatal.
 *
 * pi never trusts the snapshot alone (agent-session.js:850-851):
 *
 *   hasConfiguredAuth(provider) || (await checkAuth(provider)) !== undefined
 *
 * `hasConfiguredAuth` reads `snapshot.configuredProviders`, which an availability pass
 * fills. MEASURED against pi 0.84.2's real ModelRuntime on a live Bedrock/SSO host, using
 * `ModelRuntime.create({ refreshOnCreate: false })` so the pass never populated it:
 *
 *   getApiKeyAndHeaders(model)   -> { ok: true, apiKey: undefined, headers: undefined }
 *   hasConfiguredAuth(model)     -> FALSE        <- differs from the refreshed case
 *   checkAuth("amazon-bedrock")  -> resolves     <- the credential genuinely works
 *   refresh({ allowNetwork: false, providers: ["amazon-bedrock"] })  -> 1ms, then
 *   hasConfiguredAuth(model)     -> true
 *
 * So the snapshot half alone rejects a provider pi itself would accept. This is reachable
 * whenever the pass is skipped, aborted, or FAILS — e.g. an SSO token expired at startup
 * and since renewed: pi recovers on its next turn, consolidation would stay dead for the
 * whole session.
 *
 * VERSION SKEW, deliberately covered by two different doubles below. The facade's refresh
 * differs across the pi versions this extension supports:
 *   pi 0.84: `refresh(options)` -> `runtime.refresh(options)`      — honours the options
 *   pi 0.81: `refresh()`        -> `runtime.reloadConfig()`        — ignores them, then
 *            reloads models.json and runs a full, network-permitted availability pass
 * The recovery must therefore work through either path, and must not depend on the abort
 * signal being observed (0.81 never sees it), which is why the implementation races a
 * timeout instead.
 */
describe("resolveModel with a stale availability snapshot", () => {
	/**
	 * The REAL facade over a runtime double, exposing both underlying entry points so the
	 * test passes against either pi version's ModelRegistry.
	 */
	function staleSnapshotFacade(opts: { recovers: boolean }) {
		const recoveries: string[] = [];
		let configured = false;
		const recover = (via: string) => {
			recoveries.push(via);
			if (opts.recovers) configured = true;
			return { aborted: false, errors: new Map() };
		};
		const registry: any = new ModelRegistry({
			getAuth: async () => ({ auth: {}, source: "AWS_PROFILE" }),
			getCompatibilityRequestConfig: () => ({ headers: undefined, authHeader: false }),
			hasConfiguredAuth: () => configured,
			isUsingOAuth: () => false,
			refresh: async () => recover("refresh"), // pi >= 0.84
			reloadConfig: async () => recover("reloadConfig"), // pi 0.81
		} as any);
		return { registry, recoveries };
	}

	it("re-checks live and accepts when the snapshot was merely stale", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const { registry, recoveries } = staleSnapshotFacade({ recovers: true });

		const result = await runtime.resolveModel({ model: bedrockModel, modelRegistry: registry, hasUI: false });

		expect(result.ok).toBe(true);
		expect(recoveries).toHaveLength(1);
	});

	it("asks for a scoped, network-free re-check", async () => {
		// Asserted against a plain registry double, because only pi >= 0.84 forwards these
		// options at all — on 0.81 the facade drops them before the runtime sees them.
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const calls: unknown[] = [];
		let configured = false;
		const result = await runtime.resolveModel({
			model: bedrockModel,
			modelRegistry: {
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true }),
				hasConfiguredAuth: () => configured,
				isUsingOAuth: () => false,
				refresh: async (options: unknown) => {
					calls.push(options);
					configured = true;
				},
			},
			hasUI: false,
		});

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ allowNetwork: false, providers: ["amazon-bedrock"] });
	});

	it("still rejects when the live re-check confirms the provider is unconfigured", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const { registry, recoveries } = staleSnapshotFacade({ recovers: false });

		const result = await runtime.resolveModel({ model: bedrockModel, modelRegistry: registry, hasUI: false });

		expect(result.ok).toBe(false);
		expect(recoveries).toHaveLength(1);
	});

	it("rate-limits the re-check so an unauthenticated host pays it once, not per consolidation", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const { registry, recoveries } = staleSnapshotFacade({ recovers: false });

		for (let i = 0; i < 3; i++) {
			await runtime.resolveModel({ model: bedrockModel, modelRegistry: registry, hasUI: false });
		}

		expect(recoveries).toHaveLength(1);
	});

	it("does not re-check when auth is already usable", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const { registry, recoveries } = staleSnapshotFacade({ recovers: true });
		registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "sk-live" });

		const result = await runtime.resolveModel({ model: bedrockModel, modelRegistry: registry, hasUI: false });

		expect(result.ok).toBe(true);
		expect(recoveries).toHaveLength(0);
	});

	it("does not re-check OAuth providers — an empty resolution there means expired", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const { registry, recoveries } = staleSnapshotFacade({ recovers: true });
		registry.isUsingOAuth = () => true;

		const result = await runtime.resolveModel({ model: bedrockModel, modelRegistry: registry, hasUI: false });

		expect(result.ok).toBe(false);
		expect(recoveries).toHaveLength(0);
	});

	it("survives a registry with no refresh(), and a refresh that throws", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;

		const noRefresh = {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			hasConfiguredAuth: () => false,
			isUsingOAuth: () => false,
		};
		await expect(
			runtime.resolveModel({ model: bedrockModel, modelRegistry: noRefresh, hasUI: false }),
		).resolves.toMatchObject({ ok: false });

		const throwing = {
			...noRefresh,
			refresh: async () => {
				throw new Error("availability refresh failed");
			},
		};
		await expect(
			runtime.resolveModel({ model: bedrockModel, modelRegistry: throwing, hasUI: false }),
		).resolves.toMatchObject({ ok: false });
	});
});
