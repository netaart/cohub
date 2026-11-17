<script lang="ts">
import Dialog from "#lib/components/Dialog.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	open,
	onClose,
	children,
}: {
	open: boolean;
	onClose: () => void;
	children: import("svelte").Snippet;
} = $props();

const locale = $derived(getLocale());
</script>

<Dialog {open} {onClose} title={m.nav_settings({}, { locale })}>
  <div class="flex flex-col h-full">
    <div class="flex-1 overflow-y-auto">
      {@render children()}
    </div>
  </div>
</Dialog>
