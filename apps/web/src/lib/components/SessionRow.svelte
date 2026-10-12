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
import StatusGlyph, {
	type StatusGlyphMotion,
	type StatusGlyphShape,
	type StatusGlyphTone,
} from "$lib/components/StatusGlyph.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { clock } from "$lib/clock.svelte";
import { formatElapsedMs } from "$lib/format-duration";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	getSessionPreview,
	getSessionPreviewText,
} from "$lib/session-preview";
import {
	getSessionRowStatus,
	type SessionRowStatusKind,
} from "$lib/session-activity";
import { getSessionActivityAt } from "$lib/session-sort";
import { authStore } from "$lib/stores/auth.svelte";
import {
	chatsSourceName,
	resolveSessionSourceKey,
} from "$lib/stores/chats-filter";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import { formatCompactAbsoluteTime } from "$lib/time-format";

const {
	session,
	title,
	href,
	density,
	active = false,
	isMobile = false,
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
	active?: boolean;
	isMobile?: boolean;
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

type Glyph = {
	shape: StatusGlyphShape;
	tone: StatusGlyphTone;
	motion?: StatusGlyphMotion;
	soft?: boolean;
};

const GLYPHS: Record<
	Exclude<SessionRowStatusKind, "idle" | "unread">,
	Glyph
> = {
	running: { shape: "dots", tone: "brand", motion: "active" },
	queued: { shape: "dots", tone: "muted", soft: true },
	stopping: { shape: "dots", tone: "muted", motion: "slow" },
	failed: { shape: "ring", tone: "error" },
	lost: { shape: "ring", tone: "warning", soft: true },
};

const locale = $derived(getLocale());
let renameInput = $state<HTMLInputElement | null>(null);

const dense = $derived(density === "dense");
const isUnread = $derived(
	unreadTracker.isUnread(session, session.lastMessageId),
);
const status = $derived(getSessionRowStatus(session, isUnread, locale));
const glyph = $derived(
	status.kind === "idle" || status.kind === "unread"
		? null
		: GLYPHS[status.kind],
);
const startedAtMs = $derived(
	status.startedAt ? Date.parse(status.startedAt) : Number.NaN,
);
const statusText = $derived(
	Number.isFinite(startedAtMs)
		? m.session_activity_running_for(
				{ duration: formatElapsedMs(clock.now - startedAtMs, locale) },
				{ locale },
			)
		: status.label,
);
const time = $derived(formatCompactAbsoluteTime(getSessionActivityAt(session)));
const sourceKey = $derived(resolveSessionSourceKey(session.source));
const sourceName = $derived(chatsSourceName(sourceKey, locale));
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
const hasMessages = $derived(
	Boolean(session.latestMessageText || session.lastMessageAt),
);
// Web chats keep a preview that repeats the title; others fall back to the source.
const preview = $derived(
	dense
		? null
		: sourceKey === "web"
			? getSessionPreviewText(session)
			: getSessionPreview(session, title),
);
const statusDetail = $derived(status.errorMessage ?? preview);
const showSourceLine = $derived(
	!dense && !preview && hasMessages && sourceKey !== "web",
);
const sourceBadge = $derived(
	showSourceBadge && !showSourceLine && sourceKey !== "web"
		? sourceName
		: "",
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
		? Math.min(tree.depth, isMobile ? 1 : 3) * (isMobile ? 10 : 12)
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

{#snippet unreadDot()}
	{#if status.kind === "unread"}
		<StatusGlyph tone="brand" soft />
	{/if}
{/snippet}

{#snippet meta()}
	<span class="inline-flex items-center gap-1.5 {actionCount ? 'group-hover/row:hidden group-focus-within/row:hidden' : ''}">
		{#if sourceBadge}
			<span class="max-w-20 truncate rounded-[3px] bg-bg-hover-strong px-1.5 py-px text-[10px] font-medium leading-none text-text-tertiary" title={sourceBadge}>{sourceBadge}</span>
		{/if}
		{time}
	</span>
{/snippet}

{#snippet people()}
	<span class="inline-flex min-w-0 shrink-0 items-center gap-1.5 {dense ? 'max-w-[60%]' : 'max-w-[40%]'}" title={participantLabel}>
		<span class="inline-flex shrink-0 -space-x-1.5 opacity-80">
			{#each participants.slice(0, 3) as participant (participant.key)}
				<UserAvatar name={participant.name} avatarUrl={participant.avatarUrl} seed={participant.key} size="xxs" class="border-bg-primary {dense ? 'h-3.5 w-3.5' : ''}" />
			{/each}
		</span>
		<span class="min-w-0 truncate">{participantLabel}</span>
	</span>
{/snippet}

{#snippet secondLine()}
	{#if glyph}
		<span class="inline-flex items-center gap-1.5 align-top {status.kind === 'failed' ? 'text-error-soft' : 'text-text-tertiary'}">
			<StatusGlyph {...glyph} class="[--status-glyph-size:5px]" />{statusText}
		</span>
		{#if statusDetail}<span title={statusDetail}> · {statusDetail}</span>{/if}
	{:else if preview}
		<span title={preview}>{preview}</span>
	{:else if showSourceLine}
		<span class="text-text-placeholder">{sourceName}</span>
	{:else if !hasMessages}
		<span class="text-text-placeholder">{m.chats_row_no_messages({}, { locale })}</span>
	{/if}
{/snippet}

{#if renaming}
	<ListRow {density} active data-session-rename leading={avatar ? leading : undefined}>
		<input
			bind:this={renameInput}
			value={renameValue}
			type="text"
			class="min-w-0 flex-1 bg-transparent text-[length:var(--list-title-size)] leading-tight text-text-primary outline-none"
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
		aria-label={[title, status.label, tooltip].filter(Boolean).join(', ')}
		draggable={!isMobile && draggable}
		leading={avatar ? leading : undefined}
		onclick={(event: MouseEvent) => onNavigate(event, session)}
		ondblclick={(event: MouseEvent) => onDoubleClick?.(event, session)}
		ondragstart={(event: DragEvent) => onDragStart?.(event, session, title)}
		ondragend={onDragEnd}
	>
		<ListRowText
			{title}
			badge={unreadDot}
			{meta}
			lead={!glyph && participants.length > 0 ? people : undefined}
			subtitle={dense && !glyph ? undefined : secondLine}
		/>
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
		padding-left: calc(var(--list-row-pad-x) + var(--fork-indent, 0px));
	}

	:global(.session-row--indent)::before {
		content: "";
		left: calc(var(--list-row-pad-x) + var(--fork-indent, 0px) - 7px);
		top: 6px;
		bottom: 6px;
		width: 2px;
	}

	:global(.session-row--indent)::after {
		content: "";
		left: calc(var(--list-row-pad-x) + var(--fork-indent, 0px) - 7px);
		top: calc(50% - 1px);
		width: 7px;
		height: 2px;
	}

	:global(.session-row--last)::before {
		bottom: 50%;
	}

	:global(.list-row.session-row[data-density="comfortable"]) {
		--list-subtitle-size: 13px;
	}

	:global(.list-row.session-row[data-density="compact"]) {
		--list-subtitle-size: 11px;
	}
</style>
