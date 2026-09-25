<script lang="ts">
// Local-only browser fixture. Mounted temporarily by scripts/preview-runtime-ui.mjs.
import "../../app.css";
import type { RuntimeStatus } from "@neta-art/cohub";
import SessionComposer from "$lib/components/SessionComposer.svelte";
import SpaceWorkspaceHeader, {
	type SpaceWorkspaceHeaderContext,
} from "$lib/features/space/modules/SpaceWorkspaceHeader.svelte";
import { refreshRuntimeStatus } from "$lib/features/space/runtime-status.svelte";
import { setLocalePreference } from "$lib/i18n/locale.svelte";
import { sdk } from "$lib/sdk";

const spaceId = "11111111-1111-4111-8111-111111111111";
const models = [
	{
		harness: "pi" as const,
		provider: "anthropic",
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
	},
	{
		harness: "pi" as const,
		provider: "openai",
		id: "gpt-5.4",
		name: "GPT-5.4",
	},
	{
		harness: "codex" as const,
		provider: "openai",
		id: "gpt-5.4-codex",
		name: "GPT-5.4 Codex",
	},
];
type PreviewState = "ready" | "limited" | "offline" | "unknown";
let previewState = $state<PreviewState>("ready");
let input = $state("");
let harness = $state<"cohub" | "pi" | "codex">("pi");
let model = $state<{ provider: string; id: string; name?: string } | null>(
	null,
);
let status = $state<RuntimeStatus>(makeStatus());
function makeStatus(): RuntimeStatus {
	return {
		kind: "local",
		online: previewState !== "offline",
		runtimeId: "22222222-2222-4222-8222-222222222222",
		capabilities: { harnesses: ["pi", "codex"], models },
		workspace: {
			online: previewState === "ready",
			observedAt: new Date().toISOString(),
		},
		fileWatcher: {
			state: "running",
			backend: "fsevents",
			observedAt: new Date().toISOString(),
		},
		observedAt: new Date(
			Date.now() - (previewState === "unknown" ? 120_000 : 0),
		).toISOString(),
	};
}
const fixtureSpace = sdk.space(spaceId);
fixtureSpace.getRuntime = async () => status;
fixtureSpace.subscribe = () => () => {};
sdk.space = () => fixtureSpace;
async function choose(next: PreviewState) {
	previewState = next;
	status = makeStatus();
	await refreshRuntimeStatus(spaceId, { force: true });
}
const context: SpaceWorkspaceHeaderContext = {
	routeView: "app",
	spaceId,
	space: null,
	activeSession: undefined,
	activeSessionLoaded: true,
	activeSessionLoading: false,
	isNewSessionRoute: false,
	wsConnectionState: "connected",
	onlineUsers: [],
	activeRouteDetailHeader: {
		view: "app",
		id: "preview",
		title:
			"Local workspace — a long project title that should never push status offscreen",
	},
	activeSessionId: "session",
	canManageSessionAccess: true,
	isActiveSessionPublic: false,
	spaceHasMinimalAccess: false,
	rightSidebarAvailable: true,
	rightSidebarCollapsed: true,
};
const noop = () => {};
</script>

<svelte:head><title>Runtime UI verification</title></svelte:head>
<div class="flex h-dvh flex-col bg-bg-primary text-text-primary">
	<SpaceWorkspaceHeader {context} sessionRename={{ renaming: false, value: "", saving: false }} resourceActions={{ open: false, available: true }} actions={{ openShareModal: noop, startSessionRename: noop, cancelSessionRename: noop, submitSessionRename: noop, setSessionRenameValue: noop, toggleResourceActionMenu: noop, closeResourceActionMenu: noop, labelHeaderResource: noop, insertHeaderReference: noop, toggleRightSidebar: noop }} />
	<main class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8">
		<div class="flex flex-wrap gap-2 text-sm">
			{#each ["ready", "limited", "offline", "unknown"] as value}<button class="rounded border border-border-subtle px-2 py-1" onclick={() => void choose(value as PreviewState)}>{value}</button>{/each}
			<button class="rounded border border-border-subtle px-2 py-1" onclick={() => setLocalePreference("zh-CN")}>中文</button>
			<button class="rounded border border-border-subtle px-2 py-1" onclick={() => setLocalePreference("en")}>EN</button>
			<button class="rounded border border-border-subtle px-2 py-1" onclick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"}>Theme</button>
		</div>
		<div class="flex-1 text-sm text-text-tertiary">Isolated fixtures · no account or model requests</div>
		<SessionComposer bind:value={input} {harness} harnesses={["cohub", "pi", "codex"]} localRuntime runtimeOnline={status.online} onharnesschange={(next) => { harness = next; model = null; }} localModels={models.filter((item) => item.harness === harness)} localModel={model} onlocalmodelchange={(next) => { model = next; }} onsubmit={noop} onpickattachment={noop} />
	</main>
</div>
