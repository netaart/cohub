import type {
	BoardPatch,
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
} from "@cohub/protocol";
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import type { BoardDocument } from "@neta-art/cohub/board";
import type { BoardLod } from "@neta-art/cohub/board/render";
import type { BoardDeviceTier, BoardStage } from "@neta-art/cohub/board/stage";
import type {
	BoardAutomationActivity,
	BoardCollaboratorProfile,
} from "$lib/board/board-activity";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import { isBoardFile } from "$lib/board/board-file";
import { createLazyModuleLoader } from "$lib/lazy-module";

export type BoardRuntimeViewState = {
	path: string;
	visibleRect: { x: number; y: number; width: number; height: number } | null;
	selectedNodes: Array<{ id: string; type: string; title?: string }>;
};

export type BoardRuntimeMode = "edit" | "view";

export type BoardCommitHandler = (patch: BoardPatch) => void | Promise<void>;

export type BoardRuntimeProps = {
	path: string;
	boardId: string;
	document: BoardDocument;
	playback: BoardPlaybackSnapshot | null;
	spaceId: string;
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
	mode?: BoardRuntimeMode;
	assetSource?: BoardAssetSource;
	active?: boolean;
	immersive?: boolean;
	syncError?: string | null;
	isMobile?: boolean;
	collaborators?: Map<string, BoardCollaboratorProfile>;
	activities?: BoardAutomationActivity[];
	onOpenActivity?: (activity: BoardAutomationActivity) => void | Promise<void>;
	onCommit?: BoardCommitHandler;
	onPlayback?: (
		command: BoardPlaybackCommand,
	) => Promise<BoardPlaybackSnapshot | null>;
	onRetrySync?: () => void | Promise<void>;
	onViewStateChange?: (state: BoardRuntimeViewState) => void;
	onOpenFile?: (path: string) => void | Promise<void>;
	/** Overrides the device's level-of-detail thresholds. */
	lod?: BoardLod;
	deviceTier?: BoardDeviceTier;
	onStageReady?: (stage: BoardStage | null) => void;
};

const loadCohubPixiRuntime = createLazyModuleLoader(
	() => import("$lib/components/board/BoardPanel.svelte"),
);

export const cohubPixiRuntime = {
	id: "cohub-pixi",
	load: loadCohubPixiRuntime,
} as const;

export function preloadBoardRuntime(path: string) {
	if (isBoardFile(path)) void loadCohubPixiRuntime().catch(() => undefined);
}
