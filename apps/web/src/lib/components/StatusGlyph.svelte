<script lang="ts" module>
export type StatusGlyphShape = "dot" | "ring" | "dots";
export type StatusGlyphTone =
	| "brand"
	| "success"
	| "warning"
	| "error"
	| "muted";
export type StatusGlyphMotion = "active" | "slow" | "none";
</script>

<script lang="ts">
const {
	shape = "dot",
	tone = "muted",
	motion = "none",
	soft = false,
	label,
	class: className = "",
}: {
	shape?: StatusGlyphShape;
	tone?: StatusGlyphTone;
	motion?: StatusGlyphMotion;
	soft?: boolean;
	label?: string;
	class?: string;
} = $props();
</script>

<span
	class="status-glyph {className}"
	data-shape={shape}
	data-tone={tone}
	data-motion={motion}
	data-soft={soft || undefined}
	role={label ? "img" : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : "true"}
	title={label}
><span></span><span></span><span></span></span>

<style>
	.status-glyph {
		--d: var(--status-glyph-size, 0.45em);
		--glyph-color: var(--color-text-placeholder);
		--glyph-ease: cubic-bezier(0.16, 1, 0.3, 1);
		position: relative;
		display: inline-block;
		flex-shrink: 0;
		width: var(--d);
		height: var(--d);
		color: var(--glyph-color);
		transition: color 200ms ease-out;
	}

	.status-glyph[data-tone="brand"] {
		--glyph-color: var(--color-brand);
	}

	.status-glyph[data-tone="success"] {
		--glyph-color: var(--color-status-running);
	}

	.status-glyph[data-tone="warning"] {
		--glyph-color: var(--color-status-starting);
	}

	.status-glyph[data-tone="error"] {
		--glyph-color: var(--color-status-error);
	}

	.status-glyph[data-soft] {
		color: color-mix(in oklab, var(--glyph-color) 70%, transparent);
	}

	.status-glyph[data-shape="dots"] {
		width: calc(var(--d) * 2.62);
	}

	.status-glyph > span {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--d);
		height: var(--d);
		border-radius: 999px;
		background: currentColor;
		transition:
			translate 240ms var(--glyph-ease),
			scale 240ms var(--glyph-ease),
			opacity 160ms ease-out,
			background-color 200ms ease-out,
			box-shadow 200ms ease-out;
	}

	.status-glyph:not([data-shape="dots"]) > span:not(:first-child) {
		scale: 0.4;
		opacity: 0;
	}

	.status-glyph[data-shape="ring"] > span:first-child {
		background-color: transparent;
		box-shadow: inset 0 0 0 max(1px, calc(var(--d) * 0.24)) currentColor;
	}

	.status-glyph[data-shape="dots"] > span {
		scale: 0.62;
	}

	.status-glyph[data-shape="dots"] > span:nth-child(1) {
		translate: calc(var(--d) * -0.19) 0;
	}

	.status-glyph[data-shape="dots"] > span:nth-child(2) {
		translate: calc(var(--d) * 0.81) 0;
	}

	.status-glyph[data-shape="dots"] > span:nth-child(3) {
		translate: calc(var(--d) * 1.81) 0;
	}

	@media (prefers-reduced-motion: no-preference) {
		.status-glyph[data-shape="dot"][data-motion="active"] > span:first-child {
			animation: status-glyph-breathe 1.6s ease-in-out infinite;
		}

		.status-glyph[data-shape="dot"][data-motion="slow"] > span:first-child {
			animation: status-glyph-breathe 3s ease-in-out infinite;
		}

		.status-glyph[data-shape="dots"][data-motion="active"] > span {
			animation: status-glyph-wave 1.2s ease-in-out infinite;
		}

		.status-glyph[data-shape="dots"][data-motion="slow"] > span {
			animation: status-glyph-wave 2.4s ease-in-out infinite;
		}

		.status-glyph[data-shape="dots"] > span:nth-child(2) {
			animation-delay: 150ms;
		}

		.status-glyph[data-shape="dots"] > span:nth-child(3) {
			animation-delay: 300ms;
		}
	}

	@keyframes status-glyph-breathe {
		0%,
		100% {
			opacity: 0.6;
			transform: scale(0.88);
		}
		50% {
			opacity: 1;
			transform: scale(1.08);
		}
	}

	@keyframes status-glyph-wave {
		0%,
		70%,
		100% {
			opacity: 0.4;
			transform: translateY(0);
		}
		35% {
			opacity: 1;
			transform: translateY(calc(var(--d) * -0.45));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.status-glyph,
		.status-glyph > span {
			transition: none;
		}
	}
</style>
