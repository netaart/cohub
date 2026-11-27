<script lang="ts" module>
import type { BoardExportRegion } from "@neta-art/cohub/board";

export type BoardExportView = Extract<
	BoardExportRegion,
	{ kind: "rect" }
>["rect"];

export type BoardExportInputs = { path: string; recent: boolean };

export type BoardExportIntent = {
	mode: "image" | "video";
	animationId?: string;
};
</script>

<script lang="ts">
import {
	BOARD_CAMERA_VIEWPORT,
	BOARD_EXPORT_MAX_EDGE,
	type BoardDocument,
	buildBoardScene,
	createBoardAnimationSampler,
	planBoardExport,
} from "@neta-art/cohub/board";
import { Check, ChevronDown, Copy, Download, Loader2, X } from "lucide-svelte";
import { untrack } from "svelte";
import { formatBoardTime } from "#lib/board/animation-timeline.ts";
import { boardAnimationReach } from "#lib/board/board-media-playback.ts";
import {
	type BoardImageExportWarning,
	type BoardImageFormat,
	type BoardStageExportBridge,
	boardExportFilename,
	copyImageToClipboard,
	exportBoardImage,
} from "#lib/board/board-image-export.ts";
import type { BoardVideoExportRequest } from "#lib/board/board-video-export.svelte.ts";
import Dialog from "#lib/components/Dialog.svelte";
import Segmented from "#lib/components/Segmented.svelte";
import Spinner from "#lib/components/Spinner.svelte";
import { saveFile } from "#lib/downloads.svelte.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	open,
	intent,
	onClose,
	document: boardDocument,
	bridge,
	title,
	selection,
	view,
	playhead,
	videoBlocked,
	inputs = null,
	onExportVideo,
}: {
	open: boolean;
	intent: BoardExportIntent;
	onClose: () => void;
	document: BoardDocument;
	bridge: BoardStageExportBridge | null;
	title: string | null;
	selection: string[];
	view: BoardExportView | null;
	playhead: { animationId: string; time: number } | null;
	videoBlocked: string | null;
	inputs?: BoardExportInputs | null;
	onExportVideo: (request: BoardVideoExportRequest) => void;
} = $props();

const locale = $derived(getLocale());

type ImageScope = "view" | "all" | "selection" | "frame" | "camera";

const SCALES = [1, 2, 3, 4] as const;
const FORMATS: Array<{ id: BoardImageFormat; label: string }> = [
	{ id: "png", label: "PNG" },
	{ id: "jpeg", label: "JPEG" },
	{ id: "webp", label: "WebP" },
];

let mode = $state<"image" | "video">("image");
let scope = $state<ImageScope>("view");
let frameId = $state<string | null>(null);
let at = $state<{ animationId: string; time: number } | null>(null);
let scale = $state(2);
let format = $state<BoardImageFormat>("png");
let transparent = $state(false);
let optionsOpen = $state(false);
let videoId = $state("");
let videoScope = $state<"camera" | "all">("camera");
let replayInputs = $state(true);
let busy = $state<"download" | "copy" | null>(null);
let copied = $state(false);
let failure = $state<string | null>(null);
let warnings = $state<BoardImageExportWarning[]>([]);

const animationIds = $derived(Object.keys(boardDocument.animations));
const hasSelection = $derived(selection.length > 0);
const scene = $derived(open ? buildBoardScene(boardDocument) : null);
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

function nameOf(id: string) {
	return boardDocument.animations[id]?.name || id;
}

function viewportOf(id: string | undefined) {
	return (
		(id ? boardDocument.animations[id]?.viewport : undefined) ??
		BOARD_CAMERA_VIEWPORT
	);
}

function chooseVideo(id: string) {
	videoId = id;
	videoScope = boardAnimationReach(boardDocument, id).camera ? "camera" : "all";
}

$effect(() => {
	if (open) untrack(reset);
});

function reset() {
	failure = null;
	warnings = [];
	copied = false;
	busy = null;
	optionsOpen = false;
	replayInputs = inputs?.recent ?? false;
	at = playhead && boardDocument.animations[playhead.animationId] ? playhead : null;
	scope = hasSelection ? "selection" : view ? "view" : "all";
	if (!frameId && frames.length > 0) frameId = frames[0]?.id ?? null;
	const preferred = intent.animationId ?? at?.animationId;
	const id =
		preferred && boardDocument.animations[preferred]
			? preferred
			: animationIds[0];
	if (id) chooseVideo(id);
	mode = intent.mode === "video" && id ? "video" : "image";
}

$effect(() => {
	if (scope === "camera" && !at) scope = view ? "view" : "all";
});

const sampler = $derived(
	open && at ? createBoardAnimationSampler(boardDocument, at.animationId) : null,
);
const imageScene = $derived(sampler && at ? sampler.at(at.time).scene : scene);
const imageRegion = $derived.by<BoardExportRegion>(() => {
	if (scope === "selection" && hasSelection)
		return { kind: "items", ids: selection };
	if (scope === "frame" && frameId) return { kind: "frame", id: frameId };
	if (scope === "view" && view) return { kind: "rect", rect: view };
	return { kind: "all" };
});
const imageCamera = $derived(
	scope === "camera" && at ? viewportOf(at.animationId) : null,
);
const imagePlan = $derived(
	imageScene
		? planBoardExport({ scene: imageScene, region: imageRegion, scale })
		: null,
);
const transparencySupported = $derived(format !== "jpeg");
const imageSize = $derived(
	imageCamera
		? `${imageCamera.width} × ${imageCamera.height} px`
		: imagePlan
			? `${imagePlan.width} × ${imagePlan.height} px`
			: m.board_nothing_export({}, { locale }),
);
const imageSummary = $derived(
	[
		FORMATS.find((entry) => entry.id === format)?.label,
		imageCamera ? null : `${scale}×`,
		transparent && transparencySupported
			? m.board_transparent_bg({}, { locale })
			: null,
	]
		.filter(Boolean)
		.join(" · "),
);

const video = $derived(
	videoId ? boardDocument.animations[videoId] : undefined,
);
const videoCamera = $derived(
	videoScope === "camera" ? viewportOf(videoId) : null,
);
const videoPlan = $derived(
	open && video && !videoCamera
		? planBoardExport({
				scene: createBoardAnimationSampler(boardDocument, videoId).at(0).scene,
				region: { kind: "all" },
				scale: 1,
			})
		: null,
);
const videoSize = $derived(
	videoCamera
		? `${videoCamera.width} × ${videoCamera.height} px`
		: videoPlan
			? `${videoPlan.width} × ${videoPlan.height} px`
			: m.board_nothing_export({}, { locale }),
);
const videoReady = $derived(
	videoBlocked === null && Boolean(video) && Boolean(videoCamera || videoPlan),
);

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
		case "depth-flat":
			return m.board_export_warning_depth_flat(
				{ count: warning.ids.length },
				{ locale },
			);
		case "models-flat":
			return m.board_export_warning_models_flat(
				{ count: warning.ids.length },
				{ locale },
			);
	}
}

function exportVideo() {
	if (!video || !videoReady) return;
	onExportVideo({
		animationId: videoId,
		duration: video.duration,
		region: { kind: "all" },
		...(videoCamera ? { camera: videoCamera } : {}),
		...(inputs && replayInputs ? { inputs: inputs.path } : {}),
		scale: 1,
	});
	onClose();
}

async function exportImage(target: "download" | "copy") {
	if (!bridge || !imagePlan || busy) return;
	busy = target;
	failure = null;
	warnings = [];
	copied = false;
	try {
		const outputFormat: BoardImageFormat = target === "copy" ? "png" : format;
		const result = await exportBoardImage(bridge, boardDocument, {
			region: imageRegion,
			...(imageCamera ? { camera: imageCamera } : {}),
			...(sampler && at
				? { at: { animation: at.animationId, time: at.time }, sampler }
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
		if (target === "copy") {
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

{#snippet chip(active: boolean, label: string, select: () => void)}
	<button type="button" class="chip" class:chip--active={active} aria-pressed={active} onclick={select}>{label}</button>
{/snippet}

<Dialog {open} {onClose} title={m.board_export({}, { locale })} maxWidth="420px">
	<div class="flex flex-col gap-4 px-4 py-3">
		{#if animationIds.length > 0}
			<Segmented
				label={m.board_export_format({}, { locale })}
				value={mode}
				options={[
					{ value: "image", label: m.board_export_mode_image({}, { locale }) },
					{ value: "video", label: m.board_export_mode_video({}, { locale }) },
				]}
				onchange={(next) => { mode = next; }}
			/>
		{/if}

		{#if mode === "image"}
			<fieldset class="flex flex-col gap-1.5">
				<legend class="export-label">{m.board_area({}, { locale })}</legend>
				<div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.board_export_area({}, { locale })}>
					{#if view}{@render chip(scope === "view", m.board_export_view({}, { locale }), () => { scope = "view"; })}{/if}
					{@render chip(scope === "all", m.board_whole_board({}, { locale }), () => { scope = "all"; })}
					{#if hasSelection}{@render chip(scope === "selection", `${m.board_selection_chip({}, { locale })} (${selection.length})`, () => { scope = "selection"; })}{/if}
					{#if frames.length > 0}{@render chip(scope === "frame", m.board_frame({}, { locale }), () => { scope = "frame"; })}{/if}
					{#if at}{@render chip(scope === "camera", m.board_export_camera({}, { locale }), () => { scope = "camera"; })}{/if}
				</div>
				{#if scope === "frame" && frames.length > 0}
					<select class="export-select mt-1" aria-label={m.board_frame({}, { locale })} bind:value={frameId}>
						{#each frames as frame (frame.id)}
							<option value={frame.id}>{frame.label || m.board_frame({}, { locale })}</option>
						{/each}
					</select>
				{/if}
			</fieldset>

			{#if at}
				<div class="moment">
					<span class="min-w-0 truncate">{m.board_export_moment({ name: nameOf(at.animationId), time: formatBoardTime(at.time) }, { locale })}</span>
					<button type="button" class="moment-clear" title={m.board_export_moment_clear({}, { locale })} aria-label={m.board_export_moment_clear({}, { locale })} onclick={() => { at = null; }}>
						<X class="h-3 w-3" />
					</button>
				</div>
			{/if}

			<div class="flex flex-col gap-2">
				<button type="button" class="options-toggle" aria-expanded={optionsOpen} onclick={() => { optionsOpen = !optionsOpen; }}>
					<span>{m.board_export_options({}, { locale })}</span>
					<span class="min-w-0 flex-1 truncate text-left text-text-tertiary">{optionsOpen ? "" : imageSummary}</span>
					<ChevronDown class="options-chevron h-3.5 w-3.5" />
				</button>
				{#if optionsOpen}
					<div class="flex flex-col gap-3">
						<div class="flex gap-1.5" role="radiogroup" aria-label={m.board_export_format({}, { locale })}>
							{#each FORMATS as option (option.id)}
								{@render chip(format === option.id, option.label, () => { format = option.id; })}
							{/each}
						</div>
						{#if !imageCamera}
							<div class="flex gap-1.5" role="radiogroup" aria-label={m.board_export_scale({}, { locale })}>
								{#each SCALES as option (option)}
									{@render chip(scale === option, `${option}×`, () => { scale = option; })}
								{/each}
							</div>
						{/if}
						<label class="flex items-center gap-2 text-[12px] text-text-secondary">
							<input type="checkbox" bind:checked={transparent} disabled={!transparencySupported} />
							{m.board_transparent_bg({}, { locale })}
							{#if !transparencySupported}
								<span class="text-text-tertiary">{m.board_jpeg_no_alpha({}, { locale })}</span>
							{/if}
						</label>
					</div>
				{/if}
			</div>

			<p class="text-[12px] text-text-tertiary" aria-live="polite">
				{imageSize}
				{#if imagePlan?.clamped && !imageCamera}
					<span class="text-warning">{m.board_reduced_to({ max: BOARD_EXPORT_MAX_EDGE }, { locale })}</span>
				{/if}
			</p>
			{#if failure}
				<p class="text-[12px] text-error-soft" role="alert">{failure}</p>
			{/if}
			{#each warnings as warning (warning.kind)}
				<p class="text-[12px] text-text-tertiary">{warningText(warning)}</p>
			{/each}
		{:else}
			{#if animationIds.length > 1}
				<label class="flex flex-col gap-1.5">
					<span class="export-label">{m.board_export_animation({}, { locale })}</span>
					<select class="export-select" value={videoId} onchange={(event) => chooseVideo(event.currentTarget.value)}>
						{#each animationIds as id (id)}<option value={id}>{nameOf(id)}</option>{/each}
					</select>
				</label>
			{/if}
			<fieldset class="flex flex-col gap-1.5">
				<legend class="export-label">{m.board_area({}, { locale })}</legend>
				<div class="flex gap-1.5" role="radiogroup" aria-label={m.board_export_area({}, { locale })}>
					{@render chip(videoScope === "camera", m.board_export_camera({}, { locale }), () => { videoScope = "camera"; })}
					{@render chip(videoScope === "all", m.board_whole_board({}, { locale }), () => { videoScope = "all"; })}
				</div>
			</fieldset>
			{#if inputs}
				<label class="flex min-w-0 items-center gap-2 text-[12px] text-text-secondary" title={inputs.path}>
					<input type="checkbox" bind:checked={replayInputs} />
					<span class="truncate">{m.board_export_replay_input({}, { locale })}</span>
				</label>
			{/if}
			<div class="flex flex-col gap-1 text-[12px]" aria-live="polite">
				<p class="text-text-secondary">
					{nameOf(videoId)} · {formatBoardTime(video?.duration ?? 0)} · {videoSize}
				</p>
				{#if videoBlocked}
					<p class="text-warning">{videoBlocked}</p>
				{:else}
					<p class="text-text-tertiary">{m.board_video_export_note({}, { locale })}</p>
				{/if}
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			{#if mode === "image"}
				<button type="button" class="export-btn" disabled={!imagePlan || busy !== null} onclick={() => exportImage("copy")}>
					{#if busy === "copy"}
						<Loader2 size={14} class="animate-spin" />
					{:else if copied}
						<Check size={14} />
					{:else}
						<Copy size={14} />
					{/if}
					{copied ? m.board_copied({}, { locale }) : m.board_copy({}, { locale })}
				</button>
				<button type="button" class="primary-key" disabled={!imagePlan || busy !== null} onclick={() => exportImage("download")}>
					{#if busy === "download"}
						<Spinner class="h-3.5 w-3.5" />
					{:else}
						<Download size={14} />
					{/if}
					{m.download({}, { locale })}
				</button>
			{:else}
				<button type="button" class="primary-key" disabled={!videoReady} onclick={exportVideo}>
					<Download size={14} />
					{m.board_video_export_start({}, { locale })}
				</button>
			{/if}
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

	.chip:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
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

	.moment {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		border-radius: 7px;
		background: var(--bg-hover);
		padding: 4px 4px 4px 10px;
		font-size: 12px;
		color: var(--text-secondary);
	}

	.moment-clear {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-left: auto;
		border-radius: 5px;
		color: var(--text-tertiary);
	}

	.moment-clear:hover {
		background: var(--bg-surface);
		color: var(--text-primary);
	}

	.options-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
		color: var(--text-secondary);
	}

	.options-toggle:hover { color: var(--text-primary); }

	.options-toggle :global(.options-chevron) {
		flex: none;
		color: var(--text-tertiary);
		transition: transform 150ms var(--ease-out);
	}

	.options-toggle[aria-expanded="true"] :global(.options-chevron) { transform: rotate(180deg); }

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

	@media (pointer: coarse) {
		.chip { padding: 8px 12px; }
		.moment-clear { width: 32px; height: 32px; }
	}
</style>
