<script lang="ts">
import { prefersReducedMotion } from "svelte/motion";
import { fade } from "svelte/transition";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { DURATION_MODAL_IN } from "#lib/motion.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	title,
	imageUrl,
	status,
}: {
	title: string;
	imageUrl: string | null;
	status: "loading" | "ready" | "failed";
} = $props();

const locale = $derived(getLocale());
let imageFailed = $state(false);
</script>

{#if status !== "ready"}
	<section
		class="board-poster"
		aria-busy={status === "loading"}
		out:fade={{ duration: prefersReducedMotion.current ? 0 : DURATION_MODAL_IN }}
	>
		{#if imageUrl && !imageFailed}
			<img
				src={imageUrl}
				alt={title}
				fetchpriority="high"
				loading="eager"
				onerror={() => (imageFailed = true)}
			/>
		{/if}
		<h1>{title}</h1>
		{#if status === "failed"}
			<p role="alert">{m.board_failed_load({}, { locale })}</p>
		{/if}
	</section>
{/if}

<style>
	/* Above Board chrome (≤ 32), below the Cohub bar (40). */
	.board-poster {
		position: fixed;
		inset: 0;
		z-index: 35;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: calc(env(safe-area-inset-top, 0px) + 3.5rem) 1.5rem 3rem;
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	img {
		width: 100%;
		max-width: 48rem;
		height: min(56vh, 30rem);
		object-fit: contain;
	}

	h1 {
		max-width: 40rem;
		font-size: 1.125rem;
		font-weight: 600;
		line-height: 1.4;
		text-align: center;
		overflow-wrap: anywhere;
	}

	p {
		font-size: 0.8125rem;
		color: var(--color-error-soft);
	}
</style>
