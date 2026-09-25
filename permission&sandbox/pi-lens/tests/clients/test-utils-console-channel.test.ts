import { describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

describe("test utility cleanup diagnostics", () => {
	it("writes cleanup failures to stderr with a complete line (#3128)", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			// A null byte is rejected by the real filesystem seam, so this drives
			// removeTempDirSync's failure path without replacing fs.rmSync.
			removeTempDirSync("\0");
			expect(write).toHaveBeenCalledTimes(1);
			const message = String(write.mock.calls[0]?.[0]);
			expect(message).toContain("[test cleanup] could not remove temp dir");
			expect(message.endsWith("\n")).toBe(true);
		} finally {
			write.mockRestore();
		}
	});
});
