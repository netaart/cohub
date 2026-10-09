<script lang="ts">
import { type ActivityDay, formatCompact } from "$lib/activity";
import { formatDate } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type HeatmapMode = "llm" | "generation";

type Props = {
	days: ActivityDay[];
};

const { days }: Props = $props();

const MODES: readonly HeatmapMode[] = ["llm", "generation"];
const LEVELS = [0, 1, 2, 3, 4] as const;

let mode = $state<HeatmapMode>("llm");

const locale = $derived(getLocale());
const rangeDays = $derived(days.length);

const total = $derived(days.reduce((sum, day) => sum + heatValue(day), 0));
const maxValue = $derived(Math.max(0, ...days.map((day) => heatValue(day))));
const cells = $derived.by(() => {
	if (!days.length) return [];
	const leading = new Date(`${days[0].date}T12:00:00`).getDay();
	const values: Array<ActivityDay | null> = [
		...Array.from({ length: leading }, () => null),
		...days,
	];
	while (values.length % 7) values.push(null);
	return values;
});

function heatValue(day: ActivityDay) {
	return mode === "llm" ? day.tokens : day.generationRequests;
}

function heatLevel(day: ActivityDay) {
	const value = heatValue(day);
	if (!value || !maxValue) return 0;
	const ratio = value / maxValue;
	if (ratio < 0.08) return 1;
	if (ratio < 0.25) return 2;
	if (ratio < 0.55) return 3;
	return 4;
}

function dayTitle(day: ActivityDay) {
	const params = {
		date: formatDate(`${day.date}T12:00:00`, locale),
		value: formatCompact(heatValue(day), locale),
	};
	return mode === "llm"
		? m.activity_day_title_llm(params, { locale })
		: m.activity_day_title_generation(params, { locale });
}
</script>

<section class="border-b border-border-subtle py-7">
	<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
		<h2 class="text-[13px] font-medium text-text-primary">{m.activity_daily_activity({}, { locale })}</h2>
		<div class="flex flex-wrap items-center justify-end gap-3">
			<div class="flex rounded-md bg-bg-surface p-0.5" aria-label={m.activity_type_aria({}, { locale })}>
				{#each MODES as option (option)}
					<button
						type="button"
						class="rounded-[4px] px-2.5 py-1 text-[10px] font-medium transition-colors {mode === option ? 'bg-bg-active text-text-primary' : 'text-text-placeholder hover:text-text-secondary'}"
						aria-pressed={mode === option}
						onclick={() => (mode = option)}
					>{option === "generation" ? m.activity_mode_generation({}, { locale }) : "LLM"}</button>
				{/each}
			</div>
			<div class="flex items-center gap-1.5 text-[10px] text-text-placeholder" aria-hidden="true">
				<span>{m.activity_less({}, { locale })}</span>
				{#each LEVELS as level (level)}
					<span class="heat-cell legend-cell" data-mode={mode} data-level={level}></span>
				{/each}
				<span>{m.activity_more({}, { locale })}</span>
			</div>
		</div>
	</div>
	<div class="heatmap-scroll overflow-x-auto pb-1">
		<div
			class="heatmap"
			style:--weeks={cells.length / 7}
			role="img"
			aria-label={mode === "llm"
				? m.activity_heatmap_llm_aria({ days: rangeDays }, { locale })
				: m.activity_heatmap_generation_aria({ days: rangeDays }, { locale })}
		>
			{#each cells as day, index (day?.date ?? `blank-${index}`)}
				{#if day}
					<div
						class="heat-cell"
						data-mode={mode}
						data-level={heatLevel(day)}
						title={dayTitle(day)}
					></div>
				{:else}
					<div></div>
				{/if}
			{/each}
		</div>
	</div>
	{#if total === 0}
		<p class="mt-4 text-[12px] text-text-placeholder">
			{mode === "llm"
				? m.activity_llm_empty_hint({}, { locale })
				: m.activity_generation_empty_hint({}, { locale })}
		</p>
	{/if}
</section>

<style>
	.heatmap-scroll {
		direction: rtl;
	}
	.heatmap {
		direction: ltr;
		display: grid;
		grid-auto-flow: column;
		grid-template-rows: repeat(7, 11px);
		grid-template-columns: repeat(var(--weeks), 11px);
		gap: 3px;
		min-width: max-content;
	}
	.heat-cell {
		display: inline-block;
		width: 11px;
		height: 11px;
		border-radius: 2px;
		background: var(--bg-hover);
	}
	.heat-cell[data-level="1"] { background: color-mix(in srgb, var(--brand) 24%, var(--bg-primary)); }
	.heat-cell[data-level="2"] { background: color-mix(in srgb, var(--brand) 42%, var(--bg-primary)); }
	.heat-cell[data-level="3"] { background: color-mix(in srgb, var(--brand) 66%, var(--bg-primary)); }
	.heat-cell[data-level="4"] { background: var(--brand); }
	.heat-cell[data-mode="generation"][data-level="1"] { background: color-mix(in srgb, var(--status-running) 24%, var(--bg-primary)); }
	.heat-cell[data-mode="generation"][data-level="2"] { background: color-mix(in srgb, var(--status-running) 42%, var(--bg-primary)); }
	.heat-cell[data-mode="generation"][data-level="3"] { background: color-mix(in srgb, var(--status-running) 66%, var(--bg-primary)); }
	.heat-cell[data-mode="generation"][data-level="4"] { background: var(--status-running); }
	@media (min-width: 640px) {
		.heatmap { grid-template-rows: repeat(7, 13px); grid-template-columns: repeat(var(--weeks), 13px); gap: 4px; }
		.heat-cell:not(.legend-cell) { width: 13px; height: 13px; }
	}
</style>
