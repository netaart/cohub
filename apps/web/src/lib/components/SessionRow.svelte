<script lang="ts" module>
export type SessionRowTree = {
	depth: number;
	last: boolean;
	hasChildren: boolean;
};
</script>

<script lang="ts">
import type { SessionRecord } from "@neta-art/cohub";
import { Check, Link2Off, Pencil, TextCursorInput, X } from "lucide-svelte";
import type { Snippet } from "svelte";
import ListRow from "$lib/components/list-page/ListRow.svelte";
import ListRowText from "$lib/components/list-page/ListRowText.svelte";
import type { ListRowDensity } from "$lib/components/list-page/list-row";
import SidebarActionButton from "$lib/components/sidebar/SidebarActionButton.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import type { ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import { getSessionSidebarActivity } from "$lib/session-sidebar-activity";
import { getSessionActivityAt } from "$lib/session-sort";
import { authStore } from "$lib/stores/auth.svelte";
import {
	chatsSourceName,
	resolveSessionSourceKey,
} from "$lib/stores/chats-filter";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import { formatCompactAbsoluteTime } from "$lib/time-format";

const {
	session,
	title,
	href,
	density,
	subtitle = null,
	active = false,
	isMobile = false,
	modelsCatalog,
	showSourceBadge = false,
	avatar,
	tree,
	tooltip,
	draggable = false,
	showInsert = true,
	showRename = true,
	renaming = false,
	renameValue = "",
	renameSaving = false,
	removeLabelTitle,
	removeLabelDisabled = false,
	onNavigate,
	onDoubleClick,
	onInsert,
	onRename,
	onRenameValueChange,
	onSubmitRename,
	onCancelRename,
	onRemoveLabel,
	onDragStart,
	onDragEnd,
}: {
	session: SessionRecord;
	title: string;
	href: string;
	density: ListRowDensity;
	subtitle?: string | null;
	active?: boolean;
	isMobile?: boolean;
	modelsCatalog?: ModelCatalogItem[] | null;
	showSourceBadge?: boolean;
	avatar?: Snippet;
	tree?: SessionRowTree | null;
	tooltip?: string;
	draggable?: boolean;
	showInsert?: boolean;
	showRename?: boolean;
	renaming?: boolean;
	renameValue?: string;
	renameSaving?: boolean;
	removeLabelTitle?: string;
	removeLabelDisabled?: boolean;
	onNavigate: (event: MouseEvent, session: SessionRecord) => void;
	onDoubleClick?: (event: MouseEvent, session: SessionRecord) => void;
	onInsert?: (path: string) => void;
	onRename?: (session: SessionRecord) => void;
	onRenameValueChange?: (value: string) => void;
	onSubmitRename?: (session: SessionRecord) => void;
	onCancelRename?: () => void;
	onRemoveLabel?: () => void;
	onDragStart?: (
		event: DragEvent,
		session: SessionRecord,
		title: string,
	) => void;
	onDragEnd?: () => void;
} = $props();

type Participant = {
	key: string;
	name: string;
	avatarUrl: string | null;
};

const locale = $derived(getLocale());
let renameInput = $state<HTMLInputElement | null>(null);

const activity = $derived(
	getSessionSidebarActivity(
		sessionGenerationStore.get(session.id),
		modelsCatalog,
		session.activeTurn,
	),
);
const showActivity = $derived(
	activity.active ||
		activity.phase === "failed" ||
		activity.phase === "interrupted",
);
const isUnread = $derived(
	unreadTracker.isUnread(session, session.lastMessageId),
);
const time = $derived(formatCompactAbsoluteTime(getSessionActivityAt(session)));
const sourceName = $derived(
	chatsSourceName(resolveSessionSourceKey(session.source), locale),
);
const hasMessages = $derived(
	Boolean(session.latestMessageText || session.lastMessageAt),
);
const ownSubtitle = $derived(subtitle?.trim() || null);
const fallbackSubtitle = $derived(
	hasMessages ? sourceName : m.chats_row_no_messages({}, { locale }),
);
const sourceBadge = $derived(
	showSourceBadge &&
		!showActivity &&
		ownSubtitle &&
		resolveSessionSourceKey(session.source) !== "web"
		? sourceName
		: "",
);
const participants = $derived(
	visibleParticipants(sessionParticipants(session), authStore.userUuid),
);
const participantLabel = $derived(
	participants.length > 3
		? `${participants
				.slice(0, 3)
				.map((participant) => participant.name)
				.join(", ")} +${participants.length - 3}`
		: participants.map((participant) => participant.name).join(", "),
);

const guide = $derived<"column" | "indent" | null>(
	tree && (tree.depth > 0 || tree.hasChildren)
		? avatar
			? "column"
			: tree.depth > 0
				? "indent"
				: null
		: null,
);
const indentPx = $derived(
	guide === "indent" && tree
		? Math.min(tree.depth, isMobile ? 1 : 3) * 12
		: 0,
);
const isFork = $derived(Boolean(tree && tree.depth > 0));

const actionCount = $derived(
	isMobile
		? 0
		: (showInsert && onInsert ? 1 : 0) +
				(showRename && onRename ? 1 : 0) +
				(onRemoveLabel ? 1 : 0),
);
const HOVER_ROOM = [
	"",
	"hover:pr-8 focus-within:pr-8",
	"hover:pr-12 focus-within:pr-12",
	"hover:pr-16 focus-within:pr-16",
] as const;
const hoverRoomClass = $derived(HOVER_ROOM[actionCount] ?? "");

$effect(() => {
	if (!renaming) return;
	requestAnimationFrame(() => {
		renameInput?.focus();
		renameInput?.select();
	});
});

function sessionParticipants(record: SessionRecord): Participant[] {
	const list: Participant[] = [];
	const seen = new Set<string>();
	for (const profile of [
		record.userProfile,
		...(record.participantProfiles ?? []),
	]) {
		const name = profile?.displayName?.trim();
		if (!name) continue;
		const key = profile?.userUuid?.trim() || name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		list.push({ key, name, avatarUrl: profile?.avatarUrl ?? null });
	}
	return list;
}

function visibleParticipants(list: Participant[], viewer: string | null) {
	if (!viewer || list.some((participant) => participant.key !== viewer))
		return list;
	return [];
}
</script>

{#snippet leading()}
	{#if guide === "column" && isFork}
		<span class="tree-guide tree-guide--child" class:tree-guide--last={tree?.last} aria-hidden="true"></span>
	{:else}
		{@render avatar?.()}
		{#if guide === "column" && tree?.hasChildren}
			<span class="tree-guide tree-guide--stem" aria-hidden="true"></span>
		{/if}
	{/if}
{/snippet}

{#snippet meta()}
	<span class="inline-flex items-center gap-1.5 {actionCount ? 'group-hover/row:hidden group-focus-within/row:hidden' : ''}">{time}</span>
{/snippet}

{#snippet secondLine()}
	{#if showActivity}
		<span class={activity.phase === "failed" ? "text-error-soft" : activity.active ? "text-text-tertiary" : "text-text-placeholder"}>
			{activity.label}{activity.text ? ` · ${activity.text}` : ""}{#if activity.active}<span class="session-activity-caret" aria-hidden="true">▍</span>{/if}
		</span>
	{:else if ownSubtitle}
		<span title={ownSubtitle}>{ownSubtitle}</span>
	{:else}
		<span class="text-text-placeholder">{fallbackSubtitle}</span>
	{/if}
{/snippet}

{#snippet status()}
	{#if sourceBadge}
		<span class="max-w-24 truncate rounded-[4px] bg-bg-hover-strong px-1.5 py-px text-[10px] font-medium leading-[14px] text-text-tertiary">{sourceBadge}</span>
	{/if}
	{#if participants.length > 0}
		<span class="inline-flex shrink-0 -space-x-1.5" title={participantLabel}>
			{#each participants.slice(0, 3) as participant (participant.key)}
				<UserAvatar name={participant.name} avatarUrl={participant.avatarUrl} size="xxs" class="border-bg-primary" />
			{/each}
		</span>
	{/if}
	{#if isUnread}
		<span class="h-2 w-2 shrink-0 rounded-full bg-brand" role="img" aria-label={m.sidebar_unread({}, { locale })}></span>
	{/if}
{/snippet}

{#if renaming}
	<ListRow {density} active data-session-rename leading={avatar ? leading : undefined}>
		<input
			bind:this={renameInput}
			value={renameValue}
			type="text"
			class="min-w-0 flex-1 bg-transparent text-[14px] leading-tight text-text-primary outline-none"
			placeholder={m.sidebar_session_name({}, { locale })}
			maxlength="80"
			disabled={renameSaving}
			oninput={(event) => onRenameValueChange?.(event.currentTarget.value)}
			onkeydown={(event) => {
				if (renameSaving) return;
				if (event.key === "Enter") {
					event.preventDefault();
					onSubmitRename?.(session);
				} else if (event.key === "Escape") {
					event.preventDefault();
					onCancelRename?.();
				}
			}}
		/>
		<button
			type="button"
			class="shrink-0 rounded p-0.5 text-status-running transition-colors hover:bg-bg-hover disabled:opacity-50"
			disabled={renameSaving}
			title={m.common_save({}, { locale })}
			onclick={() => onSubmitRename?.(session)}
		>
			<Check class="h-3.5 w-3.5" />
		</button>
		<button
			type="button"
			class="shrink-0 rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
			disabled={renameSaving}
			title={m.common_cancel({}, { locale })}
			onclick={() => onCancelRename?.()}
		>
			<X class="h-3.5 w-3.5" />
		</button>
	</ListRow>
{:else}
	<ListRow
		{density}
		{href}
		{active}
		class="session-row {hoverRoomClass} {isMobile ? 'select-none [-webkit-touch-callout:none]' : ''} {guide === 'indent' ? 'session-row--indent' : ''} {guide === 'indent' && tree?.last ? 'session-row--last' : ''}"
		style={indentPx ? `--fork-indent: ${indentPx}px` : undefined}
		aria-current={active ? "page" : undefined}
		title={tooltip}
		aria-label={tooltip ? `${title}, ${tooltip}` : title}
		draggable={!isMobile && draggable}
		leading={avatar ? leading : undefined}
		onclick={(event: MouseEvent) => onNavigate(event, session)}
		ondblclick={(event: MouseEvent) => onDoubleClick?.(event, session)}
		ondragstart={(event: DragEvent) => onDragStart?.(event, session, title)}
		ondragend={onDragEnd}
	>
		<ListRowText {title} strong={isUnread} {meta} subtitle={secondLine} {status} />
		{#snippet trailing()}
			{#if actionCount > 0}
				<span class="pointer-events-none absolute right-1.5 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100">
					{#if showInsert && onInsert}
						<SidebarActionButton icon={TextCursorInput} title={m.common_insert({}, { locale })} onClick={() => onInsert(`/sessions/${session.id}.jsonl`)} />
					{/if}
					{#if showRename && onRename}
						<SidebarActionButton icon={Pencil} title={m.common_rename({}, { locale })} onClick={() => onRename(session)} />
					{/if}
					{#if onRemoveLabel}
						<SidebarActionButton icon={Link2Off} title={removeLabelTitle ?? m.sidebar_remove_from_label_generic({}, { locale })} disabled={removeLabelDisabled} tone="danger" onClick={onRemoveLabel} />
					{/if}
				</span>
			{/if}
		{/snippet}
	</ListRow>
{/if}

<style>
	.tree-guide,
	:global(.session-row--indent)::before,
	:global(.session-row--indent)::after {
		position: absolute;
		background: var(--list-tree-guide);
		border-radius: 999px;
		pointer-events: none;
	}

	.tree-guide--stem {
		left: calc(50% - 1px);
		top: calc(50% + var(--list-avatar-size) / 2 + 3px);
		bottom: 0;
		width: 2px;
	}

	.tree-guide--child {
		inset: 0;
		background: none;
	}

	.tree-guide--child::before,
	.tree-guide--child::after {
		content: "";
		position: absolute;
		left: calc(50% - 1px);
		background: var(--list-tree-guide);
		border-radius: 999px;
	}

	.tree-guide--child::before {
		top: 0;
		bottom: 0;
		width: 2px;
	}

	.tree-guide--last::before {
		bottom: calc(50% - 1px);
	}

	.tree-guide--child::after {
		top: calc(50% - 1px);
		right: calc(var(--list-row-gap) / -2);
		height: 2px;
	}

	:global(.session-row--indent) {
		padding-left: calc(var(--list-row-pad-x) + 8px + var(--fork-indent, 0px));
	}

	:global(.session-row--indent)::before {
		content: "";
		left: calc(var(--list-row-pad-x) + var(--fork-indent, 0px) - 4px);
		top: 0;
		bottom: 0;
		width: 2px;
	}

	:global(.session-row--indent)::after {
		content: "";
		left: calc(var(--list-row-pad-x) + var(--fork-indent, 0px) - 4px);
		top: calc(50% - 1px);
		width: 8px;
		height: 2px;
	}

	:global(.session-row--last)::before {
		bottom: calc(50% - 1px);
	}

	.session-activity-caret {
		display: inline-block;
		margin-left: 0.0625rem;
		color: var(--color-brand);
		font-size: 0.82em;
		line-height: 1;
		animation: session-activity-caret 1.15s steps(2, jump-none) infinite;
	}

	@keyframes session-activity-caret {
		0%,
		45% {
			opacity: 1;
		}
		46%,
		100% {
			opacity: 0.28;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.session-activity-caret {
			animation: none;
			opacity: 0.85;
		}
	}
</style>
