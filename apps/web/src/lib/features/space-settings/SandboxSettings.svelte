<script lang="ts">
import {
	type SandboxImageId,
	sandboxSetupInfoSchema,
} from "@cohub/protocol/sandbox";
import type { SandboxSpecId, SpaceSandboxConfig } from "@neta-art/cohub";
import { Loader2, RefreshCw, Zap } from "lucide-svelte";
import StatusGlyph, {
	type StatusGlyphTone,
} from "$lib/components/StatusGlyph.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { formatTimeAgo } from "$lib/resource-kit/time";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import SandboxDiagnostics from "./SandboxDiagnostics.svelte";
import SandboxImage from "./SandboxImage.svelte";
import SandboxSetup from "./SandboxSetup.svelte";
import SandboxSpecPicker from "./SandboxSpecPicker.svelte";
import SettingsHeading from "./SettingsHeading.svelte";
import SettingsRow, { SETTINGS_SELECT } from "./SettingsRow.svelte";
import type {
	SandboxConfigPatch,
	SandboxSettingsState,
} from "./sandbox-settings.svelte";

type Field = "image" | "spec" | "hibernation";

const IDLE_PRESETS = [5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60];

const {
	settings,
	canManage,
}: { settings: SandboxSettingsState; canManage: boolean } = $props();

const locale = $derived(getLocale());
const sandbox = $derived(settings.sandbox);
const config = $derived(settings.config);
const preferences = $derived(
	config?.preferences?.applicable ? config.preferences : undefined,
);
const setup = $derived(sandboxSetupInfoSchema.safeParse(sandbox?.meta?.setup));
const live = $derived(
	Boolean(sandbox?.status) &&
		sandbox?.status !== "stopped" &&
		sandbox?.status !== "terminated",
);
const pendingRestart = $derived(
	live &&
		Boolean(
			config?.specPendingRestart ||
				(config?.appliedSpec && config.appliedSpec !== config.spec) ||
				preferences?.pendingRestart,
		),
);
const configErrors = $derived(
	preferences?.sources.filter((source) => source.error) ?? [],
);
const spec = $derived(
	config ? settings.specs[config.spec ?? "standard"] : undefined,
);
const autoDestroy = $derived(config?.autoDestroy);
const idleOptions = $derived(
	[
		...new Set([
			...IDLE_PRESETS,
			...(autoDestroy?.mode === "idle" ? [autoDestroy.ttlSeconds] : []),
		]),
	].sort((a, b) => a - b),
);

let saving = $state<Field | null>(null);
let failure = $state<{ field: Field; message: string } | null>(null);
let restarting = $state(false);
let restartResult = $state<{ ok: boolean; message: string } | null>(null);
let specPickerOpen = $state(false);

$effect(() => {
	if (!restartResult?.ok) return;
	const timer = setTimeout(() => {
		restartResult = null;
	}, 6000);
	return () => clearTimeout(timer);
});

const status = $derived.by(
	(): { label: string; tone: StatusGlyphTone; busy?: boolean } => {
		const options = { locale };
		const lifecycle = sandbox?.status;
		if (!lifecycle)
			return { label: m.sandbox_status_none({}, options), tone: "muted" };
		if (lifecycle === "running" || lifecycle === "ready") {
			switch (sandbox?.runtimeStatus) {
				case "starting":
					return {
						label: m.space_health_starting({}, options),
						tone: "activity",
						busy: true,
					};
				case "degraded":
					return {
						label: m.space_health_degraded({}, options),
						tone: "warning",
					};
				case "unhealthy":
					return {
						label: m.space_health_unhealthy({}, options),
						tone: "error",
					};
				default:
					return {
						label: m.space_health_running({}, options),
						tone: "success",
					};
			}
		}
		switch (lifecycle) {
			case "provisioning":
			case "pending":
				return {
					label: m.space_health_provisioning({}, options),
					tone: "activity",
					busy: true,
				};
			case "stopping":
				return {
					label: m.space_health_stopping({}, options),
					tone: "activity",
					busy: true,
				};
			case "stopped":
				return { label: m.space_health_stopped({}, options), tone: "muted" };
			case "terminated":
				return { label: m.space_health_terminated({}, options), tone: "muted" };
			case "error":
				return { label: m.space_health_error({}, options), tone: "error" };
			default:
				return { label: m.space_health_unknown({}, options), tone: "muted" };
		}
	},
);

const lastActive = $derived.by(() => {
	const at = Date.parse(
		sandbox?.lastActivityAt ?? sandbox?.lastHeartbeatAt ?? "",
	);
	if (Number.isNaN(at)) return null;
	return m.sandbox_last_active(
		{ time: formatTimeAgo(at, Date.now(), locale) },
		{ locale },
	);
});

function idleLabel(seconds: number) {
	const options = { locale };
	if (seconds % 86400 === 0)
		return m.sandbox_idle_days({ n: seconds / 86400 }, options);
	if (seconds % 3600 === 0)
		return m.sandbox_idle_hours({ n: seconds / 3600 }, options);
	if (seconds % 60 === 0)
		return m.sandbox_idle_minutes({ n: seconds / 60 }, options);
	return m.sandbox_idle_seconds({ n: seconds }, options);
}

async function save(
	field: Field,
	patch: SandboxConfigPatch,
	optimistic?: Partial<SpaceSandboxConfig>,
) {
	if (!canManage || saving) return;
	saving = field;
	failure = null;
	try {
		await settings.update(patch, optimistic);
	} catch (error) {
		if (!billingConversion.handleHttpError(error)) {
			const fallback =
				field === "spec"
					? m.space_failed_sandbox_spec({}, { locale })
					: m.space_failed_sandbox_config({}, { locale });
			failure = {
				field,
				message: error instanceof Error ? error.message : fallback,
			};
		}
	} finally {
		saving = null;
	}
}

function selectSpec(next: SandboxSpecId) {
	if (!canManage || saving || !config) return;
	specPickerOpen = false;
	if (next === config.spec && preferences?.overrides.spec === next) return;
	void save("spec", { spec: next }, { spec: next });
}

function selectIdle(value: string) {
	const policy =
		value === "never"
			? ({ mode: "never" } as const)
			: ({ mode: "idle", ttlSeconds: Number(value) } as const);
	void save("hibernation", { autoDestroy: policy }, { autoDestroy: policy });
}

function openUpgrade(specId: SandboxSpecId) {
	const target = settings.specs[specId];
	billingConversion.openFromIntent({
		level: "hard",
		reason: "feature_not_entitled",
		audience: "unknown",
		preferredOfferKind: "upgrade",
		title: m.space_upgrade_title(
			{ spec: target?.label ?? "better" },
			{ locale },
		),
		message: m.space_upgrade_message(
			{
				spec: target?.label ?? specId,
				cpu: target?.resources.limits.cpu ?? "more",
				memory: target?.resources.limits.memory ?? "more",
			},
			{ locale },
		),
		primaryAction: {
			label: m.space_view_plans({}, { locale }),
			action: "open_billing_conversion",
		},
		source: "sandbox_spec_picker",
	});
}

async function restart() {
	if (!canManage || restarting) return;
	if (!window.confirm(m.sandbox_restart_confirm({}, { locale }))) return;
	restarting = true;
	restartResult = null;
	try {
		const result = await settings.restart();
		restartResult = {
			ok: true,
			message: result.verified
				? m.sandbox_restarted({}, { locale })
				: m.sandbox_restart_unverified({}, { locale }),
		};
	} catch (error) {
		restartResult = {
			ok: false,
			message:
				error instanceof Error
					? error.message
					: m.sandbox_restart_failed({}, { locale }),
		};
	} finally {
		restarting = false;
	}
}
</script>

{#snippet fieldError(field: Field)}
	{#if failure?.field === field}<p class="mt-2 break-words text-[12px] text-error-soft">{failure.message}</p>{/if}
{/snippet}

<SettingsHeading title={m.space_section_sandbox({}, { locale })} description={m.space_sandbox_desc({}, { locale })}>
	{#snippet action()}
		<button type="button" class="{pendingRestart ? 'primary-key' : 'secondary-key'} h-8 px-2.5 text-[12px]" disabled={!canManage || restarting} onclick={restart}>
			{#if restarting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
			{m.sandbox_restart({}, { locale })}
		</button>
	{/snippet}
</SettingsHeading>

<div class="space-y-2 py-5" aria-live="polite">
	<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
		<StatusGlyph tone={status.tone} motion={status.busy ? "active" : "none"} />
		<span class="font-medium text-text-primary">{status.label}</span>
		{#if lastActive}<span class="text-text-tertiary">· {lastActive}</span>{/if}
		{#if pendingRestart}<span class="tag font-medium" data-tone="warning">{m.space_restart_to_apply({}, { locale })}</span>{/if}
	</div>
	{#if restartResult}
		<p class="break-words text-[12px] {restartResult.ok ? 'text-success-soft' : 'text-error-soft'}">{restartResult.message}</p>
	{/if}
	{#each configErrors as source (source.source)}
		<p class="break-words text-[12px] text-error-soft">{m.sandbox_config_invalid({ source: source.source }, { locale })}</p>
	{/each}
</div>

{#if config}
	<div class="divide-y divide-border-subtle border-t border-border-subtle">
		{#if config.preferences}
			<SandboxImage
				status={config.preferences}
				disabled={!canManage || saving !== null}
				error={failure?.field === "image" ? failure.message : undefined}
				onChange={(image: SandboxImageId | null) => void save("image", { image })}
			/>
		{/if}

		<SettingsRow label={m.space_compute_spec({}, { locale })}>
			{#snippet meta()}
				<div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
					<span class="text-[12px] font-medium text-text-secondary">{spec?.label ?? config.spec}</span>
					{#if spec}<span class="font-mono text-[11px] text-text-tertiary">{spec.resources.limits.cpu} vCPU · {spec.resources.limits.memory}</span>{/if}
					{#if saving === "spec"}<Loader2 class="h-3 w-3 animate-spin text-text-tertiary" />{/if}
				</div>
				{#if preferences?.overrides.spec}
					<button type="button" class="mt-1 text-left text-[12px] text-brand hover:underline disabled:opacity-50" disabled={!canManage || saving !== null} onclick={() => void save("spec", { spec: null })}>{m.sandbox_follow_spec({}, { locale })}</button>
				{/if}
			{/snippet}
			{#snippet control()}
				<button type="button" class="secondary-key h-9 px-3 text-[12px] lg:h-8" disabled={!canManage || saving !== null} onclick={() => (specPickerOpen = true)}><Zap class="h-3.5 w-3.5" /> {m.space_change({}, { locale })}</button>
			{/snippet}
			{#if preferences?.warnings.includes("spec_entitlement_limited")}
				<p class="mt-2 text-[12px] text-text-secondary">{m.sandbox_spec_limited({}, { locale })}</p>
			{/if}
			{@render fieldError("spec")}
		</SettingsRow>

		<SettingsRow label={m.space_hibernation({}, { locale })} hint={m.space_hibernation_desc({}, { locale })} for="sandbox-hibernation">
			{#snippet control()}
				{#if saving === "hibernation"}<Loader2 class="h-3.5 w-3.5 animate-spin text-text-tertiary" />{/if}
				<select
					id="sandbox-hibernation"
					class={SETTINGS_SELECT}
					value={autoDestroy?.mode === "idle" ? String(autoDestroy.ttlSeconds) : "never"}
					disabled={!canManage || saving !== null}
					onchange={(event) => selectIdle(event.currentTarget.value)}
				>
					{#each idleOptions as seconds (seconds)}<option value={String(seconds)}>{idleLabel(seconds)}</option>{/each}
					<option value="never">{m.space_never({}, { locale })}</option>
				</select>
			{/snippet}
			{@render fieldError("hibernation")}
		</SettingsRow>
	</div>
{/if}

<SandboxSetup
	spaceId={settings.spaceId}
	local={sandbox?.provider === "local" || config?.provider === "local"}
	setup={setup.success ? setup.data : null}
/>

<SandboxDiagnostics {sandbox} {preferences} />

<SandboxSpecPicker
	open={specPickerOpen}
	currentSpec={config?.spec ?? "standard"}
	appliedSpec={config?.appliedSpec}
	allowedSpec={config?.allowedSpec ?? "standard"}
	specs={settings.specs}
	onClose={() => (specPickerOpen = false)}
	onSelect={selectSpec}
	onUpgrade={openUpgrade}
/>
