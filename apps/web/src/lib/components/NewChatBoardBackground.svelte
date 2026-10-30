<script lang="ts">
import {
	type AppNavigationTarget,
	buildAppNavigationOpenMessage,
} from "@cohub/protocol/app-navigation";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import { parseBoardLaunch } from "@neta-art/cohub/board";
import type { BoardReplica } from "@neta-art/cohub/board/replica";
import type { AppNavigationHandler } from "$lib/board/board-app";
import { readBoardManifestId } from "$lib/board/board-manifest-text";
import {
	acquireBoardReplica,
	playBoardReplica,
} from "$lib/board/board-replica-registry";
import { cohubPixiRuntime } from "$lib/board/runtime/board-runtime";
import {
	readBoardManifestCache,
	writeBoardManifestCache,
} from "$lib/cache/repositories/board-repo";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { subscribeSpaceBoardFileChanged } from "$lib/space-config";

type Props = {
	spaceId: string;
	path: string;
	launch?: string;
	onNavigationOpen?: AppNavigationHandler;
};

const { spaceId, path, launch, onNavigationOpen }: Props = $props();

const MAX_PREPARING_RETRIES = 5;
const locale = $derived(getLocale());
const runtime = cohubPixiRuntime.load();
const isMobile = $derived(useCompactShell());
const parsedLaunch = $derived(launch ? parseBoardLaunch(launch) : null);
const shell = $derived<AppRuntimeShellContext>({
	surface: "background",
	space: { id: spaceId },
	session: null,
	turn: null,
});

let resolved = $state<{ key: string; boardId: string | null } | null>(null);
let board = $state.raw<{
	boardId: string;
	replica: BoardReplica;
	state: BoardReplica["state"];
} | null>(null);

const key = $derived(`${spaceId}:${path}`);
const boardId = $derived(resolved?.key === key ? resolved.boardId : undefined);
const shown = $derived(boardId && board?.boardId === boardId ? board : null);

async function readManifest(live: () => boolean, attempt = 0): Promise<string> {
	const file = await sdk.space(spaceId).files.read(path);
	if ("content" in file || attempt >= MAX_PREPARING_RETRIES || !live())
		return readBoardManifestId(file);
	const wait = Math.min(2000, Math.max(250, file.retryAfterMs));
	await new Promise((resolve) => setTimeout(resolve, wait));
	return readManifest(live, attempt + 1);
}

let fileVersion = $state(0);
$effect(() =>
	subscribeSpaceBoardFileChanged((changed) => {
		if (changed === path) fileVersion += 1;
	}),
);

$effect(() => {
	fileVersion;
	const current = key;
	const manifest = { spaceId, sourceKey: "live", path };
	let live = true;
	const settle = (id: string | null) => {
		if (live) resolved = { key: current, boardId: id };
	};
	void readBoardManifestCache(manifest)
		.then((cached) => {
			if (cached && live && resolved?.key !== current) settle(cached);
		})
		.catch(() => undefined);
	readManifest(() => live).then(
		(id) => {
			if (!live) return;
			settle(id);
			void writeBoardManifestCache({ ...manifest, boardId: id }).catch(
				() => undefined,
			);
		},
		(cause) => {
			if (!live) return;
			if (cause instanceof HttpError && cause.status === 404) {
				void writeBoardManifestCache({ ...manifest, boardId: null }).catch(
					() => undefined,
				);
				settle(null);
			} else if (resolved?.key !== current) settle(null);
		},
	);
	return () => {
		live = false;
	};
});

$effect(() => {
	const id = boardId;
	if (!id) return;
	const { replica, release } = acquireBoardReplica(spaceId, id);
	const adopt = () => {
		board = { boardId: id, replica, state: replica.state };
	};
	adopt();
	const stop = replica.subscribe(adopt);
	return () => {
		stop();
		release();
	};
});

function navigate(target: AppNavigationTarget) {
	void onNavigationOpen?.(
		buildAppNavigationOpenMessage({ requestId: crypto.randomUUID(), target }),
	);
}
</script>

{#if boardId === null || (shown && !shown.state.document && shown.state.error)}
	<div class="new-chat-board-state">{m.newchat_bg_unavailable({}, { locale })}</div>
{:else if shown?.state.document}
	{@const { boardId: id, replica, state } = shown}
	{#await runtime then { default: BoardRuntime }}
		{#key id}
			<BoardRuntime
				{path}
				boardId={id}
				document={shown.state.document}
				playback={state.playback}
				scope={{ kind: "space", spaceId }}
				{shell}
				{onNavigationOpen}
				launch={parsedLaunch}
				{isMobile}
				keysWhenUsed
				syncError={state.error}
				onCommit={(patch) => replica.apply(patch)}
				onPlayback={(command) => playBoardReplica(spaceId, id, command)}
				onRetrySync={() => replica.retry()}
				onOpenFile={(file) => navigate({ kind: "file", spaceId, path: file })}
				onOpenTask={(taskRunId) => navigate({ kind: "task", spaceId, taskRunId })}
				onOpenSession={(sessionId) => navigate({ kind: "session", spaceId, sessionId })}
				onOpenApp={(app) => navigate({ kind: "app", ref: app.appId })}
			/>
		{/key}
	{:catch}
		<div class="new-chat-board-state">{m.newchat_bg_unavailable({}, { locale })}</div>
	{/await}
{/if}

<style>
	.new-chat-board-state {
		display: flex;
		width: 100%;
		height: 100%;
		align-items: center;
		justify-content: center;
		font-size: 0.875rem;
		color: var(--text-tertiary);
	}
</style>
