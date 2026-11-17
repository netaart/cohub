<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { mediaPreviewCandidates } from "@neta-art/cohub/media";
import { mediaLightbox } from "#lib/components/media-lightbox.svelte.ts";
import { recordedSize, screenVariantSize } from "#lib/media/media-info.ts";
import MediaImage from "#lib/resource-kit/MediaImage.svelte";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

type Props = {
	blocks: ImageBlock[];
};

const { blocks }: Props = $props();

function getImagePreviewSrc(block: ImageBlock): string {
	if (block.source.type === "url") return block.source.url;
	return `data:${block.source.media_type};base64,${block.source.data}`;
}

const tileSize = screenVariantSize(224);

function getImageAlt(block: ImageBlock, index: number): string {
	return String(block._meta?.filename ?? `attachment-${index + 1}`);
}
</script>

{#if blocks.length > 0}
	<div class="grid grid-cols-2 gap-2 max-w-md">
		{#each blocks as block, index}
			<button
				type="button"
				class="group overflow-hidden rounded-2xl border border-border-subtle bg-bg-content p-0 cursor-zoom-in"
				onclick={() => {
					const gallery = blocks.map((b, i) => ({
						src: getImagePreviewSrc(b),
						type: "image" as const,
						alt: getImageAlt(b, i),
						...recordedSize(b._meta),
					}));
					mediaLightbox.show(gallery, index);
				}}
			>
				<MediaImage
					candidates={mediaPreviewCandidates({ type: "image", url: getImagePreviewSrc(block) }, { size: tileSize, fit: "cover" })}
					alt={getImageAlt(block, index)}
					class="h-36 w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
				/>
			</button>
		{/each}
	</div>
{/if}
