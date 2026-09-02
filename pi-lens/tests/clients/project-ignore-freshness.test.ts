import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import {
	getProjectIgnoreMatcher,
	PROJECT_IGNORE_FRESHNESS_CADENCE_MS,
} from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("project ignore freshness probe (#2159)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("refreshes a consumed nested ignore file after an external edit", () => {
		const env = setupTestEnvironment("pi-lens-2159-external-");
		try {
			const nested = path.join(env.tmpDir, "ignored", "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			const target = path.join(nested, "generated.ts");
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), "ignored/\n");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const first = getProjectIgnoreMatcher(env.tmpDir);
			expect(first.isIgnored(target)).toBe(true);
			// The next lookup publishes the nested source discovered by the verdict.
			expect(getProjectIgnoreMatcher(env.tmpDir)).toBe(first);

			// This bypasses the tool_result write boundary that #2153 covers.
			fs.writeFileSync(ignorePath, "!generated.ts\n");
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			expect(getProjectIgnoreMatcher(env.tmpDir).isIgnored(target)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("drops a consumed nested source when an external delete removes it", () => {
		const env = setupTestEnvironment("pi-lens-2159-delete-");
		try {
			const nested = path.join(env.tmpDir, "ignored", "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			const target = path.join(nested, "generated.ts");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(target)).toBe(true);
			getProjectIgnoreMatcher(env.tmpDir);
			fs.unlinkSync(ignorePath);
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);

			expect(getProjectIgnoreMatcher(env.tmpDir).isIgnored(target)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("refreshes a pre-memoized path after other paths walk an edited source", () => {
		const env = setupTestEnvironment("pi-lens-2159-ordering-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			const memoizedTarget = path.join(nested, "a.ts");
			const walkerTarget = path.join(nested, "b.ts");
			fs.writeFileSync(ignorePath, "a.ts\n");
			vi.useFakeTimers();
			const start = Date.now();
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(memoizedTarget)).toBe(true);
			getProjectIgnoreMatcher(env.tmpDir);

			fs.writeFileSync(ignorePath, "!a.ts\n");
			// This ordinary walker lookup must not replace the pre-edit baseline.
			getProjectIgnoreMatcher(env.tmpDir).isIgnored(walkerTarget);
			getProjectIgnoreMatcher(env.tmpDir);
			for (let window = 1; window <= 5; window++) {
				vi.setSystemTime(
					start + window * PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1,
				);
				getProjectIgnoreMatcher(env.tmpDir).isIgnored(walkerTarget);
			}

			expect(
				getProjectIgnoreMatcher(env.tmpDir).isIgnored(memoizedTarget),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("refreshes a pre-memoized path after other paths walk a deleted source", () => {
		const env = setupTestEnvironment("pi-lens-2159-delete-ordering-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			const memoizedTarget = path.join(nested, "a.ts");
			const walkerTarget = path.join(nested, "b.ts");
			fs.writeFileSync(ignorePath, "a.ts\n");
			vi.useFakeTimers();
			const start = Date.now();
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			expect(matcher.isIgnored(memoizedTarget)).toBe(true);
			getProjectIgnoreMatcher(env.tmpDir);

			fs.unlinkSync(ignorePath);
			// This ordinary walker lookup must not replace the pre-delete baseline.
			getProjectIgnoreMatcher(env.tmpDir).isIgnored(walkerTarget);
			getProjectIgnoreMatcher(env.tmpDir);
			for (let window = 1; window <= 5; window++) {
				vi.setSystemTime(
					start + window * PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1,
				);
				getProjectIgnoreMatcher(env.tmpDir).isIgnored(walkerTarget);
			}

			expect(
				getProjectIgnoreMatcher(env.tmpDir).isIgnored(memoizedTarget),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the unchanged matcher hot inside the cadence window", () => {
		const env = setupTestEnvironment("pi-lens-2159-cadence-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(nested, ".gitignore"), "generated.ts\n");
			const target = path.join(nested, "generated.ts");
			getProjectIgnoreMatcher(env.tmpDir).isIgnored(target);

			const first = getProjectIgnoreMatcher(env.tmpDir);
			const statSpy = vi.spyOn(fs, "statSync");
			const sourceStats = () =>
				statSpy.mock.calls.filter(
					([filePath]) => filePath === path.join(nested, ".gitignore"),
				);
			statSpy.mockClear();

			expect(getProjectIgnoreMatcher(env.tmpDir)).toBe(first);
			expect(sourceStats()).toHaveLength(0);

			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1);
			getProjectIgnoreMatcher(env.tmpDir);
			expect(sourceStats().length).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("settles to one source stat per cadence window after external edit", () => {
		const env = setupTestEnvironment("pi-lens-2159-settled-");
		try {
			const nested = path.join(env.tmpDir, "package");
			fs.mkdirSync(nested, { recursive: true });
			const ignorePath = path.join(nested, ".gitignore");
			const target = path.join(nested, "generated.ts");
			fs.writeFileSync(ignorePath, "generated.ts\n");
			const matcher = getProjectIgnoreMatcher(env.tmpDir);
			matcher.isIgnored(target);
			getProjectIgnoreMatcher(env.tmpDir);

			const statSpy = vi.spyOn(fs, "statSync");
			const sourceStats = () =>
				statSpy.mock.calls.filter(([filePath]) => filePath === ignorePath);
			statSpy.mockClear();
			fs.writeFileSync(ignorePath, "!generated.ts\n");
			vi.useFakeTimers();
			const start = Date.now();
			const perWindow: number[] = [];
			for (let window = 1; window <= 6; window++) {
				vi.setSystemTime(
					start + window * PROJECT_IGNORE_FRESHNESS_CADENCE_MS + 1,
				);
				const before = sourceStats().length;
				getProjectIgnoreMatcher(env.tmpDir).isIgnored(target);
				perWindow.push(sourceStats().length - before);
			}

			expect(perWindow.slice(1)).toEqual([1, 1, 1, 1, 1]);
		} finally {
			env.cleanup();
		}
	});
});
