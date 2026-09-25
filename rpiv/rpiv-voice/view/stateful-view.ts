import type { Component } from "@earendil-works/pi-tui";

export interface StatefulView<P> extends Component {
	setProps(props: P): void;
}

export type ActiveView = "dictation" | "settings";
