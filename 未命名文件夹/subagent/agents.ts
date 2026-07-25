/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type PlanModePolicy = "auto" | "explicit" | "deny";

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "bash", "questionnaire"]);

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	planMode: PlanModePolicy;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function normalizePlanModePolicy(value: string | undefined, tools: string[] | undefined): PlanModePolicy {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "auto" || normalized === "explicit" || normalized === "deny") return normalized;
	if (tools && tools.length > 0 && tools.every((tool) => READ_ONLY_TOOL_NAMES.has(tool.toLowerCase()))) return "auto";
	return "explicit";
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		const name = frontmatter.name || path.basename(entry.name, ".md");
		if (!name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const normalizedTools = tools && tools.length > 0 ? tools : undefined;

		agents.push({
			name,
			description: frontmatter.description,
			tools: normalizedTools,
			model: frontmatter.model,
			planMode: normalizePlanModePolicy(frontmatter.planMode, normalizedTools),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function getExtensionAgentsDir(): string | null {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
	return isDirectory(dir) ? dir : null;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	void cwd;
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = getExtensionAgentsDir();

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name.toLowerCase(), agent);
		for (const agent of projectAgents) agentMap.set(agent.name.toLowerCase(), agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name.toLowerCase(), agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name.toLowerCase(), agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function findAgentByName(agents: AgentConfig[], name: string): AgentConfig | undefined {
	const normalized = name.trim().toLowerCase();
	return agents.find((agent) => agent.name.toLowerCase() === normalized);
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
