#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
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
const tmpRoot = join(tmpdir(), `pi-subagents-live-skill-visibility-${process.pid}`);
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const agentsDir = join(configDir, "agents");
const extensionsDir = join(configDir, "extensions");
const probeExtensionFile = join(extensionsDir, "live-e2e-skill-vis-probe.ts");
const snapshotsDir = join(tmpRoot, "snapshots");
// Real user skills, reused so the test runs against the same materialized
// `disable-model-invocation` flags a real child would see.
const sourceConfigDir = join(homedir(), ".pi", "agent");
const realSkillsDir = join(sourceConfigDir, "skills");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";

const REAL_SKILLS = ["context7", "tdd", "codebase-design"];
const prompt = [
	"The subagent tool is available in this session.",
	"Use exactly this sequence.",
	"Do not reply before all three tool calls have returned.",
	'Call subagent with name "sv-auto-child", agent "live-e2e-sv-auto", title "Skill visibility auto check", task "Reply with exactly SV_AUTO_DONE and nothing else.", and async false.',
	'Call subagent with name "sv-manual-child", agent "live-e2e-sv-manual", title "Skill visibility manual check", task "Reply with exactly SV_MANUAL_DONE and nothing else.", and async false.',
	'Call subagent with name "sv-plain-child", agent "live-e2e-sv-plain", title "Skill visibility baseline check", task "Reply with exactly SV_PLAIN_DONE and nothing else.", and async false.',
	'After all three tool calls return, reply with exactly "LIVE_E2E_SKILL_VISIBILITY_OK" and nothing else.',
	"Do not call any other tools.",
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
mkdirSync(extensionsDir, { recursive: true });
mkdirSync(snapshotsDir, { recursive: true });
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
	const source = join(sourceConfigDir, name);
	if (existsSync(source)) copyFileSync(source, join(configDir, name));
}
symlinkSync(realSkillsDir, join(configDir, "skills"), "dir");

for (const agent of REAL_SKILLS) {
	const skillFile = join(realSkillsDir, agent, "SKILL.md");
	if (!existsSync(skillFile)) throw new Error(`Missing real skill for this live test: ${skillFile}`);
}

function writeAgent(name, skills) {
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: Live skill visibility smoke test agent.\nauto-exit: true\nmode: background\nasync: false\nspawning: false\nextensions: ${probeExtensionFile}\nskills: ${skills}\n---\n\nReply with your marker exactly.`,
		"utf8",
	);
}

writeAgent("live-e2e-sv-auto", "context7=auto, tdd");
writeAgent("live-e2e-sv-manual", "tdd, codebase-design=manual");
writeAgent("live-e2e-sv-plain", "tdd, context7");

// The probe loads after the mandatory subagent-done extension, so its
// before_agent_start handler sees the prompt after the visibility rewrite.
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
    const outDir = process.env.PI_E2E_SKILL_VIS_SNAPSHOT_DIR;
    const agent = process.env.PI_SUBAGENT_AGENT;
    if (!outDir || !agent) return;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, agent + ".txt"), event.systemPrompt ?? "", "utf8");
  });
}
`,
	"utf8",
);

function hashSkillFiles() {
	const hashes = {};
	for (const name of REAL_SKILLS) {
		const file = join(realSkillsDir, name, "SKILL.md");
		hashes[name] = createHash("sha256").update(readFileSync(file)).digest("hex");
	}
	return hashes;
}

const skillHashesBefore = hashSkillFiles();

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

function getToolResults(events, toolName) {
	return events.filter(
		(event) => event.type === "message" && event.message?.role === "toolResult" && event.message.toolName === toolName,
	);
}

function getParentEvents() {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes("LIVE_E2E_SKILL_VISIBILITY_OK")) return { file, events };
	}
	return null;
}

function findChildSession(marker) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes("LIVE_E2E_SKILL_VISIBILITY_OK")) continue;
		if (!getUserText(events).includes(marker)) continue;
		return { file, events };
	}
	return null;
}

function readSnapshot(agentName) {
	const file = join(snapshotsDir, `${agentName}.txt`);
	if (!existsSync(file)) throw new Error(`Missing child system prompt snapshot for ${agentName}: ${file}`);
	return readFileSync(file, "utf8");
}

function assertSkill(prompt, name, advertised) {
	const present = prompt.includes(`<name>${name}</name>`);
	if (present !== advertised) {
		throw new Error(
			`Expected ${name} to be ${advertised ? "advertised in" : "hidden from"} the child prompt, but it was ${
				present ? "advertised" : "hidden"
			}.`,
		);
	}
}

function cleanup() {
	if (keepTmp) return;
	rmSync(tmpRoot, { recursive: true, force: true });
}

try {
	// The e2e parent must behave like a top-level pi even when this script is
	// run from inside a subagent: inherited spawn grants, timeouts, and
	// orchestrator flags would otherwise reshape the launch under test.
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
				PI_E2E_SKILL_VIS_SNAPSHOT_DIR: snapshotsDir,
				PI_SUBAGENT_AGENT: "",
				PI_SUBAGENT_NAME: "",
				PI_SUBAGENT_AUTO_EXIT: "",
				PI_SUBAGENT_EXTENSIONS: "",
				PI_DENY_TOOLS: "",
				PI_SUBAGENT_PI_COMMAND: piBin,
				PI_ARTIFACT_PROJECT_ROOT: "",
			},
		},
	);

	const parent = getParentEvents();
	if (!parent) throw new Error("Could not find parent session events.");
	if (!getAssistantTexts(parent.events).includes("LIVE_E2E_SKILL_VISIBILITY_OK")) {
		throw new Error("Parent did not produce LIVE_E2E_SKILL_VISIBILITY_OK.");
	}
	const childMarkers = {
		"sv-auto-child": "SV_AUTO_DONE",
		"sv-manual-child": "SV_MANUAL_DONE",
		"sv-plain-child": "SV_PLAIN_DONE",
	};
	for (const [child, marker] of Object.entries(childMarkers)) {
		const found = findChildSession(marker);
		if (!found) throw new Error(`Missing child session carrying task marker ${marker} (${child}).`);
		if (getAssistantTexts(found.events).length === 0) {
			throw new Error(`${child} never produced an assistant turn.`);
		}
	}

	assertSkill(readSnapshot("live-e2e-sv-auto"), "context7", true);
	assertSkill(readSnapshot("live-e2e-sv-auto"), "tdd", true);
	assertSkill(readSnapshot("live-e2e-sv-manual"), "tdd", true);
	assertSkill(readSnapshot("live-e2e-sv-manual"), "codebase-design", false);
	assertSkill(readSnapshot("live-e2e-sv-plain"), "tdd", true);
	assertSkill(readSnapshot("live-e2e-sv-plain"), "context7", false);

	const skillHashesAfter = hashSkillFiles();
	for (const name of REAL_SKILLS) {
		if (skillHashesBefore[name] !== skillHashesAfter[name]) {
			throw new Error(`SKILL.md for ${name} was modified during the live test.`);
		}
	}

	console.log("LIVE_E2E_SKILL_VISIBILITY_OK");
} finally {
	cleanup();
}
