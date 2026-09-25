import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type EditorTheme, Key, matchesKey } from "@earendil-works/pi-tui";
import type { OrchestratorController } from "../../runtime/orchestrator-controller.ts";
import { type ResumeServiceRuntime, resumeSubagentSession } from "../../runtime/resume-service.ts";
import { completedSubagentResults } from "../../runtime/state.ts";
import type { RunningSubagent, SubagentResult } from "../../types.ts";
import { buildAgentItems, buildCompletedItems, buildRunningItems } from "./data.ts";
import {
	getOrchestratorActions,
	getOrchestratorGuardMessage,
	keepOrchestratorSelectionVisible,
	renderOrchestrator,
	renderOrchestratorConfirmation,
} from "./orchestrator-view.ts";
import { getMaxScroll, renderDetail } from "./render-detail.ts";
import { getFooterHints, renderFooter, renderHeader } from "./render-frame.ts";
import { fitLine } from "./render-helpers.ts";
import { getItemRowCount, renderList } from "./render-list.ts";
import type { OverlayContext, OverlayItem, OverlayState, OverlayTui, Theme } from "./render-types.ts";
import { TABS } from "./render-types.ts";

export interface OverlayRuntime extends ResumeServiceRuntime {
	pi: ExtensionAPI;
	wireSubagentSteerBack: (pi: ExtensionAPI, r: RunningSubagent, p: Promise<SubagentResult>) => void;
	orchestrator?: OrchestratorController;
}

export type SubagentsOverlayResult = {
	kind: "fresh-session";
	targetMode: boolean;
} | null;

const FALLBACK_BODY_HEIGHT = 24;

export class SubagentsOverlayController implements Component {
	private completedLoadId = 0;
	private ctx: ExtensionContext;
	private done: (result: SubagentsOverlayResult) => void;
	private editor: Editor;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private runtime: OverlayRuntime;
	private theme: Theme;
	private tui: OverlayTui;
	private finished = false;
	private state: OverlayState = {
		activeTab: "running",
		selectedIndex: 0,
		view: { kind: "list" },
		items: [],
		listScroll: { running: 0, completed: 0, agents: 0, orchestrator: 0 },
		loading: false,
		orchestrator: { selectedIndex: 0, scroll: 0 },
	};

	constructor(
		done: (result: SubagentsOverlayResult) => void,
		ctx: ExtensionContext,
		theme: Theme,
		runtime: OverlayRuntime,
		tui: OverlayTui,
	) {
		this.done = done;
		this.ctx = ctx;
		this.theme = theme;
		this.runtime = runtime;
		this.tui = tui;
		this.editor = new Editor(tui, createEditorTheme(theme), { paddingX: 1 });
		this.editor.onSubmit = (text) => this.submitResume(text);
		runtime.startWidgetRefresh();
		this.refreshItems();
		this.refreshTimer = setInterval(() => {
			this.refreshItems();
			this.requestRender();
		}, 1000);
	}

	dispose(): void {
		this.stopRefreshTimer();
		if (this.finished) return;
		this.finished = true;
		this.done(null);
	}

	close(): void {
		this.finish(null);
	}

	private finish(result: SubagentsOverlayResult): void {
		if (this.finished) return;
		this.finished = true;
		this.stopRefreshTimer();
		this.done(result);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.alt("s"))) {
			this.close();
			return;
		}

		if (this.state.view.kind === "detail") this.handleDetailInput(data);
		else if (this.state.view.kind === "confirm") this.handleConfirmInput(data);
		else if (this.state.view.kind === "orchestrator-confirm") this.handleOrchestratorConfirmInput(data);
		else if (this.state.view.kind === "editor") this.handleEditorInput(data);
		else if (this.state.activeTab === "orchestrator") this.handleOrchestratorInput(data);
		else this.handleListInput(data);

		this.requestRender();
	}

	render(width: number): string[] {
		const lines = renderHeader(this.state, this.visibleTabs(), this.theme, width);
		const bodyHeight = this.bodyHeight(width);
		if (this.state.activeTab === "orchestrator") {
			const snapshot = this.getOrchestratorSnapshot();
			const orchestratorHeight = this.orchestratorBodyHeight(width);
			if (snapshot && this.state.view.kind === "orchestrator-confirm") {
				lines.push(
					...renderOrchestratorConfirmation(this.state.view.targetMode, this.state.view.confirmed, this.theme, width, orchestratorHeight),
				);
			} else if (snapshot) {
				this.state.orchestrator.scroll = keepOrchestratorSelectionVisible(
					snapshot,
					this.state.orchestrator.selectedIndex,
					this.state.orchestrator.scroll,
					width,
					orchestratorHeight,
					this.state.orchestrator.error,
				);
				lines.push(
					...renderOrchestrator(
						snapshot,
						this.state.orchestrator.selectedIndex,
						this.state.orchestrator.scroll,
						this.theme,
						width,
						orchestratorHeight,
						this.state.orchestrator.error,
					),
				);
			}
		} else if (this.state.view.kind === "detail") {
			lines.push(...renderDetail(this.state.view.item, this.state.view.scroll, this.theme, width, bodyHeight));
		} else if (this.state.view.kind === "confirm") {
			lines.push(...this.renderConfirmView(this.state.view.item, this.state.view.confirmed, width));
		} else if (this.state.view.kind === "orchestrator-confirm") {
			lines.push(...renderOrchestratorConfirmation(this.state.view.targetMode, this.state.view.confirmed, this.theme, width, bodyHeight));
		} else if (this.state.view.kind === "editor") {
			const item = this.state.items[this.state.view.itemIndex];
			if (item) lines.push(...this.renderEditorView(item, width));
		} else {
			lines.push(...renderList(this.state, this.theme, width, bodyHeight, this.state.listScroll[this.state.activeTab]));
		}
		lines.push(...renderFooter(getFooterHints(this.state), this.theme, width));
		return lines.map((line) => fitLine(line, width));
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.switchTab(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.switchTab(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}

		const item = this.selectedItem();
		if (!item) return;
		if (matchesKey(data, Key.enter) || matchesKey(data, "i")) {
			this.state.view = { kind: "detail", item, scroll: 0 };
			return;
		}
		if (matchesKey(data, "k") && item.canKill && item.onKill) {
			this.state.view = { kind: "confirm", item, confirmed: true };
			return;
		}
		if (matchesKey(data, "m") && item.canResume) {
			this.editor.setText("");
			this.state.view = { kind: "editor", itemIndex: this.state.selectedIndex };
		}
	}

	private handleOrchestratorInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.switchTab(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.switchTab(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveOrchestratorSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveOrchestratorSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter)) this.activateOrchestratorAction();
	}

	private handleOrchestratorConfirmInput(data: string): void {
		if (this.state.view.kind !== "orchestrator-confirm") return;
		if (matchesKey(data, Key.escape) || matchesKey(data, "n")) {
			this.state.view = { kind: "list" };
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
			this.state.view = { ...this.state.view, confirmed: false };
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || matchesKey(data, "y")) {
			this.state.view = { ...this.state.view, confirmed: true };
			return;
		}
		if (!matchesKey(data, Key.enter) || !this.state.view.confirmed) {
			if (matchesKey(data, Key.enter)) this.state.view = { kind: "list" };
			return;
		}

		const snapshot = this.getOrchestratorSnapshot();
		if (!snapshot) {
			this.state.view = { kind: "list" };
			this.state.orchestrator.error = "Orchestrator controls are unavailable in this session.";
			return;
		}
		if (snapshot.blockedReason) {
			this.state.view = { kind: "list" };
			this.state.orchestrator.error = getOrchestratorGuardMessage(snapshot);
			return;
		}

		const targetMode = this.state.view.targetMode;
		this.finish({ kind: "fresh-session", targetMode });
	}

	private handleDetailInput(data: string): void {
		if (this.state.view.kind !== "detail") return;
		if (matchesKey(data, Key.escape)) {
			this.state.view = { kind: "list" };
			return;
		}
		const item = this.state.view.item;
		const maxScroll = getMaxScroll(item, this.tui.terminal?.columns ?? 80, this.bodyHeight(this.tui.terminal?.columns ?? 80));
		if ((matchesKey(data, Key.down) || matchesKey(data, "j")) && this.state.view.scroll < maxScroll) {
			this.state.view = {
				...this.state.view,
				scroll: this.state.view.scroll + 1,
			};
		}
		if ((matchesKey(data, Key.up) || matchesKey(data, "k")) && this.state.view.scroll > 0) {
			this.state.view = {
				...this.state.view,
				scroll: this.state.view.scroll - 1,
			};
		}
	}

	private handleConfirmInput(data: string): void {
		if (this.state.view.kind !== "confirm") return;
		if (matchesKey(data, Key.escape) || matchesKey(data, "n")) {
			this.state.view = { kind: "list" };
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || matchesKey(data, "y")) {
			this.state.view = { ...this.state.view, confirmed: true };
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
			this.state.view = { ...this.state.view, confirmed: false };
			return;
		}
		if (!matchesKey(data, Key.enter)) return;

		const { item, confirmed } = this.state.view;
		this.state.view = { kind: "list" };
		if (!confirmed || !item.onKill) return;
		void item.onKill().finally(() => {
			this.refreshItems();
			this.requestRender();
		});
	}

	private handleEditorInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.state.view = { kind: "list" };
			return;
		}
		this.editor.disableSubmit = false;
		this.editor.handleInput(data);
	}

	private moveOrchestratorSelection(direction: -1 | 1): void {
		const snapshot = this.getOrchestratorSnapshot();
		if (!snapshot) return;
		const maxIndex = Math.max(0, getOrchestratorActions(snapshot).length - 1);
		this.state.orchestrator.selectedIndex = Math.max(0, Math.min(maxIndex, this.state.orchestrator.selectedIndex + direction));
		this.state.orchestrator.scroll = keepOrchestratorSelectionVisible(
			snapshot,
			this.state.orchestrator.selectedIndex,
			this.state.orchestrator.scroll,
			this.tui.terminal?.columns ?? 80,
			this.orchestratorBodyHeight(this.tui.terminal?.columns ?? 80),
			this.state.orchestrator.error,
		);
	}

	private activateOrchestratorAction(): void {
		const controller = this.runtime.orchestrator;
		const snapshot = this.getOrchestratorSnapshot();
		if (!controller || !snapshot) return;
		const action = getOrchestratorActions(snapshot)[this.state.orchestrator.selectedIndex];
		if (!action || action.disabled) return;

		if (action.id === "session-fresh") {
			this.state.view = {
				kind: "orchestrator-confirm",
				targetMode: action.targetMode === true,
				confirmed: false,
			};
			return;
		}

		const result =
			action.id === "session-toggle"
				? controller.setMode(action.targetMode === true, this.ctx)
				: controller.saveGlobalDefault(!snapshot.savedGlobalDefault, this.ctx);
		this.state.orchestrator.error = result.ok
			? undefined
			: (result.error ?? getOrchestratorGuardMessage(result.snapshot) ?? "The orchestrator setting was not changed.");
		this.state.orchestrator.scroll = keepOrchestratorSelectionVisible(
			result.snapshot,
			this.state.orchestrator.selectedIndex,
			this.state.orchestrator.scroll,
			this.tui.terminal?.columns ?? 80,
			this.orchestratorBodyHeight(this.tui.terminal?.columns ?? 80),
			this.state.orchestrator.error,
		);
	}

	private getOrchestratorSnapshot() {
		return this.runtime.orchestrator?.getSnapshot(this.ctx);
	}

	private renderConfirmView(item: OverlayItem, confirmed: boolean, width: number): string[] {
		const selected = (text: string, active: boolean) => (active ? this.theme.bg("selectedBg", ` ${text} `) : ` ${text} `);
		return [
			` ${this.theme.fg("warning", "Kill subagent?")}`,
			` Stop ${this.theme.bold(item.name)}?`,
			"",
			` ${selected("Yes", confirmed)}  ${selected("No", !confirmed)}`,
		].map((line) => fitLine(line, width));
	}

	private renderEditorView(item: OverlayItem, width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const editorLines = this.editor.render(innerWidth);
		const lines = [
			` ${this.theme.fg("accent", "▸")} Resume ${this.theme.bold(item.name)}`,
			`   ${this.theme.fg("muted", "Write a follow-up message. Enter sends, Esc cancels.")}`,
			"",
		];

		for (const line of editorLines) {
			lines.push(`  ${this.theme.bg("selectedBg", line)}`);
		}
		if (!this.editor.getText()) {
			lines.push(`  ${this.theme.fg("dim", "Message…")}`);
		}
		return lines.map((line) => fitLine(line, width));
	}

	private switchTab(direction: -1 | 1): void {
		const tabs = this.visibleTabs();
		const currentIndex = tabs.findIndex((tab) => tab.id === this.state.activeTab);
		const nextIndex = currentIndex + direction;
		if (currentIndex < 0 || nextIndex < 0 || nextIndex >= tabs.length) return;
		this.state.activeTab = tabs[nextIndex].id;
		this.state.selectedIndex = 0;
		this.state.view = { kind: "list" };
		this.refreshItems();
	}

	private visibleTabs() {
		const snapshot = this.getOrchestratorSnapshot();
		const tabs = TABS.filter((tab) => tab.id !== "orchestrator" || Boolean(snapshot && !snapshot.isChildSession));
		if (!snapshot || snapshot.isChildSession) return tabs;
		return tabs.map((tab) =>
			tab.id === "orchestrator"
				? { ...tab, label: `Orchestrator: ${snapshot.currentMode ? "On" : "Off"}` }
				: tab,
		);
	}

	private moveSelection(direction: -1 | 1): void {
		this.state.selectedIndex = Math.max(0, Math.min(this.state.items.length - 1, this.state.selectedIndex + direction));
		this.keepSelectionVisible();
	}

	private refreshItems(): void {
		if (this.state.activeTab === "orchestrator") {
			this.state.items = [];
			this.state.loading = false;
			return;
		}
		const overlayCtx: OverlayContext = {
			ui: this.ctx.ui,
			cwd: this.ctx.cwd,
			sessionManager: this.ctx.sessionManager,
		};

		if (this.state.activeTab === "running") {
			this.state.items = buildRunningItems(overlayCtx);
			this.state.loading = false;
			this.clampSelection();
			return;
		}
		if (this.state.activeTab === "agents") {
			this.state.items = buildAgentItems(overlayCtx);
			this.state.loading = false;
			this.clampSelection();
			return;
		}

		const loadId = ++this.completedLoadId;
		this.state.loading = this.state.items.length === 0;
		void buildCompletedItems(overlayCtx).then((items) => {
			if (loadId !== this.completedLoadId || this.state.activeTab !== "completed") return;
			this.state.items = items;
			this.state.loading = false;
			this.clampSelection();
			this.requestRender();
		});
	}

	private clampSelection(): void {
		this.state.selectedIndex = Math.max(0, Math.min(this.state.selectedIndex, this.state.items.length - 1));
		this.keepSelectionVisible();
	}

	private keepSelectionVisible(): void {
		const height = this.bodyHeight();
		const width = this.tui.terminal?.columns ?? 80;
		let start = 0;
		for (let i = 0; i < this.state.selectedIndex; i++) {
			start += getItemRowCount(this.state.items[i], this.state.activeTab, width);
		}
		const selectedHeight = this.state.items[this.state.selectedIndex]
			? getItemRowCount(this.state.items[this.state.selectedIndex], this.state.activeTab, width)
			: 1;
		const end = start + selectedHeight;
		const current = this.state.listScroll[this.state.activeTab] ?? 0;
		let next = current;
		if (start < current) next = start;
		else if (end > current + height) next = Math.max(0, end - height);
		this.state.listScroll = {
			...this.state.listScroll,
			[this.state.activeTab]: next,
		};
	}

	private bodyHeight(width = this.tui.terminal?.columns ?? 80): number {
		const rows = this.tui.terminal?.rows;
		if (!rows) return FALLBACK_BODY_HEIGHT;
		const footerHeight = renderFooter(getFooterHints(this.state), this.theme, width).length;
		return Math.max(1, Math.min(FALLBACK_BODY_HEIGHT, rows - 5 - footerHeight));
	}

	private orchestratorBodyHeight(width = this.tui.terminal?.columns ?? 80): number {
		const rows = this.tui.terminal?.rows;
		if (!rows) return FALLBACK_BODY_HEIGHT;
		const footerHeight = renderFooter(getFooterHints(this.state), this.theme, width).length;
		return Math.max(1, Math.min(FALLBACK_BODY_HEIGHT, rows - 5 - footerHeight));
	}

	private selectedItem(): OverlayItem | undefined {
		return this.state.items[this.state.selectedIndex];
	}

	private submitResume(rawText: string): void {
		if (!rawText.trim() || this.state.view.kind !== "editor") return;
		const item = this.state.items[this.state.view.itemIndex];
		this.state.view = { kind: "list" };
		if (!item?.sessionFile) {
			this.ctx.ui.notify("No session file.", "error");
			return;
		}
		void this.doResume(item, rawText);
	}

	private async doResume(item: OverlayItem, message: string): Promise<void> {
		try {
			const running = await resumeSubagentSession(
				{
					sessionFile: item.sessionFile!,
					task: message,
					name: item.name,
					agent: item.agent,
				},
				this.runtime,
			);
			if (running.completionPromise) {
				this.runtime.wireSubagentSteerBack(this.runtime.pi, running, running.completionPromise);
			}
			completedSubagentResults.delete(item.id);
			this.ctx.ui.notify(`Resumed ${item.name}.`, "info");
			this.refreshItems();
		} catch (err) {
			this.ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			this.requestRender();
		}
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private stopRefreshTimer(): void {
		if (!this.refreshTimer) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = null;
	}
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			description: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("warning", text),
			scrollInfo: (text) => theme.fg("dim", text),
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
		},
	};
}
