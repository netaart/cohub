<script lang="ts">
const {
	checked,
	label,
	disabled = false,
	onchange,
}: {
	checked: boolean;
	label: string;
	disabled?: boolean;
	onchange: (checked: boolean) => void;
} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	title={label}
	{disabled}
	class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center disabled:cursor-default disabled:opacity-40"
	onclick={() => onchange(!checked)}
>
	<span class="h-3.5 w-6 rounded-full p-0.5 transition-colors {checked ? 'bg-brand' : 'bg-border-strong'}">
		<span class="block h-2.5 w-2.5 rounded-full bg-brand-contrast-fg shadow-sm transition-transform {checked ? 'translate-x-2.5' : ''}"></span>
	</span>
</button>
