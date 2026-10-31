<script lang="ts">
import { onMount, tick } from "svelte";
import {
	generationRoleLabel,
	generationRolePlaceholder,
} from "$lib/generation-role-labels";
import type {
	GenerationRoleTexts,
	GenerationTextRoleField,
} from "$lib/generation-text-roles";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";

const {
	fields,
	values,
	hint = null,
	readonly = false,
	autofocus = false,
	onchange,
	onsubmit,
}: {
	fields: readonly GenerationTextRoleField[];
	values: GenerationRoleTexts;
	/** Why sending is blocked; shown under the boxes. */
	hint?: string | null;
	readonly?: boolean;
	autofocus?: boolean;
	onchange: (role: string, text: string) => void;
	onsubmit?: () => void;
} = $props();

const locale = $derived(getLocale());
const uid = $props.id();
let group: HTMLDivElement | null = $state(null);

/** Lyrics are written line by line; a style description or a score starts as one line. */
function rowsFor(role: string) {
	switch (role) {
		case "prompt":
		case "abc":
			return 1;
		case "lyrics":
			return 3;
		default:
			return 2;
	}
}

/** A box grows to this many lines, then scrolls itself, so its label stays in view. */
function maxRowsFor(role: string) {
	switch (role) {
		case "prompt":
			return 3;
		case "lyrics":
			return 8;
		default:
			return 4;
	}
}

/** Grows with its text up to the box's own limit. */
function autogrow(node: HTMLTextAreaElement, _text: string) {
	const fit = () => {
		node.style.height = "auto";
		node.style.height = `${node.scrollHeight}px`;
	};
	fit();
	// The new value reaches the DOM after the action's update, so wait for the flush.
	return { update: () => void tick().then(fit) };
}

function handleKeydown(event: KeyboardEvent) {
	if (
		event.key !== "Enter" ||
		!(event.metaKey || event.ctrlKey) ||
		isComposingKeyboardEvent(event)
	)
		return;
	event.preventDefault();
	onsubmit?.();
}

onMount(() => {
	if (autofocus) group?.querySelector("textarea")?.focus();
});
</script>

<div
	bind:this={group}
	class="role-inputs"
	role="group"
	aria-label={m.generation_role_inputs_aria({}, { locale })}
>
	<div class="role-fields">
		{#each fields as field (field.role)}
			<div class="role-field">
				<label class="role-label" for={`${uid}-${field.role}`}>
					<span class="role-name">{generationRoleLabel(field.role, locale)}</span>
					<span class="role-need">
						{field.required ? m.generation_role_required({}, { locale }) : m.generation_role_optional({}, { locale })}
					</span>
				</label>
				<textarea
					id={`${uid}-${field.role}`}
					class="role-text"
					class:role-text--score={field.role === "abc"}
					rows={rowsFor(field.role)}
					style:max-height={`${maxRowsFor(field.role) * 24}px`}
					value={values[field.role] ?? ""}
					{readonly}
					aria-required={field.required}
					placeholder={generationRolePlaceholder(field.role, locale)}
					spellcheck={field.role === "abc" ? false : undefined}
					use:autogrow={values[field.role] ?? ""}
					oninput={(event) => onchange(field.role, event.currentTarget.value)}
					onkeydown={handleKeydown}
				></textarea>
			</div>
		{/each}
	</div>
	<p class="role-hint" role="status">
		{#if hint}{hint}{:else}<span class="role-shortcut">{m.generation_role_send_hint({}, { locale })}</span>{/if}
	</p>
</div>

<style>
	.role-inputs {
		padding-inline: var(--role-inputs-inset, 0px);
	}
	/* Safety net for short viewports; with the per-box limits the stack normally fits. */
	.role-fields {
		display: flex;
		flex-direction: column;
		max-height: min(52dvh, 440px);
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}
	.role-field {
		padding: 6px 0 4px;
		border-bottom: 1px solid var(--border-subtle);
	}
	.role-field:last-child {
		border-bottom-color: transparent;
	}
	.role-field:focus-within {
		border-bottom-color: var(--brand);
	}
	.role-label {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 11px;
		line-height: 16px;
		color: var(--text-tertiary);
	}
	.role-name {
		font-weight: 500;
		color: var(--text-secondary);
		transition: color 120ms ease;
	}
	.role-field:focus-within .role-name {
		color: var(--text-primary);
	}
	.role-text {
		display: block;
		width: 100%;
		min-height: 24px;
		resize: none;
		overflow-y: auto;
		scrollbar-width: thin;
		border: 0;
		background: transparent;
		padding: 0;
		font-size: 14px;
		line-height: 24px;
		color: var(--text-primary);
		outline: none;
	}
	.role-text:read-only {
		color: var(--text-secondary);
	}
	.role-text::placeholder {
		color: var(--text-placeholder);
	}
	.role-text--score {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.role-hint {
		margin: 0;
		padding: 4px 0 2px;
		font-size: 11px;
		line-height: 16px;
		color: var(--text-tertiary);
	}
	@media (pointer: fine) {
		/* Holds the row whether it names a missing box or the send shortcut, so the boxes do not jump. */
		.role-hint {
			min-height: 22px;
		}
	}
	@media (pointer: coarse) {
		.role-hint:has(.role-shortcut) {
			display: none;
		}
		.role-text {
			min-height: 32px;
			padding-block: 4px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.role-name {
			transition: none;
		}
	}
</style>
