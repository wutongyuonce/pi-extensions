/**
 * Regression coverage for #1757: enabling `S` (flake8-bandit) in the bundled
 * ruff config must not weaken the config-first discipline — a project-local
 * ruff config still wins outright over `config/ruff/core.toml`.
 *
 * Runs the real ruff binary (guarded, skips cleanly when ruff isn't on PATH,
 * mirroring the vulture/dead-code-client integration-test pattern) through
 * the SAME `ruffConfigArgs` builder production code calls, so this proves the
 * actual wiring rather than reasoning about it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { ruffConfigArgs } from "../../clients/tool-policy.js";

function ruffAvailable(): boolean {
	for (const cmd of [
		["ruff", ["--version"]],
		["python", ["-m", "ruff", "--version"]],
	] as const) {
		const result = safeSpawn(cmd[0], [...cmd[1]]);
		if (result.status === 0 && !result.error) return true;
	}
	return false;
}

// A hardcoded-password literal — S105 under the bundled config's now-enabled
// `S` selection, and a rule no ordinary `E,F` project config would ever ask
// ruff to check.
const HARDCODED_PASSWORD_SOURCE = 'token = "hardcoded-super-secret-value"\n';

function runRuff(cwd: string, filePath: string) {
	const args = [
		"check",
		"--output-format",
		"json",
		"--no-cache",
		...ruffConfigArgs(cwd),
		filePath,
	];
	const result = safeSpawn("ruff", args, { cwd });
	const stdout = result.stdout ?? "";
	let findings: Array<{ code?: string }> = [];
	try {
		findings = JSON.parse(stdout);
	} catch {
		findings = [];
	}
	return findings.map((f) => f.code).filter(Boolean);
}

describe("ruff S rules vs config-first precedence (#1757, real ruff)", () => {
	it.skipIf(!ruffAvailable())(
		"bundled core.toml (no project config) flags S105 on a hardcoded password",
		() => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-ruff-s-bundled-"),
			);
			try {
				const filePath = path.join(tmpDir, "secret.py");
				fs.writeFileSync(filePath, HARDCODED_PASSWORD_SOURCE);
				const codes = runRuff(tmpDir, filePath);
				expect(codes).toContain("S105");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!ruffAvailable())(
		"a project-local ruff config that doesn't select S overrides the bundled S rules",
		() => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-ruff-s-project-override-"),
			);
			try {
				// Project opts in to its own, narrower rule set (no "S") via
				// pyproject.toml — the same config-first shape every other
				// pi-lens tool policy honors (#1247).
				fs.writeFileSync(
					path.join(tmpDir, "pyproject.toml"),
					'[tool.ruff]\n[tool.ruff.lint]\nselect = ["F"]\n',
				);
				const filePath = path.join(tmpDir, "secret.py");
				fs.writeFileSync(filePath, HARDCODED_PASSWORD_SOURCE);

				// Sanity: ruffConfigArgs really did detect the project config and
				// omit --config, exactly as tests/clients/tool-policy-config-args
				// asserts for the general case.
				expect(ruffConfigArgs(tmpDir)).toEqual([]);

				const codes = runRuff(tmpDir, filePath);
				expect(codes).not.toContain("S105");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	);
});
