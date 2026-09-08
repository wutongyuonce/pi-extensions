import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ConnRecord {
	ts: number;
	ok: boolean;
}

export interface QuotaGovernorOptions {
	/** 历史目录（落盘 conn-history.jsonl）。 */
	dir: string;
	/** 计数窗口（默认 60min）。 */
	windowMs?: number;
	/** 窗口内最大失败连接次数，超过即熔断（默认 12）。 */
	maxFailures?: number;
}

export interface QuotaVerdict {
	allowed: boolean;
	/** 熔断时：剩余等待毫秒数；允许时：0。 */
	retryAfterMs: number;
	/** 窗口内失败次数。 */
	failuresInWindow: number;
}

const HISTORY_FILE = "conn-history.jsonl";

/**
 * QuotaGovernor（spec 1905 §3 创新点②）：连接配额熔断预算。
 *
 * 背景：租户级连接速率限制（exceed_conn_limit / 1000040350）被连接风暴
 * 持续顶住，冷却窗口永远滑不过去。本组件把连接尝试历史落盘到
 * `conn-history.jsonl`，窗口内失败次数达到上限即熔断——daemon 不再
 * 每 60s 重试烧配额，而是停止并明确告诉用户等多久。
 *
 * 跨进程生效：历史文件在磁盘，新 daemon 启动时重读，防止"杀一个起一个"
 * 继续烧。成功连接会清除失败窗口（成功 = 配额恢复）。
 */
export class QuotaGovernor {
	private readonly dir: string;
	private readonly windowMs: number;
	private readonly maxFailures: number;
	private history: ConnRecord[] = [];

	constructor(opts: QuotaGovernorOptions) {
		this.dir = opts.dir;
		this.windowMs = opts.windowMs ?? 60 * 60_000;
		this.maxFailures = opts.maxFailures ?? 12;
		this.load();
	}

	/** 记录一次连接结果。ok=true 会清空失败窗口（配额已恢复）。 */
	record(ok: boolean, now: number = Date.now()): void {
		const entry: ConnRecord = { ts: now, ok };
		this.history.push(entry);
		this.history = this.prune(this.history, now);
		if (ok) {
			// 成功连接 = 配额恢复：丢弃所有失败记录，让窗口重新开始。
			this.history = this.history.filter((r) => r.ok);
		}
		this.persist();
	}

	/** 判定当前是否允许发起连接。 */
	canConnect(now: number = Date.now()): QuotaVerdict {
		const inWindow = this.prune(this.history, now);
		const failures = inWindow.filter((r) => !r.ok).length;
		if (failures < this.maxFailures) {
			return { allowed: true, retryAfterMs: 0, failuresInWindow: failures };
		}
		// 熔断：返回最早一次失败滑出窗口所需的时间。
		const oldestFailure = inWindow.find((r) => !r.ok);
		const retryAfterMs = oldestFailure
			? Math.max(0, oldestFailure.ts + this.windowMs - now + 1_000)
			: 0;
		return { allowed: false, retryAfterMs, failuresInWindow: failures };
	}

	/** 丢弃窗口外的记录。 */
	private prune(history: ConnRecord[], now: number): ConnRecord[] {
		const cutoff = now - this.windowMs;
		return history.filter((r) => r.ts >= cutoff);
	}

	private load(): void {
		const file = join(this.dir, HISTORY_FILE);
		if (!existsSync(file)) return;
		try {
			this.history = readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.map((l) => {
					try {
						return JSON.parse(l) as ConnRecord;
					} catch {
						return null;
					}
				})
				.filter((r): r is ConnRecord => r !== null);
		} catch {
			this.history = [];
		}
	}

	private persist(): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			appendFileSync(
				join(this.dir, HISTORY_FILE),
				this.history
					.slice(-1)
					.map((r) => JSON.stringify(r))
					.join("\n") + "\n",
			);
		} catch {
			// 落盘失败不影响运行（仅丢失熔断记忆）。
		}
	}
}
