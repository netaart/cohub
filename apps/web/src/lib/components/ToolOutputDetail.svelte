<script lang="ts">
import { tick } from "svelte";
import {
	describeTextValue,
	isLongTextValue,
} from "#lib/components/tool-call-format.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	value: string;
	failed?: boolean;
	partial?: boolean;
	idPrefix?: string;
};

const {
	value,
	failed = false,
	partial = false,
	idPrefix = "tool-output",
}: Props = $props();

const locale = $derived(getLocale());

let expanded = $state(false);
let outputElement = $state<HTMLPreElement | null>(null);
let tailPinned = $state(true);

const summary = $derived(describeTextValue(value, locale));
const tailMode = $derived(partial);
const collapsible = $derived(!tailMode && isLongTextValue(value));
const collapsed = $derived(collapsible && !expanded);
const bodyId = $derived(`${idPrefix}-${failed ? "err" : "out"}-body`);

function isPinnedToBottom(element: HTMLElement) {
	return element.scrollHeight - element.scrollTop - element.clientHeight <= 6;
}

function handleOutputScroll() {
	if (!outputElement || !tailMode) return;
	tailPinned = isPinnedToBottom(outputElement);
}

$effect(() => {
	if (!tailMode) return;
	const currentValue = value;
	void tick().then(() => {
		if (!outputElement || !tailPinned || currentValue !== value) return;
		outputElement.scrollTop = outputElement.scrollHeight;
	});
});
</script>

<div class="min-w-0 space-y-1 pt-px">
	{#if collapsible || partial}
		<div class="flex min-h-5 items-start gap-2 text-[11px] leading-none text-text-placeholder max-sm:gap-1.5">
			<span class="pt-[1px]">{summary}</span>
		</div>
	{/if}

	<pre
		bind:this={outputElement}
		id={bodyId}
		onscroll={handleOutputScroll}
		class={`whitespace-pre-wrap break-words font-mono text-[13px] leading-snug [overflow-wrap:anywhere] max-sm:text-[12px] ${failed ? 'text-status-error' : 'text-text-secondary'} ${tailMode ? 'max-h-[min(38dvh,14rem)] overflow-auto overscroll-contain pr-1 [scrollbar-width:thin]' : collapsed ? 'max-h-[calc(var(--leading-snug)*12em)] overflow-hidden' : ''}`}
	>{value}</pre>

	{#if collapsible}
		<button
			type="button"
			class="inline-flex min-h-7 items-center rounded-sm px-0 text-[12px] leading-none text-text-placeholder transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/35 sm:min-h-5 max-sm:min-h-11 max-sm:px-1"
			aria-expanded={expanded}
			aria-controls={bodyId}
			onclick={() => (expanded = !expanded)}
		>
			{expanded
				? m.common_collapse({}, { locale })
				: m.common_show_full({}, { locale })}
		</button>
	{/if}
</div>
