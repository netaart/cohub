<script lang="ts">
import type { ToolSection, ToolTodo, ToolView } from "@cohub/protocol/tools";
import { Circle, CircleCheck, CircleDot } from "lucide-svelte";
import {
	describeSection,
	isLongSection,
} from "#lib/components/tool-call-format.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	view: ToolView;
	idPrefix?: string;
	autoFollow?: boolean;
};

const { view, idPrefix = "tool-input", autoFollow = false }: Props = $props();

const locale = $derived(getLocale());
let expandedSections = $state<Record<string, boolean>>({});

function toggleSection(id: string) {
	expandedSections = { ...expandedSections, [id]: !expandedSections[id] };
}

function isExpanded(section: ToolSection) {
	return Boolean(expandedSections[section.id]);
}

function shouldCollapse(section: ToolSection) {
	return isLongSection(section) && !isExpanded(section);
}

function sectionBodyId(section: ToolSection) {
	return `${idPrefix}-${section.id}-body`;
}

function diffLineClass(sign: "+" | "-" | " ") {
	const tone =
		sign === "+"
			? "border-success/35 bg-success-bg/45 text-success"
			: sign === "-"
				? "border-error/35 bg-error-bg/45 text-error"
				: "border-transparent text-text-tertiary";
	return `grid grid-cols-[1rem_minmax(0,1fr)] gap-1 border-l px-1 py-px font-mono text-[12px] leading-snug ${tone} max-sm:text-[12px]`;
}

function todoTextClass(status: ToolTodo["status"]) {
	return status === "completed"
		? "text-text-tertiary line-through decoration-text-placeholder/60"
		: status === "in_progress"
			? "text-text-primary"
			: "text-text-secondary";
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

function sectionFollowValue(section: ToolSection) {
	if (section.kind === "diff")
		return section.lines.map((line) => `${line.sign}${line.text}`).join("\n");
	return section.kind === "todos" ? section.items.length : section.text;
}
</script>

<div class="min-w-0 space-y-1.5 pt-px">
	{#if view.subtitle}
		<div class="min-w-0 break-words text-[12px] leading-snug text-text-tertiary [overflow-wrap:anywhere]">{view.subtitle}</div>
	{/if}

	{#if view.primary}
		<div class="relative min-w-0">
			<pre
				use:autoFollowScroll={{
					enabled: autoFollow === true,
					value: view.primary.text,
				}}
				class="max-h-[min(38dvh,14rem)] overflow-auto overscroll-contain pr-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-text-secondary [overflow-wrap:anywhere] [scrollbar-width:thin] max-sm:text-[12px]"
			>{view.primary.text}</pre>
		</div>
	{/if}

	{#if view.fields.length > 0}
		<div class="space-y-0.5">
			{#each view.fields as field, index (`${index}:${field.label}`)}
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
				{@const summary = describeSection(section, locale)}
				<div class="min-w-0 space-y-1">
					<div class="flex min-h-5 items-start gap-2 text-[11px] leading-none max-sm:gap-1.5">
						<div class="shrink-0 font-mono uppercase tracking-wide text-text-placeholder select-none pt-[1px]">{section.label}</div>
						{#if section.kind === 'diff' && section.path}
							<div class="min-w-0 truncate font-mono text-text-secondary" title={section.path}>{section.path}</div>
						{/if}
						{#if summary}
							<div class="truncate text-text-placeholder">{summary}</div>
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
								{#each section.lines as line, index (`${index}-${line.sign}`)}
									<div class={diffLineClass(line.sign)}>
										<span class="select-none opacity-85">{line.sign}</span>
										<span class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{line.text || ' '}</span>
									</div>
								{/each}
							</div>
						</div>
					{:else if section.kind === 'todos'}
						<ul class="min-w-0 space-y-0.5">
							{#each section.items as item, index (index)}
								<li class="flex min-w-0 items-start gap-1.5 text-[12px] leading-snug">
									{#if item.status === 'completed'}
										<CircleCheck class="mt-px h-3.5 w-3.5 shrink-0 text-success/80" aria-hidden="true" />
									{:else if item.status === 'in_progress'}
										<CircleDot class="mt-px h-3.5 w-3.5 shrink-0 text-[var(--activity)]" aria-hidden="true" />
									{:else}
										<Circle class="mt-px h-3.5 w-3.5 shrink-0 text-text-placeholder" aria-hidden="true" />
									{/if}
									<span class={`min-w-0 break-words [overflow-wrap:anywhere] ${todoTextClass(item.status)}`}>{item.text}</span>
								</li>
							{/each}
						</ul>
					{:else}
						<div class="relative min-w-0">
							<pre
								use:autoFollowScroll={{
									enabled: autoFollow === true && shouldCollapse(section),
									value: sectionFollowValue(section),
								}}
								id={sectionBodyId(section)}
								class={`whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-text-secondary [overflow-wrap:anywhere] ${shouldCollapse(section) ? 'max-h-56 overflow-auto overscroll-contain pr-1 [scrollbar-width:thin]' : ''}`}
							>{section.text}</pre>
						</div>
					{/if}

					{#if isLongSection(section)}
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
