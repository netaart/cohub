<script lang="ts">
import {
	type GenerationOutputType,
	type GenerationTaskOutput,
	type GenerationTaskView,
	generationOutputSource,
	type TaskRunRecord,
} from "@neta-art/cohub";
import { taskRunToBoardTaskSnapshot } from "@neta-art/cohub/board";
import { SvelteSet } from "svelte/reactivity";
import { inScrollView } from "$lib/actions/in-scroll-view";
import { type MediaItem, mediaLightbox } from "$lib/components/media-lightbox";
import { setCohubResourceDragData } from "$lib/drag/cohub-resource-drag";
import { screenVariantSize } from "$lib/media/media-info";
import GenerationTile from "./GenerationTile.svelte";
import { resolveGenerationOutputSource } from "./generation-feed.svelte";

type Props = {
	tasks: GenerationTaskView[];
	/** Queued, running, and failed tasks show only without a type filter. */
	typeFilter?: GenerationOutputType | "all";
	draggable?: boolean;
	resolveRun: (taskRunId: string) => TaskRunRecord | undefined;
	onOpenTask: (taskRunId: string) => void;
};

const {
	tasks,
	typeFilter = "all",
	draggable = true,
	resolveRun,
	onOpenTask,
}: Props = $props();

const MIN_TILE_PX = 88;
const GAP_PX = 4;
/** Rows per virtualized chunk; offscreen chunks keep only their height. */
const CHUNK_ROWS = 6;

type GridItem = {
	key: string;
	task: GenerationTaskView;
	output: GenerationTaskOutput | null;
};

const items = $derived.by(() =>
	tasks.flatMap((task): GridItem[] => {
		if (task.status !== "completed") {
			return typeFilter === "all" ? [{ key: task.id, task, output: null }] : [];
		}
		return task.outputs
			.filter((output) => typeFilter === "all" || output.type === typeFilter)
			.map((output) => ({ key: `${task.id}:${output.index}`, task, output }));
	}),
);

type MediaGridItem = GridItem & {
	output: GenerationTaskOutput & { type: MediaItem["type"] };
};

function isMedia(item: GridItem): item is MediaGridItem {
	const type = item.output?.type;
	return type === "image" || type === "video" || type === "audio";
}

/** Inline payloads live on the run; deferred ones need the run detail. */
function resolveSource({ task, output }: MediaGridItem) {
	const inline = generationOutputSource(
		resolveRun(task.id)?.result,
		output.index,
	);
	if (inline || !output.deferred) return Promise.resolve(inline);
	return resolveGenerationOutputSource(task.id, output.index);
}

function mediaItem(item: MediaGridItem): MediaItem {
	const { task, output } = item;
	return {
		type: output.type,
		src: output.url ?? undefined,
		resolve: output.url ? undefined : () => resolveSource(item),
		alt: output.title ?? task.prompt ?? undefined,
		poster: output.previewUrl ?? undefined,
		title: task.prompt ?? undefined,
		subtitle: task.model ?? undefined,
		mimeType: output.mimeType ?? undefined,
		width: output.width ?? undefined,
		height: output.height ?? undefined,
		onDetails: () => onOpenTask(task.id),
	};
}

/** Media opens in one gallery that follows the grid order and filter. */
function activate(item: GridItem) {
	if (!isMedia(item)) {
		onOpenTask(item.task.id);
		return;
	}
	const gallery = items.filter(isMedia);
	mediaLightbox.show(gallery.map(mediaItem), gallery.indexOf(item));
}

// Geometry mirrors `repeat(auto-fill, minmax(88px, 1fr))`, so a placeholder
// chunk is exactly as tall as the tiles it stands in for.
let width = $state(0);
const columns = $derived(
	Math.max(1, Math.floor((width + GAP_PX) / (MIN_TILE_PX + GAP_PX))),
);
const tilePx = $derived(
	width > 0 ? (width - GAP_PX * (columns - 1)) / columns : MIN_TILE_PX,
);
const previewSize = $derived(screenVariantSize(tilePx));
const chunks = $derived.by(() => {
	const size = columns * CHUNK_ROWS;
	return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
		items.slice(index * size, (index + 1) * size),
	);
});
// Two chunks cover a tall panel on first paint, before the observer reports.
const visibleChunks = new SvelteSet<number>([0, 1]);

function chunkHeight(count: number) {
	const rows = Math.ceil(count / columns);
	return rows * tilePx + (rows - 1) * GAP_PX;
}

function trackChunk(index: number) {
	return (visible: boolean) => {
		if (visible) visibleChunks.add(index);
		else visibleChunks.delete(index);
	};
}

function dragStart(event: DragEvent, item: GridItem) {
	const run = resolveRun(item.task.id);
	if (!run) {
		event.preventDefault();
		return;
	}
	const uri = `cohub://tasks/${run.id}`;
	setCohubResourceDragData(
		event.dataTransfer,
		{
			version: 1,
			resources: [
				{
					type: "task",
					ref: run.id,
					taskRunId: run.id,
					snapshot: taskRunToBoardTaskSnapshot(run),
				},
			],
			origin: { kind: "side-panel" },
			createdAt: Date.now(),
		},
		{ cohubPath: uri, plainText: uri, effectAllowed: "copy" },
	);
}
</script>

{#if items.length > 0}
	<div class="flex flex-col gap-1" bind:clientWidth={width}>
		{#each chunks as chunk, index (index)}
			<div
				class="generation-grid"
				style:height={visibleChunks.has(index) ? undefined : `${chunkHeight(chunk.length)}px`}
				use:inScrollView={trackChunk(index)}
			>
				{#if visibleChunks.has(index)}
					{#each chunk as item (item.key)}
						<GenerationTile
							task={item.task}
							output={item.output}
							{previewSize}
							{draggable}
							onActivate={() => activate(item)}
							onOpenTask={() => onOpenTask(item.task.id)}
							onDragStart={(event) => dragStart(event, item)}
						/>
					{/each}
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.generation-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
		gap: 4px;
	}
</style>
