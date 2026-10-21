<script lang="ts">
import type { SessionGoal, SessionGoalStatus } from "@neta-art/cohub";
import { Check, Pause, Pencil, Play, Target, X } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

let {
	goal,
	pending = false,
	onpause,
	onresume,
	oncomplete,
	onclear,
	onedit,
}: {
	goal: SessionGoal;
	pending?: boolean;
	onpause?: () => void;
	onresume?: () => void;
	oncomplete?: () => void;
	onclear?: () => void;
	onedit?: () => void;
} = $props();

const locale = $derived(getLocale());
const statusLabel = $derived.by(() => {
	const status = goal.status as SessionGoalStatus;
	return {
		active: m.goal_status_active({}, { locale }),
		paused: m.goal_status_paused({}, { locale }),
		blocked: m.goal_status_blocked({}, { locale }),
		budget_limited: m.goal_status_budget_limited({}, { locale }),
		complete: m.goal_status_complete({}, { locale }),
	}[status];
});
const statusTone = $derived.by(() => {
	switch (goal.status) {
		case "active":
			return "text-emerald-600 dark:text-emerald-400";
		case "blocked":
		case "budget_limited":
			return "text-amber-600 dark:text-amber-400";
		case "complete":
			return "text-text-tertiary";
		default:
			return "text-text-secondary";
	}
});
const formatTokens = (value: number) =>
	new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(Math.max(0, value));
const usageLabel = $derived(
	goal.tokenBudget == null
		? m.goal_used({ used: formatTokens(goal.tokensUsed) }, { locale })
		: m.goal_usage(
				{
					used: formatTokens(goal.tokensUsed),
					budget: formatTokens(goal.tokenBudget),
				},
				{ locale },
			),
);
const elapsedLabel = $derived.by(() => {
	const seconds = Math.max(0, goal.timeUsedSeconds);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
});
</script>

<div
	class="session-goal-bar chat-gutter-x border-b border-chat-panel-border/70 bg-chat-panel"
	data-session-goal
>
	<div
		class="mx-auto flex w-full max-w-[var(--chat-content-max-width)] flex-wrap items-center gap-x-3 gap-y-1 px-[var(--chat-msg-inset)] py-2 text-[12px]"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<Target class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
			<span class:font-medium={goal.status === "active"} class={statusTone}
				>{statusLabel}</span
			>
			<span
				class="min-w-0 truncate text-text-secondary"
				title={goal.objective}>{goal.objective}</span
			>
		</div>
		<div class="flex shrink-0 items-center gap-3 text-[11px] text-text-placeholder">
			<span>{usageLabel}</span>
			<span>{elapsedLabel}</span>
			{#if goal.status === "active"}
				<button
					type="button"
					class="rounded p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
					title={m.goal_pause({}, { locale })}
					disabled={pending}
					onclick={onpause}><Pause class="h-3.5 w-3.5" /></button
				>
			{:else if goal.status === "paused" || goal.status === "blocked"}
				<button
					type="button"
					class="rounded p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
					title={m.goal_resume({}, { locale })}
					disabled={pending}
					onclick={onresume}><Play class="h-3.5 w-3.5" /></button
				>
			{/if}
			{#if goal.status !== "complete"}
				<button
					type="button"
					class="rounded p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
					title={m.goal_edit({}, { locale })}
					disabled={pending}
					onclick={onedit}><Pencil class="h-3.5 w-3.5" /></button
				>
				<button
					type="button"
					class="rounded p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
					title={m.goal_complete({}, { locale })}
					disabled={pending}
					onclick={oncomplete}><Check class="h-3.5 w-3.5" /></button
				>
			{/if}
			<button
				type="button"
				class="rounded p-1 text-text-placeholder hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50"
				title={m.goal_clear({}, { locale })}
				disabled={pending}
				onclick={onclear}><X class="h-3.5 w-3.5" /></button
			>
		</div>
	</div>
</div>
