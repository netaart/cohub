<script lang="ts">
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import type {
	GenerationModelRow,
	GenerationSpaceRow,
	GenerationUserRow,
	ModelRow,
	SpaceRow,
	UserProfile,
	UserRow,
} from "$lib/trending";
import {
	fetchGenerationModels,
	fetchGenerationSpaces,
	fetchGenerationUsers,
	fetchModels,
	fetchSpaces,
	fetchUsers,
} from "$lib/trending";

type Board = "llm" | "generation";
type Dimension = "spaces" | "users" | "models";

type LlmRow = SpaceRow | UserRow | ModelRow;
type GenerationRow =
	| GenerationSpaceRow
	| GenerationUserRow
	| GenerationModelRow;
type AnyRow = LlmRow | GenerationRow;

const boards: { id: Board; label: string }[] = [
	{ id: "llm", label: "LLM" },
	{ id: "generation", label: "Generation" },
];

const dimensions: { id: Dimension; label: string }[] = [
	{ id: "spaces", label: "Spaces" },
	{ id: "users", label: "Users" },
	{ id: "models", label: "Models" },
];

let activeBoard = $state<Board>("llm");
let activeDimension = $state<Dimension>("spaces");

let spaces = $state<SpaceRow[]>([]);
let users = $state<UserRow[]>([]);
let models = $state<ModelRow[]>([]);
let generationSpaces = $state<GenerationSpaceRow[]>([]);
let generationUsers = $state<GenerationUserRow[]>([]);
let generationModels = $state<GenerationModelRow[]>([]);

/** Per-board load state avoids cross-board loading races when switching quickly. */
let llmLoaded = $state(false);
let generationLoaded = $state(false);
let llmLoading = $state(false);
let generationLoading = $state(false);
let llmRequestId = 0;
let generationRequestId = 0;

function toFiniteNumber(value: unknown, fallback = 0): number {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : fallback;
}

function formatNumber(n: number): string {
	const value = toFiniteNumber(n);
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

function formatCost(n: number): string {
	const value = toFiniteNumber(n);
	if (value === 0) return "$0";
	if (value > 0 && value < 0.001) return "<$0.001";

	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 0,
		maximumFractionDigits: value >= 0.01 ? 2 : 3,
	}).format(value);
}

function isSpaceRow(row: AnyRow): row is SpaceRow | GenerationSpaceRow {
	return "spaceId" in row;
}

function isUserRow(row: AnyRow): row is UserRow | GenerationUserRow {
	return "userId" in row && !("spaceId" in row) && !("model" in row);
}

function isModelRow(row: AnyRow): row is ModelRow | GenerationModelRow {
	return "model" in row;
}

function getDisplayName(row: AnyRow): string {
	if (isSpaceRow(row)) return row.spaceName;
	if (isUserRow(row)) return row.userDisplay;
	return row.modelDisplay;
}

function getSpaceHref(row: AnyRow): string | null {
	if (!isSpaceRow(row)) return null;
	return buildSpaceLandingRoute(row.spaceId);
}

function getUserProfile(row: AnyRow): UserProfile | null {
	if (isSpaceRow(row) || isUserRow(row)) return row.userProfile;
	return null;
}

function getRowKey(row: AnyRow): string {
	const board = activeBoard;
	if (isSpaceRow(row)) return `${board}:spaces:${row.spaceId}`;
	if (isUserRow(row)) return `${board}:users:${row.userId}`;
	return `${board}:models:${row.provider}:${row.model}`;
}

function getPrimaryMetric(row: AnyRow): string {
	if (activeBoard === "llm" && "totalTokens" in row) {
		return formatNumber(row.totalTokens);
	}
	return formatNumber(row.requestCount);
}

function getPrimaryLabel(): string {
	return activeBoard === "llm" ? "Tokens" : "Reqs";
}

function getSecondaryMetrics(
	row: AnyRow,
): Array<{ label: string; value: string }> {
	if (activeBoard === "llm") {
		return [
			{ label: "Cost", value: formatCost(row.costTotal) },
			{ label: "Sessions", value: String(row.sessionCount) },
			{ label: "Reqs", value: formatNumber(row.requestCount) },
		];
	}
	return [
		{ label: "Cost", value: formatCost(row.costTotal) },
		{ label: "Sessions", value: String(row.sessionCount) },
	];
}

async function loadBoard(board: Board) {
	if (board === "llm") {
		if (llmLoaded || llmLoading) return;
		const requestId = ++llmRequestId;
		llmLoading = true;
		try {
			const [s, u, m] = await Promise.all([
				fetchSpaces(),
				fetchUsers(),
				fetchModels(),
			]);
			if (requestId !== llmRequestId) return;
			spaces = s;
			users = u;
			models = m;
			llmLoaded = true;
		} finally {
			if (requestId === llmRequestId) llmLoading = false;
		}
		return;
	}

	if (generationLoaded || generationLoading) return;
	const requestId = ++generationRequestId;
	generationLoading = true;
	try {
		const [gs, gu, gm] = await Promise.all([
			fetchGenerationSpaces(),
			fetchGenerationUsers(),
			fetchGenerationModels(),
		]);
		if (requestId !== generationRequestId) return;
		generationSpaces = gs;
		generationUsers = gu;
		generationModels = gm;
		generationLoaded = true;
	} finally {
		if (requestId === generationRequestId) generationLoading = false;
	}
}

$effect(() => {
	void loadBoard(activeBoard);
});

const currentRows = $derived.by((): AnyRow[] => {
	if (activeBoard === "llm") {
		switch (activeDimension) {
			case "spaces":
				return spaces;
			case "users":
				return users;
			case "models":
				return models;
		}
	}
	switch (activeDimension) {
		case "spaces":
			return generationSpaces;
		case "users":
			return generationUsers;
		case "models":
			return generationModels;
	}
});

const boardLoading = $derived(
	activeBoard === "llm"
		? llmLoading || !llmLoaded
		: generationLoading || !generationLoaded,
);
const boardLoaded = $derived(
	activeBoard === "llm" ? llmLoaded : generationLoaded,
);
const hasData = $derived(currentRows.length > 0);

const boardHint = $derived(
	activeBoard === "llm" ? "Ranked by tokens" : "Ranked by generation requests",
);
</script>

<svelte:head>
	<title>Trending — Cohub</title>
</svelte:head>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
	<!-- Header -->
	<div class="px-4 pt-8 pb-0 shrink-0 sm:px-6 sm:pt-10">
		<h1 class="text-[28px] font-semibold tracking-tight text-text-primary">Trending</h1>
		<p class="mt-1 text-[13px] leading-snug text-text-tertiary">Yesterday's platform leaderboard</p>
	</div>

	<!-- Board switcher (LLM vs Generation) -->
	<div class="flex gap-0 px-4 mt-5 mb-0 border-b border-border-subtle shrink-0 sm:px-6 sm:mt-6">
		{#each boards as board}
			<button
				type="button"
				aria-pressed={activeBoard === board.id}
				class="relative min-h-11 px-3 py-2.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary {activeBoard === board.id ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}"
				onclick={() => {
					activeBoard = board.id;
				}}
			>
				{board.label}
				{#if activeBoard === board.id}
					<span class="absolute bottom-0 left-0 right-0 h-[2px] bg-brand rounded-full"></span>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Dimension chips + ranking hint -->
	<div class="flex flex-wrap items-center gap-2 px-4 mt-4 mb-4 shrink-0 sm:px-6 sm:mt-5 sm:mb-5">
		{#each dimensions as dimension}
			<button
				type="button"
				aria-pressed={activeDimension === dimension.id}
				class="min-h-8 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary {activeDimension === dimension.id
					? 'bg-bg-elevated text-text-primary ring-1 ring-border-subtle'
					: 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
				onclick={() => {
					activeDimension = dimension.id;
				}}
			>
				{dimension.label}
			</button>
		{/each}
		<span class="ml-auto text-[11px] text-text-placeholder">{boardHint}</span>
	</div>

	<!-- Content -->
	<div class="flex-1 px-4 pb-6 overflow-y-auto sm:px-6">
		{#if boardLoading}
			<CenteredLoading label="Loading…" />
		{:else if !hasData}
			<div class="py-20">
				<div class="text-[13px] text-text-tertiary">
					{#if boardLoaded}Yesterday's data is being collected{:else}No data available{/if}
				</div>
			</div>
		{:else}
			<div class="trending-table" class:generation-board={activeBoard === "generation"}>
				<div class="trending-table-row px-0 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-placeholder border-b border-border-subtle sm:pb-3">
					<span></span>
					<span class="truncate">Name</span>
					<span class="text-right">{getPrimaryLabel()}</span>
					<span class="hidden text-right sm:block">Cost</span>
					<span class="hidden text-right sm:block">Sessions</span>
					{#if activeBoard === "llm"}
						<span class="hidden text-right sm:block">Reqs</span>
					{/if}
				</div>

				{#each currentRows as row, i (getRowKey(row))}
					{@const userProfile = getUserProfile(row)}
					{@const spaceHref = getSpaceHref(row)}
					{@const secondary = getSecondaryMetrics(row)}
					<div
						class="trending-table-row px-0 transition-all duration-300 ease-out"
						class:row-top={row.rank <= 3}
						class:row-data={row.rank > 3}
						style="--row-index: {i}; animation: rowFadeIn 0.35s ease-out both; animation-delay: {i * 35}ms;"
					>
						<div class="row-span-2 flex min-h-12 items-start justify-center py-2.5 sm:row-span-1 sm:min-h-0 sm:items-center sm:py-3">
							{#if row.rank === 1}
								<span class="flex items-center justify-center w-6 h-6 rounded-[4px] bg-brand text-[11px] font-bold text-brand-contrast-fg">1</span>
							{:else if row.rank === 2}
								<span class="text-[13px] font-semibold text-brand">2</span>
							{:else if row.rank === 3}
								<span class="text-[13px] font-semibold text-brand">3</span>
							{:else}
								<span class="text-[12px] text-text-disabled tabular-nums">{row.rank}</span>
							{/if}
						</div>

						<div class="min-w-0 py-2.5 sm:py-3">
							<div class="flex min-w-0 items-center gap-2">
								{#if isSpaceRow(row)}
									<SpaceAvatar name={row.spaceName} profile={row.spaceProfile} seed={row.spaceId} size="sm" />
								{:else if isUserRow(row) && userProfile}
									<UserAvatar name={userProfile.displayName} avatarUrl={userProfile.avatarUrl} seed={userProfile.userUuid} size="sm" />
								{/if}
								{#if spaceHref}
									<a
										href={spaceHref}
										class="trending-name min-w-0 text-[14px] font-medium leading-snug text-text-primary transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary sm:truncate sm:text-[13px] sm:leading-normal"
										data-sveltekit-preload-data="hover"
									>
										{getDisplayName(row)}
									</a>
								{:else}
									<div class="trending-name min-w-0 text-[14px] font-medium leading-snug text-text-primary sm:truncate sm:text-[13px] sm:leading-normal">
										{getDisplayName(row)}
									</div>
								{/if}
							</div>
							{#if isSpaceRow(row) && userProfile}
								<div class="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-text-tertiary sm:mt-0.5 sm:text-[11px]">
									<span>by</span>
									<UserAvatar name={userProfile.displayName} avatarUrl={userProfile.avatarUrl} seed={userProfile.userUuid} size="xxs" class="border-0" />
									<span class="min-w-0 truncate">{userProfile.displayName}</span>
								</div>
							{/if}
						</div>

						<div class="flex items-start justify-end py-2.5 sm:items-center sm:py-3">
							<span class="font-mono text-[13px] tabular-nums text-text-primary">
								{getPrimaryMetric(row)}
							</span>
						</div>

						<div class="col-start-2 col-span-2 -mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 pb-2.5 text-[12px] leading-none text-text-tertiary sm:hidden">
							{#each secondary as metric}
								<span>
									<span class="text-text-placeholder">{metric.label}</span>
									<span class="font-mono tabular-nums text-text-secondary">{metric.value}</span>
								</span>
							{/each}
						</div>

						<div class="hidden items-center justify-end py-2 sm:flex sm:py-3">
							<span class="text-[13px] text-text-secondary font-mono tabular-nums">
								{formatCost(row.costTotal)}
							</span>
						</div>

						<div class="hidden items-center justify-end py-2 sm:flex sm:py-3">
							<span class="text-[13px] text-text-secondary tabular-nums">
								{row.sessionCount}
							</span>
						</div>

						{#if activeBoard === "llm"}
							<div class="hidden items-center justify-end py-2 sm:flex sm:py-3">
								<span class="text-[13px] text-text-secondary tabular-nums">
									{formatNumber(row.requestCount)}
								</span>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	@keyframes rowFadeIn {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.trending-table {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		column-gap: 0.5rem;
	}

	.trending-table-row {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: subgrid;
		column-gap: inherit;
	}

	.trending-name {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	.row-top {
		border-bottom: 1px solid var(--border-subtle);
	}

	.row-data {
		border-bottom: 1px solid var(--divider-muted);
	}

	@media (min-width: 640px) {
		.trending-table {
			grid-template-columns: 28px minmax(0, 1fr) minmax(64px, auto) minmax(64px, auto) minmax(48px, auto) minmax(48px, auto);
			column-gap: 1rem;
		}

		.trending-table.generation-board {
			grid-template-columns: 28px minmax(0, 1fr) minmax(64px, auto) minmax(64px, auto) minmax(48px, auto);
		}

		.trending-name {
			display: block;
			-webkit-line-clamp: unset;
			line-clamp: unset;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.row-top,
		.row-data {
			animation-duration: 1ms !important;
			animation-delay: 0ms !important;
		}
	}
</style>
