<script lang="ts">
import {
	Check,
	File as FileIcon,
	Globe,
	Maximize2,
	Menu,
	Minimize2,
	MonitorSmartphone,
	MoreHorizontal,
	MousePointer2,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
	Rocket,
	X,
} from "lucide-svelte";
import type { Snippet } from "svelte";
import { floatNear } from "#lib/actions/portal.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { uiState } from "#lib/stores/ui.svelte.ts";
import type {
	PreviewChrome,
	PreviewHeaderAction,
	PreviewHeaderVariant,
} from "./preview-header.ts";
import WindowSyncStatus from "./WindowSyncStatus.svelte";
import type { Window } from "./windows.ts";

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
	controls?: Snippet;
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

let actionsMenuOpen = $state(false);
let actionsMenuAnchor = $state<HTMLButtonElement | null>(null);

const desktop = $derived(variant === "dock");
const focusLabel = $derived(
	chrome.focus
		? m.preview_exit_focus({}, { locale })
		: m.preview_focus({}, { locale }),
);
const mainLabel = $derived(
	chrome.mainHidden
		? m.preview_show_chat({}, { locale })
		: m.preview_hide_chat({}, { locale }),
);
const treeLabel = $derived(
	chrome.treeVisible
		? m.files_collapse_tree({}, { locale })
		: m.files_show_tree({}, { locale }),
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
			onpointerdown={(event) => {
				if (action.keepFocus) event.preventDefault();
			}}
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
				class="preview-actions-menu menu-surface"
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
	{:else if chrome.onToggleMain}
		<div class="preview-leading">
			<button
				type="button"
				class="preview-icon-action"
				title={mainLabel}
				aria-label={mainLabel}
				onclick={() => chrome.onToggleMain?.()}
			>
				{#if chrome.mainHidden}
					<PanelLeftOpen class="h-3.5 w-3.5" />
				{:else}
					<PanelLeftClose class="h-3.5 w-3.5" />
				{/if}
			</button>
			<div class="preview-divider"></div>
		</div>
	{/if}

	<div class="preview-tabs-scroll" role="tablist" aria-label={m.window_open({}, { locale })}>
		{#each windows as tab (`${tab.kind}:${tab.key}`)}
			{@render TabButton(tab)}
		{/each}
	</div>

	<div class="preview-trailing">
		{@render controls?.()}
		{@render PrimaryActions()}
		{@render ActionsMenuButton()}
		{#if desktop && (chrome.onToggleFocus || chrome.onToggleTree)}
			<div class="preview-divider"></div>
		{/if}
		{#if desktop && chrome.onToggleFocus}
			<button
				type="button"
				class="preview-icon-action"
				title={focusLabel}
				aria-label={focusLabel}
				onclick={() => chrome.onToggleFocus?.()}
			>
				{#if chrome.focus}
					<Minimize2 class="h-3.5 w-3.5" />
				{:else}
					<Maximize2 class="h-3.5 w-3.5" />
				{/if}
			</button>
		{/if}
		{#if desktop && chrome.onToggleTree}
			<button
				type="button"
				class="preview-icon-action"
				title={treeLabel}
				aria-label={treeLabel}
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

	.preview-leading {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 2px;
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
		padding: 4px;
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
