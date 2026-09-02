// Group message trigger policy — pure functions (fully unit-testable).
// open: reply to all messages in groups/topics (no mention needed).
// mention: reply only when the bot is mentioned.
// keywords / alsoOnReply extend the trigger set.

export type GroupPolicy = "open" | "mention";

export interface GroupDecisionInput {
	chatType: "p2p" | "group";
	groupPolicy: GroupPolicy;
	mentioned: boolean;
	text: string;
	keywords: string[];
	alsoOnReply: boolean;
	replyToBot: boolean;
}

export interface GroupDecision {
	accept: boolean;
	reason: "open" | "mention" | "keyword" | "reply" | "ignored";
}

/** Split a config string (comma/semicolon separated) into trimmed keywords. */
export function parseGroupKeywords(
	input: string | string[] | undefined,
): string[] {
	if (input === undefined) return [];
	if (Array.isArray(input)) {
		return input.map((s) => s.trim()).filter((s) => s.length > 0);
	}
	return input
		.split(/[,;，；]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Case-insensitive substring match after whitespace normalization. */
export function textMatchesKeywords(text: string, keywords: string[]): boolean {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized || keywords.length === 0) return false;
	const lower = normalized.toLowerCase();
	return keywords.some(
		(k) => k.trim().length > 0 && lower.includes(k.trim().toLowerCase()),
	);
}

/** Extract the plain trigger text from a Feishu message content payload. */
export function extractPlainTextForTrigger(
	msgType: string,
	content: string,
): string {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (msgType === "text") {
			return typeof parsed.text === "string" ? parsed.text : "";
		}
		if (msgType === "post") {
			const title = typeof parsed.title === "string" ? parsed.title : "";
			const parts: string[] = [];
			const contentArr = parsed.content;
			if (Array.isArray(contentArr)) {
				for (const line of contentArr) {
					if (Array.isArray(line)) {
						for (const seg of line) {
							if (
								typeof seg === "object" &&
								seg !== null &&
								typeof (seg as { text?: unknown }).text === "string"
							) {
								parts.push((seg as { text: string }).text);
							}
						}
					}
				}
			}
			return [title, ...parts].join("\n").trim();
		}
		return "";
	} catch {
		return "";
	}
}

/** Decide whether a group message triggers the bot. p2p always accepts. */
export function shouldAcceptGroupMessage(
	input: GroupDecisionInput,
): GroupDecision {
	if (input.chatType === "p2p") return { accept: true, reason: "open" };
	if (input.groupPolicy === "open") return { accept: true, reason: "open" };
	if (input.mentioned) return { accept: true, reason: "mention" };
	if (input.alsoOnReply && input.replyToBot)
		return { accept: true, reason: "reply" };
	if (textMatchesKeywords(input.text, input.keywords))
		return { accept: true, reason: "keyword" };
	return { accept: false, reason: "ignored" };
}
