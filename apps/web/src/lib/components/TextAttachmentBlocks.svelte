<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { ArrowUpRight } from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { mediaLightbox } from "$lib/components/media-lightbox.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type ImageBlock = Extract<ContentBlock, { type: "image" }>;

type AttachmentBlock = TextBlock | ImageBlock;

type Props = {
	blocks: AttachmentBlock[];
};

const { blocks }: Props = $props();

const locale = $derived(getLocale());
let previewTextBlock = $state<TextBlock | null>(null);

function isTextAttachment(block: ContentBlock): block is TextBlock {
	return block.type === "text" && block._meta?.attachmentKind === "text";
}

function isImageAttachment(block: ContentBlock): block is ImageBlock {
	return block.type === "image";
}

function getFilename(block: TextBlock | ImageBlock, index: number) {
	return String(block._meta?.filename ?? `attachment-${index + 1}`);
}

function getSizeLabel(block: TextBlock) {
	const size = block._meta?.size;
	if (typeof size !== "number" || !Number.isFinite(size)) return "";
	return `${Math.ceil(size / 1024)} KB`;
}

function getAttachmentBody(block: TextBlock) {
	const filename = block._meta?.filename;
	if (typeof filename !== "string" || !filename) return block.text;
	const prefix = `[File: ${filename}]\n`;
	return block.text.startsWith(prefix)
		? block.text.slice(prefix.length)
		: block.text;
}

function getImageSrc(block: ImageBlock) {
	if (block.source.type === "url") return block.source.url;
	return `data:${block.source.media_type};base64,${block.source.data}`;
}

const attachments = $derived(
	blocks.filter(
		(block): block is AttachmentBlock =>
			isTextAttachment(block) || isImageAttachment(block),
	),
);

function openImagePreview(block: ImageBlock) {
	const imageBlocks = attachments.filter(isImageAttachment);
	const index = Math.max(0, imageBlocks.indexOf(block));
	mediaLightbox.show(
		imageBlocks.map((item, itemIndex) => {
			const name = getFilename(item, itemIndex);
			return {
				src: getImageSrc(item),
				type: "image" as const,
				alt: name,
				filename: name,
			};
		}),
		index,
	);
}
</script>

{#if attachments.length > 0}
	<div class="flex flex-wrap gap-2">
		{#each attachments as block, index}
			{#if isTextAttachment(block)}
				<button
					type="button"
					class="group relative flex h-20 w-36 shrink-0 items-center overflow-hidden rounded-2xl border border-border-subtle bg-bg-content px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-bg-content"
					onclick={() => {
						previewTextBlock = block;
					}}
					title={m.attach_preview_file({}, { locale })}
					aria-label={m.attach_preview_named({ name: getFilename(block, index) }, { locale })}
				>
					<div class="min-w-0 flex-1 pr-4">
						<div class="truncate text-[12px] font-medium leading-4 text-text-primary" title={getFilename(block, index)}>{getFilename(block, index)}</div>
						<div class="mt-0.5 flex items-center gap-1.5 text-[10px] leading-3 text-text-tertiary">
							<span>{m.attach_text({}, { locale })}</span>
							{#if getSizeLabel(block)}
								<span aria-hidden="true">·</span>
								<span>{getSizeLabel(block)}</span>
							{/if}
						</div>
					</div>
					<ArrowUpRight class="absolute right-1.5 top-1.5 h-4 w-4 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
				</button>
			{:else if isImageAttachment(block)}
				<button
					type="button"
					class="group h-20 w-20 shrink-0 cursor-zoom-in overflow-hidden rounded-2xl border border-border-subtle bg-bg-hover/45 p-0 transition-colors hover:border-border-strong"
					onclick={() => openImagePreview(block)}
					title={m.attach_preview_image({}, { locale })}
					aria-label={m.attach_preview_named({ name: getFilename(block, index) }, { locale })}
				>
					<img src={getImageSrc(block)} alt={getFilename(block, index)} class="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]" />
				</button>
			{/if}
		{/each}
	</div>
{/if}

<Dialog
	open={previewTextBlock !== null}
	onClose={() => {
		previewTextBlock = null;
	}}
	title={previewTextBlock ? getFilename(previewTextBlock, 0) : m.attach_file_preview({}, { locale })}
	maxWidth="860px"
>
	{#if previewTextBlock}
		<div class="border-b border-border-subtle px-3 py-2 text-[11px] text-text-tertiary">
			{getSizeLabel(previewTextBlock)}
		</div>
		<pre class="max-h-[62vh] overflow-auto whitespace-pre-wrap break-words bg-bg-content px-4 py-3 text-[12px] leading-5 text-text-secondary"><code>{getAttachmentBody(previewTextBlock)}</code></pre>
	{/if}
</Dialog>
