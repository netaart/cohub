<script lang="ts">
import type { HostPermission } from "@cohub/protocol/host-bridge";
import {
	canOpenHostPermissionSettings,
	openHostPermissionSettings,
} from "$lib/host-permissions.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const { kind, message }: { kind: HostPermission; message?: string } = $props();
const locale = $derived(getLocale());
</script>

<p class="notice">
	{#if message}<span>{message}</span>{/if}
	{#if canOpenHostPermissionSettings(kind)}
		<button type="button" onclick={() => void openHostPermissionSettings(kind)}>{m.permission_open_settings({}, { locale })}</button>
	{/if}
</p>

<style>
.notice { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin: 0; }
button { color: var(--brand); white-space: nowrap; }
button:hover { text-decoration: underline; }
button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 2px; }
</style>
