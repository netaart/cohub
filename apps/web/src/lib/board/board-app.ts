import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppDetailResponse } from "@neta-art/cohub";
import type { BoardSceneItem } from "@neta-art/cohub/board";
import { sdk } from "$lib/sdk";

export type AppNavigationHandler = (
	message: AppNavigationOpenMessage,
) => Promise<{
	handled: boolean;
	reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
	call?:
		| { ok: true; result?: unknown }
		| { ok: false; code: string; message: string };
}>;

export type BoardAppMeta = {
	appId: string;
	ref: string;
	url: string;
	name: string;
	icon?: string;
};

export function boardAppMeta(item: BoardSceneItem): BoardAppMeta | null {
	if (item.type !== "frame" || !item.metadata) return null;
	const value = (item.metadata as { cohubApp?: unknown }).cohubApp;
	if (!value || typeof value !== "object") return null;
	const meta = value as Partial<BoardAppMeta>;
	if (!meta.appId || !meta.ref || !meta.url || !meta.name) return null;
	return {
		appId: meta.appId,
		ref: meta.ref,
		url: meta.url,
		name: meta.name,
		icon: meta.icon,
	};
}

export function createBoardAppDetailLoader(): (
	appId: string,
) => Promise<AppDetailResponse | null> {
	const details = new Map<string, Promise<AppDetailResponse | null>>();
	return (appId) => {
		let request = details.get(appId);
		if (!request) {
			request = sdk.apps
				.get(appId)
				.catch((cause: unknown) => {
					const status = (cause as { status?: unknown } | null)?.status;
					if (status !== 401 && status !== 403) throw cause;
					return sdk.apps.getPublicById(appId);
				})
				.catch(() => {
					details.delete(appId);
					return null;
				});
			details.set(appId, request);
		}
		return request;
	};
}
