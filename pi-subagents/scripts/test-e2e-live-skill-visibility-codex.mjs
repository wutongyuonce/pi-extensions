#!/usr/bin/env node
// Live check: skill-visibility annotations in a child whose tool set replaces
// Pi's native tools (no `read`). The runtime corrects the structured skill
// list in place, so the codex dialect extension — which rebuilds its own
// skills block from that list and filters the manual flag itself — must
// inherit the annotations through its own render, and the prompt must stay
// clean (no core block leaked, no leftovers).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const liveModel = process.env.PI_SUBAGENT_LIVE_MODEL;
if (!liveModel) {
	throw new Error("Set PI_SUBAGENT_LIVE_MODEL=provider/model[:thinking] before running this live test.");
}

const piBin = process.env.PI_E2E_PI_BIN ?? "pi";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const sourceConfigDir = join(homedir(), ".pi", "agent");
const realSkillsDir = join(sourceConfigDir, "skills");
const codexExtensionSpec = "npm:@howaboua/pi-codex-conversion";
const realNpmDir = join(sourceConfigDir, "npm");
if (!existsSync(join(realNpmDir, "node_modules", "@howaboua", "pi-codex-conversion"))) {
	throw new Error("Missing installed codex extension under ~/.pi/agent/npm.");
}

const tmpRoot = join(tmpdir(), `pi-subagents-live-sv-codex-${process.pid}`);
const sessionDir = join(tmpRoot, "sessions");
// The codex package has native dependencies that break when pi re-resolves it
// under a foreign config root (temporary install, blocked postinstalls), so
// this test runs against the REAL config root with temporary agent files,
// following the repo's live-test convention. cleanup() removes them again.
const configDir = sourceConfigDir;
const agentsDir = join(configDir, "agents");
// The probe lives in the throwaway tmp root, never in the real config dir.
const extensionsDir = join(tmpRoot, "extensions");
const probeExtensionFile = join(extensionsDir, "live-e2e-sv-codex-probe.ts");
const snapshotsDir = join(tmpRoot, "snapshots");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
// Collision-safe names: the agent files live in the real config dir for one
// run and are removed in cleanup().
const AGENT_AUTO = `live-e2e-cx-auto-${process.pid}`;
const AGENT_MANUAL = `live-e2e-cx-manual-${process.pid}`;

const REAL_SKILLS = ["agent-browser", "safari-agent", "tdd"];
for (const name of REAL_SKILLS) {
	if (!existsSync(join(realSkillsDir, name, "SKILL.md"))) throw new Error(`Missing real skill: ${name}`);
}

const prompt = [
	"The subagent tool is available in this session.",
	"Use exactly this sequence.",
	"Do not reply before both tool calls have returned.",
	`Call subagent with name "cx-auto-child", agent "${AGENT_AUTO}", title "Codex auto check", task "Reply with exactly CX_AUTO_DONE and nothing else.", and async false.`,
	`Call subagent with name "cx-manual-child", agent "${AGENT_MANUAL}", title "Codex manual check", task "Reply with exactly CX_MANUAL_DONE and nothing else.", and async false.`,
	'After both tool calls return, reply with exactly "LIVE_E2E_SV_CODEX_OK" and nothing else.',
	"Do not call any other tools.",
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(extensionsDir, { recursive: true });
mkdirSync(snapshotsDir, { recursive: true });

// Listed after the codex extension, so this handler sees the final chained
// prompt once the dialect extension has rebuilt the skills section.
writeFileSync(
	probeExtensionFile,
	`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  let captured = false;
  pi.on("before_agent_start", (event) => {
    if (captured) return;
    captured = true;
    const outDir = process.env.PI_E2E_SV_CODEX_SNAPSHOT_DIR;
    const agent = process.env.PI_SUBAGENT_AGENT;
    if (!outDir || !agent) return;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, agent + ".txt"), event.systemPrompt ?? "", "utf8");
  });
}
`,
	"utf8",
);

const TEMP_AGENT_NAMES = [AGENT_AUTO, AGENT_MANUAL];

function writeAgent(name, skills) {
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: Live codex skill visibility probe agent.\nauto-exit: true\nmode: background\nasync: false\nspawning: false\ntools: exec_command, write_stdin\nextensions: ${codexExtensionSpec}, ${probeExtensionFile}\nskills: ${skills}\n---\n\nReply with your marker exactly.`,
		"utf8",
	);
}

const MARKER_AGENTS = [
	["CX_AUTO_DONE", AGENT_AUTO],
	["CX_MANUAL_DONE", AGENT_MANUAL],
];

function hashSkillFiles() {
	const hashes = {};
	for (const name of REAL_SKILLS) {
		hashes[name] = createHash("sha256").update(readFileSync(join(realSkillsDir, name, "SKILL.md"))).digest("hex");
	}
	return hashes;
}

const before = hashSkillFiles();

function listJsonlFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listJsonlFiles(fullPath));
		else if (entry.isFile() && fullPath.endsWith(".jsonl")) files.push(fullPath);
	}
	return files;
}

function parseJsonl(file) {
	const events = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			events.push(JSON.parse(line));
		} catch {}
	}
	return events;
}

function getUserText(events) {
	return events
		.filter((event) => event.type === "message" && event.message?.role === "user")
		.flatMap((event) => event.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function getAssistantTexts(events) {
	return events
		.filter((event) => event.type === "message" && event.message?.role === "assistant")
		.flatMap((event) => event.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim());
}

function readSnapshot(agentName) {
	const file = join(snapshotsDir, `${agentName}.txt`);
	if (!existsSync(file)) throw new Error(`Missing snapshot for ${agentName}: ${file}`);
	return readFileSync(file, "utf8");
}

function cleanup() {
	for (const name of TEMP_AGENT_NAMES) {
		rmSync(join(agentsDir, `${name}.md`), { force: true });
	}
	if (keepTmp) return;
	rmSync(tmpRoot, { recursive: true, force: true });
}

try {
	writeAgent(AGENT_AUTO, "agent-browser, safari-agent=auto");
	// tdd is the positive control: visible, unannotated, must stay listed —
	// without it an all-filtered leg passes vacuously.
	writeAgent(AGENT_MANUAL, "agent-browser=manual, safari-agent, tdd");
	const parentEnv = { ...process.env };
	for (const key of Object.keys(parentEnv)) {
		if (key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS" || key === "PI_ORCHESTRATOR_MODE") {
			delete parentEnv[key];
		}
	}
	execFileSync(
		piBin,
		[
			"-p",
			"--model",
			liveModel,
			// The e2e parent must only launch children: a model turn with write
			// tools in this cwd once edited repo source mid-test.
			"--tools",
			"subagent",
			"--no-extensions",
			"-e",
			extensionSource,
			"--session-dir",
			sessionDir,
			prompt,
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...parentEnv,
				PI_PACKAGE_DIR: "",
				PI_CODING_AGENT_DIR: configDir,
				PI_E2E_SV_CODEX_SNAPSHOT_DIR: snapshotsDir,
				PI_SUBAGENT_PI_COMMAND: piBin,
				PI_ARTIFACT_PROJECT_ROOT: "",
			},
		},
	);

	let parent = null;
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes("LIVE_E2E_SV_CODEX_OK")) parent = { file, events };
	}
	if (!parent) throw new Error("Could not find the parent session.");
	if (!getAssistantTexts(parent.events).includes("LIVE_E2E_SV_CODEX_OK")) {
		throw new Error("Parent did not produce LIVE_E2E_SV_CODEX_OK.");
	}
	for (const [marker, agent] of MARKER_AGENTS) {
		const found = listJsonlFiles(sessionDir).find((file) => {
			const events = parseJsonl(file);
			return getUserText(events).includes(marker) && !getUserText(events).includes("LIVE_E2E_SV_CODEX_OK");
		});
		if (!found) throw new Error(`Missing child session carrying ${marker} (${agent}).`);
		if (getAssistantTexts(parseJsonl(found)).length === 0) throw new Error(`${agent} never produced a turn.`);
	}

	// The dialect renders its own skills block from the structured skill
	// list; the runtime corrects that list in place, so the annotations must
	// flow through the dialect's own flag filter.
	const auto = readSnapshot(AGENT_AUTO);
	const manual = readSnapshot(AGENT_MANUAL);
	const checks = [
		[auto.includes("<skills_instructions>"), "cx-auto: codex skills block present"],
		[auto.includes("agent-browser:"), "cx-auto: visible skill listed"],
		[auto.includes("safari-agent:"), "cx-auto: =auto advertises the flagged skill through the dialect"],
		[!auto.includes("<available_skills>"), "cx-auto: no core skills block leaked"],
		[manual.includes("<skills_instructions>"), "cx-manual: codex skills block present"],
		[manual.includes("tdd:"), "cx-manual: positive control listed"],
		[!manual.includes("agent-browser:"), "cx-manual: =manual hides the skill through the dialect"],
		[!manual.includes("safari-agent:"), "cx-manual: flagged skill stays filtered"],
		[!manual.includes("<available_skills>"), "cx-manual: no core skills block leaked"],
	];
	for (const [ok, label] of checks) {
		if (!ok) throw new Error(`FAILED: ${label}`);
		console.log(`ok - ${label}`);
	}

	const after = hashSkillFiles();
	for (const name of REAL_SKILLS) {
		if (before[name] !== after[name]) throw new Error(`SKILL.md for ${name} was modified during the live test.`);
	}

	console.log("LIVE_E2E_SV_CODEX_OK");
} finally {
	cleanup();
}
