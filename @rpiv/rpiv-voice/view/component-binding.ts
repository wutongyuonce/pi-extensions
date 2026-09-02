import type { BindingContext, GlobalSelector } from "../state/selectors/contract.js";
import type { VoiceState } from "../state/state.js";
import type { StatefulView } from "./stateful-view.js";

export interface ComponentBinding<P> {
	readonly component: StatefulView<P>;
	readonly select: GlobalSelector<P>;
	readonly predicate?: (state: VoiceState, ctx: BindingContext) => boolean;
}

export interface BoundGlobalBinding {
	apply(state: VoiceState, ctx: BindingContext): void;
	invalidate(): void;
}

export function globalBinding<P>(spec: ComponentBinding<P>): BoundGlobalBinding {
	return {
		apply: (state, ctx) => {
			if (spec.predicate && !spec.predicate(state, ctx)) return;
			spec.component.setProps(spec.select(state, ctx));
		},
		invalidate: () => spec.component.invalidate(),
	};
}
