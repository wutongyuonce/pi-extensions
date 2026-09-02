// 卡片构建测试（spec §9）：schema 2.0 结构、按钮交互、doctor 命名。
// 2026-08-14 修复：飞书卡片 schema 2.0 移除 tag:"action"（ErrCode 200861），
// 按钮必须直接放 body.elements 且用 behaviors:[{type:"callback",value}] 回传。

import test from "node:test";
import assert from "node:assert/strict";
import {
	buildApprovalCard,
	buildHelpCard,
	buildSimpleTextCard,
	buildStatusCard,
	buildWelcomeCard,
} from "../../../src/presentation/cards.ts";

type Json = Record<string, unknown>;

function collectButtons(node: unknown, acc: Array<Json> = []): Array<Json> {
	if (Array.isArray(node)) {
		for (const item of node) collectButtons(item, acc);
		return acc;
	}
	if (node && typeof node === "object") {
		const obj = node as Json;
		if (obj.tag === "button") acc.push(obj);
		for (const v of Object.values(obj)) collectButtons(v, acc);
	}
	return acc;
}

test("所有卡片声明 schema 2.0", () => {
	for (const card of [
		buildWelcomeCard("测试"),
		buildHelpCard(),
		buildApprovalCard("a1", "bash", "ls"),
		buildStatusCard("connected", []),
		buildSimpleTextCard("hi"),
	]) {
		assert.equal((card as Json).schema, "2.0");
	}
});

test('卡片不含 tag:"action"（schema 2.0 已移除该能力，200861）', () => {
	const cards = [
		buildWelcomeCard("测试"),
		buildHelpCard(),
		buildApprovalCard("a1", "bash", "ls"),
		buildStatusCard("connected", []),
	];
	let actionCount = 0;
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) return n.forEach(walk);
		if (n && typeof n === "object") {
			const obj = n as Json;
			if (obj.tag === "action") actionCount++;
			Object.values(obj).forEach(walk);
		}
	};
	cards.forEach(walk);
	assert.equal(actionCount, 0, "schema 2.0 卡片不得包含 action 容器");
});

test("按钮直接位于 elements（tag:button）且用 behaviors callback 回传", () => {
	const card = buildHelpCard();
	const buttons = collectButtons(card);
	assert.ok(
		buttons.length >= 8,
		`help 卡至少 8 个按钮，实际 ${buttons.length}`,
	);
	for (const b of buttons) {
		assert.equal(b.tag, "button");
		assert.ok(
			Array.isArray(b.behaviors),
			"按钮必须有 behaviors（schema 2.0 回传）",
		);
		const callback = (b.behaviors as Json[]).find((x) => x.type === "callback");
		assert.ok(callback, "behaviors 必须含 callback 类型");
		assert.ok(
			callback.value && typeof callback.value === "object",
			"callback 带 value",
		);
	}
});

test("help 卡按钮 op 覆盖核心命令，无 support 旧命名", () => {
	const card = buildHelpCard();
	const ops = collectButtons(card).map((b) => {
		const callback = (b.behaviors as Json[]).find((x) => x.type === "callback");
		return (callback?.value as Json)?.op as string;
	});
	for (const op of ["new", "resume", "model", "stop", "status", "doctor"]) {
		assert.ok(ops.includes(op), `help 卡缺 ${op} 按钮`);
	}
	assert.ok(!ops.includes("support"), "support 已改名 doctor");
	assert.ok(ops.includes("doctor"), "导出诊断按钮 op 应为 doctor");
});

test("审批卡 approve/deny 按钮回传 approvalId", () => {
	const card = buildApprovalCard("appr-123", "bash", "rm -rf /", true);
	const buttons = collectButtons(card);
	assert.equal(buttons.length, 2);
	const ops = buttons.map((b) => {
		const callback = (b.behaviors as Json[]).find((x) => x.type === "callback");
		return callback?.value as Json;
	});
	const approve = ops.find((v) => v.op === "approve");
	const deny = ops.find((v) => v.op === "deny");
	assert.ok(approve, "有批准按钮");
	assert.ok(deny, "有拒绝按钮");
	assert.equal(approve.approvalId, "appr-123");
	assert.equal(deny.approvalId, "appr-123");
	// 危险命令 → primary/danger 类型
	assert.equal((buttons[0] as Json).type, "primary");
	assert.equal((buttons[1] as Json).type, "danger");
});

test("状态卡含 doctor 导出按钮", () => {
	const card = buildStatusCard("connected", ["line"]);
	const ops = collectButtons(card).map((b) => {
		const callback = (b.behaviors as Json[]).find((x) => x.type === "callback");
		return (callback?.value as Json)?.op as string;
	});
	assert.ok(ops.includes("doctor"), "状态卡导出诊断按钮 op=doctor");
});

test("欢迎卡按钮 op 为 help/model/status", () => {
	const card = buildWelcomeCard("测试桥");
	const ops = collectButtons(card).map((b) => {
		const callback = (b.behaviors as Json[]).find((x) => x.type === "callback");
		return (callback?.value as Json)?.op as string;
	});
	for (const op of ["help", "model", "status"]) {
		assert.ok(ops.includes(op), `欢迎卡缺 ${op}`);
	}
});
