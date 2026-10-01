<script lang="ts">
	import { MousePointer2, Square, Type } from "lucide-svelte";
	import { getLocale } from "$lib/i18n/locale.svelte";
	import { m } from "$lib/paraglide/messages.js";

	const { onAddText, onAddShape }: { onAddText: () => void; onAddShape: () => void } =
		$props();

	const locale = $derived(getLocale());
</script>

<div
	class="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
>
	<div class="flex flex-col items-center gap-3 text-center">
		<div
			class="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-surface text-text-tertiary"
		>
			<MousePointer2 class="h-4 w-4" />
		</div>
		<div class="text-sm font-medium text-text-secondary">
			{m.board_start({}, { locale })}
		</div>
		<div class="pointer-events-auto flex items-center gap-2">
			<button
				type="button"
				class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-default hover:text-text-primary"
				onclick={onAddText}
			>
				<Type class="h-3.5 w-3.5" />
				{m.board_empty_text({}, { locale })}
			</button>
			<button
				type="button"
				class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-default hover:text-text-primary"
				onclick={onAddShape}
			>
				<Square class="h-3.5 w-3.5" />
				{m.board_empty_shape({}, { locale })}
			</button>
		</div>
		<div class="max-w-[280px] text-xs leading-5 text-text-tertiary">
			{m.board_empty_hint({}, { locale })}
		</div>
	</div>
</div>
