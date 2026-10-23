<script lang="ts">
import type { BoardAssetSource } from "@neta-art/cohub/board";
import type { BoardLod } from "@neta-art/cohub/board/render";
import {
	BOARD_DEVICE_TIERS,
	type BoardDeviceTier,
	type BoardStage,
	boardDeviceBudget,
	readBoardDeviceSignals,
	runBoardStageBench,
} from "@neta-art/cohub/board/stage";
import { page } from "$app/state";
import { cohubPixiRuntime } from "$lib/board/runtime/board-runtime";
import { getTheme, setTheme, type ThemeMode } from "$lib/theme.svelte";
import { RESOLVED_THEMES } from "$lib/theme-registry";
import {
	BENCH_SCENARIOS,
	type BenchScenario,
	boardGalleryDocument,
	GALLERY_ASSET_PREFIX,
} from "./gallery";
import LodTuner from "./LodTuner.svelte";

const assetOrigin = page.url.searchParams.get("assets");
const bench = Number(page.url.searchParams.get("bench") ?? 0) || undefined;
const isMobile = page.url.searchParams.has("mobile");
const requested = page.url.searchParams.get("scenario");
const scenario = BENCH_SCENARIOS.find((name) => name === requested) as
	| BenchScenario
	| undefined;
const document = boardGalleryDocument({ bench, scenario });
if (bench) {
	for (const key of Object.keys(localStorage))
		if (key.startsWith("cohub:board:view")) localStorage.removeItem(key);
}

const requestedTier = page.url.searchParams.get("tier");
const deviceTier = BOARD_DEVICE_TIERS.find((tier) => tier === requestedTier) as
	| BoardDeviceTier
	| undefined;
const device = boardDeviceBudget(readBoardDeviceSignals(), deviceTier);
const base = device.lod;
const param = (key: keyof BoardLod) => {
	const value = Number(page.url.searchParams.get(key));
	return page.url.searchParams.has(key) && Number.isFinite(value)
		? value
		: base[key];
};
let lod = $state<BoardLod>({
	media: param("media"),
	text: param("text"),
	card: param("card"),
	live: param("live"),
});
let stage = $state.raw<BoardStage | null>(null);
$effect(() => {
	const current = stage;
	if (!current) return;
	const target = window as Window & {
		boardBench?: () => ReturnType<typeof runBoardStageBench>;
	};
	target.boardBench = () => runBoardStageBench(current, { since: 0 });
	return () => {
		delete target.boardBench;
	};
});

const resolve = async (path: string) =>
	assetOrigin && path.startsWith(GALLERY_ASSET_PREFIX)
		? new URL(path.slice(GALLERY_ASSET_PREFIX.length), assetOrigin).toString()
		: null;
const assetSource: BoardAssetSource = {
	resolveFileUrl: resolve,
	resolvePlaybackUrl: resolve,
};
const runtime = cohubPixiRuntime.load();
</script>

<div class="dev-board">
	<select
		class="dev-theme"
		aria-label="Theme"
		value={getTheme()}
		onchange={(event) => setTheme(event.currentTarget.value as ThemeMode)}
	>
		{#each RESOLVED_THEMES as theme (theme)}<option value={theme}>{theme}</option>{/each}
	</select>
	{#await runtime then module}
		<module.default
			path="dev/gallery.board"
			boardId="dev-gallery"
			{document}
			playback={null}
			spaceId="dev-gallery"
			{assetSource}
			{isMobile}
			{lod}
			deviceTier={device.tier}
			onStageReady={(next) => {
				stage = next;
			}}
			onCommit={() => {
			}}
		/>
	{/await}
	<LodTuner bind:lod {stage} tier={device.tier} />
</div>

<style>
	.dev-board {
		position: fixed;
		inset: 0;
		background: var(--bg-primary);
	}
	.dev-theme {
		position: absolute;
		top: 8px;
		left: 50%;
		z-index: 50;
		transform: translateX(-50%);
		font-size: 12px;
	}
</style>
