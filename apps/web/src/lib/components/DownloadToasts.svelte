<script lang="ts">
import type { HostFileLocation } from "@cohub/protocol/host-bridge";
import { Check, CircleAlert, X } from "lucide-svelte";
import Spinner from "$lib/components/Spinner.svelte";
import { type Download, downloads } from "$lib/downloads.svelte";
import { formatBytes } from "$lib/format-bytes";
import { hostPlatform } from "$lib/host-bridge";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const MAX_VISIBLE = 3;

const locale = $derived(getLocale());
const visible = $derived(downloads.visible.slice(-MAX_VISIBLE));

const savedTo: Record<HostFileLocation, () => string> = {
	downloads: () => m.download_saved_downloads({}, { locale }),
	pictures: () => m.download_saved_pictures({}, { locale }),
	movies: () => m.download_saved_movies({}, { locale }),
	music: () => m.download_saved_music({}, { locale }),
	photos: () => m.download_saved_photos({}, { locale }),
	files: () => m.download_saved_files({}, { locale }),
};

function status(item: Download): string {
	switch (item.phase) {
		case "preparing":
			return m.download_preparing({}, { locale });
		case "saving":
			if (item.received === null) return m.download_saving({}, { locale });
			return item.total
				? m.download_progress(
						{
							received: formatBytes(item.received),
							total: formatBytes(item.total),
						},
						{ locale },
					)
				: formatBytes(item.received);
		case "started":
			return m.download_started({}, { locale });
		case "saved":
			return item.location
				? savedTo[item.location]()
				: m.download_started({}, { locale });
		case "failed":
			if (item.failure === "preparing")
				return m.download_still_preparing({}, { locale });
			if (item.failure === "tooLarge")
				return m.download_too_large({}, { locale });
			return m.download_failed({}, { locale });
	}
}

function revealLabel(): string {
	const platform = hostPlatform();
	if (platform === "macos") return m.download_reveal_finder({}, { locale });
	if (platform === "android") return m.download_open({}, { locale });
	return m.download_reveal_folder({}, { locale });
}

function progress(item: Download): number | null {
	if (item.phase !== "saving" || !item.total || item.received === null)
		return null;
	return Math.min(1, item.received / item.total);
}

const running = (item: Download) =>
	item.phase === "preparing" || item.phase === "saving";
</script>

{#if visible.length > 0}
	<div class="download-region" role="status" aria-live="polite">
		{#each visible as item (item.id)}
			{@const fraction = progress(item)}
			<div
				class="download-toast toast-surface"
				data-phase={item.phase}
				role="group"
				aria-label={item.name}
				onpointerenter={() => downloads.hold(item.id, true)}
				onpointerleave={() => downloads.hold(item.id, false)}
			>
				<span class="download-glyph" aria-hidden="true">
					{#if running(item)}
						<Spinner />
					{:else if item.phase === "failed"}
						<CircleAlert class="h-3.5 w-3.5" />
					{:else}
						<Check class="h-3.5 w-3.5" />
					{/if}
				</span>
				<div class="min-w-0 flex-1">
					<div class="download-name" title={item.name}>{item.name}</div>
					<div class="download-status">{status(item)}</div>
				</div>
				{#if item.phase === "failed"}
					<button type="button" class="download-action" onclick={() => downloads.retry(item.id)}>
						{m.common_retry({}, { locale })}
					</button>
				{:else if item.phase === "saved" && item.revealable}
					<button type="button" class="download-action" onclick={() => void downloads.reveal(item.id)}>
						{revealLabel()}
					</button>
				{/if}
				<button
					type="button"
					class="download-close"
					onclick={() => downloads.dismiss(item.id)}
					aria-label={m.common_close({}, { locale })}
					title={m.common_close({}, { locale })}
				>
					<X class="h-3.5 w-3.5" />
				</button>
				{#if running(item)}
					<span
						class="download-progress"
						class:download-progress--indeterminate={fraction === null}
						style:--fraction={fraction ?? 0}
						aria-hidden="true"
					></span>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.download-region {
		position: fixed;
		left: 50%;
		bottom: calc(var(--safe-area-bottom, 0px) + 1rem);
		z-index: var(--z-lightbox);
		display: flex;
		width: min(22rem, calc(100vw - 1.5rem));
		flex-direction: column;
		gap: 0.375rem;
		transform: translateX(-50%);
		pointer-events: none;
	}

	@media (max-width: 1023px) {
		.download-region {
			bottom: calc(var(--safe-area-bottom, 0px) + 4.5rem);
		}
	}

	.download-toast {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		overflow: hidden;
		padding: 0.5rem 0.375rem 0.5rem 0.625rem;
		pointer-events: auto;
	}

	.download-glyph {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		justify-content: center;
		color: var(--text-tertiary);
		font-size: 0.8125rem;
	}

	[data-phase="saved"] .download-glyph,
	[data-phase="started"] .download-glyph {
		color: var(--color-success-soft);
	}

	[data-phase="failed"] .download-glyph {
		color: var(--color-error-soft);
	}

	.download-name {
		overflow: hidden;
		color: var(--text-primary);
		font-size: 12px;
		font-weight: 500;
		line-height: 1.25rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.download-status {
		overflow: hidden;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		line-height: 1rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.download-action {
		flex-shrink: 0;
		border-radius: 5px;
		padding: 0.25rem 0.5rem;
		color: var(--text-primary);
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		transition: background-color 120ms ease;
	}

	.download-close {
		display: inline-flex;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		color: var(--text-tertiary);
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.download-action:hover,
	.download-close:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.download-progress {
		position: absolute;
		inset: auto 0 0;
		height: 2px;
		background: var(--activity);
		transform: scaleX(var(--fraction));
		transform-origin: left;
		transition: transform 120ms linear;
	}

	.download-progress--indeterminate {
		width: 30%;
		transform: none;
		animation: download-sweep 1.2s ease-in-out infinite;
	}

	@keyframes download-sweep {
		from {
			translate: -100% 0;
		}
		to {
			translate: 340% 0;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.download-toast {
			animation: download-enter 140ms ease-out;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.download-progress--indeterminate {
			width: 100%;
			opacity: 0.4;
			animation: none;
		}
	}

	@keyframes download-enter {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
