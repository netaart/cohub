<script lang="ts">
import Dialog from "$lib/components/Dialog.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import SpaceFundPanel from "./SpaceFundPanel.svelte";

const {
	open,
	spaceId,
	signInPath,
	onClose,
}: {
	open: boolean;
	spaceId: string;
	signInPath?: string;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());
</script>

<Dialog {open} {onClose} title={m.wallet_fund({}, { locale })} maxWidth="440px" maxHeight="88vh">
	<div class="p-4 sm:p-5">
		<SpaceFundPanel {spaceId} {signInPath} />
	</div>
</Dialog>
