<script lang="ts">
import { mediaPreviewCandidates } from "@neta-art/cohub/media";
import { AudioLines, Film, Image as ImageIcon } from "lucide-svelte";
import type { MediaItem } from "#lib/components/media-lightbox.svelte.ts";
import { screenVariantSize } from "#lib/media/media-info.ts";
import MediaImage from "#lib/resource-kit/MediaImage.svelte";

const {
	items,
	index,
	label,
	onselect,
}: {
	items: readonly MediaItem[];
	index: number;
	label: string;
	onselect: (index: number) => void;
} = $props();

const size = screenVariantSize(44);
let stripEl = $state<HTMLDivElement | null>(null);

function candidates(item: MediaItem) {
	return mediaPreviewCandidates(
		{
			type: item.type,
			url: item.src,
			previewUrl: item.poster,
			width: item.width,
			height: item.height,
		},
		{ size, fit: "cover" },
	);
}

$effect(() => {
	const strip = stripEl;
	const thumb = strip?.querySelectorAll<HTMLElement>("[data-thumb]")[index];
	if (!strip || !thumb) return;
	strip.scrollLeft =
		thumb.offsetLeft - (strip.clientWidth - thumb.offsetWidth) / 2;
});
</script>

<div bind:this={stripEl} class="filmstrip overflow-x-auto overscroll-x-contain" role="group" aria-label={label}>
	<div class="mx-auto flex w-max gap-1.5 px-1 py-1">
		{#each items as item, slot (slot)}
			{@const active = slot === index}
			<button
				type="button"
				data-thumb
				class="thumb relative h-11 w-11 shrink-0 overflow-hidden rounded-md bg-overlay-control"
				class:active
				aria-current={active ? "true" : undefined}
				aria-label={`${slot + 1} / ${items.length}${item.title ? ` · ${item.title}` : ""}`}
				title={item.title}
				onclick={() => onselect(slot)}
			>
				<MediaImage candidates={candidates(item)} alt="" class="h-full w-full object-cover">
					{#snippet fallback()}
						<span class="flex h-full w-full items-center justify-center text-overlay-control-text opacity-60">
							{#if item.type === "video"}
								<Film class="h-4 w-4" />
							{:else if item.type === "audio"}
								<AudioLines class="h-4 w-4" />
							{:else}
								<ImageIcon class="h-4 w-4" />
							{/if}
						</span>
					{/snippet}
				</MediaImage>
			</button>
		{/each}
	</div>
</div>

<style>
	.filmstrip {
		scrollbar-width: none;
	}

	.filmstrip::-webkit-scrollbar {
		display: none;
	}

	.thumb {
		opacity: 0.5;
		transition: opacity 120ms var(--ease-out);
	}

	.thumb.active {
		opacity: 1;
		outline: 2px solid var(--overlay-control-text);
		outline-offset: 1px;
	}

	@media (hover: hover) {
		.thumb:not(.active):hover {
			opacity: 0.85;
		}
	}

	.thumb:focus-visible {
		opacity: 1;
		outline: 2px solid var(--overlay-control-text);
		outline-offset: 1px;
	}
</style>
