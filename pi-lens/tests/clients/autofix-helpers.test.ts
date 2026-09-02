/**
 * Autofix Helper Tests
 *
 * Tests the file-modification detection and config detection helpers
 * used by the pipeline autofix phase.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectFileChangedAfterCommand } from "../../clients/file-utils.js";
import {
	hasEslintConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
} from "../../clients/pipeline.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("Autofix Helpers", () => {
	describe("Config Detection", () => {
		it("detects eslint config from .eslintrc.json", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			createTempFile(tmpDir, ".eslintrc.json", '{"root": true}');

			expect(hasEslintConfig(tmpDir)).toBe(true);
			cleanup();
		});

		it("detects eslint config from package.json", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			createTempFile(
				tmpDir,
				"package.json",
				JSON.stringify({ eslintConfig: { root: true } }),
			);

			expect(hasEslintConfig(tmpDir)).toBe(true);
			cleanup();
		});

		it("returns false when no eslint config exists", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();

			expect(hasEslintConfig(tmpDir)).toBe(false);
			cleanup();
		});

		it("handles malformed package.json gracefully", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			createTempFile(tmpDir, "package.json", "not valid json");

			expect(hasEslintConfig(tmpDir)).toBe(false);
			cleanup();
		});

		it("detects stylelint config from .stylelintrc", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			createTempFile(tmpDir, ".stylelintrc", "{}");

			expect(hasStylelintConfig(tmpDir)).toBe(true);
			cleanup();
		});

		it("detects stylelint config from package.json", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			createTempFile(tmpDir, "package.json", JSON.stringify({ stylelint: {} }));

			expect(hasStylelintConfig(tmpDir)).toBe(true);
			cleanup();
		});

		it("detects sqlfluff config from .sqlfluff", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			createTempFile(tmpDir, ".sqlfluff", "[sqlfluff]\ndialect = ansi");

			expect(hasSqlfluffConfig(tmpDir)).toBe(true);
			cleanup();
		});

		it("detects sqlfluff config from pyproject.toml", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			createTempFile(
				tmpDir,
				"pyproject.toml",
				"[tool.sqlfluff]\ndialect = ansi",
			);

			expect(hasSqlfluffConfig(tmpDir)).toBe(true);
			cleanup();
		});

		it("returns false when no sqlfluff config exists", () => {
			const { tmpDir, cleanup } = setupTestEnvironment();

			expect(hasSqlfluffConfig(tmpDir)).toBe(false);
			cleanup();
		});
	});

	describe("detectFileChangedAfterCommand", () => {
		it("returns 0 when command does not modify the file", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			const filePath = createTempFile(tmpDir, "test.txt", "original");

			const result = await detectFileChangedAfterCommand(
				filePath,
				process.execPath,
				["-e", "console.log('noop')"],
				tmpDir,
			);

			expect(result).toBe(0);
			cleanup();
		});

		it("returns 0 when file does not exist", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			const filePath = path.join(tmpDir, "nonexistent.txt");

			const result = await detectFileChangedAfterCommand(
				filePath,
				process.execPath,
				["-e", "console.log('noop')"],
				tmpDir,
			);

			expect(result).toBe(0);
			cleanup();
		});

		it("returns 0 when command exits with error", async () => {
			const { tmpDir, cleanup } = setupTestEnvironment();
			const filePath = createTempFile(tmpDir, "test.txt", "original");

			const result = await detectFileChangedAfterCommand(
				filePath,
				process.execPath,
				["-e", "process.exit(1)"],
				tmpDir,
			);

			expect(result).toBe(0);
			cleanup();
		});
	});
});
