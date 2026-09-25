import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	setTmpHygieneAfterAllProbeForTests,
	writeTmpHygieneLeakNotice,
} from "./vitest-setup.js";

describe("worker console channel (#3128)", () => {
	it("writes tmp-hygiene leak notices to stderr with a newline", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			writeTmpHygieneLeakNotice("/tmp/pi-lens-hygiene", 3);
			expect(write).toHaveBeenCalledTimes(1);
			const message = String(write.mock.calls[0]?.[0]);
			expect(message).toContain("3 unadmitted entry(s)");
			expect(message.endsWith("\n")).toBe(true);
		} finally {
			write.mockRestore();
		}
	});

	it("reports an unadmitted entry from the worker teardown path", () => {
		const leakedEntry = path.join(
			os.tmpdir(),
			`pi-lens-worker-teardown-${Date.now()}-${process.pid}`,
		);
		const previousTrace = process.env.PI_LENS_TMP_HYGIENE_TRACE;
		delete process.env.PI_LENS_TMP_HYGIENE_TRACE;
		fs.mkdirSync(leakedEntry);
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		setTmpHygieneAfterAllProbeForTests(() => {
			try {
				const notices = write.mock.calls
					.map(([chunk]) => String(chunk))
					.filter((message) => message.startsWith("[tmp-hygiene]"));
				expect(notices).toHaveLength(1);
				const message = notices[0] ?? "";
				expect(message).toContain("unadmitted entry(s)");
				expect(message.endsWith("\n")).toBe(true);
			} finally {
				write.mockRestore();
				fs.rmSync(leakedEntry, { recursive: true, force: true });
				if (previousTrace === undefined)
					delete process.env.PI_LENS_TMP_HYGIENE_TRACE;
				else process.env.PI_LENS_TMP_HYGIENE_TRACE = previousTrace;
			}
		});
	});
});
