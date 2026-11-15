<script lang="ts">
import type {
	Archive,
	ArchiveRestore,
	Link2Off,
	Pencil,
	TextCursorInput,
} from "lucide-svelte";

type SidebarActionIcon =
	| typeof Archive
	| typeof ArchiveRestore
	| typeof Link2Off
	| typeof Pencil
	| typeof TextCursorInput;

const {
	icon: Icon,
	title,
	label = title,
	disabled = false,
	tone = "default",
	href,
	onClick,
}: {
	icon: SidebarActionIcon;
	title: string;
	label?: string;
	disabled?: boolean;
	tone?: "default" | "danger";
} & (
	| { href: string; onClick?: never }
	| { href?: never; onClick: (event: MouseEvent) => void }
) = $props();

const className = $derived(
	`rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong disabled:cursor-not-allowed disabled:opacity-50 ${tone === "danger" ? "hover:text-status-error" : "hover:text-text-primary"}`,
);
</script>

{#if href}
	<a
		class="inline-flex {className}"
		{href}
		target="_blank"
		rel="noopener"
		draggable="false"
		{title}
		aria-label={label}
		onclick={(event) => event.stopPropagation()}
	>
		<Icon class="h-3.5 w-3.5" />
	</a>
{:else}
	<button
		type="button"
		class={className}
		draggable="false"
		{disabled}
		{title}
		aria-label={label}
		onclick={(event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick?.(event);
		}}
	>
		<Icon class="h-3.5 w-3.5" />
	</button>
{/if}
