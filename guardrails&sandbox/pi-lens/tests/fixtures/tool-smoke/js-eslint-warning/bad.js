// Tool-smoke fixture (#1954) — eslint.config.cjs downgrades no-unused-vars
// to "warn", so a real run reports one severity-1 finding and exits 0
// (--max-warnings is not set).
export function demo() {
	const unused = 1;
	return 2;
}
