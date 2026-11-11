import { resolveOpenSurface } from "@cohub/protocol/desktop-command";
import type { AppMeta } from "@neta-art/cohub";
import {
	createWorkspaceAppInvocation,
	type WorkspaceAppInvocation,
	type WorkspaceAppOpenContext,
} from "./workspace-app-context";

export const OVERLAY_LIMIT_MESSAGE =
	"Too many overlay surfaces are already open.";

export type WorkspaceAppLaunch = {
	appId: string;
	name: string;
	meta?: AppMeta | null;
};

export type PublishedAppOpenInput = {
	appId: string;
	label?: string;
	launch?: { search?: string; hash?: string } | null;
	openContext: WorkspaceAppOpenContext;
	/**
	 * Already-resolved surface. When set, `meta` is ignored — desktop commands
	 * pass this so a compact `window` on the wire stays a window.
	 */
	surface?: "window" | "overlay";
	/** Used when `surface` is omitted. `null` means "known, not overlay". */
	meta?: AppMeta | null;
};

export type PublishedAppOpenResult =
	| { ok: true; surface: "window" | "overlay" }
	| { ok: false; reason: "overlay_limit" | "cancelled" };

export type PublishedAppOpenPorts = {
	spaceId: string;
	isCurrent?: () => boolean;
	/** Fetches presentation meta when neither `surface` nor `meta` is given. */
	loadMeta?: (appId: string) => Promise<AppMeta | null>;
	openWindow: (input: {
		appId: string;
		label?: string;
		launch?: { search?: string; hash?: string } | null;
		openContext: WorkspaceAppOpenContext;
	}) => void;
	openOverlay: (input: {
		appId: string;
		label?: string;
		invocation: WorkspaceAppInvocation;
	}) => "opened" | "activated" | "limit";
};

/**
 * Opens a published App on the desktop using the same surface rule as
 * `cohub desktop open`: an explicit request wins, then the App's published
 * `meta.presentation.surface`, otherwise a preview tab.
 */
export async function openPublishedApp(
	input: PublishedAppOpenInput,
	ports: PublishedAppOpenPorts,
): Promise<PublishedAppOpenResult> {
	let declared: unknown =
		input.surface === undefined ? input.meta?.presentation?.surface : undefined;
	if (
		input.surface === undefined &&
		input.meta === undefined &&
		ports.loadMeta
	) {
		try {
			declared = (await ports.loadMeta(input.appId))?.presentation?.surface;
		} catch {
			declared = undefined;
		}
	}
	if (ports.isCurrent && !ports.isCurrent())
		return { ok: false, reason: "cancelled" };
	if (resolveOpenSurface(input.surface, declared) === "overlay") {
		const opened = ports.openOverlay({
			appId: input.appId,
			label: input.label,
			invocation: createWorkspaceAppInvocation(
				ports.spaceId,
				input.openContext,
				"overlay",
			),
		});
		if (opened === "limit") return { ok: false, reason: "overlay_limit" };
		return { ok: true, surface: "overlay" };
	}
	ports.openWindow({
		appId: input.appId,
		label: input.label,
		launch: input.launch ?? null,
		openContext: input.openContext,
	});
	return { ok: true, surface: "window" };
}
