import { nativeMessageRole } from "@cohub/protocol";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import type { StoredIntermediateMessage } from "@cohub/protocol/model";

function blockText(block: ContentBlock): string {
	if (block.type === "text") return block.text;
	if (block.type === "thinking") return block.thinking;
	if (block.type === "system_note") return block.text;
	if (block.type === "tool_use") {
		return block._meta?.summary ? String(block._meta.summary) : block.name;
	}
	if (block.type === "tool_result") {
		return typeof block.content === "string" ? block.content : "";
	}
	return "";
}

export function createStreamingIntermediateMessage(input: {
	spaceId?: string | null;
	sessionId: string;
	turnId?: string | null;
	streamMessageId?: string | null;
	messageOrdinal?: number | null;
	sequence?: number | null;
	role?: StoredIntermediateMessage["role"];
	contentBlocks: ContentBlock[];
	text?: string | null;
	provider?: string | null;
	model?: string | null;
	stopReason?: string | null;
	errorMessage?: string | null;
	usage?: Usage | null;
	durationMs?: number | null;
	toolCallsObjectKey?: string | null;
	meta?: Record<string, unknown> | null;
	createdAt?: string;
}): StoredIntermediateMessage | null {
	if (input.contentBlocks.length === 0) return null;
	const id =
		input.streamMessageId ??
		`stream:${input.sessionId}:${input.turnId ?? "turn"}:${input.messageOrdinal ?? 0}`;
	const text =
		input.text ??
		input.contentBlocks.map(blockText).filter(Boolean).join("\n\n");
	const toolResultError = input.contentBlocks.find(
		(block) => block.type === "tool_result" && block.is_error,
	) as Extract<ContentBlock, { type: "tool_result" }> | undefined;
	const role =
		nativeMessageRole(input.contentBlocks) === "user"
			? "user"
			: (input.role ?? "assistant");
	return {
		id,
		sessionId: input.sessionId,
		sequence: input.sequence ?? null,
		role,
		content: input.contentBlocks,
		text,
		provider: input.provider ?? null,
		model: input.model ?? null,
		stopReason: input.stopReason ?? null,
		errorMessage:
			input.errorMessage ??
			(toolResultError ? blockText(toolResultError) : null),
		usage: input.usage ?? null,
		durationMs: input.durationMs ?? null,
		toolCallsObjectKey: input.toolCallsObjectKey ?? null,
		meta: {
			...(input.meta ?? {}),
			messageKind:
				role === "user"
					? "user_steering"
					: typeof input.meta?.messageKind === "string"
						? input.meta.messageKind
						: "assistant_intermediate",
			streaming: true,
			turnId: input.turnId ?? null,
			spaceId: input.spaceId ?? null,
			streamMessageId: id,
			messageOrdinal: input.messageOrdinal ?? null,
		},
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}
