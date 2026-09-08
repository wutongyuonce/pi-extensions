// Status store: aggregates a StatusSnapshot, keeps the last N state
// transitions, and persists to status.json for both TUI and Feishu-side
// /status to read the same source of truth (spec §9.7).

import { readJson, writeJson } from "./config.js";
import type { ConnState, StatusSnapshot } from "./types.js";

export interface StateTransition {
  from: string;
  to: string;
  ts: number;
  detail?: string;
}

const MAX_TRANSITIONS = 50;

export class StatusStore {
  private snapshot: StatusSnapshot;
  private transitions: StateTransition[] = [];
  private readonly now: () => number;

  constructor(private readonly filePath: string, now: () => number = Date.now) {
    this.now = now;
    this.snapshot = readJson<StatusSnapshot>(filePath, {
      connState: "disconnected",
      reconnectCount: 0,
      inboundCount: 0,
      outboundCount: 0,
      outboxPending: 0,
      outboxFailed: 0,
      residentSessions: 0,
      maxResident: 8,
      schedulerDetected: false,
      boundJobs: 0,
      startedAt: now(),
    });
  }

  get(): StatusSnapshot {
    return { ...this.snapshot };
  }

  update(partial: Partial<StatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.write();
  }

  setConnState(state: ConnState, detail?: string): void {
    const from = this.snapshot.connState;
    if (from === state) {
      this.update({ connState: state });
      return;
    }
    this.transitions.push({ from, to: state, ts: this.now(), detail });
    if (this.transitions.length > MAX_TRANSITIONS) this.transitions.shift();
    this.snapshot.connState = state;
    if (state === "connected" && this.snapshot.connectedAt === undefined) {
      this.snapshot.connectedAt = this.now();
    }
    this.write();
  }

  recordInbound(): void {
    this.update({ inboundCount: this.snapshot.inboundCount + 1 });
  }
  recordOutbound(): void {
    this.update({ outboundCount: this.snapshot.outboundCount + 1 });
  }
  recordReconnect(durationMs: number): void {
    this.update({
      reconnectCount: this.snapshot.reconnectCount + 1,
      lastReconnectAt: this.now(),
      lastReconnectDurationMs: durationMs,
    });
  }

  transitionsLog(): StateTransition[] {
    return [...this.transitions];
  }

  private write(): void {
    try {
      writeJson(this.filePath, { ...this.snapshot, stateTransitions: this.transitions });
    } catch {
      // status persistence is best-effort
    }
  }
}
