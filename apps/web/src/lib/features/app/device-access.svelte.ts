import {
	type AppDevice,
	type AppDevicesStatus,
	appDeviceNeedsConsent,
	parseAppDevices,
} from "@cohub/protocol/app-devices";
import { untrack } from "svelte";
import {
	readAppDeviceConsent,
	writeAppDeviceConsent,
} from "$lib/features/app/app-devices";
import { hostAllowsMediaCapture } from "$lib/host-bridge";
import { authStore } from "$lib/stores/auth.svelte";

function hostSupports(device: AppDevice) {
	if (typeof navigator === "undefined") return false;
	if (device === "screen")
		return typeof navigator.mediaDevices?.getDisplayMedia === "function";
	if (device === "location") return Boolean(navigator.geolocation);
	return hostAllowsMediaCapture();
}

export function createAppDeviceAccess(input: {
	appId: string;
	declared: () => unknown;
	supported: boolean;
	reply: (requestId: string, status: AppDevicesStatus) => void;
}) {
	const declared = $derived(parseAppDevices(input.declared()));
	const supports = (device: AppDevice) =>
		input.supported && declared.includes(device) && hostSupports(device);
	const devicesFor = (consent: readonly AppDevice[]) =>
		declared.filter(
			(device) =>
				supports(device) &&
				(!appDeviceNeedsConsent(device) || consent.includes(device)),
		);

	let consent = $state<AppDevice[]>(
		readAppDeviceConsent(input.appId, authStore.userUuid),
	);
	const allowed = $derived(devicesFor(consent));
	let loaded = untrack(() => allowed);
	let reloadKey = $state(0);
	let pending = $state<{ requestId: string; devices: AppDevice[] } | null>(
		null,
	);

	function reload() {
		loaded = devicesFor(consent);
		reloadKey += 1;
	}

	function setConsent(next: AppDevice[]) {
		consent = next;
		writeAppDeviceConsent(input.appId, authStore.userUuid, next);
		reload();
	}

	$effect(() => {
		const viewerUuid = authStore.userUuid;
		void authStore.ensureLoaded();
		const stored = readAppDeviceConsent(input.appId, viewerUuid);
		untrack(() => {
			if (stored.join() === consent.join()) return;
			consent = stored;
			if (devicesFor(stored).join() !== loaded.join()) reload();
		});
	});

	return {
		get allowed() {
			return allowed;
		},
		get granted() {
			return allowed.filter(appDeviceNeedsConsent);
		},
		get declared() {
			return declared;
		},
		get pending() {
			return pending;
		},
		get reloadKey() {
			return reloadKey;
		},
		request(requestId: string, devices: AppDevice[]) {
			const wanted = parseAppDevices(devices);
			if (wanted.length === 0 || !wanted.every(supports))
				return input.reply(requestId, "unavailable");
			const ask = wanted.filter((device) => !loaded.includes(device));
			if (ask.length === 0) return input.reply(requestId, "granted");
			if (pending) input.reply(pending.requestId, "denied");
			pending = { requestId, devices: ask };
		},
		allow() {
			if (!pending) return;
			const devices = pending.devices;
			pending = null;
			setConsent([...new Set([...consent, ...devices])]);
		},
		deny() {
			if (!pending) return;
			input.reply(pending.requestId, "denied");
			pending = null;
		},
		turnOff(device: AppDevice) {
			setConsent(consent.filter((item) => item !== device));
		},
	};
}

export type AppDeviceAccess = ReturnType<typeof createAppDeviceAccess>;
