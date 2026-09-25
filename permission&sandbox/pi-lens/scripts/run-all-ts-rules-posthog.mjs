import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { queryLoader } from "../clients/tree-sitter-query-loader.js";
import { TreeSitterClient } from "../clients/tree-sitter-client.js";
import { execSync } from "node:child_process";

// #1728: this dev-only tool scans an EXTERNAL checkout (posthog), not
// pi-lens's own tree, so there is no repo-relative default to derive. It
// used to hardcode a single author's now-nonexistent posthog checkout path.
// Point it at a checkout via --posthog-dir or the POSTHOG_DIR env var.
const argDir = process.argv
	.slice(2)
	.find((_, i, arr) => arr[i - 1] === "--posthog-dir");
const POSTHOG = argDir ?? process.env.POSTHOG_DIR;
if (!POSTHOG) {
	console.error(
		"Usage: node scripts/run-all-ts-rules-posthog.mjs --posthog-dir <path> " +
			"(or set POSTHOG_DIR). Point it at a local posthog checkout.",
	);
	process.exit(1);
}
const TARGET_DIRS = ["posthog", "products", "ee"].map((sub) =>
	path.join(POSTHOG, sub),
);

const posthogPosix = POSTHOG.replace(/\\/g, "/");
const posthogPrefix = new RegExp(
	`^${posthogPosix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
);

const pyFiles = [];
for (const dir of TARGET_DIRS) {
	try {
		const found = execSync(
			`find "${dir.replace(/\\/g, "/")}" -name "*.py" -type f -not -path "*/node_modules/*" -not -path "*/.venv/*" -not -path "*/venv/*" -not -path "*/migrations/*"`,
			{ encoding: "utf-8" },
		)
			.trim()
			.split("\n")
			.filter(Boolean);
		pyFiles.push(...found);
	} catch {}
}

console.log(`Found ${pyFiles.length} Python files (including tests)`);

const client = new TreeSitterClient();
if (!client.isAvailable()) {
	console.log("Tree-sitter NOT AVAILABLE");
	process.exit(1);
}
await client.init();

const allQueriesByLang = await queryLoader.loadQueries();
const allQueries = Array.from(allQueriesByLang.values()).flat();
const pyQueries = allQueries.filter((q) => q.language === "python");
console.log(`Loaded ${pyQueries.length} Python rules`);

const findings = {};
for (const q of pyQueries) findings[q.id] = [];

const startTime = Date.now();
for (let i = 0; i < pyFiles.length; i++) {
	const file = pyFiles[i];
	if (i % 500 === 0)
		console.log(
			`  ${i}/${pyFiles.length} (${Math.round((Date.now() - startTime) / 1000)}s)...`,
		);
	for (const q of pyQueries) {
		try {
			const r = await client.runQueryOnFile(q, file, "python");
			for (const f of r) {
				findings[q.id].push({
					file: file.replace(posthogPrefix, ""),
					line: f.line,
					text: f.text?.slice(0, 120) ?? "",
				});
			}
		} catch {}
	}
}

console.log(
	`\nDone: ${pyFiles.length} files, ${Math.round((Date.now() - startTime) / 1000)}s\n`,
);
const sorted = Object.entries(findings).sort(
	(a, b) => b[1].length - a[1].length,
);
for (const [ruleId, ruleFindings] of sorted) {
	console.log(`${ruleFindings.length.toString().padStart(6)} ${ruleId}`);
	const fileCounts = {};
	for (const f of ruleFindings)
		fileCounts[f.file] = (fileCounts[f.file] ?? 0) + 1;
	const topFiles = Object.entries(fileCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2);
	for (const [file, count] of topFiles) {
		console.log(`  ${count.toString().padStart(5)} ${file}`);
	}
}

const outPath = path.join(os.tmpdir(), "all_ts_posthog.json");
fs.writeFileSync(outPath, JSON.stringify(findings, null, 2));
console.log(`Wrote findings to ${outPath}`);
