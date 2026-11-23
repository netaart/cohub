<script lang="ts">
import type { ModelOffer } from "@cohub/protocol";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { multiplierLabel } from "#lib/model-pricing.ts";

const { offer }: { offer: ModelOffer } = $props();
const locale = $derived(getLocale());
</script>

<span class="badge shrink-0 tabular-nums">{multiplierLabel(offer.multiplier, locale)}</span>
