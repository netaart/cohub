<script lang="ts">
import { AudioLines, Box, Image, Scale, Sparkles, Video } from "lucide-svelte";
import type { GenerationCategoryKey } from "#lib/generation-model-catalog.ts";

const {
	category,
	class: className = "h-3.5 w-3.5",
}: { category: GenerationCategoryKey; class?: string } = $props();

const ICONS = {
	image: Image,
	video: Video,
	audio: AudioLines,
	"3d": Box,
	decision: Scale,
	other: Sparkles,
} satisfies Record<GenerationCategoryKey, typeof Image>;

const Icon = $derived(ICONS[category]);
</script>

<Icon class={className} aria-hidden="true" />
