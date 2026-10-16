<script lang="ts">
import type { GenerationParameterSpec } from "@cohub/protocol/generation";
import {
	generationParameterLabel,
	parseListParameter,
} from "$lib/generation-parameters";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	name,
	spec,
	value,
	disabled = false,
	onchange,
}: {
	name: string;
	spec: GenerationParameterSpec;
	value: unknown;
	disabled?: boolean;
	/** `undefined` clears the parameter so the model default applies. */
	onchange: (value: unknown) => void;
} = $props();

const locale = $derived(getLocale());
const label = $derived(generationParameterLabel(name));
const defaultText = $derived(
	spec.default === undefined
		? null
		: Array.isArray(spec.default)
			? spec.default.join(", ")
			: spec.type === "boolean"
				? spec.default
					? m.generation_param_on({}, { locale })
					: m.generation_param_off({}, { locale })
				: String(spec.default),
);
const unsetLabel = $derived(
	defaultText === null
		? m.board_auto({}, { locale })
		: m.generation_param_default({ value: defaultText }, { locale }),
);
const selectedItems = $derived(Array.isArray(value) ? value : []);

function toggleItem(options: readonly string[], option: string) {
	const next = options.filter((item) =>
		item === option
			? !selectedItems.includes(item)
			: selectedItems.includes(item),
	);
	onchange(next.length > 0 ? next : undefined);
}

function commitText(text: string, parse: (text: string) => unknown) {
	onchange(text.trim() ? parse(text) : undefined);
}
</script>

{#if spec.type === "array" && spec.items.type === "string" && spec.items.enum}
	{@const options = spec.items.enum}
	<div class="chip-group" role="group" aria-label={label}>
		{#each options as option (option)}
			<button
				type="button"
				class="chip"
				aria-pressed={selectedItems.includes(option)}
				{disabled}
				onclick={() => toggleItem(options, option)}
			>{option}</button>
		{/each}
	</div>
{:else if spec.type === "array"}
	{@const items = spec.items}
	<input
		class="field"
		aria-label={label}
		inputmode={items.type === "integer" ? "numeric" : "text"}
		value={selectedItems.join(", ")}
		placeholder={unsetLabel}
		{disabled}
		onchange={(event) =>
			commitText(event.currentTarget.value, (text) => parseListParameter(text, items))}
	/>
{:else if spec.type === "boolean"}
	<select
		class="field"
		aria-label={label}
		value={value === undefined ? "" : String(value)}
		{disabled}
		onchange={(event) =>
			onchange(event.currentTarget.value ? event.currentTarget.value === "true" : undefined)}
	>
		<option value="">{unsetLabel}</option>
		<option value="true">{m.generation_param_on({}, { locale })}</option>
		<option value="false">{m.generation_param_off({}, { locale })}</option>
	</select>
{:else if spec.type === "string" && spec.enum}
	<select
		class="field"
		aria-label={label}
		value={typeof value === "string" ? value : ""}
		{disabled}
		onchange={(event) => onchange(event.currentTarget.value || undefined)}
	>
		<option value="">{unsetLabel}</option>
		{#each spec.enum as option (option)}<option value={option}>{option}</option>{/each}
	</select>
{:else if spec.type === "number" || spec.type === "integer"}
	<input
		class="field"
		type="number"
		aria-label={label}
		min={spec.min}
		max={spec.max}
		step={spec.multipleOf ?? (spec.type === "integer" ? 1 : "any")}
		value={typeof value === "number" ? String(value) : ""}
		placeholder={unsetLabel}
		{disabled}
		oninput={(event) =>
			commitText(event.currentTarget.value, (text) => Number(text))}
	/>
{:else}
	<input
		class="field"
		aria-label={label}
		value={typeof value === "string" ? value : ""}
		placeholder={unsetLabel}
		{disabled}
		oninput={(event) => commitText(event.currentTarget.value, (text) => text)}
	/>
{/if}

<style>
	.field {
		width: 100%;
		min-width: 0;
		height: 28px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0 8px;
		font-size: 11px;
		color: var(--text-primary);
		outline: none;
		transition: border-color 100ms ease;
	}
	.field:hover:not(:disabled) { border-color: var(--border-strong); }
	.field:focus-visible { border-color: var(--brand); }
	.field:disabled { cursor: not-allowed; opacity: 0.5; }
	.field::placeholder { color: var(--text-placeholder); }
	.chip-group {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.chip {
		height: 24px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		padding: 0 8px;
		font-size: 11px;
		color: var(--text-secondary);
		transition: background-color 100ms ease, color 100ms ease, border-color 100ms ease;
	}
	.chip:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
	.chip:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
	.chip:active:not(:disabled) { background: var(--bg-hover-strong); }
	.chip:disabled { cursor: not-allowed; opacity: 0.5; }
	.chip[aria-pressed="true"] {
		border-color: transparent;
		background: var(--brand-bg);
		color: var(--brand-muted-fg);
	}
	@media (pointer: coarse) {
		.field { height: 36px; font-size: 13px; }
		.chip { height: 32px; font-size: 12px; }
	}
</style>
