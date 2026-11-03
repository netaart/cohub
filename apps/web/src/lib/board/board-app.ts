import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppDetailResponse, AppMeta } from "@neta-art/cohub";
import { type BoardSceneItem, boardAppMetadata } from "@neta-art/cohub/board";
import type { BoardAppMetadata } from "@neta-art/cohub/board/editor";
import { appCoverUrl, appThemeColor } from "$lib/app-page-meta";
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

export type BoardAppMeta = BoardAppMetadata;

type BoardAppFace = Pick<BoardAppMeta, "cover" | "themeColor">;

export function boardAppFace(face: {
	cover?: unknown;
	themeColor?: unknown;
}): BoardAppFace {
	const { cover, themeColor } = face;
	return {
		...(typeof cover === "string" &&
		cover.length <= 2048 &&
		cover.startsWith("https://")
			? { cover }
			: {}),
		...(typeof themeColor === "string" &&
		themeColor.length > 0 &&
		themeColor.length <= 64
			? { themeColor }
			: {}),
	};
}

export function boardAppMeta(item: BoardSceneItem): BoardAppMeta | null {
	const meta = boardAppMetadata(item);
	if (!meta) return null;
	const { cover: _cover, themeColor: _themeColor, ...identity } = meta;
	return { ...identity, ...boardAppFace(meta) };
}

export function boardAppCover(meta: AppMeta | null | undefined): BoardAppFace {
	return boardAppFace({
		cover: appCoverUrl(meta),
		themeColor: appThemeColor(meta),
	});
}

export type BoardAppDetails = {
	load(appId: string): Promise<AppDetailResponse | null>;
	peek(appId: string): AppDetailResponse | null;
};

export function createBoardAppDetailLoader(): BoardAppDetails {
	const requests = new Map<string, Promise<AppDetailResponse | null>>();
	const settled = new Map<string, AppDetailResponse>();
	return {
		load(appId) {
			let request = requests.get(appId);
			if (!request) {
				request = sdk.apps
					.get(appId)
					.catch((cause: unknown) => {
						const status = (cause as { status?: unknown } | null)?.status;
						if (status !== 401 && status !== 403) throw cause;
						return sdk.apps.getPublicById(appId);
					})
					.then((detail) => {
						settled.set(appId, detail);
						return detail;
					})
					.catch(() => {
						requests.delete(appId);
						return null;
					});
				requests.set(appId, request);
			}
			return request;
		},
		peek: (appId) => settled.get(appId) ?? null,
	};
}

// Board documents are user-written: only open http(s).
export function boardAppOpenUrl(
	meta: BoardAppMeta,
	detail: AppDetailResponse | null,
): string | null {
	try {
		const url = new URL(detail?.publicUrl ?? meta.url, location.origin);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.href
			: null;
	} catch {
		return null;
	}
}
