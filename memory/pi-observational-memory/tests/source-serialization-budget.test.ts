import { describe, expect, it } from "vitest";

import { renderRecallSourceEntry, serializeSourceAddressedBranchEntries } from "../src/serialize.js";
import { estimateStringTokens } from "../src/tokens.js";

function customEntry(id: string, content: string) {
	return {
		type: "custom_message",
		id,
		timestamp: "2026-05-02T10:00:00.000Z",
		content,
	};
}

function toolResultEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		timestamp: "2026-05-02T10:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
		},
	};
}

describe("source-addressed serialization budget", () => {
	it("preserves all source blocks when they fit", () => {
		const entries = [
			customEntry("raw-1", "first"),
			customEntry("raw-2", "second"),
		];
		const result = serializeSourceAddressedBranchEntries(entries, {
			maxTokens: 1_000,
		});

		expect(result.sourceEntryIds).toEqual(["raw-1", "raw-2"]);
		expect(result.truncatedSourceEntryIds).toEqual([]);
		expect(result.text).toContain("[Source entry id: raw-1]");
		expect(result.text).toContain("[Source entry id: raw-2]");
		expect(result.estimatedTokens).toBe(estimateStringTokens(result.text));
	});

	it("keeps later complete entries for the next run when the budget is full", () => {
		const first = customEntry("raw-1", "a".repeat(80));
		const second = customEntry("raw-2", "b".repeat(80));
		const firstOnly = serializeSourceAddressedBranchEntries([first]);
		const result = serializeSourceAddressedBranchEntries([first, second], {
			maxTokens: firstOnly.estimatedTokens,
		});

		expect(result.sourceEntryIds).toEqual(["raw-1"]);
		expect(result.truncatedSourceEntryIds).toEqual([]);
		expect(result.text).not.toContain("raw-2");
	});

	it("returns no source instead of truncating the source label under an unusably small budget", () => {
		const result = serializeSourceAddressedBranchEntries(
			[customEntry("raw-1", "content")],
			{ maxTokens: 1 },
		);

		expect(result).toEqual({
			text: "",
			sourceEntryIds: [],
			estimatedTokens: 0,
			truncatedSourceEntryIds: [],
		});
	});

	it("uses a marked head/tail excerpt when one tool result exceeds the budget", () => {
		const source = `HEAD:${"m".repeat(2_000)}:TAIL`;
		const hugeEntry = toolResultEntry("raw-huge", source);
		const result = serializeSourceAddressedBranchEntries(
			[hugeEntry, customEntry("raw-next", "later")],
			{ maxTokens: 100 },
		);

		expect(result.sourceEntryIds).toEqual(["raw-huge"]);
		expect(result.truncatedSourceEntryIds).toEqual(["raw-huge"]);
		expect(result.estimatedTokens).toBeLessThanOrEqual(100);
		expect(result.text).toContain("[Source entry id: raw-huge]");
		expect(result.text).toContain("[Tool result for bash");
		expect(result.text).toContain("HEAD:");
		expect(result.text).toContain(":TAIL");
		expect(result.text).toContain(
			"middle omitted: source exceeds observer input budget",
		);
		expect(result.text).toContain(
			"original source remains in the session ledger",
		);
		expect(result.text).not.toContain("raw-next");

		// Budgeting changes only the observer projection. Recall still renders
		// the original, unmodified ledger entry in full.
		const recalled = renderRecallSourceEntry(hugeEntry);
		expect(recalled).toContain(source);
		expect(recalled?.length).toBeGreaterThan(result.text.length);
	});
});
