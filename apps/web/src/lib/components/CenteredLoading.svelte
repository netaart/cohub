<script lang="ts">
import { Loader2 } from "lucide-svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type LoadingSize = "compact" | "panel" | "page";
type LoadingVariant = "plain" | "surface";

const props: {
	label?: string;
	size?: LoadingSize;
	variant?: LoadingVariant;
	class?: string;
} = $props();

const locale = $derived(getLocale());
const label = $derived(props.label ?? m.common_loading({}, { locale }));
const size = $derived(props.size ?? "panel");
const variant = $derived(props.variant ?? "plain");
const className = $derived(props.class ?? "");

const sizeClass = $derived(
	size === "compact"
		? "min-h-24 sm:min-h-36"
		: size === "page"
			? "min-h-[55dvh] sm:min-h-[60dvh]"
			: "min-h-40 sm:min-h-[42vh]",
);
const variantClass = $derived(
	variant === "surface"
		? "rounded-[10px] border border-border-subtle bg-bg-surface px-4 py-3"
		: "",
);
</script>

<div
	class={`flex items-center justify-center gap-2 text-[12px] text-text-tertiary sm:text-[13px] ${sizeClass} ${variantClass} ${className}`}
	role="status"
	aria-live="polite"
>
	<Loader2 class="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
	<span>{label}</span>
</div>
