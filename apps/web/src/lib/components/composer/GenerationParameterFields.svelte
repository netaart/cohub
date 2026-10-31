<script lang="ts">
import type { GenerationParameterSpec } from "@cohub/protocol/generation";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	parameters,
	values,
	onchange,
	onclear,
}: {
	parameters: Readonly<Record<string, GenerationParameterSpec>>;
	values: Readonly<Record<string, unknown>>;
	onchange: (name: string, value: unknown) => void;
	onclear: (name: string) => void;
} = $props();

const locale = $derived(getLocale());
const entries = $derived(Object.entries(parameters));
</script>

{#each entries as [name, spec] (name)}
	<label class="parameter-row" title={spec.description}>
		<span>{name.replaceAll("_", " ")}</span>
		{#if spec.type === "boolean"}
			<input type="checkbox" checked={(values[name] ?? spec.default) === true} onchange={(event) => onchange(name, event.currentTarget.checked)} />
		{:else if spec.type === "string" && spec.enum}
			<select value={String(values[name] ?? spec.default ?? "")} onchange={(event) => event.currentTarget.value ? onchange(name, event.currentTarget.value) : onclear(name)}>
				<option value="">{m.board_auto({}, { locale })}</option>
				{#each spec.enum as value (value)}<option value={value}>{value}</option>{/each}
			</select>
		{:else if spec.type === "number" || spec.type === "integer"}
			<input type="number" min={spec.min} max={spec.max} step={spec.type === "integer" ? 1 : "any"} value={String(values[name] ?? spec.default ?? "")} placeholder={spec.default === undefined ? m.board_auto({}, { locale }) : String(spec.default)} oninput={(event) => event.currentTarget.value ? onchange(name, Number(event.currentTarget.value)) : onclear(name)} />
		{:else}
			<input value={String(values[name] ?? spec.default ?? "")} placeholder={spec.default === undefined ? m.board_auto({}, { locale }) : String(spec.default)} oninput={(event) => event.currentTarget.value ? onchange(name, event.currentTarget.value) : onclear(name)} />
		{/if}
	</label>
{/each}

<style>
	.parameter-row {
		display: grid;
		min-height: 34px;
		grid-template-columns: minmax(0, 1fr) minmax(90px, 140px);
		align-items: center;
		gap: 10px;
		padding: 3px 5px;
		font-size: 11px;
		text-transform: capitalize;
		color: var(--text-secondary);
	}
	.parameter-row input:not([type="checkbox"]),
	.parameter-row select {
		min-width: 0;
		height: 26px;
		border: 1px solid var(--border-subtle);
		border-radius: 5px;
		background: var(--bg-input);
		padding: 0 6px;
		font-size: 10px;
		color: var(--text-primary);
		outline: none;
	}
	.parameter-row input:not([type="checkbox"]):focus-visible,
	.parameter-row select:focus-visible {
		border-color: var(--brand);
	}
	.parameter-row input[type="checkbox"] {
		justify-self: end;
	}
	@media (pointer: coarse) {
		.parameter-row {
			min-height: 44px;
		}
		.parameter-row input:not([type="checkbox"]),
		.parameter-row select {
			height: 36px;
			font-size: 12px;
		}
		.parameter-row input[type="checkbox"] {
			width: 20px;
			height: 20px;
		}
	}
</style>
