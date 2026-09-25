import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { hasSqlfluffConfig } from "../../../../clients/dispatch/runners/sqlfluff.js";
import { hasYamllintConfig } from "../../../../clients/dispatch/runners/yamllint.js";
import { setupTestEnvironment } from "../../test-utils.js";

describe("yaml/sql runner config gating", () => {
	it("detects yamllint config via .yamllint file", () => {
		const env = setupTestEnvironment("pi-lens-yamllint-gate-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".yamllint"),
				"extends: default\n",
			);
			expect(hasYamllintConfig(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("detects sqlfluff config via pyproject.toml tool section", () => {
		const env = setupTestEnvironment("pi-lens-sqlfluff-gate-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "pyproject.toml"),
				"[tool.sqlfluff]\ndialect = 'postgres'\n",
			);
			expect(hasSqlfluffConfig(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does not enable yaml/sql runners without config or deps", () => {
		const env = setupTestEnvironment("pi-lens-yaml-sql-gate-");
		try {
			expect(hasYamllintConfig(env.tmpDir)).toBe(false);
			expect(hasSqlfluffConfig(env.tmpDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
