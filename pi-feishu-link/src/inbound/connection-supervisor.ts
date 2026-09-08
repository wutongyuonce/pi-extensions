// Connection supervisor (R2 core).
//
// v1.1 semantics (spec §6.2): event silence beyond `silenceSuspectMs` triggers
// an UNCONDITIONAL transport rebuild — REST probe health does not clear a
// zombie WS (they are independent channels; this was the original "no reply"
// bug). Probe failures are diagnostic only (network down vs platform issue)
// and drive the `degraded` state. Rebuild uses exponential backoff with no
// upper retry limit; after 5+ consecutive failures a down-report is emitted
// (post-recovery). Recovery = first event arrives AND probe ok.

import type { ConnState } from "../common/types.js";

export interface SupervisorTransport {
	start(): Promise<void>;
	stop(): Promise<void>;
	probe(): Promise<{ ok: boolean; latencyMs: number }>;
	/** WS 是否已成功握手（2026-08-07 加固：autoReconnect:false 下由 supervisor 感知） */
	isConnected(): boolean;
}

import type { QuotaGovernor } from "../common/quota-governor.js";

export interface ConnectionSupervisorOptions {
	transport: SupervisorTransport;
	tickIntervalMs?: number;
	probeIntervalMs?: number;
	silenceSuspectMs?: number;
	/** 等待 WS 握手完成的时长（2026-08-07 加固） */
	wsHandshakeTimeoutMs?: number;
	reconnectBackoffBaseMs?: number;
	reconnectBackoffMaxMs?: number;
	downReportEnabled?: boolean;
	/** QuotaGovernor 熔断（1905 spec 创新点②）：连接失败计入预算，超额停手不再烧配额。 */
	governor?: QuotaGovernor;
	/** 熔断触发回调（retryAfterMs = 剩余等待）。 */
	onQuotaBlocked?: (retryAfterMs: number) => void;
	/** silence 重建冷却（2026-08-08 修复：防止 tick 每 15s 重复重建烧配额）。 */
	silenceRestartCooldownMs?: number;
	onStateChange?: (state: ConnState, detail?: string) => void;
	onRecovered?: (downMs: number) => void;
	onDownReport?: (downMs: number) => void;
	onProbeFail?: (failCount: number) => void;
	now?: () => number;
}

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_SILENCE_SUSPECT_MS = 1_200_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const DEFAULT_SILENCE_RESTART_COOLDOWN_MS = 300_000;
const PROBE_FAIL_THRESHOLD = 3;
const DOWN_REPORT_THRESHOLD_ATTEMPTS = 5;

export class ConnectionSupervisor {
	private readonly transport: SupervisorTransport;
	private readonly tickIntervalMs: number;
	private readonly probeIntervalMs: number;
	private readonly wsHandshakeTimeoutMs: number;
	private readonly silenceSuspectMs: number;
	private readonly silenceRestartCooldownMs: number;
	private readonly backoffBaseMs: number;
	private readonly backoffMaxMs: number;
	private readonly downReportEnabled: boolean;
	private readonly onStateChange?: (state: ConnState, detail?: string) => void;
	private readonly onRecovered?: (downMs: number) => void;
	private readonly onDownReport?: (downMs: number) => void;
	private readonly onProbeFail?: (failCount: number) => void;
	private readonly now: () => number;

	private state: ConnState = "disconnected";
	private lastEventAt = 0;
	private lastProbeAt = 0;
	private lastProbeOk = false;
	private lastProbeLatencyMs: number | undefined;
	private probeFailCount = 0;
	private connectAttempts = 0;
	/** 首次为 -Infinity：首个 silence 允许触发（冷却只防重复重建）。 */
	private lastSilenceRestartAt = -Infinity;
	private downSince: number | undefined;
	private readonly governor: QuotaGovernor | undefined;
	private readonly onQuotaBlocked: ((retryAfterMs: number) => void) | undefined;
	private downReported = false;
	private timer: NodeJS.Timeout | undefined;
	private stopped = true;

	constructor(options: ConnectionSupervisorOptions) {
		this.transport = options.transport;
		this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
		this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
		this.wsHandshakeTimeoutMs =
			options.wsHandshakeTimeoutMs ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
		this.silenceSuspectMs =
			options.silenceSuspectMs ?? DEFAULT_SILENCE_SUSPECT_MS;
		this.silenceRestartCooldownMs =
			options.silenceRestartCooldownMs ?? DEFAULT_SILENCE_RESTART_COOLDOWN_MS;
		this.backoffBaseMs =
			options.reconnectBackoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
		this.backoffMaxMs = options.reconnectBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.downReportEnabled = options.downReportEnabled ?? true;
		this.governor = options.governor;
		this.onQuotaBlocked = options.onQuotaBlocked;
		this.onStateChange = options.onStateChange;
		this.onRecovered = options.onRecovered;
		this.onDownReport = options.onDownReport;
		this.onProbeFail = options.onProbeFail;
		this.now = options.now ?? Date.now;
	}

	getState(): ConnState {
		return this.state;
	}

	/** Any inbound WS event (message, card action) proves liveness. */
	recordEvent(): void {
		this.lastEventAt = this.now();
		this.maybeRecover();
	}

	getDiagnostics() {
		return {
			state: this.state,
			lastEventAt: this.lastEventAt || undefined,
			lastProbeAt: this.lastProbeAt || undefined,
			lastProbeOk: this.lastProbeOk,
			lastProbeLatencyMs: this.lastProbeLatencyMs,
			probeFailCount: this.probeFailCount,
			connectAttempts: this.connectAttempts,
			downSince: this.downSince,
		};
	}

	async start(): Promise<void> {
		if (!this.timer) {
			this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
			this.timer.unref?.();
		}
		this.stopped = false;
		this.lastEventAt = this.now();
		await this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await this.transport.stop();
		this.setState("disconnected");
	}

	/** 配额熔断判定：熔断时置 degraded 并返回 true（入口门禁 + 失败后共用）。 */
	private quotaBlocked(): boolean {
		const verdict = this.governor?.canConnect();
		if (verdict && !verdict.allowed) {
			this.setState(
				"degraded",
				`配额熔断，${Math.ceil(verdict.retryAfterMs / 60_000)} 分钟后重试`,
			);
			this.onQuotaBlocked?.(verdict.retryAfterMs);
			return true;
		}
		return false;
	}

	/** Connect (or rebuild) the transport with backoff. */
	async connect(): Promise<void> {
		if (this.stopped) return;
		// 2026-08-08 修复：入口熔断门禁。之前熔断只在失败后记录，tick 的
		// silence_restart 仍每 15s 调 connect() 发起真实连接 → 单日烧穿 50 条
		// 连接配额（1000040350）。现在任何调用路径（含 tick 重建）先查预算。
		if (this.quotaBlocked()) return;
		this.setState("connecting");
		const started = this.now();
		try {
			await this.transport.stop(); // clean any half-open state
			await this.transport.start();
			// WS 握手等待（2026-08-07 加固：autoReconnect:false，SDK 不再内部无限
			// 重试）。连接被拒（如 exceed_conn_limit 配额封锁）时 isConnected 恒为
			// false → 走 catch → 受控退避重试，而不是 SDK 疯狂打点把配额锁得更久。
			// 握手等待是真实挂钟操作（测试里 fake clock 不前进，用 Date.now）
			const wsDeadline = Date.now() + this.wsHandshakeTimeoutMs;
			while (Date.now() < wsDeadline && !this.transport.isConnected()) {
				await new Promise((r) => setTimeout(r, 200));
			}
			if (!this.transport.isConnected()) {
				throw new Error("WS 握手未完成（可能连接配额受限）");
			}
			this.connectAttempts = 0;
			this.downReported = false;
			// 成功重建 = 新生命周期：刷新静默时钟，避免旧 lastEventAt 触发反复重建。
			this.lastEventAt = this.now();
			// 连接成功 = 配额恢复：清除熔断窗口。
			this.governor?.record(true);
			this.setState("connected");
			// Consider recovered when connected AND we had been down.
			this.maybeRecover();
		} catch {
			this.connectAttempts += 1;
			this.governor?.record(false);
			// QuotaGovernor 熔断（1905 spec 创新点②）：窗口内失败超额 → 停手，
			// 不再每 60s 重试顶住配额冷却窗口。剩余等待由 onQuotaBlocked 上报。
			if (this.quotaBlocked()) return;
			const delayMs = Math.min(
				this.backoffBaseMs * 2 ** (this.connectAttempts - 1),
				this.backoffMaxMs,
			);
			this.setState(
				"degraded",
				`connect failed (attempt ${this.connectAttempts})`,
			);
			if (
				this.downReportEnabled &&
				!this.downReported &&
				this.connectAttempts >= DOWN_REPORT_THRESHOLD_ATTEMPTS
			) {
				this.downReported = true;
				const downMs = this.now() - (this.downSince ?? started);
				this.onDownReport?.(downMs);
			}
			setTimeout(() => {
				if (!this.stopped) void this.connect();
			}, delayMs).unref?.();
		}
	}

	private maybeRecover(): void {
		if (this.downSince !== undefined) {
			const downMs = this.now() - this.downSince;
			this.downSince = undefined;
			this.onRecovered?.(downMs);
		}
	}

	async tick(now: number = this.now()): Promise<void> {
		if (this.stopped) return;
		if (this.state === "connecting" || this.state === "disconnected") {
			// A connect attempt is already in flight or pending.
			return;
		}
		if (
			this.state === "connected" ||
			this.state === "degraded" ||
			this.state === "restarting"
		) {
			// 1) Zombie WS detection: silence → unconditional rebuild.
			// 2026-08-07 加固：连接掉线（isConnected=false）立即重建，
			// 不等 20 分钟静默；初始连接失败由 connect() 的退避重试处理。
			if (!this.transport.isConnected()) {
				this.setState("restarting", "ws disconnected");
				if (this.downSince === undefined)
					this.downSince = this.lastEventAt || now;
				await this.connect();
				return;
			}
			if (now - this.lastEventAt > this.silenceSuspectMs) {
				// 2026-08-08 修复：静默≠僵尸。probe（REST 心跳）健康说明连接仍
				// 活着——空闲 20 分钟无事件完全正常（实测 03:28-03:48 被误判为
				// 断连并误报"连接恢复"）。仅当 probe 持续失败（网络真断）才重建。
				if (this.lastProbeOk) {
					this.lastEventAt = now; // 重置静默时钟，不打扰连接
					return;
				}
				// 冷却：silence 重建不密集触发（2026-08-08 修复——之前每 15s tick
				// 都重建，连接被拒时重复打点把配额锁得更久）。
				if (now - this.lastSilenceRestartAt < this.silenceRestartCooldownMs) {
					return;
				}
				this.lastSilenceRestartAt = now;
				// 2026-08-07 诊断：打印触发静默重建时的实际数值
				console.log(
					`[supervisor] silence_restart now=${now} lastEventAt=${this.lastEventAt} silenceSuspectMs=${this.silenceSuspectMs} gap=${now - this.lastEventAt}`,
				);
				this.setState("restarting", "event silence exceeded threshold");
				if (this.downSince === undefined)
					this.downSince = this.lastEventAt || now;
				await this.connect();
				return;
			}
			// 2) Periodic probe (diagnostic channel).
			if (now - this.lastProbeAt >= this.probeIntervalMs) {
				this.lastProbeAt = now;
				try {
					const res = await this.transport.probe();
					this.lastProbeOk = res.ok;
					this.lastProbeLatencyMs = res.latencyMs;
					if (res.ok) {
						if (this.probeFailCount >= PROBE_FAIL_THRESHOLD) {
							this.setState("connected", "probe recovered");
						}
						this.probeFailCount = 0;
						this.maybeRecover();
					} else {
						this.probeFailCount += 1;
						this.onProbeFail?.(this.probeFailCount);
						if (this.probeFailCount >= PROBE_FAIL_THRESHOLD) {
							this.setState(
								"degraded",
								`probe failed ${this.probeFailCount} times`,
							);
						}
					}
				} catch {
					this.probeFailCount += 1;
					this.onProbeFail?.(this.probeFailCount);
					if (this.probeFailCount >= PROBE_FAIL_THRESHOLD) {
						this.setState("degraded", "probe threw");
					}
				}
			}
		}
	}

	private setState(state: ConnState, detail?: string): void {
		if (this.state === state) return;
		this.state = state;
		this.onStateChange?.(state, detail);
	}
}
