<script lang="ts">
import {
	BOARD_EXPORT_MAX_EDGE,
	type BoardDocument,
	type BoardExportRegion,
	buildBoardScene,
	createBoardAnimationSampler,
	planBoardExport,
} from "@neta-art/cohub/board";
import {
	type BoardRenderDiagnostic,
	inspectBoardScene,
} from "@neta-art/cohub/board/render";
import { Check, Copy, Download, Loader2 } from "lucide-svelte";
import {
	type BoardImageExportWarning,
	type BoardImageFormat,
	type BoardStageExportBridge,
	boardExportFilename,
	copyImageToClipboard,
	exportBoardImage,
} from "$lib/board/board-image-export";
import type { BoardVideoExportRequest } from "$lib/board/board-video-export.svelte";
import Dialog from "$lib/components/Dialog.svelte";
import Spinner from "$lib/components/Spinner.svelte";
import { saveFile } from "$lib/downloads.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	open,
	onClose,
	document: boardDocument,
	bridge,
	title,
	selection,
	onLocate,
	onExportVideo,
	inputs = null,
}: {
	open: boolean;
	onClose: () => void;
	document: BoardDocument;
	bridge: BoardStageExportBridge | null;
	title: string | null;
	selection: string[];
	onLocate?: (id: string) => void;
	onExportVideo?: (request: BoardVideoExportRequest) => void;
	inputs?: string | null;
} = $props();
let replayInputs = $state(true);

const locale = $derived(getLocale());

type Scope = "all" | "selection" | "frame" | "camera";

const SCALES = [1, 2, 3, 4] as const;
const FORMATS: Array<{ id: BoardImageFormat; label: string }> = [
	{ id: "png", label: "PNG" },
	{ id: "jpeg", label: "JPEG" },
	{ id: "webp", label: "WebP" },
];

let scope = $state<Scope>("all");
let frameId = $state<string | null>(null);
let scale = $state<number>(2);
let format = $state<BoardImageFormat | "mp4">("png");
let transparent = $state(false);
let busy = $state<"download" | "copy" | null>(null);
let copied = $state(false);
let failure = $state<string | null>(null);
let warnings = $state<BoardImageExportWarning[]>([]);
let animationId = $state("");
let seconds = $state(0);
let viewport = $state("1600x900");
let hints = $state<BoardRenderDiagnostic[] | null>(null);
const animationIds = $derived(Object.keys(boardDocument.animations));
const cameraSize = $derived.by(() => {
	const [width = 1600, height = 900] = viewport.split("x").map(Number);
	return { width, height };
});
const scene = $derived(open ? buildBoardScene(boardDocument) : null);
const sampler = $derived(
	open && animationId && boardDocument.animations[animationId]
		? createBoardAnimationSampler(boardDocument, animationId)
		: null,
);
const sampledScene = $derived(
	sampler ? sampler.at(Math.max(0, seconds || 0) * 1000).scene : scene,
);

function inspect() {
	hints = sampledScene ? inspectBoardScene(sampledScene) : [];
}
function hintLabel(hint: BoardRenderDiagnostic) {
	if (hint.code === "text-clipped")
		return m.board_issue_clipped({}, { locale });
	if (hint.code === "text-overlap")
		return m.board_issue_overlap({}, { locale });
	if (hint.code === "glyph-unavailable")
		return m.board_issue_glyph(
			{ characters: hint.characters ?? "" },
			{ locale },
		);
	return m.board_issue_follow({}, { locale });
}
$effect(() => {
	boardDocument;
	seconds;
	animationId;
	hints = null;
});

const frames = $derived(
	scene
		? scene.items
				.filter((item) => item.type === "frame")
				.map((item) => ({
					id: item.id,
					label: (item.props as { label: string }).label,
				}))
		: [],
);
const hasSelection = $derived(selection.length > 0);

$effect(() => {
	if (!open) return;
	failure = null;
	warnings = [];
	copied = false;
	busy = null;
	scope = hasSelection ? "selection" : "all";
	if (!frameId && frames.length > 0) frameId = frames[0]?.id ?? null;
});

const region = $derived.by<BoardExportRegion>(() => {
	if (scope === "selection" && hasSelection)
		return { kind: "items", ids: selection };
	if (scope === "frame" && frameId) return { kind: "frame", id: frameId };
	return { kind: "all" };
});

const plan = $derived.by(() =>
	sampledScene ? planBoardExport({ scene: sampledScene, region, scale }) : null,
);
const sizeLabel = $derived(
	scope === "camera"
		? `${cameraSize.width} × ${cameraSize.height} px`
		: plan
			? `${plan.width} × ${plan.height} px`
			: m.board_nothing_export({}, { locale }),
);
const clamped = $derived(Boolean(plan?.clamped));

const video = $derived(format === "mp4");
const animation = $derived(
	animationId ? boardDocument.animations[animationId] : undefined,
);
const transparencySupported = $derived(format !== "jpeg" && !video);

$effect(() => {
	if (video && !(sampler && onExportVideo)) format = "png";
});

function warningText(warning: BoardImageExportWarning) {
	switch (warning.kind) {
		case "scale-clamped":
			return m.board_export_warning_scale_clamped(
				{
					requested: warning.requested,
					applied: warning.applied.toFixed(2),
				},
				{ locale },
			);
		case "images-missing":
			return warning.keys.length === 1
				? m.board_export_warning_images_missing_one({}, { locale })
				: m.board_export_warning_images_missing_many(
						{ count: warning.keys.length },
						{ locale },
					);
		case "many-items":
			return m.board_export_warning_many_items(
				{ count: warning.count },
				{ locale },
			);
		case "background-missing":
			return m.board_export_warning_background_missing({}, { locale });
		case "previews-omitted":
			return m.board_export_warning_previews_omitted(
				{ count: warning.count },
				{ locale },
			);
		case "shaders-unsupported":
			return m.board_export_warning_shaders_unsupported(
				{ count: warning.drawn.length + warning.omitted.length },
				{ locale },
			);
		case "shader-failed":
			return m.board_export_warning_shader_failed(
				{ id: warning.id },
				{ locale },
			);
	}
}

function exportVideo() {
	if (!animation || !plan) return;
	onExportVideo?.({
		animationId,
		duration: animation.duration,
		region,
		...(scope === "camera" ? { camera: cameraSize } : {}),
		...(inputs && replayInputs ? { inputs } : {}),
		scale,
	});
	onClose();
}

async function run(mode: "download" | "copy") {
	if (video) return exportVideo();
	if (!bridge || !plan || busy) return;
	busy = mode;
	failure = null;
	warnings = [];
	copied = false;
	try {
		const outputFormat: BoardImageFormat =
			mode === "copy" ? "png" : (format as BoardImageFormat);
		const result = await exportBoardImage(bridge, boardDocument, {
			region,
			...(scope === "camera" ? { camera: cameraSize } : {}),
			...(sampler
				? {
						at: {
							animation: animationId,
							time: Math.max(0, seconds || 0) * 1000,
						},
						sampler,
					}
				: {}),
			scale,
			background:
				transparent && transparencySupported ? "transparent" : "paper",
			format: outputFormat,
		});
		if (!result) {
			failure = m.board_nothing_export_detail({}, { locale });
			return;
		}
		warnings = result.warnings;
		if (mode === "copy") {
			await copyImageToClipboard(result.blob);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
			return;
		}
		const suffix =
			scope === "selection"
				? "selection"
				: scope === "frame"
					? "frame"
					: undefined;
		const { blob } = result;
		const name = boardExportFilename(title, outputFormat, suffix);
		onClose();
		void saveFile({
			key: name,
			name,
			mimeType: blob.type,
			source: () => ({ kind: "blob", blob }),
		});
	} catch (cause) {
		failure =
			cause instanceof Error
				? cause.message
				: m.board_export_failed({}, { locale });
	} finally {
		busy = null;
	}
}
</script>

<Dialog {open} {onClose} title={m.board_export_image({}, { locale })} maxWidth="440px">
	<div class="flex flex-col gap-4 px-4 py-3">
		<fieldset class="flex flex-col gap-1.5">
			<legend class="export-label">{m.board_area({}, { locale })}</legend>
			<div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.board_export_area({}, { locale })}>
				<button
					type="button"
					class="chip"
					class:chip--active={scope === "all"}
					aria-pressed={scope === "all"}
					onclick={() => { scope = "all"; }}
				>
					{m.board_whole_board({}, { locale })}
				</button>
				<button
					type="button"
					class="chip"
					class:chip--active={scope === "selection"}
					aria-pressed={scope === "selection"}
					disabled={!hasSelection}
					onclick={() => { scope = "selection"; }}
				>
					{m.board_selection_chip({}, { locale })}{hasSelection ? ` (${selection.length})` : ""}
				</button>
				{#if sampler}
					<button type="button" class="chip" class:chip--active={scope === "camera"} aria-pressed={scope === "camera"} onclick={() => { scope = "camera"; }}>{m.board_export_camera({}, { locale })}</button>
				{/if}
				{#if frames.length > 0}
					<button
						type="button"
						class="chip"
						class:chip--active={scope === "frame"}
						aria-pressed={scope === "frame"}
						onclick={() => { scope = "frame"; }}
					>
						{m.board_frame({}, { locale })}
					</button>
				{/if}
			</div>
			{#if scope === "frame" && frames.length > 0}
				<label class="mt-1 flex flex-col gap-1">
					<span class="sr-only">{m.board_frame_to_export({}, { locale })}</span>
					<select class="export-select" bind:value={frameId}>
						{#each frames as frame (frame.id)}
							<option value={frame.id}>{frame.label || m.board_frame({}, { locale })}</option>
						{/each}
					</select>
				</label>
			{/if}
		</fieldset>

		{#if animationIds.length > 0}
			<div class="grid grid-cols-2 gap-2">
				<label class="flex min-w-0 flex-col gap-1 text-xs text-text-secondary">{m.board_export_animation({}, { locale })}
					<select class="export-select" bind:value={animationId} onchange={() => { if (!animationId && scope === "camera") scope = "all"; }}>
						<option value="">—</option>
						{#each animationIds as id (id)}<option value={id}>{boardDocument.animations[id]?.name || id}</option>{/each}
					</select>
				</label>
				<label class="flex min-w-0 flex-col gap-1 text-xs text-text-secondary">{m.board_export_time({}, { locale })}<input class="export-select" type="number" min="0" max={(animation?.duration ?? 0) / 1000} step="0.1" bind:value={seconds} disabled={!sampler || video} /></label>
			</div>
		{/if}
		{#if scope === "camera"}
			<label class="flex flex-col gap-1 text-xs text-text-secondary">{m.board_export_viewport({}, { locale })}<select class="export-select" bind:value={viewport}><option>1600x900</option><option>900x1600</option><option>1080x1080</option></select></label>
		{/if}
		<button type="button" class="export-btn self-start" onclick={inspect}>{m.board_inspect({}, { locale })}</button>
		{#if hints}
			<div class="max-h-32 overflow-y-auto text-xs text-text-secondary" aria-live="polite">
				{#if hints.length === 0}<p>{m.board_inspect_clear({}, { locale })}</p>{/if}
				{#each hints as hint, index (`${hint.code}:${hint.item}:${index}`)}
					<button type="button" class="block w-full rounded px-1 py-2 text-left hover:bg-bg-hover" onclick={() => { onLocate?.(hint.item); onClose(); }}>{hint.item} · {hintLabel(hint)}</button>
				{/each}
			</div>
		{/if}

		{#if scope !== "camera"}
		<fieldset class="flex flex-col gap-1.5">
			<legend class="export-label">{m.board_scale({}, { locale })}</legend>
			<div class="flex gap-1.5" role="radiogroup" aria-label={m.board_export_scale({}, { locale })}>
				{#each SCALES as option (option)}
					<button
						type="button"
						class="chip"
						class:chip--active={scale === option}
						aria-pressed={scale === option}
						onclick={() => { scale = option; }}
					>
						{option}×
					</button>
				{/each}
			</div>
		</fieldset>
		{/if}

		<fieldset class="flex flex-col gap-1.5">
			<legend class="export-label">{m.board_format({}, { locale })}</legend>
			<div class="flex gap-1.5" role="radiogroup" aria-label={m.board_export_format({}, { locale })}>
				{#each FORMATS as option (option.id)}
					<button
						type="button"
						class="chip"
						class:chip--active={format === option.id}
						aria-pressed={format === option.id}
						onclick={() => { format = option.id; }}
					>
						{option.label}
					</button>
				{/each}
				{#if sampler && onExportVideo}
					<button type="button" class="chip" class:chip--active={video} aria-pressed={video} onclick={() => { format = "mp4"; }}>MP4</button>
				{/if}
			</div>
			{#if video}
				<p class="mt-1 text-[12px] text-text-tertiary">{m.board_video_export_note({}, { locale })}</p>
				{#if inputs}
					<label class="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-text-secondary" title={inputs}>
						<input type="checkbox" bind:checked={replayInputs} />
						<span class="truncate">{m.board_export_replay_input({}, { locale })}</span>
					</label>
				{/if}
			{:else}
			<label class="mt-1 flex items-center gap-2 text-[12px] text-text-secondary">
				<input
					type="checkbox"
					bind:checked={transparent}
					disabled={!transparencySupported}
				/>
				{m.board_transparent_bg({}, { locale })}
				{#if !transparencySupported}
					<span class="text-text-tertiary">{m.board_jpeg_no_alpha({}, { locale })}</span>
				{/if}
			</label>
			{/if}
		</fieldset>

		<p class="text-[12px] text-text-tertiary" aria-live="polite">
			{sizeLabel}{#if video && animation} · {(animation.duration / 1000).toFixed(1)}s{/if}
			{#if clamped}
				<span class="text-warning">
					· {m.board_reduced_to({ max: BOARD_EXPORT_MAX_EDGE }, { locale })}
				</span>
			{/if}
		</p>

		{#if failure}
			<p class="text-[12px] text-error-soft" role="alert">{failure}</p>
		{/if}
		{#each warnings as warning (warning.kind)}
			<p class="text-[12px] text-text-tertiary">{warningText(warning)}</p>
		{/each}
	</div>

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			{#if !video}
			<button
				type="button"
				class="export-btn"
				disabled={!plan || busy !== null}
				onclick={() => run("copy")}
			>
				{#if busy === "copy"}
					<Loader2 size={14} class="animate-spin" />
				{:else if copied}
					<Check size={14} />
				{:else}
					<Copy size={14} />
				{/if}
				{copied ? m.board_copied({}, { locale }) : m.board_copy({}, { locale })}
			</button>
			{/if}
			<button
				type="button"
				class="primary-key"
				disabled={!plan || busy !== null}
				onclick={() => run("download")}
			>
				{#if busy === "download"}
					<Spinner class="h-3.5 w-3.5" />
				{:else}
					<Download size={14} />
				{/if}
				{video ? m.board_video_export_start({}, { locale }) : m.download({}, { locale })}
			</button>
		</div>
	{/snippet}
</Dialog>

<style>
	.export-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text-tertiary);
		text-transform: uppercase;
	}

	.chip {
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: transparent;
		padding: 4px 10px;
		font-size: 12px;
		color: var(--text-secondary);
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
	}

	.chip:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.chip:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.chip--active {
		border-color: var(--brand);
		background: color-mix(in srgb, var(--brand) 14%, transparent);
		color: var(--text-primary);
	}

	.export-select {
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-surface);
		padding: 4px 8px;
		font-size: 12px;
		color: var(--text-primary);
	}

	.export-btn,
	.primary-key {
		padding: 5px 12px;
		font-size: 12px;
	}

	.export-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
	}

	.export-btn:hover:not(:disabled) {
		background: var(--bg-hover);
	}

	.export-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
