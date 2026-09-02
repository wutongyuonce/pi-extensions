/**
 * Unit tests for the capture primitive behind the real-bytes fixtures (#1937).
 *
 * The script writes the provenance header every runner-output fixture is
 * trusted on, so its own helpers need to be right: a version it cannot read
 * must stop the capture, a workspace path must not leak into the repo, and an
 * argument must survive cmd.exe intact.
 */

import { describe, expect, it } from "vitest";
import {
	extractVersion,
	needsShell,
	quoteForShell,
	redactWorkspace,
	WORKSPACE_TOKEN,
} from "../../scripts/capture-runner-output.mjs";

describe("extractVersion", () => {
	it("takes the first major.minor token out of a banner", () => {
		expect(extractVersion("actionlint 1.7.12\ninstalled by download")).toBe(
			"1.7.12",
		);
		expect(extractVersion("vale version 3.9.6")).toBe("3.9.6");
		expect(extractVersion("mypy 2.3.1 (compiled: yes)")).toBe("2.3.1");
	});

	// The capture refuses to write a fixture when this returns "". Falling back
	// to "the first line" once recorded a Windows "not compatible with the
	// version of Windows you're running" error AS the tool version.
	it("returns empty for a banner with no version token", () => {
		expect(extractVersion("")).toBe("");
		expect(extractVersion("this program cannot be run")).toBe("");
		expect(
			extractVersion(
				"This version of ktlint.exe is not compatible with the version of Windows you're running.",
			),
		).toBe("");
	});
});

describe("redactWorkspace", () => {
	it("replaces the native, posix, and backslash spellings", () => {
		const workspace = "C:\\Temp\\ws";
		expect(redactWorkspace("at C:\\Temp\\ws\\bad.toml", workspace)).toBe(
			`at ${WORKSPACE_TOKEN}\\bad.toml`,
		);
		expect(redactWorkspace("at C:/Temp/ws/bad.toml", workspace)).toBe(
			`at ${WORKSPACE_TOKEN}/bad.toml`,
		);
	});

	// The JSON-escaped spelling is the one that matters: `--format json` output
	// embeds `C:\\Temp\\ws`, which the raw spelling never matches. Missing it
	// left a local absolute path inside committed fixtures, and the replay then
	// spliced back an invalid JSON escape.
	it("replaces the JSON-escaped spelling", () => {
		const redacted = redactWorkspace(
			'{"file":"C:\\\\Temp\\\\ws\\\\bad.php"}',
			"C:\\Temp\\ws",
		);
		expect(redacted).toBe(`{"file":"${WORKSPACE_TOKEN}\\\\bad.php"}`);
		expect(redacted).not.toContain("Temp");
	});

	it("is a no-op without a workspace", () => {
		expect(redactWorkspace("text", "")).toBe("text");
	});
});

describe("needsShell", () => {
	it("shells npm shims on Windows but never a real exe", () => {
		expect(needsShell("C:\\tools\\oxlint", "win32")).toBe(true);
		expect(needsShell("C:\\tools\\actionlint.exe", "win32")).toBe(false);
		expect(needsShell("C:\\tools\\ACTIONLINT.EXE", "win32")).toBe(false);
	});

	it("never shells off Windows", () => {
		expect(needsShell("oxlint", "linux")).toBe(false);
		expect(needsShell("oxlint", "darwin")).toBe(false);
	});
});

describe("quoteForShell", () => {
	it("leaves a plain argument alone", () => {
		expect(quoteForShell("--format")).toBe("--format");
		expect(quoteForShell("bad.toml")).toBe("bad.toml");
	});

	it("quotes whitespace and cmd metacharacters", () => {
		expect(quoteForShell("{{json .}}")).toBe('"{{json .}}"');
		expect(quoteForShell("a&b")).toBe('"a&b"');
		expect(quoteForShell("100%")).toBe('"100%"');
	});

	// #1937 round 2: the old version escaped `"` and ignored `\`. Per
	// CommandLineToArgvW a backslash run that abuts the closing quote must be
	// doubled, or the quote is escaped away and the next argument is swallowed.
	it("doubles a trailing backslash run so the closing quote survives", () => {
		expect(quoteForShell("C:\\path with space\\")).toBe(
			'"C:\\path with space\\\\"',
		);
		expect(quoteForShell("C:\\a b\\\\")).toBe('"C:\\a b\\\\\\\\"');
	});

	it("leaves an interior backslash literal", () => {
		expect(quoteForShell("C:\\a b\\c")).toBe('"C:\\a b\\c"');
	});

	it("escapes an embedded quote and the run before it", () => {
		expect(quoteForShell('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteForShell('a\\"b c')).toBe('"a\\\\\\"b c"');
	});

	it("quotes the empty string so it stays one argument", () => {
		expect(quoteForShell("")).toBe('""');
	});

	/**
	 * Round-trip against the real parser rules. Any argument this produces must
	 * decode back to itself, which is the property the character-by-character
	 * assertions above only sample.
	 */
	function parseWindowsCommandLine(commandLine: string): string[] {
		const args: string[] = [];
		let current = "";
		let inQuotes = false;
		let started = false;
		let backslashes = 0;
		const flushBackslashes = (count: number) => {
			current += "\\".repeat(count);
		};
		for (const character of commandLine) {
			if (character === "\\") {
				backslashes++;
				continue;
			}
			if (character === '"') {
				flushBackslashes(Math.floor(backslashes / 2));
				if (backslashes % 2 === 1) {
					current += '"';
				} else {
					inQuotes = !inQuotes;
					started = true;
				}
				backslashes = 0;
				continue;
			}
			flushBackslashes(backslashes);
			backslashes = 0;
			if (character === " " && !inQuotes) {
				if (started || current.length > 0) args.push(current);
				current = "";
				started = false;
				continue;
			}
			current += character;
		}
		flushBackslashes(backslashes);
		if (started || current.length > 0) args.push(current);
		return args;
	}

	it("round-trips every argument shape through the real parser rules", () => {
		const cases = [
			["--format", "{{json .}}", "bad.yml"],
			["C:\\path with space\\", "next"],
			['say "hi"', "plain"],
			['a\\"b c', "C:\\a b\\c"],
			["", "after-empty"],
			["--filter=bad.tf", "C:\\Users\\dev\\repo\\"],
		];
		for (const argv of cases) {
			const commandLine = argv.map(quoteForShell).join(" ");
			expect(parseWindowsCommandLine(commandLine), commandLine).toEqual(argv);
		}
	});
});
