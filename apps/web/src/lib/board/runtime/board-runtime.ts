import type {
	BoardPatch,
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
} from "@cohub/protocol";
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import type {
	BoardDocument,
	BoardImageSource,
	BoardLaunch,
} from "@neta-art/cohub/board";
import type { BoardAutomationActivity } from "@neta-art/cohub/board/presence";
import type { BoardLod } from "@neta-art/cohub/board/render";
import type { BoardDeviceTier, BoardStage } from "@neta-art/cohub/board/stage";
import type { BoardRoomChannel } from "#lib/board/board-app-room.svelte.ts";
import type { BoardAssetSource } from "#lib/board/board-asset-source.ts";
import type { BoardCollaboratorProfile } from "#lib/board/board-collaborator.ts";
import { isBoardFile } from "#lib/board/board-file.ts";
import { createLazyModuleLoader, pending } from "#lib/lazy-module.ts";

export type BoardRuntimeViewState = {
	path: string;
	visibleRect: { x: number; y: number; width: number; height: number } | null;
	selectedNodes: Array<{ id: string; type: string; title?: string }>;
};

export type BoardRuntimeMode = "edit" | "play" | "view";

export type BoardScope =
	| { kind: "space"; spaceId: string }
	| {
			kind: "checkpoint";
			spaceId: string;
			checkpointId: string;
			assetSource: BoardAssetSource;
	  }
	| { kind: "app"; appId: string; assetSource: BoardAssetSource }
	| { kind: "local"; assetSource: BoardAssetSource };

export type BoardCommitHandler = (
	patch: BoardPatch,
	document: BoardDocument,
) => void | Promise<void>;

export type BoardRuntimeProps = {
	path: string;
	boardId: string;
	document: BoardDocument;
	playback: BoardPlaybackSnapshot | null;
	scope: BoardScope;
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
	mode?: BoardRuntimeMode;
	onReset?: () => void;
	onTogglePlay?: () => void;
	presence?: BoardRoomChannel;
	launch?: BoardLaunch | null;
	shareUrl?: () => string;
	active?: boolean;
	keysWhenUsed?: boolean;
	syncError?: string | null;
	syncing?: boolean;
	isMobile?: boolean;
	collaborators?: Map<string, BoardCollaboratorProfile>;
	onOpenActivity?: (activity: BoardAutomationActivity) => void | Promise<void>;
	onCommit?: BoardCommitHandler;
	onPlayback?: (
		command: BoardPlaybackCommand,
	) => Promise<BoardPlaybackSnapshot | null>;
	onRetrySync?: () => void | Promise<void>;
	onViewStateChange?: (state: BoardRuntimeViewState) => void;
	onOpenFile?: (path: string) => void | Promise<void>;
	onOpenApp?: (app: { appId: string; name: string }) => void;
	onOpenSession?: (sessionId: string) => void | Promise<void>;
	/** Keeps a pasted image beside the Board instead of uploading it to Cohub. */
	storeImage?: (file: File) => Promise<BoardImageSource>;
	/** Overrides the device's level-of-detail thresholds. */
	lod?: BoardLod;
	deviceTier?: BoardDeviceTier;
	onStageReady?: (stage: BoardStage | null) => void;
};

const loadCohubPixiRuntime = createLazyModuleLoader(() =>
	import.meta.env.SSR
		? pending()
		: import("#lib/components/board/BoardPanel.svelte"),
);

export const cohubPixiRuntime = {
	id: "cohub-pixi",
	load: loadCohubPixiRuntime,
} as const;

export function preloadBoardRuntime(path: string) {
	if (isBoardFile(path)) void loadCohubPixiRuntime().catch(() => undefined);
}
