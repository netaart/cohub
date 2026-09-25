<script lang="ts">
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import GenerationGrid from "./GenerationGrid.svelte";
import type { GenerationFeed } from "./generation-feed.svelte";
import LoadError from "./LoadError.svelte";
import LoadMoreButton from "./LoadMoreButton.svelte";
import SessionFileList from "./SessionFileList.svelte";
import SidePanelSection from "./SidePanelSection.svelte";
import type { SessionFilesFeed } from "./session-files.svelte";

type Props = {
	hasSession: boolean;
	generations: GenerationFeed | null;
	files: SessionFilesFeed | null;
	draggable: boolean;
	touchDraggable: boolean;
	onOpenTask: (taskRunId: string) => void;
	onOpenFile: (path: string) => void;
	onShowInFiles: (path: string) => void;
	onInsertReference?: (path: string) => void;
	onJumpToTurn?: (sequence: number) => void;
};

const {
	hasSession,
	generations,
	files,
	draggable,
	touchDraggable,
	onOpenTask,
	onOpenFile,
	onShowInFiles,
	onInsertReference,
	onJumpToTurn,
}: Props = $props();

const SECTIONS_KEY = "cohub:side-panel:session-sections:v1";
type SectionId = "media" | "files";

function readCollapsed(): Record<SectionId, boolean> {
	try {
		const value = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}");
		return { media: value?.media === true, files: value?.files === true };
	} catch {
		return { media: false, files: false };
	}
}

const locale = $derived(getLocale());
let collapsed = $state(readCollapsed());

function toggle(section: SectionId) {
	collapsed = { ...collapsed, [section]: !collapsed[section] };
	try {
		localStorage.setItem(SECTIONS_KEY, JSON.stringify(collapsed));
	} catch {}
}

const tasks = $derived(generations?.tasks ?? []);
const fileEntries = $derived(files?.files ?? []);
const activeGenerations = $derived(generations?.activeCount ?? 0);
const mediaCount = $derived(
	tasks.reduce(
		(count, task) =>
			count + (task.status === "completed" ? task.outputs.length : 1),
		0,
	),
);
const ready = $derived((generations?.ready ?? true) && (files?.ready ?? true));
const mediaFailed = $derived(
	tasks.length === 0 && Boolean(generations?.failed),
);
const filesFailed = $derived(
	fileEntries.length === 0 && Boolean(files?.failed),
);
const showMedia = $derived(tasks.length > 0 || mediaFailed);
const showFiles = $derived(fileEntries.length > 0 || filesFailed);
</script>

<div class="h-full min-h-0 overflow-y-auto px-1.5 pb-3 pt-1" data-pointer-drag-autoscroll>
	{#if !hasSession}
		<p class="empty-note">{m.session_outputs_no_chat({}, { locale })}</p>
	{:else if !ready}
		<div class="grid grid-cols-3 gap-1 px-1.5 pt-2" aria-hidden="true">
			{#each [1, 2, 3] as item (item)}
				<div class="aspect-square animate-pulse rounded-[6px] bg-bg-elevated"></div>
			{/each}
		</div>
	{:else if !showMedia && !showFiles}
		<p class="empty-note">{m.session_outputs_empty({}, { locale })}</p>
	{:else}
		{#if showMedia}
			<SidePanelSection
				title={m.session_outputs_media({}, { locale })}
				count={generations?.pageInfo.hasMore ? `${mediaCount}+` : mediaCount}
				collapsed={collapsed.media}
				onToggle={() => toggle("media")}
			>
				{#snippet meta()}
					{#if activeGenerations > 0}
						<span class="inline-flex items-center gap-1.5 text-[10px] text-text-tertiary">
							<span class="h-1.5 w-1.5 rounded-full bg-brand"></span>
							{m.generation_active_count({ count: activeGenerations }, { locale })}
						</span>
					{/if}
				{/snippet}
				<div class="px-1.5 pb-2">
					{#if mediaFailed && generations}
						<LoadError message={m.generation_load_failed({}, { locale })} onRetry={() => void generations.refresh()} />
					{/if}
					<GenerationGrid
						{tasks}
						{draggable}
						resolveRun={(id) => generations?.run(id)}
						{onOpenTask}
					/>
					{#if generations}
						<LoadMoreButton feed={generations} />
					{/if}
				</div>
			</SidePanelSection>
		{/if}
		{#if showFiles}
			<SidePanelSection
				title={m.session_outputs_files({}, { locale })}
				count={fileEntries.length}
				collapsed={collapsed.files}
				onToggle={() => toggle("files")}
			>
				{#if filesFailed && files}
					<div class="px-1.5">
						<LoadError message={m.session_files_load_failed({}, { locale })} onRetry={() => void files.refresh()} />
					</div>
				{/if}
				<SessionFileList
					files={fileEntries}
					{draggable}
					{touchDraggable}
					{onOpenFile}
					{onShowInFiles}
					{onInsertReference}
					{onJumpToTurn}
				/>
			</SidePanelSection>
		{/if}
	{/if}
</div>

<style>
	.empty-note {
		margin: 12px 8px 0;
		font-size: 12px;
		line-height: 18px;
		color: var(--text-tertiary);
	}
</style>
