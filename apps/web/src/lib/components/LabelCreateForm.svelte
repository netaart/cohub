<script lang="ts">
import type { LabelListItem } from "@neta-art/cohub";
import { ChevronDown, Plus } from "lucide-svelte";
import { tick } from "svelte";
import Spinner from "#lib/components/Spinner.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import {
	flattenLabels,
	flattenLabelsWithRefs,
	getLabelDisplayName,
	onUserLabelProfilesUpdated,
} from "#lib/stores/space-labels.ts";

const {
	labels,
	onSubmit,
	onCancel,
	submitLabel = "Create",
	errorLabel = "Could not create label",
	autofocus = false,
}: {
	labels: LabelListItem[];
	onSubmit: (input: {
		name: string;
		parentRef: string | null;
	}) => Promise<void>;
	onCancel?: () => void;
	submitLabel?: string;
	errorLabel?: string;
	autofocus?: boolean;
} = $props();

const locale = $derived(getLocale());

let name = $state("");
let parentId = $state("");
let saving = $state(false);
let error = $state("");
let nameInput = $state<HTMLInputElement>();
let userLabelProfileVersion = $state(0);

const rootLabels = $derived(
	flattenLabels(labels).filter(
		(label) => label.depth === 0 && label.source === "user",
	),
);

function getReactiveLabelDisplayName(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelDisplayName(label);
}

async function focusNameInput() {
	if (!autofocus) return;
	await tick();
	nameInput?.focus();
}

$effect(() => {
	void focusNameInput();
});

$effect(() => {
	const unsubscribe = onUserLabelProfilesUpdated(() => {
		userLabelProfileVersion += 1;
	});
	return unsubscribe;
});

async function submit() {
	const trimmed = name.replace(/\s+/g, " ").trim();
	if (!trimmed || saving) return;
	saving = true;
	error = "";
	try {
		const parentRef = parentId
			? flattenLabelsWithRefs(labels).find((label) => label.id === parentId)
					?.ref
			: null;
		await onSubmit({ name: trimmed, parentRef: parentRef ?? null });
		name = "";
		parentId = "";
	} catch (err) {
		console.warn("[labels] Failed to create label", err);
		error = errorLabel;
	} finally {
		saving = false;
	}
}
</script>

<div class="label-create-form">
	<div class="label-field">
		<label for="label-create-name">Label name</label>
		<input
			id="label-create-name"
			bind:this={nameInput}
			bind:value={name}
			maxlength="80"
			placeholder="Label name"
			onkeydown={(event) => { if (event.key === "Enter") void submit(); }}
		/>
	</div>

	<div class="label-field">
		<label for="label-create-parent">Nest under</label>
		<div class="select-wrap">
			<select id="label-create-parent" bind:value={parentId}>
				<option value="">None</option>
				{#each rootLabels as label (label.id)}
					<option value={label.id}>{getReactiveLabelDisplayName(label)}</option>
				{/each}
			</select>
			<ChevronDown class="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
		</div>
	</div>

	{#if error}<div class="label-create-error" role="status">{error}</div>{/if}

	<div class="label-create-actions">
		{#if onCancel}
			<button type="button" class="label-dialog-button ghost" onclick={onCancel}>{m.common_cancel({}, { locale })}</button>
		{/if}
		<button type="button" class="label-dialog-button primary-key" disabled={!name.trim() || saving} onclick={() => void submit()}>
			{#if saving}<Spinner class="h-3 w-3" />{:else}<Plus class="h-3 w-3" />{/if}
			{submitLabel}
		</button>
	</div>
</div>

<style>
	.label-create-form {
		display: grid;
		gap: 12px;
	}

	.label-field {
		display: grid;
		gap: 5px;
	}

	.label-field label {
		color: var(--text-tertiary);
		font-size: 11px;
		line-height: 1.2;
	}

	.label-field input,
	.label-field select {
		min-height: 34px;
		width: 100%;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 13px;
		outline: none;
		padding: 7px 9px;
		transition: border-color 120ms ease, box-shadow 120ms ease;
	}

	.label-field select {
		appearance: none;
		padding-right: 30px;
	}

	.label-field input:focus,
	.label-field select:focus {
		border-color: var(--brand);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 20%, transparent);
	}

	.select-wrap {
		position: relative;
	}

	.label-create-error {
		color: var(--color-error-soft);
		font-size: 12px;
	}

	.label-create-actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
	}

	.label-dialog-button {
		display: inline-flex;
		min-height: 32px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-radius: 6px;
		padding: 7px 10px;
		font-size: 12px;
		line-height: 1;
		transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
	}

	.label-dialog-button.ghost {
		color: var(--text-tertiary);
	}

	.label-dialog-button.ghost:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	@media (max-width: 640px) {
		.label-field input,
		.label-field select,
		.label-dialog-button {
			min-height: 44px;
			font-size: 14px;
		}

		.label-create-actions {
			grid-template-columns: 1fr 1fr;
			display: grid;
		}
	}
</style>
