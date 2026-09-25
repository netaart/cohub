<script module lang="ts">
export type OpenWithChoice =
	| { kind: "builtin" }
	| { kind: "app"; appId: string };
</script>

<script lang="ts">
import { fileExtensionOf } from "@cohub/protocol";
import { FileText, Loader2 } from "lucide-svelte";
import AppIcon from "$lib/components/app/AppIcon.svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { appDisplayTitle } from "$lib/app-page-meta";
import type { FileHandlerApp } from "$lib/features/app/file-handlers";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	open,
	path,
	candidates,
	defaultAppId = null,
	canSetDefault = false,
	onPick,
	onClose,
}: {
	open: boolean;
	path: string;
	/** Null while the Space's Apps are still being checked. */
	candidates: FileHandlerApp[] | null;
	defaultAppId?: string | null;
	/** Whether the viewer may change the Space's default for this file type. */
	canSetDefault?: boolean;
	/** `always` makes the choice the Space's default for the extension. */
	onPick: (choice: OpenWithChoice, always: boolean) => void;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());
const name = $derived(path.split("/").pop() ?? path);
const extension = $derived(fileExtensionOf(path));
let always = $state(false);

$effect(() => {
	void path;
	always = false;
});
</script>

<Dialog {open} {onClose} title={m.open_with_title({ name }, { locale })} maxWidth="360px">
	<div class="py-1">
		<button type="button" class="choice" onclick={() => onPick({ kind: "builtin" }, always)}>
			<span class="flex h-5 w-5 items-center justify-center text-text-tertiary"><FileText class="h-4 w-4" /></span>
			<span class="min-w-0 flex-1 truncate">{m.open_with_builtin({}, { locale })}</span>
			{#if !defaultAppId}<span class="badge">{m.open_with_default({}, { locale })}</span>{/if}
		</button>
		{#each candidates ?? [] as app (app.appId)}
			<button type="button" class="choice" onclick={() => onPick({ kind: "app", appId: app.appId }, always)}>
				<AppIcon meta={app.meta} slug={app.slug} size="xs" class="mx-0.5" />
				<span class="min-w-0 flex-1 truncate">{appDisplayTitle(app.meta, app.slug)}</span>
				{#if app.appId === defaultAppId}<span class="badge">{m.open_with_default({}, { locale })}</span>{/if}
			</button>
		{/each}
		{#if !candidates}
			<div class="flex items-center gap-2 px-3 py-2 text-[12px] text-text-tertiary">
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
				{m.open_with_loading({}, { locale })}
			</div>
		{/if}
	</div>
	{#if canSetDefault && extension}
		<label class="flex items-center gap-2 border-t border-border-subtle px-3 py-2 text-[12px] text-text-secondary">
			<input type="checkbox" class="accent-[var(--brand)]" bind:checked={always} />
			{m.open_with_always({ extension }, { locale })}
		</label>
	{/if}
</Dialog>

<style>
	.choice {
		display: flex;
		width: 100%;
		min-height: 2.25rem;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.75rem;
		font-size: 13px;
		color: var(--text-primary);
		text-align: left;
		transition: background-color 100ms;
	}

	.choice:hover,
	.choice:focus-visible {
		background: var(--bg-hover);
		outline: none;
	}

	.badge {
		flex-shrink: 0;
		border-radius: 4px;
		background: var(--bg-elevated);
		padding: 0.0625rem 0.375rem;
		font-size: 10px;
		color: var(--text-tertiary);
	}
</style>
