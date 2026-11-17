<script lang="ts">
import type {
	AppPromotionProviderStatus,
	AppPromotionRecord,
	AppPromotionStatsResponse,
	AppsApi,
} from "@neta-art/cohub";
import {
	BarChart3,
	Check,
	ChevronDown,
	Copy,
	Loader2,
	Plus,
	X,
} from "lucide-svelte";
import { onMount } from "svelte";
import { m } from "../paraglide/messages.js";
import type { Locale } from "./core.ts";

type Props = {
	locale: Locale;
	appId: string;
	publicUrl: string;
	api: Pick<
		AppsApi,
		"listPromotions" | "createPromotion" | "getPromotionStats"
	>;
};

let { locale, appId, publicUrl, api }: Props = $props();

let promotions = $state<AppPromotionRecord[]>([]);
let providers = $state<AppPromotionProviderStatus[]>([]);
let selectedId = $state<string | null>(null);
let stats = $state<AppPromotionStatsResponse | null>(null);
let loading = $state(true);
let statsLoading = $state(false);
let creating = $state(false);
let createOpen = $state(false);
let failed = $state(false);
let copiedId = $state<string | null>(null);
let name = $state("");
let provider = $state("generic");
const emptyUtm = () => ({ source: "", medium: "", campaign: "", content: "" });
let utm = $state(emptyUtm());

const selected = $derived(
	promotions.find((promotion) => promotion.id === selectedId) ?? null,
);
const inputClass =
	"w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-primary focus:border-brand/50 focus:outline-none";
const utmFields = [
	["source", m.app_promo_utm_source, "instagram"],
	["medium", m.app_promo_utm_medium, "paid_social"],
	["campaign", m.app_promo_utm_campaign, "launch_2026"],
	["content", m.app_promo_utm_content, "video_a"],
] as const;
const summaryFields = [
	["landing", m.app_promo_landing],
	["ready", m.app_promo_ready],
	["registrationCompleted", m.app_promo_registered],
	["paywallViewed", m.app_promo_paywall],
	["checkoutStarted", m.app_promo_checkout],
] as const;

function promotionUrl(promotion: AppPromotionRecord) {
	const url = new URL(publicUrl, window.location.origin);
	url.searchParams.set("cohub_campaign", promotion.id);
	for (const [key, value] of Object.entries(promotion.parameters)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

async function loadPromotions() {
	loading = true;
	failed = false;
	try {
		const result = await api.listPromotions(appId);
		promotions = result.promotions;
		providers = result.providers;
		selectedId =
			selectedId && promotions.some((item) => item.id === selectedId)
				? selectedId
				: (promotions[0]?.id ?? null);
	} catch (cause) {
		console.warn("[promotions]", cause);
		failed = true;
	} finally {
		loading = false;
	}
}

async function loadStats(promotionId: string) {
	statsLoading = true;
	try {
		stats = await api.getPromotionStats(appId, promotionId);
	} catch {
		stats = null;
	} finally {
		statsLoading = false;
	}
}

$effect(() => {
	if (selectedId) void loadStats(selectedId);
	else stats = null;
});

async function createPromotion(event: SubmitEvent) {
	event.preventDefault();
	creating = true;
	failed = false;
	try {
		const parameters = Object.fromEntries(
			Object.entries(utm)
				.map(([key, value]) => [`utm_${key}`, value.trim()])
				.filter(([, value]) => value.length > 0),
		);
		const result = await api.createPromotion(appId, {
			name: name.trim(),
			provider,
			parameters,
		});
		promotions = [...promotions, result.promotion];
		selectedId = result.promotion.id;
		name = "";
		utm = emptyUtm();
		createOpen = false;
	} catch (cause) {
		console.warn("[promotions]", cause);
		failed = true;
	} finally {
		creating = false;
	}
}

async function copyPromotion(promotion: AppPromotionRecord) {
	await navigator.clipboard.writeText(promotionUrl(promotion));
	copiedId = promotion.id;
	window.setTimeout(() => {
		if (copiedId === promotion.id) copiedId = null;
	}, 1500);
}

onMount(() => {
	void loadPromotions();
});
</script>

<section class="border-b border-border-subtle/70 pb-5" aria-labelledby="app-promotions-heading">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<BarChart3 class="h-3.5 w-3.5 text-text-tertiary" />
			<h2 id="app-promotions-heading" class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.app_promotions_title({}, { locale })}</h2>
		</div>
		<button
			type="button"
			class="inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
			onclick={() => (createOpen = !createOpen)}
		>
			{#if createOpen}<X class="h-3.5 w-3.5" />{:else}<Plus class="h-3.5 w-3.5" />{/if}
			<span>{createOpen ? m.common_close({}, { locale }) : m.app_promo_new({}, { locale })}</span>
		</button>
	</div>

	{#if createOpen}
		<form class="mb-5 grid gap-3 border-b border-border-subtle/60 pb-5 lg:grid-cols-[minmax(0,1fr)_180px]" onsubmit={createPromotion}>
			<div class="space-y-1.5">
				<label for="promotion-name" class="block text-[10px] font-medium text-text-tertiary">{m.app_promo_name({}, { locale })}</label>
				<input id="promotion-name" required maxlength="120" bind:value={name} placeholder={m.app_promo_placeholder_creative({}, { locale })} class={inputClass} />
			</div>
			<div class="space-y-1.5">
				<label for="promotion-provider" class="block text-[10px] font-medium text-text-tertiary">{m.app_promo_provider({}, { locale })}</label>
				<select id="promotion-provider" bind:value={provider} class={inputClass}>
					{#each providers as item (item.key)}
						<option value={item.key} disabled={!item.configured}>{item.configured ? item.key : m.app_promo_provider_unavailable({ provider: item.key }, { locale })}</option>
					{/each}
				</select>
			</div>
			<details class="group border-y border-border-subtle/60 lg:col-span-2">
				<summary class="flex min-h-9 cursor-pointer list-none items-center gap-2 py-2 text-[11px] text-text-tertiary transition-colors hover:text-text-secondary">
					<span class="font-medium">{m.app_promo_url_params({}, { locale })}</span>
					<span class="text-[10px] text-text-placeholder">{m.app_promo_optional({}, { locale })}</span>
					<ChevronDown class="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" />
				</summary>
				<div class="grid gap-3 pt-1 pb-3 sm:grid-cols-2">
					{#each utmFields as [key, label, placeholder] (key)}
						<div class="space-y-1.5">
							<label for="promotion-{key}" class="block text-[10px] font-medium text-text-tertiary">{label({}, { locale })}</label>
							<input id="promotion-{key}" bind:value={utm[key]} {placeholder} class="{inputClass} font-mono" />
						</div>
					{/each}
				</div>
			</details>
			<div class="flex justify-end lg:col-span-2">
				<button type="submit" disabled={creating || !name.trim()} class="inline-flex min-h-9 items-center gap-1.5 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">
					{#if creating}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if}
					<span>{m.app_promo_create({}, { locale })}</span>
				</button>
			</div>
		</form>
	{/if}

	{#if failed}
		<div class="mb-4 rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft">{m.app_promo_error({}, { locale })}</div>
	{/if}

	{#if loading}
		<div class="flex min-h-16 items-center text-[12px] text-text-placeholder">{m.common_loading({}, { locale })}</div>
	{:else if promotions.length === 0}
		<div class="py-3 text-[12px] text-text-placeholder">{m.app_promo_empty({}, { locale })}</div>
	{:else}
		<div class="grid gap-5 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
			<div class="divide-y divide-border-subtle/60 border-y border-border-subtle/60">
				{#each promotions as promotion (promotion.id)}
					<div class="flex min-w-0 items-center gap-2 py-2.5">
						<button type="button" class="min-w-0 flex-1 text-left" onclick={() => (selectedId = promotion.id)}>
							<div class="truncate text-[12px] font-medium {selectedId === promotion.id ? 'text-text-primary' : 'text-text-secondary'}">{promotion.name}</div>
							<div class="mt-0.5 font-mono text-[10px] text-text-placeholder">{promotion.provider}</div>
						</button>
						<button type="button" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => void copyPromotion(promotion)} title={m.app_promo_copy_link({}, { locale })} aria-label={m.app_promo_copy_link({}, { locale })}>
							{#if copiedId === promotion.id}<Check class="h-3.5 w-3.5 text-success-soft" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				{/each}
			</div>

			<div class="min-w-0">
				{#if statsLoading}
					<div class="flex min-h-20 items-center"><Loader2 class="h-4 w-4 animate-spin text-text-placeholder" /></div>
				{:else if selected && stats}
					<div class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
						{#each summaryFields as [key, label] (key)}
							<div><div class="font-mono text-[18px] font-semibold text-text-primary">{stats.summary[key]}</div><div class="text-[10px] text-text-placeholder">{label({}, { locale })}</div></div>
						{/each}
						<div><div class="font-mono text-[18px] font-semibold text-text-primary">{(stats.summary.readyRate * 100).toFixed(1)}%</div><div class="text-[10px] text-text-placeholder">{m.app_promo_ready_rate({}, { locale })}</div></div>
					</div>
					<div class="mt-4 font-mono text-[10px] leading-5 break-all text-text-placeholder">{promotionUrl(selected)}</div>
				{:else}
					<div class="py-3 text-[12px] text-text-placeholder">{m.app_promo_stats_unavailable({}, { locale })}</div>
				{/if}
			</div>
		</div>
	{/if}
</section>
