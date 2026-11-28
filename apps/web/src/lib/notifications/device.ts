import { sdk } from "#lib/sdk.ts";

const DEVICE_ID_KEY = "cohub:device-id";
let deviceId: string | null = null;

export function getDeviceId(): string {
	if (deviceId) return deviceId;
	try {
		deviceId = localStorage.getItem(DEVICE_ID_KEY);
		if (!deviceId) {
			deviceId = crypto.randomUUID().replaceAll("-", "");
			localStorage.setItem(DEVICE_ID_KEY, deviceId);
		}
	} catch {
		deviceId ??= crypto.randomUUID().replaceAll("-", "");
	}
	return deviceId;
}

export function isDeviceAttended() {
	return document.visibilityState === "visible" && document.hasFocus();
}

export function trackDeviceAttention(): () => void {
	const id = getDeviceId();
	const sync = () =>
		sdk.setDeviceState({ deviceId: id, visible: isDeviceAttended() });
	sync();
	document.addEventListener("visibilitychange", sync);
	window.addEventListener("focus", sync);
	window.addEventListener("blur", sync);
	return () => {
		document.removeEventListener("visibilitychange", sync);
		window.removeEventListener("focus", sync);
		window.removeEventListener("blur", sync);
	};
}
