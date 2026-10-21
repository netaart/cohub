<script lang="ts">
import type { SessionGoal } from "@neta-art/cohub";
import Dialog from "$lib/components/Dialog.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

let {
	open,
	goal = null,
	modelLabel = null,
	pending = false,
	onclose,
	onsubmit,
}: {
	open: boolean;
	goal?: SessionGoal | null;
	modelLabel?: string | null;
	pending?: boolean;
	onclose: () => void;
	onsubmit: (input: {
		objective: string;
		tokenBudget: number | null;
	}) => Promise<void>;
} = $props();

const locale = $derived(getLocale());
let objective = $state("");
let budget = $state("");
let error = $state<string | null>(null);
let submitting = $state(false);
let initialized = $state(false);

$effect(() => {
	if (!open) {
		initialized = false;
		return;
	}
	if (initialized) return;
	objective = goal?.objective ?? "";
	budget = goal?.tokenBudget == null ? "" : String(goal.tokenBudget);
	error = null;
	initialized = true;
});

const title = $derived(
	goal
		? m.goal_edit_title({}, { locale })
		: m.goal_dialog_title({}, { locale }),
);

async function submit(event: SubmitEvent) {
	event.preventDefault();
	error = null;
	const trimmed = objective.trim();
	if (!trimmed) {
		error = m.goal_invalid_objective({}, { locale });
		return;
	}
	const rawBudget = budget.trim();
	const parsedBudget = rawBudget ? Number(rawBudget) : null;
	if (
		parsedBudget != null &&
		(!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0)
	) {
		error = m.goal_invalid_budget({}, { locale });
		return;
	}
	submitting = true;
	try {
		await onsubmit({ objective: trimmed, tokenBudget: parsedBudget });
		onclose();
	} catch (submitError) {
		error =
			submitError instanceof Error
				? submitError.message
				: m.goal_action_failed({}, { locale });
	} finally {
		submitting = false;
	}
}
</script>

<Dialog {open} onClose={onclose} {title} maxWidth="520px">
	<form class="flex flex-col gap-4 p-1" onsubmit={submit}>
		<label class="flex flex-col gap-1.5 text-[12px] text-text-secondary">
			<span class="font-medium text-text-primary">{m.goal_objective_label({}, { locale })}</span>
			<textarea
				bind:value={objective}
				rows="5"
				class="w-full resize-y rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[13px] text-text-primary outline-none focus:border-brand/60"
				placeholder={m.goal_objective_placeholder({}, { locale })}
				disabled={pending || submitting}
			></textarea>
		</label>
		<label class="flex flex-col gap-1.5 text-[12px] text-text-secondary">
			<span class="font-medium text-text-primary">{m.goal_budget_label({}, { locale })}</span>
			<input
				bind:value={budget}
				type="number"
				min="1"
				step="1"
				inputmode="numeric"
				class="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[13px] text-text-primary outline-none focus:border-brand/60"
				placeholder={m.goal_budget_placeholder({}, { locale })}
				disabled={pending || submitting}
			/>
			<span class="text-[11px] text-text-placeholder">{m.goal_budget_hint({}, { locale })}</span>
		</label>
		{#if modelLabel}
			<div class="text-[11px] text-text-placeholder">{modelLabel}</div>
		{/if}
		{#if error}
			<div class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
				{error}
			</div>
		{/if}
		<div class="flex justify-end gap-2 pt-1">
			<button
				type="button"
				class="rounded-lg px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
				disabled={pending || submitting}
				onclick={onclose}>{m.common_cancel({}, { locale })}</button
			>
			<button
				type="submit"
				class="rounded-lg bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
				disabled={pending || submitting}>{goal ? m.goal_save({}, { locale }) : m.goal_start({}, { locale })}</button
			>
		</div>
	</form>
</Dialog>
