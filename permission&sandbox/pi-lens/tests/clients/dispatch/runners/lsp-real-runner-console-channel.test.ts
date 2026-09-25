import { describe, expect, it, vi } from "vitest";

type FsModule = typeof import("node:fs") & {
	default: typeof import("node:fs");
};

// Load the real LSP test module with its fixture unavailable. The module-load
// branch runs before any test body, so a direct helper call cannot satisfy this
// regression. The real-server suite must also remain skipped in this cell.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<FsModule>();
	const unavailable = (): boolean => false;
	return {
		...actual,
		existsSync: unavailable,
		default: { ...actual.default, existsSync: unavailable },
	};
});

const writes: string[] = [];
const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
	writes.push(String(chunk));
	return true;
});
const { serverAvailable } = await import("./lsp-real-runner.test.ts");
write.mockRestore();

const unavailableNotices = writes.filter((line) =>
	line.startsWith("[CI LOUD]"),
);

describe("LSP unavailable worker console channel (#3128)", () => {
	it("reports module-load unavailability once and keeps the suite skipped", () => {
		expect(unavailableNotices).toHaveLength(1);
		expect(unavailableNotices[0]).toContain("fake server unavailable");
		expect(unavailableNotices[0]?.endsWith("\n")).toBe(true);
		expect(serverAvailable).toBe(false);
	});
});
