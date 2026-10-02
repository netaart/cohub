<script lang="ts">
import { boardSnapshotPatch } from "@cohub/protocol";
import type { AppBoardArtifactManifest, WorkContent } from "@neta-art/cohub";
import { parseBoardDocument } from "@neta-art/cohub/board";
import { createAppBoardAssetSource } from "$lib/board/board-asset-source";
import { cohubPixiRuntime } from "$lib/board/runtime/board-runtime";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	content,
	isMobile = false,
}: {
	content: Extract<WorkContent, { kind: "board" }>;
	isMobile?: boolean;
} = $props();

type LoadedBoard = {
	url: string;
	manifest: AppBoardArtifactManifest;
};

let loaded = $state<LoadedBoard | null>(null);
let error = $state<string | null>(null);

const manifest = $derived(loaded?.url === content.url ? loaded.manifest : null);
const locale = $derived(getLocale());
const parsed = $derived.by(() => {
	if (!manifest) return null;
	try {
		return parseBoardDocument(boardSnapshotPatch(manifest.snapshot));
	} catch {
		return { ok: false as const };
	}
});
// Published snapshots remain immutable; only their in-memory document is upgraded.
const board = $derived.by(() => {
	if (!manifest || !parsed?.ok) return null;
	return {
		document: parsed.document,
		assetSource: createAppBoardAssetSource({
			manifestUrl: content.url,
			assets: manifest.assets,
		}),
	};
});
const runtimeModule = $derived(board ? cohubPixiRuntime.load() : null);

$effect(() => {
	const url = content.url;
	let cancelled = false;
	error = null;
	void fetch(url)
		.then(async (response) => {
			if (!response.ok)
				throw new Error(`Failed to load board (${response.status})`);
			return (await response.json()) as AppBoardArtifactManifest;
		})
		.then((value) => {
			if (cancelled) return;
			if (value?.kind !== "cohub.work.board" || !value.snapshot?.items) {
				throw new Error("Board artifact is invalid.");
			}
			loaded = { url, manifest: value };
		})
		.catch((cause: unknown) => {
			if (cancelled) return;
			error = cause instanceof Error ? cause.message : "Failed to load board.";
		});
	return () => {
		cancelled = true;
	};
});
</script>

<div class="work-board-surface">
	{#if error || parsed?.ok === false}
		<div class="board-message error" role="alert">{m.board_failed_load({}, { locale })}</div>
	{:else if !board || !runtimeModule}
		<CenteredLoading label={m.common_loading({}, { locale })} size="page" />
	{:else}
		{#await runtimeModule}
			<CenteredLoading label={m.common_loading({}, { locale })} size="page" />
		{:then module}
			{@const BoardRuntime = module.default}
			{#key content.url}
				<BoardRuntime
					mode="view"
					path={content.path}
					boardId={content.boardId}
					document={board.document}
					playback={null}
					spaceId={`app:${content.boardId}`}
					assetSource={board.assetSource}
					{isMobile}
				/>
			{/key}
		{:catch}
			<div class="board-message error" role="alert">{m.board_failed_load({}, { locale })}</div>
		{/await}
	{/if}
</div>

<style>
	.work-board-surface {
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
		color: var(--error-soft);
	}
</style>
