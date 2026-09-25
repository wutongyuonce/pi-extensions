import { describe, expect, it } from "vitest";
import {
	CODE_KINDS,
	KIND_EXTENSIONS,
	NON_CODE_KINDS,
	type FileKind,
} from "../../clients/file-kinds.js";
import {
	SUPPORTED_FILE_KINDS,
	WARMUP_SOURCE_EXTS,
} from "../../clients/language-profile.js";
import {
	ALL_SCANNABLE_EXTENSIONS,
	SOURCE_PRECEDENCE,
} from "../../clients/source-filter.js";

describe("project-wide extension coverage (#894)", () => {
	const scannable = new Set(ALL_SCANNABLE_EXTENSIONS);

	it("derives supported kinds from every KIND_EXTENSIONS key", () => {
		expect(new Set(SUPPORTED_FILE_KINDS)).toEqual(
			new Set(Object.keys(KIND_EXTENSIONS)),
		);
	});

	it.each(Object.entries(KIND_EXTENSIONS))(
		"includes every %s extension in shared source enumeration",
		(_kind, extensions) => {
			for (const extension of extensions) {
				expect(scannable.has(extension)).toBe(true);
			}
		},
	);

	it.each(Object.entries(KIND_EXTENSIONS))(
		"includes every %s extension in language-profile warmup",
		(_kind, extensions) => {
			for (const extension of extensions) {
				expect(WARMUP_SOURCE_EXTS.has(extension)).toBe(true);
			}
		},
	);

	it("contains no extension outside KIND_EXTENSIONS ∪ SOURCE_PRECEDENCE keys", () => {
		// Reverse direction: junk extensions can't accrete into the shared
		// enumeration gate — every scannable extension must be justified by a
		// registered kind or a legacy shadowing source (`.coffee`).
		const known = new Set([
			...Object.values(KIND_EXTENSIONS).flat(),
			...Object.keys(SOURCE_PRECEDENCE),
		]);
		for (const extension of ALL_SCANNABLE_EXTENSIONS) {
			expect(known.has(extension)).toBe(true);
		}
	});

	it("classifies every kind as exactly one of CODE_KINDS / NON_CODE_KINDS", () => {
		// The code/non-code partition drives dominant-warm ranking and capped-walk
		// prioritization — a newly registered kind must not be silently
		// unclassified (or double-classified).
		for (const kind of Object.keys(KIND_EXTENSIONS) as FileKind[]) {
			const inCode = CODE_KINDS.has(kind);
			const inNonCode = NON_CODE_KINDS.has(kind);
			expect(
				inCode !== inNonCode,
				`kind "${kind}" must be in exactly one of CODE_KINDS / NON_CODE_KINDS`,
			).toBe(true);
		}
		expect(CODE_KINDS.size + NON_CODE_KINDS.size).toBe(
			Object.keys(KIND_EXTENSIONS).length,
		);
	});
});
