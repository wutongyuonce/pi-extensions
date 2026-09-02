// Real pi-backed session backend (spec ADR-6): wraps createAgentSession with
// per-conversation cwd and model binding. Lazy-imports the pi SDK so this
// module can be loaded without it (tests use the fake backend instead).
//
// 2026-08-08（spec 2026-08-08-1400 §3.3）：handle 增加 pi 原生命令能力
// （setModel/cycleModel/setThinkingLevel/compact/setSessionName/executeBash），
// backend 增加 listModels（ModelRegistry 全局模型列表）。

import { join } from "node:path";
import type {
	ModelInfo,
	PiSessionHandle,
	SessionBackend,
	SessionListItem,
} from "./conversation-manager.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

export class PiSessionBackend implements SessionBackend {
	private sdk: PiSdk | undefined;
	private modelRuntime: unknown;

	private async ensureSdk(): Promise<PiSdk> {
		if (this.sdk) return this.sdk;
		const sdk = await import("@earendil-works/pi-coding-agent");
		this.sdk = sdk;
		const agentDir = sdk.getAgentDir();
		this.modelRuntime = await sdk.ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		return sdk;
	}

	async createSession(opts: {
		cwd: string;
		modelId?: string;
		sessionFile?: string;
	}): Promise<PiSessionHandle> {
		const sdk = await this.ensureSdk();
		const agentDir = sdk.getAgentDir();
		const sessionManager = opts.sessionFile
			? sdk.SessionManager.open(opts.sessionFile, undefined, opts.cwd)
			: sdk.SessionManager.create(opts.cwd);
		const loader = new sdk.DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir,
			systemPromptOverride: (base: string | undefined) => {
				const extra =
					"You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
				return base?.trim() ? `${base}\n\n${extra}` : extra;
			},
		});
		await loader.reload();
		const modelRuntime = this.modelRuntime;
		const { session } = await sdk.createAgentSession({
			cwd: opts.cwd,
			agentDir,
			modelRuntime: this.modelRuntime as never,
			model: await this.resolveModel(sdk, opts.modelId),
			resourceLoader: loader,
			sessionManager,
		});
		const handle: PiSessionHandle = {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile ?? "",
			async prompt(text, images) {
				// 2026-08-08 修复：streaming 中调用必须传 streamingBehavior，否则
				// SDK 抛 "Agent is already processing"（群聊 open 策略下用户连发
				// 消息/FIFO 放行时上一回合 streaming 未结束）。followUp = 排队到
				// 当前回合结束后再处理，与桥的 FIFO 语义一致。
				await session.prompt(text, {
					...(images?.length ? { images } : {}),
					streamingBehavior: "followUp",
				});
			},
			subscribe(fn) {
				return session.subscribe(fn);
			},
			getLastAssistantText() {
				const messages = [...session.messages].reverse() as unknown as Array<{
					role?: string;
					content?: string | Array<{ type?: string; text?: string }>;
				}>;
				for (const msg of messages) {
					if (msg.role !== "assistant") continue;
					const content = msg.content;
					if (typeof content === "string") return content.trim();
					if (Array.isArray(content)) {
						return content
							.map((p) => (p && p.type === "text" ? (p.text ?? "") : ""))
							.join("")
							.trim();
					}
				}
				return "";
			},
			getModelLabel() {
				return session.model?.id ?? "default";
			},
			// ---- 2026-08-08 命令适配：pi 原生能力透传 ----
			async setModel(modelId) {
				const registry = new sdk.ModelRegistry(modelRuntime as never);
				await registry.refresh().catch(() => undefined);
				// 2026-08-08 修复：支持 "provider/id" 或纯 "id"；兜底必须选
				// 已认证模型（此前 find("configured"/"*") 匹配不到，getAll().find
				// 又可能命中未认证的同名模型如 zai/glm-4.7 auth=false）。
				const slash = modelId.indexOf("/");
				const provider = slash > 0 ? modelId.slice(0, slash) : undefined;
				const id = slash > 0 ? modelId.slice(slash + 1) : modelId;
				let found = provider ? registry.find(provider, id) : undefined;
				if (!found || !registry.hasConfiguredAuth(found)) {
					found = registry
						.getAll()
						.find((m) => m.id === id && registry.hasConfiguredAuth(m));
				}
				if (!found || !registry.hasConfiguredAuth(found)) return false;
				await session.setModel(found);
				return true;
			},
			async cycleModel() {
				const result = await session.cycleModel();
				return result?.model?.id;
			},
			async setThinkingLevel(level) {
				(session.setThinkingLevel as (l: string) => void)(level);
			},
			getThinkingLevel() {
				return session.thinkingLevel ?? "off";
			},
			getAvailableThinkingLevels() {
				return session.getAvailableThinkingLevels() as string[];
			},
			async compact(instructions) {
				const result = await session.compact(instructions);
				const brief = (
					typeof result?.summary === "string" ? result.summary : ""
				) as string;
				const tokens = (result as { tokens?: number } | undefined)?.tokens;
				return [
					brief ? `压缩摘要：${brief.slice(0, 200)}` : "会话已压缩",
					tokens ? `（约 ${tokens} tokens）` : "",
				].join("");
			},
			async setSessionName(name) {
				session.setSessionName(name);
			},
			getSessionSummary() {
				return {
					modelId: session.model?.id ?? "default",
					messageCount: session.messages.length,
					name: session.sessionName ?? undefined,
				};
			},
			async executeBash(command, onChunk) {
				let acc = "";
				const result = await session.executeBash(command, (chunk) => {
					acc += chunk;
					onChunk?.(chunk);
				});
				return result.output ?? acc;
			},
			async dispose() {
				try {
					session.dispose();
				} catch {
					/* ignore */
				}
			},
		};
		return handle;
	}

	async listSessions(cwd?: string): Promise<SessionListItem[]> {
		const sdk = await this.ensureSdk();
		const list = cwd
			? await sdk.SessionManager.list(cwd)
			: await sdk.SessionManager.listAll();
		return list.map(
			(s: {
				path: string;
				name?: string;
				firstMessage?: string;
				messageCount?: number;
				modified?: unknown;
				cwd?: string;
			}) => ({
				path: s.path,
				name: s.name,
				firstMessage: s.firstMessage,
				messageCount: s.messageCount ?? 0,
				modified: (s.modified as Date | string) ?? new Date(0),
				cwd: s.cwd,
			}),
		);
	}

	/**
	 * 2026-08-08（spec §3.3 /login API key 通道）：写入 provider 的 API key
	 * 到 pi auth.json（复用 ModelRuntime.setRuntimeApiKey 官方路径）。
	 */
	async setProviderApiKey(provider: string, apiKey: string): Promise<boolean> {
		await this.ensureSdk();
		const rt = this.modelRuntime as {
			setRuntimeApiKey?: (
				p: string,
				k: string,
				opts?: unknown,
			) => Promise<void>;
		};
		if (!rt.setRuntimeApiKey) return false;
		try {
			await rt.setRuntimeApiKey(provider, apiKey);
			return true;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const sdk = await this.ensureSdk();
		const registry = new sdk.ModelRegistry(this.modelRuntime as never);
		await registry.refresh().catch(() => undefined);
		// 2026-08-08 用户指令：只列已认证（有凭据）的模型——全量列表含未
		// 配置/未登录的模型，切换必失败。与 resolveModel/setModel 的
		// hasConfiguredAuth 检查保持一致。
		return registry
			.getAll()
			.filter((m) => registry.hasConfiguredAuth(m))
			.map(
				(m: {
					id: string;
					provider?: string;
					contextWindow?: number;
					reasoning?: boolean;
				}) => ({
					provider: (m.provider as string) ?? "configured",
					id: m.id as string,
					contextWindow: (m.contextWindow as number) ?? 0,
					reasoning: Boolean(m.reasoning),
				}),
			);
	}

	private async resolveModel(sdk: PiSdk, modelId: string | undefined) {
		const registry = new sdk.ModelRegistry(this.modelRuntime as never);
		await registry.refresh().catch(() => undefined);
		if (modelId) {
			const found =
				registry.find("configured", modelId) ??
				registry.find("*", modelId) ??
				registry.getAll().find((m: { id: string }) => m.id === modelId);
			if (found && registry.hasConfiguredAuth(found)) return found;
		}
		return undefined; // default: settings.json model
	}
}
