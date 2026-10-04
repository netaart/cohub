<script lang="ts" module>
import type { LabelListItem } from "@neta-art/cohub";

let cachedLabels: LabelListItem[] = [];
</script>

<script lang="ts">
import { Loader2, Plus, Tag } from "lucide-svelte";
import { tick } from "svelte";
import AdaptivePopover from "$lib/components/list-page/AdaptivePopover.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { flattenLabelsWithRefs } from "$lib/stores/space-labels";

const {
	open,
	anchor,
	count,
	onApply,
	onClose,
}: {
	open: boolean;
	anchor: HTMLElement | null;
	count: number;
	onApply: (labelRef: string) => Promise<void>;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

let labels = $state<LabelListItem[]>(cachedLabels);
let draft = $state("");
let applying = $state<string | null>(null);
let input = $state<HTMLInputElement | null>(null);

const options = $derived(
	flattenLabelsWithRefs(labels).filter((label) => !label.systemKey),
);
const query = $derived(draft.trim());
const matches = $derived(
	query
		? options.filter((label) =>
				label.ref.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
			)
		: options,
);
const exact = $derived(
	options.some(
		(label) => label.ref.toLocaleLowerCase() === query.toLocaleLowerCase(),
	),
);

$effect(() => {
	if (!open) return;
	draft = "";
	applying = null;
	if (!useCompactShell())
		void tick().then(() => input?.focus({ preventScroll: true }));
	void sdk.user.labels
		.list()
		.then((result) => {
			cachedLabels = result.labels;
			labels = result.labels;
		})
		.catch(() => undefined);
});

async function apply(labelRef: string) {
	const ref = labelRef.trim();
	if (!ref || applying) return;
	applying = ref;
	try {
		await onApply(ref);
	} finally {
		applying = null;
	}
}
</script>

<AdaptivePopover {open} {anchor} {onClose} label={m.spaces_label_title({ count }, { locale })} width={260} placement="bottom-end">
	<div class="px-2 pb-1 pt-1.5 text-[11px] text-text-tertiary">{m.spaces_label_title({ count }, { locale })}</div>
	<form
		class="px-1 pb-1"
		onsubmit={(event) => {
			event.preventDefault();
			void apply(query);
		}}
	>
		<input
			bind:this={input}
			bind:value={draft}
			placeholder={m.spaces_label_placeholder({}, { locale })}
			aria-label={m.spaces_label_placeholder({}, { locale })}
			autocomplete="off"
			class="h-9 w-full rounded-[6px] border border-border-subtle bg-bg-input px-2.5 text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none lg:h-8 lg:text-[12px]"
		/>
	</form>
	<div class="flex flex-col">
		{#if query && !exact}
			<button type="button" class="label-option" disabled={Boolean(applying)} onclick={() => void apply(query)}>
				{#if applying === query}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if}
				<span class="truncate">{m.spaces_label_create({ name: query }, { locale })}</span>
			</button>
		{/if}
		{#each matches as label (label.id)}
			<button type="button" class="label-option" disabled={Boolean(applying)} onclick={() => void apply(label.ref)}>
				{#if applying === label.ref}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Tag class="h-3.5 w-3.5 text-text-placeholder" />{/if}
				<span class="truncate">{label.ref}</span>
			</button>
		{:else}
			{#if !query}
				<div class="px-2 py-3 text-[12px] text-text-tertiary">{m.spaces_label_empty({}, { locale })}</div>
			{/if}
		{/each}
	</div>
</AdaptivePopover>

<style>
	.label-option {
		display: flex;
		min-height: 40px;
		width: 100%;
		align-items: center;
		gap: 8px;
		border-radius: 6px;
		padding: 0 8px;
		text-align: left;
		font-size: 13px;
		color: var(--text-secondary);
		transition: background-color 90ms, color 90ms;
	}

	.label-option:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.label-option:disabled {
		opacity: 0.6;
	}

	@media (min-width: 960px) {
		.label-option {
			min-height: 30px;
			font-size: 12px;
		}
	}
</style>
