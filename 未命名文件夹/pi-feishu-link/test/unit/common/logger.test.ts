import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../../src/common/logger.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "feishu-link-log-"));
}

test("logger writes JSONL lines with level filtering", () => {
	const dir = tempDir();
	try {
		const log = new Logger(dir, { level: "info" });
		log.debug("feishu.debug_only", { a: 1 });
		log.info("feishu.hello", { n: 42 });
		log.warn("feishu.warned");
		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		assert.equal(files.length, 1);
		const lines = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n");
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]!);
		assert.equal(first.event, "feishu.hello");
		assert.equal(first.level, "info");
		assert.equal(first.data.n, 42);
		assert.equal(typeof first.ts, "number");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("debug level enables debug records", () => {
	const dir = tempDir();
	try {
		const log = new Logger(dir, { level: "debug" });
		log.debug("feishu.debug_now", {});
		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		const lines = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ring buffer returns recent events newest-last, bounded", () => {
	const log = new Logger("/nonexistent-dir-that-append-will-fail", {
		ringSize: 5,
	});
	for (let i = 0; i < 10; i++) log.info(`event.${i}`);
	const recent = log.recent();
	assert.equal(recent.length, 5);
	assert.equal(recent[0]?.event, "event.5");
	assert.equal(recent[4]?.event, "event.9");
	assert.equal(log.recent(2).length, 2);
});

test("rotation rolls files and keeps maxFiles", () => {
	const dir = tempDir();
	try {
		const log = new Logger(dir, {
			level: "debug",
			maxFileBytes: 500,
			maxFiles: 3,
		});
		// Write enough to force several rolls.
		for (let i = 0; i < 200; i++) {
			log.info(`feishu.rotate.${i}`, { pad: "x".repeat(80) });
		}
		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		assert.ok(files.length <= 3, `expected <=3 files, got ${files.length}`);
		assert.ok(
			files.length >= 2,
			`expected rolls to happen, got ${files.length}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logging never throws when disk is unwritable", () => {
	const dir = tempDir();
	try {
		// A regular file used as a parent dir fails fast with ENOTDIR.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x", "utf8");
		const log = new Logger(join(blocker, "sub"), { level: "debug" });
		assert.doesNotThrow(() => {
			log.info("feishu.silent");
			log.error("feishu.err", { e: "boom" });
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logger errors do not propagate on bad data", () => {
	const dir = tempDir();
	try {
		const log = new Logger(dir, { level: "debug" });
		const ev = {
			ts: Date.now(),
			level: "info" as const,
			event: "x",
			data: { cyclic: {} as Record<string, unknown> },
		};
		ev.data.cyclic.self = ev.data.cyclic;
		assert.doesNotThrow(() => {
			log.log(ev.level, ev.event, ev.data);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
