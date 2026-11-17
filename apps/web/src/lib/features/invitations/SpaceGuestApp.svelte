<script lang="ts">
import type {
	AppResolveResponse,
	AppRuntimeShellContext,
	SpaceRole,
} from "@neta-art/cohub";
import AppSurface from "#lib/components/app/AppSurface.svelte";
import Spinner from "#lib/components/Spinner.svelte";
import { sdk } from "#lib/sdk.ts";

const {
	appId,
	space,
	invite = null,
	onJoined,
	onUnavailable,
}: {
	appId: string;
	space: { id: string; name: string | null };
	invite?: string | null;
	onJoined: (space: { id: string; role: SpaceRole }) => void;
	onUnavailable: () => void;
} = $props();

let state = $state<
	{ status: "loading" } | { status: "ready"; data: AppResolveResponse }
>({ status: "loading" });

$effect(() => {
	const id = appId;
	let stale = false;
	state = { status: "loading" };
	sdk.apps.getPublicById(id).then(
		(data) => {
			if (!stale) state = { status: "ready", data };
		},
		() => {
			if (!stale) onUnavailable();
		},
	);
	return () => {
		stale = true;
	};
});

const shell = $derived<AppRuntimeShellContext>({
	surface: "guest",
	space: { id: space.id, name: space.name },
	session: null,
	turn: null,
	invite: invite ? { token: invite } : null,
});
</script>

{#if state.status === "ready"}
	{@const data = state.data}
	<div class="flex h-full min-h-0 w-full flex-1 flex-col">
	<AppSurface
		mode="page"
		cohubBar={false}
		app={data.app}
		space={data.space}
		owner={data.owner}
		publisher={data.publisher}
		content={data.content}
		invocation={{ surface: "page", source: "route", spaceId: space.id }}
		{shell}
		onSpaceJoined={(joined) => onJoined({ id: joined.id, role: joined.role })}
	/>
	</div>
{:else}
	<div class="flex h-full min-h-0 flex-1 items-center justify-center text-text-tertiary">
		<Spinner class="h-4 w-4" />
	</div>
{/if}
