import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaGovernor } from "../../../src/common/quota-governor.js";

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "quota-gov-"));
}

test("记录失败达到上限 → 熔断（blocked）并给出剩余等待", () => {
	const dir = makeDir();
	try {
		const g = new QuotaGovernor({ dir, windowMs: 3_600_000, maxFailures: 12 });
		const t0 = 1_000_000;
		// 12 次失败
		for (let i = 0; i < 12; i++) g.record(false, t0 + i * 60_000);
		const verdict = g.canConnect(t0 + 12 * 60_000);
		assert.equal(verdict.allowed, false);
		assert.ok(verdict.retryAfterMs > 0, "应给出剩余等待时长");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("未达上限 → 允许连接", () => {
	const dir = makeDir();
	try {
		const g = new QuotaGovernor({ dir, windowMs: 3_600_000, maxFailures: 12 });
		for (let i = 0; i < 5; i++) g.record(false, i * 60_000);
		assert.equal(g.canConnect(6 * 60_000).allowed, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("成功连接 → 清除失败窗口 → 允许", () => {
	const dir = makeDir();
	try {
		const g = new QuotaGovernor({ dir, windowMs: 3_600_000, maxFailures: 3 });
		g.record(false, 0);
		g.record(false, 60_000);
		g.record(false, 120_000);
		assert.equal(g.canConnect(180_000).allowed, false, "3 次失败应熔断");
		g.record(true, 181_000); // 成功
		assert.equal(g.canConnect(181_000).allowed, true, "成功后解除熔断");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("窗口滑过（旧失败过期）→ 恢复允许", () => {
	const dir = makeDir();
	try {
		const g = new QuotaGovernor({ dir, windowMs: 3_600_000, maxFailures: 3 });
		g.record(false, 0);
		g.record(false, 60_000);
		g.record(false, 120_000);
		// 2 小时后：所有失败记录都过期
		assert.equal(g.canConnect(120_000 + 3_700_000).allowed, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("历史落盘 → 新实例重读 → 仍熔断（跨 daemon 生效）", () => {
	const dir = makeDir();
	try {
		const g1 = new QuotaGovernor({ dir, windowMs: 3_600_000, maxFailures: 3 });
		g1.record(false, 0);
		g1.record(false, 60_000);
		g1.record(false, 120_000);
		// 新 daemon 重新加载
		const g2 = new QuotaGovernor({ dir, windowMs: 3_600_000, maxFailures: 3 });
		assert.equal(g2.canConnect(180_000).allowed, false, "重启后仍应熔断");
		assert.ok(existsSync(join(dir, "conn-history.jsonl")), "历史文件应落盘");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("无历史文件（全新）→ 直接允许", () => {
	const dir = makeDir();
	try {
		const g = new QuotaGovernor({ dir, windowMs: 3_600_000, maxFailures: 12 });
		assert.equal(g.canConnect(0).allowed, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
