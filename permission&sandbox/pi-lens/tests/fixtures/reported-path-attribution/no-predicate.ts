// A comment naming pathsEqual must not launder this parser into the census.
// The literal "pathsEqual" in a string must not either.
const note = "pathsEqual";

export function parse(raw: string, filePath: string) {
	void note;
	return raw.split("\n").map((line) => {
		const match = line.match(/^(.*?):(\d+):(\d+)/);
		return {
			id: match?.[1] ?? "x",
			message: line,
			filePath,
			line: Number(match?.[2] ?? 1),
			tool: "fixture",
		};
	});
}
