<script lang="ts" module>
import type { ModelScene, ModelShading } from "@neta-art/cohub/board/render";

export type ModelControlsState = Pick<
	ModelScene,
	| "clips"
	| "clip"
	| "playing"
	| "spinning"
	| "shadings"
	| "shading"
	| "wireframe"
>;

export function readModelControls(scene: ModelScene): ModelControlsState {
	const { clips, clip, playing, spinning, shadings, shading, wireframe } =
		scene;
	return { clips, clip, playing, spinning, shadings, shading, wireframe };
}
</script>

<script lang="ts">
import {
	MODEL_VIEW_PRESETS,
	type ModelStats,
	type ModelViewPreset,
} from "@neta-art/cohub/board/render";
import {
	Check,
	ChevronDown,
	Contrast,
	Ellipsis,
	ImageDown,
	Info,
	Maximize2,
	Minimize2,
	Pause,
	Play,
	Rotate3d,
	RotateCcw,
} from "lucide-svelte";
import AdaptivePopover from "#lib/components/list-page/AdaptivePopover.svelte";
import { formatBytes } from "#lib/format-bytes.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	controls,
	stats,
	fileSize,
	fullscreen,
	reducedMotion,
	onChange,
	onSnapshot,
	onFullscreen,
}: {
	controls: ModelControlsState;
	stats: ModelStats | null;
	fileSize: number | null;
	fullscreen: boolean | null;
	reducedMotion: boolean;
	onChange: (change: (scene: ModelScene) => void) => void;
	onSnapshot: () => void;
	onFullscreen: () => void;
} = $props();

const locale = $derived(getLocale());

type Menu = "clip" | "shading" | "info" | "more";
let open = $state<Menu | null>(null);
const anchors = $state<Record<Menu, HTMLElement | null>>({ clip: null, shading: null, info: null, more: null });

const shadingLabels: Record<ModelShading, () => string> = {
	standard: () => m.model3d_shading_standard({}, { locale }),
	clay: () => m.model3d_shading_clay({}, { locale }),
	color: () => m.model3d_shading_color({}, { locale }),
	normals: () => m.model3d_shading_normals({}, { locale }),
};
const viewLabels: Record<ModelViewPreset, () => string> = {
	home: () => m.model3d_view_home({}, { locale }),
	front: () => m.model3d_view_front({}, { locale }),
	side: () => m.model3d_view_side({}, { locale }),
	top: () => m.model3d_view_top({}, { locale }),
};
const views = Object.keys(MODEL_VIEW_PRESETS) as ModelViewPreset[];

const inspecting = $derived(controls.shading !== "standard" || controls.wireframe);
const playLabel = $derived(controls.playing ? m.model3d_pause({}, { locale }) : m.model3d_play({}, { locale }));
const fullscreenLabel = $derived(fullscreen ? m.model3d_exit_fullscreen({}, { locale }) : m.model3d_fullscreen({}, { locale }));

const facts = $derived.by(() => {
	if (!stats) return [];
	const count = new Intl.NumberFormat(locale);
	const rows: [string, string][] = [
		[m.model3d_stat_triangles({}, { locale }), count.format(stats.triangles)],
		[m.model3d_stat_vertices({}, { locale }), count.format(stats.vertices)],
		[m.model3d_stat_size({}, { locale }), formatSize(stats, locale)],
	];
	if (stats.materials) rows.push([m.model3d_stat_materials({}, { locale }), count.format(stats.materials)]);
	if (stats.textures) rows.push([m.model3d_stat_textures({}, { locale }), count.format(stats.textures)]);
	if (stats.clips) rows.push([m.model3d_stat_animations({}, { locale }), count.format(stats.clips)]);
	if (fileSize !== null) rows.push([m.model3d_stat_file({}, { locale }), formatBytes(fileSize)]);
	return rows;
});

function formatSize({ size, unit }: ModelStats, locale: string): string {
	const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 });
	if (!unit) return size.map((value) => number.format(value)).join(" × ");
	const largest = Math.max(...size);
	const [factor, suffix] = largest >= 1 ? [1, "m"] : largest >= 0.01 ? [100, "cm"] : [1000, "mm"];
	return `${size.map((value) => number.format(value * factor)).join(" × ")} ${suffix}`;
}

$effect(() => {
	fullscreen;
	open = null;
});

function toggle(menu: Menu) {
	open = open === menu ? null : menu;
}

function choose(change: (scene: ModelScene) => void) {
	open = null;
	onChange(change);
}

const hint = (label: string, key: string) => `${label} (${key})`;
</script>

{#snippet option(label: string, checked: boolean, pick: () => void, role = "menuitemradio")}
	<button type="button" {role} aria-checked={checked} class="model-option" onclick={pick}>
		<span class="min-w-0 flex-1 truncate">{label}</span>
		<Check class="h-3.5 w-3.5 shrink-0 text-brand {checked ? 'opacity-100' : 'opacity-0'}" />
	</button>
{/snippet}

<div class="model-toolbar toolbar-surface" role="toolbar" aria-label={m.model3d_controls({}, { locale })}>
	{#if controls.clips.length}
		<button type="button" class="tool-key" title={hint(playLabel, "Space")} aria-label={playLabel} onclick={() => onChange((scene) => (scene.playing = !scene.playing))}>
			{#if controls.playing}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}
		</button>
		{#if controls.clips.length > 1}
			<button
				bind:this={anchors.clip}
				type="button"
				class="tool-key clip-key"
				title={m.model3d_animation({}, { locale })}
				aria-label={`${m.model3d_animation({}, { locale })}: ${controls.clip}`}
				aria-haspopup="menu"
				aria-expanded={open === "clip"}
				onclick={() => toggle("clip")}
			>
				<span class="min-w-0 truncate">{controls.clip}</span>
				<ChevronDown class="h-3 w-3 shrink-0" />
			</button>
		{/if}
		<div class="toolbar-divider"></div>
	{/if}
	{#if !reducedMotion}
		<button
			type="button"
			class="tool-key"
			title={hint(m.model3d_spin({}, { locale }), "R")}
			aria-label={m.model3d_spin({}, { locale })}
			aria-pressed={controls.spinning}
			onclick={() => onChange((scene) => (scene.spinning = !scene.spinning))}
		>
			<Rotate3d class="h-4 w-4" />
		</button>
	{/if}
	<button
		bind:this={anchors.shading}
		type="button"
		class="tool-key"
		class:is-inspecting={inspecting}
		title={m.model3d_view_mode({}, { locale })}
		aria-label={m.model3d_view_mode({}, { locale })}
		aria-haspopup="menu"
		aria-expanded={open === "shading"}
		onclick={() => toggle("shading")}
	>
		<Contrast class="h-4 w-4" />
	</button>
	<button
		type="button"
		class="tool-key"
		title={hint(m.model3d_reset_view({}, { locale }), "0")}
		aria-label={m.model3d_reset_view({}, { locale })}
		onclick={() => onChange((scene) => scene.home())}
	>
		<RotateCcw class="h-4 w-4" />
	</button>
	<div class="toolbar-divider"></div>
	<button
		bind:this={anchors.info}
		type="button"
		class="tool-key"
		title={m.model3d_info({}, { locale })}
		aria-label={m.model3d_info({}, { locale })}
		aria-expanded={open === "info"}
		onclick={() => toggle("info")}
	>
		<Info class="h-4 w-4" />
	</button>
	<button
		bind:this={anchors.more}
		type="button"
		class="tool-key"
		title={m.model3d_more({}, { locale })}
		aria-label={m.model3d_more({}, { locale })}
		aria-haspopup="menu"
		aria-expanded={open === "more"}
		onclick={() => toggle("more")}
	>
		<Ellipsis class="h-4 w-4" />
	</button>
	{#if fullscreen !== null}
		<button type="button" class="tool-key" title={hint(fullscreenLabel, "F")} aria-label={fullscreenLabel} onclick={onFullscreen}>
			{#if fullscreen}<Minimize2 class="h-4 w-4" />{:else}<Maximize2 class="h-4 w-4" />{/if}
		</button>
	{/if}
</div>

<AdaptivePopover open={open === "clip"} anchor={anchors.clip} placement="top-start" width={200} label={m.model3d_animation({}, { locale })} onClose={() => (open = null)}>
	<div role="menu" aria-label={m.model3d_animation({}, { locale })}>
		{#each controls.clips as clip (clip)}
			{@render option(clip, clip === controls.clip, () =>
				choose((scene) => {
					scene.clip = clip;
					scene.playing = true;
				}),
			)}
		{/each}
	</div>
</AdaptivePopover>

<AdaptivePopover open={open === "shading"} anchor={anchors.shading} placement="top-start" width={180} label={m.model3d_view_mode({}, { locale })} onClose={() => (open = null)}>
	<div role="menu" aria-label={m.model3d_view_mode({}, { locale })}>
		{#each controls.shadings as shading (shading)}
			{@render option(shadingLabels[shading](), shading === controls.shading, () => choose((scene) => (scene.shading = shading)))}
		{/each}
		<div class="my-1 h-px bg-border-subtle" role="separator"></div>
		{@render option(m.model3d_wireframe({}, { locale }), controls.wireframe, () => choose((scene) => (scene.wireframe = !scene.wireframe)), "menuitemcheckbox")}
	</div>
</AdaptivePopover>

<AdaptivePopover open={open === "info"} anchor={anchors.info} placement="top-start" width={240} label={m.model3d_info({}, { locale })} onClose={() => (open = null)}>
	<dl class="model-facts">
		{#each facts as [label, value] (label)}
			<dt>{label}</dt>
			<dd>{value}</dd>
		{/each}
	</dl>
</AdaptivePopover>

<AdaptivePopover open={open === "more"} anchor={anchors.more} placement="top-start" width={180} label={m.model3d_more({}, { locale })} onClose={() => (open = null)}>
	<div role="menu" aria-label={m.model3d_more({}, { locale })}>
		<div class="px-2 pb-0.5 pt-1 text-[11px] text-text-placeholder">{m.model3d_views({}, { locale })}</div>
		{#each views as view (view)}
			<button type="button" role="menuitem" class="model-option" onclick={() => choose((scene) => scene.look(MODEL_VIEW_PRESETS[view]))}>
				<span class="min-w-0 flex-1 truncate">{viewLabels[view]()}</span>
			</button>
		{/each}
		<div class="my-1 h-px bg-border-subtle" role="separator"></div>
		<button
			type="button"
			role="menuitem"
			class="model-option"
			onclick={() => {
				open = null;
				onSnapshot();
			}}
		>
			<ImageDown class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
			<span class="min-w-0 flex-1 truncate">{m.model3d_save_image({}, { locale })}</span>
		</button>
	</div>
</AdaptivePopover>

<style>
	.model-toolbar {
		position: absolute;
		right: 12px;
		bottom: 16px;
		left: 12px;
		z-index: 10;
		width: max-content;
		max-width: calc(100% - 24px);
		margin-inline: auto;
	}

	.clip-key {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 132px;
		padding: 0 6px 0 8px;
		gap: 4px;
		font-size: 12px;
	}

	.is-inspecting {
		color: var(--brand-muted-fg);
	}

	.model-option {
		display: flex;
		min-height: 40px;
		width: 100%;
		align-items: center;
		gap: 8px;
		border-radius: 6px;
		padding: 0 8px;
		color: var(--text-secondary);
		text-align: left;
		font-size: 13px;
		transition: background-color 90ms, color 90ms;
	}

	.model-option[aria-checked="true"] {
		color: var(--text-primary);
	}

	@media (hover: hover) {
		.model-option:hover {
			background: var(--bg-hover);
			color: var(--text-primary);
		}
	}

	.model-facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 16px;
		margin: 0;
		padding: 8px;
		font-size: 12px;
	}

	.model-facts dt {
		color: var(--text-tertiary);
	}

	.model-facts dd {
		margin: 0;
		color: var(--text-primary);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}

	@media (pointer: coarse) {
		.model-toolbar {
			--tool-key-size: 36px;
		}

	}

	@media (min-width: 960px) {
		.model-option {
			min-height: 28px;
			font-size: 12px;
		}
	}
</style>
