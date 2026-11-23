<script module lang="ts">
import type { ModelOffer } from "@cohub/protocol";

export type AnnouncedModel = {
	title: string;
	offer: ModelOffer | null | undefined;
	select: () => void;
};
</script>

<script lang="ts">
import { X } from "lucide-svelte";
import { minuteClock } from "#lib/clock.svelte.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { liveOffer, offerDeadline } from "#lib/model-pricing.ts";
import { m } from "#lib/paraglide/messages.js";
import OfferBadge from "./OfferBadge.svelte";

const { models }: { models: AnnouncedModel[] } = $props();

const STORAGE_KEY = "cohub:pricing-notice-dismissed:v1";
const locale = $derived(getLocale());

function readDismissed(): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
	} catch {
		return [];
	}
}

let dismissed = $state<string[]>(typeof window === "undefined" ? [] : readDismissed());

/** One announcement at a time: the live announced offer that ends soonest. */
const featured = $derived.by(() => {
	const now = minuteClock.now;
	return models
		.flatMap((model) => {
			const offer = liveOffer(model.offer, now);
			return offer?.announce && offer.ruleKey && !dismissed.includes(offer.ruleKey) ? [{ model, offer }] : [];
		})
		.sort((a, b) => Date.parse(a.offer.endsAt ?? "9999") - Date.parse(b.offer.endsAt ?? "9999"))[0] ?? null;
});

function dismiss(ruleKey: string) {
	// Keep the list bounded; rule keys of ended campaigns stop mattering.
	dismissed = [...dismissed.filter((key) => key !== ruleKey), ruleKey].slice(-20);
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissed));
	} catch {}
}
</script>

{#if featured}
	{@const { model, offer } = featured}
	{@const deadline = offerDeadline(offer, locale, minuteClock.now)}
	<div class="chat-gutter-x">
		<div class="mx-auto flex max-w-[var(--chat-content-max-width)] items-center gap-2 pb-1 text-[12px] text-text-tertiary" role="status">
			<OfferBadge {offer} />
			<span class="min-w-0 flex-1 truncate">
				<span class="text-text-secondary">{m.pricing_notice_title({ model: model.title }, { locale })}</span>
				{#if deadline}<span class="tabular-nums"> · {deadline}</span>{/if}
			</span>
			<button
				type="button"
				class="shrink-0 rounded px-1.5 py-0.5 text-brand transition-colors hover:bg-bg-hover"
				onclick={() => {
					model.select();
					if (offer.ruleKey) dismiss(offer.ruleKey);
				}}
			>
				{m.pricing_notice_action({}, { locale })}
			</button>
			<button
				type="button"
				class="shrink-0 rounded p-0.5 text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary"
				aria-label={m.pricing_notice_dismiss({}, { locale })}
				onclick={() => offer.ruleKey && dismiss(offer.ruleKey)}
			>
				<X class="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	</div>
{/if}
