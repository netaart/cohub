import { normalizeBoardRemoteUrl } from "@cohub/protocol/board-document";
import type { TaskRunRecord } from "./types.js";

/** Tolerant readers for generation payloads, shared by every task projection. */

const EXCERPT_LIMIT = 240;

export function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function cleanExcerpt(
	value: unknown,
	limit = EXCERPT_LIMIT,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	return clean.length > limit
		? `${clean.slice(0, limit - 3).trimEnd()}...`
		: clean;
}

export function blockText(block: Record<string, unknown>): string | undefined {
	return cleanExcerpt(block.text ?? block.content ?? block.value);
}

export function blockUrl(block: Record<string, unknown>): string | undefined {
	const source = record(block.source);
	return normalizeBoardRemoteUrl(
		source?.url ?? source?.src ?? block.url ?? block.src,
	);
}

export function blockMimeType(block: Record<string, unknown>): string | undefined {
	const source = record(block.source);
	const value =
		source?.mediaType ??
		source?.media_type ??
		source?.mimeType ??
		block.mediaType ??
		block.media_type ??
		block.mimeType;
	return typeof value === "string" ? value : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

export function blockNaturalSize(block: Record<string, unknown>): {
	naturalWidth?: number;
	naturalHeight?: number;
} {
	const source = record(block.source);
	const naturalWidth = positiveNumber(
		source?.width ?? source?.naturalWidth ?? block.width ?? block.naturalWidth,
	);
	const naturalHeight = positiveNumber(
		source?.height ??
			source?.naturalHeight ??
			block.height ??
			block.naturalHeight,
	);
	return {
		...(naturalWidth ? { naturalWidth } : {}),
		...(naturalHeight ? { naturalHeight } : {}),
	};
}

export function contentBlocks(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? (value.filter((item) => record(item)) as Record<string, unknown>[])
		: [];
}

export function taskData(run: TaskRunRecord): Record<string, unknown> | null {
	const payload = record(run.payload);
	return record(payload?.data) ?? payload;
}

export function generationOutput(run: TaskRunRecord): Record<string, unknown>[] {
	return contentBlocks(record(run.result)?.output);
}

export function generationPrompt(run: TaskRunRecord): string | undefined {
	for (const block of contentBlocks(taskData(run)?.content)) {
		const text = blockText(block);
		if (text) return text;
	}
	return undefined;
}

export function blockMeta(block: Record<string, unknown>) {
	return record(block.meta);
}

export function blockIdentity(block: Record<string, unknown>): string | undefined {
	const meta = blockMeta(block);
	const value =
		meta?.id ??
		meta?.clip_id ??
		meta?.clipId ??
		block.id ??
		block.clip_id ??
		block.clipId;
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	return cleanExcerpt(String(value), 220);
}

export function blockTitle(block: Record<string, unknown>): string | undefined {
	const meta = blockMeta(block);
	return cleanExcerpt(meta?.title ?? block.title ?? block.name, 240);
}

export function blockDurationMs(block: Record<string, unknown>): number | undefined {
	const source = record(block.source);
	const meta = blockMeta(block);
	const milliseconds = positiveNumber(
		source?.durationMs ?? meta?.durationMs ?? block.durationMs,
	);
	if (milliseconds) return Math.round(milliseconds);
	const seconds = positiveNumber(
		source?.duration ?? meta?.duration ?? block.duration,
	);
	return seconds ? Math.round(seconds * 1000) : undefined;
}

export function blockPreviewUrl(block: Record<string, unknown>): string | undefined {
	const source = record(block.source);
	return normalizeBoardRemoteUrl(
		source?.poster ??
			source?.thumbnail ??
			source?.previewUrl ??
			block.poster ??
			block.thumbnail ??
			block.previewUrl,
	);
}
