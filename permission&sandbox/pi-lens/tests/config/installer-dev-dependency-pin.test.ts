import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../clients/installer/index.js";

type PackageJson = {
	devDependencies?: Record<string, string>;
};

const packageJson = JSON.parse(
	readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as PackageJson;

const PIN_EXEMPTIONS = new Map([
	[
		"typescript",
		"The installer pin is the standalone tsc CLI; the repository devDependency is the host compiler range.",
	],
]);

function splitPinnedPackage(packageName: string): [string, string] | undefined {
	const at = packageName.lastIndexOf("@");
	if (at <= 0) return undefined;
	return [packageName.slice(0, at), packageName.slice(at + 1)];
}

describe("installer npm pin governance", () => {
	it("keeps every npm installer pin equal to its devDependency", () => {
		// Regression: #3430 found jscpd@5.0.12 in the user installer while the
		// repository's exact devDependency was 5.3.0. Keep this enumerable
		// population on one version of truth; unpinned npm tools are not in scope.
		const mismatches = TOOLS.flatMap((tool) => {
			if (tool.installStrategy !== "npm" || !tool.packageName) return [];
			const pin = splitPinnedPackage(tool.packageName);
			if (!pin) return [];
			const [packageName, version] = pin;
			const declared = packageJson.devDependencies?.[packageName];
			if (declared !== undefined && PIN_EXEMPTIONS.has(packageName)) return [];
			return declared === undefined || declared === version
				? []
				: [`${tool.id}: installer ${version}, devDependency ${declared}`];
		});

		for (const [packageName, reason] of PIN_EXEMPTIONS) {
			expect(reason, `${packageName} pin exemption reason`).not.toBe("");
		}
		expect(mismatches).toEqual([]);
	});
});
