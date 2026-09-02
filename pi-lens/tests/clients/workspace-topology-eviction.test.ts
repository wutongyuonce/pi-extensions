import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import {
	findNearestDirWithMarker,
	getDirectoryMarkers,
	releaseWorkspaceTopologyIdleTimers,
	resetWorkspaceTopology,
} from "../../clients/workspace-topology.js";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	resetWorkspaceTopology();
});

describe("workspace-topology replacement eviction", () => {
	it("keeps one marker-cache timer after 20 forced mtime misses", () => {
		vi.stubEnv("PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS", "60000");
		vi.useFakeTimers();
		const dir = path.join(process.cwd(), "topology-marker-cache-probe");
		const realStatSync = vi.mocked(fs.statSync).getMockImplementation()!;
		let mtime = 0;
		vi.mocked(fs.statSync).mockImplementation((filePath) => {
			if (path.resolve(String(filePath)) === dir)
				return { mtimeMs: ++mtime } as fs.Stats;
			return realStatSync(filePath);
		});

		for (let i = 0; i < 20; i++) getDirectoryMarkers(dir);

		expect(vi.getTimerCount()).toBe(1);
	});

	it("keeps one walk-cache timer after 20 forced mtime misses", () => {
		vi.stubEnv("PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS", "60000");
		vi.useFakeTimers();
		const startDir = path.join(process.cwd(), "topology-walk-cache-probe");
		const homeDir = path.dirname(startDir);
		const realStatSync = vi.mocked(fs.statSync).getMockImplementation()!;
		let walkMtime = 0;
		vi.mocked(fs.statSync).mockImplementation((filePath) => {
			if (path.resolve(String(filePath)) === startDir)
				return new Error().stack?.includes("walkStillFresh")
					? ({ mtimeMs: ++walkMtime } as fs.Stats)
					: ({ mtimeMs: -1 } as fs.Stats);
			return realStatSync(filePath);
		});

		for (let i = 0; i < 20; i++)
			findNearestDirWithMarker(startDir, "tsconfigPath", homeDir);
		releaseWorkspaceTopologyIdleTimers();
		vi.mocked(fs.statSync).mockImplementation((filePath) => {
			if (path.resolve(String(filePath)) === startDir)
				return { mtimeMs: -1 } as fs.Stats;
			return realStatSync(filePath);
		});
		findNearestDirWithMarker(startDir, "tsconfigPath", homeDir);

		expect(vi.getTimerCount()).toBe(1);
	});
});
