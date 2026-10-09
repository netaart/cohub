import type { BoardPatch, BoardPlaybackCommand, BoardPlaybackSnapshot } from "@cohub/protocol";
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import type { BoardDocument } from "@neta-art/cohub/board";
import type {
	BoardAutomationActivity,
	BoardCollaboratorProfile,
} from "$lib/board/board-activity";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
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
		call?: { ok: true; result?: unknown } | { ok: false; code: string; message: string };
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
	onPlayback?: (command: BoardPlaybackCommand) => Promise<BoardPlaybackSnapshot | null>;
	onRetrySync?: () => void | Promise<void>;
	onViewStateChange?: (state: BoardRuntimeViewState) => void;
	onOpenFile?: (path: string) => void | Promise<void>;
};

const loadCohubPixiRuntime = createLazyModuleLoader(() => import("$lib/components/board/BoardPanel.svelte"));

export const cohubPixiRuntime = {
	id: "cohub-pixi",
	load: loadCohubPixiRuntime,
} as const;
