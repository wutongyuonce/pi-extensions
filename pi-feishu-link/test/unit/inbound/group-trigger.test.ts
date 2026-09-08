import test from "node:test";
import assert from "node:assert/strict";
import {
	extractPlainTextForTrigger,
	parseGroupKeywords,
	shouldAcceptGroupMessage,
	textMatchesKeywords,
} from "../../../src/inbound/group-trigger.ts";

test("parseGroupKeywords splits comma/semicolon/CJK and trims", () => {
	assert.deepEqual(parseGroupKeywords("志胜, zhisheng; ZS"), [
		"志胜",
		"zhisheng",
		"ZS",
	]);
	assert.deepEqual(parseGroupKeywords(["  a ", "", "b"]), ["a", "b"]);
	assert.deepEqual(parseGroupKeywords(undefined), []);
	assert.deepEqual(parseGroupKeywords(""), []);
	assert.deepEqual(parseGroupKeywords("甲；乙，丙"), ["甲", "乙", "丙"]);
});

test("textMatchesKeywords is case-insensitive substring after whitespace normalize", () => {
	assert.equal(textMatchesKeywords("你好 志胜 在吗", ["志胜"]), true);
	assert.equal(textMatchesKeywords("Hey ZHISHENG please", ["zhisheng"]), true);
	assert.equal(textMatchesKeywords("hello world", ["志胜", "zs"]), false);
	assert.equal(textMatchesKeywords("  ", ["志胜"]), false);
	assert.equal(textMatchesKeywords("x", []), false);
	assert.equal(textMatchesKeywords("multi   space line", ["space line"]), true);
});

test("extractPlainTextForTrigger reads text/post content", () => {
	assert.equal(
		extractPlainTextForTrigger("text", JSON.stringify({ text: "叫志胜一下" })),
		"叫志胜一下",
	);
	const post = JSON.stringify({
		title: "标题",
		content: [
			[{ tag: "text", text: "第一段" }],
			[{ tag: "text", text: "第二段" }],
		],
	});
	assert.equal(
		extractPlainTextForTrigger("post", post),
		"标题\n第一段\n第二段",
	);
	assert.equal(
		extractPlainTextForTrigger("image", JSON.stringify({ image_key: "x" })),
		"",
	);
	assert.equal(extractPlainTextForTrigger("text", "not-json"), "");
});

test("p2p always accepts", () => {
	const d = shouldAcceptGroupMessage({
		chatType: "p2p",
		groupPolicy: "mention",
		mentioned: false,
		text: "hi",
		keywords: [],
		alsoOnReply: true,
		replyToBot: false,
	});
	assert.deepEqual(d, { accept: true, reason: "open" });
});

test("open policy accepts everything in groups", () => {
	const d = shouldAcceptGroupMessage({
		chatType: "group",
		groupPolicy: "open",
		mentioned: false,
		text: "随便聊聊",
		keywords: [],
		alsoOnReply: false,
		replyToBot: false,
	});
	assert.deepEqual(d, { accept: true, reason: "open" });
});

test("mention policy: mention > reply > keyword > ignored", () => {
	const base = {
		chatType: "group" as const,
		groupPolicy: "mention" as const,
		keywords: ["价格"],
		alsoOnReply: true,
	};
	assert.deepEqual(
		shouldAcceptGroupMessage({
			...base,
			mentioned: true,
			text: "你好",
			replyToBot: false,
		}),
		{ accept: true, reason: "mention" },
	);
	assert.deepEqual(
		shouldAcceptGroupMessage({
			...base,
			mentioned: false,
			text: "你好",
			replyToBot: true,
		}),
		{ accept: true, reason: "reply" },
	);
	assert.deepEqual(
		shouldAcceptGroupMessage({
			...base,
			mentioned: false,
			text: "这个价格多少",
			replyToBot: false,
		}),
		{ accept: true, reason: "keyword" },
	);
	assert.deepEqual(
		shouldAcceptGroupMessage({
			...base,
			mentioned: false,
			text: "无关内容",
			replyToBot: false,
		}),
		{ accept: false, reason: "ignored" },
	);
});

test("mention policy without reply/alsoOnReply still triggers on mention only", () => {
	const d = shouldAcceptGroupMessage({
		chatType: "group",
		groupPolicy: "mention",
		mentioned: false,
		text: "hi",
		keywords: [],
		alsoOnReply: false,
		replyToBot: true,
	});
	assert.equal(d.accept, false);
});
