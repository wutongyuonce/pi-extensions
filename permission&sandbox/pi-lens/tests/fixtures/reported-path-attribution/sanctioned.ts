import * as path from "node:path";
import { pathsEqual } from "../../../clients/path-utils.js";

export function parse(raw: string, filePath: string, cwd: string) {
	const absTarget = path.resolve(cwd, filePath);
	return raw.split("\n").flatMap((line) => {
		const match = line.match(/^(.*?):(\d+):(\d+)/);
		if (!match) return [];
		if (!pathsEqual(path.resolve(cwd, match[1]!), absTarget)) return [];
		return [
			{
				id: match[1]!,
				message: line,
				filePath,
				line: Number(match[2]),
				tool: "fixture",
			},
		];
	});
}
