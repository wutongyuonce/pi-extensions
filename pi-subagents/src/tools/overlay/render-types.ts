import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export type Theme = {
	fg(tone: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
};

export type OverlayTui = TUI;

export type TabId = "running" | "completed" | "agents" | "orchestrator";

export interface TabDef {
	id: TabId;
	label: string;
}

export const TABS: TabDef[] = [
	{ id: "running", label: "Running" },
	{ id: "completed", label: "Completed" },
	{ id: "agents", label: "Agents" },
	{ id: "orchestrator", label: "Orchestrator" },
];

export interface OverlayItem {
	id: string;
	icon: string;
	iconColor: string;
	name: string;
	agent?: string;
	modelRef?: string;
	status?: string;
	statusColor?: string;
	stats: string[];
	activity: string;
	detailSections: DetailSection[];
	canKill: boolean;
	canResume: boolean;
	sessionFile?: string;
	onKill?: () => Promise<void>;
}

export interface DetailSection {
	title: string;
	fields: DetailField[];
}

export interface DetailField {
	label: string;
	value: string;
}

type ViewState =
	| { kind: "list" }
	| { kind: "detail"; item: OverlayItem; scroll: number }
	| { kind: "confirm"; item: OverlayItem; confirmed: boolean }
	| { kind: "editor"; itemIndex: number }
	| { kind: "orchestrator-confirm"; targetMode: boolean; confirmed: boolean };

export type OrchestratorActionId = "session-toggle" | "session-fresh" | "default-toggle";

interface OrchestratorOverlayState {
	selectedIndex: number;
	scroll: number;
	error?: string;
}

export interface OverlayState {
	activeTab: TabId;
	selectedIndex: number;
	view: ViewState;
	items: OverlayItem[];
	listScroll: Record<TabId, number>;
	loading: boolean;
	orchestrator: OrchestratorOverlayState;
}

export interface FooterHint {
	key: string;
	action: string;
}

export type OverlayContext = Pick<ExtensionContext, "ui" | "cwd" | "sessionManager">;
