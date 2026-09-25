import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectFileKind,
	TERRAGRUNT_FILENAMES,
} from "../../clients/file-kinds.js";
import { resolveLanguageRootForFile } from "../../clients/language-profile.js";
import {
	getFormatterPolicyForFile,
	getLinterPolicyForFile,
} from "../../clients/tool-policy.js";
import { setupTestEnvironment } from "./test-utils.js";

// Single-source-of-truth coverage for the terragrunt entrypoint filenames
// (same shape as tests/clients/dotnet-root-markers.test.ts): every case is
// DERIVED from TERRAGRUNT_FILENAMES, so a consumer that hand-copies the list
// and misses a name fails here rather than silently dropping that file's
// linting or formatting.
describe("terragrunt filenames single source of truth", () => {
	it("every name is detected as the terragrunt kind, case-insensitively", () => {
		for (const name of TERRAGRUNT_FILENAMES) {
			expect(detectFileKind(`/repo/infra/${name}`), name).toBe("terragrunt");
			expect(detectFileKind(`/repo/infra/${name.toUpperCase()}`), name).toBe(
				"terragrunt",
			);
		}
	});

	it("every name selects the terragrunt runner", () => {
		for (const name of TERRAGRUNT_FILENAMES) {
			expect(
				getLinterPolicyForFile(`/repo/infra/${name}`, {}),
				name,
			).toMatchObject({
				preferredRunners: ["terragrunt"],
				defaultRunner: "terragrunt",
			});
		}
	});

	it("every name selects the terragrunt-hcl formatter policy", () => {
		for (const name of TERRAGRUNT_FILENAMES) {
			expect(
				getFormatterPolicyForFile(`/repo/infra/${name}`),
				name,
			).toMatchObject({
				defaultFormatter: "terragrunt-hcl",
			});
		}
	});

	it("every name acts as a language root marker", () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-sst-");
		try {
			for (const name of TERRAGRUNT_FILENAMES) {
				const unit = path.join(env.tmpDir, `unit-${name}`);
				fs.mkdirSync(unit, { recursive: true });
				const filePath = path.join(unit, name);
				fs.writeFileSync(filePath, "locals {}\n");

				expect(resolveLanguageRootForFile(filePath, env.tmpDir), name).toBe(
					unit,
				);
			}
		} finally {
			env.cleanup();
		}
	});
});
