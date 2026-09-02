/** Keep host-facing tool metadata valid at the final registration boundary. */
export type ToolDefinition = {
	name?: unknown;
	description?: unknown;
};

export function normalizeToolDefinition<T extends ToolDefinition>(tool: T): T {
	const name = typeof tool.name === "string" ? tool.name.trim() : "tool";
	const description =
		typeof tool.description === "string" && tool.description.trim().length > 0
			? tool.description
			: `Use the ${name} tool.`;
	return { ...tool, description } as T;
}
