import {
	type DEVICE_RUNTIME_REFUSALS,
	type DeviceFolderListing,
	type DeviceRuntimeInstance,
	deviceRuntimeSchema,
	HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS,
} from "@cohub/protocol/host-bridge";
import { HostBridgeErrorClass } from "@neta-art/cohub/host-bridge";
import {
	callHost,
	onHostEvent,
	readyHost,
	supportsHostCapability,
} from "$lib/host-bridge";

let instances = $state<DeviceRuntimeInstance[] | null>(null);
let subscribed: Promise<void> | null = null;

export type DeviceRuntimeRefusal = (typeof DEVICE_RUNTIME_REFUSALS)[number];

function subscribe(): Promise<void> {
	subscribed ??= (async () => {
		if (!(await readyHost()) || !supportsHostCapability("runtime")) return;
		const unsubscribe = onHostEvent((event) => {
			if (event.name !== "runtime.changed") return;
			const parsed = deviceRuntimeSchema.safeParse(event.payload);
			if (parsed.success) instances = parsed.data.instances;
		});
		try {
			instances = (await callHost("runtime.list")).instances;
		} catch (error) {
			unsubscribe();
			subscribed = null;
			throw error;
		}
	})().catch(() => undefined);
	return subscribed;
}

export async function deviceRuntimeSupported(): Promise<boolean> {
	await subscribe();
	return supportsHostCapability("runtime");
}

export function deviceRuntimeInstances(): DeviceRuntimeInstance[] | null {
	void subscribe();
	return instances;
}

export function deviceRuntimeInstance(
	spaceId: string,
): DeviceRuntimeInstance | null {
	return (
		deviceRuntimeInstances()?.find((item) => item.spaceId === spaceId) ?? null
	);
}

export function isDeviceRuntimeRunning(
	instance: DeviceRuntimeInstance | null | undefined,
): boolean {
	return instance?.state === "connecting" || instance?.state === "ready";
}

async function interactive<T>(call: () => Promise<T>): Promise<T | null> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof HostBridgeErrorClass && error.isCanceled) return null;
		throw error;
	}
}

export function browseDeviceFolder(
	path?: string,
): Promise<DeviceFolderListing | null> {
	return interactive(() =>
		callHost("runtime.browse", path ? { path } : {}, {
			timeoutMs: HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS,
		}),
	);
}

export async function startDeviceRuntime(
	spaceId: string,
	root: string,
): Promise<DeviceRuntimeRefusal | "declined" | null> {
	const result = await interactive(() =>
		callHost(
			"runtime.start",
			{ spaceId, root },
			{ timeoutMs: HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS },
		),
	);
	if (!result) return "declined";
	instances = result.instances;
	return result.refused;
}

export async function stopDeviceRuntime(spaceId: string): Promise<void> {
	instances = (await callHost("runtime.stop", { spaceId })).instances;
}

export function deviceFolderName(listing: DeviceFolderListing): string {
	return listing.label.split("/").filter(Boolean).at(-1) ?? listing.label;
}
