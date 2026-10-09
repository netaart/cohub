<script lang="ts">
import { type BoardDocument, buildBoardScene } from "@neta-art/cohub/board";
import {
	BOARD_EXPORT_MAX_EDGE,
	type BoardExportRegion,
	planBoardExport,
} from "@neta-art/cohub/board";
import { Check, Copy, Download, Loader2 } from "lucide-svelte";
import {
	type BoardImageFormat,
	type BoardStageExportBridge,
	boardExportFilename,
	copyImageToClipboard,
	downloadBlob,
	exportBoardImage,
} from "$lib/board/board-image-export";
import Dialog from "$lib/components/Dialog.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	open,
	onClose,
	document: boardDocument,
	bridge,
	title,
	selection,
}: {
	open: boolean;
	onClose: () => void;
	document: BoardDocument;
	bridge: BoardStageExportBridge | null;
	title: string | null;
	selection: string[];
} = $props();

const locale = $derived(getLocale());

type Scope = "all" | "selection" | "frame";

const SCALES = [1, 2, 3, 4] as const;
const FORMATS: Array<{ id: BoardImageFormat; label: string }> = [
	{ id: "png", label: "PNG" },
	{ id: "jpeg", label: "JPEG" },
	{ id: "webp", label: "WebP" },
];

let scope = $state<Scope>("all");
let frameId = $state<string | null>(null);
let scale = $state<number>(2);
let format = $state<BoardImageFormat>("png");
let transparent = $state(false);
let busy = $state<"download" | "copy" | null>(null);
let copied = $state(false);
let failure = $state<string | null>(null);
let warnings = $state<string[]>([]);

const scene = $derived(open ? buildBoardScene(boardDocument) : null);
const frames = $derived(
	scene ? scene.items.filter((item) => item.type === "frame").map((item) => ({ id: item.id, label: (item.props as { label: string }).label })) : [],
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

const plan = $derived.by(() => (scene ? planBoardExport({ scene, region, scale }) : null));
const sizeLabel = $derived(
	plan
		? `${plan.width} × ${plan.height} px`
		: m.board_nothing_export({}, { locale }),
);
const clamped = $derived(Boolean(plan?.clamped));

const transparencySupported = $derived(format !== "jpeg");

async function run(mode: "download" | "copy") {
	if (!bridge || !plan || busy) return;
	busy = mode;
	failure = null;
	warnings = [];
	copied = false;
	try {
		const outputFormat: BoardImageFormat = mode === "copy" ? "png" : format;
		const result = await exportBoardImage(bridge, boardDocument, {
			region,
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
		downloadBlob(result.blob, boardExportFilename(title, outputFormat, suffix));
		onClose();
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
				{#if frames.length > 0}
					<button
						type="button"
						class="chip"
						class:chip--active={scope === "frame"}
						aria-pressed={scope === "frame"}
						onclick={() => { scope = "frame"; }}
					>
						Frame
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
			</div>
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
		</fieldset>

		<p class="text-[12px] text-text-tertiary" aria-live="polite">
			{sizeLabel}
			{#if clamped}
				<span class="text-warning-400">
					· {m.board_reduced_to({ max: BOARD_EXPORT_MAX_EDGE }, { locale })}
				</span>
			{/if}
		</p>

		{#if failure}
			<p class="text-[12px] text-error-soft" role="alert">{failure}</p>
		{/if}
		{#each warnings as warning (warning)}
			<p class="text-[12px] text-text-tertiary">{warning}</p>
		{/each}
	</div>

	{#snippet footer()}
		<div class="flex justify-end gap-2">
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
			<button
				type="button"
				class="export-btn export-btn--primary"
				disabled={!plan || busy !== null}
				onclick={() => run("download")}
			>
				{#if busy === "download"}
					<Loader2 size={14} class="animate-spin" />
				{:else}
					<Download size={14} />
				{/if}
				{m.download({}, { locale })}
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

	.export-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: transparent;
		padding: 5px 12px;
		font-size: 12px;
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

	.export-btn--primary {
		border-color: transparent;
		background: var(--brand);
		color: var(--brand-contrast, #fff);
	}

	.export-btn--primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--brand) 88%, black);
	}
</style>
