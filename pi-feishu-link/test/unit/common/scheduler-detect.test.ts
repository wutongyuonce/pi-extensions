import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSchedulerInstalled } from "../../../src/common/scheduler-detect.js";

/** 构造一个假的 ~/.pi/agent 目录，可控注入 packages / node_modules。 */
function makePiRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-detect-"));
	// 默认空 settings.json（无 packages）
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [] }));
	return dir;
}

function withPackages(root: string, pkgs: unknown[]) {
	writeFileSync(
		join(root, "settings.json"),
		JSON.stringify({ packages: pkgs }),
	);
}

function withNodeModules(root: string) {
	const pkgDir = join(
		root,
		"npm",
		"node_modules",
		"@ineersa",
		"my-pi-scheduler",
	);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(
		join(pkgDir, "package.json"),
		JSON.stringify({ name: "@ineersa/my-pi-scheduler" }),
	);
}

test("detectSchedulerInstalled: settings.json string 形式 → true", () => {
	const root = makePiRoot();
	withPackages(root, ["npm:context-mode", "npm:@ineersa/my-pi-scheduler"]);
	try {
		assert.equal(detectSchedulerInstalled(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("detectSchedulerInstalled: settings.json object 形式（source 字段）→ true", () => {
	const root = makePiRoot();
	withPackages(root, [{ source: "npm:@ineersa/my-pi-scheduler" }]);
	try {
		assert.equal(detectSchedulerInstalled(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("detectSchedulerInstalled: node_modules 存在 → true（settings 无记录）", () => {
	const root = makePiRoot();
	withNodeModules(root);
	try {
		assert.equal(detectSchedulerInstalled(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("detectSchedulerInstalled: 都没装 → false", () => {
	const root = makePiRoot();
	try {
		assert.equal(detectSchedulerInstalled(root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("detectSchedulerInstalled: settings.json 损坏 → 不抛错，回退 node_modules 检测", () => {
	const root = makePiRoot();
	writeFileSync(join(root, "settings.json"), "{not-json");
	try {
		assert.equal(detectSchedulerInstalled(root), false);
		withNodeModules(root);
		assert.equal(detectSchedulerInstalled(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("detectSchedulerInstalled: settings.json 缺失 → 不抛错", () => {
	const root = makePiRoot();
	rmSync(join(root, "settings.json"));
	try {
		assert.equal(detectSchedulerInstalled(root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
