<script lang="ts">
import { onDestroy, type Snippet } from "svelte";
import { ensureThemeCss } from "$lib/custom-theme/theme-css.svelte";
import {
	applyThemeIsland,
	compileThemeIsland,
	isThemeIslandSupported,
} from "$lib/custom-theme/theme-island";
import { spaceThemeCss, userTheme } from "$lib/custom-theme/user-theme.svelte";
import { getResolvedTheme } from "$lib/theme.svelte";

const { spaceId, children }: { spaceId: string; children: Snippet } = $props();

const supported = isThemeIslandSupported();
const spaceCss = $derived(supported ? spaceThemeCss(spaceId) : null);
const css = $derived(
	spaceCss === null
		? null
		: compileThemeIsland(
				spaceCss,
				spaceId === userTheme.spaceId ? null : userTheme.css,
			),
);
const active = $derived(css !== null);

$effect(() => ensureThemeCss(spaceId));
$effect(() => applyThemeIsland(css, spaceId));
onDestroy(() => applyThemeIsland(null, spaceId));
</script>

<div
	class="flex min-h-0 min-w-0 flex-1 flex-col text-text-primary"
	data-theme-island={active ? spaceId : undefined}
	data-theme={active ? getResolvedTheme() : undefined}
	data-space-id={active ? spaceId : undefined}
	data-cohub-space-style-active={active ? "true" : undefined}
>
	{@render children()}
</div>
