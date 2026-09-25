import {
	blockDurationMs,
	blockIdentity,
	blockMimeType,
	blockNaturalSize,
	blockPreviewUrl,
	blockText,
	blockTitle,
	blockUrl,
	contentBlocks,
	generationOutput,
	generationPrompt,
	record,
	taskData,
} from "./generation-blocks.js";
import type { TaskRunRecord } from "./types.js";

export type GenerationOutputType = "image" | "video" | "audio" | "text";

export type GenerationTaskOutput = {
	index: number;
	type: GenerationOutputType;
	/** Null for inline payloads; resolve with {@link generationOutputSource}. */
	url: string | null;
	previewUrl: string | null;
	title: string | null;
	mimeType: string | null;
	text: string | null;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	/** The list response stripped the inline payload; fetch the run detail. */
	deferred: boolean;
};

export type GenerationTaskView = {
	id: string;
	status: TaskRunRecord["status"];
	spaceId: string | null;
	sessionId: string | null;
	turnId: string | null;
	model: string | null;
	prompt: string | null;
	errorMessage: string | null;
	outputs: GenerationTaskOutput[];
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	updatedAt: string;
};

const INLINE_KEYS = ["data", "base64", "contentBase64"] as const;

function isDeferred(block: Record<string, unknown>) {
	return block.deferredBase64 === true || record(block.source)?.deferredBase64 === true;
}

const MEDIA_TYPE_PATTERN = /^(image|video|audio)\/[\w.+-]+$/;
const DEFAULT_MEDIA_TYPES: Record<string, string> = {
	image: "image/png",
	video: "video/mp4",
	audio: "audio/mpeg",
};

function outputType(value: unknown): GenerationOutputType | null {
	return value === "image" || value === "video" || value === "audio" || value === "text"
		? value
		: null;
}

/** A cover sharing a provider id with media becomes that media's preview. */
function projectOutputs(run: TaskRunRecord): GenerationTaskOutput[] {
	const blocks = generationOutput(run);
	const coverByGroup = new Map<string, string>();
	const coverIndexes = new Set<number>();
	const groupKey = (block: Record<string, unknown>, index: number) =>
		blockIdentity(block) ?? `output-${index}`;

	blocks.forEach((block, index) => {
		if (block.type !== "video" && block.type !== "audio") return;
		const key = groupKey(block, index);
		if (coverByGroup.has(key)) return;
		const coverIndex = blocks.findIndex(
			(candidate, candidateIndex) =>
				candidate.type === "image" &&
				!coverIndexes.has(candidateIndex) &&
				blockIdentity(candidate) !== undefined &&
				groupKey(candidate, candidateIndex) === key,
		);
		const coverUrl = coverIndex >= 0 ? blockUrl(blocks[coverIndex] as Record<string, unknown>) : undefined;
		if (coverIndex >= 0 && coverUrl) {
			coverIndexes.add(coverIndex);
			coverByGroup.set(key, coverUrl);
		}
	});

	return blocks.flatMap((block, index): GenerationTaskOutput[] => {
		const type = outputType(block.type);
		if (!type || coverIndexes.has(index)) return [];
		const size = blockNaturalSize(block);
		const text = type === "text" ? (blockText(block) ?? null) : null;
		if (type === "text" && !text) return [];
		return [
			{
				index,
				type,
				url: type === "text" ? null : (blockUrl(block) ?? null),
				previewUrl: blockPreviewUrl(block) ?? coverByGroup.get(groupKey(block, index)) ?? null,
				title: blockTitle(block) ?? null,
				mimeType: blockMimeType(block) ?? null,
				text,
				width: size.naturalWidth ?? null,
				height: size.naturalHeight ?? null,
				durationMs: blockDurationMs(block) ?? null,
				deferred: type !== "text" && isDeferred(block),
			},
		];
	});
}

export function toGenerationTaskView(run: TaskRunRecord): GenerationTaskView {
	const data = taskData(run);
	const result = record(run.result);
	const model = data?.model ?? result?.model;
	return {
		id: run.id,
		status: run.status,
		spaceId: run.spaceId,
		sessionId: run.sessionId,
		turnId: run.turnId,
		model: typeof model === "string" && model ? model : null,
		prompt: generationPrompt(run) ?? null,
		errorMessage: run.errorMessage,
		outputs: run.status === "completed" ? projectOutputs(run) : [],
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		updatedAt: run.updatedAt,
	};
}

export function isActiveGenerationTask(task: Pick<GenerationTaskView, "status">) {
	return task.status === "pending" || task.status === "running";
}

/** Playable source of an output: its URL, or a data URL for inline payloads. */
export function generationOutputSource(result: unknown, outputIndex: number): string | null {
	const block = contentBlocks(record(result)?.output)[outputIndex];
	if (!block) return null;
	const url = blockUrl(block);
	if (url) return url;
	const source = record(block.source);
	const data = INLINE_KEYS.map((key) => source?.[key] ?? block[key]).find(
		(value): value is string => typeof value === "string" && value !== "",
	);
	if (!data) return null;
	const declared = blockMimeType(block);
	const mediaType =
		declared && MEDIA_TYPE_PATTERN.test(declared)
			? declared
			: (DEFAULT_MEDIA_TYPES[String(block.type)] ?? "application/octet-stream");
	return `data:${mediaType};base64,${data}`;
}
