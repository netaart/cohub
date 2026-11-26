<script lang="ts" module>
const COLLAPSED_KEY = "cohub:stats-timeline-collapsed";

function readCollapsed() {
	try {
		return localStorage.getItem(COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

let collapsed = $state(typeof window !== "undefined" && readCollapsed());

function toggle(event: Event & { currentTarget: HTMLDetailsElement }) {
	collapsed = !event.currentTarget.open;
	try {
		if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1");
		else localStorage.removeItem(COLLAPSED_KEY);
	} catch {}
}
</script>

<script lang="ts">
import { ChevronDown } from "lucide-svelte";
import { formatDurationMs } from "#lib/format-duration.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import {
	type StatsLabelKey,
	type StatsTimelineModel,
	type StatsTimelinePart,
	type StatsTimelineRow,
	statsTimeTone,
	statsToneClass,
} from "#lib/stats-view-model.ts";

let {
	timeline,
	count,
	label,
	modelName = (_provider: string, model: string) => model,
}: {
	timeline: StatsTimelineModel;
	count: string;
	label: (key: StatsLabelKey) => string;
	modelName?: (provider: string, model: string) => string;
} = $props();
const locale = $derived(getLocale());
const legend = $derived(
	(["queue", "modelTime", "toolTime", "otherTime"] as const).filter((key) =>
		timeline.rows.some((row) => row.parts.some((part) => part.key === key)),
	),
);

function partClass(part: StatsTimelinePart) {
	if (part.failed) return "bg-error-soft";
	return statsToneClass(statsTimeTone[part.key]);
}

function rowTitle(row: StatsTimelineRow) {
	const request = row.request;
	return [
		request?.model ? modelName(request.provider, request.model) : "",
		...row.breakdown.map((item) => `${label(item.key)} ${item.value}`),
	]
		.filter(Boolean)
		.join(" · ");
}
</script>

<details class="group border-t border-border-subtle pt-3" open={!collapsed} ontoggle={toggle}>
	<summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] text-text-secondary marker:hidden">
		<span class="inline-flex items-center gap-1 font-medium"><ChevronDown aria-hidden="true" class="h-3 w-3 -rotate-90 transition-transform group-open:rotate-0" />{m.stats_timeline({}, { locale })}</span>
		<span class="shrink-0 tabular-nums text-text-placeholder">{count}</span>
	</summary>
	<ol class="mt-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[10px] tabular-nums">
		{#each timeline.rows as row (row.key)}
			<li class="contents" title={rowTitle(row)}>
				<span class={`text-right ${row.failed ? "text-error-soft" : "text-text-placeholder"}`}>{row.label}</span>
				<div class="h-1.5">
					<div class="relative h-full min-w-0.5 overflow-hidden rounded-full" style={`width: ${row.width}%;`}>
						{#each row.parts as part, index (index)}
							<div class={`absolute inset-y-0 ${partClass(part)}`} style={`left: ${part.left}%; width: ${part.width}%;`}></div>
						{/each}
					</div>
				</div>
				<span class="text-right text-text-tertiary">{formatDurationMs(row.durationMs, locale)}</span>
			</li>
		{/each}
	</ol>
	<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-placeholder">
		{#each legend as key (key)}
			<span class="inline-flex items-center gap-1"><i aria-hidden="true" class={`h-1.5 w-1.5 rounded-full ${statsToneClass(statsTimeTone[key])}`}></i>{label(key)}</span>
		{/each}
	</div>
</details>
