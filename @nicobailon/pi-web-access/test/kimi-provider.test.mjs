import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const kimiModuleUrl = new URL("../kimi-search.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const { isKimiSearchAvailable, searchWithKimi } = await import(kimiModuleUrl);

function registryContext({
	models = [{ provider: "kimi-coding", id: "kimi-for-coding" }],
	auth = { ok: true, apiKey: "kimi-oauth-token", headers: {} },
} = {}) {
	const selected = [];
	return {
		selected,
		context: {
			modelRegistry: {
				getAll: () => models,
				getApiKeyAndHeaders: async (model) => {
					selected.push({ provider: model.provider, id: model.id });
					return typeof auth === "function" ? auth(model) : auth;
				},
			},
		},
	};
}

async function withFetch(mock, action) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock;
	try {
		return await action();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("Kimi resolves primary model-registry auth and sends the verified search request", async () => {
	const models = [
		{ provider: "kimi-code", id: "compat-model" },
		{ provider: "other", id: "unrelated" },
		{ provider: "kimi-coding", id: "primary-model" },
	];
	const { context, selected } = registryContext({
		models,
		auth: {
			ok: true,
			apiKey: "kimi-registry-token",
			headers: {
				"X-Registry": "forwarded",
				"X-Nullable": null,
				authorization: "Bearer stale-token",
				"content-type": "text/plain",
				"x-msh-tool-call-id": "stale-call-id",
			},
		},
	});
	let captured;
	const result = await withFetch(async (url, init) => {
		captured = {
			url: String(url),
			method: init.method,
			headers: Object.fromEntries(new Headers(init.headers)),
			body: JSON.parse(init.body),
		};
		return new Response(JSON.stringify({
			search_results: [
				{ title: "Kimi result", url: "https://example.com/one", snippet: "First snippet", site_name: "Example" },
				{ title: "   ", url: "https://example.com/two" },
				{ title: "Missing URL", snippet: "must be ignored" },
			],
		}), { status: 200 });
	}, async () => {
		assert.equal(await isKimiSearchAvailable(context), true);
		return searchWithKimi("Kimi Code Plan search", {}, context);
	});

	assert.deepEqual(selected, [
		{ provider: "kimi-coding", id: "primary-model" },
		{ provider: "kimi-coding", id: "primary-model" },
	]);
	assert.equal(captured.url, "https://api.kimi.com/coding/v1/search");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.authorization, "Bearer kimi-registry-token");
	assert.equal(captured.headers["content-type"], "application/json");
	assert.equal(captured.headers["x-registry"], "forwarded");
	assert.equal(captured.headers["x-nullable"], undefined);
	assert.match(captured.headers["x-msh-tool-call-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.notEqual(captured.headers["x-msh-tool-call-id"], "stale-call-id");
	assert.deepEqual(captured.body, { text_query: "Kimi Code Plan search" });
	assert.deepEqual(result, {
		answer: "First snippet\nSource: Kimi result (https://example.com/one)\n\nSource: https://example.com/two (https://example.com/two)",
		results: [
			{ title: "Kimi result", url: "https://example.com/one", snippet: "First snippet" },
			{ title: "https://example.com/two", url: "https://example.com/two", snippet: "" },
		],
	});
});

test("Kimi accepts Pi OAuth returned only in the Authorization header", async () => {
	const { context } = registryContext({
		auth: { ok: true, headers: { Authorization: "Bearer kimi-header-token" } },
	});
	let authorization;
	const result = await withFetch(async (_url, init) => {
		authorization = new Headers(init.headers).get("authorization");
		return new Response(JSON.stringify({
			search_results: [{ title: "Header auth", url: "https://example.com/header", snippet: "ok" }],
		}), { status: 200 });
	}, () => searchWithKimi("header auth", {}, context));

	assert.equal(authorization, "Bearer kimi-header-token");
	assert.equal(result.results[0]?.url, "https://example.com/header");
});

test("Kimi accepts the kimi-code registry provider as a compatibility fallback", async () => {
	const { context, selected } = registryContext({
		models: [{ provider: "kimi-code", id: "compat-only" }],
	});
	assert.equal(await isKimiSearchAvailable(context), true);
	assert.deepEqual(selected, [{ provider: "kimi-code", id: "compat-only" }]);
});

test("Kimi without model-registry auth fails before making a request", async () => {
	const { context } = registryContext({
		models: [{ provider: "kimi-coding", id: "signed-out" }],
		auth: { ok: false, error: "not authenticated" },
	});
	let requests = 0;
	await withFetch(async () => {
		requests++;
		throw new Error("must not reach the network");
	}, async () => {
		assert.equal(await isKimiSearchAvailable(context), false);
		await assert.rejects(
			() => searchWithKimi("signed out", {}, context),
			/error.*\/login kimi-coding|\/login kimi-coding/i,
		);
	});
	assert.equal(requests, 0);
});

test("Kimi preserves model-registry credential failures", async () => {
	const { context } = registryContext({
		models: [{ provider: "kimi-coding", id: "broken-refresh" }],
		auth: async () => { throw new Error("credential refresh failed"); },
	});
	let requests = 0;
	await withFetch(async () => {
		requests++;
		throw new Error("must not reach the network");
	}, async () => {
		await assert.rejects(
			() => searchWithKimi("broken auth", {}, context),
			/credential refresh failed/,
		);
	});
	assert.equal(requests, 0);
});

test("Kimi tries later registry models after an earlier credential failure", async () => {
	const { context, selected } = registryContext({
		models: [
			{ provider: "kimi-coding", id: "broken-refresh" },
			{ provider: "kimi-coding", id: "usable-refresh" },
		],
		auth: async (model) => {
			if (model.id === "broken-refresh") throw new Error("credential refresh failed");
			return { ok: true, apiKey: "kimi-later-token", headers: {} };
		},
	});
	let authorization;
	const result = await withFetch(async (_url, init) => {
		authorization = new Headers(init.headers).get("authorization");
		return new Response(JSON.stringify({
			search_results: [{ title: "Later auth", url: "https://example.com/later", snippet: "ok" }],
		}), { status: 200 });
	}, () => searchWithKimi("later auth", {}, context));

	assert.deepEqual(selected, [
		{ provider: "kimi-coding", id: "broken-refresh" },
		{ provider: "kimi-coding", id: "usable-refresh" },
	]);
	assert.equal(authorization, "Bearer kimi-later-token");
	assert.equal(result.results[0]?.url, "https://example.com/later");
});

test("Kimi availability treats registry credential failures as unavailable", async () => {
	const { context } = registryContext({
		models: [{ provider: "kimi-coding", id: "broken-refresh" }],
		auth: async () => { throw new Error("credential refresh failed"); },
	});

	assert.equal(await isKimiSearchAvailable(context), false);
});

test("Kimi API errors redact the model-registry credential", async () => {
	const secret = "kimi-oauth-secret";
	const { context } = registryContext({ auth: { ok: true, apiKey: secret, headers: {} } });
	await withFetch(
		async () => new Response(`denied for ${secret}`, { status: 401 }),
		async () => {
			await assert.rejects(
				() => searchWithKimi("redact", {}, context),
				(error) => {
					assert.match(error.message, /Kimi Code search API error 401/);
					assert.match(error.message, /\[redacted\]/);
					assert.doesNotMatch(error.message, new RegExp(secret));
					return true;
				},
			);
		},
	);
});

test("Kimi applies normalized domain filters and numResults locally", async () => {
	const { context } = registryContext();
	let body;
	const response = await withFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		return new Response(JSON.stringify({
			search_results: [
				{ title: "First", url: "https://allowed.example/first", snippet: "one" },
				{ title: "Blocked", url: "https://ads.allowed.example/tracker", snippet: "blocked" },
				{ title: "Second", url: "https://docs.allowed.example/second", snippet: "two" },
				{ title: "Other", url: "https://other.example/no", snippet: "other" },
				{ title: "Third", url: "https://allowed.example/third", snippet: "three" },
			],
		}), { status: 200 });
	}, () => searchWithKimi("local filtering", {
		numResults: 2,
		domainFilter: [" HTTPS://Allowed.Example/scope ", "-https://ADS.allowed.example/path", "not a domain"],
	}, context));

	assert.deepEqual(body, { text_query: "local filtering" });
	assert.deepEqual(response.results.map(({ title, url }) => ({ title, url })), [
		{ title: "First", url: "https://allowed.example/first" },
		{ title: "Second", url: "https://docs.allowed.example/second" },
	]);
	assert.equal(response.answer, "one\nSource: First (https://allowed.example/first)\n\ntwo\nSource: Second (https://docs.allowed.example/second)");
});

test("Kimi drops malformed and non-web result URLs before citation", async () => {
	const { context } = registryContext();
	const response = await withFetch(async () => new Response(JSON.stringify({
		search_results: [
			{ title: "Script", url: "javascript:alert(1)", snippet: "bad" },
			{ title: "FTP", url: "ftp://example.com/file", snippet: "bad" },
			{ title: "Relative", url: "/relative", snippet: "bad" },
			{ title: "Malformed", url: "not a url", snippet: "bad" },
			{ title: "HTTPS", url: " https://example.com/ok ", snippet: "good" },
			{ title: "HTTP", url: "http://example.org/path", snippet: "also good" },
		],
	}), { status: 200 }), () => searchWithKimi("safe urls", {}, context));

	assert.deepEqual(response.results, [
		{ title: "HTTPS", url: "https://example.com/ok", snippet: "good" },
		{ title: "HTTP", url: "http://example.org/path", snippet: "also good" },
	]);
	assert.doesNotMatch(response.answer, /javascript:|ftp:|relative|not a url/);
});

test("Kimi rejects invalid JSON and empty result envelopes", async () => {
	const { context } = registryContext();
	await withFetch(
		async () => new Response("{", { status: 200 }),
		() => assert.rejects(() => searchWithKimi("invalid", {}, context), /returned invalid JSON/),
	);
	await withFetch(
		async () => new Response(JSON.stringify({ search_results: [] }), { status: 200 }),
		() => assert.rejects(() => searchWithKimi("empty", {}, context), /returned no results/),
	);
});

test("explicit kimi routing dispatches through the Kimi Code search endpoint", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-kimi-routing-"));
	await writeFile(join(agentDir, "web-search.json"), "{}\n", "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { search } = await import(`${searchModuleUrl}?kimi-routing=${Date.now()}`);
		const { context } = registryContext();
		const calls = [];
		const result = await withFetch(async (url) => {
			calls.push(String(url));
			return new Response(JSON.stringify({
				search_results: [{ title: "Dispatched", url: "https://example.com/dispatch", snippet: "ok" }],
			}), { status: 200 });
		}, () => search("dispatch", { provider: "kimi", extensionContext: context }));

		assert.equal(result.provider, "kimi");
		assert.deepEqual(calls, ["https://api.kimi.com/coding/v1/search"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("configured routing falls back when Kimi hits its provider timeout", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-kimi-timeout-routing-"));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({
		braveApiKey: "brave-routing-key",
		searchRouting: { providers: ["kimi", "brave"], fallbackOn: ["network"] },
	}) + "\n", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				globalThis.calls.push(target);
				if (target === "https://api.kimi.com/coding/v1/search") {
					throw new DOMException("The operation timed out", "TimeoutError");
				}
				if (target.startsWith("https://api.search.brave.com/res/v1/web/search?")) {
					return new Response(JSON.stringify({
						web: { results: [{ title: "Brave fallback", url: "https://example.com/brave", description: "fallback ok" }] },
					}), { status: 200 });
				}
				throw new Error("Unexpected fetch " + target);
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const context = {
				modelRegistry: {
					getAll: () => [{ provider: "kimi-coding", id: "kimi-for-coding" }],
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "kimi-oauth-token", headers: {} }),
				},
			};
			const result = await search("fallback after kimi timeout", { extensionContext: context });
			console.log(JSON.stringify({ result, calls: globalThis.calls }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, BRAVE_API_KEY: "brave-routing-key" },
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result.provider, "brave");
	assert.deepEqual(output.result.results, [{ title: "Brave fallback", url: "https://example.com/brave", snippet: "fallback ok" }]);
	assert.equal(output.calls[0], "https://api.kimi.com/coding/v1/search");
	assert.match(output.calls[1], /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
});

test("configured routing does not fall back when the caller cancels Kimi", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-kimi-cancel-routing-"));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({
		braveApiKey: "brave-routing-key",
		searchRouting: { providers: ["kimi", "brave"], fallbackOn: ["network"] },
	}) + "\n", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.calls = [];
			globalThis.fetch = async (url, init = {}) => {
				const target = String(url);
				globalThis.calls.push(target);
				if (target === "https://api.kimi.com/coding/v1/search") {
					if (!init.signal?.aborted) throw new Error("expected aborted Kimi signal");
					throw new DOMException("The operation was aborted", "AbortError");
				}
				throw new Error("Unexpected fallback fetch " + target);
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const context = {
				modelRegistry: {
					getAll: () => [{ provider: "kimi-coding", id: "kimi-for-coding" }],
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "kimi-oauth-token", headers: {} }),
				},
			};
			const controller = new AbortController();
			controller.abort();
			let message = "";
			try {
				await search("cancel kimi", { extensionContext: context, signal: controller.signal });
			} catch (error) {
				message = String(error);
			}
			console.log(JSON.stringify({ message, calls: globalThis.calls }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, BRAVE_API_KEY: "brave-routing-key" },
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.message, /aborted/i);
	assert.deepEqual(output.calls, ["https://api.kimi.com/coding/v1/search"]);
});
