<script lang="ts">
import { onMount } from "svelte";
import { signInWithRedirectPath } from "#lib/auth.ts";
import PublicHeader from "#lib/components/PublicHeader.svelte";
import { trackPurchase } from "#lib/features/billing/funnel.ts";
import PurchasePanel from "#lib/features/billing/PurchasePanel.svelte";
import { PurchaseFlow } from "#lib/features/billing/purchase.svelte.ts";
import {
	type PublicLocale,
	resolvePublicLocale,
} from "#lib/i18n/public-locale.ts";
import { m } from "#lib/paraglide/messages.js";
import { canonicalUrl } from "#lib/seo.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { goto } from "$app/navigation";
import { page } from "$app/state";

const locale = $derived<PublicLocale>(resolvePublicLocale(page.url.pathname));
const zh = $derived(locale === "zh-CN");
const canonicalPath = $derived(zh ? "/zh/pricing" : "/pricing");
const pricingTitle = $derived(m.pricing_seo_title({}, { locale }));
const pricingDescription = $derived(m.pricing_seo_description({}, { locale }));
const canonical = $derived(canonicalUrl(page.url.origin, canonicalPath));
const returnPath = $derived(`${page.url.pathname}${page.url.search}`);

const flow = new PurchaseFlow("pricing");
let signedIn = $state(false);

/** The strongest campaign on any plan — drives the headline eyebrow. */
const promo = $derived.by(() => {
	const products = flow.catalog?.products ?? [];
	let best: { percentOff: number } | null = null;
	for (const product of products) {
		const percent =
			product.offer && product.offer.pricing.discountAmountUsd > 0
				? Math.round(
						(product.offer.pricing.discountAmountUsd /
							product.offer.pricing.amountUsd) *
							100,
					)
				: !signedIn
					? (product.promotion?.percentOff ?? 0)
					: 0;
		if (percent > 0 && (!best || percent > best.percentOff))
			best = { percentOff: percent };
	}
	return best;
});

const faq = $derived([
	{
		q: m.pricing_faq_balance_q({}, { locale }),
		a: m.pricing_faq_balance_a({}, { locale }),
	},
	{
		q: m.pricing_faq_first_q({}, { locale }),
		a: m.pricing_faq_first_a({}, { locale }),
	},
	{
		q: m.pricing_faq_cancel_q({}, { locale }),
		a: m.pricing_faq_cancel_a({}, { locale }),
	},
	{
		q: m.pricing_faq_packs_q({}, { locale }),
		a: m.pricing_faq_packs_a({}, { locale }),
	},
	{
		q: m.pricing_faq_selfhost_q({}, { locale }),
		a: m.pricing_faq_selfhost_a({}, { locale }),
	},
]);

async function buy() {
	if (!signedIn) {
		await signInWithRedirectPath(returnPath);
		return;
	}
	await flow.checkout({
		returnTo: new URL("/settings/billing", window.location.origin),
	});
}

async function startFree() {
	if (!signedIn) {
		await signInWithRedirectPath("/");
		return;
	}
	await goto("/");
}

onMount(() => {
	void (async () => {
		// Catalog first so the grid paints from cache; auth only decides copy.
		const catalogReady = flow.load();
		await authStore.ensureLoaded();
		signedIn = authStore.isAuthenticated;
		await catalogReady;
		// A signed-in visitor gets personalised offers on a fresh catalog.
		if (signedIn) await flow.load({ force: true });
		trackPurchase({
			name: "purchase_open",
			source: "pricing",
			focus: flow.focus(),
		});
	})();
});
</script>

<svelte:head>
	<title>{pricingTitle}</title>
	<meta name="description" content={pricingDescription} />
	<link rel="canonical" href={canonical} />
	<link rel="alternate" hreflang="en" href={canonicalUrl(page.url.origin, "/pricing")} />
	<link rel="alternate" hreflang="zh-CN" href={canonicalUrl(page.url.origin, "/zh/pricing")} />
	<link rel="alternate" hreflang="x-default" href={canonicalUrl(page.url.origin, "/pricing")} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Cohub" />
	<meta property="og:title" content={pricingTitle} />
	<meta property="og:description" content={pricingDescription} />
	<meta property="og:url" content={canonical} />
	<meta property="og:locale" content={zh ? "zh_CN" : "en_US"} />
	<meta property="og:locale:alternate" content={zh ? "en_US" : "zh_CN"} />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={pricingTitle} />
	<meta name="twitter:description" content={pricingDescription} />
</svelte:head>

<div class="page">
	<PublicHeader cta="open-app" />

	<main class="main">
		<section class="hero">
			{#if promo}
				<p class="eyebrow">
					<span class="eyebrow-dot" aria-hidden="true"></span>
					{signedIn
						? m.pricing_eyebrow_offer_active({ percent: promo.percentOff }, { locale })
						: m.pricing_eyebrow_offer_teaser({ percent: promo.percentOff }, { locale })}
				</p>
			{/if}
			<h1 class="headline">{m.pricing_headline({}, { locale })}</h1>
			<p class="lede">{m.pricing_lede({}, { locale })}</p>
		</section>

		<section class="plans" id="plans">
			<PurchasePanel
				{flow}
				{locale}
				{signedIn}
				focus={flow.focus()}
				ctaLabel={signedIn ? undefined : m.purchase_cta_sign_in_claim({}, { locale })}
				onbuy={buy}
			/>
		</section>

		{#if flow.view?.freePlan}
			<section class="free">
				<div class="free-text">
					<h2 class="free-title">{m.pricing_free_title({}, { locale })}</h2>
					<p class="free-lede">{m.pricing_free_lede({}, { locale })}</p>
				</div>
				<button type="button" class="free-cta" onclick={startFree}>{m.pricing_get_started({}, { locale })} →</button>
			</section>
		{/if}

		<section class="faq">
			<h2 class="faq-title">{m.pricing_faq_title({}, { locale })}</h2>
			<dl class="faq-list">
				{#each faq as item, index (index)}
					<div class="faq-item">
						<dt>{item.q}</dt>
						<dd>{item.a}</dd>
					</div>
				{/each}
			</dl>
		</section>
	</main>
</div>

<style>
	.page {
		min-height: 100vh;
		background: var(--bg-primary);
		color: var(--text-primary);
	}
	.main {
		width: 100%;
		max-width: 72rem;
		margin: 0 auto;
		padding: clamp(2rem, 5vw, 3.5rem) 1.25rem 5rem;
	}
	@media (min-width: 640px) {
		.main {
			padding-inline: 2rem;
		}
	}

	.hero {
		max-width: 44rem;
		margin-bottom: clamp(2rem, 4vw, 3rem);
	}
	.eyebrow {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 14px;
		padding: 4px 10px 4px 8px;
		border-radius: 999px;
		border: 1px solid var(--brand-border);
		background: var(--brand-muted);
		color: var(--brand-muted-fg);
		font-size: 12px;
		font-weight: 500;
	}
	.eyebrow-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--brand);
	}
	.headline {
		font-size: clamp(32px, 5.5vw, 54px);
		font-weight: 600;
		line-height: 1;
		letter-spacing: -0.045em;
		text-wrap: balance;
	}
	.lede {
		max-width: 34rem;
		margin: 16px 0 0;
		font-size: clamp(14px, 1.4vw, 16px);
		line-height: 1.6;
		color: var(--text-tertiary);
		text-wrap: pretty;
	}

	.plans {
		margin-bottom: clamp(3rem, 6vw, 4.5rem);
	}

	.free {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 14px 24px;
		padding: 18px 0;
		border-block: 1px solid var(--border-subtle);
		margin-bottom: clamp(3rem, 6vw, 4.5rem);
	}
	.free-title {
		font-size: 14px;
		font-weight: 600;
	}
	.free-lede {
		margin: 2px 0 0;
		font-size: 12.5px;
		color: var(--text-tertiary);
	}
	.free-cta {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.free-cta:hover {
		color: var(--text-primary);
	}

	.faq {
		display: grid;
		gap: 20px 48px;
	}
	@media (min-width: 800px) {
		.faq {
			grid-template-columns: 200px minmax(0, 1fr);
		}
	}
	.faq-title {
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.faq-list {
		display: grid;
		gap: 0;
		margin: 0;
	}
	@media (min-width: 640px) {
		.faq-list {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0 40px;
		}
	}
	.faq-item {
		padding: 14px 0;
		border-top: 1px solid var(--divider-muted);
	}
	.faq-item dt {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-primary);
	}
	.faq-item dd {
		margin: 6px 0 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-tertiary);
	}
</style>
