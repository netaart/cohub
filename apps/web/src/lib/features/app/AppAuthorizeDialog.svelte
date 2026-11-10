<script lang="ts">
import type {
	AppAuthorizeRequest,
	AppAuthorizeSpaceOption,
	Permission,
	SpaceBootstrapSource,
	SpaceRecord,
} from "@neta-art/cohub";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	Search,
	ShieldCheck,
	UserPlus,
} from "lucide-svelte";
import { tick, untrack } from "svelte";
import Dialog from "$lib/components/Dialog.svelte";
import Spinner from "$lib/components/Spinner.svelte";
import { spaceRoleLabel } from "$lib/features/invitations/invitation-format";
import { spacesFilterLabel } from "$lib/features/spaces/spaces-views";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { APP_SCOPE_OPTIONS } from "$lib/resource-kit/app";
import { sdk } from "$lib/sdk";
import type { SpacePickerFilter } from "$lib/space-picker-model";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces } from "$lib/stores/recent-space";

const {
	open,
	pending,
	error,
	saving,
	appName,
	authorName,
	selectedSpaceId,
	canChangeSpace,
	onSelectSpace,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	pending: AppAuthorizeRequest | null;
	error: string | null;
	saving: boolean;
	appName?: string;
	authorName?: string;
	selectedSpaceId: string | null;
	canChangeSpace: boolean;
	onSelectSpace: (space: AppAuthorizeSpaceOption) => void;
	onConfirm: (pickedSpaceId?: string) => void;
	onCancel: () => void;
} = $props();

const locale = $derived(getLocale());

type Message = typeof m.app_auth_op_other;

type OperationGroup = {
	id: string;
	title: Message;
	description: Message;
	scopes: string[];
};

type OperationRow = {
	id: string;
	title: string;
	description: string;
	scopes: string[];
};

// Maps viewer scopes to user-facing operation groups shown in the consent
// dialog. Each group is shown only when at least one of its scopes is present
// in the requested set. Unmapped scopes fall back to a generic group.
const OPERATION_GROUPS: OperationGroup[] = [
	{
		id: "generation",
		title: m.app_auth_op_generation,
		description: m.app_auth_op_generation_desc,
		scopes: ["generation.create"],
	},
	{
		id: "prompt",
		title: m.app_auth_op_prompt,
		description: m.app_auth_op_prompt_desc,
		scopes: ["session.prompt.fullaccess"],
	},
	{
		id: "read",
		title: m.app_auth_op_read,
		description: m.app_auth_op_read_desc,
		scopes: [
			"session.prompt.readonly",
			"session.view",
			"file.view",
			"taskrun.view",
		],
	},
	{
		id: "account",
		title: m.app_auth_op_account,
		description: m.app_auth_op_account_desc,
		scopes: [
			"user.session.list",
			"user.space.list",
			"user.taskrun.list",
			"user.usage.read",
			"user.app.list",
			"user.cronjob.list",
		],
	},
	{
		id: "create-space",
		title: m.app_auth_op_create_space,
		description: m.app_auth_op_create_space_desc,
		scopes: ["space.create"],
	},
];

const operationGroups = $derived.by(() => {
	if (!pending) return [];
	const requested = new Set(pending.scopes);
	const groups: OperationRow[] = OPERATION_GROUPS.filter((g) =>
		g.scopes.some((s) => requested.has(s as Permission)),
	).map((g) => ({
		id: g.id,
		title: g.title({}, { locale }),
		description: g.description({}, { locale }),
		scopes: g.scopes,
	}));
	// Surface any scopes not covered by the predefined groups.
	const mapped = new Set(groups.flatMap((g) => g.scopes));
	const unmapped = pending.scopes.filter((s) => !mapped.has(s));
	if (unmapped.length > 0) {
		groups.push({
			id: "other",
			title: m.app_auth_op_other({}, { locale }),
			description: unmapped.map(scopeLabel).join(", "),
			scopes: unmapped,
		});
	}
	return groups;
});

const displayName = $derived(
	appName?.trim() || m.app_auth_this_app({}, { locale }),
);

/** Initial rows rendered; scrolling reveals the next pages. */
const SPACE_PICKER_INITIAL = 8;
/** Rows added per scroll page. */
const SPACE_PICKER_PAGE = 20;
const SPACE_SEARCH_PAGE = 50;
const SPACE_SEARCH_DEBOUNCE_MS = 200;

type SpaceSearch = {
	filter: SpacePickerFilter;
	query: string;
	items: AppAuthorizeSpaceOption[];
	cursor: string | null;
	hasMore: boolean;
	failed: boolean;
};

// Picker selection is owned by the host bridge core; this dialog only renders
// it. Picker step resets whenever a new request opens the dialog, and a single
// accessible Space needs no choice.
let spaceQuery = $state("");
const SPACE_PICKER_FILTERS: SpacePickerFilter[] = [
	"recent",
	"all",
	"mine",
	"pinned",
];
let spaceFilter = $state<SpacePickerFilter>("recent");
let pickerStep = $state<"choose" | "review">("review");
let spaceDisplayLimit = $state(SPACE_PICKER_INITIAL);
let spaceListEl = $state<HTMLDivElement | null>(null);
/** Coalesces a scroll burst into at most one page reveal per frame. */
let spaceLoadFrame: number | null = null;
$effect(() => {
	const spaces = pending?.spaces ?? null;
	spaceQuery = "";
	spaceFilter = "recent";
	spaceSearch = null;
	pickerStep =
		pending?.selectSpace && spaces?.length !== 1 ? "choose" : "review";
	// A fresh request must not inherit a page reveal queued for the old one.
	cancelSpaceLoad();
});

const picking = $derived(pickerStep === "choose");
const spaceOptions = $derived(pending?.spaces ?? null);
function handleSpaceQueryInput(event: Event) {
	spaceQuery = (event.currentTarget as HTMLInputElement).value;
	if (spaceQuery.trim()) spaceFilter = "all";
}

// "Recent" shows the bridge's preloaded page; other filters and queries search the server.
const trimmedSpaceQuery = $derived(spaceQuery.trim());
const searching = $derived(
	spaceFilter !== "recent" || Boolean(trimmedSpaceQuery),
);
let spaceSearch = $state.raw<SpaceSearch | null>(null);
const isCurrentSearch = (search: SpaceSearch | null) =>
	search?.filter === spaceFilter && search.query === trimmedSpaceQuery;
const searchSettled = $derived(!searching || isCurrentSearch(spaceSearch));
const searchScope = $derived(
	spaceSearch ? `${spaceSearch.filter}\u0000${spaceSearch.query}` : null,
);

const toSpaceOption = (space: SpaceRecord): AppAuthorizeSpaceOption => ({
	id: space.id,
	name: space.name || null,
	ownerUserUuid: space.userUuid,
	isPinned: space.isPinned,
});

async function searchSpaces(
	filter: SpacePickerFilter,
	query: string,
	previous: SpaceSearch | null = null,
): Promise<SpaceSearch> {
	const page = await sdk.spaces.list({
		limit: SPACE_SEARCH_PAGE,
		cursor: previous?.cursor ?? null,
		filter,
		query,
		recentSpaces: getRecentSpaces(authStore.userUuid ?? "").map((entry) => ({
			id: entry.spaceId,
			timestamp: entry.timestamp,
		})),
	});
	const known = new Set(previous?.items.map((space) => space.id));
	return {
		filter,
		query,
		items: [
			...(previous?.items ?? []),
			...page.items.map(toSpaceOption).filter((space) => !known.has(space.id)),
		],
		cursor: page.pageInfo.nextCursor,
		hasMore: page.pageInfo.hasMore,
		failed: false,
	};
}

$effect(() => {
	if (!picking || !searching) return;
	const filter = spaceFilter;
	const query = trimmedSpaceQuery;
	let stale = false;
	const land = (search: SpaceSearch) => {
		if (!stale && isCurrentSearch(search)) spaceSearch = search;
	};
	const timer = setTimeout(
		() => {
			searchSpaces(filter, query).then(land, () =>
				land({
					filter,
					query,
					items: [],
					cursor: null,
					hasMore: false,
					failed: true,
				}),
			);
		},
		query ? SPACE_SEARCH_DEBOUNCE_MS : 0,
	);
	return () => {
		stale = true;
		clearTimeout(timer);
	};
});

let loadingMoreSpaces = false;
async function loadMoreSearchResults() {
	const current = spaceSearch;
	if (loadingMoreSpaces || !current?.hasMore || !isCurrentSearch(current))
		return;
	loadingMoreSpaces = true;
	try {
		const next = await searchSpaces(current.filter, current.query, current);
		if (spaceSearch !== current) return;
		spaceSearch = next;
		loadMoreSpaces();
	} catch {
		// Retried on the next scroll.
	} finally {
		loadingMoreSpaces = false;
	}
}

// Full ordered match set; the template windows it so the DOM stays bounded
// even when the viewer has hundreds of Spaces.
const spaceMatches = $derived(
	searching ? (spaceSearch?.items ?? []) : (spaceOptions ?? []),
);
const visibleSpaceOptions = $derived(spaceMatches.slice(0, spaceDisplayLimit));
const spaceMoreCount = $derived(
	Math.max(0, spaceMatches.length - spaceDisplayLimit),
);

/** Drops a queued page reveal, e.g. when the window is about to reset. */
function cancelSpaceLoad() {
	if (spaceLoadFrame !== null) {
		cancelAnimationFrame(spaceLoadFrame);
		spaceLoadFrame = null;
	}
}
$effect(() => () => cancelSpaceLoad());

// Reveals the next page only after the current one has been painted, so a burst
// of inertial scroll events cannot flush the entire window in a single frame.
function requestMoreSpaces() {
	if (spaceLoadFrame !== null) return;
	spaceLoadFrame = requestAnimationFrame(() => {
		spaceLoadFrame = null;
		loadMoreSpaces();
	});
}

function loadMoreSpaces() {
	spaceDisplayLimit = Math.min(
		spaceDisplayLimit + SPACE_PICKER_PAGE,
		spaceMatches.length,
	);
}

function handleSpaceListScroll(event: Event) {
	const el = event.currentTarget as HTMLElement | null;
	// Ignore the programmatic reset scroll (scrollTop = 0).
	if (!el || el.scrollTop <= 0) return;
	if (el.scrollTop + el.clientHeight < el.scrollHeight - 64) return;
	if (spaceMoreCount > 0) requestMoreSpaces();
	else if (searching) void loadMoreSearchResults();
}

function scrollSelectedIntoView() {
	const list = spaceListEl;
	const option = list?.querySelector<HTMLElement>(
		".auth-space-option.selected",
	);
	if (!list || !option) return;
	// Adjust the list's own scrollTop so revealing a row never moves the dialog.
	const listRect = list.getBoundingClientRect();
	const optionRect = option.getBoundingClientRect();
	if (optionRect.top < listRect.top) {
		list.scrollTop -= listRect.top - optionRect.top;
	} else if (optionRect.bottom > listRect.bottom) {
		list.scrollTop += optionRect.bottom - listRect.bottom;
	}
}

/**
 * Single reset path for a new match scope (new request / filter / query):
 * drops queued loads, restarts the window, and reveals the preselected Space
 * when it is part of the new match set.
 */
function resetSpaceWindow(matches: readonly { id: string }[]) {
	cancelSpaceLoad();
	spaceDisplayLimit = SPACE_PICKER_INITIAL;
	if (spaceListEl) spaceListEl.scrollTop = 0;
	const spaceId = selectedSpaceId;
	const index = matches.findIndex((space) => space.id === spaceId);
	if (index < 0) return;
	const needed = index + 1;
	if (needed > spaceDisplayLimit) {
		// Grow on the same `INITIAL + n * PAGE` curve as the scroll reveals.
		spaceDisplayLimit = Math.min(
			matches.length,
			SPACE_PICKER_INITIAL +
				Math.ceil((needed - SPACE_PICKER_INITIAL) / SPACE_PICKER_PAGE) *
					SPACE_PICKER_PAGE,
		);
		void tick().then(scrollSelectedIntoView);
	} else {
		scrollSelectedIntoView();
	}
}

// Resets on a new scope, never on scroll or an appended page.
$effect(() => {
	if (!picking) return;
	void (searching ? searchScope : spaceOptions);
	untrack(() => resetSpaceWindow(spaceMatches));
});

const spaceEmptyCopy = $derived.by(() => {
	if (!searchSettled) return null;
	if (searching && spaceSearch?.failed)
		return m.spaces_load_failed({}, { locale });
	if (spaceQuery.trim()) return m.spaces_empty_search({}, { locale });
	if (spaceFilter === "pinned") return m.spaces_empty_pinned({}, { locale });
	if (spaceFilter === "mine") return m.spaces_empty_mine({}, { locale });
	if (spaceFilter === "recent") return m.app_auth_empty_recent({}, { locale });
	return m.spaces_empty_title({}, { locale });
});
const spaceLabel = $derived.by(() => {
	if (!pending || pending.createSpace) return null;
	if (pending.spaceId) return pending.spaceName?.trim() || pending.spaceId;
	if (pending.selectSpace) return null;
	return pending.homeSpaceName?.trim() || null;
});
// The Space shown in the dialog: the viewer's pick wins, then the request's
// explicit target, then the implicit home Space.
const displaySpaceName = $derived.by(() => {
	const id = selectedSpaceId || pending?.spaceId || "";
	if (!id) return spaceLabel;
	const fromList = [...(pending?.spaces ?? []), ...(spaceSearch?.items ?? [])]
		.find((space) => space.id === id)
		?.name?.trim();
	if (fromList) return fromList;
	if (id === pending?.spaceId) return pending?.spaceName?.trim() || id;
	return id;
});
const createSpaceName = $derived(pending?.createSpace?.name?.trim() || null);
const createSpaceSource = $derived.by(() =>
	createSpaceSourceLabel(pending?.createSpace?.bootstrapSource),
);
const requiresGenerationQuota = $derived(
	Boolean(pending?.scopes.includes("generation.create")),
);
const join = $derived(pending?.join ?? null);
const confirmLabel = $derived(
	join
		? m.app_auth_join_confirm({}, { locale })
		: pending?.createSpace
			? m.app_auth_confirm_create({}, { locale })
			: m.app_auth_confirm({}, { locale }),
);
const confirmDisabled = $derived(
	saving || (pending?.spaces !== undefined && !selectedSpaceId),
);

function createSpaceSourceLabel(
	source: SpaceBootstrapSource | undefined,
): string | null {
	if (!source || source.type === "blank") return null;
	if (source.type === "checkpoint")
		return m.app_auth_source_checkpoint({}, { locale });
	if (source.type === "git_repo") {
		try {
			const url = new URL(source.repoUrl);
			return m.app_auth_source_repo(
				{ repo: `${url.host}${url.pathname}` },
				{ locale },
			);
		} catch {
			return m.app_auth_source_git({}, { locale });
		}
	}
	return null;
}

// Human label for scopes outside the predefined operation groups.
const scopeLabel = (scope: string) =>
	APP_SCOPE_OPTIONS.find((option) => option.scope === scope)?.label(
		{},
		{ locale },
	) ?? scope;
</script>

<Dialog {open} onClose={onCancel} maxWidth="440px" maxHeight="90vh">
	{#if pending}
		<div class="auth-panel" class:auth-review={!picking}>
			<div class="auth-intro">
				<div class="auth-icon">{#if join}<UserPlus class="h-4 w-4" />{:else}<ShieldCheck class="h-4 w-4" />{/if}</div>
				<div class="min-w-0">
					<div class="auth-title">{join ? m.app_auth_join_title({}, { locale }) : m.app_auth_title({}, { locale })}</div>
					<p class="auth-copy">{join ? m.app_auth_join_request({ app: displayName }, { locale }) : m.app_auth_request({ app: displayName }, { locale })}</p>
					{#if authorName}
						<p class="auth-author">{m.app_auth_author({ name: authorName }, { locale })}</p>
					{/if}
					{#if pending.reason}
						<p class="auth-reason">{pending.reason}</p>
					{/if}
				</div>
			</div>

			<hr class="auth-divider" />

			{#if picking}
				<section class="auth-section auth-picker-step">
					<div class="auth-step-heading">
						<div>
							<div class="auth-section-label">{m.app_auth_choose_space({}, { locale })}</div>
							<div class="auth-step-copy">{m.app_auth_choose_space_hint({}, { locale })}</div>
						</div>
					</div>
					{#if spaceOptions === null}
						<div class="auth-space-empty">{m.app_auth_spaces_load_failed({}, { locale })}</div>
					{:else if spaceOptions.length === 0}
						<div class="auth-space-empty">{m.app_auth_space_prepare_failed({}, { locale })}</div>
					{:else}
						<label class="auth-space-search">
							<Search class="h-3.5 w-3.5" />
							<input value={spaceQuery} oninput={handleSpaceQueryInput} placeholder={m.spaces_search_placeholder({}, { locale })} aria-label={m.spaces_search_placeholder({}, { locale })} />
						</label>
						<div class="auth-space-filters" role="group" aria-label={m.app_auth_filter_spaces({}, { locale })}>
							{#each SPACE_PICKER_FILTERS as filter (filter)}
								<button type="button" class:active={spaceFilter === filter} aria-pressed={spaceFilter === filter} onclick={() => (spaceFilter = filter)}>{spacesFilterLabel(filter, locale)}</button>
							{/each}
						</div>
						<div class="auth-space-list" class:auth-space-list-pending={!searchSettled} role="radiogroup" aria-label={m.app_auth_choose_space({}, { locale })} aria-busy={!searchSettled} bind:this={spaceListEl} onscroll={handleSpaceListScroll}>
							{#each visibleSpaceOptions as space (space.id)}
								<label class="auth-space-option" class:selected={selectedSpaceId === space.id}>
									<input type="radio" name="auth-space" checked={selectedSpaceId === space.id} onchange={() => onSelectSpace(space)} />
									<span class="auth-space-option-name">{space.name || space.id}</span>
								</label>
							{/each}
							{#if visibleSpaceOptions.length === 0 && spaceEmptyCopy}
								<div class="auth-space-empty-list">{spaceEmptyCopy}</div>
							{/if}
						</div>
					{/if}
					<div class="auth-picker-actions">
						<button type="button" class="auth-cancel" disabled={saving} onclick={onCancel}>{m.app_auth_deny({}, { locale })}</button>
						<button type="button" class="auth-confirm primary-key" disabled={saving || !selectedSpaceId} onclick={() => (pickerStep = "review")}>{m.app_auth_review({}, { locale })}</button>
					</div>
				</section>
			{:else}
				{#if join}
					<section class="auth-space">
						<div class="auth-space-label">{m.app_auth_space({}, { locale })}</div>
						<div class="auth-space-name" title={join.spaceName}>{join.spaceName}</div>
						<div class="auth-space-source">{m.app_auth_join_as({ role: spaceRoleLabel(join.role, locale) }, { locale })} · {m.app_auth_join_invited_by({ name: join.inviter.displayName }, { locale })}</div>
					</section>
				{:else if pending.createSpace && createSpaceName}
					<section class="auth-space">
						<div class="auth-space-label">{m.app_auth_new_space({}, { locale })}</div>
						<div class="auth-space-name" title={createSpaceName}>{createSpaceName}</div>
						{#if createSpaceSource}
							<div class="auth-space-source">{createSpaceSource}</div>
						{/if}
						<div class="auth-space-note">{m.app_auth_space_owner_note({}, { locale })}</div>
					</section>
				{:else if !selectedSpaceId && (pending.spaces === null || pending.spaces?.length === 0)}
					<section class="auth-space">
						<div class="auth-space-label">{m.app_auth_space({}, { locale })}</div>
						<div class="auth-space-empty">{m.app_auth_spaces_retry({}, { locale })}</div>
					</section>
				{:else if pending.selectSpace || selectedSpaceId || spaceLabel}
					<section class="auth-space auth-selected-space">
						<div class="auth-space-label">{m.app_auth_space({}, { locale })}</div>
						<div class="auth-selected-row">
							<div class="auth-space-name" title={selectedSpaceId || undefined}>{displaySpaceName}</div>
							{#if canChangeSpace}
								<button type="button" class="auth-change-space" onclick={() => (pickerStep = "choose")}><ArrowLeft class="h-3 w-3" /> {m.common_change({}, { locale })}</button>
							{/if}
						</div>
					</section>
				{/if}
			{/if}

			{#if !picking}
			{#if operationGroups.length > 0}
			<section class="auth-section">
				<div class="auth-section-label">{m.app_auth_once_authorized({}, { locale })}</div>
				<div class="auth-scope-list">
					{#each operationGroups as group (group.id)}
						<div class="auth-scope-row">
							<div class="auth-scope-check"><Check class="h-3 w-3" /></div>
							<div class="min-w-0">
								<div class="auth-scope-name">{group.title}</div>
								<div class="auth-scope-description">{group.description}</div>
							</div>
						</div>
					{/each}
				</div>
			</section>
			{/if}

			{#if requiresGenerationQuota}
				<section class="auth-usage">
					<div class="auth-usage-label">{m.app_auth_about_usage({}, { locale })}</div>
					<p class="auth-usage-copy">{m.app_auth_usage_copy({}, { locale })}</p>
				</section>
			{/if}

			<hr class="auth-divider" />

			<div class="auth-validity">
				{join
					? pending.scopes.length > 0
						? m.app_auth_join_validity_scopes({}, { locale })
						: m.app_auth_join_validity({}, { locale })
					: pending.createSpace
						? m.app_auth_validity_create({}, { locale })
						: m.app_auth_validity({}, { locale })}
			</div>

			{#if error}
				<div class="auth-error"><AlertTriangle class="h-3.5 w-3.5" /> {error}</div>
			{/if}

				<div class="auth-actions">
					<button type="button" class="auth-cancel" disabled={saving} onclick={onCancel}>{join ? m.common_cancel({}, { locale }) : m.app_auth_deny({}, { locale })}</button>
					<button type="button" class="auth-confirm primary-key" disabled={confirmDisabled} onclick={() => onConfirm(selectedSpaceId || undefined)}>
						{#if saving}<Spinner class="h-3.5 w-3.5" />{/if}
						{confirmLabel}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</Dialog>

<style>
	.auth-panel {
		display: grid;
		gap: 16px;
		padding: 18px;
	}

	.auth-panel.auth-review {
		gap: 12px;
		padding: 16px;
	}

	.auth-intro {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr);
		gap: 12px;
		align-items: flex-start;
	}

	.auth-icon {
		display: inline-flex;
		width: 34px;
		height: 34px;
		align-items: center;
		justify-content: center;
		border-radius: 9px;
		background: var(--brand-muted);
		color: var(--brand-muted-fg);
		border: 1px solid var(--brand-border);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bg-elevated) 80%, transparent);
	}

	.auth-title {
		font-size: 15px;
		font-weight: 650;
		line-height: 1.25;
		letter-spacing: -0.01em;
		color: var(--text-primary);
	}

	.auth-copy {
		margin-top: 6px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.auth-author {
		margin-top: 3px;
		font-size: 12px;
		line-height: 1.4;
		color: var(--text-tertiary);
	}

	.auth-reason {
		margin-top: 6px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-tertiary);
	}

	.auth-space-empty {
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
		padding: 12px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-tertiary);
	}

	.auth-space-list {
		display: grid;
		max-height: min(40vh, 300px);
		overflow: hidden auto;
		overscroll-behavior: contain;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
		transition: opacity 150ms ease;
	}

	.auth-space-list-pending {
		opacity: 0.6;
	}

	.auth-space-empty-list {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 18px 12px;
		font-size: 12px;
		line-height: 1.4;
		text-align: center;
		color: var(--text-tertiary);
	}

	.auth-space-option {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 10px 12px;
		font-size: 12.5px;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.auth-space-option + .auth-space-option {
		border-top: 1px solid var(--border-subtle);
	}

	.auth-space-option:hover,
	.auth-space-option.selected {
		background: var(--bg-hover);
	}

	.auth-space-search {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		padding: 0 10px;
		color: var(--text-tertiary);
	}

	.auth-space-search:focus-within {
		border-color: var(--brand-border);
		box-shadow: 0 0 0 2px var(--brand-ring);
	}

	.auth-space-search input {
		width: 100%;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		font: inherit;
		font-size: 12px;
		color: var(--text-primary);
	}

	.auth-space-search input::placeholder {
		color: var(--text-placeholder);
	}

	.auth-space-filters {
		display: flex;
		gap: 2px;
		overflow-x: auto;
		padding: 2px;
		border-radius: 7px;
		background: var(--bg-elevated);
	}

	.auth-space-filters button {
		min-height: 28px;
		flex: 1 0 auto;
		border: 0;
		border-radius: 5px;
		background: transparent;
		padding: 3px 9px;
		font-size: 11px;
		color: var(--text-tertiary);
		cursor: pointer;
	}

	.auth-space-filters button:hover,
	.auth-space-filters button.active {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.auth-space-filters button.active {
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}

	.auth-step-copy {
		margin-top: 3px;
		font-size: 11px;
		color: var(--text-tertiary);
	}

	.auth-picker-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding-top: 2px;
	}

	.auth-selected-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.auth-change-space {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: 0 0 auto;
		border: 0;
		background: transparent;
		padding: 2px 0;
		font-size: 11px;
		color: var(--text-tertiary);
		cursor: pointer;
	}

	.auth-change-space:hover {
		color: var(--brand);
	}

	.auth-space-option input {
		flex: 0 0 auto;
		margin: 0;
	}

	.auth-space-option-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.auth-divider {
		border: 0;
		border-top: 1px solid var(--border-subtle);
		margin: 0;
	}

	.auth-section {
		display: grid;
		gap: 9px;
	}

	.auth-section-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.auth-scope-list {
		display: grid;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
	}

	.auth-scope-row {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr);
		gap: 10px;
		padding: 10px;
		background: var(--bg-elevated);
	}

	.auth-scope-row + .auth-scope-row {
		border-top: 1px solid var(--border-subtle);
	}

	.auth-scope-check {
		display: inline-flex;
		width: 18px;
		height: 18px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		flex: 0 0 auto;
		margin-top: 1px;
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 24%, transparent);
	}

	.auth-scope-name {
		font-size: 12.5px;
		font-weight: 650;
		line-height: 1.25;
		color: var(--text-primary);
	}

	.auth-scope-description {
		margin-top: 2px;
		font-size: 11.5px;
		line-height: 1.35;
		color: var(--text-secondary);
	}

	.auth-space {
		display: grid;
		gap: 4px;
		padding: 12px;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
	}

	.auth-space-label {
		font-size: 11px;
		font-weight: 650;
		line-height: 1.2;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}

	.auth-space-name {
		font-size: 13px;
		font-weight: 550;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.auth-space-source,
	.auth-space-note {
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--text-tertiary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.auth-usage {
		display: grid;
		gap: 4px;
	}

	.auth-usage-label {
		font-size: 12px;
		font-weight: 650;
		color: var(--text-primary);
	}

	.auth-usage-copy {
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--text-secondary);
	}

	.auth-validity {
		font-size: 12px;
		line-height: 1.4;
		color: var(--text-tertiary);
	}

	.auth-error {
		display: flex;
		align-items: center;
		gap: 7px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--color-error-soft) 28%, transparent);
		background: var(--color-error-bg);
		padding: 9px 10px;
		font-size: 12px;
		line-height: 1.35;
		color: var(--color-error-soft);
	}

	.auth-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding-top: 2px;
	}

	.auth-cancel,
	.auth-confirm {
		display: inline-flex;
		height: 34px;
		min-width: 72px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-radius: 7px;
		padding: 0 13px;
		font-size: 12.5px;
		font-weight: 650;
		line-height: 1;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			transform 0.15s ease,
			opacity 0.15s ease;
	}

	.auth-cancel {
		border: 1px solid transparent;
		color: var(--text-secondary);
	}

	.auth-cancel:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.auth-cancel:focus-visible,
	.auth-confirm:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--brand-ring);
	}

	.auth-cancel:active,
	.auth-confirm:active {
		transform: translateY(1px);
	}

	.auth-cancel:disabled,
	.auth-confirm:disabled {
		pointer-events: none;
		opacity: 0.55;
		transform: none;
	}

	@media (max-width: 640px) {
		.auth-panel {
			gap: 14px;
			padding: 14px 14px max(14px, env(safe-area-inset-bottom));
		}

		.auth-intro {
			grid-template-columns: 32px minmax(0, 1fr);
			gap: 11px;
		}

		.auth-icon {
			width: 32px;
			height: 32px;
		}

		.auth-title {
			font-size: 14.5px;
		}

		.auth-copy {
			font-size: 13px;
			line-height: 1.5;
		}

		.auth-scope-row {
			padding: 11px;
		}

		.auth-space-search {
			min-height: 40px;
		}

		.auth-space-filters {
			gap: 4px;
		}

		.auth-space-filters button {
			min-height: 36px;
		}

		.auth-space-option {
			padding: 11px 12px;
		}

		.auth-actions {
			position: sticky;
			bottom: calc(-1 * max(14px, env(safe-area-inset-bottom)));
			display: grid;
			grid-template-columns: 1fr 1fr;
			margin: 0 -14px calc(-1 * max(14px, env(safe-area-inset-bottom)));
			padding: 10px 14px max(14px, env(safe-area-inset-bottom));
			border-top: 1px solid var(--border-subtle);
			background: var(--bg-primary);
		}

		.auth-cancel,
		.auth-confirm {
			height: 44px;
			min-width: 0;
		}
	}
</style>
