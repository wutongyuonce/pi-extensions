// Permission bridge (spec §6.15, model v1.3): tool-call gating for headless
// sessions. Pure classifier is unit-testable; the bridge manages pending
// approvals, per-session memory, and timeout auto-deny.
//
// Model (user-directed, 2026-08-07):
//  - EVERYTHING is allowed by default (private AND group chats) — zero friction.
//  - Blacklist items (rm -rf /, curl|sh …) show an APPROVAL CARD instead of
//    being hard-blocked: admin approves → it runs; nobody approves in 5min →
//    auto-denied. The card carries a ⚠️ danger banner.
//  - `permissions.policy=strict` opts back into ask-for-everything (non-safe).
//  - Group approvals are never session-memorized (one approved call releases
//    only that call); only the owner/admin may approve (enforced upstream).

import type { PermissionsConfig } from "../common/types.js";

export type ToolDecision = "allow" | "ask";

export interface ClassifyInput {
	name: string;
	/** Stringified params for pattern checks (bash commands etc). */
	paramsText: string;
	policy: PermissionsConfig["policy"];
	autoApprove: string[];
	sessionAllowlist: string[];
}

/** Blacklist patterns for obviously destructive shell invocations. */
const BLACKLIST_PATTERNS: RegExp[] = [
	// Download-and-execute: curl/wget/… piped into a shell OR an interpreter
	// (curl|python is just as destructive as curl|sh).
	/\b(?:curl|wget|nc|ncat)\b[^|;\n]*\|\s*(?:sh|bash|zsh|python|python3|perl|ruby|node|php)\b/i,
	// Pipe local content into a shell OR an interpreter (content is executed).
	/\b(?:cat|echo|sh|bash|zsh)\b[^|;\n]*\|\s*(?:sh|bash|zsh|python|python3|perl|ruby|node|php)\b/i,
	// 2026-08-08（对抗性审查 S1）：下载命令（curl/wget/nc/ncat）经任意中间
	// 变换（base64/tar/openssl 等）管道到 shell/解释器结尾 = 下载即执行——
	// 拦截绕过。lookahead 限定含下载源，避免误报数据管道（node|python）。
	/^(?=.*\b(?:curl|wget|nc|ncat)\b).*\|\s*(?:sh|bash|zsh|python|python3|perl|ruby|node|php)\b[^|]*$/i,
	// sudo/doas rm -r -f targeting the root.
	/\b(?:sudo|doas)\s+rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+[^|;\n]*(\s|^)\/(?:\*|\s|$|\.|["'}\]])/i,
	// Raw device destruction.
	/\b(?:mkfs|fdisk|dd)\s+.*of=\/dev\//i,
	// World-writable root.
	/\bchmod\s+777\s+\//i,
];

/**
 * Detect `rm` with recursive+force flags deleting the filesystem root
 * (any flag spelling: -rf / -fr / -r -f / --recursive --force, target
 * `/`, `/*`, `/ *`, `/ .` …). Deliberately scoped to the root so
 * legitimate targeted deletes (e.g. `rm -rf /tmp/scratch`) still pass.
 */
export function dangerousRm(paramsText: string): boolean {
	const match = paramsText.match(/\brm\b([^|;\n]*)/i);
	if (!match) return false;
	const rest = match[1]!;
	const flags = rest.match(/-{1,2}[a-zA-Z]+/g) ?? [];
	const hasRecursive = flags.some(
		(f) => f === "-r" || f === "--recursive" || /^-.*r.*$/.test(f),
	);
	const hasForce = flags.some(
		(f) => f === "-f" || f === "--force" || /^-.*f.*$/.test(f),
	);
	if (!hasRecursive || !hasForce) return false;
	// Target is the root: / , /* , / * , / ., /.. (slash then non-path char).
	// Trailing quotes/braces tolerated — params often arrive JSON-wrapped.
	return (
		/(\s|^)\/(?:\*|\s|$|\.|["'}\]])/.test(rest) || /(\s|^)\/\s+\*/.test(rest)
	);
}

export function matchesBlacklist(paramsText: string): boolean {
	// sudo/doas prefixes don't change the underlying rm semantics.
	if (dangerousRm(paramsText.replace(/\b(?:sudo|doas)\s+/g, ""))) return true;
	return BLACKLIST_PATTERNS.some((re) => re.test(paramsText));
}

/**
 * Pure classifier (model v1.3):
 *  - safe tools (allowlist / session memory) → allow
 *  - blacklist → ask (approval card; NOT a hard block anymore)
 *  - policy=strict → ask for anything non-safe
 *  - everything else → allow by default (private AND group)
 */
export function classifyToolCall(input: ClassifyInput): ToolDecision {
	const safe =
		input.autoApprove.includes(input.name) ||
		input.sessionAllowlist.includes(input.name);
	if (safe) return "allow";
	if (matchesBlacklist(input.paramsText)) return "ask";
	if (input.policy === "strict") return "ask";
	return "allow";
}

export type ApprovalVerdict = "approved" | "denied" | "timeout";

export interface PendingApproval {
	id: string;
	key: string;
	toolName: string;
	paramsText: string;
	expiresAt: number;
	allowlistedOnApprove: boolean;
	/** True when this call matched the destructive blacklist (card shows ⚠️). */
	dangerous: boolean;
	resolve?: (v: ApprovalVerdict) => void;
	/** Resolves when this approval is approved/denied/timed out. */
	verdict?: Promise<ApprovalVerdict>;
}

export interface GateInput {
	key: string;
	toolName: string;
	paramsText: string;
	/** Still tracked: group approvals never grant session memory. */
	isGroup: boolean;
}

export interface GateResult {
	decision: ToolDecision;
	/** Set when decision === "ask"; resolves when approved/denied/timed out. */
	approvalId?: string;
	verdict?: Promise<ApprovalVerdict>;
}

export interface PermissionBridgeOptions {
	getConfig: () => PermissionsConfig;
	onAsk: (p: PendingApproval) => Promise<void>;
	onDenyTimeout?: (p: PendingApproval) => Promise<void>;
	onAudit?: (entry: {
		key: string;
		toolName: string;
		paramsText: string;
		decision: ToolDecision;
	}) => void;
	now?: () => number;
}

export class PermissionBridge {
	private readonly getConfig: () => PermissionsConfig;
	private readonly onAsk: (p: PendingApproval) => Promise<void>;
	private readonly onDenyTimeout?: (p: PendingApproval) => Promise<void>;
	private readonly onAudit?: (entry: {
		key: string;
		toolName: string;
		paramsText: string;
		decision: ToolDecision;
	}) => void;
	private readonly now: () => number;
	private readonly pending = new Map<string, PendingApproval>();
	private readonly sessionAllowlist = new Map<string, Set<string>>();
	private seq = 0;

	constructor(options: PermissionBridgeOptions) {
		this.getConfig = options.getConfig;
		this.onAsk = options.onAsk;
		this.onDenyTimeout = options.onDenyTimeout;
		this.onAudit = options.onAudit;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Evaluate a tool call. For "ask" this creates the pending approval AND
	 * returns an awaitable verdict — the tool_call handler blocks on it.
	 */
	async gate(input: GateInput): Promise<GateResult> {
		this.sweep(this.now());
		const cfg = this.getConfig();
		const allowlist = this.sessionAllowlist.get(input.key) ?? new Set<string>();
		const decision = classifyToolCall({
			name: input.toolName,
			paramsText: input.paramsText,
			policy: cfg.policy,
			autoApprove: cfg.autoApprove,
			sessionAllowlist: [...allowlist],
		});
		this.onAudit?.({
			key: input.key,
			toolName: input.toolName,
			paramsText: input.paramsText,
			decision,
		});
		if (decision !== "ask") return { decision };
		const p = this.createPending(input, cfg);
		void this.onAsk(p);
		// Best-effort real-timer backup; sweep() is the authoritative timeout.
		this.scheduleTimeout(p, cfg.approvalTimeoutMs);
		return { decision, approvalId: p.id, verdict: p.verdict };
	}

	/** Evaluate and return only the decision (legacy convenience wrapper). */
	async evaluate(
		input: Omit<GateInput, "toolName"> & { name: string },
	): Promise<ToolDecision> {
		const { decision } = await this.gate({
			key: input.key,
			toolName: input.name,
			paramsText: input.paramsText,
			isGroup: input.isGroup,
		});
		return decision;
	}

	/** Approve a pending approval (from a Feishu card action). */
	async approve(id: string): Promise<boolean> {
		const p = this.pending.get(id);
		if (!p) return false;
		if (this.now() > p.expiresAt) {
			this.pending.delete(id);
			p.resolve?.("timeout");
			return false;
		}
		if (p.allowlistedOnApprove) {
			const set = this.sessionAllowlist.get(p.key) ?? new Set<string>();
			set.add(p.toolName);
			this.sessionAllowlist.set(p.key, set);
		}
		this.pending.delete(id);
		p.resolve?.("approved");
		return true;
	}

	/** Deny a pending approval. */
	async deny(id: string): Promise<boolean> {
		const p = this.pending.get(id);
		if (!p) return false;
		this.pending.delete(id);
		p.resolve?.("denied");
		return true;
	}

	/** Clear per-session memory (e.g. on /new or /stop). */
	resetSessionMemory(key: string): void {
		this.sessionAllowlist.delete(key);
	}

	pendingCount(): number {
		return this.pending.size;
	}

	/** Expire pending approvals past their deadline (auto-deny). */
	sweep(now: number = this.now()): number {
		let expired = 0;
		for (const [id, p] of [...this.pending.entries()]) {
			if (now > p.expiresAt) {
				this.pending.delete(id);
				p.resolve?.("timeout");
				void this.onDenyTimeout?.(p);
				expired++;
			}
		}
		return expired;
	}

	pendingIds(): string[] {
		return [...this.pending.keys()];
	}

	getPending(id: string): PendingApproval | undefined {
		return this.pending.get(id);
	}

	private createPending(
		input: GateInput,
		cfg: PermissionsConfig,
	): PendingApproval {
		let resolve: ((v: ApprovalVerdict) => void) | undefined;
		const verdict = new Promise<ApprovalVerdict>((r) => {
			resolve = r;
		});
		const p: PendingApproval = {
			id: `ap-${this.now().toString(36)}-${(this.seq++).toString(36)}`,
			key: input.key,
			toolName: input.toolName,
			paramsText: input.paramsText,
			expiresAt: this.now() + cfg.approvalTimeoutMs,
			// Session memory is never granted in GROUPS — one approved call must
			// not silently allowlist the tool for the whole shared session.
			allowlistedOnApprove: cfg.sessionMemory && !input.isGroup,
			dangerous: matchesBlacklist(input.paramsText),
			resolve,
		};
		this.pending.set(p.id, p);
		p.verdict = verdict;
		return p;
	}

	private scheduleTimeout(p: PendingApproval, timeoutMs: number): void {
		setTimeout(() => {
			const current = this.pending.get(p.id);
			if (!current) return;
			this.pending.delete(p.id);
			current.resolve?.("timeout");
			void this.onDenyTimeout?.(p);
		}, timeoutMs).unref?.();
	}
}
