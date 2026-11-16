<script lang="ts">
import { type BoardAssetSource, parseBoardLaunch } from "@neta-art/cohub/board";
import {
	type BoardStage,
	boardDeviceBudget,
	readBoardDeviceSignals,
	runBoardStageBench,
} from "@neta-art/cohub/board/stage";
import { page } from "$app/state";
import { cohubPixiRuntime } from "$lib/board/runtime/board-runtime";
import { depthDemoDocument, depthScriptUrl } from "./demo";

const document = depthDemoDocument({
	still: page.url.searchParams.has("still"),
	only: page.url.searchParams.get("only")?.split(","),
});
const mode = page.url.searchParams.has("edit")
	? "edit"
	: page.url.searchParams.has("view")
		? "view"
		: "play";
const isMobile = page.url.searchParams.has("mobile");
const device = boardDeviceBudget(readBoardDeviceSignals());
const assetSource: BoardAssetSource = {
	resolveFile: async (path) => {
		const url = depthScriptUrl(path);
		return url ? { url } : null;
	},
};
const runtime = cohubPixiRuntime.load();
let stage = $state.raw<BoardStage | null>(null);
$effect(() => {
	const current = stage;
	if (!current) return;
	const target = window as Window & {
		boardStage?: BoardStage;
		boardBench?: () => ReturnType<typeof runBoardStageBench>;
	};
	target.boardStage = current;
	target.boardBench = () => runBoardStageBench(current, { since: 0 });
	return () => {
		delete target.boardStage;
		delete target.boardBench;
	};
});
</script>

<div class="dev-depth">
	{#await runtime then module}
		<module.default
			path="dev/depth.board"
			boardId="dev-depth"
			{document}
			playback={null}
			scope={{ kind: "app", appId: "dev-depth", assetSource }}
			{mode}
			launch={parseBoardLaunch(page.url.hash)}
			{isMobile}
			lod={device.lod}
			deviceTier={device.tier}
			onStageReady={(next) => {
				stage = next;
			}}
			onCommit={() => {}}
			onViewStateChange={(state) => {
				(window as Window & { boardSelection?: string[] }).boardSelection =
					state.selectedNodes.map((node) => node.id);
			}}
		/>
	{/await}
</div>

<style>
	.dev-depth {
		position: fixed;
		inset: 0;
		background: var(--bg-primary);
	}
</style>
