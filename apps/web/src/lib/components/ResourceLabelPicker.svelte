<script lang="ts">
import type {
	LabelAssignmentRecord,
	LabelListItem,
	LabelResourceType,
} from "@neta-art/cohub";
import { Check, Loader2, Plus, X } from "lucide-svelte";
import { fade, scale, slide } from "svelte/transition";
import { floatNear, portal } from "$lib/actions/portal";
import LabelCreateForm from "$lib/components/LabelCreateForm.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import {
	DURATION_MODAL_IN,
	DURATION_MODAL_OUT,
	svelteEaseIn,
	svelteEaseOut,
} from "$lib/motion.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	createSpaceLabel,
	fetchResourceLabelsFresh,
	flattenLabels,
	flattenLabelsWithRefs,
	getCachedResourceLabelsSnapshot,
	getCachedSpaceLabelsSnapshot,
	getLabelDisplayName,
	getLabelDisplayTitle,
	getLabelUserProfile,
	getResourceLabels,
	getSessionUserUuidFromLabel,
	hydrateUserProfilesForLabels,
	isSessionUserLabel,
	onSpaceLabelsCacheUpdated,
	onUserLabelProfilesUpdated,
	setResourceLabels,
} from "$lib/stores/space-labels";

const {
	spaceId,
	resourceType,
	resourceRef,
	anchorEl = null,
	onClose,
}: {
	spaceId: string;
	resourceType: LabelResourceType;
	resourceRef: string;
	/** Optional trigger element; desktop popover anchors near it when present. */
	anchorEl?: HTMLElement | null;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

let labels = $state<LabelListItem[]>([]);
let assignments = $state<LabelAssignmentRecord[]>([]);
let selected = $state<Set<string>>(new Set());
let saving = $state(false);
let error = $state("");
let showCreate = $state(false);
let initialLoadSettled = $state(false);
let loading = $state(false);
let loadVersion = 0;
let userLabelProfileVersion = $state(0);
const isCompact = $derived(useCompactShell());

const flatLabels = $derived(flattenLabels(labels));
const labelOptions = $derived(flattenLabelsWithRefs(labels));
const useAnchoredPopover = $derived(Boolean(anchorEl) && !isCompact);

const FADE_IN = { duration: DURATION_MODAL_IN, easing: svelteEaseOut };
const FADE_OUT = { duration: DURATION_MODAL_OUT, easing: svelteEaseIn };
const SCALE_IN = { ...FADE_IN, start: 0.97 };
const SCALE_OUT = { ...FADE_OUT, start: 0.97 };

function getReactiveLabelDisplayName(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelDisplayName(label);
}

function getReactiveLabelDisplayTitle(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelDisplayTitle(label);
}

function getReactiveLabelUserProfile(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelUserProfile(label);
}
const selectableLabelRefs = $derived(
	new Set(labelOptions.filter(canSelectLabel).map((label) => label.ref)),
);
const selectedCount = $derived(
	[...selected].filter((labelRef) => selectableLabelRefs.has(labelRef)).length,
);

function labelsEqual(a: LabelListItem[], b: LabelListItem[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((label, index) => {
		const other = b[index];
		return (
			other &&
			label.id === other.id &&
			label.name === other.name &&
			labelsEqual(label.children ?? [], other.children ?? [])
		);
	});
}

function assignmentRefsEqual(a: Set<string>, b: Set<string>) {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

function hydrateLabelUserProfiles(nextLabels = labels) {
	void hydrateUserProfilesForLabels(nextLabels).catch(() => undefined);
}

function updateLabels(nextLabels: LabelListItem[]) {
	if (!labelsEqual(labels, nextLabels)) labels = nextLabels;
	hydrateLabelUserProfiles(nextLabels);
}

function applyAssignments(
	nextLabels: LabelListItem[],
	nextAssignments: LabelAssignmentRecord[],
) {
	updateLabels(nextLabels);
	assignments = nextAssignments;
	const refsById = new Map(
		flattenLabelsWithRefs(nextLabels).map((label) => [label.id, label.ref]),
	);
	const nextSelected = new Set(
		nextAssignments
			.map((assignment) => refsById.get(assignment.labelId))
			.filter((ref): ref is string => Boolean(ref)),
	);
	if (!assignmentRefsEqual(selected, nextSelected)) selected = nextSelected;
}

async function load() {
	const version = ++loadVersion;
	initialLoadSettled = false;
	loading = true;
	error = "";
	try {
		const [treeCache, assignmentsCache] = await Promise.all([
			getCachedSpaceLabelsSnapshot(spaceId),
			getCachedResourceLabelsSnapshot(spaceId, resourceType, resourceRef),
		]);
		if (version !== loadVersion) return;
		if (treeCache?.labels) updateLabels(treeCache.labels);
		if (assignmentsCache) {
			applyAssignments(assignmentsCache.labels, assignmentsCache.assignments);
			if (!assignmentsCache.stale) return;
		}

		const result = await fetchResourceLabelsFresh(
			spaceId,
			resourceType,
			resourceRef,
		);
		if (version !== loadVersion) return;
		applyAssignments(result.labels, result.assignments);
	} catch (err) {
		if (version !== loadVersion) return;
		console.warn("[labels] Failed to load resource labels", err);
		error = "Labels unavailable";
	} finally {
		if (version === loadVersion) {
			initialLoadSettled = true;
			loading = false;
		}
	}
}

function canSelectLabel(label: LabelListItem) {
	return label.source === "user";
}

function toggleLabel(labelRef: string) {
	const next = new Set(selected);
	if (next.has(labelRef)) next.delete(labelRef);
	else next.add(labelRef);
	selected = next;
}

async function save() {
	saving = true;
	error = "";
	try {
		const previousLabelRefs = new Set(
			assignments
				.map(
					(assignment) =>
						labelOptions.find((label) => label.id === assignment.labelId)?.ref,
				)
				.filter((ref): ref is string => Boolean(ref)),
		);
		const result = await setResourceLabels(
			spaceId,
			resourceType,
			resourceRef,
			[...selected].filter((labelRef) => selectableLabelRefs.has(labelRef)),
			{
				previousLabelRefs: [...previousLabelRefs].filter((labelRef) =>
					selectableLabelRefs.has(labelRef),
				),
			},
		);
		updateLabels(result.labels);
		assignments = result.assignments;
		onClose();
	} catch (err) {
		console.warn("[labels] Failed to save resource labels", err);
		error = "Could not save labels";
	} finally {
		saving = false;
	}
}

async function createLabel(input: { name: string; parentRef: string | null }) {
	const label = await createSpaceLabel(
		spaceId,
		input.parentRef ? `${input.parentRef}/${input.name}` : input.name,
	);
	const result = await getResourceLabels(spaceId, resourceType, resourceRef);
	updateLabels(result.labels);
	assignments = result.assignments;
	if (label) {
		const createdRef = flattenLabelsWithRefs(result.labels).find(
			(item) => item.id === label.id,
		)?.ref;
		if (createdRef) selected = new Set([...selected, createdRef]);
	}
	showCreate = false;
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && !event.defaultPrevented) {
		event.preventDefault();
		onClose();
	}
}

$effect(() => {
	spaceId;
	resourceType;
	resourceRef;
	void load();
});

$effect(() => {
	const currentSpaceId = spaceId;
	const unsubscribe = onSpaceLabelsCacheUpdated(
		({ spaceId: updatedSpaceId, labels: nextLabels }) => {
			if (updatedSpaceId !== currentSpaceId) return;
			updateLabels(nextLabels);
		},
	);
	return unsubscribe;
});

$effect(() => {
	const unsubscribe = onUserLabelProfilesUpdated(() => {
		userLabelProfileVersion += 1;
	});
	hydrateLabelUserProfiles();
	return unsubscribe;
});
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet pickerBody()}
	<div class="label-picker-body">
		{#if initialLoadSettled && flatLabels.length === 0 && !showCreate}
			<div class="px-2 py-5 text-[12px] text-text-tertiary">
				<div class="font-medium text-text-secondary">{m.sidebar_no_labels({}, { locale })}</div>
				<div class="mt-1">{m.label_create_hint({}, { locale })}</div>
			</div>
		{:else if flatLabels.length > 0}
			<div class="space-y-[1px]">
				{#each labels as label (label.id)}
					{@const labelRef = labelOptions.find((item) => item.id === label.id)?.ref ?? label.name}
					<label class="label-row" class:system={!canSelectLabel(label)} title={getReactiveLabelDisplayTitle(label)}>
						<input type="checkbox" checked={selected.has(labelRef)} disabled={!canSelectLabel(label)} onchange={() => toggleLabel(labelRef)} />
						<span class="truncate">{getReactiveLabelDisplayName(label)}</span>
					</label>
					{#each label.children ?? [] as child (child.id)}
						{@const childRef = labelOptions.find((item) => item.id === child.id)?.ref ?? `${labelRef}/${child.name}`}
						{@const childProfile = getReactiveLabelUserProfile(child)}
						<label class="label-row child" class:system={!canSelectLabel(child)} title={getReactiveLabelDisplayTitle(child)}>
							<input type="checkbox" checked={selected.has(childRef)} disabled={!canSelectLabel(child)} onchange={() => toggleLabel(childRef)} />
							{#if childProfile || isSessionUserLabel(child)}
								<UserAvatar name={getReactiveLabelDisplayName(child)} avatarUrl={childProfile?.avatarUrl} seed={getSessionUserUuidFromLabel(child)} size="xxs" class="border-0" />
							{/if}
							<span class="truncate">{getReactiveLabelDisplayName(child)}</span>
						</label>
					{/each}
				{/each}
			</div>
		{/if}

		{#if showCreate}
			<div class="create-panel">
				<LabelCreateForm labels={labels} onSubmit={createLabel} onCancel={() => { showCreate = false; }} autofocus={showCreate} />
			</div>
		{/if}
	</div>

	{#if error}
		<div class="border-t border-border-subtle px-3 py-2 text-[12px] text-error-soft">{error}</div>
	{/if}

	<div class="label-picker-footer">
		<button type="button" class="label-action secondary" onclick={() => { showCreate = !showCreate; }}>
			<Plus class="h-3.5 w-3.5" /> {m.sidebar_new_label({}, { locale })}
		</button>
		<div class="selected-count" aria-live="polite">{m.label_selected_count({ count: selectedCount }, { locale })}</div>
		<button type="button" class="label-action primary" disabled={saving} onclick={() => void save()}>
			{#if saving}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}
			{m.common_apply({}, { locale })}
		</button>
	</div>
{/snippet}

{#snippet pickerHeader(closeAriaLabel = m.common_close({}, { locale }))}
	<div class="flex items-start justify-between border-b border-border-subtle px-3 py-2.5">
		<div class="min-w-0">
			<div class="flex min-w-0 items-center gap-1.5">
				<div class="text-[13px] font-medium text-text-primary">{m.inline_label_as({}, { locale })}</div>
				{#if loading}
					<Loader2 class="h-3 w-3 animate-spin text-text-placeholder" aria-label={m.label_loading({}, { locale })} />
				{/if}
			</div>
			<div class="mt-0.5 text-[11px] text-text-tertiary">{m.label_choose_hint({}, { locale })}</div>
		</div>
		<button type="button" class="close-button" onclick={onClose} aria-label={closeAriaLabel}>
			<X class="h-3.5 w-3.5" />
		</button>
	</div>
{/snippet}

<div
	use:portal
	class="label-picker-root"
	class:is-anchored={useAnchoredPopover}
	class:is-compact={isCompact}
	role="presentation"
>
	<button
		type="button"
		class="label-picker-backdrop"
		class:is-soft={useAnchoredPopover}
		aria-label={m.label_dismiss_picker({}, { locale })}
		onclick={onClose}
		in:fade={FADE_IN}
		out:fade={FADE_OUT}
	></button>

	{#if useAnchoredPopover}
		<div
			class="label-picker label-picker--popover"
			role="dialog"
			aria-modal="true"
			aria-label={m.inline_label_as({}, { locale })}
			tabindex="-1"
			use:floatNear={{
				getAnchor: () => anchorEl,
				placement: "bottom-end",
				gap: 8,
				width: 360,
				zIndex: 121,
			}}
			in:fade|local={FADE_IN}
			out:fade|local={FADE_OUT}
		>
			{@render pickerHeader()}
			{@render pickerBody()}
		</div>
	{:else if isCompact}
		<div
			class="label-picker label-picker--sheet"
			role="dialog"
			aria-modal="true"
			aria-label={m.inline_label_as({}, { locale })}
			tabindex="-1"
			in:slide|local={{ axis: "y", ...FADE_IN }}
			out:slide|local={{ axis: "y", ...FADE_OUT }}
		>
			<div class="sheet-handle" aria-hidden="true"></div>
			{@render pickerHeader()}
			{@render pickerBody()}
		</div>
	{:else}
		<div
			class="label-picker label-picker--modal"
			role="dialog"
			aria-modal="true"
			aria-label={m.inline_label_as({}, { locale })}
			tabindex="-1"
			in:scale|local={SCALE_IN}
			out:scale|local={SCALE_OUT}
		>
			{@render pickerHeader()}
			{@render pickerBody()}
		</div>
	{/if}
</div>

<style>
	.label-picker-root {
		position: fixed;
		inset: 0;
		z-index: 120;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		pointer-events: none;
	}

	.label-picker-root.is-anchored {
		align-items: stretch;
		justify-content: stretch;
	}

	.label-picker-root:not(.is-anchored):not(.is-compact) {
		align-items: center;
		padding: 16px;
	}

	.label-picker-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		margin: 0;
		background: var(--overlay-scrim);
		pointer-events: auto;
		cursor: default;
	}

	.label-picker-backdrop.is-soft {
		background: color-mix(in srgb, var(--overlay-scrim) 35%, transparent);
	}

	.label-picker {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		background: var(--bg-primary);
		pointer-events: auto;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
	}

	.label-picker--popover {
		width: 360px;
		max-height: min(74vh, 580px);
		border-radius: 10px;
	}

	.label-picker--modal {
		width: min(380px, calc(100vw - 32px));
		max-height: min(74vh, 580px);
		border-radius: 12px;
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.32);
	}

	.label-picker--sheet {
		width: 100%;
		max-width: 480px;
		max-height: min(86dvh, 720px);
		border-radius: 16px 16px 0 0;
		border-bottom: 0;
		border-left: 0;
		border-right: 0;
		box-shadow: 0 -12px 36px rgba(0, 0, 0, 0.28);
	}

	.label-picker-body {
		min-height: 0;
		flex: 1 1 auto;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 8px;
		-webkit-overflow-scrolling: touch;
	}

	.label-row {
		display: flex;
		min-width: 0;
		min-height: 32px;
		align-items: center;
		gap: 8px;
		border-radius: 6px;
		padding: 0 8px;
		color: var(--text-secondary);
		font-size: 13px;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.label-row:hover { background: var(--bg-hover); color: var(--text-primary); }
	.label-row.child { padding-left: 28px; color: var(--text-tertiary); }
	.label-row.system { cursor: default; opacity: 0.82; }
	.label-row input { flex-shrink: 0; accent-color: var(--brand); }

	.create-panel {
		margin-top: 10px;
		border-top: 1px solid var(--border-subtle);
		padding: 12px 2px 2px;
	}

	.close-button,
	.label-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-radius: 6px;
		font-size: 12px;
		line-height: 1;
		transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
	}

	.close-button {
		min-height: 28px;
		min-width: 28px;
		color: var(--text-tertiary);
	}

	.close-button:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.label-picker-footer {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 8px;
		border-top: 1px solid var(--border-subtle);
		padding: 8px 12px;
		flex-shrink: 0;
	}

	.label-action {
		min-height: 32px;
		padding: 7px 10px;
	}

	.label-action.primary {
		background: var(--brand);
		color: var(--brand-contrast-fg);
	}

	.label-action.primary:disabled { opacity: 0.55; }
	.label-action.secondary { color: var(--text-tertiary); }
	.label-action.secondary:hover { background: var(--bg-hover); color: var(--text-secondary); }

	.selected-count {
		color: var(--text-placeholder);
		font-size: 11px;
		text-align: right;
	}

	.sheet-handle {
		display: block;
		margin: 8px auto 2px;
		height: 4px;
		width: 36px;
		border-radius: 999px;
		background: var(--border-strong);
		opacity: 0.75;
		flex-shrink: 0;
	}

	.label-picker-root.is-compact .label-row {
		min-height: 44px;
		font-size: 14px;
	}

	.label-picker-root.is-compact .label-row.child {
		padding-left: 34px;
	}

	.label-picker-root.is-compact .close-button,
	.label-picker-root.is-compact .label-action {
		min-height: 44px;
	}

	.label-picker-root.is-compact .close-button {
		min-width: 44px;
	}

	.label-picker-root.is-compact .label-picker-footer {
		grid-template-columns: 1fr 1fr;
		padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
	}

	.label-picker-root.is-compact .selected-count {
		display: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.label-picker,
		.label-picker-backdrop {
			transition: none !important;
		}
	}
</style>
