import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// A minimal MCP server that advertises tools only — no `resources`, no
// `prompts`. Used by resources-capability.test.ts to check that the adapter
// skips resources/list instead of asking a server that cannot answer.
const server = new Server(
  { name: "tools-only-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler("tools/list", async () => ({
  tools: [{ name: "noop", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler("tools/call", async () => ({
  content: [{ type: "text", text: "ok" }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
