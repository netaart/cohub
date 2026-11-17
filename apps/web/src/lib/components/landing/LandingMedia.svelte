<script lang="ts">
/**
 * Landing media slot — the single way marketing sections show product visuals.
 *
 * Assets are hosted outside the repo (see `LANDING_MEDIA_BASE`) so marketing
 * captures can be re-shot without pushing binaries through git. `src` is a
 * basename; the slot resolves it to `<base>/<src>.webp`. Until a name is
 * given, the slot renders a labelled placeholder frame so the page keeps its
 * layout and reviewers can see exactly which asset is still missing.
 *
 * Video is lazy by design: `preload="none"` + a poster, and playback only
 * starts once the element is actually near the viewport. The homepage doubles
 * as the authenticated redirect target, so marketing media must never compete
 * with that path for bandwidth.
 */

import { landingMediaUrl } from "#lib/components/landing/media.ts";
import { browser } from "$app/env";

type Props = {
	/** Asset basename, e.g. "hero" → <base>/hero.webp (and .webm/.mp4 for video) */
	src?: string;
	kind?: "video" | "image";
	alt: string;
	/** Intrinsic aspect ratio, used to reserve space and avoid layout shift. */
	ratio?: string;
	/** Shown in the placeholder frame while the asset is missing. */
	label?: string;
	priority?: boolean;
};

const {
	src,
	kind = "image",
	alt,
	ratio = "16 / 10",
	label,
	priority = false,
}: Props = $props();

let videoEl = $state<HTMLVideoElement | null>(null);

/**
 * Start playback only when visible, and pause when it scrolls away — an
 * offscreen looping video is pure battery cost on mobile.
 */
function autoplayWhenVisible(node: HTMLVideoElement) {
	if (!browser) return;
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	if (typeof IntersectionObserver === "undefined") return;

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					void node.play().catch(() => {
						// Autoplay can be refused (data saver, low power) — the poster
						// stays visible, which is an acceptable degraded state.
					});
				} else {
					node.pause();
				}
			}
		},
		{ rootMargin: "200px 0px" },
	);
	observer.observe(node);
	return { destroy: () => observer.disconnect() };
}
</script>

<div class="media media-framed" style="aspect-ratio: {ratio};">
	{#if src && kind === "video"}
		<!-- svelte-ignore a11y_media_has_caption -- silent product loop, decorative -->
		<video
			bind:this={videoEl}
			use:autoplayWhenVisible
			class="asset"
			muted
			loop
			playsinline
			preload="none"
			poster={landingMediaUrl(src, "webp")}
			aria-label={alt}
		>
			<source src={landingMediaUrl(src, "webm")} type="video/webm" />
			<source src={landingMediaUrl(src, "mp4")} type="video/mp4" />
		</video>
	{:else if src}
		<img
			class="asset"
			src={landingMediaUrl(src, "webp")}
			{alt}
			loading={priority ? "eager" : "lazy"}
			decoding="async"
			fetchpriority={priority ? "high" : "auto"}
		/>
	{:else}
		<div class="placeholder">
			<span class="placeholder-label">{label ?? alt}</span>
			<span class="placeholder-kind">{kind === "video" ? "video" : "image"}</span>
		</div>
	{/if}
</div>

<style>
	.media {
		position: relative;
		width: 100%;
		overflow: hidden;
		border-radius: 8px;
	}

	.media-framed {
		border: 1px solid var(--border-subtle);
		background: var(--bg-surface);
	}

	.asset {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* Missing-asset state: readable, obviously provisional, never mistaken for UI. */
	.placeholder {
		display: flex;
		height: 100%;
		width: 100%;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		background-image: repeating-linear-gradient(
			135deg,
			transparent,
			transparent 9px,
			color-mix(in srgb, var(--text-placeholder) 8%, transparent) 9px,
			color-mix(in srgb, var(--text-placeholder) 8%, transparent) 10px
		);
	}

	.placeholder-label {
		max-width: 80%;
		text-align: center;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-tertiary);
	}

	.placeholder-kind {
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-placeholder);
	}
</style>
