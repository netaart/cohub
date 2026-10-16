import { normalizeBoardRemoteUrl } from "../board-url.js";

/** Tolerant readers for generation payloads, shared by every task projection. */

export type GenerationRunPayload = { payload?: unknown; result?: unknown };

const EXCERPT_LIMIT = 240;

export function asRecord(value: unknown): Record<string, unknown> | null {
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
	const source = asRecord(block.source);
	return normalizeBoardRemoteUrl(
		source?.url ?? source?.src ?? block.url ?? block.src,
	);
}

export function blockMimeType(block: Record<string, unknown>): string | undefined {
	const source = asRecord(block.source);
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
	const source = asRecord(block.source);
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
		? (value.filter((item) => asRecord(item)) as Record<string, unknown>[])
		: [];
}

export function taskData(run: GenerationRunPayload): Record<string, unknown> | null {
	const payload = asRecord(run.payload);
	return asRecord(payload?.data) ?? payload;
}

export function generationOutput(run: GenerationRunPayload): Record<string, unknown>[] {
	return contentBlocks(asRecord(run.result)?.output);
}

export function generationPrompt(run: GenerationRunPayload): string | undefined {
	for (const block of contentBlocks(taskData(run)?.content)) {
		const text = blockText(block);
		if (text) return text;
	}
	return undefined;
}

export function blockMeta(block: Record<string, unknown>) {
	return asRecord(block.meta);
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
	const source = asRecord(block.source);
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
	const source = asRecord(block.source);
	return normalizeBoardRemoteUrl(
		source?.poster ??
			source?.thumbnail ??
			source?.previewUrl ??
			block.poster ??
			block.thumbnail ??
			block.previewUrl,
	);
}

/** A 3D file's format: what the provider declares, else the URL's extension. */
export function blockFormat(block: Record<string, unknown>): string | undefined {
	const declared = blockMeta(block)?.format;
	if (typeof declared === "string" && /^[a-z0-9]{1,16}$/i.test(declared)) return declared.toLowerCase();
	const url = blockUrl(block);
	const name = url ? (new URL(url).pathname.split("/").pop() ?? "") : "";
	const extension = /\.([a-z0-9]{1,16})$/i.exec(name)?.[1];
	return extension?.toLowerCase();
}

function blockTaskId(block: Record<string, unknown>): string | undefined {
	const value = blockMeta(block)?.task_id;
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Image roles that depict other media, by the media types they may cover;
 * `last_frame` stays a result of its own.
 */
const COVER_ROLES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["first_frame", new Set(["video"])],
	["cover", new Set(["video", "audio", "3d"])],
	["poster", new Set(["video", "audio", "3d"])],
	["thumbnail", new Set(["video", "audio", "3d"])],
]);

function isDepicted(block: Record<string, unknown>) {
	return block.type === "video" || block.type === "audio" || block.type === "3d";
}

/**
 * Whether an image comes from the same provider result as `media`: playable
 * media share the provider id (music tracks and their art); 3D files share the
 * provider task, whose first image is the model's still.
 */
function sharesSource(media: Record<string, unknown>, image: Record<string, unknown>) {
	const key = media.type === "3d" ? blockTaskId : blockIdentity;
	const value = key(media);
	return value !== undefined && key(image) === value;
}

/**
 * Pair media with its cover image, returning media index → cover index. An
 * image from the same provider result wins, shared by every media of that
 * result; otherwise cover-role images pair in order with remaining media their
 * role fits (a video and its `first_frame`). Covers need a remote URL, so an
 * inline image is never folded away.
 */
export function generationCovers(
	blocks: readonly Record<string, unknown>[],
): Map<number, number> {
	const covers = new Map<number, number>();
	// A `last_frame` is a result even when it shares the media's provider id.
	const isCover = (block: Record<string, unknown>) =>
		block.type === "image" &&
		blockUrl(block) !== undefined &&
		blockMeta(block)?.role !== "last_frame";

	blocks.forEach((block, index) => {
		if (!isDepicted(block)) return;
		const cover = blocks.findIndex(
			(candidate) => isCover(candidate) && sharesSource(block, candidate),
		);
		if (cover >= 0) covers.set(index, cover);
	});

	const paired = new Set(covers.values());
	const roleCovers = blocks.flatMap((block, index) => {
		const role = blockMeta(block)?.role;
		const types = typeof role === "string" ? COVER_ROLES.get(role) : undefined;
		return isCover(block) && !paired.has(index) && types ? [{ index, types }] : [];
	});
	blocks.forEach((block, index) => {
		if (!isDepicted(block) || covers.has(index)) return;
		const at = roleCovers.findIndex(({ types }) => types.has(String(block.type)));
		const [cover] = at < 0 ? [] : roleCovers.splice(at, 1);
		if (cover) covers.set(index, cover.index);
	});
	return covers;
}
