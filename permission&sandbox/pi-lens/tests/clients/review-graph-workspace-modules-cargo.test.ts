/**
 * Golden + regression coverage for the Cargo.toml reader fold (#2473).
 *
 * `clients/review-graph/workspace-modules.ts`'s `scanCargoModules`/
 * `detectWorkspaceType` used to carry their own regex TOML reader
 * (`extractTomlArray`/`extractTomlSection`/`extractTomlString`), a third
 * copy alongside `clients/cargo-manifest.ts` (#2466) and
 * `clients/lsp/server.ts`'s rust-analyzer hoisting. `extractTomlString` was
 * NOT table-scoped: it scanned the whole manifest for the first
 * `name = "..."` line regardless of table, so a member crate whose `name`
 * key appeared under some OTHER table before `[package]` (a `[[bin]]` or
 * `[package.metadata.*]` block) silently returned the wrong crate name for
 * the module graph.
 *
 * `tests/fixtures/cargo-modules-snapshot.json` is the committed "before"
 * golden — `buildModuleGraph`'s output (via `scanCargoModules`/
 * `detectWorkspaceType`, its only externally observable surface) over every
 * `Cargo.toml`-bearing fixture directory in `tests/fixtures/`, captured on
 * pre-#2473 code. Regenerate with `node scripts/gen-cargo-modules-snapshot.mjs`
 * after a change and diff it — a change to this reader should show up here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildSnapshot,
	SNAPSHOT_PATH,
} from "../../scripts/gen-cargo-modules-snapshot.mjs";
import {
	buildModuleGraph,
	clearModuleGraphCache,
} from "../../clients/review-graph/workspace-modules.js";

const SYNTHETIC_WORKSPACE = fileURLToPath(
	new URL(
		"../fixtures/cargo-workspace-modules/synthetic-workspace",
		import.meta.url,
	),
);

function fixtureDir(name: string): string {
	return fileURLToPath(
		new URL(`../fixtures/cargo-workspace-modules/${name}`, import.meta.url),
	);
}

describe("cargo module-graph golden snapshot (#2473)", () => {
	it("matches the committed fixture", () => {
		const fixture = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		expect(buildSnapshot()).toEqual(fixture);
	});
});

describe("Cargo.toml reader table-scoping (#2473)", () => {
	it("reads a member crate's name from `[package]`, not an earlier `[[bin]]` block", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(SYNTHETIC_WORKSPACE);
		expect(graph).not.toBeNull();
		// `crates/bin-before-package/Cargo.toml` declares `[[bin]] name =
		// "wrong-bin-name"` BEFORE `[package] name = "bin-before-package"`. The
		// pre-fold unscoped reader returned the `[[bin]]` value.
		expect(graph?.modules.has("bin-before-package")).toBe(true);
		expect(graph?.modules.has("wrong-bin-name")).toBe(false);
	});

	it("reads a member crate's name from `[package]`, not an earlier `[package.metadata.*]` block", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(SYNTHETIC_WORKSPACE);
		expect(graph).not.toBeNull();
		// `crates/metadata-before-package/Cargo.toml` declares
		// `[package.metadata.docs.rs] name = "wrong-metadata-name"` BEFORE
		// `[package] name = "metadata-before-package"`.
		expect(graph?.modules.has("metadata-before-package")).toBe(true);
		expect(graph?.modules.has("wrong-metadata-name")).toBe(false);
	});

	it("still resolves an internal dependency edge and `[dependencies]` names unscoped-array-preserving", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(SYNTHETIC_WORKSPACE);
		expect(graph?.modules.get("normal-with-deps")?.internalDeps).toEqual([
			"autofix-smoke",
		]);
		expect(graph?.modules.get("normal-with-deps")?.externalDeps.sort()).toEqual(
			["serde", "tokio"],
		);
	});
});

/**
 * Reviewer's adversarial cargo-workspace fixtures (review round 2, F6):
 * `tests/fixtures/cargo-workspace-modules/adv-*`. Each isolates ONE finding
 * from PR #2480 review round 2 at the `buildModuleGraph` level (the same
 * externally observable surface the golden snapshot covers).
 */
describe("adversarial fixtures (#2473 review round 2, F1-F4)", () => {
	it("F1: a commented-out member's crate does not enter the module graph even though it still exists on disk", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-a-commented-member"));
		expect(graph?.modules.has("adv-a-kept")).toBe(true);
		expect(graph?.modules.has("adv-a-commented-out")).toBe(false);
	});

	it("F2: an indented [package] heading is still read (single-member workspace is not null)", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-b-indented-package"));
		expect(graph).not.toBeNull();
		expect(graph?.modules.has("adv-b-indented")).toBe(true);
	});

	it("F2: an indented sub-table heading terminates the parent [dependencies] slice", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-c-indented-subtable"));
		const deps = graph?.modules.get("adv-c-subtable")?.externalDeps;
		expect(deps).toEqual(["serde"]);
		expect(deps).not.toContain("version");
		expect(deps).not.toContain("features");
	});

	it("control: dev/build/target-scoped dependency tables never feed [dependencies] reads", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-d-dev-only-deps"));
		expect(graph?.modules.get("adv-d-devonly")?.externalDeps).toEqual([]);
	});

	it("F2: a CRLF manifest is read the same as an LF one", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-e-crlf"));
		expect(graph).not.toBeNull();
		expect(graph?.modules.get("adv-e-crlf")?.externalDeps).toEqual(["serde"]);
	});

	it("control: a bare minimal [package] (name only) still resolves", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-f-bare-package"));
		expect(graph?.modules.has("adv-f-bare")).toBe(true);
	});

	it("a trailing comment on a table heading does not hide the table body", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-g-heading-comment"));
		expect(graph?.modules.get("adv-g-heading-comment")?.externalDeps).toEqual([
			"serde",
		]);
	});

	it("F3: a commented-out [workspace] heading falls through to a real npm workspace instead of resolving to null", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(
			fixtureDir("adv-h-commented-workspace-heading"),
		);
		expect(graph).not.toBeNull();
		expect(graph?.modules.has("foo")).toBe(true);
	});

	it("F1 (review round 3): an EMPTY [workspace] table with no trailing newline at EOF is still classified as cargo, not npm", () => {
		// `adv-i-empty-workspace-eof/Cargo.toml`'s `[workspace]` heading is the
		// LAST bytes of the file (no trailing newline, no `members` key) — an
		// empty-but-PRESENT table. `extractTomlTableSection` used to return the
		// same `""` sentinel for this as for "table absent", so
		// `detectWorkspaceType` fell through past Cargo.toml to the sibling
		// package.json's `workspaces` glob and misclassified the project as
		// npm, surfacing the npm member "foo". Fixed: Cargo.toml correctly
		// short-circuits detection as "cargo" — since this workspace declares
		// no explicit `members`, `scanCargoModules` finds none and
		// `buildModuleGraph` returns `null`, but "foo" must never appear (that
		// would mean detection fell through to npm again).
		clearModuleGraphCache();
		const graph = buildModuleGraph(fixtureDir("adv-i-empty-workspace-eof"));
		expect(graph).toBeNull();
	});
});
