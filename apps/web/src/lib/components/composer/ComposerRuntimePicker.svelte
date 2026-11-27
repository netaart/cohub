<script lang="ts">
import {
	type ApprovalMode,
	type HarnessKind,
	harnessLabel,
	isApprovalMode,
	isLocalHarness,
	type LocalHarness,
} from "@cohub/protocol/runtime";
import { Check, Eye, Shield, ShieldCheck, ShieldOff } from "lucide-svelte";
import { tick } from "svelte";
import ModelSelector from "#lib/components/ModelSelector.svelte";
import { localHarnessOptions } from "#lib/features/space/runtime-status-view.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import {
	formatThinkingLevelShort,
	isFastServiceTier,
	type LocalModelSelection,
	toLocalModelCatalog,
} from "#lib/model-catalog.ts";
import { m } from "#lib/paraglide/messages.js";
import ComposerModelTrigger from "./ComposerModelTrigger.svelte";
import ComposerSelect from "./ComposerSelect.svelte";
import HarnessIcon from "./HarnessIcon.svelte";
import {
	approvalMenuOptions,
	type CloudModels,
	type ComposerRuntime,
	type ModelListProps,
} from "./runtime-picker.ts";

let {
	runtime,
	cloud,
	disabled = false,
	open = $bindable(false),
}: {
	runtime: ComposerRuntime;
	cloud: CloudModels;
	disabled?: boolean;
	open?: boolean;
} = $props();

const locale = $derived(getLocale());
const approvalIcons = {
	inherit: Shield,
	auto: ShieldCheck,
	full_access: ShieldOff,
	read_only: Eye,
};
const approvalLabel = (mode: ApprovalMode) =>
	({
		inherit: m.runtime_approval_inherit,
		auto: m.runtime_approval_auto,
		full_access: m.runtime_approval_full_access,
		read_only: m.runtime_approval_read_only,
	})[mode]({}, { locale });
const catalogFor = (harness: LocalHarness) =>
	toLocalModelCatalog(
		runtime.models.filter((model) => model.harness === harness),
	);

const harness = $derived(runtime.harness);
const options = $derived(
	localHarnessOptions(runtime.harnesses, runtime.online),
);
const localModel = $derived(runtime.model);
const localMeta = $derived.by(() => {
	if (!localModel) return [];
	const catalog = isLocalHarness(harness) ? catalogFor(harness) : [];
	return [
		localModel.thinkingLevel
			? formatThinkingLevelShort(localModel.thinkingLevel)
			: null,
		isFastServiceTier(
			catalog.find(
				(item) =>
					item.provider === localModel.provider && item.id === localModel.id,
			),
			localModel.serviceTier,
		)
			? m.model_selector_fast({}, { locale })
			: null,
	].filter((item): item is string => Boolean(item));
});
const approval = $derived(
	isLocalHarness(harness)
		? runtime.approvalFor(harness)
		: { modes: [], mode: null },
);
const shownApproval = $derived(
	approval.mode !== "inherit" ? approval.mode : null,
);
const label = $derived(
	harness === "cohub"
		? cloud.label
		: (localModel?.name ?? harnessLabel(harness)),
);
const meta = $derived(harness === "cohub" ? cloud.meta : localMeta);
const ariaLabel = $derived(
	harness === "cohub"
		? cloud.ariaLabel
		: [
				`${m.runtime_harness({}, { locale })}: ${harnessLabel(harness)}`,
				localModel ? `${m.runtime_model({}, { locale })}: ${label}` : null,
				shownApproval
					? `${m.runtime_approval_mode({}, { locale })}: ${approvalLabel(shownApproval)}`
					: null,
				!runtime.online ? m.runtime_offline({}, { locale }) : null,
			]
				.filter(Boolean)
				.join(", "),
);

let trigger = $state<HTMLButtonElement | null>(null);
let tabList = $state<HTMLDivElement | null>(null);
let preview = $state<HarnessKind>("cohub");
let refreshed = new Set<LocalHarness>();
const availability = $derived(
	options.find((option) => option.harness === preview)?.availability,
);
const previewModel = $derived(
	open && isLocalHarness(preview) ? runtime.modelFor(preview) : null,
);
const list = $derived.by((): ModelListProps => {
	if (preview === "cohub") return cloud.list;
	if (!isLocalHarness(preview)) return { models: [] };
	const ready = availability === "ready";
	return {
		models: ready ? catalogFor(preview) : [],
		showGeneration: false,
		currentModel: previewModel,
		currentThinkingLevel: previewModel?.thinkingLevel ?? null,
		currentServiceTier: previewModel?.serviceTier ?? null,
		emptyText: !runtime.online
			? m.runtime_models_offline({}, { locale })
			: availability === "missing"
				? m.runtime_models_not_installed(
						{ harness: harnessLabel(preview) },
						{ locale },
					)
				: m.runtime_models_empty(
						{ harness: harnessLabel(preview) },
						{ locale },
					),
		emptyAction: ready
			? {
					label: m.runtime_model_inherit({}, { locale }),
					onclick: () => commit(preview),
				}
			: undefined,
	};
});
const previewApproval = $derived(
	isLocalHarness(preview) ? runtime.approvalFor(preview) : null,
);
const showApproval = $derived(
	Boolean(previewApproval?.modes.length || previewApproval?.mode),
);
const selectedApproval = $derived(previewApproval?.mode ?? "inherit");
const SelectedApprovalIcon = $derived(approvalIcons[selectedApproval]);

let shown = false;
$effect(() => {
	if (open === shown) return;
	shown = open;
	if (!open) return;
	refreshed = new Set();
	previewHarness(harness);
	void tick().then(() => {
		const tab = tabList?.querySelector<HTMLElement>("[aria-selected='true']");
		tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
		tab?.focus();
	});
});

function previewHarness(next: HarnessKind) {
	preview = next;
	if (isLocalHarness(next)) {
		if (refreshed.has(next)) return;
		refreshed.add(next);
		runtime.refresh(next);
	} else cloud.onOpen?.();
}

function close() {
	open = false;
	trigger?.focus();
}

function commit(next: HarnessKind, model?: LocalModelSelection) {
	runtime.select(next, model);
	close();
}

/**
 * Picking the current model again keeps its level; the Fast switch reports a
 * tier only when it changes, so other picks keep the current one.
 */
function choose(
	selected: Omit<LocalModelSelection, "serviceTier"> & {
		serviceTier?: string | null;
	},
) {
	if (!isLocalHarness(preview))
		return commit(preview, {
			provider: selected.provider,
			id: selected.id,
			...(selected.thinkingLevel
				? { thinkingLevel: selected.thinkingLevel }
				: {}),
		});
	const same =
		previewModel?.provider === selected.provider &&
		previewModel.id === selected.id;
	const {
		thinkingLevel = same ? previewModel.thinkingLevel : undefined,
		serviceTier = previewModel?.serviceTier,
		...rest
	} = selected;
	commit(preview, {
		...rest,
		...(thinkingLevel ? { thinkingLevel } : {}),
		...(serviceTier ? { serviceTier } : {}),
	});
}

function navigate(event: KeyboardEvent) {
	const delta =
		event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
	if (!delta || !(event.target as HTMLElement).closest("[role='tab']")) return;
	event.preventDefault();
	const tabs: HarnessKind[] = ["cohub", ...options.map((o) => o.harness)];
	const next =
		tabs[(tabs.indexOf(preview) + delta + tabs.length) % tabs.length];
	previewHarness(next);
	(event.currentTarget as HTMLElement)
		.querySelector<HTMLElement>(`[data-harness="${next}"]`)
		?.focus();
}
</script>

<ComposerModelTrigger bind:element={trigger} {label} {meta} keepMetaVisible {ariaLabel} {disabled} expanded={open} onclick={() => { open = true; }}>
	{#snippet leading()}{#if harness !== "cohub"}<HarnessIcon {harness} size={14} />{/if}{/snippet}
	{#snippet trailing()}
		{#if shownApproval}
			{@const Icon = approvalIcons[shownApproval]}
			<Icon class="h-3 w-3 shrink-0" />
			<span class="approval-label">{approvalLabel(shownApproval)}</span>
		{/if}
		{#if isLocalHarness(harness) && !runtime.online}<span class="offline-dot"></span>{/if}
	{/snippet}
</ComposerModelTrigger>

<ModelSelector
	{open}
	onClose={close}
	onSelect={choose}
	title={runtime.local ? m.runtime_harness({}, { locale }) : undefined}
	catalogKey={preview}
	header={runtime.local ? tabs : undefined}
	footer={showApproval ? approvalRow : undefined}
	{...list}
/>

{#snippet tabs()}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="tabs" onkeydown={navigate}>
		<button type="button" class="tab-key tab" data-harness="cohub" role="tab" aria-selected={preview === "cohub"} aria-current={harness === "cohub" ? "true" : undefined} title={m.runtime_cloud_execution({}, { locale })} tabindex={preview === "cohub" ? 0 : -1} onclick={() => previewHarness("cohub")}>
			<HarnessIcon harness="cohub" size={14} />{harnessLabel("cohub")}
			{#if harness === "cohub"}<Check class="h-3 w-3 text-brand" />{/if}
		</button>
		<span class="divider" aria-hidden="true"></span>
		<div bind:this={tabList} class="flex items-center gap-0.5" role="tablist" aria-label={m.runtime_local_execution({}, { locale })}>
			{#each options as option (option.harness)}
				{@const selected = option.harness === preview}
				<button type="button" class="tab-key tab" class:unavailable={option.availability !== "ready"} role="tab" data-harness={option.harness} aria-selected={selected} aria-label={harnessLabel(option.harness)} aria-current={option.harness === harness ? "true" : undefined} title={!runtime.online ? m.runtime_offline({}, { locale }) : option.availability === "missing" ? m.runtime_harness_not_installed({}, { locale }) : harnessLabel(option.harness)} tabindex={selected ? 0 : -1} onclick={() => previewHarness(option.harness)}>
					<HarnessIcon harness={option.harness} size={14} />
					{#if option.availability !== "missing"}{harnessLabel(option.harness)}{/if}
					{#if option.harness === harness}<Check class="h-3 w-3 text-brand" />{/if}
				</button>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet approvalRow()}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="approval" onkeydown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) close(); }}>
		<span class="approval-title"><SelectedApprovalIcon class="h-3.5 w-3.5 shrink-0" />{m.runtime_approval_mode({}, { locale })}</span>
		<ComposerSelect
			value={selectedApproval}
			options={approvalMenuOptions(previewApproval?.modes ?? [], selectedApproval).map(({ mode, disabled }) => ({ value: mode, label: approvalLabel(mode), disabled }))}
			ariaLabel={m.runtime_approval_mode({}, { locale })}
			onchange={(mode) => {
				if (isLocalHarness(preview) && isApprovalMode(mode))
					runtime.setApproval(preview, mode);
			}}
		/>
	</div>
{/snippet}

<style>
.tabs { display: flex; flex-shrink: 0; align-items: center; gap: 2px; overflow-x: auto; padding: 8px 12px; border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent); scrollbar-width: none; --tab-key-selected-bg: var(--bg-hover-strong); }
.tab { position: relative; height: 32px; }
@media (min-width: 640px) { .tab { height: 28px; } }
.tab:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.tab.unavailable { opacity: .55; }
.divider { width: 1px; height: 16px; flex-shrink: 0; margin: 0 6px; background: var(--border-subtle); }
.offline-dot { width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%; background: var(--color-warning); }
.approval { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--border-subtle); }
.approval-title { display: inline-flex; align-items: center; gap: 8px; color: var(--text-tertiary); font-size: 12px; }
.approval-label { flex-shrink: 0; }
@media (max-width: 639px) { .approval-label { display: none; } }
</style>
