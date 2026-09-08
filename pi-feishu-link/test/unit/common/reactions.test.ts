// 表情回执策略（用户指令 2026-08-07）：
// 1. 收到用户消息 → 从随机池取一枚表情（池内排除 DONE，"已收到"即时反馈）
// 2. 任务完成 → 对触发消息打 DONE 表情（DONE 永不参与随机池）

import test from "node:test";
import assert from "node:assert/strict";
import {
	DONE_EMOJI,
	REACTION_POOL,
	VALID_EMOJI_TYPES,
	pickRandomReaction,
} from "../../../src/common/reactions.ts";

test("默认随机池不包含 DONE", () => {
	assert.ok(REACTION_POOL.length >= 3, "池至少 3 枚");
	assert.ok(!REACTION_POOL.includes(DONE_EMOJI), "DONE 永不进随机池");
});

test("pickRandomReaction 返回池内成员（注入 rng 确定性）", () => {
	assert.equal(
		pickRandomReaction(REACTION_POOL, () => 0),
		REACTION_POOL[0],
	);
	const last = REACTION_POOL[REACTION_POOL.length - 1];
	assert.equal(
		pickRandomReaction(REACTION_POOL, () => 0.999999),
		last,
	);
});

test("池内即便包含 DONE 也不会被随机到（用户要求）", () => {
	const pool = ["DONE", "THUMBSUP", "HEART"];
	for (let i = 0; i < 50; i++) {
		assert.notEqual(pickRandomReaction(pool), "DONE");
	}
});

test("空池 / 全 DONE 池回退到默认池", () => {
	assert.ok(REACTION_POOL.includes(pickRandomReaction([], () => 0)));
	assert.ok(REACTION_POOL.includes(pickRandomReaction(["DONE"], () => 0)));
});

test("自定义池生效（有效类型）", () => {
	assert.equal(
		pickRandomReaction(["Fire", "CLAP"], () => 0),
		"Fire",
	);
	assert.equal(
		pickRandomReaction(["Fire", "CLAP"], () => 0.5),
		"CLAP",
	);
});

test("pickRandomReaction 过滤无效类型（配置池含 FIRE/AMAZE 等非法值）", () => {
	// 用户配置池含 4 个飞书不支持的 emoji_type（FIRE 应为 Fire，AMAZE/AWESOME/COOL 不存在）
	const badPool = [
		"THUMBSUP",
		"OK",
		"HEART",
		"FIRE",
		"AMAZE",
		"AWESOME",
		"COOL",
	];
	for (let i = 0; i < 200; i++) {
		const picked = pickRandomReaction(badPool, () => i / 200);
		assert.ok(VALID_EMOJI_TYPES.has(picked), `选出非法类型：${picked}`);
		assert.ok(
			!["FIRE", "AMAZE", "AWESOME", "COOL"].includes(picked),
			`不应选出无效类型：${picked}`,
		);
	}
});

test("配置池全部无效 → 回退默认池（不再 400）", () => {
	const badPool = ["FIRE", "AMAZE", "AWESOME", "COOL"];
	for (let i = 0; i < 50; i++) {
		const picked = pickRandomReaction(badPool, () => i / 50);
		assert.ok(
			VALID_EMOJI_TYPES.has(picked),
			`全无效池必须回退默认池：${picked}`,
		);
	}
});

test("DEFAULT_CONFIG 默认池全部是飞书有效 emoji_type", async () => {
	const { DEFAULT_CONFIG } = await import("../../../src/common/config.ts");
	const r = DEFAULT_CONFIG.forward.reactions;
	for (const e of r.emojis) {
		assert.ok(VALID_EMOJI_TYPES.has(e), `默认池含无效类型：${e}`);
	}
	assert.ok(VALID_EMOJI_TYPES.has(r.doneEmoji), "DONE 应为有效类型");
});

test("未传池时使用默认池", () => {
	assert.ok(REACTION_POOL.includes(pickRandomReaction(undefined, () => 0.13)));
});

test("DEFAULT_CONFIG 接线：doneEmoji=DONE 且 emojis 池排除 DONE", async () => {
	const { DEFAULT_CONFIG } = await import("../../../src/common/config.ts");
	const r = DEFAULT_CONFIG.forward.reactions;
	assert.equal(r.doneEmoji, "DONE");
	assert.ok(!r.emojis.includes("DONE"));
	assert.ok(r.emojis.length >= 3);
});
