<script lang="ts">
import type { SessionRecord } from "@neta-art/cohub";
import { Check, Link2Off, Pencil, TextCursorInput, X } from "lucide-svelte";
import SessionSidebarRowContent from "$lib/components/SessionSidebarRowContent.svelte";
import SidebarActionButton from "$lib/components/sidebar/SidebarActionButton.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import type { ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";

export type SidebarSessionRowState = {
	isFork?: boolean;
	isLastVisibleChild?: boolean;
	style?: string;
	titleText?: string;
	ariaLabel?: string;
};

const {
	session,
	title,
	href,
	active = false,
	isMobile = false,
	modelsCatalog,
	showSourceBadge = false,
	rowState,
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
	active?: boolean;
	isMobile?: boolean;
	modelsCatalog?: ModelCatalogItem[] | null;
	showSourceBadge?: boolean;
	rowState?: SidebarSessionRowState | null;
	draggable?: boolean;
	showInsert?: boolean;
	showRename?: boolean;
	renaming?: boolean;
	renameValue?: string;
	renameSaving?: boolean;
	removeLabelTitle?: string;
	removeLabelDisabled?: boolean;
	onNavigate: (session: SessionRecord) => void;
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

const locale = $derived(getLocale());
let renameInputElement: HTMLInputElement | null = $state(null);

$effect(() => {
	if (!renaming) return;
	requestAnimationFrame(() => {
		renameInputElement?.focus();
		renameInputElement?.select();
	});
});

const actionCount = $derived(
	(showInsert ? 1 : 0) + (showRename ? 1 : 0) + (onRemoveLabel ? 1 : 0),
);
const hoverPaddingClass = $derived.by(() => {
	if (isMobile || actionCount <= 0) return "";
	if (actionCount >= 3) return "hover:pr-24 focus-within:pr-24";
	if (actionCount === 2) return "hover:pr-20 focus-within:pr-20";
	return "hover:pr-12 focus-within:pr-12";
});
</script>

{#if renaming}
	<div class="flex items-center gap-1 rounded-[var(--list-row-radius)] bg-[var(--list-row-active-bg)] px-1.5 py-1.5" data-session-rename>
		<input
			bind:this={renameInputElement}
			value={renameValue}
			type="text"
			class="min-w-0 flex-1 bg-transparent text-[13px] leading-tight text-text-primary outline-none"
			placeholder={m.sidebar_session_name({}, { locale })}
			maxlength="80"
			disabled={renameSaving}
			oninput={(event) => onRenameValueChange?.(event.currentTarget.value)}
			onkeydown={(event) => {
				if (event.key === "Enter" && !renameSaving) {
					event.preventDefault();
					onSubmitRename?.(session);
				}
				if (event.key === "Escape" && !renameSaving) {
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
	</div>
{:else}
<a
	{href}
	class="sidebar-flyout-item group/session relative flex items-center gap-[var(--list-row-gap)] overflow-hidden rounded-[var(--list-row-radius)] px-[var(--list-row-pad-x)] py-2 pr-4 transition-colors duration-100 {isMobile ? 'text-[15px]' : 'text-[14px]'} {hoverPaddingClass} {rowState?.isFork ? 'session-fork-row' : ''} {rowState?.isLastVisibleChild ? 'session-fork-row--last' : ''} {active ? 'bg-[var(--list-row-active-bg)]' : 'hover:bg-[var(--list-row-hover-bg)]'}"
	style={rowState?.style}
	onclick={(event) => {
		event.preventDefault();
		onNavigate(session);
	}}
	ondblclick={(event) => onDoubleClick?.(event, session)}
	draggable={!isMobile && draggable}
	ondragstart={(event) => onDragStart?.(event, session, title)}
	ondragend={onDragEnd}
	title={rowState?.titleText}
	aria-label={rowState?.ariaLabel ?? title}
>
	<SessionSidebarRowContent {session} {title} {isMobile} {showSourceBadge} modelsCatalog={modelsCatalog ?? undefined} />
	{#if !isMobile && actionCount > 0}
		<span class="absolute right-1 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/session:opacity-100 group-hover/session:pointer-events-auto group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto">
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
</a>
{/if}

<style>
	.session-fork-row {
		--session-fork-line: color-mix(
			in oklab,
			var(--color-brand) 34%,
			var(--color-border-subtle)
		);
		padding-left: calc(var(--list-row-pad-x) + var(--fork-indent, 0px));
	}

	.session-fork-row::before {
		content: "";
		position: absolute;
		left: calc(var(--list-row-pad-x) - 7px + var(--fork-indent, 0px));
		top: 50%;
		width: 8px;
		height: 2px;
		border-radius: 999px;
		background: var(--session-fork-line);
		opacity: 0.8;
		transform: translateY(-50%);
		pointer-events: none;
	}

	.session-fork-row::after {
		content: "";
		position: absolute;
		left: calc(var(--list-row-pad-x) - 7px + var(--fork-indent, 0px));
		top: 0.35rem;
		bottom: 0.35rem;
		width: 2px;
		background: var(--session-fork-line);
		opacity: 0.8;
		pointer-events: none;
	}

	.session-fork-row--last::after {
		bottom: 50%;
	}

	@media (hover: hover) {
		.session-fork-row:hover,
		.session-fork-row:focus-within {
			--session-fork-line: color-mix(
				in oklab,
				var(--color-brand) 48%,
				var(--color-text-placeholder)
			);
		}

		.session-fork-row:hover::before,
		.session-fork-row:hover::after,
		.session-fork-row:focus-within::before,
		.session-fork-row:focus-within::after {
			opacity: 0.95;
		}
	}

	@media (max-width: 640px) {
		.session-fork-row {
			padding-left: calc(var(--list-row-pad-x) + min(var(--fork-indent, 0px), 10px));
		}

		.session-fork-row::before,
		.session-fork-row::after {
			left: calc(var(--list-row-pad-x) - 7px + min(var(--fork-indent, 0px), 10px));
		}
	}
</style>
