<script lang="ts">
import { provideSettingsPageActive } from "$lib/features/settings/page-context.svelte";
import { loadSettingsPage, settingsPage } from "$lib/features/settings/pages";
import { scrollListToTop } from "$lib/layout/list-scroll-top";
import type { SettingsSection } from "$lib/settings-nav";

const {
	section,
	active = true,
}: {
	section: SettingsSection;
	active?: boolean;
} = $props();

provideSettingsPageActive(() => active);

const Page = $derived(settingsPage(section));
let scroller = $state<HTMLDivElement | null>(null);

$effect(() => {
	if (Page) return;
	// Tracked so a chunk that failed off screen is retried once in view.
	void active;
	void loadSettingsPage(section).catch(() => undefined);
});

export function scrollToTop() {
	scrollListToTop(scroller);
}
</script>

<div
	bind:this={scroller}
	class="scrollbar-quiet flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain"
>
	{#if Page}<Page />{/if}
</div>
