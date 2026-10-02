<script lang="ts">
import {
	BOARD_ENTER_PRESETS,
	type BoardEnterPreset,
	type BoardSettings,
	normalizeBoardRemoteUrl,
} from "@neta-art/cohub/board";
import { Image, Palette, RotateCcw, X } from "lucide-svelte";
import { untrack } from "svelte";
import type { BoardBackgroundLoadState } from "$lib/board/board-theme";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	loadState = null,
	onClose,
}: {
	editor: BoardEditor;
	loadState?: BoardBackgroundLoadState | null;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

type Background = BoardSettings["background"];
const background = $derived(editor.settings.background);
const initialBackground = untrack(() => editor.settings.background);
const presetColors = [
	"#141414",
	"#f5f2ea",
	"#17212b",
	"#24332f",
	"#352b3f",
	"#e8dfd1",
];
let mode = $state<"color" | "pattern" | "image">(
	initialBackground.kind === "image"
		? "image"
		: initialBackground.kind === "dots" || initialBackground.kind === "grid"
			? "pattern"
			: "color",
);
let imageUrl = $state(initialBackground.imageUrl ?? "");
let validationError = $state<string | null>(null);
const imageStatus = $derived.by(() => {
	if (background.kind !== "image" || !background.imageUrl) return null;
	return loadState?.url === background.imageUrl ? loadState.status : null;
});
const imageError = $derived(
	validationError ??
		(imageStatus === "error"
			? m.board_image_load_failed({}, { locale })
			: null),
);
const solidColor = $derived(
	background.kind === "solid" && typeof background.color === "string"
		? background.color
		: null,
);

const ENTER_LABELS: Record<BoardEnterPreset, () => string> = {
	"fade-in": () => m.board_motion_fade({}, { locale }),
	rise: () => m.board_motion_rise({}, { locale }),
	drop: () => m.board_motion_drop({}, { locale }),
	pop: () => m.board_motion_pop({}, { locale }),
	deal: () => m.board_motion_deal({}, { locale }),
};

function update(patch: Partial<BoardSettings>, commit = true) {
	const next = { ...editor.settings, ...patch };
	if (commit) editor.setSettings(next);
	else editor.previewSettings(next);
}

function setColor(color: string, commit = true) {
	mode = "color";
	validationError = null;
	update(
		{
			background: { kind: "solid", color },
			grid: {
				...editor.settings.grid,
				visible: false,
				size: editor.settings.grid?.size ?? 24,
			},
		},
		commit,
	);
}

function setPattern(kind: "dots" | "grid") {
	mode = "pattern";
	update({
		background: {
			kind,
			...(background.color ? { color: background.color } : {}),
		},
		grid: {
			...editor.settings.grid,
			visible: true,
			size: editor.settings.grid?.size ?? 24,
		},
	});
}

function setGridVisible(visible: boolean) {
	update({
		grid: {
			...editor.settings.grid,
			visible,
			size: editor.settings.grid?.size ?? 24,
		},
	});
}

function setGridSize(size: number) {
	if (!Number.isFinite(size) || size < 4) return;
	update({ grid: { ...editor.settings.grid, visible: true, size } });
}

function useImage() {
	const url = normalizeBoardRemoteUrl(imageUrl);
	if (!url) {
		validationError = "Enter a public HTTP(S) image URL.";
		return;
	}
	imageUrl = url;
	mode = "image";
	validationError = null;
	update({
		background: {
			...background,
			kind: "image",
			imageUrl: url,
			fit: background.fit ?? "cover",
			opacity: background.opacity ?? 1,
		},
		grid: {
			...editor.settings.grid,
			visible: false,
			size: editor.settings.grid?.size ?? 24,
		},
	});
}

function patchImageOptions(
	patch: Partial<Pick<Background, "fit" | "opacity">>,
	commit = true,
) {
	if (background.kind !== "image" || !background.imageUrl) return;
	update({ background: { ...background, ...patch } }, commit);
}

function setEnterMotion(preset: BoardEnterPreset | "") {
	const { enter: _enter, ...rest } = editor.settings;
	editor.setSettings(preset ? { ...rest, enter: { preset } } : rest);
}

function reset() {
	imageUrl = "";
	validationError = null;
	mode = "pattern";
	const { enter: _enter, ...rest } = editor.settings;
	editor.setSettings({
		...rest,
		background: { kind: "dots" },
		grid: { visible: true, size: 24 },
	});
}
</script>

<div class="appearance-popover" role="dialog" aria-label={m.board_appearance({}, { locale })}>
	<div class="appearance-header">
		<div class="appearance-title"><Palette class="h-3.5 w-3.5" /> {m.board_appearance({}, { locale })}</div>
		<button type="button" class="icon-button" title={m.board_close({}, { locale })} aria-label={m.board_close({}, { locale })} onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<div class="mode-tabs" role="tablist" aria-label={m.board_bg_type({}, { locale })}>
		<button type="button" class:active={mode === "color"} role="tab" aria-selected={mode === "color"} onclick={() => { mode = "color"; }}>
			<Palette class="h-3.5 w-3.5" /> {m.board_color({}, { locale })}
		</button>
		<button type="button" class:active={mode === "pattern"} role="tab" aria-selected={mode === "pattern"} onclick={() => setPattern(background.kind === "grid" ? "grid" : "dots")}>
			{m.board_pattern({}, { locale })}
		</button>
		<button type="button" class:active={mode === "image"} role="tab" aria-selected={mode === "image"} onclick={() => { mode = "image"; }}>
			<Image class="h-3.5 w-3.5" /> {m.board_image_mode({}, { locale })}
		</button>
	</div>

	{#if mode === "color"}
		<div class="color-section">
			<div class="swatches" role="group" aria-label={m.board_bg_presets({}, { locale })}>
				{#each presetColors as color (color)}
					<button type="button" class="swatch" class:selected={solidColor === color} style:background={color} title={color} aria-label={m.board_use_color_aria({ color }, { locale })} onclick={() => setColor(color)}></button>
				{/each}
			</div>
			<label class="color-input">
				<span>{m.board_custom_color({}, { locale })}</span>
				<input type="color" value={solidColor ?? "#141414"} oninput={(event) => setColor(event.currentTarget.value, false)} onchange={(event) => setColor(event.currentTarget.value)} />
			</label>
		</div>
	{:else if mode === "pattern"}
		<div class="pattern-section">
			<div class="pattern-options" role="group" aria-label={m.board_pattern({}, { locale })}>
				<button type="button" class:active={background.kind === "dots"} aria-pressed={background.kind === "dots"} onclick={() => setPattern("dots")}>
					{m.board_pattern_dots({}, { locale })}
				</button>
				<button type="button" class:active={background.kind === "grid"} aria-pressed={background.kind === "grid"} onclick={() => setPattern("grid")}>
					{m.board_pattern_grid({}, { locale })}
				</button>
			</div>
			<label class="pattern-toggle">
				<input type="checkbox" checked={editor.settings.grid?.visible ?? false} onchange={(event) => setGridVisible(event.currentTarget.checked)} />
				<span>{m.board_pattern_visible({}, { locale })}</span>
			</label>
			<label class="field-label" for="board-pattern-spacing">{m.board_pattern_spacing({}, { locale })}</label>
			<input id="board-pattern-spacing" class="spacing-input" type="number" min="4" step="4" value={editor.settings.grid?.size ?? 24} onchange={(event) => setGridSize(Number(event.currentTarget.value))} />
		</div>
	{:else}
		<div class="image-section">
			<label class="field-label" for="board-background-url">{m.board_image_url({}, { locale })}</label>
			<div class="url-row">
				<input id="board-background-url" type="url" bind:value={imageUrl} placeholder="https://..." autocomplete="url" onkeydown={(event) => { if (event.key === "Enter") useImage(); }} />
				<button type="button" class="apply-button" disabled={!imageUrl.trim()} onclick={useImage}>{m.common_apply({}, { locale })}</button>
			</div>
			{#if imageError}
				<p class="error" role="status">{imageError}</p>
			{:else if imageStatus === "loading"}
				<p class="loading" role="status">{m.board_loading_image({}, { locale })}</p>
			{/if}
			{#if background.kind === "image" && background.imageUrl}
				<div class="image-options">
					<div class="option-row">
						<label for="board-image-fit">{m.board_fit({}, { locale })}</label>
						<select id="board-image-fit" value={background.fit ?? "cover"} onchange={(event) => patchImageOptions({ fit: event.currentTarget.value as "cover" | "contain" | "repeat" })}><option value="cover">{m.board_cover({}, { locale })}</option><option value="contain">{m.board_contain({}, { locale })}</option><option value="repeat">{m.board_repeat({}, { locale })}</option></select>
					</div>
					<div class="option-row">
						<label for="board-image-opacity">{m.board_opacity({}, { locale })}</label>
						<input id="board-image-opacity" type="range" min="0.1" max="1" step="0.05" value={background.opacity ?? 1} oninput={(event) => patchImageOptions({ opacity: Number(event.currentTarget.value) }, false)} onchange={(event) => patchImageOptions({ opacity: Number(event.currentTarget.value) })} />
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<div class="motion-section">
		<label class="field-label" for="board-enter-motion">{m.board_motion_enter({}, { locale })}</label>
		<select
			id="board-enter-motion"
			value={editor.settings.enter?.preset ?? ""}
			onchange={(event) => setEnterMotion(event.currentTarget.value as BoardEnterPreset | "")}
		>
			<option value="">{m.board_motion_none({}, { locale })}</option>
			{#each BOARD_ENTER_PRESETS as preset (preset)}
				<option value={preset}>{ENTER_LABELS[preset]()}</option>
			{/each}
		</select>
		<p class="section-hint">{m.board_motion_hint({}, { locale })}</p>
	</div>

	<div class="appearance-footer">
		{#if editor.saving}
			<span class="save-status" role="status">{m.common_saving({}, { locale })}</span>
		{/if}
		<button type="button" class="reset-button" onclick={reset}><RotateCcw class="h-3.5 w-3.5" /> {m.common_reset({}, { locale })}</button>
	</div>
</div>

<style>
	.appearance-popover { width: min(320px, calc(100vw - 24px)); border: 1px solid var(--border-subtle); border-radius: 9px; background: var(--bg-elevated); box-shadow: 0 14px 32px color-mix(in srgb, var(--overlay-scrim-strong) 20%, transparent); padding: 10px; color: var(--text-primary); }
	.appearance-header, .appearance-title, .mode-tabs, .url-row, .color-input, .appearance-footer { display: flex; align-items: center; }
	.appearance-header { justify-content: space-between; margin-bottom: 10px; }
	.appearance-title { gap: 6px; font-size: 12px; font-weight: 600; }
	.icon-button, .reset-button, .mode-tabs button, .apply-button { min-height: 32px; border-radius: 6px; }
	.icon-button { display: grid; place-items: center; width: 32px; color: var(--text-tertiary); }
	.icon-button:hover, .reset-button:hover { background: var(--bg-hover); color: var(--text-primary); }
	.mode-tabs { gap: 3px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 7px; }
	.mode-tabs button { display: inline-flex; align-items: center; gap: 5px; padding: 0 9px; color: var(--text-tertiary); font-size: 11px; }
	.mode-tabs button.active { background: var(--brand-bg); color: var(--brand-muted-fg); }
	.color-section, .image-section { padding: 12px 2px 4px; }
	.swatches { display: flex; flex-wrap: wrap; gap: 8px; }
	.swatch { width: 28px; height: 28px; border: 1px solid var(--border-subtle); border-radius: 50%; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 12%, transparent); }
	.swatch.selected { outline: 2px solid var(--text-primary); outline-offset: 2px; }
	.color-input { justify-content: space-between; margin-top: 14px; color: var(--text-tertiary); font-size: 11px; }
	.color-input input { width: 38px; height: 28px; padding: 2px; border: 1px solid var(--border-subtle); border-radius: 5px; background: transparent; }
	.field-label { display: block; margin-bottom: 5px; color: var(--text-tertiary); font-size: 11px; }
	.url-row { gap: 6px; }
	.url-row input { min-width: 0; flex: 1; height: 32px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-input); padding: 0 8px; color: var(--text-primary); font-size: 12px; }
	.apply-button { padding: 0 9px; background: var(--brand); color: var(--brand-contrast-fg); font-size: 11px; }
	.apply-button:disabled { opacity: .45; }
	.error, .loading { margin: 7px 0 0; font-size: 11px; line-height: 1.35; }
	.error { color: var(--error-700); }
	.loading { color: var(--text-tertiary); }
	.motion-section { display: grid; gap: 5px; margin: 12px 2px 4px; padding-top: 10px; border-top: 1px solid var(--border-subtle); }
	.motion-section select { height: 30px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-input); padding: 0 7px; color: var(--text-primary); font-size: 12px; }
	.section-hint { margin: 0; color: var(--text-tertiary); font-size: 10px; line-height: 1.35; }
	.pattern-section { display: grid; gap: 10px; padding: 12px 2px; }
	.pattern-options { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
	.pattern-options button { min-height: 32px; border-radius: 6px; color: var(--text-secondary); font-size: 11px; }
	.pattern-options button.active { background: var(--brand-bg); color: var(--brand-muted-fg); }
	.pattern-toggle { display: flex; align-items: center; gap: 8px; min-height: 28px; color: var(--text-secondary); font-size: 11px; }
	.spacing-input { width: 100%; height: 32px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-input); padding: 0 8px; color: var(--text-primary); font-size: 12px; }
	.image-options { display: grid; gap: 8px; margin-top: 12px; }
	.option-row { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 8px; }
	.option-row label { color: var(--text-tertiary); font-size: 11px; }
	.image-options select { height: 30px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-input); padding: 0 7px; color: var(--text-primary); }
	.image-options input[type="range"] { width: 100%; accent-color: var(--brand); }
	.appearance-footer { justify-content: flex-end; margin-top: 8px; border-top: 1px solid var(--border-subtle); padding-top: 8px; }
	.save-status { margin-right: auto; color: var(--text-tertiary); font-size: 11px; }
	.reset-button { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; color: var(--text-tertiary); font-size: 11px; }
	@media (pointer: coarse) { .appearance-popover { padding: 12px; } .icon-button, .reset-button, .mode-tabs button, .apply-button { min-height: 40px; } .swatch { width: 34px; height: 34px; } .url-row input { height: 40px; } }
</style>
