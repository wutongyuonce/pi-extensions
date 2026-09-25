// Tool-smoke fixture (#1937) — oxlint flags both violations at error severity,
// so the capture carries a nonzero exit and a parseable report.
export function demo() {
	const unused = 1;
	debugger;
	return 2;
}
