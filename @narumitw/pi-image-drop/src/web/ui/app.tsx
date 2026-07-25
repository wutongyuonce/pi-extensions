import { Container, Link, Theme } from "@radix-ui/themes";
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { imageDropClient } from "./client.js";
import {
	ConnectionBlocker,
	DraftSection,
	DropZone,
	HistorySection,
	ImagePreviewDialog,
	LoadingState,
	MetadataNotice,
	type PreviewSelection,
	PrivacyNotice,
	SessionHeader,
} from "./components.js";
import { canMutate } from "./state.js";

function useAppearance(): "dark" | "light" {
	const query = "(prefers-color-scheme: dark)";
	const [appearance, setAppearance] = useState<"dark" | "light">(() =>
		window.matchMedia(query).matches ? "dark" : "light",
	);
	useEffect(() => {
		const media = window.matchMedia(query);
		const update = () => setAppearance(media.matches ? "dark" : "light");
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	return appearance;
}

function App() {
	const view = useSyncExternalStore(imageDropClient.subscribe, imageDropClient.getSnapshot);
	const appearance = useAppearance();
	const [dragActive, setDragActive] = useState(false);
	const [preview, setPreview] = useState<PreviewSelection>();
	const dragDepth = useRef(0);
	const previewReturnFocus = useRef<HTMLElement | undefined>(undefined);
	const state = view.state;

	useEffect(() => imageDropClient.start(), []);
	useEffect(() => {
		if (!state) return;
		document.title = `${state.projectName} · Pi Image Drop`;
	}, [state]);
	useEffect(() => {
		if (!view.focusTarget) return;
		requestAnimationFrame(() => {
			document
				.querySelector<HTMLElement>(`[data-id="${CSS.escape(view.focusTarget ?? "")}"]`)
				?.focus();
		});
	}, [view.focusTarget]);
	useEffect(() => {
		if (!preview || !state) return;
		const items = preview.collection === "items" ? state.batch.items : state.history.items;
		if (!items.some((item) => item.id === preview.item.id)) closePreview();
	});
	useEffect(() => {
		const paste = (event: ClipboardEvent) => {
			if (!state || !canMutate(state.batch)) return;
			const files = [...(event.clipboardData?.items ?? [])]
				.filter((item) => item.kind === "file")
				.map((item) => item.getAsFile())
				.filter((file): file is File => Boolean(file));
			if (files.length === 0) return;
			event.preventDefault();
			void imageDropClient.addFiles(files);
		};
		const dragEnter = (event: DragEvent) => {
			if (!state || !canMutate(state.batch) || !hasFiles(event)) return;
			event.preventDefault();
			dragDepth.current += 1;
			setDragActive(true);
		};
		const dragOver = (event: DragEvent) => {
			if (!state || !canMutate(state.batch) || !hasFiles(event)) return;
			event.preventDefault();
		};
		const dragLeave = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			dragDepth.current = Math.max(0, dragDepth.current - 1);
			if (dragDepth.current === 0) setDragActive(false);
		};
		const drop = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			dragDepth.current = 0;
			setDragActive(false);
			if (state && canMutate(state.batch)) {
				void imageDropClient.addFiles(event.dataTransfer?.files ?? null);
			}
		};
		document.addEventListener("paste", paste);
		document.addEventListener("dragenter", dragEnter);
		document.addEventListener("dragover", dragOver);
		document.addEventListener("dragleave", dragLeave);
		document.addEventListener("drop", drop);
		return () => {
			document.removeEventListener("paste", paste);
			document.removeEventListener("dragenter", dragEnter);
			document.removeEventListener("dragover", dragOver);
			document.removeEventListener("dragleave", dragLeave);
			document.removeEventListener("drop", drop);
		};
	}, [state]);

	function openPreview(selection: PreviewSelection, trigger: HTMLElement) {
		previewReturnFocus.current = trigger;
		setPreview(selection);
	}

	function closePreview() {
		setPreview(undefined);
		requestAnimationFrame(() => previewReturnFocus.current?.focus());
	}

	return (
		<Theme
			accentColor="jade"
			appearance={appearance}
			grayColor="slate"
			panelBackground="solid"
			radius="large"
			scaling="100%"
		>
			<Link className="skip-link" highContrast href="#drop-zone">
				Skip to image staging
			</Link>
			<Container className="page-shell" size="4">
				<SessionHeader state={state} />
				<main id="main-content">
					{state ? (
						<>
							<DropZone
								dragActive={dragActive}
								mutable={canMutate(state.batch)}
								onFiles={(files) => void imageDropClient.addFiles(files)}
							/>
							<MetadataNotice />
							<DraftSection
								error={view.error}
								highlightedId={view.highlightedId}
								onPreview={openPreview}
								state={state}
							/>
							<HistorySection onPreview={openPreview} state={state} />
							<PrivacyNotice />
						</>
					) : (
						<LoadingState />
					)}
				</main>
			</Container>
			<ImagePreviewDialog
				onOpenChange={(open) => !open && closePreview()}
				open={Boolean(preview)}
				revision={state?.batch.revision ?? 0}
				selection={preview}
			/>
			<ConnectionBlocker failure={view.connectionFailure} />
		</Theme>
	);
}

function hasFiles(event: DragEvent): boolean {
	return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

const root = document.querySelector("#root");
if (!root) throw new Error("Pi Image Drop root is unavailable.");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
