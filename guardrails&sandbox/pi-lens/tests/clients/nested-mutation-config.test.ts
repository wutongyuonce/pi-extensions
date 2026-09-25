import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolvePiLensFlag,
	resolvePiLensFlagWithSource,
} from "../../clients/lens-config.js";
import {
	getLensFlagSpec,
	type LensFlagSpec,
} from "../../clients/lens-flag-registry.js";
import {
	findNestedProjectMutationValue,
	loadPiLensProjectConfig,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];
const noAutoformat = getLensFlagSpec("no-autoformat") as LensFlagSpec;

function fixture(): { root: string; pkg: string; file: string } {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-nested-mutation-"),
	);
	dirs.push(root);
	const pkg = path.join(root, "packages", "app");
	fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
	return { root, pkg, file: path.join(pkg, "src", "index.ts") };
}

function writeConfig(dir: string, value: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(value));
}

afterEach(() => {
	resetProjectLensConfigCache();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("nested project mutation controls (#792)", () => {
	it("uses the closest explicitly defining config and reports its directory", () => {
		const { root, pkg, file } = fixture();
		writeConfig(root, { format: { enabled: true } });
		writeConfig(pkg, { format: { enabled: false } });
		const resolved = resolvePiLensFlagWithSource(
			"no-autoformat",
			false,
			undefined,
			loadPiLensProjectConfig(root),
			file,
			root,
		);
		expect(resolved).toEqual({
			value: true,
			source: `nested-project:${pkg}`,
		});
	});

	it("inherits each missing flag independently from an ancestor", () => {
		const { root, pkg, file } = fixture();
		writeConfig(root, { autofix: { enabled: false } });
		writeConfig(pkg, { format: { enabled: false } });
		const project = loadPiLensProjectConfig(root);
		expect(
			resolvePiLensFlag("no-autoformat", false, undefined, project, file, root),
		).toBe(true);
		expect(
			resolvePiLensFlag("no-autofix", false, undefined, project, file, root),
		).toBe(true);
	});

	it("keeps an explicit CLI disable above a nested enable", () => {
		const { root, pkg, file } = fixture();
		writeConfig(pkg, { autofix: { enabled: true } });
		expect(
			resolvePiLensFlagWithSource(
				"no-autofix",
				true,
				undefined,
				loadPiLensProjectConfig(root),
				file,
				root,
			),
		).toEqual({ value: true, source: "cli" });
	});

	it("does not inspect the configured home directory or its ancestors", () => {
		const { root, pkg, file } = fixture();
		writeConfig(root, { format: { enabled: false } });
		expect(
			findNestedProjectMutationValue(noAutoformat, file, root, pkg),
		).toBeUndefined();
	});

	it("invalidates the per-directory cache when a config is edited", () => {
		const { root, pkg, file } = fixture();
		writeConfig(pkg, { format: { enabled: false } });
		expect(
			findNestedProjectMutationValue(noAutoformat, file, root)?.value,
		).toBe(false);
		writeConfig(pkg, { format: { enabled: true }, extra: "changes-size" });
		const configPath = path.join(pkg, ".pi-lens.json");
		const now = new Date(Date.now() + 2_000);
		fs.utimesSync(configPath, now, now);
		expect(
			findNestedProjectMutationValue(noAutoformat, file, root)?.value,
		).toBe(true);
	});
});
