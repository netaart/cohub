<script lang="ts">
import type { DisplayRecordingMeta } from "@neta-art/cohub";
import Dialog from "$lib/components/Dialog.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import DisplayReplay from "./DisplayReplay.svelte";

const {
	spaceId,
	recording = null,
	turnId = null,
	onClose,
}: {
	spaceId: string;
	recording?: DisplayRecordingMeta | null;
	turnId?: string | null;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());
</script>

<Dialog open {onClose} title={m.display_replay_title({}, { locale })} maxWidth="1040px" maxHeight="90vh" scrollable={false}>
	<DisplayReplay {spaceId} {recording} {turnId} />
</Dialog>
