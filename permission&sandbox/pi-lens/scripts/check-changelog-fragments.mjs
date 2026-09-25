#!/usr/bin/env node
// Fast-fail changelog-fragment validator (refs #1844).
//
// Reuses parseEntry/validateChangelogEntries from rollup-changelog.mjs --
// the SAME parser tests/scripts/changelog-entries.test.ts exercises and that
// the release rollup relies on. This script adds no parsing rules of its
// own; it exists only to run that check standing alone, with no `npm
// install` and no `npm run build`, so a bad fragment fails in seconds
// instead of after the full Unit-tests lap (#1844 comment: four PRs in one
// day paid a full CI lap each for this).
//
// Usage: node scripts/check-changelog-fragments.mjs

import { validateChangelogEntries } from "./rollup-changelog.mjs";

try {
	const entries = validateChangelogEntries();
	console.log(
		`changelog fragments OK (${entries.length} entr${entries.length === 1 ? "y" : "ies"} in .changelog/)`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
