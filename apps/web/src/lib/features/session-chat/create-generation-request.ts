import type {
	GenerationContentBlock,
	PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import type { CreateSpacePromptInput } from "@neta-art/cohub";
import {
	type GenerationRoleTexts,
	roleTextBlocks,
} from "$lib/generation-text-roles";

export type CreateGenerationRequestInput = {
	declaration: PublicGenerationDeclaration;
	text: string;
	/** Per-role boxes of a model whose text input declares roles; sent before `text`. */
	roleTexts?: GenerationRoleTexts;
	textAttachments?: readonly { text: string }[];
	imageUrls?: readonly string[];
	parameters?: Readonly<Record<string, unknown>>;
	sessionId?: string | null;
	clientMessageId: string;
};

export function buildCreateGenerationRequest(
	input: CreateGenerationRequestInput,
): CreateSpacePromptInput {
	const content: GenerationContentBlock[] = [
		...(input.roleTexts
			? (roleTextBlocks(input.declaration, input.roleTexts) ?? [])
			: []),
		...(input.text
			? [{ type: "text", text: input.text } satisfies GenerationContentBlock]
			: []),
		...(input.textAttachments ?? []).map(
			(attachment): GenerationContentBlock => ({
				type: "text",
				text: attachment.text,
			}),
		),
		...(input.imageUrls ?? []).map(
			(url): GenerationContentBlock => ({
				type: "image",
				source: { type: "url", url },
			}),
		),
	];
	const parameters =
		input.parameters && Object.keys(input.parameters).length > 0
			? { ...input.parameters }
			: null;
	return {
		mode: "create",
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		generation: {
			model: input.declaration.model,
			content,
			...(parameters ? { parameters } : {}),
		},
		clientMessageId: input.clientMessageId,
		accessMode: "full_access",
		intent: "followup",
		schedule: { mode: "immediate" },
	};
}
