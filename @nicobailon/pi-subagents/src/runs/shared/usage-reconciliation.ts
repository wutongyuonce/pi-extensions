import type { Usage } from "../../shared/types.ts";

type UsageMessage = { role?: unknown; timestamp?: unknown; usage?: object };

const usageFields = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
type UsageField = typeof usageFields[number];

const aliases: Record<Exclude<UsageField, "cost">, readonly string[]> = {
	input: ["input", "inputTokens"],
	output: ["output", "outputTokens"],
	cacheRead: ["cacheRead", "cacheReadTokens"],
	cacheWrite: ["cacheWrite", "cacheWriteTokens"],
};

function validNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function fieldValue(usage: object | undefined, field: UsageField): number | undefined {
	if (!usage) return undefined;
	const values = usage as Record<string, unknown>;
	if (field === "cost") {
		const direct = validNumber(values.cost);
		if (direct !== undefined) return direct;
		const cost = values.cost;
		return cost && typeof cost === "object" && !Array.isArray(cost)
			? validNumber((cost as { total?: unknown }).total)
			: undefined;
	}
	for (const name of aliases[field]) {
		const value = validNumber(values[name]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function validTimestamp(message: UsageMessage): string | number | undefined {
	const value = message.timestamp;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

export function reconcileAttemptUsage(live: Usage, messages: readonly UsageMessage[], baseline: number): Usage {
	if (!Number.isInteger(baseline) || baseline < 0 || messages.length < baseline) return { ...live };

	const persisted: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const complete: Record<UsageField, boolean> = { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true };
	let previous: UsageMessage | undefined;
	for (let index = baseline; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "assistant") {
			const timestamp = validTimestamp(message);
			const duplicate = previous?.role === "assistant" && timestamp !== undefined && validTimestamp(previous) === timestamp;
			if (!duplicate) {
				persisted.turns++;
				for (const field of usageFields) {
					const value = fieldValue(message.usage, field);
					if (value === undefined) complete[field] = false;
					else persisted[field] += value;
				}
			}
		}
		previous = message;
	}
	if (persisted.turns === 0) return { ...live };

	const reconciled = { ...live, turns: persisted.turns };
	for (const field of usageFields) {
		if (complete[field] && Number.isFinite(persisted[field])) reconciled[field] = persisted[field];
	}
	return reconciled;
}
