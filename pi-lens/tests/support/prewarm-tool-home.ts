// Global setup: seed a synthetic, network-free oxlint tool template once.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Under the installer's 24h probe-cache TTL so a handed-out cache is never
// already expired mid-run.
const TEMPLATE_STALE_MS = 20 * 60 * 60 * 1000;

export default function prewarmToolHome(): void {
	const repoRoot = process.cwd();
	let lockKey = "nolock";
	try {
		lockKey = createHash("sha256")
			.update(fs.readFileSync(path.join(repoRoot, "package-lock.json")))
			.digest("hex")
			.slice(0, 12);
	} catch {
		// keyless template still works; it just never invalidates on dep bumps
	}
	const template = path.join(os.tmpdir(), `pi-lens-test-tools-${lockKey}`);
	const probeCache = path.join(template, "probe-cache.json");

	try {
		if (Date.now() - fs.statSync(probeCache).mtimeMs < TEMPLATE_STALE_MS) {
			process.env.PI_LENS_TEST_TOOLS_TEMPLATE = template;
			return;
		}
	} catch {
		// no template yet — build one below
	}

	fs.mkdirSync(path.join(template, "bin"), { recursive: true });
	const shim = path.join(
		template,
		"bin",
		process.platform === "win32" ? "oxlint.cmd" : "oxlint",
	);
	fs.writeFileSync(
		shim,
		process.platform === "win32"
			? "@echo off\r\nexit /b 0\r\n"
			: "#!/bin/sh\nexit 0\n",
		{ mode: 0o750 },
	);
	const stat = fs.statSync(shim);
	fs.writeFileSync(
		probeCache,
		JSON.stringify(
			{
				oxlint: {
					path: shim,
					mtimeMs: stat.mtimeMs,
					cachedAt: Date.now(),
				},
			},
			null,
			2,
		),
	);
	process.env.PI_LENS_TEST_TOOLS_TEMPLATE = template;
}
