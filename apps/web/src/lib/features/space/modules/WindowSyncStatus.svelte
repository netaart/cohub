<script lang="ts">
import { CircleAlert, LoaderCircle } from "lucide-svelte";
import type { WindowSyncStatus } from "./window-sync-status.ts";

const {
	status,
	compact = true,
}: { status: WindowSyncStatus; compact?: boolean } = $props();

const label = $derived(
	status === "saving"
		? "Syncing"
		: status === "error"
			? "Sync failed"
			: status === "conflict"
				? "Sync conflict"
				: status === "dirty"
					? "Pending sync"
					: "Synced",
);
</script>

<span
	class="sync-status"
	class:sync-status--error={status === "error" || status === "conflict"}
	class:sync-status--compact={compact}
	class:sync-status--idle={status === "idle"}
	role={status === "idle" ? undefined : "status"}
	aria-label={status === "idle" ? undefined : label}
	aria-hidden={status === "idle"}
	title={status === "idle" ? undefined : label}
>
	{#if status === "saving"}
		<LoaderCircle class="h-3 w-3 animate-spin" />
	{:else if status === "error" || status === "conflict"}
		<CircleAlert class="h-3 w-3" />
	{:else if status === "dirty"}
		<span class="sync-status-dot"></span>
	{/if}
</span>

<style>
	.sync-status {
		display: inline-flex;
		height: 1rem;
		min-width: 1rem;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		color: var(--text-tertiary);
	}

	.sync-status--compact {
		height: 0.75rem;
		min-width: 0.75rem;
	}

	.sync-status--error {
		color: var(--color-error-soft);
	}

	.sync-status--idle {
		visibility: hidden;
	}

	.sync-status-dot {
		height: 0.375rem;
		width: 0.375rem;
		border-radius: 9999px;
		background: var(--color-warning-soft);
	}
</style>
