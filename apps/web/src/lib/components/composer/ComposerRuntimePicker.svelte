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
import { approvalMenuOptions, type ComposerRuntime } from "./runtime-picker.ts";

const {
	runtime,
	disabled = false,
}: { runtime: ComposerRuntime; disabled?: boolean } = $props();

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
const catalogFor = (harness: HarnessKind) =>
	isLocalHarness(harness)
		? toLocalModelCatalog(
				runtime.models.filter((model) => model.harness === harness),
			)
		: [];

const harness = $derived(runtime.harness);
const model = $derived(runtime.model);
const catalog = $derived(catalogFor(harness));
const meta = $derived(
	model
		? [
				model.thinkingLevel
					? formatThinkingLevelShort(model.thinkingLevel)
					: null,
				isFastServiceTier(
					catalog.find(
						(item) => item.provider === model.provider && item.id === model.id,
					),
					model.serviceTier,
				)
					? m.model_selector_fast({}, { locale })
					: null,
			].filter((item): item is string => Boolean(item))
		: [],
);
const shownApproval = $derived(
	runtime.approvalMode !== "inherit" ? runtime.approvalMode : null,
);
const label = $derived(model?.name ?? model?.id ?? harnessLabel(harness));
const ariaLabel = $derived(
	[
		`${m.runtime_harness({}, { locale })}: ${harnessLabel(harness)}`,
		model ? `${m.runtime_model({}, { locale })}: ${label}` : null,
		shownApproval
			? `${m.runtime_approval_mode({}, { locale })}: ${approvalLabel(shownApproval)}`
			: null,
		isLocalHarness(harness) && !runtime.online
			? m.runtime_offline({}, { locale })
			: null,
	]
		.filter(Boolean)
		.join(", "),
);

let open = $state(false);
let trigger = $state<HTMLButtonElement | null>(null);
let tabList = $state<HTMLDivElement | null>(null);
let preview = $state<LocalHarness>("claude");
let refreshed = new Set<LocalHarness>();
const options = $derived(
	localHarnessOptions(runtime.harnesses, runtime.online),
);
const availability = $derived(
	options.find((option) => option.harness === preview)?.availability,
);
const previewModels = $derived(
	open && availability === "ready" ? catalogFor(preview) : [],
);
const previewModel = $derived(open ? runtime.modelFor(preview) : null);
const emptyText = $derived(
	!runtime.online
		? m.runtime_models_offline({}, { locale })
		: availability === "missing"
			? m.runtime_models_not_installed(
					{ harness: harnessLabel(preview) },
					{ locale },
				)
			: m.runtime_models_empty({ harness: harnessLabel(preview) }, { locale }),
);
const approval = $derived(
	open ? runtime.approvalFor(preview) : { modes: [], mode: null },
);
// A recorded mode stays visible after the Runtime stops offering it, so it can be replaced.
const showApproval = $derived(
	approval.modes.length > 0 || approval.mode !== null,
);
const selectedApproval = $derived(approval.mode ?? "inherit");
const SelectedApprovalIcon = $derived(approvalIcons[selectedApproval]);

async function show() {
	refreshed = new Set();
	showHarness(isLocalHarness(harness) ? harness : options[0].harness);
	open = true;
	await tick();
	const tab = tabList?.querySelector<HTMLElement>("[aria-selected='true']");
	tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
	tab?.focus();
}

function showHarness(next: LocalHarness) {
	preview = next;
	if (refreshed.has(next)) return;
	refreshed.add(next);
	runtime.refresh(next);
}

function close() {
	open = false;
	trigger?.focus();
}

function commit(next: HarnessKind, selected?: LocalModelSelection) {
	runtime.select(next, selected);
	close();
}

function choose(
	selected: Omit<LocalModelSelection, "serviceTier"> & {
		serviceTier?: string | null;
	},
) {
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
	const index = options.findIndex((option) => option.harness === preview);
	const next = options[(index + delta + options.length) % options.length];
	showHarness(next.harness);
	(event.currentTarget as HTMLElement)
		.querySelector<HTMLElement>(`[data-harness="${next.harness}"]`)
		?.focus();
}
</script>

<ComposerModelTrigger bind:element={trigger} {label} {meta} keepMetaVisible {ariaLabel} {disabled} expanded={open} onclick={show}>
	{#snippet leading()}<HarnessIcon {harness} size={14} />{/snippet}
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
	showGeneration={false}
	title={m.runtime_harness({}, { locale })}
	catalogKey={preview}
	models={previewModels}
	currentModel={previewModel}
	currentThinkingLevel={previewModel?.thinkingLevel ?? null}
	currentServiceTier={previewModel?.serviceTier ?? null}
	{empty}
	header={tabs}
	footer={showApproval ? approvalRow : undefined}
/>

{#snippet tabs()}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="tabs" onkeydown={navigate}>
		<button type="button" class="tab-key tab" aria-current={harness === "cohub" ? "true" : undefined} title={m.runtime_cloud_execution({}, { locale })} onclick={() => commit("cohub")}>
			<HarnessIcon harness="cohub" size={14} />{harnessLabel("cohub")}
			{#if harness === "cohub"}<Check class="h-3 w-3 text-brand" />{/if}
		</button>
		<span class="divider" aria-hidden="true"></span>
		<div bind:this={tabList} class="flex items-center gap-0.5" role="tablist" aria-label={m.runtime_local_execution({}, { locale })}>
			{#each options as option (option.harness)}
				{@const selected = option.harness === preview}
				<button type="button" class="tab-key tab" class:unavailable={option.availability !== "ready"} role="tab" data-harness={option.harness} aria-selected={selected} aria-label={harnessLabel(option.harness)} aria-current={option.harness === harness ? "true" : undefined} title={!runtime.online ? m.runtime_offline({}, { locale }) : option.availability === "missing" ? m.runtime_harness_not_installed({}, { locale }) : harnessLabel(option.harness)} tabindex={selected ? 0 : -1} onclick={() => showHarness(option.harness)}>
					<HarnessIcon harness={option.harness} size={14} />
					{#if option.availability !== "missing"}{harnessLabel(option.harness)}{/if}
					{#if option.harness === harness}<Check class="h-3 w-3 text-brand" />{/if}
				</button>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet empty()}
	<div class="empty">
		<p>{emptyText}</p>
		{#if availability === "ready"}<button type="button" class="secondary-key inherit" onclick={() => commit(preview)}>{m.runtime_model_inherit({}, { locale })}</button>{/if}
	</div>
{/snippet}

{#snippet approvalRow()}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="approval" onkeydown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) close(); }}>
		<span class="approval-title"><SelectedApprovalIcon class="h-3.5 w-3.5 shrink-0" />{m.runtime_approval_mode({}, { locale })}</span>
		<ComposerSelect
			value={selectedApproval}
			options={approvalMenuOptions(approval.modes, selectedApproval).map(({ mode, disabled }) => ({ value: mode, label: approvalLabel(mode), disabled }))}
			ariaLabel={m.runtime_approval_mode({}, { locale })}
			onchange={(mode) => { if (isApprovalMode(mode)) runtime.setApproval(preview, mode); }}
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
.empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 32px 16px; color: var(--text-tertiary); font-size: 13px; text-align: center; }
.inherit { min-height: 32px; padding: 0 12px; font-size: 12px; }
.approval { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--border-subtle); }
.approval-title { display: inline-flex; align-items: center; gap: 8px; color: var(--text-tertiary); font-size: 12px; }
.approval-label { flex-shrink: 0; }
@media (max-width: 639px) { .approval-label { display: none; } }
</style>
