import type {
	SessionRecord,
	SpaceRecord,
	UserSessionSpaceSummary,
} from "@neta-art/cohub";
import {
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
	buildUserNewSessionRoute,
	buildUserSessionRoute,
	parseUserSessionRoute,
} from "$lib/space-routes";
import { resolveWorkspaceSpaceId } from "$lib/workspace-route";

/** What differs between a workspace mounted in its Space and in the Chats inbox. */
export type WorkspaceScope = {
	kind: "space" | "chats";
	sessionRoute: (spaceId: string, sessionId: string) => string;
	newSessionRoute: (spaceId: string) => string;
	/** Space shown at `url` by this same instance; null when it would unmount. */
	spaceAt: (
		url: URL,
		localSpaceOf?: (sessionId: string) => string | null,
	) => string | null;
	onActiveSession?: (session: SessionRecord, space: SpaceRecord | null) => void;
	pickSpace?: () => void;
	knownSpace?: (spaceId: string) => UserSessionSpaceSummary | null;
	knownSession?: (sessionId: string) => SessionRecord | null;
};

export const spaceWorkspaceScope: WorkspaceScope = {
	kind: "space",
	sessionRoute: buildSpaceSessionRoute,
	newSessionRoute: buildSpaceNewSessionRoute,
	spaceAt: (url) => resolveWorkspaceSpaceId({ pathname: url.pathname }),
};

export function createChatsWorkspaceScope(input: {
	spaceOfSession: (sessionId: string) => string | null;
	onActiveSession?: WorkspaceScope["onActiveSession"];
	pickSpace?: WorkspaceScope["pickSpace"];
	knownSpace?: WorkspaceScope["knownSpace"];
	knownSession?: WorkspaceScope["knownSession"];
}): WorkspaceScope {
	return {
		kind: "chats",
		sessionRoute: (_spaceId, sessionId) => buildUserSessionRoute(sessionId),
		newSessionRoute: buildUserNewSessionRoute,
		spaceAt: (url, localSpaceOf) => {
			const route = parseUserSessionRoute(url);
			if (!route) return null;
			if (route.kind === "new") return route.spaceId;
			return (
				localSpaceOf?.(route.sessionId) ?? input.spaceOfSession(route.sessionId)
			);
		},
		onActiveSession: input.onActiveSession,
		pickSpace: input.pickSpace,
		knownSpace: input.knownSpace,
		knownSession: input.knownSession,
	};
}
