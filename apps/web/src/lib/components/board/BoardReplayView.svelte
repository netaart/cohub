<script lang="ts">
import type { BoardHistoryPage } from "@neta-art/cohub";
import {
	type BoardDocument,
	type BoardReplayPlayer,
	type BoardViewport,
	visibleWorldRect,
} from "@neta-art/cohub/board";
import type { BoardAssetManager } from "@neta-art/cohub/board/stage";
import { onDestroy, onMount, untrack } from "svelte";
import type { BoardCollaboratorProfile } from "$lib/board/board-activity";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import { createBoardAwarenessController } from "$lib/board/board-awareness";
import {
	BOARD_REPLAY_PAGE_SIZE,
	BOARD_REPLAY_STEP_MS,
	type BoardReplayDocumentFetch,
	type BoardReplayFetch,
	type BoardReplaySpeed,
	loadBoardReplay,
	replayNextVersion,
	replayPreviousVersion,
} from "$lib/board/board-replay";
import { createBoardEditor } from "$lib/board/editor.svelte";
import BoardReplayTimeline from "$lib/components/board/BoardReplayTimeline.svelte";
import BoardStage from "$lib/components/board/BoardStage.svelte";
import BoardZoomMenu from "$lib/components/board/BoardZoomMenu.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	boardId,
	path,
	spaceId,
	assets,
	assetSource,
	initialDocument,
	initialCamera,
	profiles,
	isMobile = false,
	fetchHistory,
	fetchDocument,
	liveVersion,
	onClose,
}: {
	boardId: string;
	path: string;
	spaceId: string;
	assets: BoardAssetManager;
	assetSource: BoardAssetSource;
	initialDocument: BoardDocument;
	initialCamera: BoardViewport;
	profiles: Map<string, BoardCollaboratorProfile>;
	isMobile?: boolean;
	fetchHistory: BoardReplayFetch;
	fetchDocument: BoardReplayDocumentFetch;
	liveVersion: number;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

let player = $state<BoardReplayPlayer | null>(null);
let loadError = $state<string | null>(null);
let nextBefore = $state<number | null>(null);
let olderState = $state<"idle" | "loading" | "failed">("idle");
let version = $state(0);
let playing = $state(false);
let speed = $state<BoardReplaySpeed>(4);
let follow = $state(true);
let surfaceSize = $state({ width: 0, height: 0 });
let timer: ReturnType<typeof setTimeout> | null = null;
let revision = $state(0);

const awareness = createBoardAwarenessController({
	send: async () => {},
	onChange: () => {},
});

const replayKey = `${untrack(() => path)}#replay`;

const editor = createBoardEditor({
	document: untrack(() => initialDocument),
	viewport: untrack(() => initialCamera),
	initialTool: "hand",
	key: replayKey,
	readonly: true,
	onCommit: () => {},
});

const entries = $derived.by(() => {
	revision;
	return player?.entries ?? [];
});
const floor = $derived.by(() => {
	revision;
	return player?.floor ?? 0;
});
const head = $derived.by(() => {
	revision;
	return player?.head ?? 0;
});

function show(target: number, animateCamera: boolean) {
	if (!player) return;
	const document = player.documentAt(target);
	const reached = player.version;
	version = reached;
	editor.loadDocument(document, replayKey);
	if (!follow || !animateCamera) return;
	const changed = player.changedItemIds(reached);
	if (changed.length === 0) return;
	if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return;
	const visible = visibleWorldRect(
		editor.camera,
		surfaceSize.width,
		surfaceSize.height,
	);
	const frames = changed
		.map((id) => editor.itemById(id)?.frame)
		.filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
	if (frames.length === 0) return;
	const inside = frames.every(
		(frame) =>
			frame.x >= visible.x &&
			frame.y >= visible.y &&
			frame.x + frame.width <= visible.x + visible.width &&
			frame.y + frame.height <= visible.y + visible.height,
	);
	if (!inside) editor.focusItems(changed, { padding: 96, maxZoom: 1.5 });
}

function stopTimer() {
	if (timer) clearTimeout(timer);
	timer = null;
}

function scheduleTick() {
	stopTimer();
	timer = setTimeout(tick, BOARD_REPLAY_STEP_MS / speed);
}

function tick() {
	timer = null;
	if (!playing || !player) return;
	const next = replayNextVersion(entries, version);
	if (next === version) {
		playing = false;
		return;
	}
	show(next, true);
	scheduleTick();
}

function play() {
	if (!player || playing) return;
	if (version >= head) show(floor, false);
	playing = true;
	scheduleTick();
}

function togglePlay() {
	if (playing) {
		playing = false;
		stopTimer();
		return;
	}
	play();
}

function step(direction: -1 | 1) {
	playing = false;
	stopTimer();
	show(
		direction < 0
			? replayPreviousVersion(entries, floor, version)
			: replayNextVersion(entries, version),
		true,
	);
}

function seek(target: number) {
	playing = false;
	stopTimer();
	show(target, false);
}

function setSpeed(next: BoardReplaySpeed) {
	speed = next;
	if (playing) scheduleTick();
}

async function loadOlder() {
	if (!player || nextBefore === null || olderState === "loading") return;
	olderState = "loading";
	try {
		const page = await fetchHistory({
			before: nextBefore,
			limit: BOARD_REPLAY_PAGE_SIZE,
		});
		player.prepend(page);
		nextBefore = page.nextBefore;
		revision += 1;
		olderState = "idle";
	} catch {
		olderState = "failed";
	}
}

let appending = false;
let disposed = false;
async function appendLatest() {
	if (!player || appending || disposed) return;
	appending = true;
	const seen = liveVersion;
	try {
		const pages: BoardHistoryPage[] = [];
		let before: number | undefined;
		for (;;) {
			const page = await fetchHistory({
				...(before !== undefined ? { before } : {}),
				limit: BOARD_REPLAY_PAGE_SIZE,
			});
			if (disposed) return;
			pages.push(page);
			if (page.nextBefore === null || page.nextBefore <= player.head) break;
			before = page.nextBefore;
		}
		for (const page of pages.reverse()) player.append(page);
		revision += 1;
	} catch {
	} finally {
		appending = false;
	}
	if (liveVersion > seen && liveVersion > player.head) void appendLatest();
}

function handleKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	const target = event.target as HTMLElement | null;
	if (
		target &&
		(target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.isContentEditable)
	)
		return;
	if (event.key === "Escape") {
		event.preventDefault();
		onClose();
	} else if (event.key === " ") {
		if (target?.closest("button, a, select, [role='slider']")) return;
		event.preventDefault();
		togglePlay();
	} else if (event.key === "ArrowLeft" || event.key === ",") {
		event.preventDefault();
		step(-1);
	} else if (event.key === "ArrowRight" || event.key === ".") {
		event.preventDefault();
		step(1);
	} else if (event.key === "Home") {
		event.preventDefault();
		seek(floor);
	} else if (event.key === "End") {
		event.preventDefault();
		seek(head);
	}
}

onMount(() => {
	let cancelled = false;
	loadBoardReplay(fetchHistory, fetchDocument)
		.then((loaded) => {
			if (cancelled) return;
			player = loaded.player;
			nextBefore = loaded.nextBefore;
			revision += 1;
			show(loaded.player.floor, false);
			play();
		})
		.catch((error: unknown) => {
			if (cancelled) return;
			loadError =
				error instanceof Error
					? error.message
					: m.board_replay_failed({}, { locale });
		});
	return () => {
		cancelled = true;
	};
});

$effect(() => {
	if (liveVersion > head) untrack(() => void appendLatest());
});

$effect(() => {
	window.addEventListener("keydown", handleKeydown);
	return () => window.removeEventListener("keydown", handleKeydown);
});

onDestroy(() => {
	disposed = true;
	stopTimer();
	void awareness.destroy();
	editor.destroy();
});
</script>

<div class="board-replay" data-drawer-swipe-ignore>
	<BoardStage
		{editor}
		{assets}
		{spaceId}
		{assetSource}
		{awareness}
		awarenessVersion={0}
		readonly
		onSurfaceChange={(size) => {
			surfaceSize = size;
		}}
	/>
	<BoardZoomMenu {editor} />

	{#if player}
		<BoardReplayTimeline
			{entries}
			{floor}
			{head}
			{version}
			{playing}
			{speed}
			{follow}
			hasOlder={nextBefore !== null}
			{olderState}
			{profiles}
			{isMobile}
			onSeek={seek}
			onTogglePlay={togglePlay}
			onStep={step}
			onSpeed={setSpeed}
			onToggleFollow={() => { follow = !follow; }}
			onLoadOlder={loadOlder}
			{onClose}
		/>
	{:else}
		<div class="replay-notice" role="status" aria-live="polite">
			{#if loadError}
				<span class="text-error-soft">{loadError}</span>
			{:else}
				{m.board_replay_loading({}, { locale })}
			{/if}
			<button type="button" class="replay-notice-close" onclick={onClose}>{m.common_close({}, { locale })}</button>
		</div>
	{/if}
</div>

<style>
	.board-replay {
		position: absolute;
		inset: 0;
		z-index: 40;
		background: var(--bg-primary);
	}

	.replay-notice {
		position: absolute;
		left: 50%;
		bottom: 14px;
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 10px;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
		padding: 8px 12px;
		color: var(--text-secondary);
		font-size: 11px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		backdrop-filter: blur(12px);
		transform: translateX(-50%);
	}

	.replay-notice-close {
		color: var(--text-tertiary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.replay-notice-close:hover { color: var(--text-primary); }
</style>
