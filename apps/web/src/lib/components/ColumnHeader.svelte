<script lang="ts">
import type { Snippet } from "svelte";

const {
	left,
	right,
	bordered = true,
	inset = "column",
	class: className = "",
}: {
	left: Snippet;
	right?: Snippet;
	bordered?: boolean;
	inset?: "column" | "list";
	class?: string;
} = $props();
</script>

<header
	class="column-header {className}"
	class:column-header--bordered={bordered}
	class:column-header--list={inset === "list"}
>
	<div class="column-header__left">
		{@render left()}
	</div>
	{#if right}
		<div class="column-header__right">
			{@render right()}
		</div>
	{/if}
</header>

<style>
	.column-header {
		display: flex;
		height: 2.75rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0 0.75rem;
		background: var(--bg-primary);
	}

	.column-header--list {
		padding: 0 calc(var(--list-content-x) - 10px);
	}

	@media (min-width: 960px) {
		.column-header {
			height: 2.5rem;
			padding: 0 1rem;
		}

		.column-header--list {
			padding: 0 calc(var(--list-content-x) - 8px) 0 var(--list-content-x);
		}
	}

	.column-header--bordered {
		border-bottom: 1px solid var(--border-subtle);
	}

	.column-header__left {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 0.375rem;
		overflow: hidden;
	}

	.column-header__right {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.125rem;
		overflow: visible;
	}
</style>
