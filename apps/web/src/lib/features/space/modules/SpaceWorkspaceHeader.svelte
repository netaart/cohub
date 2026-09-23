<script lang="ts">
import type {
	SessionRecord,
	SpacePresenceUser,
	SpaceRecord,
} from "@neta-art/cohub";
import {
	Check,
	Globe,
	Images,
	ListTree,
	Loader2,
	Menu,
	MoreHorizontal,
	PanelRightClose,
	PanelRightOpen,
	Share2,
	TextCursorInput,
	X,
} from "lucide-svelte";
import { floatNear } from "$lib/actions/portal";
import ColumnHeader from "$lib/components/ColumnHeader.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { getSessionTitle } from "$lib/features/session-chat";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { uiState } from "$lib/stores/ui.svelte";
import SpacePresenceStack from "./SpacePresenceStack.svelte";
import SpaceRuntimeStatus from "./SpaceRuntimeStatus.svelte";

type HeaderRouteView =
	| "space"
	| "session"
	| "checkpoint"
	| "checkpoint-new"
	| "cronjob"
	| "cronjob-new"
	| "app"
	| "task";

type RouteDetailHeader = {
	view: "checkpoint" | "cronjob" | "app" | "task";
	id: string;
	title: string;
};

export type SpaceWorkspaceHeaderContext = {
	routeView: HeaderRouteView;
	spaceId: string;
	space: SpaceRecord | null;
	activeSession: SessionRecord | undefined;
	activeSessionLoaded: boolean;
	activeSessionLoading: boolean;
	isNewSessionRoute: boolean;
	wsConnectionState: string;
	onlineUsers: SpacePresenceUser[];
	activeRouteDetailHeader: RouteDetailHeader | null;
	activeSessionId: string | null;
	hasGenerationTasks: boolean;
	canManageSessionAccess: boolean;
	isActiveSessionPublic: boolean;
	spaceHasMinimalAccess: boolean;
	rightSidebarAvailable: boolean;
	rightSidebarCollapsed: boolean;
};

export type SessionRenameState = {
	renaming: boolean;
	value: string;
	saving: boolean;
};

export type ResourceActionState = {
	open: boolean;
	available: boolean;
};

export type SpaceWorkspaceHeaderActions = {
	openShareModal: (sessionId: string) => void;
	openTaskBrowser: () => void | Promise<void>;
	startSessionRename: () => void;
	cancelSessionRename: () => void;
	submitSessionRename: () => void | Promise<void>;
	setSessionRenameValue: (value: string) => void;
	toggleResourceActionMenu: () => void;
	closeResourceActionMenu: () => void;
	labelHeaderResource: (anchorEl?: HTMLElement | null) => void | Promise<void>;
	insertHeaderReference: () => void;
	toggleRightSidebar: () => void | Promise<void>;
};

type Props = {
	context: SpaceWorkspaceHeaderContext;
	sessionRename: SessionRenameState;
	resourceActions: ResourceActionState;
	actions: SpaceWorkspaceHeaderActions;
};

let { context, sessionRename, resourceActions, actions }: Props = $props();

const locale = $derived(getLocale());
let sessionRenameInputEl: HTMLInputElement | null = $state(null);
let resourceActionsRootEl: HTMLElement | null = $state(null);
let sessionRenameFocused = $state(false);

const spaceTitle = $derived(
	context.space?.name || context.space?.title || context.spaceId,
);
const showSessionTitle = $derived(
	context.routeView === "session" &&
		(context.activeSession || context.isNewSessionRoute),
);
const routeHeaderTitle = $derived.by(() => {
	if (context.routeView === "checkpoint" && context.activeRouteDetailHeader) {
		return context.activeRouteDetailHeader.title.slice(0, 36) || "Checkpoint";
	}
	if (context.routeView === "checkpoint-new") return "New save";
	if (context.routeView === "cronjob" && context.activeRouteDetailHeader) {
		return context.activeRouteDetailHeader.title;
	}
	if (context.routeView === "cronjob-new") return "New cronjob";
	if (context.routeView === "app" && context.activeRouteDetailHeader) {
		return context.activeRouteDetailHeader.title;
	}
	if (context.routeView === "task" && context.activeRouteDetailHeader) {
		return context.activeRouteDetailHeader.title;
	}
	return null;
});

$effect(() => {
	if (!sessionRename.renaming) {
		sessionRenameFocused = false;
		return;
	}
	if (sessionRenameFocused || !sessionRenameInputEl) return;
	sessionRenameFocused = true;
	sessionRenameInputEl.focus();
	sessionRenameInputEl.select();
});

function runAction(action: (() => void | Promise<void>) | undefined) {
	if (!action) return;
	Promise.resolve(action()).catch((error) => {
		console.error("Workspace header action failed", error);
	});
}

function handleSessionRenameKeydown(event: KeyboardEvent) {
	if (
		event.key === "Enter" &&
		!sessionRename.saving &&
		!isComposingKeyboardEvent(event)
	) {
		event.preventDefault();
		void actions.submitSessionRename();
	}
	if (event.key === "Escape" && !sessionRename.saving) {
		event.preventDefault();
		actions.cancelSessionRename();
	}
}
</script>

{#snippet HeaderActions()}
	<SpaceRuntimeStatus spaceId={context.spaceId} canManage={context.space?.access?.permissions.includes("sandbox.manage") === true} />
	{#if context.activeSessionId && context.hasGenerationTasks}
		<button
			type="button"
			class="header-action-btn is-square"
			onclick={() => runAction(actions.openTaskBrowser)}
			title={m.space_header_browse_media({}, { locale })}
			aria-label={m.space_header_browse_media({}, { locale })}
		>
			<Images class="h-4 w-4 shrink-0" />
		</button>
	{/if}
	{#if context.activeSessionId && context.canManageSessionAccess}
		<button
			type="button"
			class="header-action-btn {context.isActiveSessionPublic ? 'is-shared' : ''}"
			onclick={() => actions.openShareModal(context.activeSessionId!)}
			title={context.isActiveSessionPublic ? "Session is public" : "Share session"}
		>
			{#if context.isActiveSessionPublic}
				<Globe class="h-4 w-4 shrink-0" />
				<span class="hidden text-[13px] font-medium lg:inline">Shared</span>
			{:else}
				<Share2 class="h-4 w-4 shrink-0" />
				<span class="hidden text-[13px] font-medium lg:inline">Share</span>
			{/if}
		</button>
	{/if}

	{#if resourceActions.available}
		<div class="relative" data-resource-actions>
			<button
				type="button"
				class="header-action-btn is-square"
				onclick={(event) => {
					event.stopPropagation();
					resourceActionsRootEl = event.currentTarget;
					actions.toggleResourceActionMenu();
				}}
				title={m.space_header_more_actions({}, { locale })}
				aria-haspopup="menu"
				aria-expanded={resourceActions.open}
			>
				<MoreHorizontal class="h-4 w-4 shrink-0" />
			</button>
			{#if resourceActions.open && resourceActionsRootEl}
				<div
					class="w-44 overflow-hidden rounded-md border border-border-subtle bg-bg-primary py-1 shadow-lg"
					role="menu"
					data-resource-actions
					use:floatNear={{
						getAnchor: () => resourceActionsRootEl,
						placement: "bottom-end",
						gap: 4,
						width: 176,
						zIndex: 120,
					}}
				>
					<button
						type="button"
						class="menu-item"
						onclick={() => {
							void actions.labelHeaderResource(resourceActionsRootEl);
							actions.closeResourceActionMenu();
						}}
						role="menuitem"
					>
						<ListTree class="h-3.5 w-3.5" />
						<span>Label as…</span>
					</button>
					<button type="button" class="menu-item" onclick={actions.insertHeaderReference} role="menuitem">
						<TextCursorInput class="h-3.5 w-3.5" />
						<span>{m.space_header_insert_reference({}, { locale })}</span>
					</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if context.rightSidebarAvailable}
		<button
			type="button"
			class="header-action-btn"
			onclick={() => runAction(actions.toggleRightSidebar)}
			title={context.rightSidebarCollapsed ? "Show files (Ctrl+Alt+→ / ⌃⌥→)" : "Hide files (Ctrl+Alt+→ / ⌃⌥→)"}
			aria-label={context.rightSidebarCollapsed ? "Show files" : "Hide files"}
		>
			{#if context.rightSidebarCollapsed}
				<PanelRightOpen class="h-4 w-4 shrink-0" />
			{:else}
				<PanelRightClose class="h-4 w-4 shrink-0" />
			{/if}
		</button>
	{/if}
{/snippet}

<ColumnHeader>
		{#snippet left()}
			<div class="flex min-w-0 items-center gap-1.5 overflow-hidden">
				<button
					type="button"
					class="lg:hidden flex items-center justify-center w-9 h-9 -ml-0.5 rounded-[5px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors shrink-0"
					onclick={() => (uiState.mobileDrawerOpen = !uiState.mobileDrawerOpen)}
					aria-label={m.space_header_toggle_nav({}, { locale })}
				>
					<Menu class="w-5 h-5" />
				</button>
				{#if showSessionTitle}
					<button
						type="button"
						class="inline-flex shrink-0 items-center text-text-primary transition-colors hover:text-text-secondary lg:hidden"
						title={spaceTitle}
						aria-label={m.space_header_open_space({}, { locale })}
					>
						<SpaceAvatar name={spaceTitle} profile={context.space?.publicProfile} size="xs" />
					</button>
					<div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
						{#if sessionRename.renaming && context.activeSession}
							<input
								bind:this={sessionRenameInputEl}
								value={sessionRename.value}
								type="text"
								class="max-w-[40vw] min-w-0 flex-1 rounded bg-bg-hover-strong px-1 py-0.5 text-[13px] leading-tight text-text-primary outline-none"
								placeholder={m.space_header_session_name_ph({}, { locale })}
								maxlength={80}
								disabled={sessionRename.saving}
								oninput={(event) => {
									actions.setSessionRenameValue(event.currentTarget.value);
								}}
								onkeydown={handleSessionRenameKeydown}
							/>
							<button type="button" class="shrink-0 rounded p-0.5 text-status-running transition-colors hover:bg-bg-hover" disabled={sessionRename.saving} onclick={() => void actions.submitSessionRename()} title={m.common_save({}, { locale })}>
								<Check class="h-3.5 w-3.5" />
							</button>
							<button type="button" class="shrink-0 rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" disabled={sessionRename.saving} onclick={actions.cancelSessionRename} title={m.common_cancel({}, { locale })}>
								<X class="h-3.5 w-3.5" />
							</button>
						{:else}
							<button
								type="button"
								class="min-w-0 flex-1 truncate text-[13px] text-text-secondary transition-colors hover:text-text-primary"
								onclick={context.activeSession ? actions.startSessionRename : undefined}
								title={context.activeSession ? "Click to rename" : "New chat"}
							>
								{context.activeSession ? getSessionTitle(context.activeSession) : "New chat"}
							</button>
							{#if context.activeSessionLoading && context.activeSessionLoaded}
								<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-placeholder" aria-label="Syncing" />
							{/if}
							{#if context.wsConnectionState === "reconnecting"}
								<span class="inline-flex shrink-0 items-center text-[12px] text-warning">Reconnecting...</span>
							{/if}
						{/if}
					</div>
				{:else if routeHeaderTitle}
					<button type="button" class="inline-flex shrink-0 items-center text-text-primary transition-colors hover:text-text-secondary lg:hidden" title={spaceTitle} aria-label={m.space_header_open_space({}, { locale })}>
						<SpaceAvatar name={spaceTitle} profile={context.space?.publicProfile} size="xs" />
					</button>
					<span class="min-w-0 truncate text-[13px] text-text-secondary">{routeHeaderTitle}</span>
				{:else}
					<button type="button" class="inline-flex min-w-0 items-center gap-1.5 truncate text-left text-[13px] text-text-primary transition-colors hover:text-text-secondary">
						<SpaceAvatar name={spaceTitle} profile={context.space?.publicProfile} size="xs" />
						{spaceTitle}
					</button>
				{/if}
			</div>
		{/snippet}

		{#snippet right()}
			<SpacePresenceStack users={context.onlineUsers} />
			{@render HeaderActions()}
		{/snippet}
	</ColumnHeader>

<style>

	.header-action-btn {
		display: inline-flex;
		height: 32px;
		min-width: 32px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		padding: 0 8px;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.header-action-btn.is-square {
		width: 32px;
		padding: 0;
	}

	.header-action-btn:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.header-action-btn.is-shared {
		color: var(--success-soft);
	}

	.header-action-btn.is-shared:hover {
		background: var(--success-bg);
		color: var(--success);
	}
</style>
