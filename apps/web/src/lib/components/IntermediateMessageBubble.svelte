<script lang="ts">
import type {
	ContextCompactionMeta,
	MessageToolCallsFile,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import ChatMessageBubble from "$lib/components/ChatMessageBubble.svelte";
import SystemCompactionNotice from "$lib/components/SystemCompactionNotice.svelte";
import type { ModelCatalogItem } from "$lib/model-catalog";
import type { ChatMessage } from "$lib/session-tree";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	message: StoredIntermediateMessage;
	streaming?: boolean;
	modelsCatalog?: ModelCatalogItem[];
	onLoadToolCalls?: () => Promise<MessageToolCallsFile | null>;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
};

const {
	message,
	streaming = false,
	modelsCatalog,
	onLoadToolCalls,
	onOpenFile,
	onOpenUrl,
}: Props = $props();
const isCompaction = $derived(message.meta?.messageKind === "compacted");
const compaction = $derived(
	(message.meta?.compaction as
		| (Partial<ContextCompactionMeta> & Record<string, unknown>)
		| undefined) ?? {},
);
const compactionSummary = $derived.by(() => {
	const block = message.content.find(
		(
			block,
		): block is Extract<
			(typeof message.content)[number],
			{ type: "system_note" }
		> => block.type === "system_note" && block.note_type === "compacted",
	);
	return block?.text ?? message.text ?? "";
});
const chatMessage = $derived({
	id: message.id,
	sourceId: message.id,
	role: message.role,
	content: message.content,
	text: message.text ?? "",
	sequence: message.sequence ?? 0,
	blocks: [...message.content],
	createdAt: message.createdAt,
	meta: {
		messageKind:
			typeof message.meta?.messageKind === "string"
				? message.meta.messageKind
				: "assistant_intermediate",
		streaming,
		model: message.model,
		provider: message.provider,
		usage: message.usage,
		llmTiming: message.meta?.llmTiming,
		durationMs: message.durationMs,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	},
	toolCallsLoader: onLoadToolCalls,
} satisfies ChatMessage);
</script>

{#if isCompaction}
	<SystemCompactionNotice
		variant="turn-inline"
		{compaction}
		summary={compactionSummary}
		usage={message.usage}
		durationMs={message.durationMs}
	/>
{:else}
	<div class="pl-5">
		<ChatMessageBubble message={chatMessage} {modelsCatalog} {onOpenFile} {onOpenUrl} />
	</div>
{/if}
