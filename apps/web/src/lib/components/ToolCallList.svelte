<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import type { MessageToolCallsFile } from "@cohub/protocol/model";
import ToolCallItem from "$lib/components/ToolCallItem.svelte";
import { buildToolCallViewModels } from "$lib/components/tool-call-format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	content: ContentBlock[];
	toolCallsFile?: MessageToolCallsFile | null;
	streaming?: boolean;
	defaultExpanded?: boolean;
	onLoadToolCalls?: () => Promise<MessageToolCallsFile | null>;
	flush?: boolean;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
};

const {
	content,
	toolCallsFile = null,
	streaming = false,
	defaultExpanded = false,
	onLoadToolCalls,
	flush = false,
	onOpenFile,
}: Props = $props();

const locale = $derived(getLocale());

let loading = $state(false);
let loadError = $state<string | null>(null);
let loadedFile = $state<MessageToolCallsFile | null>(null);
let requestedLoad = $state(false);

const effectiveFile = $derived(toolCallsFile ?? loadedFile);
const tools = $derived(
	buildToolCallViewModels({ content, toolCallsFile: effectiveFile }),
);

async function ensureLoaded() {
	if (!onLoadToolCalls || effectiveFile || loading) return;
	requestedLoad = true;
	loading = true;
	loadError = null;
	try {
		loadedFile = await onLoadToolCalls();
	} catch (error) {
		loadError =
			error instanceof Error
				? error.message
				: m.tool_load_failed({}, { locale });
	} finally {
		loading = false;
	}
}

function retryLoad() {
	requestedLoad = false;
	void ensureLoaded();
}
</script>

{#if tools.length > 0}
	<div class={flush ? "space-y-0.5" : "mt-2 space-y-0.5"}>
		{#if loadError}
			<button type="button" class="ml-[26px] mb-1 rounded-md border border-status-error/30 bg-status-error/5 px-2 py-1 text-left text-[12px] leading-snug text-status-error hover:bg-status-error/10" onclick={retryLoad}>
				{loadError} · {m.common_retry({}, { locale })}
			</button>
		{/if}
		{#each tools as tool (tool.id)}
			<ToolCallItem {tool} loading={loading && requestedLoad && !effectiveFile} needsDetails={Boolean(onLoadToolCalls) && !effectiveFile} defaultExpanded={defaultExpanded || (streaming && tool.status === 'running')} autoExpandWhileRunning={streaming} onExpand={ensureLoaded} {onOpenFile} />
		{/each}
	</div>
{/if}
