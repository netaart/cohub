<script lang="ts">
import { modelFormatForPath } from "@cohub/protocol/fs";
import { Box, ExternalLink } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { createLazyModuleLoader } from "$lib/lazy-module";
import {
	createModelSource,
	fetchModelBytes,
	remoteReferences,
} from "$lib/model3d/source";
import { m } from "$lib/paraglide/messages.js";

const loadModelPreview = createLazyModuleLoader(
	() => import("$lib/components/ModelPreview.svelte"),
);

const { url, index }: { url: string; index: number } = $props();

const locale = $derived(getLocale());
const format = $derived(modelFormatForPath(url));
const downloadName = $derived(
	format ? `model-${index + 1}.${format}` : `model-${index + 1}`,
);
const source = $derived(
	format
		? createModelSource({
				key: url,
				name: downloadName,
				format,
				size: null,
				read: (options) => fetchModelBytes(url, options),
				references: () => remoteReferences(url),
			})
		: null,
);
</script>

{#if source}
	{#await loadModelPreview() then module}
		{@const ModelPreview = module.default}
		<ModelPreview {source} downloadUrl={url} {downloadName} />
	{:catch}
		<p class="text-xs text-text-tertiary">{m.model3d_preview_failed({}, { locale })}</p>
	{/await}
{:else}
	<a
		class="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs text-text-secondary hover:text-text-primary"
		href={url}
		target="_blank"
		rel="noreferrer"
	>
		<Box class="h-3.5 w-3.5 shrink-0" />
		<span class="truncate">{downloadName}</span>
		<ExternalLink class="h-3 w-3 shrink-0" />
	</a>
{/if}
