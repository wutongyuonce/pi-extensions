import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DependencyChecker } from "../../clients/dependency-checker.js";
import { removeTempDirSync } from "./test-utils.js";

// #1105: `importsChanged`'s fast path returned false when the on-disk mtime had
// not advanced past the cached timestamp. A content change that PRESERVES mtime
// (git checkout timestamp restoration, a formatter preserving mtime, a
// same-clock write) then skipped the madge circular-dep re-check against edited
// imports. The fix adds byte size (free from the same stat) as a second axis.
//
// mtime is pinned to the SAME fixed Date before and after the edit so the mtime
// axis is byte-for-byte unchanged and it is SIZE alone that must trigger
// re-extraction (the test cannot pass vacuously via an mtime delta).
const PINNED_MTIME = new Date(Date.now() - 60_000);

describe("DependencyChecker.importsChanged freshness (#1105)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-dep-freshness-"));
	});
	afterEach(() => {
		removeTempDirSync(tmp);
	});

	it("detects an import edit that preserved mtime but changed size", () => {
		const dc = new DependencyChecker();
		const f = path.join(tmp, "f.ts");

		fs.writeFileSync(f, 'import { a } from "./mod-a";\n');
		fs.utimesSync(f, PINNED_MTIME, PINNED_MTIME);
		const recorded = fs.statSync(f);

		// First sight seeds the cache (mtime + size); a repeat with no edit is the
		// intended fast-path "unchanged".
		expect(dc.importsChanged(f)).toBe(true);
		expect(dc.importsChanged(f)).toBe(false);

		// Add an import (changes both the import SET and the byte length), then
		// re-pin the identical mtime so only size moved.
		fs.writeFileSync(
			f,
			'import { a } from "./mod-a";\nimport { b } from "./mod-b";\n',
		);
		fs.utimesSync(f, PINNED_MTIME, PINNED_MTIME);
		const st = fs.statSync(f);
		expect(st.mtimeMs).toBe(recorded.mtimeMs);
		expect(st.size).not.toBe(recorded.size);

		// Post-fix: size delta forces re-extraction and the changed import set is
		// seen. Pre-fix (mtime-only fast path) this returned false — the new
		// dependency edge was silently missed.
		expect(dc.importsChanged(f)).toBe(true);
	});
});
