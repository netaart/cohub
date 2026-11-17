<script lang="ts">
import { onDestroy } from "svelte";
import { applyDocumentTheme } from "#lib/custom-theme/document-themes.ts";
import { getLentThemeSpace } from "#lib/custom-theme/page-space.svelte.ts";
import { ensureThemeCss } from "#lib/custom-theme/theme-css.svelte.ts";
import {
	spaceThemeCss,
	userTheme,
} from "#lib/custom-theme/user-theme.svelte.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";

const { spaceId: routeSpaceId }: { spaceId: string | null } = $props();

const spaceId = $derived(routeSpaceId ?? getLentThemeSpace());

const userCss = $derived(spaceId === userTheme.spaceId ? null : userTheme.css);
const spaceCss = $derived(spaceId ? spaceThemeCss(spaceId) : null);

$effect(() => userTheme.resolve(authStore.userUuid));
$effect(() => {
	if (userTheme.spaceId) ensureThemeCss(userTheme.spaceId);
});
$effect(() => {
	if (spaceId) ensureThemeCss(spaceId);
});
$effect(() => applyDocumentTheme("user", userCss));
$effect(() => applyDocumentTheme("space", spaceCss, spaceId));

onDestroy(() => {
	applyDocumentTheme("user", null);
	applyDocumentTheme("space", null);
});
</script>
