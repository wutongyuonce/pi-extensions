export { default as assert } from "node:assert/strict";
export { execFileSync } from "node:child_process";
export {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
export { homedir, tmpdir } from "node:os";
export { join } from "node:path";
export { after, afterEach, before, beforeEach, describe, it } from "node:test";
