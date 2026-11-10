<script lang="ts">
import type { BillingCreditStatus } from "@neta-art/cohub";
import { ChevronRight, Loader2 } from "lucide-svelte";
import { formatDate } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { formatBalance } from "./format";

const { credit, locale }: { credit: BillingCreditStatus; locale: Locale } =
	$props();

type Group = BillingCreditStatus["groups"][number];
type Source = {
	key: string;
	name: string;
	count: number;
	remainingUsd: number;
	originalUsd: number;
	expiresAt: string | null;
	group: Group["key"];
};

let open = $state(false);
let exhausted = $state.raw<Source[] | null>(null);
let exhaustedLoading = $state(false);
let exhaustedFailed = $state(false);

function sources(groups: Group[]): Source[] {
	const byKey = new Map<string, Source>();
	for (const group of groups) {
		for (const grant of group.grants) {
			const name =
				grant.benefitName ??
				grant.grantKind ??
				m.billing_balance_source({}, { locale });
			const key = `${group.key}:${name}`;
			const source = byKey.get(key) ?? {
				key,
				name,
				count: 0,
				remainingUsd: 0,
				originalUsd: 0,
				expiresAt: grant.expiresAt,
				group: group.key,
			};
			source.count += 1;
			source.remainingUsd += grant.remainingAmountUsd;
			source.originalUsd += grant.originalAmountUsd ?? grant.remainingAmountUsd;
			if (
				grant.expiresAt &&
				(!source.expiresAt || grant.expiresAt < source.expiresAt)
			)
				source.expiresAt = grant.expiresAt;
			byKey.set(key, source);
		}
	}
	return [...byKey.values()];
}

const available = $derived(sources(credit.groups));
const total = $derived(
	credit.groups.reduce((sum, group) => sum + group.grants.length, 0),
);

function expiry(source: Source) {
	if (source.group === "expired") return m.billing_expired({}, { locale });
	if (!source.expiresAt) return m.billing_no_expiration({}, { locale });
	const date = formatDate(source.expiresAt, locale);
	return source.count > 1
		? m.billing_expires_from({ date }, { locale })
		: m.billing_expires_on({ date }, { locale });
}

async function showExhausted() {
	if (exhaustedLoading) return;
	exhaustedLoading = true;
	exhaustedFailed = false;
	try {
		const all = await sdk.billing.getCredits({ includeExhausted: true });
		const spendable = new Set(
			credit.groups.flatMap((group) => group.grants.map((grant) => grant.id)),
		);
		exhausted = sources(
			all.groups.map((group) => ({
				...group,
				grants: group.grants.filter((grant) => !spendable.has(grant.id)),
			})),
		);
	} catch {
		exhaustedFailed = true;
	} finally {
		exhaustedLoading = false;
	}
}
</script>

{#snippet row(source: Source, muted: boolean)}
	<li class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 py-2 text-[12px] sm:grid-cols-[minmax(0,1fr)_12rem_9rem]">
		<span class="min-w-0 truncate {muted ? 'text-text-tertiary' : 'text-text-primary'}">
			{source.name}{#if source.count > 1}<span class="ml-1.5 font-mono text-[11px] text-text-tertiary">×{source.count}</span>{/if}
		</span>
		<span class="order-last col-span-2 truncate text-[11px] text-text-tertiary sm:order-none sm:col-span-1">{expiry(source)}</span>
		<span class="text-right font-mono tabular-nums {muted ? 'text-text-placeholder' : 'text-text-secondary'}">
			{formatBalance(source.remainingUsd, locale)}<span class="text-text-placeholder"> / {formatBalance(source.originalUsd, locale)}</span>
		</span>
	</li>
{/snippet}

<section class="border-b border-border-subtle">
	<button type="button" class="flex w-full items-center gap-2 py-3 text-left" aria-expanded={open} onclick={() => (open = !open)}>
		<ChevronRight class="h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform duration-150 {open ? 'rotate-90' : ''}" />
		<span class="text-[13px] font-medium text-text-primary">{m.billing_sources_heading({}, { locale })}</span>
		<span class="font-mono text-[11px] tabular-nums text-text-tertiary">{total}</span>
	</button>
	{#if open}
		<div class="pb-3 pl-5.5">
			{#if available.length === 0}
				<p class="py-2 text-[12px] text-text-tertiary">{m.billing_no_balance_sources({}, { locale })}</p>
			{:else}
				<ul class="divide-y divide-border-subtle">
					{#each available as source (source.key)}{@render row(source, false)}{/each}
				</ul>
			{/if}
			{#if exhausted}
				{#if exhausted.length > 0}
					<h3 class="mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{m.billing_sources_exhausted({}, { locale })}</h3>
					<ul class="divide-y divide-border-subtle">
						{#each exhausted as source (source.key)}{@render row(source, true)}{/each}
					</ul>
				{/if}
			{:else}
				<button type="button" class="mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-tertiary transition-colors hover:text-text-secondary" onclick={showExhausted} disabled={exhaustedLoading}>
					{#if exhaustedLoading}<Loader2 class="h-3 w-3 animate-spin" />{/if}
					{exhaustedFailed ? m.billing_load_failed({}, { locale }) : m.billing_sources_show_exhausted({}, { locale })}
				</button>
			{/if}
		</div>
	{/if}
</section>
