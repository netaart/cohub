<script lang="ts">
import type { AppRecord } from "@neta-art/cohub";
import { Eye } from "lucide-svelte";
import type { Snippet } from "svelte";
import { page } from "$app/state";
import { appDisplayTitle } from "$lib/app-page-meta";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import { formatCompactNumber, formatNumber } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { resolvePublicLocale } from "$lib/i18n/public-locale";
import { m } from "$lib/paraglide/messages.js";

export type CohubBarSpace = {
	id: string;
	slug: string | null;
	name: string | null;
	publicProfile?: { avatarUrl: string | null } | null;
};

export type CohubBarOwner = {
	username: string | null;
	displayName: string;
	avatarUrl?: string | null;
} | null;

type Props = {
	app: Pick<AppRecord, "slug" | "meta">;
	space?: CohubBarSpace | null;
	/** Author identity to credit ("Published by"): the App publisher, or the Space owner when unknown. */
	publisher?: CohubBarOwner;
	/** All-time view count; null hides the stat instead of rendering 0. */
	totalViews?: number | null;
	/** Extra controls rendered before the stats (e.g. version switcher). */
	actions?: Snippet;
};

const {
	app,
	space = null,
	publisher = null,
	totalViews = null,
	actions = undefined,
}: Props = $props();

const locale = $derived(getLocale());
// Brand link follows the page's URL locale, exactly like the public header.
const zh = $derived(resolvePublicLocale(page.url.pathname) === "zh-CN");
const homeHref = $derived(zh ? "/zh" : "/");
const homeLabel = $derived(
	m.head_home_aria({}, { locale: zh ? "zh-CN" : "en" }),
);
const spaceName = $derived(space?.name || space?.slug || "Space");
const appTitle = $derived(appDisplayTitle(app?.meta, app?.slug ?? "App"));
const publisherName = $derived(publisher?.displayName ?? "Cohub");
const publisherAvatarUrl = $derived(publisher?.avatarUrl?.trim() || null);
const totalViewsText = $derived(
	typeof totalViews === "number" && totalViews > 0
		? formatCompactNumber(totalViews, locale)
		: null,
);
const totalViewsTitle = $derived(
	totalViewsText
		? m.app_stats_total_views_title(
				{ count: formatNumber(totalViews ?? 0, locale) },
				{ locale },
			)
		: "",
);
</script>

<!--
  Public App chrome. It renders in flow above the App rather than overlaying
  it, so the App's own viewport is exactly what the viewer can see — no
  controls hidden under the bar. See `AppSurface` for the height contract.
-->
<header
	class="cohub-bar relative z-40 flex shrink-0 items-center gap-3 border-b border-border-subtle bg-bg-primary px-3 text-[11px] text-text-tertiary sm:px-4"
>
	<div class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
		<a
			href={homeHref}
			class="flex shrink-0 items-center gap-1.5 transition-opacity hover:opacity-80"
			aria-label={homeLabel}
		>
			<img
				src="/favicon.svg"
				alt="Cohub"
				class="block h-5 w-5 shrink-0 rounded-[5px]"
			/>
			<span class="text-[13px] font-semibold tracking-tight text-text-primary"
				>Cohub</span
			>
		</a>
		<div class="hidden h-4 w-px shrink-0 bg-border-subtle sm:block"></div>
		<div class="flex min-w-0 items-center gap-2 overflow-hidden">
			<SpaceAvatar
				name={spaceName}
				profile={space?.publicProfile}
				size="xs"
				class="translate-y-0"
			/>
			<span class="min-w-0 truncate font-medium leading-none text-text-secondary"
				>{spaceName}</span
			>
			<span class="hidden shrink-0 leading-none text-text-tertiary sm:inline"
				>/</span
			>
			<span
				class="hidden min-w-0 truncate font-medium leading-none text-text-primary sm:inline"
				>{appTitle}</span
			>
		</div>
	</div>
	{#if actions}
		<div class="shrink-0">
			{@render actions()}
		</div>
		<div class="hidden h-4 w-px shrink-0 bg-border-subtle sm:block"></div>
	{/if}
	<div class="flex min-w-0 shrink-0 items-center gap-2 overflow-hidden">
		{#if totalViewsText}
			<span
				class="flex shrink-0 items-center gap-1.5 text-text-tertiary"
				title={totalViewsTitle}
			>
				<Eye class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="font-mono leading-none tabular-nums">{totalViewsText}</span>
				<span class="sr-only">{totalViewsTitle}</span>
			</span>
			<div class="hidden h-4 w-px shrink-0 bg-border-subtle sm:block"></div>
		{/if}
		<span class="hidden shrink-0 leading-none text-text-tertiary md:inline"
			>Published by</span
		>
		<UserIdentity
			name={publisherName}
			avatarUrl={publisherAvatarUrl}
			username={publisher?.username}
			size="xs"
			class="min-w-0 text-text-secondary"
			avatarClass="h-5 w-5 rounded-full bg-bg-elevated text-[8px]"
			nameClass="hidden max-w-32 truncate font-medium leading-none sm:inline"
		/>
	</div>
</header>

<style>
	/*
	 * The bar owns the top safe area (notch / status bar): it grows instead of
	 * pushing its own content under the inset, and the App below absorbs the
	 * difference because the surface is a flex column.
	 */
	.cohub-bar {
		padding-top: env(safe-area-inset-top, 0px);
		min-height: calc(3rem + env(safe-area-inset-top, 0px));
	}
</style>
