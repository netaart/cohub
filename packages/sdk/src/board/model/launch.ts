import { BOARD_MAX_PITCH } from "@cohub/protocol/board-constants";
import { BOARD_ID_MAX_LENGTH } from "@cohub/protocol/board-model";
import { type BoardCameraState, clampZoom } from "./geometry.js";

/** `#focus=<itemId>`, `#view=<centerX>,<centerY>,<zoom>[,<pitch>,<bearing>]`, `#play=<animationId>&t=<ms>`; `&present` presents from the focused frame, or the first. */
export type BoardLaunch = {
	focus?: string;
	present?: boolean;
	view?: BoardCameraState;
	play?: { animationId: string; at: number };
};

const KEY = /^[^\s/]+$/;

function key(value: string | null): string | undefined {
	return value && value.length <= BOARD_ID_MAX_LENGTH && KEY.test(value) ? value : undefined;
}

function view(value: string | null): BoardCameraState | undefined {
	const parts = value?.split(",") ?? [];
	if ((parts.length !== 3 && parts.length !== 5) || parts.some((part) => part.trim() === "")) return undefined;
	const [centerX, centerY, zoom, pitch = 0, bearing = 0] = parts.map(Number) as [number, number, number, number?, number?];
	if (![centerX, centerY, zoom, pitch, bearing].every(Number.isFinite) || zoom <= 0) return undefined;
	const angled = Math.min(BOARD_MAX_PITCH, Math.max(0, pitch));
	return { centerX, centerY, zoom: clampZoom(zoom), ...(angled ? { pitch: angled } : {}), ...(bearing ? { bearing } : {}) };
}

export function parseBoardLaunch(hash: string): BoardLaunch | null {
	const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
	const launch: BoardLaunch = {};
	const focus = key(params.get("focus"));
	if (focus) launch.focus = focus;
	if (params.has("present")) launch.present = true;
	const camera = view(params.get("view"));
	if (camera) launch.view = camera;
	const animationId = key(params.get("play"));
	if (animationId) {
		const at = Number(params.get("t") ?? 0);
		launch.play = { animationId, at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0 };
	}
	return Object.keys(launch).length ? launch : null;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

export function formatBoardLaunch(launch: BoardLaunch | null | undefined): string {
	const parts: string[] = [];
	if (launch?.focus) parts.push(`focus=${encodeURIComponent(launch.focus)}`);
	else if (launch?.view) {
		const { centerX, centerY, zoom, pitch = 0, bearing = 0 } = launch.view;
		const angles = pitch || bearing ? `,${round(pitch, 1)},${round(bearing, 1)}` : "";
		parts.push(`view=${round(centerX, 1)},${round(centerY, 1)},${round(clampZoom(zoom), 4)}${angles}`);
	}
	if (launch?.present) parts.push("present");
	if (launch?.play) {
		parts.push(`play=${encodeURIComponent(launch.play.animationId)}`);
		if (launch.play.at > 0) parts.push(`t=${Math.round(launch.play.at)}`);
	}
	return parts.length ? `#${parts.join("&")}` : "";
}
