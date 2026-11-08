import { type AppDevice, parseAppDevices } from "@cohub/protocol/app-devices";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

// Cohub asks first: in a shared frame origin the browser cannot tell Apps apart.
const STORAGE_KEY_PREFIX = "cohub:app:devices:v1";

const storageKey = (appId: string, viewerUuid: string | null) =>
	`${STORAGE_KEY_PREFIX}:${viewerUuid ?? "anonymous"}:${appId}`;

export function readAppDeviceConsent(
	appId: string,
	viewerUuid: string | null,
): AppDevice[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(storageKey(appId, viewerUuid));
		return raw ? parseAppDevices(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

export function writeAppDeviceConsent(
	appId: string,
	viewerUuid: string | null,
	devices: readonly AppDevice[],
) {
	if (typeof localStorage === "undefined") return;
	try {
		const normalized = parseAppDevices(devices);
		if (normalized.length === 0)
			localStorage.removeItem(storageKey(appId, viewerUuid));
		else
			localStorage.setItem(
				storageKey(appId, viewerUuid),
				JSON.stringify(normalized),
			);
	} catch {}
}

const DEVICE_LABEL: Record<AppDevice, (locale: Locale) => string> = {
	camera: (locale) => m.app_devices_camera({}, { locale }),
	microphone: (locale) => m.app_devices_microphone({}, { locale }),
	screen: (locale) => m.app_devices_screen({}, { locale }),
	location: (locale) => m.app_devices_location({}, { locale }),
};

export function appDevicesLabel(devices: readonly AppDevice[], locale: Locale) {
	return new Intl.ListFormat(locale, { type: "conjunction" }).format(
		devices.map((device) => DEVICE_LABEL[device](locale)),
	);
}
