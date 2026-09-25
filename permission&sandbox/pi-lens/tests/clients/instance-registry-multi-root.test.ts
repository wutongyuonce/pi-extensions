/**
 * #2130: the host registry entry holds a SET of roots, not one clobbered
 * scalar.
 *
 * The defect: `registerInstance` overwrote `projectRoot` on every call, so a
 * host whose subagent started a temp worktree advertised the TEMP DIR as its
 * project root. `selectLivePeerInstances` — the single predicate behind warm
 * attach (#2007) and the shared-checkout guard (#2107) — then compared against
 * that one clobbered value and could not see a peer under any other root.
 *
 * `getGlobalPiLensDir` is mocked to a per-test temp dir, so nothing here
 * touches the real `~/.pi-lens/instances.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

vi.mock("../../clients/file-utils.js", () => ({
	// #2506: both resolvers, same dir. Under the vitest PI_LENS_HOME pin
	// production returns one value for both, so a double that split them
	// would diverge from production on the axis these tests measure.
	getGlobalPiLensDir: () => dir,
}));

describe("instance-registry multi-root (#2130)", () => {
	let realRoot: string;
	let tempRoot: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-mr-"));
		// Real directories: `normalizeFilePath` canonicalizes an EXISTING path
		// via realpath, so comparing against a made-up path would compare two
		// differently-derived spellings and prove nothing.
		realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-real-"));
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-temp-"));
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		removeTempDirSync(dir);
		removeTempDirSync(realRoot);
		removeTempDirSync(tempRoot);
	});

	function readEntry(): {
		projectRoot: string;
		projectRoots?: string[];
	} {
		const raw = fs.readFileSync(path.join(dir, "instances.json"), "utf-8");
		return JSON.parse(raw).instances[0];
	}

	it("a second root is ADDED, not substituted for the first", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		await registerInstance(tempRoot);

		const entry = readEntry();
		expect(entry.projectRoots).toHaveLength(2);
		expect(entry.projectRoots?.[0]).toContain(path.basename(realRoot));
		expect(entry.projectRoots?.[1]).toContain(path.basename(tempRoot));
	});

	it("the primary projectRoot is pinned and never clobbered", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		await registerInstance(tempRoot);
		// This is the exact live symptom: the host advertised a temp dir.
		expect(readEntry().projectRoot).toContain(path.basename(realRoot));
		expect(readEntry().projectRoot).not.toContain(path.basename(tempRoot));
	});

	it("re-registering the same root does not duplicate it", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		await registerInstance(realRoot);
		expect(readEntry().projectRoots).toHaveLength(1);
	});

	it("getInstanceRoots folds a pre-#2130 entry back to its scalar root", async () => {
		const { getInstanceRoots } =
			await import("../../clients/instance-registry.js");
		const legacy = {
			pid: 1,
			startedAt: "2026-08-26T00:00:00.000Z",
			projectRoot: "/legacy/root",
			lspChildren: [],
			lspChildCount: 0,
			rssBytes: 0,
			heartbeatAt: "2026-08-26T00:00:00.000Z",
		};
		expect(getInstanceRoots(legacy)).toEqual(["/legacy/root"]);
	});

	it("getInstanceRoots drops non-string members from a torn file", async () => {
		const { getInstanceRoots } =
			await import("../../clients/instance-registry.js");
		const torn = {
			pid: 1,
			startedAt: "2026-08-26T00:00:00.000Z",
			projectRoot: "/a",
			projectRoots: ["/a", "", null, 7, "/b"] as unknown as string[],
			lspChildren: [],
			lspChildCount: 0,
			rssBytes: 0,
			heartbeatAt: "2026-08-26T00:00:00.000Z",
		};
		expect(getInstanceRoots(torn)).toEqual(["/a", "/b"]);
	});

	it("the root set is capped, and the cap never evicts the primary", async () => {
		const { registerInstance, getInstanceRoots } =
			await import("../../clients/instance-registry.js");
		await registerInstance(realRoot);
		for (let i = 0; i < 40; i++) {
			await registerInstance(path.join(tempRoot, `wt-${i}`));
		}
		const entry = readEntry();
		const roots = getInstanceRoots(entry as never);
		expect(roots.length).toBeLessThanOrEqual(32);
		expect(roots[0]).toContain(path.basename(realRoot));
		expect(entry.projectRoot).toContain(path.basename(realRoot));
	});

	describe("registerInstanceRoot (the declined start's lightweight add)", () => {
		it("adds a root without touching the pinned primary", async () => {
			const { registerInstance, registerInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await registerInstanceRoot(tempRoot);

			const entry = readEntry();
			expect(entry.projectRoots).toHaveLength(2);
			expect(entry.projectRoots?.[1]).toContain(path.basename(tempRoot));
			expect(entry.projectRoot).toContain(path.basename(realRoot));
		});

		it("does NOT create an entry when this pid has none", async () => {
			// Synthesizing one would write the TEMP root as `projectRoot` —
			// reproducing the exact clobber #2130 is about.
			const { registerInstanceRoot, readInstanceRegistry } =
				await import("../../clients/instance-registry.js");
			await registerInstanceRoot(tempRoot);
			expect(await readInstanceRegistry()).toEqual([]);
		});

		it("leaves the other entry fields alone", async () => {
			const { registerInstance, registerInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			const before = readEntry() as unknown as Record<string, unknown>;
			await registerInstanceRoot(tempRoot);
			const after = readEntry() as unknown as Record<string, unknown>;
			// No RSS resample, no startedAt reseed, no heartbeat bump.
			expect(after.startedAt).toBe(before.startedAt);
			expect(after.heartbeatAt).toBe(before.heartbeatAt);
			expect(after.rssBytes).toBe(before.rssBytes);
		});

		it("re-adding a known root does not rewrite the file", async () => {
			const { registerInstance, registerInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			const registryFile = path.join(dir, "instances.json");
			const before = fs.statSync(registryFile, { bigint: true }).mtimeNs;
			await new Promise((resolve) => setTimeout(resolve, 25));
			await registerInstanceRoot(realRoot);
			expect(fs.statSync(registryFile, { bigint: true }).mtimeNs).toBe(before);
		});
	});

	describe("mergeInstanceRoots (the single owner of set semantics)", () => {
		it("appends a new root and dedupes a known one", async () => {
			const { mergeInstanceRoots } =
				await import("../../clients/instance-registry.js");
			expect(mergeInstanceRoots(["/a"], "/b")).toEqual(["/a", "/b"]);
			expect(mergeInstanceRoots(["/a", "/b"], "/a")).toEqual(["/a", "/b"]);
		});

		it("evicts the oldest NON-primary root at the cap", async () => {
			const { mergeInstanceRoots } =
				await import("../../clients/instance-registry.js");
			const full = Array.from({ length: 32 }, (_, i) => `/root-${i}`);
			const merged = mergeInstanceRoots(full, "/root-new");
			expect(merged).toHaveLength(32);
			expect(merged[0]).toBe("/root-0");
			expect(merged).not.toContain("/root-1");
			expect(merged.at(-1)).toBe("/root-new");
		});

		it("never mutates its input", async () => {
			const { mergeInstanceRoots } =
				await import("../../clients/instance-registry.js");
			const prior = ["/a"];
			mergeInstanceRoots(prior, "/b");
			expect(prior).toEqual(["/a"]);
		});
	});

	describe("scoped deregistration", () => {
		it("removes one root and leaves the rest of the entry alive", async () => {
			const { registerInstance, deregisterInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await registerInstance(tempRoot);
			await deregisterInstanceRoot(tempRoot);

			const entry = readEntry();
			expect(entry.projectRoots).toHaveLength(1);
			expect(entry.projectRoots?.[0]).toContain(path.basename(realRoot));
		});

		it("promotes the next root when the primary is the one removed", async () => {
			const { registerInstance, deregisterInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await registerInstance(tempRoot);
			await deregisterInstanceRoot(realRoot);
			expect(readEntry().projectRoot).toContain(path.basename(tempRoot));
		});

		it("removing the LAST root removes the whole entry", async () => {
			const { registerInstance, deregisterInstanceRoot, readInstanceRegistry } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await deregisterInstanceRoot(realRoot);
			expect(await readInstanceRegistry()).toEqual([]);
		});

		it("deregistering an unknown root does not rewrite the file", async () => {
			// The early return is not just tidiness: this module's writes are
			// read-modify-write over the WHOLE file, so a pointless rewrite can
			// clobber a concurrent update (the #1724 shape). Proven by mtime, the
			// only externally observable trace of "a write happened" — the
			// serialized content is identical either way, so a content compare
			// would pass with the guard deleted.
			const { registerInstance, deregisterInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			const registryFile = path.join(dir, "instances.json");
			const before = fs.statSync(registryFile, { bigint: true }).mtimeNs;
			// Rename-based writes stamp a fresh mtime; wait past the filesystem's
			// timestamp granularity so "unchanged" cannot be an artifact of speed.
			await new Promise((resolve) => setTimeout(resolve, 25));
			await deregisterInstanceRoot(tempRoot);
			expect(fs.statSync(registryFile, { bigint: true }).mtimeNs).toBe(before);
			// And the entry is untouched.
			expect(readEntry().projectRoots).toHaveLength(1);
		});
	});

	describe("the resource footprint reports every root (#2130)", () => {
		function entry(roots: { projectRoot?: string; projectRoots?: string[] }) {
			return {
				pid: 1,
				startedAt: "2026-08-26T00:00:00.000Z",
				heartbeatAt: "2026-08-26T00:00:00.000Z",
				rssBytes: 0,
				lspChildCount: 0,
				lspChildren: [],
				projectRoot: "",
				...roots,
			};
		}

		it("carries the whole set for a multi-root host", async () => {
			// The under-report: `pilens_health` projected ONE root per instance, so
			// a host serving a subagent's temp worktree looked single-rooted there
			// while `instances.json` listed both.
			const { computeResourceFootprint } =
				await import("../../clients/instance-registry.js");
			const footprint = computeResourceFootprint([
				entry({
					projectRoot: "/primary",
					projectRoots: ["/primary", "/tmp/worktree-a"],
				}),
			]);
			expect(footprint.perInstance[0].projectRoots).toEqual([
				"/primary",
				"/tmp/worktree-a",
			]);
			expect(footprint.perInstance[0].projectRoot).toBe("/primary");
		});

		it("folds a pre-#2130 entry to a one-element set, never undefined", async () => {
			const { computeResourceFootprint } =
				await import("../../clients/instance-registry.js");
			const footprint = computeResourceFootprint([
				entry({ projectRoot: "/legacy" }),
			]);
			expect(footprint.perInstance[0].projectRoots).toEqual(["/legacy"]);
		});

		it("resolves the scalar from the set when a torn entry lost it", async () => {
			// `getInstanceRoots` is the single reader precisely so a projection
			// cannot disagree with the set. Reading `entry.projectRoot` directly
			// reported the empty scalar for a shape the set answers cleanly.
			const { computeResourceFootprint } =
				await import("../../clients/instance-registry.js");
			const footprint = computeResourceFootprint([
				entry({ projectRoots: ["/a", "/b"] }),
			]);
			expect(footprint.perInstance[0].projectRoot).toBe("/a");
		});

		it("getResourceFootprint reports both roots this pid registered", async () => {
			const { registerInstance, registerInstanceRoot, getResourceFootprint } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await registerInstanceRoot(tempRoot);

			const footprint = await getResourceFootprint(() => true);
			const mine = footprint.perInstance.find((i) => i.pid === process.pid);
			expect(mine?.projectRoots).toHaveLength(2);
			expect(mine?.projectRoots[1]).toContain(path.basename(tempRoot));
		});
	});

	describe("selectLivePeerInstances sees SECONDARY roots (#2007 / #2107)", () => {
		function peerEntry(roots: string[]) {
			return {
				pid: process.pid + 1,
				startedAt: new Date().toISOString(),
				projectRoot: roots[0],
				projectRoots: roots,
				lspChildren: [],
				lspChildCount: 0,
				rssBytes: 0,
				heartbeatAt: new Date().toISOString(),
			};
		}

		it("exact match finds a peer registered under its SECOND root", async () => {
			const { selectLivePeerInstances } =
				await import("../../clients/instance-registry.js");
			const { normalizeFilePath } = await import("../../clients/path-utils.js");
			const peer = peerEntry([
				normalizeFilePath(realRoot),
				normalizeFilePath(tempRoot),
			]);
			const found = selectLivePeerInstances(
				[peer],
				tempRoot,
				Date.now(),
				() => true,
				"exact",
			);
			expect(found).toHaveLength(1);
		});

		it("containment match finds a subdirectory of a SECOND root", async () => {
			const { selectLivePeerInstances } =
				await import("../../clients/instance-registry.js");
			const { normalizeFilePath } = await import("../../clients/path-utils.js");
			const peer = peerEntry([
				normalizeFilePath(realRoot),
				normalizeFilePath(tempRoot),
			]);
			const found = selectLivePeerInstances(
				[peer],
				path.join(tempRoot, "clients"),
				Date.now(),
				() => true,
				"containment",
			);
			expect(found).toHaveLength(1);
		});

		it("an unrelated root still matches nothing", async () => {
			const { selectLivePeerInstances } =
				await import("../../clients/instance-registry.js");
			const { normalizeFilePath } = await import("../../clients/path-utils.js");
			const peer = peerEntry([normalizeFilePath(realRoot)]);
			expect(
				selectLivePeerInstances(
					[peer],
					tempRoot,
					Date.now(),
					() => true,
					"exact",
				),
			).toHaveLength(0);
		});
	});
});
