<script lang="ts">
import type { Settings2 } from "lucide-svelte";

type Props = {
	icon: typeof Settings2;
	label: string;
	itemName?: string;
	tone?: "default" | "danger";
	disabled?: boolean;
	onclick: () => void;
};

const {
	icon: Icon,
	label,
	itemName,
	tone = "default",
	disabled = false,
	onclick,
}: Props = $props();
</script>

<button
	type="button"
	class="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-placeholder opacity-0 transition-[opacity,color,background-color] hover:bg-bg-hover-strong focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0 [@media(hover:none)]:opacity-100 {tone === 'danger' ? 'hover:text-error-soft' : 'hover:text-text-primary'}"
	title={label}
	aria-label={itemName ? `${label} ${itemName}` : label}
	{disabled}
	{onclick}
>
	<Icon class="h-3.5 w-3.5" />
</button>
