import type {
	CreateGenerationTaskRequest,
	GenerationContentBlock,
	PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import type { TaskRunRecord } from "@neta-art/cohub";
import type { BoardRect, BoardTaskSnapshot } from "@neta-art/cohub/board";
import {
	type GenerationRoleTexts,
	missingRequiredRoles,
	roleTextBlocks,
} from "$lib/generation-text-roles";

export type BoardGenerationMediaType = "image" | "video" | "audio";

export type BoardGenerationReference = {
	id: string;
	type: BoardGenerationMediaType;
	url: string;
	label: string;
	role?: string;
};

const PENDING_TASK_GAP = 48;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isGenerationContentBlock(
	value: unknown,
): value is GenerationContentBlock {
	const block = record(value);
	if (!block) return false;
	if (block.meta !== undefined && !record(block.meta)) return false;
	if (block.type === "text") return typeof block.text === "string";
	if (
		block.type !== "image" &&
		block.type !== "video" &&
		block.type !== "audio"
	)
		return false;
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
	model: Pick<PublicGenerationDeclaration, "parameters">,
	parameters: Readonly<Record<string, unknown>>,
): number | undefined {
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

export function pendingTaskPosition(
	source: BoardRect,
	card: { width: number },
) {
	return {
		x: source.x + source.width + PENDING_TASK_GAP + card.width / 2,
		y: source.y + source.height / 2,
	};
}

const QWEN_AUDIO_31_TTS_MODELS = new Set(["qwen-audio-3.1-tts-flash"]);

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
		if (!candidate || typeof candidate !== "object") return [];
		const reference = candidate as Record<string, unknown>;
		const url =
			typeof reference.url === "string"
				? normalizeGenerationReferenceUrl(reference.url)
				: null;
		if (
			typeof reference.id !== "string" ||
			(reference.type !== "image" &&
				reference.type !== "video" &&
				reference.type !== "audio") ||
			!url ||
			typeof reference.label !== "string"
		) {
			return [];
		}
		const role =
			typeof reference.role === "string" && reference.role.trim()
				? reference.role.trim()
				: undefined;
		return [
			{
				id: reference.id,
				type: reference.type,
				url,
				label: reference.label,
				...(role ? { role } : {}),
			},
		];
	});
}

export function generationInputSpec(
	model: PublicGenerationDeclaration,
	type: "text" | BoardGenerationMediaType,
) {
	return model.content.input.find((spec) => spec.type === type) ?? null;
}

export function supportsBoardGenerationComposer(
	model: PublicGenerationDeclaration,
	_references: readonly BoardGenerationReference[] = [],
): boolean {
	if (
		Object.values(model.meta?.fields ?? {}).some(
			(spec) => spec.optional !== true,
		)
	) {
		return false;
	}
	return true;
}

export function modelAcceptsGenerationReferences(
	model: PublicGenerationDeclaration,
	references: readonly BoardGenerationReference[],
): boolean {
	for (const type of ["image", "video", "audio"] as const) {
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

export function defaultGenerationReferenceRole(
	model: PublicGenerationDeclaration,
	type: BoardGenerationMediaType,
): string | undefined {
	const spec = generationInputSpec(model, type);
	return spec?.roleRequired ? spec.roles?.[0] : undefined;
}

export function validateBoardGeneration(input: {
	model: PublicGenerationDeclaration | null;
	prompt: string;
	references: readonly BoardGenerationReference[];
	/** Role boxes of a model whose text input declares roles; they replace `prompt`. */
	roleTexts?: GenerationRoleTexts;
}): string | null {
	const { model, references } = input;
	if (!model) return "Select a model.";
	if (!supportsBoardGenerationComposer(model, references)) {
		return "This model requires additional metadata.";
	}
	if (!modelAcceptsGenerationReferences(model, references)) {
		return "The selected model does not support these references.";
	}

	const roleBlocks = input.roleTexts
		? roleTextBlocks(model, input.roleTexts)
		: null;
	const missingRole =
		roleBlocks && input.roleTexts
			? missingRequiredRoles(model, input.roleTexts)[0]
			: undefined;
	if (missingRole) return `Add ${missingRole} text.`;
	const textCount = roleBlocks
		? roleBlocks.length
		: input.prompt.trim()
			? 1
			: 0;
	if (textCount > 0 && !generationInputSpec(model, "text")) {
		return "The selected model does not support text input.";
	}
	for (const spec of model.content.input) {
		const count =
			spec.type === "text"
				? textCount
				: references.filter((reference) => reference.type === spec.type).length;
		if (spec.required === true && count === 0) {
			return `Add ${spec.type} input.`;
		}
		if (typeof spec.min === "number" && count < spec.min) {
			return `Add at least ${spec.min} ${spec.type} inputs.`;
		}
		if (typeof spec.max === "number" && count > spec.max) {
			return `Use at most ${spec.max} ${spec.type} inputs.`;
		}
		if (
			spec.roleRequired &&
			spec.type !== "text" &&
			references.some(
				(reference) => reference.type === spec.type && !reference.role,
			)
		) {
			return `Choose a role for each ${spec.type} reference.`;
		}
		if (
			spec.type !== "text" &&
			spec.roles &&
			references.some(
				(reference) =>
					reference.type === spec.type &&
					reference.role !== undefined &&
					!spec.roles?.includes(reference.role),
			)
		) {
			return `Choose a valid role for each ${spec.type} reference.`;
		}
	}

	if (
		QWEN_AUDIO_31_TTS_MODELS.has(model.model) &&
		Array.from(input.prompt.trim()).length < 15
	) {
		return "Enter at least 15 characters for this model.";
	}
	if (textCount === 0 && references.length === 0) return "Add an input.";
	return null;
}

export function validateBoardGenerationParameters(
	model: PublicGenerationDeclaration | null,
	parameters: Readonly<Record<string, unknown>>,
): string | null {
	if (!model) return null;
	for (const [name, spec] of Object.entries(model.parameters ?? {})) {
		const value = parameters[name];
		if (value === undefined || (value === null && spec.type === "object")) {
			if (spec.default === undefined && spec.optional !== true) {
				return `Set ${name.replaceAll("_", " ")}.`;
			}
			continue;
		}
		if (spec.type === "string") {
			if (typeof value !== "string") return `${name} must be text.`;
			if (spec.enum && !spec.enum.includes(value)) {
				return `Choose a valid ${name.replaceAll("_", " ")}.`;
			}
			if (spec.dimensions) {
				const { min, max, multipleOf, separator = "x" } = spec.dimensions;
				const parts = value.split(separator);
				if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part))) {
					return `Use WIDTH${separator}HEIGHT for ${name}.`;
				}
				const dimensions = parts.map(Number);
				if (
					min !== undefined &&
					dimensions.some((dimension) => dimension < min)
				) {
					return `${name} must be at least ${min}.`;
				}
				if (
					max !== undefined &&
					dimensions.some((dimension) => dimension > max)
				) {
					return `${name} must be at most ${max}.`;
				}
				if (
					multipleOf !== undefined &&
					dimensions.some((dimension) => dimension % multipleOf !== 0)
				) {
					return `${name} must use multiples of ${multipleOf}.`;
				}
			}
			continue;
		}
		if (spec.type === "boolean") {
			if (typeof value !== "boolean") return `${name} must be true or false.`;
			continue;
		}
		if (spec.type === "object") {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return `${name} must be a JSON object.`;
			}
			continue;
		}
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			(spec.type === "integer" && !Number.isInteger(value))
		) {
			return `${name} must be a valid ${spec.type}.`;
		}
		if (spec.min !== undefined && value < spec.min) {
			return `${name} must be at least ${spec.min}.`;
		}
		if (spec.max !== undefined && value > spec.max) {
			return `${name} must be at most ${spec.max}.`;
		}
	}
	return null;
}

export function buildBoardGenerationContent(
	prompt: string,
	references: readonly BoardGenerationReference[],
	roles?: { model: PublicGenerationDeclaration; texts: GenerationRoleTexts },
): GenerationContentBlock[] {
	const content: GenerationContentBlock[] = [
		...(roles ? (roleTextBlocks(roles.model, roles.texts) ?? []) : []),
	];
	const text = prompt.trim();
	if (text) content.push({ type: "text", text });
	for (const reference of references) {
		content.push({
			type: reference.type,
			source: { type: "url", url: reference.url },
			...(reference.role ? { meta: { role: reference.role } } : {}),
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
