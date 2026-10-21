<script lang="ts">
import type { SandboxSetupInfo } from "@cohub/protocol/sandbox";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { buildSpaceFileRoute } from "$lib/space-routes";

const {
	spaceId,
	local = false,
	setup,
}: {
	spaceId: string;
	local?: boolean;
	setup?: SandboxSetupInfo | null;
} = $props();
const locale = $derived(getLocale());
const status = $derived(
	setup?.status ??
		(setup
			? setup.error || setup.exitCode
				? "failed"
				: "succeeded"
			: undefined),
);
function statusLabel(status: string | undefined) {
	switch (status) {
		case "waiting":
			return m.sandbox_setup_waiting({}, { locale });
		case "running":
			return m.sandbox_setup_running({}, { locale });
		case "succeeded":
			return m.sandbox_setup_succeeded({}, { locale });
		case "failed":
			return m.sandbox_setup_failed({}, { locale });
		default:
			return m.sandbox_setup_unavailable({}, { locale });
	}
}
</script>

<section class="border-t border-border-subtle py-4" aria-labelledby="sandbox-setup-title">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 id="sandbox-setup-title" class="text-[13px] text-text-primary">{m.sandbox_setup_title({}, { locale })}</h3>
		{#if !local}<span class="text-[12px] {status === 'failed' ? 'text-error-soft' : 'text-text-secondary'}" aria-live="polite">{statusLabel(status)}{setup?.duration ? ` · ${setup.duration}` : ""}</span>{/if}
	</div>
	<p class="mt-0.5 max-w-prose text-[12px] leading-5 text-text-tertiary">{local ? m.sandbox_setup_local({}, { locale }) : m.sandbox_setup_hint({}, { locale })}</p>
	{#if !local}
		{#if setup?.error}<p class="mt-2 break-words text-[12px] text-error-soft">{setup.error}</p>{/if}
		{#if status === "succeeded" && !setup?.ran}<p class="mt-2 text-[12px] text-text-secondary">{m.sandbox_setup_empty({}, { locale })}</p>{/if}
		{#each setup?.steps ?? [] as step (step.path)}
			<details class="group mt-2 min-w-0 text-[12px]">
				<summary class="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 py-2 sm:min-h-8 [&::-webkit-details-marker]:hidden">
					<span aria-hidden="true" class="shrink-0 text-text-tertiary group-open:rotate-90">›</span>
					<span class="min-w-0 flex-1 break-all font-mono text-text-secondary">{step.path}</span>
					<span class={step.status === "failed" ? "text-error-soft" : "text-text-tertiary"}>{statusLabel(step.status)}{step.duration ? ` · ${step.duration}` : ""}</span>
				</summary>
				{#if step.error}<p class="break-words text-error-soft">{step.error}</p>{/if}
				{#if step.stdout || step.stderr}<pre class="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-bg-input p-3 font-mono text-[11px] text-text-secondary">{step.stdout}{step.stderr}</pre>{/if}
				<div class="flex flex-wrap items-center gap-x-3 text-text-tertiary">
					<span>{m.sandbox_setup_logs({}, { locale })}</span>
					{#each ["stdout.log", "stderr.log"] as file}
						<a class="inline-flex min-h-11 items-center text-brand hover:underline sm:min-h-8" href={buildSpaceFileRoute(spaceId, `${step.logDir}/${file}`)}>{file}</a>
					{/each}
				</div>
			</details>
		{/each}
	{/if}
</section>
