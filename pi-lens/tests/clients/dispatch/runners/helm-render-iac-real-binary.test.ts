/**
 * Real-binary regression coverage for #1757 (class sweep, F2).
 *
 * `helm-render.ts`'s rendered-manifest IaC pass (`runIacPass`) had the
 * IDENTICAL defect as `trivy-config.ts`: it passed `--no-progress` to
 * `trivy config`, a flag that subcommand rejects. Unlike `trivy-config.ts`,
 * this pass already checked `scan.status !== 0` unconditionally (not just
 * "nonzero exit AND empty output"), so it never silently misreported clean —
 * it correctly surfaced `iac-pass-failed` every time. But "every time" means
 * the rendered-manifest IaC pass has never actually scanned anything, ever.
 *
 * Guarded: skips cleanly when trivy isn't on PATH (mirrors the
 * vulture/dead-code-client and trivy-config-real-binary integration-test
 * pattern).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeSpawn } from "../../../../clients/safe-spawn.js";
import { runIacPass } from "../../../../clients/dispatch/runners/helm-render.js";

function trivyAvailable(): boolean {
	const result = safeSpawn("trivy", ["--version"]);
	return result.status === 0 && !result.error;
}

// A privileged container — trips trivy's built-in Kubernetes KSV/AVD checks
// (HIGH/CRITICAL severity) same shape as the seeded fixture trivy-config's
// real-binary test uses, but a rendered Kubernetes manifest rather than
// Terraform, matching what runIacPass actually scans (a rendered chart's
// output tree).
const PRIVILEGED_DEPLOYMENT = [
	"apiVersion: apps/v1",
	"kind: Deployment",
	"metadata:",
	"  name: web",
	"spec:",
	"  template:",
	"    spec:",
	"      containers:",
	"        - name: app",
	"          image: example/app:latest",
	"          securityContext:",
	"            privileged: true",
	"",
].join("\n");

describe("helm-render runIacPass (integration, real trivy binary, #1757)", () => {
	it.skipIf(!trivyAvailable())(
		"flags the seeded privileged container in a rendered manifest",
		async () => {
			const cwd = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-helm-iac-real-"),
			);
			const outputDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-helm-iac-out-"),
			);
			try {
				const renderedRelative = path.join(
					"pi-lens-render-fixture",
					"templates",
					"deployment.yaml",
				);
				const renderedPath = path.join(outputDir, renderedRelative);
				fs.mkdirSync(path.dirname(renderedPath), { recursive: true });
				fs.writeFileSync(renderedPath, PRIVILEGED_DEPLOYMENT);

				const chartRoot = path.join(cwd, "chart");
				fs.mkdirSync(chartRoot, { recursive: true });
				const sourcePath = path.join(chartRoot, "templates", "deployment.yaml");
				fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
				fs.writeFileSync(sourcePath, "# source template placeholder\n");

				const diagnostics = await runIacPass({
					chartRoot,
					cwd,
					outputDir,
					manifests: [
						{
							renderedPath,
							relativePath: renderedRelative,
							content: PRIVILEGED_DEPLOYMENT,
							sourcePath,
							sourceMapped: true,
						},
					],
				});

				// Pre-fix: this was ALWAYS `iac-pass-failed` (the invalid
				// --no-progress flag made every real trivy config invocation
				// exit 1 before it ever scanned a rendered manifest). Post-fix:
				// real findings come back instead.
				expect(diagnostics.some((d) => d.rule === "iac-pass-failed")).toBe(
					false,
				);
				expect(diagnostics.length).toBeGreaterThan(0);
				expect(
					diagnostics.some(
						(d) => d.rule?.startsWith("KSV") || d.rule?.startsWith("AVD"),
					),
				).toBe(true);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
				fs.rmSync(outputDir, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
