import type { WorkspaceScope } from "#lib/features/space/modules/workspace-scope.ts";
import { librarySpaceAt } from "#lib/library-routes.ts";
import {
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
} from "#lib/space-routes.ts";
import { libraryInbox } from "./library-inbox.svelte.ts";

export const libraryWorkspaceScope: WorkspaceScope = {
	kind: "library",
	sessionRoute: buildSpaceSessionRoute,
	newSessionRoute: buildSpaceNewSessionRoute,
	spaceAt: (url) => librarySpaceAt(url),
	knownSpace: (spaceId) => libraryInbox.spaceSummary(spaceId),
};
