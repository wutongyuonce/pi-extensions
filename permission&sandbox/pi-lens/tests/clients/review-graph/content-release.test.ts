import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import { removeTempDirSync } from "../test-utils.js";

// #886 / #931 review: the builder releases full source content it seeded into a
// shared FactStore, but must NEVER release content the DISPATCH put there — the
// incremental blast-radius path runs fire-and-forget against the live dispatch
// store, and inline suppressions / dispositions / fact rules still read
// file.content after the runner groups settle. A delete would race them.
describe("review-graph builder — file.content release ownership", () => {
	const dirs: string[] = [];

	beforeEach(() => {
		clearReviewGraphWorkspaceCache();
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeTempDirSync(dir);
		}
	});

	function tmpProject(): { cwd: string; file: string; src: string } {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-content-rel-"));
		dirs.push(cwd);
		const src = "export function alpha(): number {\n\treturn 1;\n}\n";
		const file = path.join(cwd, "alpha.ts");
		fs.writeFileSync(file, src);
		return { cwd, file, src };
	}

	it("releases content the builder itself loaded (builder-owned store)", async () => {
		const { cwd, file } = tmpProject();
		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [file], facts);
		expect(facts.getFileFact<string>(file, "file.content")).toBeUndefined();
	});

	it("keeps content the dispatch seeded (live dispatch store)", async () => {
		const { cwd, file, src } = tmpProject();
		// First build so the incremental path is exercised on the second call.
		await buildOrUpdateGraph(cwd, [file], new FactStore());

		const dispatchStore = new FactStore();
		const edited = `${src}export function beta(): number {\n\treturn 2;\n}\n`;
		fs.writeFileSync(file, edited);
		dispatchStore.setFileFact(file, "file.content", edited);

		await buildOrUpdateGraph(cwd, [file], dispatchStore);

		// The dispatch still owns this content — suppressions/dispositions read
		// it after runner groups settle, so the builder must not have freed it.
		expect(dispatchStore.getFileFact<string>(file, "file.content")).toBe(
			edited,
		);
	});
});
