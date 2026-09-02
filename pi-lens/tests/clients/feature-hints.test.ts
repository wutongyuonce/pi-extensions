import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
	featureHintMetadata,
	inferFeatureKind,
	inferTrustBoundaries,
} from "../../clients/feature-hints.js";
import { toProjectRelativePath } from "../../clients/path-utils.js";

describe("feature hints", () => {
	it("infers service/database boundaries from names", () => {
		expect(inferFeatureKind("src/db/UserRepository.ts")).toBe("service");
		expect(inferTrustBoundaries("src/db/UserRepository.ts")).toEqual([
			"filesystem",
			"database",
		]);
	});

	it("infers external API boundaries from provider names", () => {
		expect(inferFeatureKind("OpenAIClient")).toBe("service");
		expect(inferTrustBoundaries("OpenAIClient")).toEqual([
			"network",
			"external-api",
			"serialization",
		]);
	});

	it("infers cli boundaries from command names", () => {
		expect(inferFeatureKind("bin/pi-lens-cli.ts")).toBe("cli-command");
		expect(inferTrustBoundaries("bin/pi-lens-cli.ts")).toEqual([
			"user-input",
			"process-exec",
		]);
	});

	it("does not let an absolute parent path affect a relative library hint", () => {
		const projectRoot = path.join(path.resolve("store"), "project");
		const absolute = path.join(projectRoot, "plain.ts");
		const relative = toProjectRelativePath(absolute, projectRoot);
		expect(featureHintMetadata(relative)).toEqual({
			featureKind: "library",
			trustBoundaries: [],
		});
	});

	it("matches whole tokens and preserves database/camelCase matches", () => {
		expect(inferFeatureKind("src/adb.ts")).toBe("library");
		expect(inferTrustBoundaries("src/adb.ts")).toEqual([]);
		expect(inferFeatureKind("src/database.ts")).toBe("service");
		expect(inferTrustBoundaries("src/database.ts")).toEqual([
			"filesystem",
			"database",
		]);
		expect(inferTrustBoundaries("src/authStore.ts")).toEqual([
			"filesystem",
			"database",
		]);
	});
});
