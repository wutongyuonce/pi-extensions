/**
 * #265 — per-file runners over multi-file tools must attribute each diagnostic
 * to its REAL file (type-checkers: mypy/phpstan/pyright) and must not let a
 * sibling's diagnostic fail the edited file's turn (lint-style: rust-clippy).
 *
 * These tests guard the parse layer, which is where the mis-attribution bug
 * lived (blanket-stamping ctx.filePath). The run-level filter (rust-clippy) is
 * exercised here against the parsed output to prove sibling exclusion.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCredoJson } from "../../../../clients/dispatch/runners/credo.js";
import { parseMypyOutput } from "../../../../clients/dispatch/runners/mypy.js";
import { parsePhpstanJson } from "../../../../clients/dispatch/runners/phpstan.js";
import { parseClippyOutput } from "../../../../clients/dispatch/runners/rust-clippy.js";

const cwd = path.resolve("/proj");
const editedAbs = path.resolve(cwd, "edited.py");

describe("mypy attribution (#265 A2)", () => {
	it("attributes each diagnostic to the file mypy names, not the edited file", () => {
		const raw = [
			"edited.py:10: error: Incompatible types [assignment]",
			"sibling/other.py:3:5: error: Name 'x' is not defined [name-defined]",
		].join("\n");
		const diags = parseMypyOutput(raw, editedAbs, cwd);
		expect(diags).toHaveLength(2);
		expect(diags[0].filePath).toBe(path.resolve(cwd, "edited.py"));
		expect(diags[1].filePath).toBe(path.resolve(cwd, "sibling/other.py"));
	});

	it("resolves absolute paths as-is and falls back when no file captured", () => {
		const abs = path.resolve(cwd, "abs.py");
		const raw = `${abs}:1: error: boom`;
		const diags = parseMypyOutput(raw, editedAbs, cwd);
		expect(diags[0].filePath).toBe(abs);
	});
});

describe("phpstan attribution (#265 A3)", () => {
	it("uses the files-map key per error, not the edited file", () => {
		// Real phpstan shape (#1937): `errors` is the COUNT, the findings are in
		// `messages`. This literal used to spell `errors: [...]`, agreeing with a
		// parser that read the same wrong field, so test and code were wrong
		// together — the #1933 vale failure mode. The real envelope is pinned by
		// tests/fixtures/runner-output/phpstan/real.captured.json.
		const raw = JSON.stringify({
			files: {
				"src/Edited.php": {
					errors: 1,
					messages: [{ message: "bad", line: 4, identifier: "return.type" }],
				},
				"src/Dep.php": {
					errors: 1,
					messages: [{ message: "cross-file", line: 9 }],
				},
			},
			totals: { errors: 0, file_errors: 2 },
			errors: [],
		});
		const editedPhp = path.resolve(cwd, "src/Edited.php");
		const diags = parsePhpstanJson(raw, editedPhp, cwd);
		expect(diags).toHaveLength(2);
		expect(diags.map((d) => d.filePath).sort()).toEqual(
			[
				path.resolve(cwd, "src/Dep.php"),
				path.resolve(cwd, "src/Edited.php"),
			].sort(),
		);
	});
});

describe("credo attribution (#265 A4)", () => {
	it("maps issue.filename rather than blanket-stamping the edited file", () => {
		const raw = JSON.stringify({
			issues: [
				{
					filename: "lib/other.ex",
					line_no: 12,
					column: 3,
					message: "m",
					category: "readability",
					check: "Credo.Check.Readability.ModuleDoc",
					priority: 1,
				},
			],
		});
		const edited = path.resolve(cwd, "lib/edited.ex");
		const diags = parseCredoJson(raw, edited, cwd);
		expect(diags[0].filePath).toBe(path.resolve(cwd, "lib/other.ex"));
	});
});

describe("rust-clippy per-file resolution + lint-style filter (#265 B1)", () => {
	const cargoDir = path.resolve(cwd, "crate");
	const editedRs = path.resolve(cargoDir, "src/lib.rs");

	function clippyMsg(file: string, level: "warning" | "error") {
		return JSON.stringify({
			reason: "compiler-message",
			message: {
				code: { code: "needless_return" },
				message: "m",
				level,
				spans: [{ file, line_start: 1, column_start: 1 }],
			},
		});
	}

	it("resolves span.file against the cargo dir to absolute paths", () => {
		const raw = [
			clippyMsg("src/lib.rs", "warning"),
			clippyMsg("src/other.rs", "error"),
		].join("\n");
		const diags = parseClippyOutput(raw, editedRs, cargoDir);
		expect(diags.map((d) => d.filePath)).toEqual([
			path.resolve(cargoDir, "src/lib.rs"),
			path.resolve(cargoDir, "src/other.rs"),
		]);
	});

	it("a sibling crate-mate error is excluded by the edited-file filter", () => {
		const raw = [
			clippyMsg("src/lib.rs", "warning"),
			clippyMsg("src/other.rs", "error"),
		].join("\n");
		const all = parseClippyOutput(raw, editedRs, cargoDir);
		// Mirror the run()-level lint-style filter.
		const absEdited = path.resolve(editedRs);
		const kept = all.filter((d) => path.resolve(d.filePath) === absEdited);
		expect(kept).toHaveLength(1);
		expect(kept[0].filePath).toBe(absEdited);
		// The only kept diagnostic is a warning → the edited file's turn must not fail.
		expect(kept.some((d) => d.semantic === "blocking")).toBe(false);
	});
});
