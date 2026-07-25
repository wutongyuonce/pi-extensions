import {
	ArrowLeftIcon,
	ArrowRightIcon,
	ChevronDownIcon,
	Cross2Icon,
	ExclamationTriangleIcon,
	ImageIcon,
	InfoCircledIcon,
	ReloadIcon,
	TrashIcon,
	UploadIcon,
} from "@radix-ui/react-icons";
import {
	Badge,
	Box,
	Button,
	Callout,
	Card,
	Code,
	Flex,
	Heading,
	IconButton,
	Spinner,
	Text,
} from "@radix-ui/themes";
import { AlertDialog, Collapsible, Dialog } from "radix-ui";
import { useRef, useState } from "react";
import { imageDropClient } from "./client.js";
import {
	canMutate,
	draftPresentation,
	formatBytes,
	summarizeBatch,
	summarizeHistory,
	visibleItemNotes,
} from "./state.js";
import type {
	ConnectionFailure,
	ImageDropState,
	PublicBatchItem,
	PublicHistoryItem,
} from "./types.js";

export const ACCEPTED_IMAGES =
	"image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/heic,image/heif,image/avif,.bmp,.tif,.tiff,.heic,.heif,.avif";

export interface PreviewSelection {
	collection: "items" | "history";
	item: PublicBatchItem | PublicHistoryItem;
}

export function SessionHeader({ state }: { state?: ImageDropState }) {
	return (
		<header className="page-header">
			<Box className="session-identity">
				<Text as="p" className="eyebrow" color="jade" size="1" weight="bold">
					Pi local image staging
				</Text>
				<Heading as="h1" size="8">
					Image Drop
				</Heading>
				<Text as="p" className="session-label" color="gray" size="2">
					{state
						? state.sessionName
							? `${state.projectName} · ${state.sessionName}`
							: state.projectName
						: "Connecting to Pi…"}
				</Text>
			</Box>
			<Collapsible.Root className="session-details">
				<Collapsible.Trigger asChild>
					<Button color="gray" highContrast type="button" variant="ghost">
						<InfoCircledIcon /> Session details <ChevronDownIcon className="disclosure-icon" />
					</Button>
				</Collapsible.Trigger>
				<Collapsible.Content className="session-details-content">
					<Text as="div" color="gray" size="1" weight="bold">
						Working directory
					</Text>
					<Code id="cwd" size="1" variant="ghost">
						{state?.cwd ?? "—"}
					</Code>
				</Collapsible.Content>
			</Collapsible.Root>
		</header>
	);
}

export function LoadingState() {
	return (
		<Flex align="center" className="loading-state" gap="2" justify="center" role="status">
			<Spinner />
			<Text color="gray">Connecting to this Pi session…</Text>
		</Flex>
	);
}

export function DropZone({
	dragActive,
	mutable,
	onFiles,
}: {
	dragActive: boolean;
	mutable: boolean;
	onFiles: (files: FileList | null) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<section
			aria-disabled={!mutable}
			aria-labelledby="drop-title"
			className={`drop-zone ${dragActive ? "drag-active" : ""} ${mutable ? "" : "disabled"}`}
			id="drop-zone"
		>
			<div className="drop-copy">
				<ImageIcon aria-hidden="true" className="drop-icon" />
				<Box>
					<Heading as="h2" id="drop-title" size="5">
						Add images
					</Heading>
					<Text as="p" color="gray" size="2">
						Paste anywhere, drop files here, or choose images.
					</Text>
				</Box>
				<Button disabled={!mutable} onClick={() => inputRef.current?.click()} type="button">
					<UploadIcon /> Choose images
				</Button>
				<input
					accept={ACCEPTED_IMAGES}
					disabled={!mutable}
					hidden
					multiple
					onChange={(event) => {
						onFiles(event.target.files);
						event.target.value = "";
					}}
					ref={inputRef}
					type="file"
				/>
			</div>
		</section>
	);
}

export function DraftSection({
	error,
	highlightedId,
	onPreview,
	state,
}: {
	error: string;
	highlightedId?: string;
	onPreview: (selection: PreviewSelection, trigger: HTMLElement) => void;
	state: ImageDropState;
}) {
	const summary = summarizeBatch(state.batch);
	const presentation = draftPresentation(state.batch);
	const mutable = canMutate(state.batch);
	return (
		<section aria-labelledby="batch-title" className="batch draft">
			<div className="batch-toolbar">
				<Box>
					<Heading as="h2" id="batch-title" size="5">
						Ready for next message
					</Heading>
					{presentation.status && (
						<Text as="p" color="gray" id="status" size="2">
							{presentation.status}
						</Text>
					)}
					<Text as="p" className="next-step" id="next-step" role="status" size="2">
						{presentation.guidance}
					</Text>
				</Box>
				{summary.total > 0 && <ClearDraftDialog disabled={!mutable} />}
			</div>
			{error && (
				<Callout.Root color="red" id="error-banner" role="alert" size="1">
					<Callout.Icon>
						<ExclamationTriangleIcon />
					</Callout.Icon>
					<Callout.Text>{error}</Callout.Text>
				</Callout.Root>
			)}
			<DraftGrid
				highlightedId={highlightedId}
				mutable={mutable}
				onPreview={onPreview}
				state={state}
			/>
		</section>
	);
}

function DraftGrid({
	highlightedId,
	mutable,
	onPreview,
	state,
}: {
	highlightedId?: string;
	mutable: boolean;
	onPreview: (selection: PreviewSelection, trigger: HTMLElement) => void;
	state: ImageDropState;
}) {
	const [draggedId, setDraggedId] = useState("");
	if (state.batch.items.length === 0) return null;
	return (
		<ol aria-live="polite" className="image-grid" id="grid">
			{state.batch.items.map((item, index) => (
				<Card asChild key={item.id} size="1">
					<li
						aria-label={`${index + 1}. ${item.name}, ${item.status}`}
						className={`image-card status-${item.status} ${item.id === highlightedId ? "duplicate-highlight" : ""}`}
						draggable={mutable}
						onDragEnd={() => setDraggedId("")}
						onDragOver={(event) => {
							if (!mutable || !draggedId) return;
							event.preventDefault();
						}}
						onDragStart={() => setDraggedId(item.id)}
						onDrop={(event) => {
							event.preventDefault();
							if (draggedId) void imageDropClient.moveBefore(draggedId, item.id);
							setDraggedId("");
						}}
					>
						<DraftPreview item={item} onPreview={onPreview} revision={state.batch.revision} />
						<ImageDetails index={index} item={item} />
						<Flex className="card-actions" gap="1" wrap="wrap">
							<IconButton
								aria-label="Move backward"
								disabled={!mutable || index === 0}
								onClick={() => void imageDropClient.move(item.id, -1)}
								title="Move backward"
								type="button"
								variant="soft"
							>
								<ArrowLeftIcon />
							</IconButton>
							<IconButton
								aria-label="Move forward"
								disabled={!mutable || index === state.batch.items.length - 1}
								onClick={() => void imageDropClient.move(item.id, 1)}
								title="Move forward"
								type="button"
								variant="soft"
							>
								<ArrowRightIcon />
							</IconButton>
							{item.status === "error" && (
								<Button
									disabled={!mutable}
									onClick={() => void imageDropClient.retry(item.id)}
									type="button"
									variant="soft"
								>
									<ReloadIcon /> Retry
								</Button>
							)}
							<Button
								color="red"
								disabled={!mutable}
								onClick={() => void imageDropClient.remove(item.id)}
								type="button"
								variant="ghost"
							>
								<TrashIcon /> Delete
							</Button>
						</Flex>
					</li>
				</Card>
			))}
		</ol>
	);
}

function DraftPreview({
	item,
	onPreview,
	revision,
}: {
	item: PublicBatchItem;
	onPreview: (selection: PreviewSelection, trigger: HTMLElement) => void;
	revision: number;
}) {
	if (item.status !== "ready") {
		return (
			<div className="preview">
				<span aria-hidden="true" className="placeholder">
					{item.status === "error" ? "!" : "…"}
				</span>
			</div>
		);
	}
	return (
		<IconButton
			aria-label={`Enlarge preview of ${item.name}`}
			className="preview preview-button"
			data-id={item.id}
			onClick={(event) => onPreview({ collection: "items", item }, event.currentTarget)}
			type="button"
			variant="ghost"
		>
			<img
				alt={`Preview of ${item.name}`}
				loading="lazy"
				src={`/api/items/${item.id}/preview?revision=${revision}`}
			/>
		</IconButton>
	);
}

function ImageDetails({ index, item }: { index: number; item: PublicBatchItem }) {
	const dimensions = item.width && item.height ? ` · ${item.width}×${item.height}` : "";
	return (
		<Box className="card-body">
			<Heading as="h3" size="3" title={item.name}>
				{item.name}
			</Heading>
			<Flex align="center" gap="2" mt="1" wrap="wrap">
				<Text color="gray" size="1">
					{`${index + 1} · ${formatBytes(item.size)}${dimensions}`}
				</Text>
				<Badge color={item.status === "error" ? "red" : item.status === "ready" ? "jade" : "gray"}>
					{item.status}
				</Badge>
			</Flex>
			{item.sourceFormat && item.sourceFormat !== item.outputFormat && (
				<Text as="p" className="conversion" size="1" weight="bold">
					{`${item.sourceFormat.toUpperCase()} → ${item.outputFormat?.toUpperCase()}`}
				</Text>
			)}
			{visibleItemNotes(item.notes).map((note) => (
				<Text as="p" className="note" color="gray" key={note} size="1">
					{note}
				</Text>
			))}
			{item.error && (
				<Text as="p" className="item-error" color="red" size="1">
					{item.error}
				</Text>
			)}
		</Box>
	);
}

export function HistorySection({
	onPreview,
	state,
}: {
	onPreview: (selection: PreviewSelection, trigger: HTMLElement) => void;
	state: ImageDropState;
}) {
	const history = summarizeHistory(state.history);
	const mutable = canMutate(state.batch);
	return (
		<section aria-labelledby="history-title" className="history">
			<header className="history-toolbar">
				<Box className="history-summary">
					<Heading as="h2" id="history-title" size="4">
						Previously sent
					</Heading>
					<Text as="p" color="gray" id="history-status" role="status" size="2">
						{history.label}
					</Text>
					<Text as="p" className="history-note" color="gray" size="2">
						<span id="history-retention">{history.usage}</span>. Images here are not attached again
						unless you choose <strong>Add again</strong>. The oldest are removed at the configured
						memory limit, and all are cleared when this Pi session ends.
					</Text>
				</Box>
				{history.total > 0 && <ClearHistoryDialog />}
			</header>
			{history.total > 0 && (
				<ol aria-live="polite" className="image-grid" id="history-grid">
					{state.history.items.map((item, index) => (
						<Card asChild key={item.id} size="1">
							<li
								aria-label={`${index + 1}. ${item.name}, sent this session`}
								className="image-card history-card"
							>
								<IconButton
									aria-label={`Enlarge preview of ${item.name}`}
									className="preview preview-button"
									onClick={(event) =>
										onPreview({ collection: "history", item }, event.currentTarget)
									}
									type="button"
									variant="ghost"
								>
									<img
										alt={`Preview of sent ${item.name}`}
										loading="lazy"
										src={`/api/history/${item.id}/preview?revision=${state.batch.revision}`}
									/>
								</IconButton>
								<Box className="card-body">
									<Heading as="h3" size="3" title={item.name}>
										{item.name}
									</Heading>
									<Text as="p" color="gray" size="1">
										{`${index + 1} · ${formatBytes(item.size)} · ${item.width}×${item.height}`}
									</Text>
									{visibleItemNotes(item.notes).map((note) => (
										<Text as="p" color="gray" key={note} size="1">
											{note}
										</Text>
									))}
								</Box>
								<Flex className="card-actions" gap="1" wrap="wrap">
									<Button
										disabled={!mutable}
										onClick={() => void imageDropClient.restageHistory(item.id)}
										type="button"
										variant="soft"
									>
										<ImageIcon /> Add again
									</Button>
									<Button
										color="red"
										onClick={() => void imageDropClient.deleteHistory(item.id)}
										type="button"
										variant="ghost"
									>
										<TrashIcon /> Delete
									</Button>
								</Flex>
							</li>
						</Card>
					))}
				</ol>
			)}
		</section>
	);
}

function ClearDraftDialog({ disabled }: { disabled: boolean }) {
	return (
		<AlertDialog.Root>
			<AlertDialog.Trigger asChild>
				<Button color="red" disabled={disabled} type="button" variant="ghost">
					<TrashIcon /> Clear all
				</Button>
			</AlertDialog.Trigger>
			<AlertDialog.Portal>
				<AlertDialog.Overlay className="dialog-overlay" />
				<AlertDialog.Content className="dialog-content">
					<AlertDialog.Title asChild>
						<Heading as="h2" size="5">
							Clear every staged image?
						</Heading>
					</AlertDialog.Title>
					<AlertDialog.Description asChild>
						<Text as="p" color="gray" size="2">
							This removes the current batch from Pi memory.
						</Text>
					</AlertDialog.Description>
					<Flex gap="3" justify="end">
						<AlertDialog.Cancel asChild>
							<Button color="gray" type="button" variant="soft">
								Cancel
							</Button>
						</AlertDialog.Cancel>
						<AlertDialog.Action asChild>
							<Button color="red" onClick={() => void imageDropClient.clearAll()} type="button">
								<TrashIcon /> Clear all
							</Button>
						</AlertDialog.Action>
					</Flex>
				</AlertDialog.Content>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

function ClearHistoryDialog() {
	return (
		<AlertDialog.Root>
			<AlertDialog.Trigger asChild>
				<Button color="red" type="button" variant="ghost">
					<TrashIcon /> Clear history
				</Button>
			</AlertDialog.Trigger>
			<AlertDialog.Portal>
				<AlertDialog.Overlay className="dialog-overlay" />
				<AlertDialog.Content className="dialog-content">
					<AlertDialog.Title asChild>
						<Heading as="h2" size="5">
							Clear sent image history?
						</Heading>
					</AlertDialog.Title>
					<AlertDialog.Description asChild>
						<Text as="p" color="gray" size="2">
							This releases every retained image from this Pi session. Images already sent to Pi or
							a model provider are unaffected.
						</Text>
					</AlertDialog.Description>
					<Flex gap="3" justify="end">
						<AlertDialog.Cancel asChild>
							<Button color="gray" type="button" variant="soft">
								Cancel
							</Button>
						</AlertDialog.Cancel>
						<AlertDialog.Action asChild>
							<Button color="red" onClick={() => void imageDropClient.clearHistory()} type="button">
								<TrashIcon /> Clear history
							</Button>
						</AlertDialog.Action>
					</Flex>
				</AlertDialog.Content>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

export function ImagePreviewDialog({
	onOpenChange,
	open,
	revision,
	selection,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	revision: number;
	selection?: PreviewSelection;
}) {
	const item = selection?.item;
	return (
		<Dialog.Root onOpenChange={onOpenChange} open={open}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay preview-overlay" />
				<Dialog.Content className="preview-content">
					<Flex align="center" className="preview-header" justify="between">
						<Dialog.Title asChild>
							<Heading className="preview-title" size="3">
								{item?.name ?? "Image preview"}
							</Heading>
						</Dialog.Title>
						<Dialog.Close asChild>
							<IconButton
								aria-label="Close enlarged image"
								color="gray"
								type="button"
								variant="soft"
							>
								<Cross2Icon />
							</IconButton>
						</Dialog.Close>
					</Flex>
					{selection && item && (
						<Dialog.Close asChild>
							<button
								aria-label="Close enlarged image"
								className="image-preview-dismiss"
								type="button"
							>
								<img
									alt={`Enlarged preview of ${item.name}`}
									src={`/api/${selection.collection}/${item.id}/preview?revision=${revision}`}
								/>
							</button>
						</Dialog.Close>
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function PrivacyNotice() {
	return (
		<Text as="p" className="privacy" color="gray" size="2">
			Draft and previously sent images stay in this Pi process until removed, evicted at the
			retention limit, or the session ends. Sending a Pi message sends its staged images to your
			configured model provider; deleting local history does not retract images already sent.
		</Text>
	);
}

export function ConnectionBlocker({ failure }: { failure?: ConnectionFailure }) {
	return (
		<Dialog.Root open={Boolean(failure)}>
			<Dialog.Portal>
				<Dialog.Overlay className="connection-overlay" />
				<Dialog.Content
					className="connection-card"
					onEscapeKeyDown={(event) => event.preventDefault()}
					onPointerDownOutside={(event) => event.preventDefault()}
				>
					<Flex direction="column" gap="2">
						<Dialog.Title asChild>
							<Heading as="h2" size="5">
								{failure?.title ?? "Connection lost"}
							</Heading>
						</Dialog.Title>
						<Dialog.Description asChild>
							<Text color="gray">
								{failure?.message ?? "Run /image-drop in Pi for a new link."}
							</Text>
						</Dialog.Description>
					</Flex>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function MetadataNotice() {
	return (
		<Text as="p" className="collection-note" color="gray" size="2">
			Sensitive image metadata removed from processed images.
		</Text>
	);
}
