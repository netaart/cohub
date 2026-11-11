import type { WorkspaceScope } from "$lib/features/space/modules/workspace-scope";
import { librarySpaceAt } from "$lib/library-routes";
import {
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
} from "$lib/space-routes";
import { libraryInbox } from "./library-inbox.svelte";

export const libraryWorkspaceScope: WorkspaceScope = {
	kind: "library",
	sessionRoute: buildSpaceSessionRoute,
	newSessionRoute: buildSpaceNewSessionRoute,
	spaceAt: (url) => librarySpaceAt(url),
	knownSpace: (spaceId) => libraryInbox.spaceSummary(spaceId),
};
