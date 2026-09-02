// Structured event logger: JSONL on disk with rotation (5MB x 3) plus an
// in-memory ring buffer for diagnostics. No pi SDK dependency.

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { logsPath } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface LogEvent {
	ts: number;
	level: LogLevel;
	event: string;
	data?: Record<string, unknown>;
}

export interface LoggerOptions {
	level: LogLevel;
	maxFileBytes?: number;
	maxFiles?: number;
	ringSize?: number;
}

export class Logger {
	private level: LogLevel;
	private readonly maxFileBytes: number;
	private readonly maxFiles: number;
	private readonly ring: LogEvent[] = [];
	private readonly ringSize: number;
	private currentFile: string | undefined;
	private readonly dir: string;

	constructor(dir: string, options: Partial<LoggerOptions> = {}) {
		this.dir = dir;
		this.level = options.level ?? "info";
		this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
		this.maxFiles = options.maxFiles ?? 3;
		this.ringSize = options.ringSize ?? 500;
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	enabled(level: LogLevel): boolean {
		return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
	}

	log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
		if (!this.enabled(level)) return;
		const entry: LogEvent = { ts: Date.now(), level, event, data };
		this.ring.push(entry);
		if (this.ring.length > this.ringSize) this.ring.shift();
		this.append(entry);
	}

	debug(event: string, data?: Record<string, unknown>): void {
		this.log("debug", event, data);
	}
	info(event: string, data?: Record<string, unknown>): void {
		this.log("info", event, data);
	}
	warn(event: string, data?: Record<string, unknown>): void {
		this.log("warn", event, data);
	}
	error(event: string, data?: Record<string, unknown>): void {
		this.log("error", event, data);
	}

	/** Recent events from the ring (newest last). */
	recent(n?: number): LogEvent[] {
		return this.ring.slice(-(n ?? this.ringSize));
	}

	private append(entry: LogEvent): void {
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			this.rotateIfNeeded();
			if (!this.currentFile) this.currentFile = this.todayFile();
			appendFileSync(this.currentFile, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// Never let logging break the bridge.
		}
	}

	private todayFile(): string {
		const d = new Date();
		const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
		return join(this.dir, `events-${ymd}.jsonl`);
	}

	private rotateIfNeeded(): void {
		const file = this.currentFile ?? this.todayFile();
		let size = 0;
		try {
			size = statSync(file).size;
		} catch {
			size = 0;
		}
		if (size < this.maxFileBytes) {
			this.currentFile = file;
			return;
		}
		// Roll: rename current to -1, shift older names, drop beyond maxFiles.
		const base = file.replace(/\.jsonl$/, "");
		for (let i = this.maxFiles - 2; i >= 1; i--) {
			const from = `${base}.${i}.jsonl`;
			const to = `${base}.${i + 1}.jsonl`;
			try {
				renameSync(from, to);
			} catch {
				/* noop */
			}
		}
		try {
			renameSync(file, `${base}.1.jsonl`);
		} catch {
			/* noop */
		}
		// Remove beyond maxFiles (index maxFiles and up).
		try {
			for (const name of readdirSync(this.dir)) {
				const match = /^events-(\d{8})\.(\d+)\.jsonl$/.exec(name);
				if (match && Number(match[2]) > this.maxFiles) {
					try {
						unlinkSync(join(this.dir, name));
					} catch {
						/* noop */
					}
				}
			}
		} catch {
			/* noop */
		}
		this.currentFile = this.todayFile();
		this.trimToMaxFiles();
	}

	/** Keep at most maxFiles total files (today's + older rolls). */
	private trimToMaxFiles(): void {
		try {
			const files = readdirSync(this.dir)
				.filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))
				.sort();
			while (files.length > this.maxFiles) {
				const oldest = files.shift();
				if (oldest) {
					try {
						unlinkSync(join(this.dir, oldest));
					} catch {
						/* noop */
					}
				}
			}
		} catch {
			/* noop */
		}
	}
}

export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
	return new Logger(logsPath(), options);
}
