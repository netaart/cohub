<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import EntityIcon from "$lib/components/EntityIcon.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { requestListScrollTop } from "$lib/layout/list-scroll-top";
import {
	LIBRARY_ENTITIES,
	type LibraryEntity,
	libraryEntityAt,
	libraryHref,
} from "$lib/library-routes";
import { m } from "$lib/paraglide/messages.js";
import { libraryEntityLabel } from "./library-copy";

const { variant }: { variant: "sidebar" | "rail" | "header" } = $props();

const locale = $derived(getLocale());
const current = $derived(libraryEntityAt(page.url.pathname));

function open(event: MouseEvent, entity: LibraryEntity) {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
		return;
	event.preventDefault();
	if (current === entity) requestListScrollTop();
	else void goto(libraryHref(entity), { keepFocus: true, noScroll: true });
}
</script>

<nav
	class={variant === "rail"
		? "mt-2 flex flex-col items-center gap-1"
		: variant === "sidebar"
			? "mx-1.5 mt-1 grid shrink-0 grid-cols-3 gap-0.5 rounded-[7px] bg-bg-surface p-0.5"
			: "flex min-w-0 items-center gap-4"}
	aria-label={m.nav_tab_library({}, { locale })}
>
	{#each LIBRARY_ENTITIES as entity (entity)}
		{@const label = libraryEntityLabel(entity, locale)}
		{@const active = current === entity}
		<a
			href={libraryHref(entity)}
			aria-current={active ? "page" : undefined}
			title={variant === "rail" ? label : undefined}
			aria-label={variant === "rail" ? label : undefined}
			onclick={(event) => open(event, entity)}
			class={variant === "rail"
				? `flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors duration-100 ${active ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"}`
				: variant === "sidebar"
					? `flex h-7 min-w-0 items-center justify-center rounded-[5px] px-1.5 text-[12px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 ${active ? "bg-bg-primary font-medium text-text-primary shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-text-tertiary hover:text-text-secondary"}`
					: `shrink-0 truncate text-[15px] tracking-tight transition-colors duration-100 ${active ? "font-semibold text-text-primary" : "font-medium text-text-tertiary hover:text-text-secondary"}`}
		>
			{#if variant === "rail"}
				<EntityIcon name={entity} class="h-4 w-4" />
			{:else}
				<span class="truncate">{label}</span>
			{/if}
		</a>
	{/each}
</nav>
