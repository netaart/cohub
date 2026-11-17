import type { PurchaseSource } from "./purchase.svelte.ts";

/**
 * Purchase funnel events. There is no analytics backend yet, so this is the
 * single seam to wire one into: every surface reports through here and
 * nothing else needs to change when a sink appears.
 */
export type PurchaseFunnelEvent =
	| { name: "purchase_open"; source: PurchaseSource; focus: "plans" | "packs" }
	| {
			name: "purchase_select";
			source: PurchaseSource;
			productKey: string;
			hasOffer: boolean;
	  }
	| {
			name: "purchase_checkout_start";
			source: PurchaseSource;
			productKey: string;
			hasOffer: boolean;
			dueTodayUsd: number;
	  }
	| {
			name: "purchase_checkout_return";
			outcome: "success" | "failed" | "cancel";
			productKey: string | null;
	  };

type Sink = (event: PurchaseFunnelEvent) => void;

let sink: Sink | null = null;

export function setPurchaseFunnelSink(next: Sink | null) {
	sink = next;
}

export function trackPurchase(event: PurchaseFunnelEvent) {
	if (sink) {
		sink(event);
		return;
	}
	if (import.meta.env.DEV) console.debug("[purchase]", event);
}
