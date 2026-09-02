import { describe, expect, it } from "vitest";
import { combinePathValuesForPlatform } from "../../../clients/lsp/launch.js";

describe("combinePathValuesForPlatform", () => {
	it("merges path-like values case-sensitively on unix platforms", () => {
		const merged = combinePathValuesForPlatform(
			["/usr/bin:/opt/bin", "/USR/BIN:/custom/bin", "/opt/bin:/sbin"],
			"linux",
		);

		expect(merged).toBe("/usr/bin:/opt/bin:/USR/BIN:/custom/bin:/sbin");
	});

	it("deduplicates path-like values case-insensitively on Windows", () => {
		const merged = combinePathValuesForPlatform(
			["C:\\Tools;C:\\Node", "c:\\tools;D:\\Bin", "C:\\NODE"],
			"win32",
		);

		expect(merged).toBe("C:\\Tools;C:\\Node;D:\\Bin");
	});

	it("ignores empty entries", () => {
		const merged = combinePathValuesForPlatform(
			[" ; C:\\Tools ;; ", "", undefined],
			"win32",
		);
		expect(merged).toBe("C:\\Tools");
	});
});
