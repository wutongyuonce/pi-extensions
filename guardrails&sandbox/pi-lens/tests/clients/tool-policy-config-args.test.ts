import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePackagePath } from "../../clients/package-root.js";
import {
	biomeConfigArgs,
	markdownlintConfigArgs,
	ruffConfigArgs,
} from "../../clients/tool-policy.js";

/**
 * Shared config-args seam regression tests (#1247).
 *
 * The lint runners and the autofix surfaces MUST both consume the builders
 * under test — this suite pins the exact args they produce for the two
 * project states (no config → package-owned fallback; config present → user
 * config wins / empty). If a builder drifts, both surfaces drift together and
 * the divergence that caused the whole-file CHANGELOG/AGENTS.md markdownlint
 * reformat (`#946` → `# 946`) is reintroduced.
 */
describe("shared lint/autofix config-args builders (#1247)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-config-args-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("markdownlintConfigArgs", () => {
		it("falls back to the package-owned core.json when the project has no config", () => {
			const args = markdownlintConfigArgs(tmpDir);
			expect(args).toEqual([
				"--config",
				resolvePackagePath(import.meta.url, "config/markdownlint/core.json"),
			]);
		});

		it("passes no --config when the project ships its own markdownlint config", () => {
			fs.writeFileSync(path.join(tmpDir, ".markdownlint.json"), "{}");
			expect(markdownlintConfigArgs(tmpDir)).toEqual([]);
		});

		it("respects a config nested below the start dir (walk-up discovery)", () => {
			const nested = path.join(tmpDir, "a", "b");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, "a", ".markdownlint.yaml"),
				"MD013: false\n",
			);
			expect(markdownlintConfigArgs(nested)).toEqual([]);
		});
	});

	describe("ruffConfigArgs", () => {
		it("falls back to the package-owned core.toml when the project has no config", () => {
			const args = ruffConfigArgs(tmpDir);
			expect(args).toEqual([
				"--config",
				resolvePackagePath(import.meta.url, "config/ruff/core.toml"),
			]);
		});

		it("passes no --config when the project ships a ruff section in pyproject.toml", () => {
			fs.writeFileSync(
				path.join(tmpDir, "pyproject.toml"),
				"[tool.ruff]\nline-length = 100\n",
			);
			expect(ruffConfigArgs(tmpDir)).toEqual([]);
		});
	});

	describe("biomeConfigArgs", () => {
		it("falls back to the package-owned core.jsonc when the project has no config", () => {
			const args = biomeConfigArgs(tmpDir);
			expect(args).toEqual([
				`--config-path=${resolvePackagePath(
					import.meta.url,
					"config/biome/core.jsonc",
				)}`,
			]);
		});

		// #1731 discipline A: `--config-path` pins biome's config resolution to
		// ONE file, so passing it even when the project ships its own
		// `biome.json` blocked biome's own nested-config resolution (a
		// monorepo package under `cwd` with its own `biome.json` could never
		// extend/override the root config). No flag at all lets biome discover
		// it unaided — the same "omit the flag" shape `ruffConfigArgs` and
		// `markdownlintConfigArgs` already use above.
		it("passes no flag at all when the project ships its own biome.json (#1731)", () => {
			const userConfig = path.join(tmpDir, "biome.json");
			fs.writeFileSync(userConfig, "{}");
			expect(biomeConfigArgs(tmpDir)).toEqual([]);
		});
	});
});
