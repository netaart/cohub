<script lang="ts">
import type { PublicAppVersionSummary } from "@neta-art/cohub";
import { History, Loader2, MessageSquare } from "lucide-svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { formatShortDateTime } from "#lib/resource-kit/time.ts";
import {
	buildSpaceSessionRoute,
	buildSpaceSessionTurnRoute,
} from "#lib/space-routes.ts";

type Props = {
	versions: PublicAppVersionSummary[];
	/** Home space of the app, used to deep link version source sessions. */
	spaceId: string;
	/** Displayed version; `null` means the current (latest) version. */
	selectedVersion: number | null;
	latestVersion: number;
	/** True while the selected version's content is loading. */
	loading?: boolean;
	onSelect: (version: number | null) => void;
};

let {
	versions,
	spaceId,
	selectedVersion,
	latestVersion,
	loading = false,
	onSelect,
}: Props = $props();

const locale = $derived(getLocale());
const displayedVersion = $derived(selectedVersion ?? latestVersion);
let open = $state(false);
let root = $state<HTMLDivElement | null>(null);

function select(version: number) {
	open = false;
	// Selecting the current version restores the canonical, parameter-free URL.
	onSelect(version === latestVersion ? null : version);
}

function handleWindowClick(event: MouseEvent) {
	if (!open) return;
	const target = event.target;
	if (root && target instanceof Node && root.contains(target)) return;
	open = false;
}

function sessionRoute(
	source: PublicAppVersionSummary["source"],
): string | null {
	// The server only includes a session the viewer may open.
	const session = source?.session;
	if (!session) return null;
	return source?.turnSequence !== undefined
		? buildSpaceSessionTurnRoute(spaceId, session.id, source.turnSequence)
		: buildSpaceSessionRoute(spaceId, session.id);
}
</script>

<svelte:window
	onclick={handleWindowClick}
	onkeydown={(event) => {
		if (event.key === "Escape") open = false;
	}}
/>

<div bind:this={root}>
	<button
		type="button"
		class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[5px] px-2 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-label="Versions"
		onclick={() => (open = !open)}
	>
		<History
			class="h-3.5 w-3.5 shrink-0 {loading ? 'hidden' : ''}"
			aria-hidden="true"
		/>
		<Loader2
			class="h-3.5 w-3.5 shrink-0 animate-spin {loading ? '' : 'hidden'}"
			aria-hidden="true"
		/>
		<span class="font-mono text-[11px] leading-none tabular-nums">v{displayedVersion}</span>
	</button>

	{#if open}
		<div
			class="absolute right-0 top-full left-0 z-[61] mt-2 w-auto overflow-hidden rounded-lg border border-border-subtle bg-bg-surface shadow-xl sm:left-auto sm:w-[340px]"
			role="dialog"
			aria-label="Versions"
		>
			<div class="flex items-center justify-between border-b border-border-subtle px-3 py-2">
				<span class="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Versions</span>
				<span class="font-mono text-[10px] text-text-placeholder">{versions.length}</span>
			</div>
			<div class="max-h-[min(60vh,420px)] overflow-y-auto py-1">
				{#each versions as version (version.id)}
					{@const sessionHref = sessionRoute(version.source)}
					{@const isActive = version.version === displayedVersion}
					<div class="flex items-center gap-1 px-2 py-1" class:bg-brand-muted={isActive}>
						<button
							type="button"
							class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[5px] px-1.5 py-1 text-left transition-colors hover:bg-bg-hover"
							onclick={() => select(version.version)}
						>
							<span class="w-8 shrink-0 font-mono text-[12px] {isActive ? 'text-brand' : 'text-text-secondary'}">v{version.version}</span>
							<span class="min-w-0 flex-1">
								{#if version.source?.via}
									<span class="block truncate text-[11px] text-text-placeholder">via {version.source.via}</span>
								{/if}
								<span class="block font-mono text-[10px] text-text-placeholder">{formatShortDateTime(version.createdAt, locale)}</span>
							</span>
						</button>
						{#if sessionHref && version.source?.session}
							<a
								href={sessionHref}
								target="_blank"
								rel="noopener noreferrer"
								class="flex max-w-[140px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
								title={version.source.session.title ?? version.source.session.id}
							>
								<MessageSquare class="h-3 w-3 shrink-0" aria-hidden="true" />
								<span class="truncate">{version.source.session.title || "Untitled session"}</span>
							</a>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
