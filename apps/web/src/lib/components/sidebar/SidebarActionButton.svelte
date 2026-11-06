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
	onClick,
}: {
	icon: SidebarActionIcon;
	title: string;
	label?: string;
	disabled?: boolean;
	tone?: "default" | "danger";
	onClick: (event: MouseEvent) => void;
} = $props();
</script>

<button
	type="button"
	class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong disabled:cursor-not-allowed disabled:opacity-50 {tone === 'danger' ? 'hover:text-status-error' : 'hover:text-text-primary'}"
	draggable="false"
	{disabled}
	{title}
	aria-label={label}
	onclick={(event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick(event);
	}}
>
	<Icon class="h-3.5 w-3.5" />
</button>
