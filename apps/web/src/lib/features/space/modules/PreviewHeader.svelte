<script lang="ts">
import {
	Check,
	ChevronDown,
	File as FileIcon,
	Globe,
	Menu,
	Minimize2,
	MonitorSmartphone,
	MoreHorizontal,
	MousePointer2,
	PanelRight,
	PanelRightClose,
	PanelRightOpen,
	Rocket,
	X,
} from "lucide-svelte";
import type { Snippet } from "svelte";
import { floatNear } from "$lib/actions/portal";
import PreviewExpandMenu from "$lib/components/PreviewExpandMenu.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { uiState } from "$lib/stores/ui.svelte";
import type {
	PreviewChrome,
	PreviewHeaderAction,
	PreviewHeaderVariant,
} from "./preview-header";
import WindowSyncStatus from "./WindowSyncStatus.svelte";
import type { Window } from "./windows";

const {
	windows,
	variant = "dock",
	actions = [],
	controls,
	chrome,
	onActivate,
	onClose,
}: {
	windows: Window[];
	variant?: PreviewHeaderVariant;
	actions?: PreviewHeaderAction[];
	/** Interactive controls (view mode, zoom, page…). `compact` forces the popover form. */
	controls?: Snippet<[{ compact: boolean }]>;
	chrome: PreviewChrome;
	onActivate: (kind: Window["kind"], key: string) => void;
	onClose: (kind: Window["kind"], key: string) => void;
} = $props();

const locale = $derived(getLocale());

const kindIcon = {
	file: FileIcon,
	board: MousePointer2,
	port: Globe,
	app: Rocket,
	display: MonitorSmartphone,
} as const satisfies Record<Window["kind"], unknown>;

const primaryActions = $derived(
	actions.filter((action) => action.primary && !action.hidden),
);
const menuActions = $derived(
	actions.filter((action) => !action.primary && !action.hidden),
);

/** Float is always space-constrained, so its controls skip the inline form. */
const compactControls = $derived(variant === "float");

let switcherOpen = $state(false);
let switcherEl = $state<HTMLDivElement | null>(null);
let actionsMenuOpen = $state(false);
let actionsMenuAnchor = $state<HTMLButtonElement | null>(null);
const activeTab = $derived(
	windows.find((tab) => tab.active) ?? windows[0] ?? null,
);

function run(
	action: PreviewHeaderAction | undefined,
	event: MouseEvent,
	anchor: HTMLElement | null = null,
) {
	if (!action || action.disabled) return;
	Promise.resolve(action.run(event, anchor)).catch((error) => {
		console.error("Preview header action failed", error);
	});
}

function activate(tab: Window) {
	switcherOpen = false;
	onActivate(tab.kind, tab.key);
}

$effect(() => {
	if (!switcherOpen) return;
	const onPointerDown = (event: PointerEvent) => {
		if (event.target instanceof Node && !switcherEl?.contains(event.target)) {
			switcherOpen = false;
		}
	};
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") switcherOpen = false;
	};
	document.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("keydown", onKeydown);
	return () => {
		document.removeEventListener("pointerdown", onPointerDown, true);
		document.removeEventListener("keydown", onKeydown);
	};
});

$effect(() => {
	if (!actionsMenuOpen) return;
	const onPointerDown = (event: PointerEvent) => {
		const target = event.target;
		if (
			target instanceof Node &&
			(actionsMenuAnchor?.contains(target) ||
				(target instanceof Element && target.closest(".preview-actions-menu")))
		) {
			return;
		}
		actionsMenuOpen = false;
	};
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") actionsMenuOpen = false;
	};
	document.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("keydown", onKeydown);
	return () => {
		document.removeEventListener("pointerdown", onPointerDown, true);
		document.removeEventListener("keydown", onKeydown);
	};
});
</script>

{#snippet TabButton(tab: Window)}
	{@const Icon = kindIcon[tab.kind]}
	<div class="preview-tab-shell" class:active={tab.active}>
		<button
			type="button"
			class="preview-tab"
			role="tab"
			aria-selected={tab.active}
			title={tab.title}
			onclick={() => onActivate(tab.kind, tab.key)}
		>
			<span class="preview-tab-icon"><Icon class="h-3 w-3" /></span>
			<span class="truncate">{tab.label}</span>
			{#if tab.syncStatus}<WindowSyncStatus status={tab.syncStatus} />{/if}
		</button>
		<button
			type="button"
			class="preview-tab-close"
			aria-label={m.window_close_tab({ label: tab.label }, { locale })}
			onclick={() => onClose(tab.kind, tab.key)}
		>
			<X class="h-3 w-3" />
		</button>
	</div>
{/snippet}

{#snippet PrimaryActions()}
	{#each primaryActions as action (action.id)}
		<button
			type="button"
			class="preview-icon-action"
			class:active={action.active}
			title={action.label}
			aria-label={action.label}
			aria-pressed={action.active}
			disabled={action.disabled}
			onclick={(event) => run(action, event, event.currentTarget as HTMLElement | null)}
		>
			<action.icon class="h-4 w-4" />
		</button>
	{/each}
{/snippet}

{#snippet ActionsMenuButton()}
	{#if menuActions.length > 0}
		<button
			bind:this={actionsMenuAnchor}
			type="button"
			class="preview-icon-action"
			class:active={actionsMenuOpen}
			title={m.inline_more_actions({}, { locale })}
			aria-label={m.inline_more_actions({}, { locale })}
			aria-haspopup="menu"
			aria-expanded={actionsMenuOpen}
			onclick={() => (actionsMenuOpen = !actionsMenuOpen)}
		>
			<MoreHorizontal class="h-4 w-4" />
		</button>
		{#if actionsMenuOpen}
			<div
				class="preview-actions-menu"
				role="menu"
				use:floatNear={{
					getAnchor: () => actionsMenuAnchor,
					placement: "bottom-end",
					gap: 6,
					width: 200,
					zIndex: 120,
				}}
			>
				{#each menuActions as action (action.id)}
					<button
						type="button"
						class="menu-item"
						class:danger={action.danger}
						class:preview-menu-item--disabled={action.disabled}
						role="menuitem"
						disabled={action.disabled}
						onclick={(event) => {
							actionsMenuOpen = false;
							run(action, event, actionsMenuAnchor);
						}}
					>
						<action.icon class="h-3.5 w-3.5" />
						<span>{action.label}</span>
						{#if action.active}<Check class="ml-auto h-3.5 w-3.5" />{/if}
					</button>
				{/each}
			</div>
		{/if}
	{/if}
{/snippet}

{#if variant === "float"}
	<div class="preview-header preview-header--float" aria-label={m.window_float_controls({}, { locale })}>
		<div class="preview-float-bar">
			<div bind:this={switcherEl} class="preview-switcher">
				<button
					type="button"
					class="preview-switcher-trigger"
					title={activeTab?.title ?? m.window_open({}, { locale })}
					aria-label={m.window_switch({}, { locale })}
					aria-haspopup="menu"
					aria-expanded={switcherOpen}
					onclick={() => (switcherOpen = !switcherOpen)}
				>
					{#if activeTab}
						{@const ActiveIcon = kindIcon[activeTab.kind]}
						<ActiveIcon class="h-3.5 w-3.5 shrink-0" />
						<span class="preview-switcher-label">{activeTab.label}</span>
						{#if activeTab.syncStatus}<WindowSyncStatus status={activeTab.syncStatus} />{/if}
					{/if}
					<span class="preview-switcher-chevron"><ChevronDown class="h-3.5 w-3.5" /></span>
				</button>
				{#if switcherOpen}
					<div class="preview-switcher-menu" role="menu" aria-label={m.window_open({}, { locale })}>
						{#each windows as tab (`${tab.kind}:${tab.key}`)}
							{@const Icon = kindIcon[tab.kind]}
							<div class="preview-switcher-item" class:active={tab.active}>
								<button type="button" class="preview-switcher-item-main" title={tab.title} role="menuitem" onclick={() => activate(tab)}>
									<Icon class="h-3.5 w-3.5 shrink-0" />
									<span class="truncate">{tab.label}</span>
									{#if tab.syncStatus}<WindowSyncStatus status={tab.syncStatus} />{/if}
									{#if tab.active}<Check class="ml-auto h-3.5 w-3.5 shrink-0" />{/if}
								</button>
								<button
									type="button"
									class="preview-switcher-item-close"
									aria-label={m.window_close_tab({ label: tab.label }, { locale })}
									onclick={() => onClose(tab.kind, tab.key)}
								>
									<X class="h-3 w-3" />
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			{#if controls}
				<div class="preview-float-controls">{@render controls({ compact: compactControls })}</div>
			{/if}
			{@render PrimaryActions()}
			{@render ActionsMenuButton()}

			<div class="preview-divider"></div>
			{#if chrome.onToggleImmersive}
				<button
					type="button"
					class="preview-icon-action"
					title={m.window_exit_float({}, { locale })}
					aria-label={m.window_exit_float({}, { locale })}
					onclick={() => chrome.onToggleImmersive?.()}
				>
					<Minimize2 class="h-4 w-4" />
				</button>
			{/if}
			{#if chrome.onToggleTree}
				<button
					type="button"
					class="preview-icon-action"
					class:active={chrome.treeVisible}
					title={chrome.treeVisible ? m.files_collapse_tree({}, { locale }) : m.files_show_tree({}, { locale })}
					aria-label={chrome.treeVisible ? m.files_collapse_tree({}, { locale }) : m.files_show_tree({}, { locale })}
					aria-pressed={chrome.treeVisible}
					onclick={() => chrome.onToggleTree?.()}
				>
					<PanelRight class="h-4 w-4" />
				</button>
			{/if}
		</div>
	</div>
{:else}
	<div
		class="preview-header"
		class:preview-header--mobile={variant === "mobile"}
	>
		{#if variant === "mobile"}
			<button
				type="button"
				class="preview-icon-action"
				title={m.mobile_open_sidebar({}, { locale })}
				aria-label={m.mobile_open_sidebar({}, { locale })}
				onclick={() => (uiState.mobileDrawerOpen = true)}
			>
				<Menu class="h-4 w-4" />
			</button>
		{/if}

		<div class="preview-tabs-scroll" role="tablist" aria-label={m.window_open({}, { locale })}>
			{#each windows as tab (`${tab.kind}:${tab.key}`)}
				{@render TabButton(tab)}
			{/each}
		</div>

		<div class="preview-trailing">
			{#if controls}
				{@render controls({ compact: compactControls })}
			{/if}
			{@render PrimaryActions()}
			{@render ActionsMenuButton()}
			{#if variant === "dock" && chrome.onToggleFocus && chrome.onToggleImmersive}
				<div class="preview-divider"></div>
				<PreviewExpandMenu
					focused={chrome.focus}
					immersive={chrome.immersive}
					size="sm"
					onToggleFocus={chrome.onToggleFocus}
					onToggleImmersive={chrome.onToggleImmersive}
				/>
			{/if}
			{#if variant === "dock" && chrome.onToggleTree}
				<button
					type="button"
					class="preview-icon-action"
					title={chrome.treeVisible ? m.files_collapse_tree({}, { locale }) : m.files_show_tree({}, { locale })}
					aria-label={chrome.treeVisible ? m.files_collapse_tree({}, { locale }) : m.files_show_tree({}, { locale })}
					aria-pressed={chrome.treeVisible}
					onclick={() => chrome.onToggleTree?.()}
				>
					{#if chrome.treeVisible}
						<PanelRightClose class="h-3.5 w-3.5" />
					{:else}
						<PanelRightOpen class="h-3.5 w-3.5" />
					{/if}
				</button>
			{/if}
			{#if variant === "mobile"}
				<button
					type="button"
					class="preview-icon-action"
					title={m.mobile_open_files({}, { locale })}
					aria-label={m.mobile_open_files({}, { locale })}
					onclick={() => (uiState.mobileRightDrawerOpen = true)}
				>
					<PanelRightOpen class="h-4 w-4" />
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.preview-header {
		container-name: preview-header;
		container-type: inline-size;
		display: flex;
		height: 2.5rem;
		min-width: 0;
		flex: 0 0 auto;
		align-items: stretch;
		gap: 2px;
		overflow: hidden;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-surface);
		padding: 0 0.25rem;
	}

	.preview-header--mobile {
		height: 2.75rem;
		align-items: center;
		padding: 0 0.25rem 0 0.125rem;
	}

	/* Tabs scroll first; the trailing actions stay pinned above them. */
	.preview-tabs-scroll {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		align-items: stretch;
		gap: 1px;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
	}

	.preview-trailing {
		position: relative;
		z-index: 1;
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		align-self: stretch;
		gap: 2px;
		margin-left: 2px;
		background: var(--bg-surface);
	}

	/* Fade the last tab out as it scrolls under the pinned actions. */
	.preview-trailing::before {
		content: "";
		position: absolute;
		left: -12px;
		top: 0;
		bottom: 0;
		width: 12px;
		background: linear-gradient(to right, transparent, var(--bg-surface));
		pointer-events: none;
	}

	.preview-divider {
		width: 1px;
		height: 18px;
		margin: 0 2px;
		flex: 0 0 auto;
		background: var(--border-subtle);
	}

	.preview-icon-action {
		display: inline-flex;
		height: 1.75rem;
		width: 1.75rem;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.preview-icon-action:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.preview-icon-action.active {
		background: var(--bg-hover-strong);
		color: var(--text-secondary);
	}

	.preview-icon-action:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.preview-tab-shell {
		position: relative;
		display: inline-flex;
		min-width: 0;
		max-width: 12rem;
		height: 100%;
		align-items: center;
		color: var(--text-tertiary);
	}

	.preview-tab-shell:hover {
		color: var(--text-secondary);
	}

	.preview-tab-shell.active {
		color: var(--text-primary);
	}

	.preview-tab-shell.active::after {
		content: "";
		position: absolute;
		left: 0.25rem;
		right: 0.25rem;
		bottom: 0;
		height: 2px;
		border-radius: 2px 2px 0 0;
		background: var(--brand);
	}

	.preview-tab {
		display: inline-flex;
		min-width: 0;
		height: 100%;
		align-items: center;
		gap: 0.375rem;
		padding: 0 0.375rem;
		font-size: 0.75rem;
		line-height: 1rem;
		white-space: nowrap;
	}

	.preview-tab-icon {
		display: inline-flex;
		flex: 0 0 auto;
		opacity: 0.6;
	}

	.preview-tab-shell.active .preview-tab-icon {
		opacity: 1;
	}

	.preview-tab-close {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		margin-right: 0.125rem;
		border-radius: 4px;
		opacity: 0;
		color: var(--text-tertiary);
		transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
	}

	.preview-tab-shell:hover .preview-tab-close,
	.preview-tab-shell.active .preview-tab-close {
		opacity: 0.55;
	}

	.preview-tab-close:hover {
		background: var(--bg-hover);
		opacity: 1;
		color: var(--text-secondary);
	}

	.preview-menu-item--disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.preview-actions-menu {
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-elevated);
		padding: 4px;
		box-shadow: 0 10px 24px color-mix(in srgb, var(--overlay-scrim-strong) 16%, transparent);
	}

	/* Float presentation */
	.preview-header--float {
		position: absolute;
		top: 10px;
		left: var(--preview-safe-left, 10px);
		right: var(--preview-safe-right, 10px);
		z-index: 35;
		display: flex;
		height: auto;
		min-width: 0;
		justify-content: flex-end;
		overflow: visible;
		border: 0;
		background: transparent;
		padding: 0;
		pointer-events: none;
	}

	.preview-float-bar {
		position: relative;
		display: flex;
		max-width: 100%;
		min-height: 38px;
		align-items: center;
		gap: 2px;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-elevated);
		padding: 3px;
		box-shadow: 0 8px 22px color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		pointer-events: auto;
	}

	.preview-float-controls {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 2px;
	}

	.preview-switcher {
		position: relative;
		min-width: 0;
	}

	.preview-switcher-trigger {
		display: flex;
		height: 30px;
		min-width: 0;
		max-width: 168px;
		align-items: center;
		gap: 6px;
		border-radius: 6px;
		padding: 0 7px;
		color: var(--text-secondary);
		font-size: 12px;
	}

	.preview-switcher-trigger:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.preview-switcher-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.preview-switcher-chevron {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-placeholder);
	}

	.preview-switcher-menu {
		position: absolute;
		top: calc(100% + 7px);
		left: 0;
		width: min(280px, calc(100vw - 24px));
		max-height: min(52dvh, 360px);
		overflow-y: auto;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-elevated);
		padding: 4px;
		box-shadow: 0 12px 28px color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent);
	}

	.preview-switcher-item {
		display: flex;
		align-items: center;
		border-radius: 6px;
		color: var(--text-tertiary);
	}

	.preview-switcher-item:hover,
	.preview-switcher-item.active {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.preview-switcher-item-main {
		display: flex;
		height: 32px;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 7px;
		padding: 0 7px;
		font-size: 12px;
		text-align: left;
	}

	.preview-switcher-item-close {
		display: inline-flex;
		height: 26px;
		width: 26px;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		margin-right: 3px;
		border-radius: 6px;
		color: var(--text-tertiary);
	}

	.preview-switcher-item-close:hover {
		background: var(--bg-surface);
		color: var(--text-primary);
	}

	@media (pointer: coarse) {
		.preview-icon-action {
			height: 2rem;
			width: 2rem;
		}
		.preview-tab-close {
			opacity: 0.55;
		}
	}
</style>
