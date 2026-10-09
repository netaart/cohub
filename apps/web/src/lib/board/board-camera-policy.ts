export type BoardCameraPolicy = "follow" | "free";

const STORAGE_KEY = "cohub:board:camera-policy";

export function readBoardCameraPolicy(): BoardCameraPolicy {
	if (typeof localStorage === "undefined") return "follow";
	try {
		return localStorage.getItem(STORAGE_KEY) === "free" ? "free" : "follow";
	} catch {
		return "follow";
	}
}

export function writeBoardCameraPolicy(policy: BoardCameraPolicy) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, policy);
	} catch {}
}
