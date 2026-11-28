<script lang="ts">
import { tick } from "svelte";
import { floatNear } from "#lib/actions/portal.ts";
import EntityIcon from "#lib/components/EntityIcon.svelte";
import NotificationList from "#lib/components/notifications/NotificationList.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { inbox } from "#lib/notifications/inbox.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const { variant = "header" }: { variant?: "header" | "rail" } = $props();

const locale = $derived(getLocale());
const unread = $derived(inbox.summary.unread);
const mentioned = $derived(inbox.summary.byCategory.mention > 0);
let open = $state(false);
let button = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLDivElement | null>(null);

async function toggle() {
	open = !open;
	if (!open) return;
	await tick();
	panel?.focus();
}

function close() {
	open = false;
}

$effect(() => {
	if (!open) return;
	const outside = (event: Event) => {
		const target = event.target;
		if (
			target instanceof Node &&
			!panel?.contains(target) &&
			!button?.contains(target)
		)
			close();
	};
	const keydown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		close();
		button?.focus();
	};
	document.addEventListener("pointerdown", outside);
	document.addEventListener("keydown", keydown, true);
	return () => {
		document.removeEventListener("pointerdown", outside);
		document.removeEventListener("keydown", keydown, true);
	};
});
</script>

<button
	bind:this={button}
	type="button"
	class="relative flex shrink-0 items-center justify-center rounded-[6px] transition-colors duration-100 {variant === 'rail' ? 'h-8 w-8' : 'h-7 w-7'} {open ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
	aria-label={m.inbox_open_aria({ count: unread }, { locale })}
	aria-haspopup="dialog"
	aria-expanded={open}
	title={m.inbox_title({}, { locale })}
	onclick={toggle}
>
	<EntityIcon name="inbox" class={variant === "rail" ? "h-4 w-4" : "h-3.5 w-3.5"} />
	{#if mentioned}
		<span class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand ring-2 ring-[var(--sidebar-bg)]"></span>
	{/if}
</button>

{#if open}
	<div
		bind:this={panel}
		role="dialog"
		aria-label={m.inbox_title({}, { locale })}
		tabindex="-1"
		class="flex h-[min(560px,calc(100dvh-24px))] flex-col overflow-hidden rounded-[12px] border border-border-subtle bg-bg-primary shadow-[0_18px_60px_rgba(15,23,42,0.18)] outline-none"
		use:floatNear={{ getAnchor: () => button, placement: variant === "rail" ? "right-start" : "bottom-start", gap: 8, width: 400, zIndex: 130 }}
	>
		<NotificationList variant="panel" onnavigate={close} />
		<a href="/spaces/inbox" class="flex h-9 shrink-0 items-center justify-center border-t border-border-subtle text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={close}>{m.inbox_view_all({}, { locale })}</a>
	</div>
{/if}
