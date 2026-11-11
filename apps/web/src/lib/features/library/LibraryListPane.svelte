<script lang="ts">
import type { UserAppListItem, UserCronJobListItem } from "@neta-art/cohub";
import {
	Check,
	Clock,
	Link2,
	PanelRight,
	Pause,
	Play,
	Trash2,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import { appDisplayTitle } from "$lib/app-page-meta";
import AppIcon from "$lib/components/app/AppIcon.svelte";
import ListRow from "$lib/components/list-page/ListRow.svelte";
import ListRowSkeleton from "$lib/components/list-page/ListRowSkeleton.svelte";
import ListRowText from "$lib/components/list-page/ListRowText.svelte";
import {
	type FixedListRowDensity,
	LIST_ROW_AVATAR,
	LIST_ROW_HEIGHT,
} from "$lib/components/list-page/list-row";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import SidebarActionButton from "$lib/components/sidebar/SidebarActionButton.svelte";
import { buildSpaceAppWindowRoute } from "$lib/features/space/modules/window-route";
import { dispatchCronjobsUpdated } from "$lib/features/space/resources/space-cronjobs-feed.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { scrollListToTop } from "$lib/layout/list-scroll-top";
import { scrollMemory } from "$lib/layout/scroll-memory";
import { type LibraryItemEntity, libraryItemHref } from "$lib/library-routes";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceAppRoute, buildSpaceCronjobRoute } from "$lib/space-routes";
import { formatCompactAbsoluteTime } from "$lib/time-format";
import { type LibraryItem as Item, libraryInbox } from "./library-inbox.svelte";

const {
	entity,
	filter,
	variant,
	split,
	active,
	selectedId,
}: {
	entity: LibraryItemEntity;
	filter: string;
	variant: "sidebar" | "page";
	split: boolean;
	active: boolean;
	selectedId: string | null;
} = $props();

const OVERSCAN_ROWS = 6;
const LOAD_MORE_ROWS = 8;

const locale = $derived(getLocale());
const density = $derived<FixedListRowDensity>(
	variant === "page" ? "comfortable" : "compact",
);
const rowHeight = $derived(LIST_ROW_HEIGHT[density]);
const isApps = $derived(entity === "apps");
const view = $derived(libraryInbox.view(entity, filter));
const items = $derived(view.items);

let scroller = $state<HTMLDivElement | null>(null);
let scrollTop = $state(0);
let viewportHeight = $state(600);
let busyId = $state<string | null>(null);
let copiedId = $state<string | null>(null);
let actionError = $state("");

const start = $derived(
	Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS),
);
const end = $derived(
	Math.min(
		items.length,
		Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS,
	),
);
const visible = $derived(items.slice(start, end));

export function scrollToTop() {
	scrollListToTop(scroller);
}

function onScroll(event: Event) {
	const element = event.currentTarget as HTMLElement;
	scrollTop = element.scrollTop;
	if (
		active &&
		element.scrollHeight - element.scrollTop - element.clientHeight <
			rowHeight * LOAD_MORE_ROWS
	)
		void libraryInbox.loadMore(entity, filter);
}

function hrefOf(item: Item) {
	const spaceId = item.spaceId as string;
	if (!split)
		return isApps
			? buildSpaceAppRoute(spaceId, item.id)
			: buildSpaceCronjobRoute(spaceId, item.id);
	return libraryItemHref(entity, spaceId, item.id);
}

function canOpen(item: Item) {
	return Boolean(item.spaceId) && !lostAccess(item);
}

function open(event: MouseEvent, item: Item) {
	if (
		!split ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.button !== 0
	)
		return;
	event.preventDefault();
	void goto(hrefOf(item), { keepFocus: true, noScroll: true });
}

function lostAccess(item: Item) {
	return !isApps && (item as UserCronJobListItem).access === "lost";
}

function canRun(app: UserAppListItem) {
	return Boolean(app.spaceId) && app.status === "published";
}

function hasActions(item: Item) {
	if (isApps) return canRun(item as UserAppListItem);
	return split || lostAccess(item);
}

function overlaid(item: Item) {
	return split && hasActions(item) && !lostAccess(item);
}

async function act(id: string, run: () => Promise<unknown>) {
	if (busyId) return;
	busyId = id;
	actionError = "";
	try {
		await run();
	} catch {
		actionError = m.library_action_failed({}, { locale });
	} finally {
		busyId = null;
	}
}

function toggleCronJob(job: UserCronJobListItem) {
	const enabled = !job.enabled;
	return act(job.id, async () => {
		const { job: saved } = await sdk.cronJobs.toggle(job.id, enabled);
		libraryInbox.setCronJobEnabled(job.id, saved.enabled);
		if (job.spaceId) dispatchCronjobsUpdated(job.spaceId);
	});
}

function deleteCronJob(job: UserCronJobListItem) {
	if (!confirm(m.library_delete_confirm({ title: job.title }, { locale })))
		return;
	return act(job.id, async () => {
		await sdk.cronJobs.delete(job.id);
		libraryInbox.removeCronJob(job.id);
		if (job.spaceId) dispatchCronjobsUpdated(job.spaceId);
	});
}

async function copyLink(app: UserAppListItem) {
	if (!app.publicUrl) return;
	try {
		await navigator.clipboard.writeText(app.publicUrl);
		copiedId = app.id;
		setTimeout(() => {
			if (copiedId === app.id) copiedId = null;
		}, 1500);
	} catch {
		actionError = m.library_action_failed({}, { locale });
	}
}

function emptyCopy() {
	if (isApps)
		return {
			title: m.library_apps_empty({}, { locale }),
			hint: m.library_apps_empty_hint({}, { locale }),
		};
	return {
		title: m.library_cron_empty({}, { locale }),
		hint:
			filter === "attention"
				? m.library_cron_attention_empty_hint({}, { locale })
				: m.library_cron_empty_hint({}, { locale }),
	};
}
</script>

{#snippet spaceLabel(item: Item)}
	{#if item.space}
		<SpaceAvatar name={item.space.name} profile={item.space.publicProfile ?? null} seed={item.space.id} size="xxs" />
		<span class="truncate">{item.space.name}</span>
	{/if}
{/snippet}

{#snippet actions(item: Item)}
	{#if isApps}
		{@const app = item as UserAppListItem}
		<SidebarActionButton icon={PanelRight} title={m.resource_app_open({}, { locale })} label={`${m.resource_app_open({}, { locale })} ${appDisplayTitle(app.meta, app.slug)}`} onClick={() => void goto(buildSpaceAppWindowRoute(app.spaceId, app.id))} />
		{#if split && app.publicUrl}
			<SidebarActionButton icon={copiedId === app.id ? Check : Link2} title={m.library_copy_link({}, { locale })} onClick={() => void copyLink(app)} />
		{/if}
	{:else}
		{@const job = item as UserCronJobListItem}
		{@const lost = job.access === "lost"}
		{#if job.enabled || !lost}
			<SidebarActionButton
				icon={job.enabled ? Pause : Play}
				title={job.enabled ? m.cron_pause({}, { locale }) : m.cron_resume({}, { locale })}
				disabled={busyId === job.id}
				onClick={() => void toggleCronJob(job)}
			/>
		{/if}
		{#if lost}
			<SidebarActionButton icon={Trash2} tone="danger" title={m.common_delete({}, { locale })} disabled={busyId === job.id} onClick={() => void deleteCronJob(job)} />
		{/if}
	{/if}
{/snippet}

{#snippet body(item: Item)}
	{#if isApps}
		{@render appRow(item as UserAppListItem)}
	{:else}
		{@render cronRow(item as UserCronJobListItem)}
	{/if}
{/snippet}

{#snippet appRow(app: UserAppListItem)}
	{@const title = appDisplayTitle(app.meta, app.slug)}
	<ListRowText {title}>
		{#snippet meta()}
			<span class={overlaid(app) ? "group-hover/row:invisible group-focus-within/row:invisible" : ""}>
				{#if app.status === "disabled"}
					<span class="text-status-error">{m.library_apps_filter_disabled({}, { locale })}</span>
				{:else if app.updatedAt}
					{formatCompactAbsoluteTime(app.updatedAt)}
				{/if}
			</span>
		{/snippet}
		{#snippet subtitle()}
			<span class="flex min-w-0 items-center gap-1.5">
				{@render spaceLabel(app)}
				{#if app.visibility === "space"}
					<span class="shrink-0 text-text-placeholder">· {m.library_space_only({}, { locale })}</span>
				{/if}
			</span>
		{/snippet}
	</ListRowText>
{/snippet}

{#snippet cronRow(job: UserCronJobListItem)}
	<ListRowText title={job.title} tooltip={`${job.cronExpression} · ${job.timezone}`}>
		{#snippet meta()}
			<span class={overlaid(job) ? "group-hover/row:invisible group-focus-within/row:invisible" : ""}>
				{#if !job.enabled}
					{m.cron_paused({}, { locale })}
				{:else if job.nextRunAt}
					{m.library_next_run({ time: formatCompactAbsoluteTime(job.nextRunAt) }, { locale })}
				{/if}
			</span>
		{/snippet}
		{#snippet subtitle()}
			<span class="flex min-w-0 items-center gap-1.5">{@render spaceLabel(job)}</span>
		{/snippet}
		{#snippet status()}
			{#if job.access === "lost"}
				<span class="text-[11px] text-text-placeholder" title={m.library_no_access_hint({}, { locale })}>{m.library_no_access({}, { locale })}</span>
			{:else if job.lastRun?.status === "failed"}
				<span class="h-1.5 w-1.5 rounded-full bg-status-error" role="img" aria-label={m.library_last_run_failed({}, { locale })} title={m.library_last_run_failed({}, { locale })}></span>
			{/if}
		{/snippet}
	</ListRowText>
{/snippet}

{#if actionError}
<p role="alert" class="shrink-0 px-[var(--list-content-x)] pt-2 text-[12px] text-error-soft">{actionError}</p>
{/if}

<div
	bind:this={scroller}
	bind:clientHeight={viewportHeight}
	class="scrollbar-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain py-1.5"
	onscroll={onScroll}
	use:scrollMemory={{ key: `library:${variant}:${entity}:${filter}`, ready: items.length > 0, onRestore: (offset) => { scrollTop = offset; } }}
>
	{#if view.loading}
		<div class="px-[var(--list-gutter-x)]">
			<ListRowSkeleton {density} rows={6} label={m.common_loading({}, { locale })} />
		</div>
	{:else if view.error && items.length === 0}
		<div class="px-3 py-8 text-center">
			<p class="text-[12px] text-error-soft">{m.library_load_failed({}, { locale })}</p>
			<button type="button" class="mt-3 text-[12px] text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void libraryInbox.sync(entity, filter)}>{m.common_retry({}, { locale })}</button>
		</div>
	{:else if items.length === 0}
		{@const copy = emptyCopy()}
		<div class="flex flex-col items-center px-6 py-12 text-center">
			<p class="text-[13px] font-medium text-text-secondary">{copy.title}</p>
			<p class="mt-1 max-w-[260px] text-[12px] text-text-tertiary">{copy.hint}</p>
		</div>
	{:else}
		<ul class="relative mx-[var(--list-gutter-x)]" style:height={`${items.length * rowHeight}px`}>
			{#each visible as item, index (item.id)}
				{@const openable = canOpen(item)}
				<li class="absolute inset-x-0" style:top={`${(start + index) * rowHeight}px`}>
					<ListRow {density} active={item.id === selectedId} class="has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-brand/35">
						{#snippet leading()}
							{#if isApps}
								{@const app = item as UserAppListItem}
								<AppIcon meta={app.meta} slug={app.slug} seed={app.id} size={LIST_ROW_AVATAR[density]} />
							{:else}
								{@const job = item as UserCronJobListItem}
								<span class="flex aspect-square w-full items-center justify-center rounded-[28%] bg-bg-surface {job.enabled ? 'text-status-running' : 'text-text-placeholder'}">
									<Clock class="h-[42%] w-[42%]" />
								</span>
							{/if}
						{/snippet}
						{#if openable}
							<a
								href={hrefOf(item)}
								class="flex min-w-0 flex-1 self-stretch focus-visible:outline-none"
								aria-current={item.id === selectedId ? "page" : undefined}
								draggable="false"
								onclick={(event) => open(event, item)}
							>
								{@render body(item)}
							</a>
						{:else}
							<span class="flex min-w-0 flex-1 self-stretch">{@render body(item)}</span>
						{/if}
						{#snippet trailing()}
							{#if hasActions(item)}
								<span class={overlaid(item) ? "pointer-events-none absolute right-1.5 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100" : "inline-flex shrink-0 items-center gap-0.5"}>
									{@render actions(item)}
								</span>
							{/if}
						{/snippet}
					</ListRow>
				</li>
			{/each}
		</ul>
		{#if view.loadingMore}
			<div class="flex h-10 items-center justify-center text-[12px] text-text-placeholder">{m.common_loading({}, { locale })}</div>
		{/if}
	{/if}
</div>
