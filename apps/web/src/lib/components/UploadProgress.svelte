<script lang="ts">
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	value?: number | null;
	label?: string;
	class?: string;
};

let { value = null, label = "", class: className = "" }: Props = $props();

const locale = $derived(getLocale());
const resolvedLabel = $derived(
	label || m.upload_progress_label({}, { locale }),
);

const normalizedValue = $derived(
	value === null ? null : Math.max(0, Math.min(100, value)),
);
</script>

<div
	class={`upload-progress ${className}`}
	class:indeterminate={normalizedValue === null}
	role="progressbar"
	aria-label={resolvedLabel}
	aria-valuemin="0"
	aria-valuemax="100"
	aria-valuenow={normalizedValue ?? undefined}
>
	<span
		class="upload-progress-indicator"
		style={normalizedValue === null
			? undefined
			: `transform: scaleX(${normalizedValue / 100})`}
	></span>
</div>

<style>
	.upload-progress {
		height: 2px;
		overflow: hidden;
		background: var(--bg-hover-strong);
	}

	.upload-progress-indicator {
		display: block;
		height: 100%;
		width: 100%;
		transform: scaleX(0);
		transform-origin: left center;
		background: var(--brand);
		transition: transform 120ms ease-out;
	}

	.indeterminate .upload-progress-indicator {
		width: 45%;
		animation: upload-progress-indeterminate 1.1s ease-in-out infinite;
	}

	@keyframes upload-progress-indeterminate {
		0% {
			transform: translateX(-110%);
		}
		100% {
			transform: translateX(245%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.upload-progress-indicator {
			transition: none;
		}

		.indeterminate .upload-progress-indicator {
			animation: none;
			transform: scaleX(0.45);
		}
	}
</style>
