import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRIDGE_HOME_ENV,
	DEFAULT_CONFIG,
	deepMerge,
	hashId,
	isConfigured,
	loadConfig,
	loadOverrides,
	mask,
	normalizePath,
	readJson,
	rootDir,
	sanitizeConfig,
	saveConfig,
	saveOverrides,
	validateConfig,
	writeJson,
} from "../../../src/common/config.ts";

function withHome<T>(fn: () => T): T {
	const dir = mkdtempSync(join(tmpdir(), "feishu-link-cfg-"));
	const prev = process.env[BRIDGE_HOME_ENV];
	process.env[BRIDGE_HOME_ENV] = dir;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env[BRIDGE_HOME_ENV];
		else process.env[BRIDGE_HOME_ENV] = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("DEFAULT_CONFIG is schemaVersion 1 and valid", () => {
	assert.equal(DEFAULT_CONFIG.schemaVersion, 1);
	assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
	assert.equal(DEFAULT_CONFIG.groupPolicy, "open");
	assert.equal(DEFAULT_CONFIG.permissions.policy, "relaxed");
	assert.equal(DEFAULT_CONFIG.ownerOpenId, undefined);
});

test("validateConfig catches bad schema/domain/policy/appId", () => {
	assert.deepEqual(validateConfig(null), ["config is not an object"]);
	assert.ok(
		validateConfig({ schemaVersion: 99 }).some((p) =>
			p.includes("schemaVersion"),
		),
	);
	assert.ok(
		validateConfig({ schemaVersion: 1, domain: "wechat" }).some((p) =>
			p.includes("domain"),
		),
	);
	assert.ok(
		validateConfig({ schemaVersion: 1, groupPolicy: "nope" }).some((p) =>
			p.includes("groupPolicy"),
		),
	);
	assert.ok(
		validateConfig({ schemaVersion: 1, appId: "garbage" }).some((p) =>
			p.includes("appId"),
		),
	);
	assert.deepEqual(
		validateConfig({
			schemaVersion: 1,
			appId: "cli_abc123",
			domain: "feishu",
			groupPolicy: "open",
		}),
		[],
	);
});

test("deepMerge merges nested objects, arrays replaced", () => {
	const base = { a: { b: 1, c: 2 }, list: [1, 2] };
	const merged = deepMerge(base, { a: { c: 3 }, list: [9] });
	assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

test("saveConfig + loadConfig roundtrip with defaults merge", () => {
	withHome(() => {
		assert.equal(loadConfig(), undefined);
		saveConfig({
			...DEFAULT_CONFIG,
			appId: "cli_test123",
			appSecret: "secret",
		});
		const cfg = loadConfig();
		assert.ok(cfg);
		assert.equal(cfg.appId, "cli_test123");
		assert.equal(cfg.forward.streaming.throttleMs, 800); // default preserved
		assert.equal(isConfigured(cfg), true);
		assert.equal(isConfigured(undefined), false);
	});
});

test("runtime overrides layer on top and win", () => {
	withHome(() => {
		saveConfig({
			...DEFAULT_CONFIG,
			appId: "cli_a",
			appSecret: "s",
			groupPolicy: "mention",
		});
		saveOverrides({
			groupPolicy: "open",
			forward: { streaming: { enabled: false } },
		});
		const cfg = loadConfig();
		assert.ok(cfg);
		assert.equal(cfg.groupPolicy, "open");
		assert.equal(cfg.forward.streaming.enabled, false);
		assert.equal(cfg.forward.streaming.throttleMs, 800);
		assert.deepEqual(loadOverrides(), {
			groupPolicy: "open",
			forward: { streaming: { enabled: false } },
		});
	});
});

test("mask hides secrets", () => {
	assert.equal(mask(""), "");
	assert.equal(mask("short"), "****");
	const m = mask("cli_abcdefghij");
	assert.equal(m.startsWith("cli_"), true);
	assert.ok(!m.includes("abcdefghij"));
});

test("hashId is stable and short", () => {
	const h = hashId("ou_abc");
	assert.equal(h, hashId("ou_abc"));
	assert.equal(h.length, 12);
	assert.notEqual(hashId("ou_abc"), hashId("ou_abd"));
});

test("sanitizeConfig masks secrets and hashes ids, keeps shape", () => {
	const cfg = {
		...DEFAULT_CONFIG,
		appId: "cli_longsecretappid123456",
		appSecret: "super-secret-value",
		allowUsers: ["ou_1"],
		allowChats: ["oc_1"],
		admins: ["ou_admin"],
	};
	const s = sanitizeConfig(cfg) as unknown as {
		appSecret: string;
		appId: string;
		allowUsers: string[];
		allowChats: string[];
		admins: string[];
	};
	assert.ok(!s.appSecret.includes("super-secret"));
	assert.ok(!s.appId.includes("longsecret"));
	assert.equal(s.appId, mask(cfg.appId));
	assert.equal(s.allowUsers[0], hashId("ou_1"));
	assert.equal(s.allowChats[0], hashId("oc_1"));
	assert.equal(s.admins[0], hashId("ou_admin"));
});

test("writeJson is atomic and readable; mode 0600 on unix", () => {
	withHome(() => {
		const p = join(rootDir(), "sub", "x.json");
		writeJson(p, { a: 1 });
		assert.deepEqual(readJson(p, {}), { a: 1 });
		if (process.platform !== "win32") {
			const mode = statSync(p).mode & 0o777;
			assert.equal(mode, 0o600);
		}
		// overwrite works
		writeJson(p, { a: 2 });
		assert.deepEqual(readJson(p, {}), { a: 2 });
	});
});

test("normalizePath expands ~ and resolves relative", () => {
	const home = process.env.HOME || "/tmp";
	assert.equal(normalizePath("~/proj"), join(home, "proj"));
	assert.equal(normalizePath("/abs/path"), "/abs/path");
});

test("I9: ownerOpenId round-trips through config + overrides", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fb-cfg-owner-"));
	const prev = process.env[BRIDGE_HOME_ENV];
	process.env[BRIDGE_HOME_ENV] = dir;
	try {
		const cfg = { ...structuredClone(DEFAULT_CONFIG), ownerOpenId: "ou_owner" };
		saveConfig(cfg);
		assert.equal(loadConfig()?.ownerOpenId, "ou_owner");
		// Sanitized diagnostics mask nothing for owner (it is a public id shape)…
		const sanitized = sanitizeConfig(loadConfig()!);
		assert.ok(String(sanitized.ownerOpenId).startsWith("ou_") === false);
	} finally {
		if (prev === undefined) delete process.env[BRIDGE_HOME_ENV];
		else process.env[BRIDGE_HOME_ENV] = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});
