<script lang="ts">
/**
 * Proof strip — trust signals directly under the hero.
 *
 * Deliberately no live counters: this audience verifies claims, and a number
 * with no traceable source is worse than no number. Everything here is either
 * checkable (licence, repo, the public Space) or a rounded claim Cohub already
 * makes publicly in its own README.
 */
import { ArrowUpRight } from "lucide-svelte";
import type { PublicLocale } from "$lib/i18n/public-locale";
import { m } from "$lib/paraglide/messages.js";
import { REPO_URL } from "$lib/project";

type Props = { locale?: PublicLocale };

let { locale = "en" }: Props = $props();

const proofs = $derived([
	{
		value: m.proof_tokens({}, { locale }),
		label: m.proof_tokens_sub({}, { locale }),
		href: null as string | null,
	},
	{
		value: m.proof_built_open({}, { locale }),
		label: m.proof_built_open_sub({}, { locale }),
		href: "https://cohub.live/tzwm/cohub",
	},
	{
		value: m.proof_apache({}, { locale }),
		label: m.proof_apache_sub({}, { locale }),
		href: REPO_URL,
	},
]);
</script>

<div class="strip">
	{#each proofs as proof, index (index)}
		{#if proof.href}
			<a class="item item-link" href={proof.href} target="_blank" rel="noopener noreferrer">
				<span class="value">
					{proof.value}
					<ArrowUpRight class="arrow" />
				</span>
				<span class="label">{proof.label}</span>
			</a>
		{:else}
			<div class="item">
				<span class="value">{proof.value}</span>
				<span class="label">{proof.label}</span>
			</div>
		{/if}
	{/each}
</div>

<style>
	.strip {
		display: grid;
		gap: 1.75rem 2.5rem;
		border-block: 1px solid var(--border-subtle);
		padding-block: 1.75rem;
	}

	@media (min-width: 720px) {
		.strip {
			grid-template-columns: repeat(3, 1fr);
		}
	}

	.item {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.value {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 15px;
		font-weight: 600;
		letter-spacing: 0;
		color: var(--text-primary);
	}

	.label {
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-tertiary);
	}

	.item-link {
		text-decoration: none;
	}

	.item-link:hover .value {
		color: var(--brand);
	}

	.value :global(.arrow) {
		height: 13px;
		width: 13px;
		opacity: 0;
		transition:
			opacity 0.2s,
			transform 0.2s;
	}

	.item-link:hover .value :global(.arrow) {
		opacity: 1;
		transform: translate(1px, -1px);
	}

	.item-link:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 4px;
		border-radius: 4px;
	}
</style>
