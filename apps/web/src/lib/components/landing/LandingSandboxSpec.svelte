<script lang="ts">
/**
 * Sandbox specs — deliberately text-only.
 *
 * A screenshot of a file preview proves "Cohub can render HTML"; it says
 * nothing about scheduling or the agent runtime. By this point the reader has
 * already *seen* the sandbox working in the hero, so what is missing is the
 * spec, not another picture. It also lands as a density change after several
 * image sections, which helps the page decelerate into the CTA.
 *
 * Scoped to what the heading and lede do not already cover — isolation and
 * "a real computer" are stated up there, so repeating them here wastes a slot.
 */
import type { PublicLocale } from "#lib/i18n/public-locale.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = { locale?: PublicLocale };

let { locale = "en" }: Props = $props();

const specs = $derived([
	{
		term: m.sb_ports_title({}, { locale }),
		desc: m.sb_ports_desc({}, { locale }),
	},
	{
		term: m.sb_scheduled_title({}, { locale }),
		desc: m.sb_scheduled_desc({}, { locale }),
	},
	{
		term: m.sb_hooks_title({}, { locale }),
		desc: m.sb_hooks_desc({}, { locale }),
	},
	{
		term: m.sb_pi_title({}, { locale }),
		desc: m.sb_pi_desc({}, { locale }),
	},
]);
</script>

<dl class="specs">
	{#each specs as spec, index (index)}
		<div class="spec">
			<dt class="term">{spec.term}</dt>
			<dd class="desc">{spec.desc}</dd>
		</div>
	{/each}
</dl>

<style>
	.specs {
		display: grid;
		gap: 2rem 3rem;
	}

	/* Four entries: 2x2 reads better than a 3-column row with one orphan. */
	@media (min-width: 640px) {
		.specs {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	.spec {
		border-top: 1px solid var(--border-subtle);
		padding-top: 1rem;
	}

	.term {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.desc {
		margin-top: 0.5rem;
		font-size: 13.5px;
		line-height: 1.65;
		color: var(--text-tertiary);
		text-wrap: pretty;
	}
</style>
