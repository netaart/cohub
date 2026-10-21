<script lang="ts">
import type {
	SandboxImageId,
	SandboxPreferenceStatus,
} from "@cohub/protocol/sandbox";
import type { SpaceSandboxRecord } from "@neta-art/cohub";
import { formatDateTime } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	sandbox,
	preferences,
}: {
	sandbox: SpaceSandboxRecord | null;
	preferences?: SandboxPreferenceStatus;
} = $props();

const locale = $derived(getLocale());
const time = (value?: string | null) =>
	(value && formatDateTime(value, locale)) || "—";
const image = (value: SandboxImageId | null) =>
	value === "game"
		? m.sandbox_image_game({}, { locale })
		: value
			? m.sandbox_image_default({}, { locale })
			: "—";
const reportedImage = $derived.by(() => {
	const fallback = sandbox?.meta?.imageVersion;
	return (
		sandbox?.reportedImageVersion ??
		(typeof fallback === "string" ? fallback : null)
	);
});
const rows = $derived<[string, string, boolean?][]>([
	[m.sandbox_stop_reason({}, { locale }), sandbox?.stopReason ?? "—"],
	[m.space_last_rpc({}, { locale }), time(sandbox?.lastActivityAt)],
	[m.space_heartbeat({}, { locale }), time(sandbox?.lastHeartbeatAt)],
	[m.space_health_stopped({}, { locale }), time(sandbox?.stoppedAt)],
	[m.space_pod({}, { locale }), sandbox?.podName ?? "—", true],
	[m.space_desired_image({}, { locale }), sandbox?.desiredImage ?? "—", true],
	[m.space_reported_image({}, { locale }), reportedImage ?? "—", true],
	...(preferences?.applicable
		? ([
				[
					m.sandbox_environment_requested({}, { locale }),
					`${image(preferences.requested.image)} · ${preferences.requested.spec}`,
				],
				[
					m.sandbox_environment_effective({}, { locale }),
					`${image(preferences.effective.image)} · ${preferences.effective.spec}`,
				],
				[
					m.sandbox_environment_applied({}, { locale }),
					`${image(preferences.applied.image)} · ${preferences.applied.spec ?? "—"}`,
				],
			] satisfies [string, string][])
		: []),
]);
const sources = $derived(
	preferences?.applicable
		? preferences.sources.filter(
				(source) => source.preferences.image || source.preferences.spec,
			)
		: [],
);
</script>

<details class="group border-t border-border-subtle py-2 text-[12px]">
	<summary class="flex min-h-11 w-fit cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden gap-1.5 text-text-secondary hover:text-text-primary lg:min-h-8">
		<span aria-hidden="true" class="text-text-tertiary transition-transform group-open:rotate-90">›</span>
		{m.runtime_diagnostics({}, { locale })}
	</summary>
	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 pb-3 pt-1">
		{#each rows as [label, value, mono] (label)}
			<dt class="text-text-tertiary">{label}</dt>
			<dd class="min-w-0 break-all text-text-secondary {mono ? 'font-mono text-[11px] leading-[18px]' : ''}">{value}</dd>
		{/each}
	</dl>
	{#if sources.length}
		<p class="text-text-tertiary">{m.sandbox_environment_sources({}, { locale })}</p>
		<ul class="mt-1 space-y-1 pb-3">
			{#each sources as source (source.source)}
				<li class="break-all font-mono text-[11px] leading-[18px] text-text-secondary">{source.source}: {source.preferences.image ?? "—"} / {source.preferences.spec ?? "—"}</li>
			{/each}
		</ul>
	{/if}
</details>
