import { getContext, setContext } from "svelte";
import type { ResolveWorkspaceAsset } from "#lib/workspace-assets.ts";

const workspaceAssetContextKey = Symbol("cohub.markdown.workspace-asset");

/**
 * Makes the workspace asset resolver available to Markdown flows rendered
 * underneath this component. Chat injects it once at the panel root so the
 * resolver doesn't have to be threaded through every timeline component.
 */
export function provideMarkdownWorkspaceAsset(
	resolve: ResolveWorkspaceAsset | undefined,
) {
	setContext(workspaceAssetContextKey, resolve);
}

export function useMarkdownWorkspaceAsset(): ResolveWorkspaceAsset | undefined {
	return getContext<ResolveWorkspaceAsset | undefined>(
		workspaceAssetContextKey,
	);
}
