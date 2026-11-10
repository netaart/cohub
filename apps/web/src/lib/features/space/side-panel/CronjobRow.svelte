<script lang="ts">
import type { CronJobRecord } from "@neta-art/cohub";
import { Clock } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import SidePanelRow from "./SidePanelRow.svelte";

type Props = {
	job: CronJobRecord;
	active?: boolean;
	onOpen: () => void;
};

const { job, active = false, onOpen }: Props = $props();
const locale = $derived(getLocale());
</script>

<SidePanelRow title={job.title} subtitle={job.cronExpression} {active} {onOpen}>
	{#snippet leading()}
		<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] {job.enabled ? 'text-status-running' : 'text-text-placeholder'}">
			<Clock class="h-3.5 w-3.5" />
		</span>
	{/snippet}
	{#snippet trailing()}
		{#if !job.enabled}
			<span class="px-1 text-[10px] text-text-placeholder">{m.cron_paused({}, { locale })}</span>
		{/if}
	{/snippet}
</SidePanelRow>
