<script lang="ts">
import type { AppRuntimeShellContext, WorkContent } from "@neta-art/cohub";
import type {
	BoardDocument,
	BoardLaunch,
	PublishedBoard,
} from "@neta-art/cohub/board";
import type { BoardStage } from "@neta-art/cohub/board/stage";
import { Info } from "lucide-svelte";
import type { AppNavigationHandler } from "$lib/board/board-app";
import {
	createBoardAppRoom,
	createBoardRoomRelay,
} from "$lib/board/board-app-room.svelte";
import { type BoardPlay, loadBoardPlay } from "$lib/board/board-play.svelte";
import {
	type BoardScope,
	cohubPixiRuntime,
} from "$lib/board/runtime/board-runtime";
import { openBoardPlayStore } from "$lib/cache/repositories/board-play-saves-repo";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { authStore } from "$lib/stores/auth.svelte";

const UNDO_RESET_MS = 6_000;

const {
	content,
	appId,
	playable = true,
	isMobile = false,
	launch = null,
	shareUrl,
	shell,
	onNavigationOpen,
	onReady,
}: {
	content: Extract<WorkContent, { kind: "board" }>;
	appId: string;
	playable?: boolean;
	isMobile?: boolean;
	launch?: BoardLaunch | null;
	shareUrl?: () => string;
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: AppNavigationHandler;
	onReady?: () => void;
} = $props();

const locale = $derived(getLocale());
const runtime = cohubPixiRuntime.load();
runtime.catch(() => onReady?.());

let loaded = $state.raw<{
	url: string;
	board: PublishedBoard;
	play: BoardPlay | null;
} | null>(null);
let failed = $state(false);
let undo = $state.raw<BoardDocument | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | null = null;

const current = $derived(loaded?.url === content.url ? loaded : null);
const scope = $derived<BoardScope | null>(
	current
		? { kind: "app", appId, assetSource: current.board.assetSource }
		: null,
);

$effect(() => {
	const { url, versionId, boardId, boardVersion } = content;
	const store =
		playable && versionId
			? openBoardPlayStore({ appId, versionId, boardId, boardVersion })
			: null;
	let cancelled = false;
	let play: BoardPlay | null = null;
	failed = false;
	loadBoardPlay(url, { playable, store })
		.then((next) => {
			if (cancelled) return;
			play = next.play;
			loaded = { url, ...next };
		})
		.catch(() => {
			if (cancelled) return;
			failed = true;
			onReady?.();
		});
	return () => {
		cancelled = true;
		play?.flush();
	};
});

$effect(() => current?.play?.saveOnHide());

const room = createBoardRoomRelay();

$effect(() => {
	const versionId = content.versionId;
	if (!playable || !versionId || !authStore.isAuthenticated) return;
	const opened = createBoardAppRoom({
		appId,
		versionId,
		profile: () => ({
			name:
				authStore.profile?.displayName?.trim() || m.common_user({}, { locale }),
		}),
	});
	room.use(opened);
	return () => {
		room.use(null);
		opened.destroy();
	};
});

function dismissUndo() {
	if (undoTimer) clearTimeout(undoTimer);
	undoTimer = null;
	undo = null;
}

function reset() {
	const play = current?.play;
	if (!play) return;
	dismissUndo();
	undo = play.reset();
	undoTimer = setTimeout(dismissUndo, UNDO_RESET_MS);
}

function undoReset() {
	if (undo) current?.play?.restore(undo);
	dismissUndo();
}

$effect(() => dismissUndo);

function handleStage(stage: BoardStage | null) {
	void stage?.ready.then(() =>
		requestAnimationFrame(() => requestAnimationFrame(() => onReady?.())),
	);
}
</script>

<div class="work-board-surface">
	{#if failed}
		<div class="board-message error" role="alert">{m.board_failed_load({}, { locale })}</div>
	{:else if !current || !scope}
		<CenteredLoading label={m.common_loading({}, { locale })} size="page" />
	{:else}
		{@const { board, play } = current}
		{#await runtime}
			<CenteredLoading label={m.common_loading({}, { locale })} size="page" />
		{:then module}
			{@const BoardRuntime = module.default}
			{#key content.url}
				{#if board.externalUrls.length}
					<details class="absolute right-3 top-3 z-10 text-text-tertiary">
						<summary class="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded bg-bg-primary" aria-label={m.board_external_media({}, { locale })} title={m.board_external_media({}, { locale })}><Info class="h-4 w-4" /></summary>
						<p class="absolute right-0 mt-1 w-60 rounded border border-border-primary bg-bg-primary p-3 text-xs text-text-secondary shadow-lg">{m.board_external_media({}, { locale })}</p>
					</details>
				{/if}
				<BoardRuntime
					mode={play ? "play" : "view"}
					path={content.path}
					boardId={content.boardId}
					document={play ? play.document : board.document}
					playback={null}
					{scope}
					{launch}
					{shareUrl}
					{shell}
					{onNavigationOpen}
					{isMobile}
					onCommit={play ? (_patch, next) => play.commit(next) : undefined}
					onReset={play?.changed ? reset : undefined}
					presence={playable ? room : undefined}
					onStageReady={handleStage}
				/>
				{#if undo}
					<div class="board-undo" role="status" aria-live="polite">
						<span>{m.board_play_reset_done({}, { locale })}</span>
						<button type="button" onclick={undoReset}>{m.common_undo({}, { locale })}</button>
					</div>
				{/if}
			{/key}
		{:catch}
			<div class="board-message error" role="alert">{m.board_failed_load({}, { locale })}</div>
		{/await}
	{/if}
</div>

<style>
	.work-board-surface {
		position: relative;
		height: 100%;
		min-height: 0;
		background: var(--bg-primary);
	}

	.board-message {
		display: flex;
		height: 100%;
		min-height: 240px;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		font-size: 0.8125rem;
	}

	.board-message.error {
		color: var(--color-error-soft);
	}

	.board-undo {
		position: absolute;
		top: 12px;
		left: 50%;
		z-index: 32;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		transform: translateX(-50%);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--bg-elevated);
		padding: 0 6px 0 12px;
		color: var(--text-secondary);
		font-size: 12px;
		white-space: nowrap;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent);
	}

	.board-undo button {
		border-radius: 999px;
		padding: 2px 8px;
		color: var(--brand-muted-fg);
		font-weight: 600;
	}

	.board-undo button:hover {
		background: var(--bg-hover);
	}
</style>
