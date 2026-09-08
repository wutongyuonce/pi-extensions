import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_LIMITS,
	isVoiceMessage,
	parseAttachmentKeys,
	processAttachments,
} from "../../../src/inbound/attachment-pipeline.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

function msg(
	overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage {
	return {
		messageId: "om_1",
		chatId: "oc_1",
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: "ou_1",
		senderType: "user",
		msgType: "text",
		content: JSON.stringify({ text: "hi" }),
		timestamp: Date.now(),
		...overrides,
	};
}

test("parseAttachmentKeys: image_key for images, file_key for files", () => {
	const img = msg({
		msgType: "image",
		content: JSON.stringify({ image_key: "img_v2_abc" }),
	});
	assert.deepEqual(parseAttachmentKeys(img), [
		{ key: "img_v2_abc", type: "image" },
	]);
	const file = msg({
		msgType: "file",
		content: JSON.stringify({ file_key: "file_v2_xyz" }),
	});
	assert.deepEqual(parseAttachmentKeys(file), [
		{ key: "file_v2_xyz", type: "file" },
	]);
	assert.deepEqual(parseAttachmentKeys(msg()), []);
	// malformed content → no keys
	assert.deepEqual(
		parseAttachmentKeys(msg({ msgType: "image", content: "not-json" })),
		[],
	);
});

test("image attachments become prompt images with base64 data", async () => {
	const img = msg({
		msgType: "image",
		content: JSON.stringify({ image_key: "img_v2_abc" }),
	});
	const downloader = {
		download: async (_mid: string, key: string) => {
			assert.equal(key, "img_v2_abc");
			return {
				bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
				mimeType: "image/png",
			};
		},
	};
	const result = await processAttachments(img, downloader);
	assert.equal(result.images.length, 1);
	assert.equal(result.images[0]?.mimeType, "image/png");
	assert.equal(
		result.images[0]?.data,
		Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
	);
	assert.equal(result.unsupported.length, 0);
});

test("text files become extracted text; binaries are unsupported", async () => {
	const file = msg({
		msgType: "file",
		content: JSON.stringify({ file_key: "f1" }),
	});
	const downloader = {
		download: async (_mid: string, key: string) => {
			if (key === "f1")
				return {
					bytes: Buffer.from("hello world"),
					mimeType: "text/plain",
					filename: "a.txt",
				};
			return {
				bytes: Buffer.from([0, 1, 2, 3]),
				mimeType: "application/octet-stream",
				filename: "a.bin",
			};
		},
	};
	const txt = await processAttachments(file, downloader);
	assert.equal(txt.text, "hello world");
	assert.equal(txt.unsupported.length, 0);

	const bin = msg({
		msgType: "file",
		content: JSON.stringify({ file_key: "f2" }),
	});
	const binResult = await processAttachments(bin, downloader);
	assert.equal(binResult.text, "");
	assert.equal(binResult.unsupported.length, 1);
	assert.ok(binResult.unsupported[0]?.includes("暂不支持提取"));
});

test("download failure → unsupported, not throw", async () => {
	const file = msg({
		msgType: "file",
		content: JSON.stringify({ file_key: "bad" }),
	});
	const downloader = {
		download: async () => {
			throw new Error("network");
		},
	};
	const result = await processAttachments(file, downloader);
	assert.equal(result.images.length, 0);
	assert.equal(result.unsupported.length, 1);
	assert.ok(result.unsupported[0]?.includes("下载失败"));
});

test("size limits enforced: image over maxImageBytes rejected", async () => {
	const img = msg({
		msgType: "image",
		content: JSON.stringify({ image_key: "big" }),
	});
	const downloader = {
		download: async () => ({
			bytes: Buffer.alloc(1024 * 1024 * 11),
			mimeType: "image/jpeg",
		}),
	};
	const result = await processAttachments(img, downloader, {
		...DEFAULT_LIMITS,
		maxImageBytes: 1024 * 1024 * 10,
	});
	assert.equal(result.images.length, 0);
	assert.ok(result.unsupported[0]?.includes("上限"));
});

test("total byte cap rejects oversized attachment", async () => {
	const img = msg({
		msgType: "image",
		content: JSON.stringify({ image_key: "a" }),
	});
	const downloader = {
		download: async () => ({
			bytes: Buffer.alloc(1024 * 1024 * 20),
			mimeType: "image/jpeg",
		}),
	};
	const result = await processAttachments(img, downloader, {
		...DEFAULT_LIMITS,
		maxImageBytes: 30 * 1024 * 1024,
		maxTotalBytes: 10 * 1024 * 1024,
	});
	assert.equal(result.images.length, 0);
	assert.ok(result.unsupported.some((u) => u.includes("总大小")));
});

test("text truncation at maxExtractedChars", async () => {
	const file = msg({
		msgType: "file",
		content: JSON.stringify({ file_key: "f" }),
	});
	const big = "a".repeat(200_000);
	const downloader = {
		download: async () => ({ bytes: Buffer.from(big), mimeType: "text/plain" }),
	};
	const result = await processAttachments(file, downloader);
	assert.equal(result.text.length, DEFAULT_LIMITS.maxExtractedChars);
	assert.ok(result.unsupported.some((u) => u.includes("截断")));
});

test("voice messages flagged", () => {
	assert.equal(isVoiceMessage(msg({ msgType: "audio" })), true);
	assert.equal(isVoiceMessage(msg({ msgType: "text" })), false);
});

test("I6: downloader receives the per-type cap so the stream aborts early", async () => {
	const img = msg({
		msgType: "image",
		content: JSON.stringify({ image_key: "capme" }),
	});
	const seen: number[] = [];
	const downloader = {
		download: async (
			_messageId: string,
			_key: string,
			_type: string,
			maxBytes?: number,
		) => {
			seen.push(maxBytes ?? -1);
			return { bytes: Buffer.from("img"), mimeType: "image/png" };
		},
	};
	await processAttachments(img, downloader, {
		...DEFAULT_LIMITS,
		maxImageBytes: 12345,
	});
	assert.deepEqual(seen, [12345]);

	const file = msg({
		msgType: "file",
		content: JSON.stringify({ file_key: "capme2" }),
	});
	await processAttachments(file, downloader, {
		...DEFAULT_LIMITS,
		maxTxtBytes: 6789,
	});
	assert.deepEqual(seen, [12345, 6789]);
});
