<script lang="ts">
import type {
	MessageToolCallsFile,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import { Loader2 } from "lucide-svelte";
import { tick } from "svelte";
import ChatMessageBubble from "$lib/components/ChatMessageBubble.svelte";
import CompactionDivider from "$lib/components/CompactionDivider.svelte";
import GenerationRuntimeStatusRow from "$lib/components/GenerationRuntimeStatusRow.svelte";
import ProcessCard from "$lib/components/ProcessCard.svelte";
import SentTurnsSummary from "$lib/components/SentTurnsSummary.svelte";
import ToolExecutionCard from "$lib/components/ToolExecutionCard.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { getModelDisplayName, type ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import type { ChatMessage, TimelineItem } from "$lib/session-tree";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	sessionId?: string | null;
	timeline: TimelineItem[];
	bindListEl?: HTMLDivElement | null;
	/** Lowest turn that must be mounted, e.g. a jump or scroll-restore target. */
	revealTurnSequence?: number | null;
	/** Every loaded turn is mounted and the reader is near the top. */
	onReachOldest?: () => void;
	/** Whether the initial/tail turn window is loading */
	loading?: boolean;
	/** Whether older turns are currently being loaded (scroll-up pagination) */
	loadingOlder?: boolean;
	modelsCatalog?: ModelCatalogItem[];
	onMarkdownRenderStart?: (message: ChatMessage) => void;
	onMarkdownRendered?: (message: ChatMessage) => void;
	onLoadIntermediate?: (
		turn: SessionTurnRecord,
	) => Promise<StoredIntermediateMessage[]>;
	onRequestIntermediateSync?: (
		turn: SessionTurnRecord,
	) => Promise<boolean | undefined>;
	onLoadToolCalls?: (input: {
		turn: SessionTurnRecord;
		message: StoredIntermediateMessage;
	}) => Promise<MessageToolCallsFile | null>;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	onForkTurn?: (turn: SessionTurnRecord) => void;
	forkingTurnId?: string | null;
};

let {
	sessionId = null,
	timeline,
	bindListEl = $bindable(null),
	revealTurnSequence = null,
	onReachOldest,
	loading = false,
	loadingOlder = false,
	modelsCatalog,
	onMarkdownRenderStart,
	onMarkdownRendered,
	onLoadIntermediate,
	onRequestIntermediateSync,
	onLoadToolCalls,
	onOpenFile,
	onOpenUrl,
	onForkTurn,
	forkingTurnId = null,
}: Props = $props();

const locale = $derived(getLocale());

// Loaded history mounts from the tail in whole turns and grows upward as the
// reader nears the top; mounted turns are never unmounted.
const INITIAL_MOUNTED_TURNS = 2;
const MOUNT_BATCH_TURNS = 3;
const PRELOAD_VIEWPORTS = 3;

let observedNodes = new Set<HTMLElement>();
let farObserver: IntersectionObserver | null = null;
let mountFrom = $state<number | null>(null);
let fillFrame = 0;

type TimelineScrollAnchor = {
	itemKey: string;
	turnSequence: number;
	kind: "user" | "assistant" | "process" | "compact";
};

function shouldFollowSessionTail(item: TimelineItem) {
	if (item.kind === "process" || item.kind === "sent")
		return item.streaming === true;
	return item.kind === "turn_footer";
}

function getTimelineScrollAnchor(
	item: TimelineItem,
): TimelineScrollAnchor | null {
	if (item.kind === "process" || item.kind === "compact") {
		return {
			itemKey: item.id,
			turnSequence: item.turn.sequence,
			kind: item.kind,
		};
	}
	if (item.kind !== "message") return null;
	const turnSequence = item.message.meta?.turn?.sequence;
	if (
		typeof turnSequence !== "number" ||
		!Number.isInteger(turnSequence) ||
		turnSequence <= 0
	) {
		return null;
	}
	if (item.message.role === "user") {
		return { itemKey: item.id, turnSequence, kind: "user" };
	}
	if (item.message.role === "assistant") {
		return { itemKey: item.id, turnSequence, kind: "assistant" };
	}
	return null;
}

function getItemTurnSequence(item: TimelineItem) {
	if (item.kind === "process" || item.kind === "compact")
		return item.turn.sequence;
	if (item.kind === "message") return item.message.meta?.turn?.sequence;
	return undefined;
}

const turnStarts = $derived.by(() => {
	const starts: { sequence: number; index: number }[] = [];
	timeline.forEach((item, index) => {
		const sequence = getItemTurnSequence(item);
		if (typeof sequence === "number" && sequence !== starts.at(-1)?.sequence)
			starts.push({ sequence, index });
	});
	return starts;
});
const mountFloor = $derived(
	Math.min(
		mountFrom ??
			(turnStarts.at(-INITIAL_MOUNTED_TURNS) ?? turnStarts[0])?.sequence ??
			Number.NEGATIVE_INFINITY,
		revealTurnSequence ?? Number.POSITIVE_INFINITY,
	),
);
const mountStart = $derived.by(() => {
	const index = turnStarts.findIndex((start) => start.sequence >= mountFloor);
	return index < 0 ? turnStarts.length - 1 : index;
});
const oldestTurnSequence = $derived(turnStarts[0]?.sequence);
const mountedTimeline = $derived(
	mountStart > 0 ? timeline.slice(turnStarts[mountStart].index) : timeline,
);

$effect(() => {
	if (turnStarts.length > 0 && mountFloor !== mountFrom) mountFrom = mountFloor;
});

function scheduleFill() {
	fillFrame ||= requestAnimationFrame(() => void fillAbove());
}

async function fillAbove() {
	fillFrame = 0;
	const list = bindListEl;
	if (!list || list.scrollTop > list.clientHeight * PRELOAD_VIEWPORTS) return;
	if (mountStart < 0) return;
	if (mountStart === 0) {
		onReachOldest?.();
		return;
	}
	const anchor = list.querySelector<HTMLElement>("[data-kind]");
	const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
	mountFrom = turnStarts[Math.max(0, mountStart - MOUNT_BATCH_TURNS)].sequence;
	await tick();
	// Measured after layout, so this also holds when native scroll anchoring already corrected.
	if (anchor?.isConnected)
		list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
	scheduleFill();
}

$effect(() => {
	void [oldestTurnSequence, mountStart];
	scheduleFill();
});

$effect(() => {
	const list = bindListEl;
	if (!list) return;
	list.addEventListener("scroll", scheduleFill, { passive: true });
	return () => {
		list.removeEventListener("scroll", scheduleFill);
		cancelAnimationFrame(fillFrame);
		fillFrame = 0;
	};
});

function observeItem(node: HTMLElement) {
	observedNodes.add(node);
	farObserver?.observe(node);
	return {
		destroy() {
			observedNodes.delete(node);
			farObserver?.unobserve(node);
		},
	};
}

$effect(() => {
	// Paint-contain offscreen items so streaming cost stays flat as history grows.
	farObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				entry.target.toggleAttribute("data-far", !entry.isIntersecting);
			}
		},
		{ root: bindListEl, rootMargin: "100% 0px" },
	);

	for (const node of observedNodes) farObserver.observe(node);

	return () => {
		farObserver?.disconnect();
		farObserver = null;
	};
});
</script>

<div
	bind:this={bindListEl}
	data-session-id={sessionId ?? undefined}
	class="chat-timeline-scroll relative flex-1 min-h-0 overflow-y-auto bg-bg-content chat-gutter-x"
>
	<div class={`mx-auto max-w-[var(--chat-content-max-width)] flex flex-col [&>*]:mt-2 pt-6 pb-6`}>
		{#if loading && timeline.length === 0}
			<div class="flex min-h-[42vh] items-center justify-center gap-2 text-[12px] text-text-tertiary">
				<Loader2 class="h-4 w-4 animate-spin" aria-label={m.chat_loading_turns({}, { locale })} />
				<span>{m.chat_loading_turns({}, { locale })}</span>
			</div>
		{/if}
		{#each mountedTimeline as item (item.id)}
			{@const scrollAnchor = getTimelineScrollAnchor(item)}
			<div
				data-kind={item.kind}
				data-scroll-anchor-key={scrollAnchor?.itemKey}
				data-scroll-anchor-kind={scrollAnchor?.kind}
				data-scroll-anchor-turn-sequence={scrollAnchor?.turnSequence}
				data-session-follow-tail={shouldFollowSessionTail(item) ? 'true' : undefined}
				data-turn-id={item.kind === 'message' && item.message.meta?.messageKind === 'turn_user'
					? item.message.meta.turnId
					: undefined}
				data-turn-anchor={item.kind === 'message' && item.message.meta?.messageKind === 'turn_user'
					? 'user'
					: undefined}
				data-turn-sequence={scrollAnchor?.turnSequence}
				use:observeItem
			>
				{#if item.kind === 'message'}
					{@const forkTurn = item.message.meta?.turn ?? null}
					<ChatMessageBubble
							message={item.message}
							{modelsCatalog}
							{onMarkdownRenderStart}
							{onMarkdownRendered}
							{onOpenFile}
							{onOpenUrl}
							onForkTurn={onForkTurn && forkTurn ? () => onForkTurn(forkTurn) : undefined}
							forkDisabled={Boolean(forkingTurnId)}
							forking={forkingTurnId === forkTurn?.id}
					/>
				{:else if item.kind === 'process' && item.turn}
						<ProcessCard turn={item.turn} summary={item.summary} intermediateMessages={item.intermediateMessages} live={item.live} streaming={item.streaming} running={item.running} {modelsCatalog} {onLoadIntermediate} {onRequestIntermediateSync} {onLoadToolCalls} {onOpenFile} {onOpenUrl} {onMarkdownRenderStart} {onMarkdownRendered} />
				{:else if item.kind === 'sent'}
					<SentTurnsSummary turnId={item.turnId} />
				{:else if item.kind === 'turn_footer'}
					{@const modelName = getModelDisplayName(modelsCatalog, {
						provider: item.runtimeProvider,
						model: item.runtimeModel,
					})}
					{@const footerLabel =
						item.phase === 'waiting_model'
							? modelName
								? m.chat_waiting_model_name({ model: modelName }, { locale })
								: m.chat_waiting_model({}, { locale })
						: item.phase === 'starting_generation'
							? m.chat_starting_generation({}, { locale })
							: m.chat_starting_agent({}, { locale })}
					<div class="py-1">
						<GenerationRuntimeStatusRow label={footerLabel} compact />
					</div>
				{:else if item.kind === 'tool'}
					<div class="px-[var(--chat-msg-inset)]">
						<ToolExecutionCard tool={item.tool} {onOpenFile} />
					</div>
				{:else if item.kind === 'compact'}
					<CompactionDivider turn={item.turn} />
				{/if}
			</div>
		{/each}
		{#if loadingOlder}
			<div class="flex items-center justify-center py-3">
				<Loader2 class="w-3.5 h-3.5 animate-spin text-text-tertiary" aria-label={m.chat_loading_turns({}, { locale })} />
			</div>
		{/if}
	</div>
</div>

<style>
	.chat-timeline-scroll {
		/* overflow-y alone computes overflow-x to auto; iOS then rubber-bands sideways. */
		overflow-x: hidden;
		overscroll-behavior-x: none;
		scrollbar-width: none;
		-ms-overflow-style: none;
		/*
		 * Mobile WebKit paints native text selection outside overflow:auto bounds,
		 * so long selections can bleed into the header/composer while scrolling.
		 * A solid mask keeps the selection highlight clipped to this scroller.
		 */
		-webkit-mask-image: linear-gradient(#000 0 0);
		mask-image: linear-gradient(#000 0 0);
	}

	.chat-timeline-scroll::-webkit-scrollbar {
		display: none;
	}

	.chat-timeline-scroll :global([data-far]) {
		contain: paint;
	}

	/* Uniform spacing between items via gap on the parent flex container.
	 * The previous column-reverse + :has() approach was fragile and hard to
	 * reason about — a single gap value is cleaner and predictable.
	 */
</style>
