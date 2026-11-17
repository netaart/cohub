<script lang="ts">
import {
	formatToolInputView,
	type ToolInputSection,
} from "#lib/components/tool-call-format.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	name: string;
	input?: Record<string, unknown>;
	idPrefix?: string;
	autoFollow?: boolean;
};

const {
	name,
	input,
	idPrefix = "tool-input",
	autoFollow = false,
}: Props = $props();

const locale = $derived(getLocale());
const view = $derived(formatToolInputView(name, input, locale));
let expandedSections = $state<Record<string, boolean>>({});

function toggleSection(id: string) {
	expandedSections = { ...expandedSections, [id]: !expandedSections[id] };
}

function isExpanded(section: ToolInputSection) {
	return Boolean(expandedSections[section.id]);
}

function shouldCollapse(section: ToolInputSection) {
	return Boolean(section.collapsible) && !isExpanded(section);
}

function sectionBodyId(section: ToolInputSection) {
	return `${idPrefix}-${section.id}-body`;
}

function diffLineClass(sign: "+" | "-") {
	const tone =
		sign === "+"
			? "border-success/35 bg-success-bg/45 text-success"
			: "border-error/35 bg-error-bg/45 text-error";
	return `grid grid-cols-[1rem_minmax(0,1fr)] gap-1 border-l px-1 py-px font-mono text-[12px] leading-snug ${tone} max-sm:text-[12px]`;
}

function diffTextClass(sign: "+" | "-") {
	return `whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${sign === "+" ? "text-success" : "text-error"}`;
}

function isPinnedToBottom(element: HTMLElement) {
	return element.scrollHeight - element.scrollTop - element.clientHeight <= 6;
}

function autoFollowScroll(
	node: HTMLElement,
	params: { enabled: boolean; value: unknown },
) {
	let pinned = true;
	const handleScroll = () => {
		pinned = isPinnedToBottom(node);
	};
	const scrollToBottom = () => {
		if (!params.enabled || !pinned) return;
		node.scrollTop = node.scrollHeight;
	};
	node.addEventListener("scroll", handleScroll, { passive: true });
	requestAnimationFrame(scrollToBottom);
	return {
		update(next: { enabled: boolean; value: unknown }) {
			params = next;
			requestAnimationFrame(scrollToBottom);
		},
		destroy() {
			node.removeEventListener("scroll", handleScroll);
		},
	};
}

function sectionFollowValue(section: ToolInputSection) {
	return section.kind === "diff"
		? section.lines?.map((line) => `${line.sign}${line.text}`).join("\n")
		: section.value;
}
</script>

{#if view}
	<div class="min-w-0 space-y-1.5 pt-px">
		{#if view.primary}
			<div class="relative min-w-0">
				<pre
					use:autoFollowScroll={{
						enabled: autoFollow === true,
						value: view.primary.value,
					}}
					class="max-h-[min(38dvh,14rem)] overflow-auto overscroll-contain pr-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-text-secondary [overflow-wrap:anywhere] [scrollbar-width:thin] max-sm:text-[12px]"
				>{view.primary.value}</pre>
			</div>
		{/if}

		{#if view.fields.length > 0}
			<div class="space-y-0.5">
				{#each view.fields as field (field.label)}
					<div class="grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 text-[12px] leading-snug max-sm:grid-cols-[minmax(3.5rem,max-content)_minmax(0,1fr)] max-sm:gap-x-1.5 max-sm:gap-y-0.5">
						<div class="font-mono text-[10px] uppercase tracking-wide text-text-placeholder select-none pt-[1px]">{field.label}</div>
						<div class={`min-w-0 break-words text-text-secondary [overflow-wrap:anywhere] ${field.mono ? 'font-mono text-[13px] max-sm:text-[12px]' : ''}`}>{field.value}</div>
					</div>
				{/each}
			</div>
		{/if}

		{#if view.sections.length > 0}
			<div class="space-y-2 pt-0.5">
				{#each view.sections as section (section.id)}
					<div class="min-w-0 space-y-1">
						<div class="flex min-h-5 items-start gap-2 text-[11px] leading-none max-sm:gap-1.5">
							<div class="font-mono uppercase tracking-wide text-text-placeholder select-none pt-[1px]">{section.label}</div>
							{#if section.summary}
								<div class="truncate text-text-placeholder">{section.summary}</div>
							{/if}
						</div>

						{#if section.kind === 'diff'}
							<div class="relative min-w-0">
								<div
									use:autoFollowScroll={{
										enabled: autoFollow === true && shouldCollapse(section),
										value: sectionFollowValue(section),
									}}
									id={sectionBodyId(section)}
									class={`${shouldCollapse(section) ? 'max-h-56 overflow-auto overscroll-contain pr-1 [scrollbar-width:thin]' : 'overflow-hidden'}`}
								>
									{#each section.lines ?? [] as line, index (`${index}-${line.sign}`)}
										<div class={diffLineClass(line.sign)}>
											<span class="select-none opacity-85">{line.sign}</span>
											<span class={diffTextClass(line.sign)}>{line.text || ' '}</span>
										</div>
									{/each}
								</div>
							</div>
						{:else}
							<div class="relative min-w-0">
								<pre
									use:autoFollowScroll={{
										enabled: autoFollow === true && shouldCollapse(section),
										value: sectionFollowValue(section),
									}}
									id={sectionBodyId(section)}
									class={`whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-text-secondary [overflow-wrap:anywhere] ${shouldCollapse(section) ? 'max-h-56 overflow-auto overscroll-contain pr-1 [scrollbar-width:thin]' : ''}`}
								>{section.value}</pre>
							</div>
						{/if}

						{#if section.collapsible}
							<button
								type="button"
								class="inline-flex min-h-7 items-center rounded-sm px-0 text-[12px] leading-none text-text-placeholder transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/35 sm:min-h-5 max-sm:min-h-11 max-sm:px-1"
								aria-expanded={isExpanded(section)}
								aria-controls={sectionBodyId(section)}
								onclick={() => toggleSection(section.id)}
							>
								{isExpanded(section)
									? m.common_collapse({}, { locale })
									: m.common_show_full({}, { locale })}
							</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
