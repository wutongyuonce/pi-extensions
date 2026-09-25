import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const crawl4aiModuleUrl = new URL("../crawl4ai.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;
const activityModuleUrl = new URL("../activity.ts", import.meta.url).href;

// Each child gets its own empty config home so a developer's real web-search.json never leaks into a test.
function runChild(script, env = {}, config = null) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-crawl4ai-"));
	if (config) writeFileSync(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const childEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home };
	for (const key of [
		"XDG_CONFIG_HOME", "CRAWL4AI_BASE_URL", "CRAWL4AI_API_TOKEN",
		"FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "FIRECRAWL_API_VERSION", "FIRECRAWL_FRESH_SCRAPE",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "GEMINI_API_KEY",
		"BRIGHTDATA_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "BRIGHTDATA_UNLOCKER_ZONE",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

const PUBLIC_LOOKUP = `async () => [{ address: "93.184.216.34", family: 4 }]`;

test("Crawl4AI extraction posts a fit markdown request with a bearer token and titles from the first heading", async () => {
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				url: "https://example.com/article",
				filter: "fit",
				markdown: "# Example Domain\\nThis domain is for use in documentation examples.\\n",
				success: true,
			}), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const result = await extractWithCrawl4ai("https://example.com/article", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ captured, result }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com/", CRAWL4AI_API_TOKEN: "c4a-test-token" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://crawl.example.com/md");
	assert.equal(output.captured.headers.authorization, "Bearer c4a-test-token");
	assert.equal(output.captured.headers["content-type"], "application/json");
	assert.deepEqual(output.captured.body, { url: "https://example.com/article", f: "fit" });
	assert.deepEqual(output.result, {
		url: "https://example.com/article",
		title: "Example Domain",
		content: "# Example Domain\nThis domain is for use in documentation examples.",
		error: null,
	});
});

test("Crawl4AI extraction sends no Authorization header without a token and returns null for empty markdown", async () => {
	const child = runChild(`
		let headers = null;
		globalThis.fetch = async (_url, init) => {
			headers = Object.fromEntries(new Headers(init.headers));
			return new Response(JSON.stringify({ success: true, markdown: "  \\n" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const result = await extractWithCrawl4ai("https://example.com/empty", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ headers, result }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.headers.authorization, undefined);
	assert.equal(output.result, null);
});

test("Crawl4AI resolves the token from a config credential source", async () => {
	const child = runChild(`
		let authorization = null;
		globalThis.fetch = async (_url, init) => {
			authorization = Object.fromEntries(new Headers(init.headers)).authorization ?? null;
			return new Response(JSON.stringify({ success: true, markdown: "# Configured" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const result = await extractWithCrawl4ai("https://example.com/configured", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ authorization, result }));
	`, { CRAWL4AI_TEST_TOKEN: "from-env-source" }, { crawl4aiBaseUrl: "https://crawl.example.com", crawl4aiApiToken: "$CRAWL4AI_TEST_TOKEN" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.authorization, "Bearer from-env-source");
	assert.equal(output.result.title, "Configured");
});

test("fetch_content falls back to configured Crawl4AI before hosted providers", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response(JSON.stringify({ success: true, markdown: "# Rendered\\nRendered body" }), { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/client-rendered", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/client-rendered", "https://crawl.example.com/md"]);
	assert.deepEqual(output.result, { url: "https://example.com/client-rendered", title: "Rendered", content: "# Rendered\nRendered body", error: null });
});

test("fetch_content tries Firecrawl before Crawl4AI when both are configured", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			if (calls.length === 2) return new Response("gateway", { status: 502 });
			return new Response(JSON.stringify({ success: true, markdown: "# Second\\nSecond body" }), { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/order", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`, { FIRECRAWL_BASE_URL: "https://firecrawl.example.com", CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.com/order",
		"https://firecrawl.example.com/v2/scrape",
		"https://crawl.example.com/md",
	]);
	assert.equal(output.result.content, "# Second\nSecond body");
});

test("Crawl4AI extraction errors remain visible in fetch_content guidance", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response("gateway", { status: 502 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/client-rendered", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, error: result.error }));
	`, {}, { crawl4aiBaseUrl: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Crawl4AI fallback failed: Crawl4AI md error 502/);
	assert.match(output.error, /Set crawl4aiBaseUrl in/);
});

test("Crawl4AI unsuccessful envelopes mentioning abort remain visible in fetch_content guidance", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response(JSON.stringify({ success: false, error: "browser navigation aborted unexpectedly" }), { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/client-rendered", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, error: result.error }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/client-rendered", "https://crawl.example.com/md"]);
	assert.match(output.error, /Crawl4AI fallback failed: Crawl4AI md unsuccessful: browser navigation aborted unexpectedly/);
	assert.notEqual(output.error, "Aborted");
});

test("Crawl4AI malformed and unsuccessful envelopes throw visible errors", async () => {
	const child = runChild(`
		const responses = [
			[],
			{ markdown: "# No success flag" },
			{ success: true },
			{ success: false, error: "browser crashed" },
			{ success: false, detail: "Authentication required" },
		];
		let index = 0;
		globalThis.fetch = async () => new Response(JSON.stringify(responses[index++]), { status: 200 });
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const errors = [];
		for (let i = 0; i < responses.length; i++) {
			try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
			catch (err) { errors.push(err.message); }
		}
		console.log(JSON.stringify({ errors }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()).errors, [
		"Crawl4AI md returned an unexpected response shape",
		"Crawl4AI md returned an unexpected response shape",
		"Crawl4AI md returned markdown in an unexpected shape",
		"Crawl4AI md unsuccessful: browser crashed",
		"Crawl4AI md unsuccessful: Authentication required",
	]);
});

test("Crawl4AI never leaks the configured token through a JSON parse failure", async () => {
	const child = runChild(`
		globalThis.fetch = async () => new Response("c4a-secret", { status: 200 });
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
		let thrown = null;
		try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { thrown = err.message; }
		const logged = JSON.stringify(activityMonitor.getEntries());
		console.log(JSON.stringify({ thrown, logged }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com", CRAWL4AI_API_TOKEN: "c4a-secret" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.thrown, "Crawl4AI md returned invalid JSON");
	assert.doesNotMatch(output.thrown, /c4a-secret/);
	assert.doesNotMatch(output.logged, /c4a-secret/);
});

test("Crawl4AI redacts a token that crosses the HTTP error excerpt boundary", async () => {
	const child = runChild(`
		globalThis.fetch = async () => new Response("x".repeat(295) + "boundary-secret-token" + "tail", { status: 502 });
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
		let thrown = null;
		try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { thrown = err.message; }
		const logged = JSON.stringify(activityMonitor.getEntries());
		console.log(JSON.stringify({ thrown, logged }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com", CRAWL4AI_API_TOKEN: "boundary-secret-token" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.thrown, /^Crawl4AI md error 502: /);
	assert.doesNotMatch(output.thrown, /bound/);
	assert.doesNotMatch(output.logged, /bound/);
});

test("Crawl4AI rejects private targets without invoking the configured instance", async () => {
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const errors = [];
		for (const target of ["http://127.0.0.1:8080/admin", "http://localhost:8080/admin", "http://169.254.169.254/latest/meta-data"]) {
			try { await extractWithCrawl4ai(target); } catch (err) { errors.push(err.message); }
		}
		try { await extractWithCrawl4ai("https://internal.example.com/", undefined, { lookup: async () => [{ address: "10.0.0.5", family: 4 }] }); }
		catch (err) { errors.push(err.message); }
		console.log(JSON.stringify({ errors, fetchCalls }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.errors.length, 4);
	assert.equal(output.fetchCalls, 0);
});

test("Crawl4AI API base allows configured loopback without global SSRF allow ranges", async () => {
	for (const crawl4aiBaseUrl of ["http://localhost:11235", "http://127.0.0.1:11235"]) {
		const child = runChild(`
			let calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response(JSON.stringify({ success: true, markdown: "# Local\\nLocal body" }), { status: 200 });
			};
			const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
			const result = await extractWithCrawl4ai("https://example.com/local", undefined, { lookup: ${PUBLIC_LOOKUP} });
			console.log(JSON.stringify({ calls, result }));
		`, {}, { crawl4aiBaseUrl });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.calls, [`${crawl4aiBaseUrl}/md`]);
		assert.equal(output.result.content, "# Local\nLocal body");
	}
});

test("Crawl4AI rejects every cross-origin redirect before fetching the redirected origin", async () => {
	const child = runChild(`
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const results = [];
		for (const status of [301, 302, 303, 307, 308]) {
			const calls = [];
			globalThis.fetch = async (url, init) => {
				calls.push({ url: String(url), method: init.method, body: init.body, auth: Object.fromEntries(new Headers(init.headers)).authorization ?? null });
				if (calls.length === 1) return new Response("", { status, headers: { location: "https://other.example.com/md" } });
				return new Response(JSON.stringify({ success: true, markdown: "# Redirected" }), { status: 200 });
			};
			let error = null;
			try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
			catch (err) { error = err.message; }
			results.push({ status, calls, error });
		}
		console.log(JSON.stringify({ results }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com", CRAWL4AI_API_TOKEN: "c4a-secret" });
	assert.equal(child.status, 0, child.stderr);
	const body = JSON.stringify({ url: "https://example.com/a", f: "fit" });
	for (const result of JSON.parse(child.stdout.trim()).results) {
		assert.deepEqual(result.calls, [
			{ url: "https://crawl.example.com/md", method: "POST", body, auth: "Bearer c4a-secret" },
		]);
		assert.match(result.error, /Crawl4AI refused cross-origin redirect to https:\/\/other\.example\.com/);
	}
});

test("Crawl4AI replays same-origin 301 and 302 POSTs but rejects a later cross-origin redirect", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), method: init.method, body: init.body, auth: Object.fromEntries(new Headers(init.headers)).authorization ?? null });
			if (calls.length === 1) return new Response("", { status: 302, headers: { location: "https://crawl.example.com/api/md" } });
			if (calls.length === 2) return new Response("", { status: 301, headers: { location: "https://other.example.com/md" } });
			return new Response(JSON.stringify({ success: true, markdown: "# Redirected" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		let error = null;
		try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ calls, error }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com", CRAWL4AI_API_TOKEN: "c4a-secret" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	const body = JSON.stringify({ url: "https://example.com/a", f: "fit" });
	assert.deepEqual(output.calls, [
		{ url: "https://crawl.example.com/md", method: "POST", body, auth: "Bearer c4a-secret" },
		{ url: "https://crawl.example.com/api/md", method: "POST", body, auth: "Bearer c4a-secret" },
	]);
	assert.match(output.error, /Crawl4AI refused cross-origin redirect to https:\/\/other\.example\.com/);
});

test("Crawl4AI follows a 303 as a bodyless GET and keeps the POST on 307", async () => {
	const child = runChild(`
		const run = async (status) => {
			let calls = [];
			globalThis.fetch = async (url, init) => {
				calls.push({ url: String(url), method: init.method, hasBody: Boolean(init.body) });
				if (calls.length === 1) return new Response("", { status, headers: { location: "https://crawl.example.com/elsewhere" } });
				return new Response(JSON.stringify({ success: true, markdown: "# Followed" }), { status: 200 });
			};
			const { extractWithCrawl4ai, clearCrawl4aiConfigCache } = await import(${JSON.stringify(crawl4aiModuleUrl)});
			clearCrawl4aiConfigCache();
			await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
			return calls[1];
		};
		console.log(JSON.stringify({ seeOther: await run(303), temporary: await run(307) }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.seeOther, { url: "https://crawl.example.com/elsewhere", method: "GET", hasBody: false });
	assert.deepEqual(output.temporary, { url: "https://crawl.example.com/elsewhere", method: "POST", hasBody: true });
});

test("Crawl4AI does not resurrect the POST when a 303 is followed by a 301", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), method: init.method, hasBody: Boolean(init.body) });
			if (calls.length === 1) return new Response("", { status: 303, headers: { location: "https://crawl.example.com/step" } });
			if (calls.length === 2) return new Response("", { status: 301, headers: { location: "https://crawl.example.com/final" } });
			return new Response(JSON.stringify({ success: true, markdown: "# Followed" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()).calls, [
		{ url: "https://crawl.example.com/md", method: "POST", hasBody: true },
		{ url: "https://crawl.example.com/step", method: "GET", hasBody: false },
		{ url: "https://crawl.example.com/final", method: "GET", hasBody: false },
	]);
});

test("Crawl4AI keeps the loopback exemption on the configured origin and blocks a pivot to another loopback service", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), method: init.method, body: init.body });
			if (calls.length === 1) return new Response("", { status: 302, headers: { location: "http://127.0.0.1:11235/api/md" } });
			if (calls.length === 2) return new Response("", { status: 302, headers: { location: "http://127.0.0.2:9999/private" } });
			return new Response(JSON.stringify({ success: true, markdown: "# Pivoted" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		let pivotError = null;
		try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { pivotError = err.message; }
		console.log(JSON.stringify({ calls, pivotError }));
	`, {}, { crawl4aiBaseUrl: "http://127.0.0.1:11235" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	const body = JSON.stringify({ url: "https://example.com/a", f: "fit" });
	// The same-origin hop is still allowed and still replays the POST; the cross-origin loopback hop is never fetched.
	assert.deepEqual(output.calls, [
		{ url: "http://127.0.0.1:11235/md", method: "POST", body },
		{ url: "http://127.0.0.1:11235/api/md", method: "POST", body },
	]);
	assert.match(output.pivotError, /Blocked internal address/);
});

test("Crawl4AI blocks a loopback base redirecting to localhost", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response("", { status: 302, headers: { location: "http://localhost:11235/md" } });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		let redirectError = null;
		try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { redirectError = err.message; }
		console.log(JSON.stringify({ calls, redirectError }));
	`, {}, { crawl4aiBaseUrl: "http://127.0.0.1:11235" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["http://127.0.0.1:11235/md"]);
	assert.match(output.redirectError, /Blocked internal hostname/);
});

test("Crawl4AI blocks configured base redirects to private targets", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		let redirectError = null;
		try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { redirectError = err.message; }
		console.log(JSON.stringify({ calls, redirectError }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://crawl.example.com/md"]);
	assert.match(output.redirectError, /Blocked internal address/);
});
