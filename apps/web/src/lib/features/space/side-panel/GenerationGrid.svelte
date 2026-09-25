<script lang="ts">
import {
	type GenerationOutputType,
	type GenerationTaskOutput,
	type GenerationTaskView,
	generationOutputSource,
	type TaskRunRecord,
} from "@neta-art/cohub";
import { taskRunToBoardTaskSnapshot } from "@neta-art/cohub/board";
import { type MediaItem, mediaLightbox } from "$lib/components/media-lightbox";
import { setCohubResourceDragData } from "$lib/drag/cohub-resource-drag";
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

type GridItem = {
	key: string;
	task: GenerationTaskView;
	output: GenerationTaskOutput | null;
};

let openingKey = $state<string | null>(null);
let audio = $state<{ key: string; src: string } | null>(null);

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

function lightboxItem(item: GridItem, src: string): MediaItem {
	return {
		src,
		type: item.output?.type === "video" ? "video" : "image",
		alt: item.task.prompt ?? undefined,
		poster: item.output?.previewUrl ?? undefined,
	};
}

async function resolveSource(item: GridItem) {
	const output = item.output;
	if (!output) return null;
	if (output.url) return output.url;
	const inline = generationOutputSource(
		resolveRun(item.task.id)?.result,
		output.index,
	);
	if (inline || !output.deferred) return inline;
	openingKey = item.key;
	try {
		return await resolveGenerationOutputSource(item.task.id, output.index);
	} catch {
		return null;
	} finally {
		if (openingKey === item.key) openingKey = null;
	}
}

async function activate(item: GridItem) {
	const output = item.output;
	if (!output || output.type === "text") {
		onOpenTask(item.task.id);
		return;
	}
	if (output.type === "audio") {
		if (audio?.key === item.key) return;
		const src = await resolveSource(item);
		if (src) audio = { key: item.key, src };
		else onOpenTask(item.task.id);
		return;
	}
	if (!output.url) {
		const src = await resolveSource(item);
		if (src) mediaLightbox.show(lightboxItem(item, src));
		else onOpenTask(item.task.id);
		return;
	}
	const visual = items.filter(
		(candidate) =>
			(candidate.output?.type === "image" ||
				candidate.output?.type === "video") &&
			candidate.output.url,
	);
	mediaLightbox.show(
		visual.map((candidate) =>
			lightboxItem(candidate, candidate.output?.url as string),
		),
		Math.max(
			0,
			visual.findIndex((candidate) => candidate.key === item.key),
		),
	);
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
	<div class="generation-grid">
		{#each items as item (item.key)}
			<GenerationTile
				task={item.task}
				output={item.output}
				{draggable}
				opening={openingKey === item.key}
				audioSrc={audio?.key === item.key ? audio.src : null}
				onActivate={() => void activate(item)}
				onOpenTask={() => onOpenTask(item.task.id)}
				onCloseAudio={() => (audio = null)}
				onDragStart={(event) => dragStart(event, item)}
			/>
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
