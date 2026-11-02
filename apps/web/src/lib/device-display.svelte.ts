import {
	type DeviceDisplayRef,
	type DeviceDisplayStatus,
	deviceDisplayRefSchema,
	deviceDisplayStatusSchema,
	HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS,
} from "@cohub/protocol/host-bridge";
import { HostBridgeErrorClass } from "@neta-art/cohub/host-bridge";
import {
	callHost,
	onHostEvent,
	readyHost,
	supportsHostCapability,
} from "$lib/host-bridge";

let status = $state<DeviceDisplayStatus | null>(null);
let subscribed: Promise<void> | null = null;

function subscribe(): Promise<void> {
	subscribed ??= (async () => {
		if (!(await readyHost()) || !supportsHostCapability("display")) return;
		const unsubscribe = onHostEvent((event) => {
			if (event.name !== "display.changed") return;
			const parsed = deviceDisplayStatusSchema.safeParse(event.payload);
			if (parsed.success) status = parsed.data;
		});
		try {
			status = await callHost("display.status");
		} catch (error) {
			unsubscribe();
			subscribed = null;
			throw error;
		}
	})().catch(() => undefined);
	return subscribed;
}

export function deviceDisplayStatus(): DeviceDisplayStatus | null {
	void subscribe();
	return status;
}

export async function shareDeviceDisplay(
	spaceId: string,
): Promise<"declined" | "failed" | null> {
	try {
		status = await callHost(
			"display.share",
			{ spaceId },
			{ timeoutMs: HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS },
		);
		return status.sharedWith === spaceId ? null : "failed";
	} catch (error) {
		if (error instanceof HostBridgeErrorClass && error.isCanceled)
			return "declined";
		throw error;
	}
}

export async function stopDeviceDisplay(): Promise<void> {
	status = await callHost("display.stop");
}

export async function openDeviceControlSettings(): Promise<void> {
	await callHost("display.openControlSettings");
}

export async function setupPhoneControl(): Promise<void> {
	status = await callHost("display.setup");
}

let linked = false;
let shown: DeviceDisplayRef | null = null;
let told: string | null = null;
let telling = false;
let scheduled = false;

const keyOf = (ref: DeviceDisplayRef | null) =>
	ref ? `${ref.spaceId}/${ref.display}` : "";

function tell() {
	scheduled = false;
	const ref = shown;
	const key = keyOf(ref);
	if (!linked || telling || key === told) return;
	told = key;
	telling = true;
	callHost("display.presenting", ref ?? undefined)
		.catch(() => {
			if (told === key) told = null;
		})
		.finally(() => {
			telling = false;
			if (keyOf(shown) !== key) tell();
		});
}

function schedule() {
	if (scheduled) return;
	scheduled = true;
	queueMicrotask(tell);
}

let opener: ((ref: DeviceDisplayRef) => void) | null = null;

export function linkDeviceDisplays(open: (ref: DeviceDisplayRef) => void) {
	const first = opener === null;
	opener = open;
	if (!first) return;
	void readyHost().then(() => {
		if (!supportsHostCapability("display.presenting")) return;
		onHostEvent((event) => {
			if (event.name !== "display.open") return;
			const parsed = deviceDisplayRefSchema.safeParse(event.payload);
			if (parsed.success) opener?.(parsed.data);
		});
		linked = true;
		schedule();
	});
}

export function presentDeviceDisplay(ref: DeviceDisplayRef): () => void {
	shown = ref;
	schedule();
	return () => {
		if (shown !== ref) return;
		shown = null;
		schedule();
	};
}

export async function pairPhoneControl(code: string): Promise<void> {
	status = await callHost(
		"display.pair",
		{ code },
		{ timeoutMs: HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS },
	);
}
