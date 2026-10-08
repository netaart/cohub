<script lang="ts">
import {
	isViewportContentBlock,
	parseViewportContextsFromMeta,
	type ViewportContext,
} from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import type { MessageToolCallsFile } from "@cohub/protocol/model";
import { page } from "$app/state";
import MarkdownView from "$lib/components/MarkdownView.svelte";
import AttachmentBlocks from "$lib/components/TextAttachmentBlocks.svelte";
import ThinkingBlocks from "$lib/components/ThinkingBlocks.svelte";
import ToolCallList from "$lib/components/ToolCallList.svelte";
import ViewportContextBlocks from "$lib/components/ViewportContextBlocks.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useMarkdownWorkspaceAsset } from "$lib/markdown-asset-context";
import {
	type ResourceMentionTextToken,
	tokenizeResourceMentionText,
} from "$lib/mentions/resource";
import { m } from "$lib/paraglide/messages.js";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type ThinkingBlock = Extract<ContentBlock, { type: "thinking" }>;
type ImageBlock = Extract<ContentBlock, { type: "image" }>;
type ShellCommandBlock = Extract<ContentBlock, { type: "shell_command" }>;
type AttachmentBlock = TextBlock | ImageBlock;

type Props = {
	content: ContentBlock[];
	isUserMessage?: boolean;
	thinkingExpanded: boolean;
	isStreaming?: boolean;
	showToolCalls?: boolean;
	defaultExpandToolCalls?: boolean;
	onToggleThinking?: () => void;
	onMarkdownSegmentRendered?: () => void;
	onMarkdownSegmentStart?: () => void;
	onLoadToolCalls?: () => Promise<MessageToolCallsFile | null>;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
};

type Segment =
	| { type: "text"; blocks: TextBlock[] }
	| { type: "thinking"; blocks: ThinkingBlock[] }
	| { type: "image"; blocks: ImageBlock[] }
	| { type: "tool"; blocks: ContentBlock[] };

const {
	content,
	isUserMessage = false,
	thinkingExpanded,
	isStreaming = false,
	showToolCalls = true,
	defaultExpandToolCalls = false,
	onToggleThinking,
	onMarkdownSegmentRendered,
	onMarkdownSegmentStart,
	onLoadToolCalls,
	onOpenFile,
	onOpenUrl,
}: Props = $props();

const locale = $derived(getLocale());

function isTextAttachment(block: TextBlock) {
	return block._meta?.attachmentKind === "text";
}

function isViewportAttachment(block: ContentBlock): block is TextBlock {
	return isViewportContentBlock(block);
}

function generationMediaForBlocks(blocks: TextBlock[]) {
	const media: Array<{ type: "video" | "audio"; url: string; index: number }> =
		[];
	for (const block of blocks) {
		if (block._meta?.attachmentKind !== "generation-output") continue;
		try {
			const parsed = JSON.parse(block.text) as {
				type?: unknown;
				result?: unknown;
			};
			if (parsed.type !== "generation.result" || !Array.isArray(parsed.result))
				continue;
			for (const [index, item] of parsed.result.entries()) {
				if (!item || typeof item !== "object" || Array.isArray(item)) continue;
				const record = item as {
					type?: unknown;
					source?: { type?: unknown; url?: unknown };
				};
				if (
					(record.type !== "video" && record.type !== "audio") ||
					record.source?.type !== "url" ||
					typeof record.source.url !== "string"
				)
					continue;
				media.push({ type: record.type, url: record.source.url, index });
			}
		} catch {
			// Keep malformed or legacy generation text readable as normal markdown.
		}
	}
	return media;
}

const resolveWorkspaceAsset = useMarkdownWorkspaceAsset();

const userTextBlocks = $derived(
	content.filter(
		(block): block is TextBlock =>
			block.type === "text" &&
			!isTextAttachment(block) &&
			!isViewportAttachment(block),
	),
);

const userViewportContexts = $derived.by(() => {
	const contexts: ViewportContext[] = [];
	for (const block of content) {
		if (!isViewportAttachment(block)) continue;
		contexts.push(...parseViewportContextsFromMeta(block._meta));
	}
	return contexts;
});

const userAttachmentBlocks = $derived(
	content.filter(
		(block): block is AttachmentBlock =>
			block.type === "image" ||
			(block.type === "text" && block._meta?.attachmentKind === "text"),
	),
);

const userShellCommandBlocks = $derived(
	content.filter(
		(block): block is ShellCommandBlock => block.type === "shell_command",
	),
);

type ResourceMentionToken = Exclude<ResourceMentionTextToken, { type: "text" }>;

type UserTextToken =
	| { type: "text"; text: string }
	| (ResourceMentionToken & { text: string });

const userMentionButtonClass =
	"inline-flex max-w-full translate-y-[-1px] items-baseline rounded-[5px] bg-brand-muted px-1.5 py-0.5 text-[0.92em] font-medium leading-none text-brand-muted-fg ring-1 ring-brand-border/70 transition-colors hover:bg-brand-muted-hover focus:outline-none focus:ring-1 focus:ring-brand";

function buildUserMentionHref(token: ResourceMentionToken) {
	if (token.type === "appMention") return token.href;
	const url = new URL(token.href, page.url.origin);
	url.searchParams.set("from", page.url.pathname);
	return `${url.pathname}${url.search}${url.hash}`;
}

function openUserMention(token: ResourceMentionToken, event: MouseEvent) {
	event.preventDefault();
	event.stopPropagation();
	window.open(buildUserMentionHref(token), "_blank", "noopener,noreferrer");
}

function tokenizeUserText(value: string) {
	return tokenizeResourceMentionText(value).map((token) => {
		if (token.type !== "text") {
			return { ...token, text: `@${token.label}` } satisfies UserTextToken;
		}
		return token satisfies UserTextToken;
	});
}

const userTextTokens = $derived.by(() =>
	tokenizeUserText(userTextBlocks.map((block) => block.text).join("\n\n")),
);

const segments = $derived.by(() => {
	const result: Segment[] = [];
	let i = 0;
	while (i < content.length) {
		const block = content[i];
		if (block.type === "text") {
			const blocks: TextBlock[] = [];
			while (content[i]?.type === "text") {
				blocks.push(content[i] as TextBlock);
				i += 1;
			}
			result.push({ type: "text", blocks });
			continue;
		}
		if (block.type === "thinking") {
			const blocks: ThinkingBlock[] = [];
			while (content[i]?.type === "thinking") {
				blocks.push(content[i] as ThinkingBlock);
				i += 1;
			}
			result.push({ type: "thinking", blocks });
			continue;
		}
		if (block.type === "image") {
			const blocks: ImageBlock[] = [];
			while (content[i]?.type === "image") {
				blocks.push(content[i] as ImageBlock);
				i += 1;
			}
			result.push({ type: "image", blocks });
			continue;
		}
		if (block.type === "tool_use") {
			const blocks: ContentBlock[] = [block];
			const next = content[i + 1];
			if (next?.type === "tool_result" && next.tool_use_id === block.id) {
				blocks.push(next);
				i += 2;
			} else {
				i += 1;
			}
			result.push({ type: "tool", blocks });
			continue;
		}
		// tool_result without a directly preceding tool_use is skipped here to avoid
		// rendering orphaned result blocks out of context.
		i += 1;
	}
	return result;
});
</script>

{#if isUserMessage}
	{#if userShellCommandBlocks.length > 0}
		<div class="font-mono text-[14px] leading-[1.7] text-brand/90 tabular-nums">
			{userShellCommandBlocks.map((block) => ["$", block.command].join("")).join('\n')}
		</div>
	{/if}
	{#if userTextBlocks.length > 0}
		<div class="whitespace-pre-wrap break-words text-inherit" class:mt-2={userShellCommandBlocks.length > 0}>
			{#each userTextTokens as token}
				{#if token.type !== 'text'}
					<button
						type="button"
						class={userMentionButtonClass}
						title={m.message_open_in_new({ label: token.label }, { locale })}
						aria-label={
							token.type === "appMention"
								? m.message_open_aria_app({ label: token.label }, { locale })
								: m.message_open_aria_space({ label: token.label }, { locale })
						}
						onclick={(event) => openUserMention(token, event)}
					>{token.text}</button>
				{:else}{token.text}{/if}
			{/each}
		</div>
	{/if}
	{#if userViewportContexts.length > 0}
		<div class={userTextBlocks.length > 0 || userShellCommandBlocks.length > 0 ? "mt-2" : ""}>
			<ViewportContextBlocks contexts={userViewportContexts} />
		</div>
	{/if}
	{#if userAttachmentBlocks.length > 0}
		<div class={userTextBlocks.length > 0 || userViewportContexts.length > 0 ? "mt-2" : ""}>
			<AttachmentBlocks blocks={userAttachmentBlocks} />
		</div>
	{/if}
{:else}
	{#each segments as segment, index (`${segment.type}:${index}`)}
		<div class={index === 0 ? "" : "mt-2"}>
			{#if segment.type === 'text'}
				{@const generationMedia = isStreaming ? [] : generationMediaForBlocks(segment.blocks)}
				<MarkdownView blocks={segment.blocks} variant="chat" {isStreaming} onStart={onMarkdownSegmentStart} onRendered={onMarkdownSegmentRendered} {onOpenFile} {onOpenUrl} {resolveWorkspaceAsset} />
				{#if generationMedia.length > 0}
					<div class="mt-3 space-y-2">
						{#each generationMedia as media (media.url)}
							{#if media.type === "video"}
								<!-- svelte-ignore a11y_media_has_caption: generated media does not provide caption tracks. -->
								<video src={media.url} controls playsinline preload="metadata" class="max-h-[min(60vh,32rem)] max-w-full rounded-lg border border-border-subtle" aria-label={m.message_generated_video({ index: media.index + 1 }, { locale })}></video>
							{:else}
								<audio src={media.url} controls preload="metadata" class="w-full" aria-label={m.message_generated_audio({ index: media.index + 1 }, { locale })}></audio>
							{/if}
						{/each}
					</div>
				{/if}
			{:else if segment.type === 'thinking'}
				<ThinkingBlocks blocks={segment.blocks} expanded={thinkingExpanded} {isStreaming} onToggle={onToggleThinking} />
			{:else if segment.type === 'image'}
				<AttachmentBlocks blocks={segment.blocks} />
			{:else if segment.type === 'tool' && showToolCalls}
				<ToolCallList content={segment.blocks} streaming={isStreaming} defaultExpanded={defaultExpandToolCalls} {onLoadToolCalls} flush {onOpenFile} />
			{/if}
		</div>
	{/each}
{/if}
