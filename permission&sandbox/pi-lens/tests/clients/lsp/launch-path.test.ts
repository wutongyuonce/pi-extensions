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

/**
 * #1193 P3: `normalizePathEntry` derived its dedupe key with the HOST-DEFAULT
 * `path.normalize` inside a branch already committed to `platform` — AGENTS.md
 * defect shape 2 ("once a path is classified as Windows-shaped, use
 * `path.win32`"). On a POSIX host the win32 arm therefore lowercased without
 * ever folding separators or dot segments, so two spellings of ONE Windows
 * directory produced two keys and both survived the dedupe. Green on a Windows
 * dev box, wrong on the authoritative ubuntu lane — the #1024 divergence class.
 *
 * These cases run the platform arms through the real production entry point on
 * every lane (defect shape 35), rather than pinning a Windows-only property.
 */
describe("combinePathValuesForPlatform path-key folding (#1193)", () => {
	it("deduplicates one Windows directory spelled with either separator", () => {
		const merged = combinePathValuesForPlatform(
			["C:\\Tools", "C:/Tools"],
			"win32",
		);

		expect(merged).toBe("C:\\Tools");
	});

	it("deduplicates a Windows entry that differs only by a dot segment", () => {
		const merged = combinePathValuesForPlatform(
			["C:\\Tools", "C:\\x\\..\\Tools"],
			"win32",
		);

		expect(merged).toBe("C:\\Tools");
	});

	it("keeps a POSIX entry containing a backslash distinct from a slash one", () => {
		// A backslash is a legal POSIX filename character, so the win32 arm's
		// separator fold must not leak into the POSIX arm.
		const merged = combinePathValuesForPlatform(
			["/opt/a\\b", "/opt/a/b"],
			"linux",
		);

		expect(merged).toBe("/opt/a\\b:/opt/a/b");
	});

	it("keeps two POSIX entries that differ only in case distinct", () => {
		const merged = combinePathValuesForPlatform(
			["/usr/bin", "/USR/BIN"],
			"linux",
		);

		expect(merged).toBe("/usr/bin:/USR/BIN");
	});

	it("passes a non-path sentinel entry through unchanged", () => {
		// `%USERPROFILE%\bin` is an unexpanded env reference, not a resolvable
		// path: the key derivation must not resolve it against a cwd or drop it.
		const merged = combinePathValuesForPlatform(
			["%USERPROFILE%\\bin;C:\\Tools", "%USERPROFILE%/bin"],
			"win32",
		);

		expect(merged).toBe("%USERPROFILE%\\bin;C:\\Tools");
	});
});
