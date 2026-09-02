import test from "node:test";
import assert from "node:assert/strict";
import { probeGroupMessagePermission } from "../../../src/inbound/permission-probe.ts";

test("ok when listing messages succeeds", async () => {
	const result = await probeGroupMessagePermission({
		listMessages: async () => [{ message_id: "om_1" }],
		groupChatIds: () => ["oc_1"],
	});
	assert.equal(result.status, "ok");
});

test("missing when a permission code is returned", async () => {
	const result = await probeGroupMessagePermission({
		listMessages: async () => {
			const err = new Error("forbidden") as Error & { code?: number };
			err.code = 403;
			throw err;
		},
		groupChatIds: () => ["oc_1"],
	});
	assert.equal(result.status, "missing");
	assert.ok(result.detail.includes("获取群组中所有消息"));
});

test("missing when the error message mentions permission", async () => {
	const result = await probeGroupMessagePermission({
		listMessages: async () => {
			throw new Error("permission denied: scope not granted");
		},
		groupChatIds: () => ["oc_1"],
	});
	assert.equal(result.status, "missing");
});

test("unknown when no group chats are known", async () => {
	const result = await probeGroupMessagePermission({
		listMessages: async () => [],
		groupChatIds: () => [],
	});
	assert.equal(result.status, "unknown");
});

test("transient errors try the next chat; missing wins if found later", async () => {
	let calls = 0;
	const result = await probeGroupMessagePermission({
		listMessages: async (chatId) => {
			calls++;
			if (chatId === "oc_1") throw new Error("network timeout");
			throw Object.assign(new Error("denied"), { code: 91402 });
		},
		groupChatIds: () => ["oc_1", "oc_2"],
	});
	assert.equal(calls, 2);
	assert.equal(result.status, "missing");
});

test("all-transient failures → unknown", async () => {
	const result = await probeGroupMessagePermission({
		listMessages: async () => {
			throw new Error("network timeout");
		},
		groupChatIds: () => ["oc_1", "oc_2"],
	});
	assert.equal(result.status, "unknown");
});
