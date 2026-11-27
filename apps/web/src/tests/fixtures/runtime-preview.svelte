<script lang="ts">
// Local-only browser fixture. Mounted temporarily by scripts/preview-runtime-ui.mjs.
import "../../app.css";
import {
	APPROVAL_MODES,
	type ApprovalMode,
	type HarnessKind,
	type RuntimeStatus,
} from "@neta-art/cohub";
import type {
	CloudModels,
	ComposerRuntime,
} from "#lib/components/composer/runtime-picker.ts";
import SessionComposer from "#lib/components/SessionComposer.svelte";
import SessionApprovals from "#lib/features/session-chat/SessionApprovals.svelte";
import SpaceWorkspaceHeader, {
	type SpaceWorkspaceHeaderContext,
} from "#lib/features/space/modules/SpaceWorkspaceHeader.svelte";
import { refreshRuntimeStatus } from "#lib/features/space/runtime-status.svelte.ts";
import { setLocalePreference } from "#lib/i18n/locale.svelte.ts";
import {
	type LocalModelSelection,
	resolveLocalModel,
} from "#lib/model-catalog.ts";
import { sdk } from "#lib/sdk.ts";

const spaceId = "11111111-1111-4111-8111-111111111111";
const models = [
	{
		harness: "pi" as const,
		provider: "anthropic",
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		isDefault: true,
		defaultThinkingLevel: "medium" as const,
		reasoning: true,
		thinkingLevelMap: { xhigh: "high", max: "max" },
	},
	{
		harness: "pi" as const,
		provider: "openai",
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
	},
	{
		harness: "codex" as const,
		provider: "openai",
		id: "gpt-5.4-codex",
		name: "GPT-5.4 Codex",
		isDefault: true,
		reasoning: true,
		defaultThinkingLevel: "medium" as const,
		serviceTiers: [{ id: "priority", name: "Fast" }],
		defaultServiceTier: "priority",
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	},
	{
		harness: "claude" as const,
		provider: "anthropic",
		id: "default",
		name: "Default",
		isDefault: true,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		harness: "cursor" as const,
		provider: "cursor",
		id: "default",
		name: "Default",
		isDefault: true,
	},
];
type PreviewState = "ready" | "limited" | "offline" | "unknown";
let previewState = $state<PreviewState>("ready");
let input = $state("");
let harness = $state<HarnessKind>("pi");
let chosenModels = $state<Record<string, LocalModelSelection>>({});
let approvalModes = $state<Record<string, ApprovalMode>>({});
const approvalMode = $derived(
	harness === "cohub" ? null : (approvalModes[harness] ?? null),
);
// Mirrors the session host: the composer always shows a resolved model and level.
const modelFor = (next: string) =>
	resolveLocalModel(
		models.filter((item) => item.harness === next),
		chosenModels[next] ?? null,
	);
const localModel = $derived(harness === "cohub" ? null : modelFor(harness));
let status = $state<RuntimeStatus>(makeStatus());
function makeStatus(): RuntimeStatus {
	return {
		kind: "local",
		online: previewState !== "offline",
		runtimeId: "22222222-2222-4222-8222-222222222222",
		capabilities: {
			harnesses: ["pi", "codex", "claude", "workbuddy", "cursor"],
			...(previewState === "limited"
				? {}
				: {
						approvalModes: {
							codex: [...APPROVAL_MODES],
							// Leaves one mode out to preview a disabled item.
							claude: ["inherit", "full_access", "read_only"],
						},
					}),
			models,
		},
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
const approvalAt = Date.now();
fixtureSpace.getSessionApprovals = async () => ({
	canDecide: true,
	approvals: [
		{
			id: "33333333-3333-4333-8333-333333333333",
			turnId: "44444444-4444-4444-8444-444444444444",
			kind: "command",
			command: "/bin/bash -lc 'pnpm install && pnpm test'",
			cwd: "/Users/me/project",
			reason: "Needs network access to install packages",
			decisions: ["accept", "accept_for_session", "decline"],
			requestedAt: new Date(approvalAt).toISOString(),
			expiresAt: new Date(approvalAt + 30 * 60_000).toISOString(),
		},
	],
});
fixtureSpace.decideApproval = async () => ({ accepted: true });
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
	activeSessionArchived: false,
	activeSessionRunning: false,
	sessionArchiveFailed: false,
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
	spaceIdentity: null,
};
const noop = () => {};
const cloudModels = [
	{
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		model: { name: "Claude Sonnet 4.5", cost: { input: 3, output: 15 } },
	},
	{ provider: "openai", id: "gpt-5", model: { name: "GPT-5" } },
];
let showPicker = $state(false);
let cloudOnly = $state(false);
let cloudModel = $state<{ provider: string; id: string; name?: string } | null>(
	cloudModels[0],
);
const cloud = $derived<Pick<CloudModels, "list" | "onOpen">>({
	list: { models: cloudModels, currentModel: cloudModel, generationModels: [] },
});
const runtime: ComposerRuntime = {
	get harness() {
		return harness;
	},
	get model() {
		return localModel;
	},
	get approvalMode() {
		return approvalMode;
	},
	get local() {
		return !cloudOnly;
	},
	get online() {
		return !cloudOnly && status.online;
	},
	get harnesses() {
		return cloudOnly ? [] : (status.capabilities?.harnesses ?? []);
	},
	get models() {
		return status.capabilities?.models ?? [];
	},
	modelFor,
	approvalFor: (next) => ({
		modes: status.capabilities?.approvalModes?.[next] ?? [],
		mode: approvalModes[next] ?? null,
	}),
	refresh: noop,
	select: (next, model) => {
		console.log("select", next, JSON.stringify(model));
		harness = next;
		if (!model) return;
		if (next === "cohub")
			cloudModel = cloudModels.find((item) => item.id === model.id) ?? null;
		else chosenModels = { ...chosenModels, [next]: model };
	},
	setApproval: (next, mode) => {
		approvalModes = { ...approvalModes, [next]: mode };
	},
};
</script>

<svelte:head><title>Runtime UI verification</title></svelte:head>
<div class="flex h-dvh flex-col bg-bg-primary text-text-primary">
	<SpaceWorkspaceHeader {context} sessionRename={{ renaming: false, value: "", saving: false, failed: false }} resourceActions={{ open: false, available: true }} actions={{ openShareModal: noop, startSessionRename: noop, cancelSessionRename: noop, submitSessionRename: noop, setSessionRenameValue: noop, toggleResourceActionMenu: noop, closeResourceActionMenu: noop, labelHeaderResource: noop, insertHeaderReference: noop, toggleSessionArchive: noop, toggleRightSidebar: noop, openDisplay: noop }} />
	<main class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8">
		<div class="flex flex-wrap gap-2 text-sm">
			{#each ["ready", "limited", "offline", "unknown"] as value}<button class="rounded border border-border-subtle px-2 py-1" onclick={() => void choose(value as PreviewState)}>{value}</button>{/each}
			<button class="rounded border border-border-subtle px-2 py-1" onclick={() => setLocalePreference("zh-CN")}>中文</button>
			<button class="rounded border border-border-subtle px-2 py-1" onclick={() => setLocalePreference("en")}>EN</button>
			<button class="rounded border border-border-subtle px-2 py-1" onclick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"}>Theme</button>
		</div>
		<div class="flex-1 text-sm text-text-tertiary">Isolated fixtures · no account or model requests</div>
		<button class="rounded border border-border-subtle px-2 py-1" onclick={() => { showPicker = true; }}>open picker</button>
		<button class="rounded border border-border-subtle px-2 py-1" onclick={() => { cloudOnly = !cloudOnly; }}>cloud only</button>
		<output aria-label="Approval selection">{approvalMode ?? "unset"}</output>
		<output aria-label="Model selection">{JSON.stringify(localModel)}</output>
		<SessionApprovals {spaceId} sessionId="55555555-5555-4555-8555-555555555555" harnessOf={() => (harness === "cohub" ? "codex" : harness)} />
		<SessionComposer bind:value={input} bind:modelOpen={showPicker} {runtime} {cloud} currentModel={cloudModel} onsubmit={noop} onpickattachment={noop} />
	</main>
</div>
