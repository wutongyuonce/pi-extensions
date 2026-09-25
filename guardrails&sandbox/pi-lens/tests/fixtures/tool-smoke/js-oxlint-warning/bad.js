// Tool-smoke fixture (#1947) — no .oxlintrc.json override, so oxlint's default
// severity for no-unused-vars (warning) applies and the process exits 0.
export function demo() {
	const unused = 1;
	return 2;
}
