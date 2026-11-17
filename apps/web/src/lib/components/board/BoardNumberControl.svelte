<script lang="ts">
import { Minus, Plus } from "lucide-svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	value,
	fallback,
	min,
	max,
	step = 1,
	label,
	onChange,
}: {
	value: number | null;
	fallback: number;
	min: number;
	max: number;
	step?: number;
	label: string;
	onChange: (value: number) => void;
} = $props();

const locale = $derived(getLocale());

let input: HTMLInputElement | null = null;

function clamp(value: number) {
	return Math.min(max, Math.max(min, value));
}

function clean(value: number) {
	return Number(clamp(value).toFixed(4));
}

function display(value: number | null) {
	return value === null ? "" : String(value);
}

function commit(input: HTMLInputElement) {
	const parsed = Number(input.value);
	if (input.value.trim() && Number.isFinite(parsed)) {
		const next = clean(parsed);
		input.value = display(next);
		onChange(next);
		return;
	}
	input.value = display(value);
}

function nudge(direction: -1 | 1) {
	const draft = input?.value.trim() ?? "";
	const parsed = Number(draft);
	const base = draft && Number.isFinite(parsed) ? parsed : (value ?? fallback);
	const next = clean(base + step * direction);
	if (input) input.value = display(next);
	onChange(next);
}

function handleKeydown(event: KeyboardEvent) {
	event.stopPropagation();
	const input = event.currentTarget as HTMLInputElement;
	if (event.key === "Enter") {
		event.preventDefault();
		commit(input);
		input.select();
	} else if (event.key === "Escape") {
		event.preventDefault();
		input.value = display(value);
		input.blur();
	}
}
</script>

<div class="number-control" class:number-control--mixed={value === null}>
	<button
		type="button"
		class="number-step"
		title="Decrease {label.toLowerCase()}"
		aria-label="Decrease {label.toLowerCase()}"
		disabled={value !== null && value <= min}
		onpointerdown={(event) => event.preventDefault()}
		onclick={() => nudge(-1)}
	>
		<Minus class="h-3 w-3" />
	</button>
	<input
		bind:this={input}
		class="number-input"
		type="text"
		inputmode="decimal"
		value={display(value)}
		placeholder="Mix"
		aria-label={label}
		title={label}
		onblur={(event) => commit(event.currentTarget)}
		onkeydown={handleKeydown}
	/>
	<button
		type="button"
		class="number-step"
		title="Increase {label.toLowerCase()}"
		aria-label="Increase {label.toLowerCase()}"
		disabled={value !== null && value >= max}
		onpointerdown={(event) => event.preventDefault()}
		onclick={() => nudge(1)}
	>
		<Plus class="h-3 w-3" />
	</button>
</div>

<style>
	.number-control {
		display: grid;
		grid-template-columns: 24px 38px 24px;
		height: 24px;
		flex-shrink: 0;
		align-items: stretch;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		overflow: hidden;
	}

	.number-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-tertiary);
		transition: background-color 100ms ease, color 100ms ease;
	}
	.number-step:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	.number-step:disabled { opacity: 0.35; }

	.number-input {
		min-width: 0;
		border-right: 1px solid var(--border-subtle);
		border-left: 1px solid var(--border-subtle);
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-align: center;
		outline: none;
	}
	.number-input::placeholder { color: var(--text-placeholder); }
	.number-input:focus {
		background: var(--bg-surface);
		box-shadow: inset 0 0 0 1px var(--brand-border);
	}

	@media (pointer: coarse) {
		.number-control {
			grid-template-columns: 32px 44px 32px;
			height: 32px;
			border-radius: 7px;
		}
		.number-input { font-size: 12px; }
	}
</style>
