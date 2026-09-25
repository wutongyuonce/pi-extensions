/**
 * Real-binary regression coverage for #1757 (IaC-misconfiguration lane).
 *
 * The mocked suite in trivy-config.test.ts proves the runner's plumbing
 * (parsing, gating, dedup). This file proves the runner actually WORKS
 * against a real `trivy` binary — the exact discipline #1736 established for
 * exit-code/empty-output semantics ("verified against the real binary, not
 * assumed"). Guarded: skips cleanly when trivy isn't on PATH (mirrors the
 * vulture/dead-code-client integration-test pattern), so CI without trivy
 * installed doesn't fail — it just doesn't cover this path.
 *
 * This test is RED on pre-fix trivy-config.ts: the runner passed `--no-progress`
 * to `trivy config`, a flag that subcommand does not accept (only `trivy fs`
 * does). Trivy 0.73.0 exits 1 on the rejected flag, but — unlike a clean
 * "spawn failed" — it prints its full usage/help text to STDOUT before the
 * FATAL line on stderr. That stdout is non-empty, so `spawnFailedWithNoOutput`
 * does NOT catch it; the runner falls through to `parseTrivyConfigOutput`,
 * fails to JSON-parse the help text, gets `[]`, and reports
 * `{ status: "succeeded", diagnostics: [] }` — a worse failure than "skipped"
 * would be, because it reads as "scanned, found nothing" when trivy never
 * scanned the file at all. This is exactly the #1736 "empty result must
 * distinguish clean from errored" discipline, and it was silently violated by
 * every real trivy-config invocation until this fix. Dropping the invalid
 * flag (keeping `--quiet`, which alone suppresses the progress bar)
 * eliminates the bad-flag path entirely.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeSpawn } from "../../../clients/safe-spawn.js";
import { makeRunnerCtx } from "../../support/runner-ctx.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
const TF_FIXTURE = path.join(
	REPO_ROOT,
	"tests/fixtures/dispatch/trivy-config-iac/main.tf",
);

function trivyAvailable(): boolean {
	const result = safeSpawn("trivy", ["--version"]);
	return result.status === 0 && !result.error;
}

describe("trivy-config runner (integration, real trivy binary)", () => {
	it.skipIf(!trivyAvailable())(
		"flags the seeded world-readable S3 bucket in main.tf",
		async () => {
			// Real opt-in gate: `.pi-lens.json` with trivy.enabled — the runner
			// reads this via the real (unmocked) isTrivyEnabled/loadPiLensProjectConfig.
			const cwd = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-trivy-config-real-"),
			);
			try {
				fs.writeFileSync(
					path.join(cwd, ".pi-lens.json"),
					JSON.stringify({ trivy: { enabled: true } }),
				);
				const filePath = path.join(cwd, "main.tf");
				fs.copyFileSync(TF_FIXTURE, filePath);

				const runner = (
					await import("../../../clients/dispatch/runners/trivy-config.js")
				).default;
				const ctx = makeRunnerCtx(filePath, cwd, { kind: "terraform" });
				const result = await runner.run(ctx);

				// Pre-fix: this was ALWAYS "skipped" (the invalid --no-progress
				// flag made every real trivy config invocation fail before it
				// scanned anything). Post-fix: real findings come back.
				expect(result.status).not.toBe("skipped");
				expect(result.diagnostics.length).toBeGreaterThan(0);
				expect(result.diagnostics.some((d) => d.rule?.startsWith("AWS-"))).toBe(
					true,
				);
				expect(result.diagnostics.every((d) => d.tool === "trivy-config")).toBe(
					true,
				);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
