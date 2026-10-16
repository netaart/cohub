import {
	asRecord,
	blockUrl,
	featuredTaskArtifact,
	generationOutput,
} from "@cohub/protocol";
import {
	type CreateGenerationTaskRequest,
	type GenerationContentBlock,
	type GenerationContentSpec,
	type GenerationOperation,
	generationModelInputType,
	generationOperations,
	type PublicGenerationDeclaration,
	resolveGenerationOperation,
} from "@cohub/protocol/generation";
import type { TaskRunRecord } from "@neta-art/cohub";
import {
	type BoardFrame,
	type BoardSceneItem,
	type BoardTaskSnapshot,
	boardItemOrigin,
	parseBoardMediaSource,
} from "@neta-art/cohub/board";
import {
	type GenerationParameterValues,
	generationParametersError,
} from "$lib/generation-parameters";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export type BoardGenerationMediaType = "image" | "video" | "audio" | "3d";

export type BoardGenerationReference = {
	id: string;
	type: BoardGenerationMediaType;
	url: string;
	label: string;
	role?: string;
	/** Output meta of the generation the reference came from, which chains 3D operations to its provider task. */
	meta?: Record<string, unknown>;
};

const MEDIA_TYPES: readonly BoardGenerationMediaType[] = [
	"image",
	"video",
	"audio",
	"3d",
];
const REGENERATED_TASK_GAP = 48;
const PENDING_TASK_WIDTH = 300;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isMediaType(value: unknown): value is BoardGenerationMediaType {
	return MEDIA_TYPES.includes(value as BoardGenerationMediaType);
}

function isGenerationContentBlock(
	value: unknown,
): value is GenerationContentBlock {
	const block = record(value);
	if (!block) return false;
	if (block.meta !== undefined && !record(block.meta)) return false;
	if (block.type === "text") return typeof block.text === "string";
	if (!isMediaType(block.type)) return false;
	const source = record(block.source);
	if (source?.type === "url") return typeof source.url === "string";
	return (
		source?.type === "base64" &&
		typeof source.mediaType === "string" &&
		typeof source.data === "string"
	);
}

/** Rebuild a public generation request from an authoritative TaskRun detail. */
export function regenerationRequestFromTaskRun(
	run: TaskRunRecord,
	spaceId: string,
): CreateGenerationTaskRequest {
	if (run.taskType !== "generation" || run.spaceId !== spaceId) {
		throw new Error("This task cannot be regenerated on this board.");
	}
	const payload = record(run.payload);
	const data = record(payload?.data) ?? payload;
	const model = data?.model;
	const content = data?.content;
	const parameters = data?.parameters;
	const meta = data?.meta;
	if (
		typeof model !== "string" ||
		!model.trim() ||
		!Array.isArray(content) ||
		content.length === 0 ||
		!content.every(isGenerationContentBlock) ||
		(parameters !== undefined && !record(parameters)) ||
		(meta !== undefined && !record(meta))
	) {
		throw new Error("The original generation input is unavailable.");
	}
	const { boardContext: _boardContext, ...modelMeta } = (meta ?? {}) as Record<
		string,
		unknown
	>;
	return {
		spaceId,
		model,
		content,
		...(parameters === undefined
			? {}
			: { parameters: parameters as Record<string, unknown> }),
		...(Object.keys(modelMeta).length > 0 ? { meta: modelMeta } : {}),
	};
}

const RATIO_PATTERN = /^(\d+(?:\.\d+)?)\s*[x×:/]\s*(\d+(?:\.\d+)?)$/i;

export function generationAspectRatio(
	model: Pick<PublicGenerationDeclaration, "parameters" | "category">,
	parameters: Readonly<Record<string, unknown>>,
): number | undefined {
	if (model.category === "3d") return 1;
	for (const name of ["aspect_ratio", "ratio", "size"]) {
		const value = parameters[name] ?? model.parameters?.[name]?.default;
		const match =
			typeof value === "string" ? RATIO_PATTERN.exec(value.trim()) : null;
		const ratio = match ? Number(match[1]) / Number(match[2]) : Number.NaN;
		if (Number.isFinite(ratio) && ratio > 0) return ratio;
	}
	return undefined;
}

export function generationPromptFromContent(
	content: readonly GenerationContentBlock[],
): string {
	const block = content.find((candidate) => candidate.type === "text");
	return block?.type === "text" ? block.text : "";
}

/** Center a pending task node to the right of its source with a stable gap. */
export function regeneratedTaskPosition(source: BoardFrame) {
	return {
		x: source.x + source.width + REGENERATED_TASK_GAP + PENDING_TASK_WIDTH / 2,
		y: source.y + source.height / 2,
	};
}

const QWEN_REFERENCE_VOICE_MODELS = new Set([
	"qwen-tts",
	"qwen-audio-3.0-tts-plus",
	"qwen-audio-3.0-tts-flash",
]);
const QWEN_AUDIO_3_MODELS = new Set([
	"qwen-audio-3.0-tts-plus",
	"qwen-audio-3.0-tts-flash",
]);

export function normalizeGenerationReferenceUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:"
			? value.trim()
			: null;
	} catch {
		return null;
	}
}

export function parseBoardGenerationReferences(
	value: unknown,
): BoardGenerationReference[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const reference = record(candidate);
		if (!reference) return [];
		const url =
			typeof reference.url === "string"
				? normalizeGenerationReferenceUrl(reference.url)
				: null;
		if (
			typeof reference.id !== "string" ||
			!isMediaType(reference.type) ||
			!url ||
			typeof reference.label !== "string"
		) {
			return [];
		}
		const role =
			typeof reference.role === "string" && reference.role.trim()
				? reference.role.trim()
				: undefined;
		const meta = record(reference.meta);
		return [
			{
				id: reference.id,
				type: reference.type,
				url,
				label: reference.label,
				...(role ? { role } : {}),
				...(meta ? { meta } : {}),
			},
		];
	});
}

function sourceFileName(src: string) {
	const source = parseBoardMediaSource(src);
	if (!source) return "";
	const path =
		source.kind === "url" ? new URL(source.value).pathname : source.value;
	return path.split("/").pop() ?? "";
}

/** The input type a Board item gives a generation, or null when it gives none. */
export function boardGenerationReferenceType(
	item: BoardSceneItem,
): BoardGenerationMediaType | null {
	if (item.type === "image" || item.type === "video" || item.type === "audio")
		return item.type;
	if (item.type === "file") {
		const mimeType = item.props.snapshot?.mimeType ?? "";
		if (mimeType.startsWith("image/")) return "image";
		if (mimeType.startsWith("video/")) return "video";
		if (mimeType.startsWith("audio/")) return "audio";
		return generationModelInputType(sourceFileName(item.props.src))
			? "3d"
			: null;
	}
	if (item.type === "task") {
		const type = featuredTaskArtifact(item.props.snapshot.artifacts)?.type;
		return isMediaType(type) ? type : null;
	}
	return null;
}

/** The generation run whose output a Board item shows. */
export function boardGenerationSourceRun(item: BoardSceneItem): string | null {
	if (item.type === "task") return item.props.taskRunId;
	return boardItemOrigin(item)?.taskRunId ?? null;
}

/** The meta of the run output at `url`, which a follow-up operation reads to reuse the provider task. */
export function generationOutputMeta(
	run: Pick<TaskRunRecord, "result">,
	url: string,
): Record<string, unknown> | undefined {
	const block = generationOutput(run).find(
		(candidate) => blockUrl(candidate) === url,
	);
	const meta = block ? asRecord(block.meta) : null;
	return meta ? { ...meta } : undefined;
}

export function generationInputSpec(
	model: Pick<PublicGenerationDeclaration, "content">,
	type: "text" | BoardGenerationMediaType,
): GenerationContentSpec | null {
	return model.content.input.find((spec) => spec.type === type) ?? null;
}

export function supportsBoardGenerationComposer(
	model: PublicGenerationDeclaration,
	references: readonly BoardGenerationReference[] = [],
): boolean {
	if (
		Object.values(model.meta?.fields ?? {}).some(
			(spec) => spec.optional !== true,
		)
	) {
		return false;
	}
	return (
		!QWEN_REFERENCE_VOICE_MODELS.has(model.model) ||
		references.some((reference) => reference.type === "audio")
	);
}

function inputsAccept(
	model: Pick<PublicGenerationDeclaration, "content">,
	references: readonly BoardGenerationReference[],
): boolean {
	for (const type of MEDIA_TYPES) {
		const count = references.filter(
			(reference) => reference.type === type,
		).length;
		if (count === 0) continue;
		const spec = generationInputSpec(model, type);
		if (!spec || (typeof spec.max === "number" && count > spec.max))
			return false;
		if (spec.sources && !spec.sources.includes("url")) return false;
	}
	return true;
}

/** Whether an operation of a model takes these references. */
export function operationAcceptsGenerationReferences(
	model: PublicGenerationDeclaration,
	operation: GenerationOperation,
	references: readonly BoardGenerationReference[],
): boolean {
	return inputsAccept(
		resolveGenerationOperation(model, { operation: operation.name }),
		references,
	);
}

/** Whether a model takes these references; a model with operations does when any operation does. */
export function modelAcceptsGenerationReferences(
	model: PublicGenerationDeclaration,
	references: readonly BoardGenerationReference[],
): boolean {
	const operations = generationOperations(model);
	return operations.length > 0
		? operations.some((operation) =>
				operationAcceptsGenerationReferences(model, operation, references),
			)
		: inputsAccept(model, references);
}

export function defaultGenerationReferenceRole(
	model: Pick<PublicGenerationDeclaration, "content">,
	type: BoardGenerationMediaType,
): string | undefined {
	const spec = generationInputSpec(model, type);
	return spec?.roleRequired ? spec.roles?.[0] : undefined;
}

function inputTypeLabel(
	type: "text" | BoardGenerationMediaType,
	locale: Locale,
): string {
	switch (type) {
		case "text":
			return m.generation_input_text({}, { locale });
		case "image":
			return m.generation_input_image({}, { locale });
		case "video":
			return m.generation_input_video({}, { locale });
		case "audio":
			return m.generation_input_audio({}, { locale });
		case "3d":
			return m.generation_input_3d({}, { locale });
	}
}

function inputCountError(
	spec: GenerationContentSpec,
	count: number,
	locale: Locale,
): string | null {
	const type = inputTypeLabel(spec.type, locale);
	if (spec.required === true && count === 0)
		return m.generation_input_required({ type }, { locale });
	if (typeof spec.min === "number" && count < spec.min)
		return m.generation_inputs_min({ type, count: spec.min }, { locale });
	if (typeof spec.max === "number" && count > spec.max)
		return m.generation_inputs_max({ type, count: spec.max }, { locale });
	return null;
}

function roleError(
	spec: GenerationContentSpec,
	references: readonly BoardGenerationReference[],
	locale: Locale,
): string | null {
	if (spec.type === "text") return null;
	const ofType = references.filter((reference) => reference.type === spec.type);
	const type = inputTypeLabel(spec.type, locale);
	if (spec.roleRequired && ofType.some((reference) => !reference.role))
		return m.generation_input_role_required({ type }, { locale });
	if (
		spec.roles &&
		ofType.some(
			(reference) =>
				reference.role !== undefined && !spec.roles?.includes(reference.role),
		)
	)
		return m.generation_input_role_invalid({ type }, { locale });
	return null;
}

/** Why the composer cannot start this generation, or null when it can. */
export function validateBoardGeneration(input: {
	model: PublicGenerationDeclaration | null;
	prompt: string;
	references: readonly BoardGenerationReference[];
	parameters: Readonly<GenerationParameterValues>;
	locale: Locale;
}): string | null {
	const { model: declared, references, locale } = input;
	if (!declared) return m.generation_select_model({}, { locale });
	if (!supportsBoardGenerationComposer(declared, references)) {
		return QWEN_REFERENCE_VOICE_MODELS.has(declared.model)
			? m.generation_audio_reference_required({}, { locale })
			: m.generation_meta_required({}, { locale });
	}
	const parametersError = generationParametersError(
		declared,
		input.parameters,
		locale,
	);
	if (parametersError) return parametersError;
	const model = resolveGenerationOperation(declared, input.parameters);
	if (!inputsAccept(model, references))
		return m.generation_inputs_unsupported({}, { locale });

	const textCount = input.prompt.trim() ? 1 : 0;
	if (textCount > 0 && !generationInputSpec(model, "text"))
		return m.generation_text_unsupported({}, { locale });
	for (const spec of model.content.input) {
		const count =
			spec.type === "text"
				? textCount
				: references.filter((reference) => reference.type === spec.type).length;
		const error =
			inputCountError(spec, count, locale) ??
			roleError(spec, references, locale);
		if (error) return error;
	}

	if (
		QWEN_AUDIO_3_MODELS.has(declared.model) &&
		Array.from(input.prompt.trim()).length < 15
	) {
		return m.generation_prompt_min_length({ count: 15 }, { locale });
	}
	if (textCount === 0 && references.length === 0)
		return m.generation_input_missing({}, { locale });
	return null;
}

export function buildBoardGenerationContent(
	prompt: string,
	references: readonly BoardGenerationReference[],
): GenerationContentBlock[] {
	const content: GenerationContentBlock[] = [];
	const text = prompt.trim();
	if (text) content.push({ type: "text", text });
	for (const reference of references) {
		const meta = {
			...reference.meta,
			...(reference.role ? { role: reference.role } : {}),
		};
		content.push({
			type: reference.type,
			source: { type: "url", url: reference.url },
			...(Object.keys(meta).length > 0 ? { meta } : {}),
		});
	}
	return content;
}

export function pendingGenerationTaskSnapshot(input: {
	prompt: string;
	model: string;
	now?: string;
}): BoardTaskSnapshot {
	const prompt = input.prompt.replace(/\s+/g, " ").trim();
	const excerpt = prompt.slice(0, 480);
	return {
		taskType: "generation",
		status: "pending",
		title: excerpt.slice(0, 240) || "Media generation",
		model: input.model,
		...(excerpt ? { promptExcerpt: excerpt } : {}),
		artifactCount: 0,
		artifacts: [],
		updatedAt: input.now ?? new Date().toISOString(),
	};
}
