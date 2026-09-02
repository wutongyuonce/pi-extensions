// M8 acceptance: the extension loads inside a real pi CLI process without
// errors, and the unconfigured banner appears. Adapted from the reference
// implementation's extension-load test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const codingAgentEntry = fileURLToPath(
	import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const piCli = join(dirname(codingAgentEntry), "cli.js");
const extensionPath = join(repoRoot, "src/index.ts");
const settlePath = join(repoRoot, "test/fixtures/settle-extension.ts");

function runPi(extraArgs: string[] = []) {
	const homeDir = mkdtempSync(join(tmpdir(), "pi-feishu-link-load-"));
	const env = {
		...process.env,
		HOME: homeDir,
		PI_FEISHU_LINK_HOME: join(homeDir, ".pi", "agent", "feishu-link"),
	};
	try {
		return spawnSync(
			process.execPath,
			[
				piCli,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-tools",
				"--no-session",
				"-e",
				extensionPath,
				"-e",
				settlePath,
				...extraArgs,
			],
			{ encoding: "utf8", env, timeout: 60_000 },
		);
	} finally {
		rmSync(homeDir, { recursive: true, force: true });
	}
}

test("extension loads in a real pi CLI without errors", () => {
	const result = runPi();
	assert.equal(
		result.status,
		0,
		`pi exit ${result.status}: ${result.stderr?.slice(0, 1000)}`,
	);
	assert.equal(result.error, undefined);
	assert.ok(
		!result.stderr?.includes("TypeError"),
		`unexpected TypeError: ${result.stderr?.slice(0, 500)}`,
	);
});

test("unconfigured banner is printed on startup", () => {
	const result = runPi();
	const all = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	assert.ok(
		all.includes("/feishu setup"),
		`banner missing: ${all.slice(0, 500)}`,
	);
});

test("child-session guard prevents recursion when env flag is set", () => {
	const homeDir = mkdtempSync(join(tmpdir(), "pi-feishu-link-guard-"));
	const env = {
		...process.env,
		HOME: homeDir,
		PI_FEISHU_LINK_CHILD: "1",
	};
	try {
		const result = spawnSync(
			process.execPath,
			[
				piCli,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-tools",
				"--no-session",
				"-e",
				extensionPath,
				"-e",
				settlePath,
			],
			{ encoding: "utf8", env, timeout: 60_000 },
		);
		assert.equal(
			result.status,
			0,
			`pi exit ${result.status}: ${result.stderr?.slice(0, 1000)}`,
		);
		// No banner (extension early-returned in child mode).
		assert.ok(
			!`${result.stdout ?? ""}${result.stderr ?? ""}`.includes("/feishu setup"),
		);
	} finally {
		rmSync(homeDir, { recursive: true, force: true });
	}
});
