import { createActiveFsClient } from "#lib/features/space/modules/active-fs-client.ts";
import { sdk } from "#lib/sdk.ts";
import type { ResolveWorkspaceAsset } from "#lib/workspace-assets.ts";

/**
 * Resolves workspace-relative markdown assets against a Space's live files.
 * Used by preview surfaces that have a Space but no file workspace controller.
 */
export function createSpaceWorkspaceAssetResolver(
	spaceId: string,
): ResolveWorkspaceAsset {
	const { resolveAsset } = createActiveFsClient({
		spaceId,
		source: { kind: "live" },
	});
	return Object.assign(resolveAsset, {
		onChange: (listener: (path: string) => void) =>
			sdk.space(spaceId).files.onUrlChange(listener),
	});
}
