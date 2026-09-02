import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function directToolsAgentStartProbe(pi: ExtensionAPI): void {
  pi.on("agent_start", () => {
    console.log(`DIRECT_TOOLS_AT_AGENT_START=${JSON.stringify(pi.getAllTools().map(tool => tool.name).sort())}`);
  });
}
