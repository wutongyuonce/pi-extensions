import { describe, expect, it } from "vitest";
import { detectFileKind } from "../../clients/file-kinds.js";

describe("detectFileKind — terragrunt", () => {
	it("detects terragrunt.hcl and root.hcl by filename", () => {
		expect(detectFileKind("/repo/infra/terragrunt.hcl")).toBe("terragrunt");
		expect(detectFileKind("/repo/infra/root.hcl")).toBe("terragrunt");
	});

	it("is case-insensitive", () => {
		expect(detectFileKind("/repo/infra/Terragrunt.HCL")).toBe("terragrunt");
		expect(detectFileKind("/repo/infra/ROOT.hcl")).toBe("terragrunt");
	});

	it("leaves a generic .hcl file unmapped", () => {
		expect(detectFileKind("/repo/infra/foo.hcl")).toBeUndefined();
	});

	it("does not match .terraform.lock.hcl", () => {
		expect(detectFileKind("/repo/infra/.terraform.lock.hcl")).toBeUndefined();
	});
});

describe("detectFileKind — Helm templates", () => {
	it("routes .tpl helpers through an explicit file kind", () => {
		expect(detectFileKind("/repo/chart/templates/_helpers.tpl")).toBe(
			"helm-template",
		);
		expect(detectFileKind("C:\\repo\\chart\\templates\\notes.TPL")).toBe(
			"helm-template",
		);
	});
});
