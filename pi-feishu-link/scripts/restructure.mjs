// One-shot restructure: move flat .pi/extensions/feishu/*.ts into a layered
// src/ layout (L0-L4 per spec §4), mirror tests into test/unit/<layer>/ and
// test/integration/, and rewrite every relative import to the new paths.
import {
	readdirSync,
	readFileSync,
	mkdirSync,
	renameSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { dirname, join, relative, posix } from "node:path";

const root = process.cwd();
const OLD_SRC = join(root, ".pi", "extensions", "feishu");
const NEW_SRC = join(root, "src");

// source file → new subdir under src/
const SRC_MAP = {
	"types.ts": "common",
	"config.ts": "common",
	"logger.ts": "common",
	"status.ts": "common",
	"dedupe-store.ts": "common",
	"diagnostics.ts": "common",
	"transport.ts": "inbound",
	"connection-supervisor.ts": "inbound",
	"group-trigger.ts": "inbound",
	"outbox.ts": "outbound",
	"live-channel.ts": "outbound",
	"outbound-router.ts": "outbound",
	"event-forwarder.ts": "outbound",
	"conversation-manager.ts": "sessions",
	"pi-session-backend.ts": "sessions",
	"turn-supervisor.ts": "sessions",
	"permission-bridge.ts": "sessions",
	"notification-throttler.ts": "sessions",
	"bridge-runtime.ts": "sessions",
	"cards.ts": "presentation",
	"rich-text.ts": "presentation",
	"gateway-lock.ts": "host",
	"auth-setup.ts": "host",
	"command-controller.ts": "commands",
};

const TEST_OLD = join(root, "test");
const TEST_UNIT = join(root, "test", "unit");
const TEST_INT = join(root, "test", "integration");

// test file → target dir
const TEST_MAP = {
	"config.test.ts": "common",
	"logger.test.ts": "common",
	"dedupe-store.test.ts": "common",
	"diagnostics.test.ts": "common",
	"transport.test.ts": "inbound",
	"connection-supervisor.test.ts": "inbound",
	"group-trigger.test.ts": "inbound",
	"outbox.test.ts": "outbound",
	"live-channel.test.ts": "outbound",
	"outbound-router.test.ts": "outbound",
	"event-forwarder.test.ts": "outbound",
	"conversation-manager.test.ts": "sessions",
	"turn-supervisor.test.ts": "sessions",
	"permission-bridge.test.ts": "sessions",
	"notification-throttler.test.ts": "sessions",
	"bridge-runtime.test.ts": "sessions",
	"rich-text.test.ts": "presentation",
	"command-controller.test.ts": "commands",
	"gateway-lock.test.ts": "host",
};

// old absolute path (without extension) → new absolute path (without extension)
const moves = new Map();
for (const [file, subdir] of Object.entries(SRC_MAP)) {
	moves.set(
		join(OLD_SRC, file.replace(/\.ts$/, "")),
		join(NEW_SRC, subdir, file.replace(/\.ts$/, "")),
	);
}
for (const [file, subdir] of Object.entries(TEST_MAP)) {
	moves.set(
		join(TEST_OLD, file.replace(/\.ts$/, "")),
		join(TEST_UNIT, subdir, file.replace(/\.ts$/, "")),
	);
}
moves.set(join(TEST_OLD, "integration"), join(TEST_INT, "integration"));

function relImport(fromDir, toBase) {
	let r = relative(fromDir, toBase);
	if (!r.startsWith(".")) r = `./${r}`;
	return posix.normalize(r.split("\\").join("/"));
}

function rewriteFile(absPath) {
	const text = readFileSync(absPath, "utf8");
	const newDir = dirname(absPath);
	let changed = false;
	const out = text.replace(/from\s+["'](\.[^"']+)["']/g, (m, spec) => {
		// resolve spec relative to current file dir
		const target = join(newDir, spec);
		const withoutExt = target.replace(/\.(js|ts)$/, "");
		const mapped = moves.get(withoutExt);
		if (!mapped) return m;
		const keepExt = spec.endsWith(".js")
			? ".js"
			: spec.endsWith(".ts")
				? ".ts"
				: "";
		const newSpec = relImport(newDir, mapped) + keepExt;
		changed = true;
		return m.replace(spec, newSpec);
	});
	if (changed) writeFileSync(absPath, out);
}

// Move files first.
for (const [from, to] of moves) {
	const fromTs = `${from}.ts`;
	const toTs = `${to}.ts`;
	if (existsSync(fromTs)) {
		mkdirSync(dirname(toTs), { recursive: true });
		renameSync(fromTs, toTs);
		console.log(`moved ${fromTs} → ${toTs}`);
	}
}

// Rewrite all source + test files in place.
const allFiles = [];
function walk(dir) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (f.endsWith(".ts")) allFiles.push(p);
		else if (!f.includes(".")) walk(p);
	}
}
for (const d of [NEW_SRC, TEST_UNIT, TEST_INT, TEST_OLD]) {
	if (existsSync(d)) walk(d);
}
for (const f of allFiles) rewriteFile(f);
console.log(`rewrote imports in ${allFiles.length} files`);
