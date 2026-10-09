import type { AppRuntimeInvocationContext } from "@neta-art/cohub";

export type WorkspaceAppOpenContext = {
	source: "desktop_command" | "user" | "route";
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	/** The workspace file this open hands to a file-handling App. */
	file?: { path: string };
};

export type WorkspaceAppInvocation = AppRuntimeInvocationContext & {
	surface: "app" | "overlay";
	source: WorkspaceAppOpenContext["source"];
	spaceId: string;
};

export function createWorkspaceAppInvocation(
	spaceId: string,
	input: WorkspaceAppOpenContext,
	surface: WorkspaceAppInvocation["surface"] = "app",
): WorkspaceAppInvocation {
	return {
		surface,
		source: input.source,
		spaceId,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.turnId ? { turnId: input.turnId } : {}),
		...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
		...(input.file ? { file: { path: input.file.path } } : {}),
		// A fresh id per open lets a running App tell a repeat open from a context update.
		id: crypto.randomUUID(),
	};
}
