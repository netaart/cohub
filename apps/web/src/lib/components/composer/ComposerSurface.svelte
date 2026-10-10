<script lang="ts">
let {
	children,
	onsubmit,
	element = $bindable(null),
}: {
	children: import("svelte").Snippet;
	onsubmit?: (event: SubmitEvent) => void;
	element?: HTMLElement | null;
} = $props();

const surfaceClass =
	"relative rounded-[var(--chat-composer-radius)] border border-[color:var(--chat-composer-border)] bg-[var(--chat-composer-bg)] p-2 shadow-[0_12px_36px_rgba(15,23,42,0.08)] backdrop-blur-md transition-colors focus-within:border-[color:var(--chat-composer-border-focus)] focus-within:bg-[var(--chat-composer-bg-focus)]";
</script>

{#if onsubmit}
	<form
		bind:this={element}
		class={surfaceClass}
		onsubmit={(event) => {
			event.preventDefault();
			onsubmit(event);
		}}
	>
		{@render children()}
	</form>
{:else}
	<div bind:this={element} class={surfaceClass}>
		{@render children()}
	</div>
{/if}
