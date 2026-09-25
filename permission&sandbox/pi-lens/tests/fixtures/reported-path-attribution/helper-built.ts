import { parseRuffOutput } from "../../../clients/dispatch/runners/utils/diagnostic-parsers.js";

/**
 * The HELPER-CONSTRUCTION escape M3304-F9 named. This parser reads the tool's
 * own output and hands the DISPATCHED path to a diagnostic-producing helper, so
 * there is no `tool:` object literal anywhere in the file and no object literal
 * of its own to inspect. Round 3's census, which recognised construction only
 * by an in-file `tool:` literal, counted this file as 0.
 */
export function parse(raw: string, filePath: string, cwd: string) {
	const lines = raw.split("\n").filter((line) => line.trim());
	return parseRuffOutput(lines.join("\n"), filePath, cwd);
}
