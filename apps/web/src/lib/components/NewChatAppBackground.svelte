<script lang="ts">
import type {
	AppNavigationOpenMessage,
	AppNavigationOpenResponse,
} from "@cohub/protocol/app-navigation";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type { CohubAppUrl } from "#lib/app-url.ts";
import AppSurface from "#lib/components/app/AppSurface.svelte";
import { sdk } from "#lib/sdk.ts";

type Props = {
	appUrl: CohubAppUrl;
	/** Space currently hosting the new chat background. */
	currentSpaceId?: string | null;
	onComposerChip?: (appId: string, chip: AppComposerChip | null) => void;
	onNavigationOpen?: (
		message: AppNavigationOpenMessage,
	) => Promise<
		Omit<
			AppNavigationOpenResponse,
			"protocol" | "version" | "type" | "requestId"
		>
	>;
};

const {
	appUrl,
	currentSpaceId = null,
	onComposerChip,
	onNavigationOpen,
}: Props = $props();

const hostContext = $derived(
	currentSpaceId
		? {
				invocation: {
					surface: "background" as const,
					source: "route" as const,
					spaceId: currentSpaceId,
				},
				shell: {
					surface: "background" as const,
					space: { id: currentSpaceId },
					session: null,
					turn: null,
				},
			}
		: null,
);

let state = $state<
	| { status: "loading" }
	| {
			status: "ready";
			data: Awaited<ReturnType<typeof sdk.apps.getBySlug>>;
	  }
	| { status: "error" }
>({ status: "loading" });
let loadVersion = 0;

$effect(() => {
	const version = ++loadVersion;
	state = { status: "loading" };
	void sdk.apps
		.getBySlug(appUrl.username, appUrl.spaceSlug, appUrl.appSlug)
		.then((data) => {
			if (version !== loadVersion) return;
			state = { status: "ready", data };
		})
		.catch(() => {
			if (version !== loadVersion) return;
			state = { status: "error" };
		});
});
</script>

{#if state.status === "ready"}
	{@const data = state.data}
	<AppSurface
		mode="background"
		app={data.app}
		space={data.space}
		owner={data.owner}
		content={data.content ?? null}
		launchState={appUrl}
		invocation={hostContext?.invocation}
		shell={hostContext?.shell}
		onComposerChip={(chip) => onComposerChip?.(data.app.id, chip)}
		onNavigationOpen={onNavigationOpen}
	/>
{:else if state.status === "error"}
	<div class="work-background-state">App background is unavailable.</div>
{:else}
	<div class="work-background-state" aria-hidden="true"></div>
{/if}

<style>
	.work-background-state {
		display: flex;
		width: 100%;
		height: 100%;
		align-items: center;
		justify-content: center;
		background: var(--bg-content);
		font-size: 0.875rem;
		color: var(--text-tertiary);
	}
</style>
