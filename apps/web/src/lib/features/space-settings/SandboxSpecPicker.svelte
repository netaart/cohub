<script lang="ts">
import type { SandboxSpecId } from "@neta-art/cohub";
import { Check, Lock, Zap } from "lucide-svelte";
import Sheet from "$lib/components/Sheet.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { SandboxSpecOption as SandboxSpec } from "./sandbox-settings.svelte";

const locale = $derived(getLocale());

const props = $props<{
	open: boolean;
	currentSpec: SandboxSpecId;
	appliedSpec?: SandboxSpecId | null;
	allowedSpec: SandboxSpecId;
	specs: Record<string, SandboxSpec>;
	onClose: () => void;
	onSelect: (spec: SandboxSpecId) => void;
	onUpgrade: (spec: SandboxSpecId) => void;
}>();

const orderedSpecs = $derived.by<SandboxSpec[]>(() =>
	(Object.values(props.specs) as SandboxSpec[]).sort(
		(left, right) => left.rank - right.rank,
	),
);
const allowedRank = $derived(props.specs[props.allowedSpec]?.rank ?? 0);

function isLocked(spec: SandboxSpec) {
	return spec.rank > allowedRank;
}

function choose(spec: SandboxSpec) {
	if (isLocked(spec)) {
		props.onUpgrade(spec.id);
		return;
	}
	props.onSelect(spec.id);
}

function specDescription(id: SandboxSpecId, fallback: string): string {
	switch (id) {
		case "standard":
			return m.sandbox_spec_desc_standard({}, { locale });
		case "boost":
			return m.sandbox_spec_desc_boost({}, { locale });
		case "ultra":
			return m.sandbox_spec_desc_ultra({}, { locale });
		default:
			return fallback;
	}
}
</script>

<Sheet open={props.open} onClose={props.onClose} maxWidth="520px">
	<div class="flex max-h-[88vh] flex-col">
		<div class="flex items-center gap-2.5 border-b border-border-subtle px-5 py-4">
			<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-brand-bg text-brand">
				<Zap class="h-4 w-4" />
			</span>
			<div>
				<div class="text-[15px] font-semibold text-text-primary">{m.sandbox_spec_title({}, { locale })}</div>
				<div class="mt-0.5 text-[12px] text-text-tertiary">{m.sandbox_spec_subtitle({}, { locale })}</div>
			</div>
		</div>

		<div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
			{#each orderedSpecs as spec (spec.id)}
				{@const locked = isLocked(spec)}
				{@const selected = props.currentSpec === spec.id}
				<button
					type="button"
					class="w-full rounded-[8px] border p-3.5 text-left transition-colors {selected
						? 'cursor-default border-brand/50 bg-brand-bg'
						: 'border-border-subtle bg-bg-content hover:border-border-primary'}"
					aria-current={selected}
					onclick={() => choose(spec)}
				>
					<div class="flex items-center justify-between gap-3">
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-[14px] font-semibold text-text-primary">{spec.label}</span>
								{#if selected}
									<span class="tag font-medium" data-tone="success">
										<Check class="h-3 w-3" /> {m.sandbox_spec_current({}, { locale })}
									</span>
								{/if}
								{#if props.appliedSpec === spec.id && !selected}
									<span class="rounded-full bg-bg-hover px-2 py-0.5 text-[11px] text-text-secondary">{m.sandbox_spec_running({}, { locale })}</span>
								{/if}
							</div>
							<div class="mt-1 text-[12px] text-text-tertiary">{specDescription(spec.id, spec.description)}</div>
						</div>
						<div class="flex shrink-0 items-center gap-1.5">
							<span class="rounded-[5px] bg-bg-hover px-2 py-1 font-mono text-[12px] font-medium text-text-secondary">{spec.resources.limits.cpu} <span class="text-text-tertiary">vCPU</span></span>
							<span class="rounded-[5px] bg-bg-hover px-2 py-1 font-mono text-[12px] font-medium text-text-secondary">{spec.resources.limits.memory}</span>
						</div>
					</div>

					{#if locked}
						<div class="mt-2.5 flex items-center gap-1.5 border-t border-border-subtle pt-2.5 text-[12px] font-medium text-brand">
							<Lock class="h-3.5 w-3.5" />
							<span>{m.sandbox_spec_unlock({ plan: spec.requiredPlan ?? "" }, { locale })}</span>
						</div>
					{/if}
				</button>
			{/each}
		</div>
	</div>
</Sheet>
