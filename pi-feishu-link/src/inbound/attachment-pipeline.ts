// Attachment pipeline (spec §6.3, M4): parses Feishu message content for
// attachment keys, downloads them through the transport with bounded limits,
// and classifies into prompt images / extractable text / unsupported voice.
// Pure orchestration with an injected downloader — fully unit-testable.

import type { FeishuInboundMessage } from "../common/types.js";

export interface DownloadedAttachment {
	bytes: Buffer;
	mimeType?: string;
	filename?: string;
}

export interface AttachmentDownloader {
	download(
		messageId: string,
		fileKey: string,
		type: "image" | "file",
		maxBytes?: number,
	): Promise<DownloadedAttachment>;
}

export interface PromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface AttachmentResult {
	images: PromptImage[];
	text: string;
	unsupported: string[];
}

export interface AttachmentLimits {
	maxAttachments: number;
	maxTotalBytes: number;
	maxImageBytes: number;
	maxTxtBytes: number;
	maxExtractedChars: number;
}

export const DEFAULT_LIMITS: AttachmentLimits = {
	maxAttachments: 4,
	maxTotalBytes: 30 * 1024 * 1024,
	maxImageBytes: 10 * 1024 * 1024,
	maxTxtBytes: 2 * 1024 * 1024,
	maxExtractedChars: 150_000,
};

/** Parse the attachment keys out of a Feishu message content payload. */
export function parseAttachmentKeys(
	msg: FeishuInboundMessage,
): Array<{ key: string; type: "image" | "file" }> {
	const out: Array<{ key: string; type: "image" | "file" }> = [];
	if (msg.msgType === "image") {
		const key = extractKey(msg.content, "image_key");
		if (key) out.push({ key, type: "image" });
		return out;
	}
	if (
		msg.msgType === "file" ||
		msg.msgType === "media" ||
		msg.msgType === "audio"
	) {
		const key = extractKey(msg.content, "file_key");
		if (key) out.push({ key, type: "file" });
		return out;
	}
	return out;
}

function extractKey(content: string, field: string): string | undefined {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const v = parsed[field];
		return typeof v === "string" && v.length > 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".jsonl",
	".yaml",
	".yml",
	".toml",
	".csv",
	".ts",
	".js",
	".tsx",
	".jsx",
	".py",
	".go",
	".rs",
	".java",
	".c",
	".h",
	".cpp",
	".sh",
	".zsh",
	".bash",
	".sql",
	".xml",
	".html",
	".css",
	".log",
]);

function mimeIsText(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	return (
		mimeType.startsWith("text/") ||
		mimeType.includes("json") ||
		mimeType.includes("javascript") ||
		mimeType.includes("yaml") ||
		mimeType.includes("xml") ||
		mimeType.includes("markdown")
	);
}

function extensionIsText(filename: string | undefined): boolean {
	if (!filename) return false;
	const lower = filename.toLowerCase();
	return TEXT_EXTENSIONS.has(lower.slice(lower.lastIndexOf(".")));
}

/** Run the pipeline for a message; returns what to attach to the prompt. */
export async function processAttachments(
	msg: FeishuInboundMessage,
	downloader: AttachmentDownloader,
	limits: AttachmentLimits = DEFAULT_LIMITS,
): Promise<AttachmentResult> {
	const keys = parseAttachmentKeys(msg);
	const result: AttachmentResult = { images: [], text: "", unsupported: [] };
	if (keys.length === 0) return result;
	if (keys.length > limits.maxAttachments) {
		result.unsupported.push(`附件数量超过上限（${limits.maxAttachments}）`);
		return result;
	}
	let totalBytes = 0;
	const textParts: string[] = [];
	for (const { key, type } of keys.slice(0, limits.maxAttachments)) {
		let dl: DownloadedAttachment;
		// I6: enforce the per-type cap DURING the download (the transport aborts
		// the stream as soon as it exceeds), not after a full unbounded fetch.
		const cap = type === "image" ? limits.maxImageBytes : limits.maxTxtBytes;
		try {
			dl = await downloader.download(msg.messageId, key, type, cap);
		} catch (err) {
			result.unsupported.push(
				`附件下载失败（${err instanceof Error ? err.message : String(err)}）`,
			);
			continue;
		}
		totalBytes += dl.bytes.length;
		if (totalBytes > limits.maxTotalBytes) {
			result.unsupported.push("附件总大小超过上限");
			break;
		}
		if (type === "image") {
			if (dl.bytes.length > limits.maxImageBytes) {
				result.unsupported.push("图片超过大小上限");
				continue;
			}
			result.images.push({
				type: "image",
				data: dl.bytes.toString("base64"),
				mimeType: dl.mimeType ?? "image/jpeg",
			});
			continue;
		}
		// file
		if (dl.bytes.length > limits.maxTxtBytes) {
			result.unsupported.push("文件超过文本提取大小上限");
			continue;
		}
		if (mimeIsText(dl.mimeType) || extensionIsText(dl.filename)) {
			const text = dl.bytes.toString("utf8");
			textParts.push(text.slice(0, limits.maxExtractedChars));
			if (text.length > limits.maxExtractedChars)
				result.unsupported.push("文本已截断");
		} else {
			result.unsupported.push(
				`文件类型暂不支持提取（${dl.mimeType ?? "unknown"}）`,
			);
		}
	}
	result.text = textParts.join("\n\n---\n\n");
	return result;
}

/** Human reply for voice messages (spec: 语音入站明确不支持). */
export function isVoiceMessage(msg: FeishuInboundMessage): boolean {
	return msg.msgType === "audio" || msg.msgType === "voice";
}
