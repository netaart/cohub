<script lang="ts">
import {
	formatViewportContextLabel,
	type ViewportContext,
	viewportContextId,
} from "@cohub/protocol";
import { AppWindow, FileText, LayoutGrid, Radio, X } from "lucide-svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	contexts: ViewportContext[];
	removable?: boolean;
	onRemove?: (id: string) => void;
};

const { contexts, removable = false, onRemove }: Props = $props();
const locale = $derived(getLocale());
let openId = $state<string | null>(null);

function iconFor(kind: ViewportContext["kind"]) {
	if (kind === "file") return FileText;
	if (kind === "board") return LayoutGrid;
	if (kind === "app") return AppWindow;
	return Radio;
}

function titleFor(context: ViewportContext) {
	if (context.kind === "file") {
		const lines = context.visibleLines
			? context.visibleLines.start === context.visibleLines.end
				? `L${context.visibleLines.start}`
				: `L${context.visibleLines.start}-${context.visibleLines.end}`
			: null;
		return lines ? `${context.path} · ${lines}` : context.path;
	}
	if (context.kind === "board") {
		const parts = [context.path];
		if (context.selectedNodes?.length) {
			parts.push(
				`${m.vctx_selected({ n: context.selectedNodes.length }, { locale })}: ${context.selectedNodes
					.map((node) => node.title || node.id)
					.join(", ")}`,
			);
		}
		if (context.visibleRect) {
			parts.push(
				m.vctx_view(
					{
						w: Math.round(context.visibleRect.width),
						h: Math.round(context.visibleRect.height),
					},
					{ locale },
				),
			);
		}
		return parts.join(" · ");
	}
	if (context.kind === "app") return context.content;
	return context.url
		? m.vctx_port_url({ port: context.port, url: context.url }, { locale })
		: m.vctx_port_n({ port: context.port }, { locale });
}

function metaFor(context: ViewportContext) {
	if (context.kind === "app")
		return m.vctx_app({ app: context.appId }, { locale });
	if (context.kind === "file") return m.vctx_file({}, { locale });
	if (context.kind === "board") return m.vctx_board({}, { locale });
	return m.vctx_port({}, { locale });
}
</script>

<svelte:window
	onclick={(event) => {
		if (
			!(event.target instanceof Element) ||
			!event.target.closest("[data-viewport-context]")
		) {
			openId = null;
		}
	}}
	onkeydown={(event) => {
		if (event.key === "Escape") openId = null;
	}}
/>

{#if contexts.length > 0}
	<div class="flex flex-wrap gap-1.5">
		{#each contexts as context (viewportContextId(context))}
			{@const Icon = iconFor(context.kind)}
			{@const id = viewportContextId(context)}
			<div class="group/context relative inline-flex max-w-full" data-viewport-context>
				<div class="inline-flex h-6 max-w-full items-center rounded-md border border-border-subtle/70 bg-bg-content/55 text-[11px] text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-hover/55 focus-within:border-border-strong focus-within:text-text-primary">
					<button
						type="button"
						class="inline-flex h-full min-w-0 max-w-full items-center gap-1.5 rounded-l-md px-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand/60"
						aria-expanded={openId === id}
						onclick={() => (openId = openId === id ? null : id)}
					>
						<Icon class="h-3 w-3 shrink-0 text-text-tertiary" />
						<span class="min-w-0 truncate font-medium">
							{formatViewportContextLabel(context)}
						</span>
					</button>
					{#if removable}
						<button
							type="button"
							class="flex h-full w-6 shrink-0 items-center justify-center rounded-r-md text-text-tertiary opacity-70 outline-none transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand/60 sm:opacity-45 sm:group-hover/context:opacity-100 sm:focus:opacity-100"
							title={m.vctx_remove({}, { locale })}
							aria-label={m.vctx_remove({}, { locale })}
							onclick={() => onRemove?.(id)}
						>
							<X class="h-3 w-3" />
						</button>
					{/if}
				</div>
				<div
					class="pointer-events-none absolute bottom-[calc(100%+0.375rem)] left-0 z-50 w-max max-w-[min(22rem,calc(100vw-1.5rem))] translate-y-1 rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 opacity-0 shadow-lg shadow-bg-primary/10 transition-[opacity,transform] duration-100 group-hover/context:pointer-events-auto group-hover/context:translate-y-0 group-hover/context:opacity-100 group-focus-within/context:pointer-events-auto group-focus-within/context:translate-y-0 group-focus-within/context:opacity-100"
					class:pointer-events-auto={openId === id}
					class:translate-y-0={openId === id}
					class:opacity-100={openId === id}
					role="tooltip"
				>
					<div class="truncate text-[10px] font-medium text-text-tertiary">{metaFor(context)}</div>
					<div class="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-[1.45] text-text-primary">{titleFor(context)}</div>
				</div>
			</div>
		{/each}
	</div>
{/if}
