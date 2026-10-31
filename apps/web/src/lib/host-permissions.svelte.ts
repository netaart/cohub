import type {
	HostPermission,
	HostPermissionState,
	HostPermissions,
} from "@cohub/protocol/host-bridge";
import {
	callHost,
	hostPlatform,
	readyHost,
	supportsHostCapability,
} from "$lib/host-bridge";

let permissions = $state<HostPermissions | null>(null);
let subscribed: Promise<void> | null = null;

async function refresh() {
	permissions = await callHost("permissions.status").catch(() => permissions);
}

function subscribe(): Promise<void> {
	subscribed ??= (async () => {
		if (!(await readyHost()) || !supportsHostCapability("permissions")) return;
		await refresh();
		window.addEventListener("focus", () => void refresh());
	})();
	return subscribed;
}

export function hostPermissions(): HostPermissions | null {
	void subscribe();
	return permissions;
}

export async function requestHostPermission(
	kind: HostPermission,
): Promise<HostPermissionState> {
	const state = await callHost(
		"permissions.request",
		{ kind },
		{ timeoutMs: 5 * 60_000 },
	);
	void refresh();
	return state;
}

export function canOpenHostPermissionSettings(kind: HostPermission): boolean {
	if (kind === "files" && hostPlatform() === "windows") return false;
	return supportsHostCapability("permissions");
}

export async function openHostPermissionSettings(
	kind: HostPermission,
): Promise<void> {
	await callHost("permissions.openSettings", { kind });
}
