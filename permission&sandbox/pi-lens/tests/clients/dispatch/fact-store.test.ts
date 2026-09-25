import { describe, it, expect } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";

describe("FactStore", () => {
	it("stores and retrieves file facts", () => {
		const store = new FactStore();
		store.setFileFact("src/foo.ts", "file.content", "const x = 1;");
		expect(store.getFileFact("src/foo.ts", "file.content")).toBe(
			"const x = 1;",
		);
	});

	it("returns undefined for unknown facts", () => {
		const store = new FactStore();
		expect(store.getFileFact("src/foo.ts", "file.content")).toBeUndefined();
	});

	it("hasFileFact returns false before set, true after", () => {
		const store = new FactStore();
		expect(store.hasFileFact("src/foo.ts", "file.content")).toBe(false);
		store.setFileFact("src/foo.ts", "file.content", "x");
		expect(store.hasFileFact("src/foo.ts", "file.content")).toBe(true);
	});

	it("stores and retrieves session facts", () => {
		const store = new FactStore();
		store.setSessionFact("session.toolCache.biome", true);
		expect(store.getSessionFact("session.toolCache.biome")).toBe(true);
	});

	it("clearFileFactsFor clears only the target file's facts", () => {
		const store = new FactStore();
		store.setFileFact("src/a.ts", "file.content", "aaa");
		store.setFileFact("src/b.ts", "file.content", "bbb");
		store.clearFileFactsFor("src/a.ts");
		expect(store.getFileFact("src/a.ts", "file.content")).toBeUndefined();
		expect(store.getFileFact("src/b.ts", "file.content")).toBe("bbb");
	});

	it("dropFileFacts clears one file's facts without disturbing others", () => {
		const store = new FactStore();
		store.setFileFact("src/a.ts", "file.content", "aaa");
		store.setFileFact("src/b.ts", "file.content", "bbb");
		store.dropFileFacts("src/a.ts");
		expect(store.getFileFact("src/a.ts", "file.content")).toBeUndefined();
		expect(store.getFileFact("src/b.ts", "file.content")).toBe("bbb");
	});

	it("clearAll() removes both file and session facts", () => {
		const store = new FactStore();
		store.setFileFact("src/foo.ts", "file.content", "x");
		store.setSessionFact("session.toolCache.biome", true);
		store.clearAll();
		expect(store.getFileFact("src/foo.ts", "file.content")).toBeUndefined();
		expect(store.getSessionFact("session.toolCache.biome")).toBeUndefined();
	});

	it("path normalization — backslash and forward-slash paths resolve to the same key", () => {
		const store = new FactStore();
		store.setFileFact("src\\foo.ts", "file.content", "x");
		expect(store.getFileFact("src/foo.ts", "file.content")).toBe("x");
	});

	it("clearFileFactsFor normalizes path — raw path clears fact set by resolved path", () => {
		const store = new FactStore();
		store.setFileFact("src/foo.ts", "file.content", "x");
		store.clearFileFactsFor("src\\foo.ts");
		expect(store.getFileFact("src/foo.ts", "file.content")).toBeUndefined();
	});

	it("hasSessionFact returns false before set, true after", () => {
		const store = new FactStore();
		expect(store.hasSessionFact("session.toolCache.biome")).toBe(false);
		store.setSessionFact("session.toolCache.biome", true);
		expect(store.hasSessionFact("session.toolCache.biome")).toBe(true);
	});

	it("setFileFact overwrites existing value for same path+factId", () => {
		const store = new FactStore();
		store.setFileFact("src/foo.ts", "file.content", "first");
		store.setFileFact("src/foo.ts", "file.content", "second");
		expect(store.getFileFact("src/foo.ts", "file.content")).toBe("second");
	});

	it("distinct factIds on same file are stored independently", () => {
		const store = new FactStore();
		store.setFileFact("src/foo.ts", "file.content", "hello");
		store.setFileFact("src/foo.ts", "file.lineCount", 42);
		expect(store.getFileFact("src/foo.ts", "file.content")).toBe("hello");
		expect(store.getFileFact("src/foo.ts", "file.lineCount")).toBe(42);
	});
});
