import {
	type DeviceDisplayStatus,
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
