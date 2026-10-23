<script lang="ts">
import type {
	MessageToolCallsFile,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import { ChevronDown, ChevronRight } from "lucide-svelte";
import IntermediateMessageBubble from "$lib/components/IntermediateMessageBubble.svelte";
import StatusGlyph from "$lib/components/StatusGlyph.svelte";
import {
	buildToolCallViewModels,
	summarizeToolCalls,
} from "$lib/components/tool-call-format";
import { getLocale } from "$lib/i18n/locale.svelte";
import type { ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	turn: SessionTurnRecord;
	messages: StoredIntermediateMessage[];
	modelsCatalog?: ModelCatalogItem[];
	onLoadToolCalls?: (input: {
		turn: SessionTurnRecord;
		message: StoredIntermediateMessage;
	}) => Promise<MessageToolCallsFile | null>;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
};

const {
	turn,
	messages,
	modelsCatalog,
	onLoadToolCalls,
	onOpenFile,
	onOpenUrl,
}: Props = $props();

const locale = $derived(getLocale());
let open = $state(false);
const tools = $derived(
	buildToolCallViewModels({
		content: messages.flatMap((message) => message.content),
	}),
);
const summary = $derived(summarizeToolCalls(tools));
const tone = $derived(
	summary.running ? "activity" : summary.failed ? "error" : "success",
);
const label = $derived(
	[
		messages.length > 1
			? m.process_steps_many({ count: messages.length }, { locale })
			: m.process_steps_one({ count: 1 }, { locale }),
		tools.length > 1
			? m.process_tools_many({ count: tools.length }, { locale })
			: tools.length === 1
				? m.process_tools_one({ count: 1 }, { locale })
				: "",
	]
		.filter(Boolean)
		.join(" · "),
);
</script>

<div class="px-[var(--chat-msg-inset)]">
	<button
		type="button"
		class="relative flex min-h-7 w-full items-center gap-2 rounded-md py-1 px-0 text-left transition-colors duration-150 hover:bg-bg-hover/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/35"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<StatusGlyph {tone} motion={summary.running ? "active" : "none"} soft={tone === "success"} class="[--status-glyph-size:6px]" />
		<span class="shrink-0 text-[13px] text-text-tertiary tabular-nums">{label}</span>
		<span class="min-w-0 flex-1 truncate font-mono text-[13px] text-text-placeholder">{summary.names}</span>
		{#if summary.failed > 0}
			<span class="ml-auto shrink-0 text-[11px] tabular-nums text-status-error">{m.tool_failed_count({ count: summary.failed }, { locale })}</span>
		{/if}
		<span class="shrink-0 text-text-tertiary">
			{#if open}<ChevronDown class="h-3.5 w-3.5" />{:else}<ChevronRight class="h-3.5 w-3.5" />{/if}
		</span>
	</button>
</div>
{#if open}
	<div class="ml-[calc(var(--chat-msg-inset)+3px)] flex flex-col gap-2 border-l border-border-subtle/70 pl-[11px] [--chat-msg-inset:0px]">
		{#each messages as message}
			<IntermediateMessageBubble {message} showMeta={false} {modelsCatalog} onLoadToolCalls={onLoadToolCalls ? () => onLoadToolCalls({ turn, message }) : undefined} {onOpenFile} {onOpenUrl} />
		{/each}
	</div>
{/if}
