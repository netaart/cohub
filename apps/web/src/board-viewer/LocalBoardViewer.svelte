<script lang="ts">
import {
	type BoardReplicaState,
	createBoardReplica,
} from "@neta-art/cohub/board/replica";
import { cohubPixiRuntime } from "$lib/board/runtime/board-runtime";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	localBoardAssetSource,
	localBoardImageStore,
	localBoardRemote,
	readLocalBoardRoute,
} from "./local-remote";

const locale = $derived(getLocale());
const route = readLocalBoardRoute(location.pathname);
const isMobile = matchMedia("(max-width: 640px), (pointer: coarse)").matches;
const runtime = cohubPixiRuntime.load();

const replica = route
	? createBoardReplica({
			remote: localBoardRemote(route),
			clientId: crypto.randomUUID(),
		})
	: null;
const storeImage = route ? localBoardImageStore(route) : undefined;
const scope = route
	? { kind: "local" as const, assetSource: localBoardAssetSource(route) }
	: null;
let board = $state.raw<BoardReplicaState | null>(replica?.state ?? null);

$effect(() => {
	if (!replica) return;
	const off = replica.subscribe((next) => {
		board = next;
	});
	void replica.start();
	return () => {
		off();
		replica.dispose();
	};
});

// The first title names the file; later title edits must not reset the view.
let path = $state<string | null>(null);
$effect(() => {
	if (!board?.title) return;
	document.title = board.title;
	path ??= board.title;
});

const failed = $derived(!route || (board?.loaded === false && board.error));
</script>

<div class="local-board">
	{#if failed}
		<div class="board-message" role="alert">
			{m.board_failed_load({}, { locale })}
		</div>
	{:else if !route || !replica || !scope || !board?.document || !path}
		<CenteredLoading label={m.common_loading({}, { locale })} size="page" />
	{:else}
		{#await runtime}
			<CenteredLoading label={m.common_loading({}, { locale })} size="page" />
		{:then module}
			<module.default
				{path}
				boardId={route.id}
				document={board.document}
				playback={board.playback}
				{scope}
				mode="edit"
				{isMobile}
				syncing={board.pending > 0}
				syncError={board.error}
				{storeImage}
				onCommit={(patch) => replica.apply(patch)}
				onRetrySync={() => replica.retry()}
			/>
		{:catch}
			<div class="board-message" role="alert">
				{m.board_failed_load({}, { locale })}
			</div>
		{/await}
	{/if}
</div>

<style>
	.local-board {
		position: fixed;
		inset: 0;
		background: var(--bg-primary);
	}

	.board-message {
		display: flex;
		height: 100%;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		color: var(--color-error-soft);
		font-size: 0.8125rem;
	}
</style>
