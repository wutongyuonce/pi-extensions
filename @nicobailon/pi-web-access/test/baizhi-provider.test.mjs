import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { before, after, test } from "node:test";

const key = "synthetic-baizhi-credential";
const endpoint = "https://agent-toolkit.app.baizhi.cloud/mcp";
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const savedEnv = { ...process.env };
let home, server, origin, searchWithBaizhi, isBaizhiAvailable;
let calls = [], mode = "json";
const payload = { status: "success", results: [{ unknown_service_field: "opaque search result; https://example.com/reference" }] };

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-web-baizhi-"));
	process.env.PI_CODING_AGENT_DIR = home;
	process.env.BAIZHI_API_KEY = key;
	await writeFile(join(home, "web-search.json"), JSON.stringify({ webSearch: { allowedProviders: ["baizhi"] } }));
	server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		const rpc = body ? JSON.parse(body) : null;
		calls.push({ method: req.method, rpc, authCorrect: req.headers.authorization === `Bearer ${key}`, session: req.headers["mcp-session-id"], protocol: req.headers["mcp-protocol-version"] });
		if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end(`bad key ${key} ${encodeURIComponent(key)}`); return; }
		if (req.method === "GET") { res.writeHead(405); res.end(); return; }
		if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
		if (mode === "redirect") { res.writeHead(307, { location: "https://untrusted.example/mcp" }); res.end(); return; }
		if (rpc.method === "initialize") {
			if (mode === "hang-init") return;
			res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "synthetic-session" });
			if (mode === "hang-init-body") { res.flushHeaders(); return; }
			res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "synthetic-only", version: "1.0.0" } } })); return;
		}
		assert.equal(req.headers["mcp-session-id"], "synthetic-session");
		assert.equal(req.headers["mcp-protocol-version"], "2025-11-25");
		if (rpc.method === "notifications/initialized" && mode === "hang-initialized") return;
		if (!rpc.id && rpc.id !== 0) { res.writeHead(202); res.end(); return; }
		assert.equal(rpc.method, "tools/call");
		assert.equal(rpc.params.name, "websearch_search");
		if (mode === "hang-body" || mode === "hang-error-body") { res.writeHead(mode === "hang-body" ? 200 : 503, { "content-type": "application/json" }); res.flushHeaders(); return; }
		const result = mode === "empty" ? { content: [] }
			: mode === "tool-error" ? { content: [{ type: "text", text: `secret ${key}` }], isError: true }
			: mode === "text" ? { content: [{ type: "text", text: JSON.stringify(payload) }] }
			: mode === "redact" ? { content: [{ type: "text", text: key }], structuredContent: { echoed: key } }
			: { content: [], structuredContent: payload };
		const response = { jsonrpc: "2.0", id: rpc.id, result };
		res.writeHead(200, { "content-type": mode === "sse" ? "text/event-stream" : "application/json" });
		res.end(mode === "sse" ? `event: message\ndata: ${JSON.stringify(response)}\n\n` : JSON.stringify(response));
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	origin = `http://127.0.0.1:${server.address().port}/mcp`;
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), endpoint, "unexpected external network request");
		assert.equal(init.redirect, "error");
		return originalFetch(origin, init);
	};
	({ searchWithBaizhi, isBaizhiAvailable } = await import("../baizhi.ts"));
});
after(async () => {
	globalThis.fetch = originalFetch;
	AbortSignal.timeout = originalTimeout;
	process.env = savedEnv;
	server?.closeAllConnections();
	await new Promise(resolve => server?.close(resolve));
	await rm(home, { recursive: true, force: true });
});
function reset(nextMode = "json") { calls = []; mode = nextMode; }

test("Baizhi uses full MCP initialization, session and schema arguments; preserves opaque output", async () => {
	reset();
	const result = await searchWithBaizhi("  中文 query  ", { numResults: 3, recencyFilter: "week", domainFilter: ["example.com", "-private.example.com", "127.0.0.1"] });
	assert.deepEqual(JSON.parse(result.answer), payload);
	assert.deepEqual(result.results, []);
	assert.deepEqual(calls.filter(c => c.rpc).map(c => c.rpc.method), ["initialize", "notifications/initialized", "tools/call"]);
	assert.deepEqual(calls.find(c => c.rpc?.method === "tools/call").rpc.params.arguments, { query: "中文 query", count: 3, need_summary: false, time_range: "week", filter: { domains: ["example.com", "127.0.0.1"], exclude_domains: ["private.example.com"] } });
	assert.ok(calls.every(c => c.authCorrect));
	assert.equal(calls.at(-1).method, "DELETE");
});
for (const variant of ["text", "sse"]) test(`Baizhi accepts ${variant} MCP response`, async () => {
	reset(variant);
	assert.deepEqual(JSON.parse((await searchWithBaizhi("q")).answer), payload);
	assert.equal(calls.find(c => c.rpc?.method === "tools/call").rpc.params.arguments.time_range, "month");
});
test("Baizhi output and errors never disclose the key", async () => {
	reset("redact");
	assert.doesNotMatch(JSON.stringify(await searchWithBaizhi("q")), new RegExp(key));
	for (const variant of ["tool-error", "empty"]) {
		reset(variant);
		await assert.rejects(searchWithBaizhi("q"), err => !String(err).includes(key) && /Baizhi/.test(String(err)));
	}
	reset(); process.env.BAIZHI_API_KEY = "wrong-synthetic";
	await assert.rejects(searchWithBaizhi("q"), err => !String(err).includes(key) && /HTTP 401/.test(String(err)));
	assert.equal(calls[0].authCorrect, false);
	assert.ok(!calls.some(c => c.rpc?.method === "tools/call"));
	process.env.BAIZHI_API_KEY = key;
});
test("Baizhi rejects redirects without contacting a second origin", async () => {
	reset("redirect");
	await assert.rejects(searchWithBaizhi("q"), /Baizhi network request failed/);
	assert.equal(calls.length, 1);
});
for (const variant of ["hang-init", "hang-init-body", "hang-initialized", "hang-body", "hang-error-body"]) test(`Baizhi caller cancellation interrupts ${variant}`, async () => {
	reset(variant);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`caller ${key}`)), 60);
	try { await assert.rejects(searchWithBaizhi("q", { signal: controller.signal }), /^Error: Aborted$/); }
	finally { clearTimeout(timer); }
	if (variant !== "hang-init") assert.equal(calls.at(-1).method, "DELETE");
});
for (const variant of ["hang-init", "hang-init-body", "hang-initialized", "hang-body", "hang-error-body"]) test(`Baizhi shared deadline covers ${variant}`, async () => {
	reset(variant);
	AbortSignal.timeout = ms => originalTimeout(ms === 60_000 ? 60 : ms);
	try { await assert.rejects(searchWithBaizhi("q"), /timed out after 60s/); }
	finally { AbortSignal.timeout = originalTimeout; }
});
test("Baizhi rejects missing credentials, empty query, invalid filter and pre-aborted calls before network", async () => {
	reset(); delete process.env.BAIZHI_API_KEY;
	assert.equal(isBaizhiAvailable(), false);
	await assert.rejects(searchWithBaizhi("q"), /API key not found/);
	process.env.BAIZHI_API_KEY = key;
	await assert.rejects(searchWithBaizhi(" "), /empty/);
	await assert.rejects(searchWithBaizhi("q", { domainFilter: ["invalid"] }), /valid domain/);
	await assert.rejects(searchWithBaizhi("q", { signal: AbortSignal.abort() }), /^Error: Aborted$/);
	assert.equal(calls.length, 0);
});
test("malformed credentials fail locally with a fixed message and never reach HTTP", async () => {
	reset();
	const malformed = "synthetic-invalid-header\nprivate-value";
	process.env.BAIZHI_API_KEY = malformed;
	try { await assert.rejects(searchWithBaizhi("q"), err => String(err) === "Error: Baizhi credential resolution failed: invalid-header-value" && !String(err).includes(malformed)); }
	finally { process.env.BAIZHI_API_KEY = key; }
	assert.equal(calls.length, 0);
});

test("Baizhi supports shared credential source rules without credential-resolution side effects at availability time", async () => {
	reset();
	await writeFile(join(home, "web-search.json"), JSON.stringify({ baizhiApiKey: "$SYNTHETIC_BAIZHI_NAMED", webSearch: { allowedProviders: ["baizhi"] } }));
	process.env.SYNTHETIC_BAIZHI_NAMED = key;
	process.env.BAIZHI_API_KEY = "wrong-fallback";
	assert.equal(isBaizhiAvailable(), true);
	await searchWithBaizhi("q");
	assert.ok(calls.every(c => c.authCorrect));
	delete process.env.SYNTHETIC_BAIZHI_NAMED; process.env.BAIZHI_API_KEY = key;
	await assert.rejects(searchWithBaizhi("q"), /environment-empty/);
	await writeFile(join(home, "web-search.json"), JSON.stringify({ webSearch: { allowedProviders: ["baizhi"] } }));
});
test("Baizhi is explicit-only, available to provider arrays, labels and the Curator", async () => {
	reset();
	const { search, ALL_SEARCH_PROVIDERS, providerLabel } = await import("../gemini-search.ts");
	assert.ok(!ALL_SEARCH_PROVIDERS.includes("baizhi"));
	await assert.rejects(search("q", { provider: "auto" }));
	await assert.rejects(search("q", { provider: "all" }));
	assert.equal(calls.length, 0);
	assert.equal((await search("q", { provider: "baizhi" })).provider, "baizhi");
	assert.equal((await search("q", { provider: ["baizhi"] })).provider, "all");
	assert.equal(providerLabel("baizhi"), "Baizhi");
	const { generateCuratorPage } = await import("../curator-page.ts");
	const available = new Proxy({ all: false, baizhi: true }, { get: (target, property) => target[property] ?? false });
	assert.match(generateCuratorPage(["q"], "token", 20, available, "baizhi", "baizhi", [], null), /data-provider="baizhi"/);
});

test("real Pi resource loader, extension binding and agent prompt dispatch Baizhi; includeContent does not guess sources", async () => {
	reset();
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { getModel } = await import("@earendil-works/pi-ai/compat");
	const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	const { fileURLToPath } = await import("node:url");
	const settings = SettingsManager.create(home, home);
	settings.setCompactionEnabled(false);
	const loader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd: home, agentDir: home, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(home), model: getModel("openai", "gpt-4o-mini"), tools: ["web_search"] });
	const errors = [], events = [];
	try {
		await session.modelRuntime.setRuntimeApiKey("openai", "synthetic-model-key-never-sent");
		await session.bindExtensions({ mode: "sdk", onError: err => errors.push(err) });
		assert.ok(session.getAllTools().some(tool => tool.name === "web_search"));
		session.subscribe(event => { if (event.type === "tool_execution_end") events.push(event); });
		let planned;
		session.agent.streamFunction = () => {
			const stream = new AssistantMessageEventStream();
			const args = planned; planned = undefined;
			const message = { role: "assistant", api: "openai-completions", provider: "openai", model: "gpt-4o-mini", content: args ? [{ type: "toolCall", id: `fixture-${events.length}`, name: "web_search", arguments: args }] : [{ type: "text", text: "Synthetic turn complete." }], stopReason: args ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
		};
		planned = { query: "host 中文", provider: "baizhi", numResults: 2, recencyFilter: "year", domainFilter: ["example.com"], includeContent: true, workflow: "none" };
		await session.prompt("Execute the synthetic tool plan.");
		assert.equal(events.length, 1);
		assert.equal(events[0].isError, false);
		assert.match(JSON.stringify(events[0].result), /opaque search result/);
		assert.deepEqual(calls.find(c => c.rpc?.method === "tools/call").rpc.params.arguments, { query: "host 中文", count: 2, need_summary: false, time_range: "year", filter: { domains: ["example.com"] } });
		assert.equal(calls.filter(c => c.rpc?.method === "tools/call").length, 1);
		assert.equal(calls.at(-1).method, "DELETE");
		assert.deepEqual(errors, []);
		assert.ok(!JSON.stringify({ events, errors }).includes(key));
		await session.reload();
		assert.ok(session.getAllTools().some(tool => tool.name === "web_search"));
	} finally { session.dispose(); }
});

test("routing keeps safe HTTP/network classifications and never falls back after caller cancellation", async () => {
	const { spawnSync } = await import("node:child_process");
	const moduleUrl = new URL("../gemini-search.ts", import.meta.url).href;
	for (const failure of ["http401", "http429", "http503", "network", "invalid-json", "abort"]) {
		const dir = await mkdtemp(join(tmpdir(), "pi-baizhi-routing-"));
		try {
			await writeFile(join(dir, "web-search.json"), JSON.stringify({ searchRouting: { providers: ["baizhi", "brave"], fallbackOn: ["network", "transient", "quota", "invalid-response"] } }));
			const env = { ...process.env, PI_CODING_AGENT_DIR: dir, BAIZHI_API_KEY: key, BRAVE_API_KEY: "synthetic-brave" };
			const child = spawnSync(process.execPath, ["--input-type=module"], { env, encoding: "utf8", timeout: 15_000, input: `
				const failure = ${JSON.stringify(failure)}, calls = [], controller = new AbortController();
				globalThis.fetch = async (url, init) => {
					const host = new URL(url).hostname; calls.push(host);
					if (host === "agent-toolkit.app.baizhi.cloud") {
						if (failure === "network") throw new TypeError("private remote error ${key}");
						if (failure === "abort") { controller.abort(); throw new Error("private abort ${key}"); }
						if (failure === "invalid-json") return new Response("not json ${key}", { headers: { "content-type": "application/json" } });
						return new Response("private body ${key}", { status: Number(failure.slice(4)) });
					}
					if (host === "api.search.brave.com") return new Response(JSON.stringify({ web: { results: [{ title: "Fallback", url: "https://example.com", description: "synthetic" }] } }), { headers: { "content-type": "application/json" } });
					throw new Error("Unexpected network destination");
				};
				try { const response = await (await import(${JSON.stringify(moduleUrl)})).search("q", { signal: controller.signal }); console.log(JSON.stringify({ provider: response.provider, calls })); }
				catch (error) { console.log(JSON.stringify({ kind: error.kind, error: String(error), calls })); }
			` });
			assert.equal(child.status, 0, child.stderr);
			assert.ok(!`${child.stdout}${child.stderr}`.includes(key));
			const result = JSON.parse(child.stdout);
			if (failure === "http401" || failure === "abort") {
				assert.equal(result.kind, failure === "http401" ? "auth" : "aborted");
				assert.ok(!result.calls.includes("api.search.brave.com"));
			} else assert.equal(result.provider, "brave", JSON.stringify(result));
		} finally { await rm(dir, { recursive: true, force: true }); }
	}
});
