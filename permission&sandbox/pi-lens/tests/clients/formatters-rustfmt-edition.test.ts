/**
 * #2466: `clients/formatters.ts` invoked bare `rustfmt <file>` with no
 * `--edition`, so rustfmt parses under its own default edition instead of
 * the file's actual Cargo package edition — rejecting valid newer-edition
 * (e.g. Rust 2024) syntax under an older default.
 *
 * These tests call `rustfmtFormatter.resolveCommand` directly (the same
 * pattern as `formatters-stylua-project-binary.test.ts`) so they exercise
 * the real edition-resolution code path (`resolveCargoPackageEdition` in
 * `clients/cargo-manifest.ts`), not a spawn mock.
 *
 * Review round 2 additions (F1/F2/F5): a root crate that is ALSO the
 * workspace root, a member nested under an intermediate plain-package
 * manifest, an unsupported edition value, and a mutation-proof HOME-ceiling
 * fixture — the last calls `resolveCargoPackageEdition` directly (not
 * through `rustfmtFormatter`) since only that function takes the `homeDir`
 * override tests need to inject a ceiling inside the fixture tree instead of
 * relying on the real OS home directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCargoPackageEdition } from "../../clients/cargo-manifest.js";
import { rustfmtFormatter } from "../../clients/formatters.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) removeTempDirSync(dir);
	}
});

function newTmpDir(prefix: string): string {
	const env = setupTestEnvironment(prefix);
	tmpDirs.push(env.tmpDir);
	return env.tmpDir;
}

describe("rustfmtFormatter — Cargo edition carriage (#2466)", () => {
	it("passes --edition from the nearest package's [package] table", async () => {
		const tmpDir = newTmpDir("pi-lens-rustfmt-edition-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n',
		);
		const filePath = path.join(tmpDir, "src", "main.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(filePath, tmpDir);

		// The load-bearing assertion: removing the `--edition 2024` carriage
		// from the fix collapses this back to ["rustfmt", filePath] and this
		// line goes red.
		expect(resolved).toEqual(["rustfmt", "--edition", "2024", filePath]);
	});

	it("resolves inherited edition from [workspace.package] when the package uses edition.workspace = true", async () => {
		const wsRoot = newTmpDir("pi-lens-rustfmt-ws-");
		fs.writeFileSync(
			path.join(wsRoot, "Cargo.toml"),
			'[workspace]\nmembers = ["crates/demo"]\n\n[workspace.package]\nedition = "2021"\n',
		);
		const memberDir = path.join(wsRoot, "crates", "demo");
		fs.mkdirSync(memberDir, { recursive: true });
		fs.writeFileSync(
			path.join(memberDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition.workspace = true\n',
		);
		const filePath = path.join(memberDir, "src", "lib.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "pub fn x() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(
			filePath,
			memberDir,
		);

		expect(resolved).toEqual(["rustfmt", "--edition", "2021", filePath]);
	});

	it("falls back to the static command (null) when no Cargo.toml is found", async () => {
		const tmpDir = newTmpDir("pi-lens-rustfmt-noedition-");
		const filePath = path.join(tmpDir, "loose.rs");
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(filePath, tmpDir);

		expect(resolved).toBeNull();
	});

	it("falls back to the static command when the package has no edition and does not inherit one", async () => {
		const tmpDir = newTmpDir("pi-lens-rustfmt-noeditionkey-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\n',
		);
		const filePath = path.join(tmpDir, "src", "main.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(filePath, tmpDir);

		expect(resolved).toBeNull();
	});

	it("resolves the workspace edition when the package's own manifest is ALSO the workspace root (F1)", async () => {
		// A non-virtual workspace root: `[package]` (with `edition.workspace =
		// true`) and `[workspace]`/`[workspace.package]` all in ONE Cargo.toml —
		// a documented, common Cargo shape. Pre-fix, the climb started at the
		// PARENT of the package dir and skipped straight over this exact file,
		// so this case resolved `null` (no `--edition`) even though the
		// workspace edition sat right there.
		const tmpDir = newTmpDir("pi-lens-rustfmt-rootws-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition.workspace = true\n\n' +
				'[workspace]\nmembers = ["."]\n\n' +
				'[workspace.package]\nedition = "2024"\n',
		);
		const filePath = path.join(tmpDir, "src", "main.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(filePath, tmpDir);

		expect(resolved).toEqual(["rustfmt", "--edition", "2024", filePath]);
	});

	it("resolves the workspace edition when the package's own [workspace] table is EMPTY and sits last in the file with no trailing newline (F1, review round 3)", async () => {
		// extractTomlTableSection returned "" both for "table absent" and
		// "table present but empty" (heading is the very last bytes of the
		// file, no trailing newline after it). resolveCargoPackageEdition's
		// own-manifest-is-also-workspace-root check used that same !== ""
		// sentinel, so this shape fell through to the (empty, isolated) tmp
		// dir's ancestor climb and resolved undefined instead of "2024".
		const tmpDir = newTmpDir("pi-lens-rustfmt-emptyws-eof-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			`[package]
name = "demo"
version = "0.1.0"
edition.workspace = true

[workspace.package]
edition = "2024"

[workspace]`,
		);
		const filePath = path.join(tmpDir, "src", "main.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fn main() {}");

		const resolved = await rustfmtFormatter.resolveCommand?.(filePath, tmpDir);

		expect(resolved).toEqual(["rustfmt", "--edition", "2024", filePath]);
	});

	it("climbs past an intermediate manifest with no [workspace] table to find the real workspace root (F1)", async () => {
		// wsRoot declares [workspace] + [workspace.package]. Between it and the
		// member sits ANOTHER Cargo.toml (a plain, unrelated [package] with no
		// [workspace] table) — Cargo's own rule is that the workspace root is
		// the nearest ancestor manifest that DECLARES [workspace], not merely
		// the nearest ancestor Cargo.toml. Pre-fix, the climb stopped at the
		// first ancestor Cargo.toml regardless, read an empty
		// [workspace.package] section from the intermediate manifest, and gave
		// up (`undefined`) without ever reaching wsRoot.
		const wsRoot = newTmpDir("pi-lens-rustfmt-intermediate-");
		fs.writeFileSync(
			path.join(wsRoot, "Cargo.toml"),
			'[workspace]\nmembers = ["group/crates/demo"]\n\n[workspace.package]\nedition = "2021"\n',
		);
		const groupDir = path.join(wsRoot, "group");
		fs.mkdirSync(groupDir, { recursive: true });
		fs.writeFileSync(
			path.join(groupDir, "Cargo.toml"),
			'[package]\nname = "group-anchor"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		const memberDir = path.join(groupDir, "crates", "demo");
		fs.mkdirSync(memberDir, { recursive: true });
		fs.writeFileSync(
			path.join(memberDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition.workspace = true\n',
		);
		const filePath = path.join(memberDir, "src", "lib.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "pub fn x() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(
			filePath,
			memberDir,
		);

		expect(resolved).toEqual(["rustfmt", "--edition", "2021", filePath]);
	});

	it("falls back to the static command when the manifest edition is not a rustfmt-supported value (F2)", async () => {
		// "2019" is four digits (would pass a bare /^\d{4}$/ check) but is not a
		// Rust/rustfmt edition — rustfmt's `--edition` is a closed enum
		// (2015/2018/2021/2024). Passing it through raw would make rustfmt
		// reject the flag and fail EVERY .rs format for this package, which is
		// strictly worse than the pre-#2466 bare command.
		const tmpDir = newTmpDir("pi-lens-rustfmt-badedition-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2019"\n',
		);
		const filePath = path.join(tmpDir, "src", "main.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(filePath, tmpDir);

		expect(resolved).toBeNull();
	});

	it("stops the ancestor climb at the injected HOME ceiling even when the real workspace root sits one level above it (F5)", async () => {
		// Mutation-proof HOME-ceiling fixture: the fixture tree puts the TRUE
		// workspace root ABOVE an injected `homeDir`, with the member package
		// BELOW it. If the `isAtOrAboveHomeDir` guard in the ancestor climb were
		// neutered (e.g. `if (false && ...)`), the climb would sail past the
		// injected home, find wsRoot's `[workspace.package] edition = "2018"`,
		// and this assertion would go red — proving the guard is load-bearing
		// without depending on the real OS home directory (which every other
		// fixture in this file already sits under, so it can never trigger the
		// ceiling on its own).
		const tmpDir = newTmpDir("pi-lens-rustfmt-homeceiling-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[workspace]\nmembers = ["home/project"]\n\n[workspace.package]\nedition = "2018"\n',
		);
		const homeDir = path.join(tmpDir, "home");
		const memberDir = path.join(homeDir, "project");
		fs.mkdirSync(memberDir, { recursive: true });
		fs.writeFileSync(
			path.join(memberDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition.workspace = true\n',
		);
		const filePath = path.join(memberDir, "src", "lib.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "pub fn x() {}\n");

		const resolved = await resolveCargoPackageEdition(filePath, homeDir);

		expect(resolved).toBeUndefined();
	});
});
