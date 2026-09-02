import assert from "node:assert/strict";
import { test } from "node:test";

import { extractContent } from "../extract.ts";

const originalFetch = globalThis.fetch;
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const toolNames = { webSearch: "web_search", fetchContent: "fetch_content" };

function stubStatus(t, status, statusText) {
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async () => new Response("gone", { status, statusText });
}

test("404 drops the provider checklist and points at the registered tools", async (t) => {
	stubStatus(t, 404, "Not Found");

	const result = await extractContent("https://example.com/missing-page", undefined, { lookup, toolNames });

	assert.equal(result.status, 404);
	assert.match(result.error, /HTTP 404: Not Found/);
	assert.doesNotMatch(result.error, /Fallback options:/);
	assert.match(result.error, /web_search/);
	assert.match(result.error, /fetch_content/);
});

test("410 gets the same not-found guidance", async (t) => {
	stubStatus(t, 410, "Gone");

	const result = await extractContent("https://example.com/retired", undefined, { lookup, toolNames });

	assert.equal(result.status, 410);
	assert.doesNotMatch(result.error, /Fallback options:/);
	assert.match(result.error, /web_search/);
});

test("guidance uses the registered public tool names", async (t) => {
	stubStatus(t, 404, "Not Found");

	const result = await extractContent("https://example.com/missing-page", undefined, {
		lookup,
		toolNames: { webSearch: "webfinder", fetchContent: "pageget" },
	});

	assert.match(result.error, /webfinder/);
	assert.match(result.error, /pageget/);
	assert.doesNotMatch(result.error, /web_search/);
});

test("guidance stays generic when the caller does not know the tool names", async (t) => {
	stubStatus(t, 404, "Not Found");

	const result = await extractContent("https://example.com/missing-page", undefined, { lookup });

	assert.doesNotMatch(result.error, /Fallback options:/);
	assert.doesNotMatch(result.error, /web_search/);
	assert.match(result.error, /Find the current URL, then retry the fetch/);
});

test("guidance omits the fetch tool when only search is registered", async (t) => {
	stubStatus(t, 404, "Not Found");

	const result = await extractContent("https://example.com/missing-page", undefined, {
		lookup,
		toolNames: { webSearch: "web_search" },
	});

	assert.match(result.error, /web_search/);
	assert.doesNotMatch(result.error, /fetch_content/);
});

test("transient errors keep the fallback checklist", async (t) => {
	stubStatus(t, 500, "Internal Server Error");

	const result = await extractContent("https://example.com/oops", undefined, { lookup, toolNames });

	assert.equal(result.status, 500);
	assert.match(result.error, /Fallback options:/);
	assert.match(result.error, /Use web_search to find content about this topic/);
});

test("the checklist search bullet follows the registered search tool name", async (t) => {
	stubStatus(t, 500, "Internal Server Error");

	const result = await extractContent("https://example.com/oops", undefined, {
		lookup,
		toolNames: { webSearch: "webfinder" },
	});

	assert.match(result.error, /Use webfinder to find content about this topic/);
	assert.doesNotMatch(result.error, /web_search/);
});
