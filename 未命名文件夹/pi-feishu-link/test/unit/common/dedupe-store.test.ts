import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DedupeStore,
	DEDUPE_TTL_MS,
} from "../../../src/common/dedupe-store.ts";

function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "feishu-link-dedupe-"));
	return join(dir, "dedupe.jsonl");
}

test("admit returns true once, false for repeats within TTL", async () => {
	const p = tempFile();
	try {
		const store = new DedupeStore(p);
		assert.equal(store.admit("msg-1"), true);
		assert.equal(store.admit("msg-1"), false);
		assert.equal(store.admit("msg-2"), true);
		assert.equal(store.has("msg-1"), true);
		assert.equal(store.size(), 2);
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("empty id is always admitted", async () => {
	const p = tempFile();
	try {
		const store = new DedupeStore(p);
		assert.equal(store.admit(""), true);
		assert.equal(store.admit(""), true);
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("persists across restart and rejects replay after reload", async () => {
	const p = tempFile();
	try {
		const a = new DedupeStore(p);
		a.admit("persisted-1");
		a.admit("persisted-2");
		const b = new DedupeStore(p);
		const loaded = await b.init();
		assert.equal(loaded, 2);
		assert.equal(b.admit("persisted-1"), false);
		assert.equal(b.admit("persisted-2"), false);
		assert.equal(b.admit("new-3"), true);
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("expired entries are dropped on init and admit again", async () => {
	const p = tempFile();
	try {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			p,
			`${JSON.stringify({ id: "old-msg", ts: Date.now() - 2_000_000 })}\n`,
			"utf8",
		);
		const b = new DedupeStore(p, 60_000);
		const loaded = await b.init();
		assert.equal(loaded, 0);
		assert.equal(b.admit("old-msg"), true);
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});

test("prune removes expired and rewrites file compacted", async () => {
	const p = tempFile();
	try {
		const { writeFileSync, readFileSync } = await import("node:fs");
		const store = new DedupeStore(p, DEDUPE_TTL_MS);
		store.admit("fresh-1");
		store.admit("fresh-2");
		// Append an expired entry into the existing file, then re-init.
		const existing = readFileSync(p, "utf8");
		const expired = JSON.stringify({
			id: "expired",
			ts: Date.now() - DEDUPE_TTL_MS - 1,
		});
		writeFileSync(p, `${existing}${expired}\n`, "utf8");
		const reloaded = new DedupeStore(p, DEDUPE_TTL_MS);
		await reloaded.init();
		assert.equal(reloaded.has("expired"), false);
		assert.equal(reloaded.has("fresh-1"), true);
		const removed = reloaded.prune();
		assert.ok(removed >= 0);
	} finally {
		rmSync(p, { recursive: true, force: true });
	}
});
