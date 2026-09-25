import * as fs from "node:fs";
import { acquireBoundedPidFileLock } from "../../clients/bounded-pid-file-lock.js";

const [lockPath, statePath] = process.argv.slice(2);
const release = acquireBoundedPidFileLock(lockPath, {
	waitMs: 2_000,
	retryMs: 10,
	timeoutMessage: "holder lock timed out",
});
fs.writeFileSync(statePath, JSON.stringify({ writer: "first" }), "utf8");
process.stdout.write("locked\n");
setTimeout(() => {
	release();
}, 2_500);
