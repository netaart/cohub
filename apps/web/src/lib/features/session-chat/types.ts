import type { ResolveWorkspaceAsset } from "#lib/workspace-assets.ts";
import type { WorkspaceFileLinkTarget } from "#lib/workspace-file-links.ts";

/** Discriminated chat route — no contradictory fields. */
export type SessionChatRoute =
	| { kind: "none" }
	| { kind: "new" }
	| { kind: "session"; sessionId: string; turnSequence: number | null };

export type SessionChatAccess = {
	spaceLoadError: string;
	spaceHasMinimalAccess: boolean;
	canCreateSession: boolean;
	bootstrapping: boolean;
};

export type SessionChatContext = {
	spaceId: string;
	route: SessionChatRoute;
	access: SessionChatAccess;
};

/** Stable environment ports — set at host construction, not route snapshots. */
export type SessionChatEnvironment = {
	openPath: (target: string | WorkspaceFileLinkTarget) => void | Promise<void>;
	/** Resolves workspace-relative markdown assets (images, media). */
	resolveWorkspaceAsset?: ResolveWorkspaceAsset;
	router: {
		toSession: (
			sessionId: string,
			opts?: { replace?: boolean },
		) => Promise<void>;
		toTurn: (sessionId: string, sequence: number) => Promise<void>;
		toNewSession: (opts?: { replace?: boolean }) => Promise<void>;
	};
};

export type SelectedModel = {
	provider: string;
	id: string;
	name?: string;
};
