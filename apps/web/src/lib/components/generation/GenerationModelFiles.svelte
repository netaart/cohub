<script lang="ts">
import { mediaPreviewCandidates } from "@neta-art/cohub/media";
import { Box, Download, Rotate3d } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { createLazyModuleLoader } from "$lib/lazy-module";
import {
	type GenerationModelOutput,
	previewableModelFormat,
	remoteModelSource,
} from "$lib/model3d/remote";
import { m } from "$lib/paraglide/messages.js";
import MediaImage from "$lib/resource-kit/MediaImage.svelte";

const loadModelPreview = createLazyModuleLoader(
	() => import("$lib/components/ModelPreview.svelte"),
);

const POSTER_SIZE = 768;

const { models }: { models: readonly GenerationModelOutput[] } = $props();

const locale = $derived(getLocale());
let selectedUrl = $state<string | null>(null);
let viewing = $state(false);

const firstPreviewable = $derived(
	models.find((model) => previewableModelFormat(model.format)) ?? null,
);
const active = $derived(
	models.find((model) => model.url === selectedUrl) ??
		firstPreviewable ??
		models[0],
);
const source = $derived(active ? remoteModelSource(active) : null);
const poster = $derived(
	active?.previewUrl ?? models.find((model) => model.previewUrl)?.previewUrl,
);

function select(model: GenerationModelOutput) {
	selectedUrl = model.url;
	viewing = true;
}
</script>

{#if active}
	<div class="model-files">
		<div class="model-stage">
			{#if viewing && source}
				{#await loadModelPreview()}
					<span class="stage-placeholder"><Box class="h-6 w-6" /></span>
				{:then module}
					{@const ModelPreview = module.default}
					<ModelPreview {source} downloadUrl={active.url} downloadName={active.name} />
				{:catch}
					<p class="stage-placeholder text-xs">{m.model3d_preview_failed({}, { locale })}</p>
				{/await}
			{:else}
				<MediaImage
					candidates={mediaPreviewCandidates({ type: "3d", previewUrl: poster }, { size: POSTER_SIZE })}
					alt={active.name}
					class="h-full w-full object-contain"
				>
					{#snippet fallback()}
						<span class="stage-placeholder"><Box class="h-6 w-6" /></span>
					{/snippet}
				</MediaImage>
				{#if source}
					<button type="button" class="secondary-key view-key" onclick={() => (viewing = true)}>
						<Rotate3d class="h-3.5 w-3.5" />
						{m.model3d_view({}, { locale })}
					</button>
				{/if}
			{/if}
		</div>
		<ul class="file-list" aria-label={m.model3d_files({}, { locale })}>
			{#each models as model (model.url)}
				{@const previewable = previewableModelFormat(model.format) !== null}
				<li class="file-row">
					{#if previewable}
						<button
							type="button"
							class="file-name"
							aria-pressed={viewing && model.url === active.url}
							title={m.model3d_view_file({ name: model.name }, { locale })}
							onclick={() => select(model)}
						>
							<Rotate3d class="h-3.5 w-3.5 shrink-0" />
							<span class="truncate">{model.name}</span>
						</button>
					{:else}
						<span class="file-name">
							<Box class="h-3.5 w-3.5 shrink-0" />
							<span class="truncate">{model.name}</span>
						</span>
					{/if}
					{#if model.format}<span class="file-format">{model.format}</span>{/if}
					<a
						class="file-download"
						href={model.url}
						download={model.name}
						target="_blank"
						rel="noreferrer"
						title={m.download({}, { locale })}
						aria-label={`${m.download({}, { locale })} ${model.name}`}
					>
						<Download class="h-3.5 w-3.5" />
					</a>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.model-files {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 32rem;
	}
	.model-stage {
		position: relative;
		display: flex;
		aspect-ratio: 1;
		max-height: min(60vh, 32rem);
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-elevated);
	}
	.stage-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-placeholder);
	}
	.view-key {
		position: absolute;
		bottom: 10px;
		left: 50%;
		display: inline-flex;
		height: 30px;
		align-items: center;
		gap: 6px;
		padding: 0 12px;
		font-size: 12px;
		transform: translateX(-50%);
	}
	.file-list {
		display: flex;
		flex-direction: column;
	}
	.file-row {
		display: flex;
		min-height: 30px;
		align-items: center;
		gap: 8px;
		border-radius: 6px;
		padding: 0 4px 0 8px;
		font-size: 12px;
		color: var(--text-secondary);
	}
	.file-row:hover { background: var(--bg-hover); }
	.file-name {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 6px;
		text-align: left;
	}
	button.file-name:hover { color: var(--text-primary); }
	button.file-name[aria-pressed="true"] { color: var(--brand); }
	.file-name:focus-visible, .file-download:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.file-format {
		flex: none;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		color: var(--text-placeholder);
	}
	.file-download {
		display: inline-flex;
		width: 26px;
		height: 26px;
		flex: none;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		color: var(--text-tertiary);
		transition: background-color 100ms ease, color 100ms ease;
	}
	.file-download:hover { background: var(--bg-hover-strong); color: var(--text-primary); }
	@media (pointer: coarse) {
		.file-row { min-height: 40px; }
		.file-download { width: 36px; height: 36px; }
	}
</style>
