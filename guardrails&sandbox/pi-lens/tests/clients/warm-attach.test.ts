import { describe, expect, it } from "vitest";
import type { InstanceEntry } from "../../clients/instance-registry.js";
import { STALE_HEARTBEAT_MS } from "../../clients/instance-reaper.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { selectWarmAttachIncumbent } from "../../clients/warm-attach.js";
import {
	_resetWarmAttachForTests,
	_setWarmAttachForTests,
	isWarmAttached,
	tryWarmAttachedCodeActions,
	tryWarmAttachedDiagnostics,
} from "../../clients/warm-attach.js";

function entry(pid: number, root: string, heartbeatAt: string): InstanceEntry {
	return {
		pid,
		startedAt: heartbeatAt,
		projectRoot: normalizeFilePath(root),
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 1,
		heartbeatAt,
	};
}

describe("selectWarmAttachIncumbent", () => {
	const now = Date.now();
	const cwd = "C:\\work\\same-root";

	it("selects a PID-confirmed live same-root incumbent", () => {
		const incumbent = entry(11, cwd, new Date(now).toISOString());
		expect(
			selectWarmAttachIncumbent([incumbent], cwd, now, () => true)?.pid,
		).toBe(11);
	});

	it("rejects stale, dead, different-root, and absent incumbents", () => {
		const stale = entry(
			11,
			cwd,
			new Date(now - STALE_HEARTBEAT_MS - 1).toISOString(),
		);
		const dead = entry(12, cwd, new Date(now).toISOString());
		const other = entry(13, "C:\\work\\other", new Date(now).toISOString());
		expect(
			selectWarmAttachIncumbent(
				[stale, dead, other],
				cwd,
				now,
				(pid) => pid !== 12,
			),
		).toBeUndefined();
		expect(selectWarmAttachIncumbent([], cwd, now, () => true)).toBeUndefined();
	});

	it("permanently promotes to local when the incumbent disappears", async () => {
		_setWarmAttachForTests(cwd, 999_999);
		expect(isWarmAttached()).toBe(true);
		await tryWarmAttachedDiagnostics("app.ts", "x", 10);
		expect(isWarmAttached()).toBe(false);
		await tryWarmAttachedDiagnostics("app.ts", "x", 10);
		expect(isWarmAttached()).toBe(false);
		_resetWarmAttachForTests();
	});

	it("does not promote when optional code-action enrichment fails", async () => {
		_setWarmAttachForTests(cwd, 999_998);
		expect(isWarmAttached()).toBe(true);
		const result = await tryWarmAttachedCodeActions(
			"app.ts",
			"diagnostics-hash",
			[],
			10,
		);
		expect(result?.available).toBe(false);
		expect(isWarmAttached()).toBe(true);
		_resetWarmAttachForTests();
	});
});
