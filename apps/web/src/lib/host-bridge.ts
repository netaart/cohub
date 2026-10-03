import type {
	HostBridgeCapability,
	HostBridgeEvent,
	HostBridgeMethod,
} from "@cohub/protocol/host-bridge";
import {
	createHostBridge,
	type HostBridgeCallOptions,
	type HostBridgeClient,
	type HostBridgeParams,
	type HostBridgeResult,
	type HostBridgeStatus,
} from "@neta-art/cohub/host-bridge";

/**
 * The native host, when this surface runs inside one. Everything native-specific
 * funnels through here so the rest of the app asks one question —
 * "does a host own credentials?" — instead of probing `window.cohubHost`.
 * In a browser there is no host and every check below is false.
 */
let bridge: HostBridgeClient | null = null;
let handshake: Promise<HostBridgeStatus | null> | null = null;
let lifecycleHooked = false;

function ensureBridge(): HostBridgeClient {
	if (bridge) return bridge;
	bridge = createHostBridge();
	if (typeof window !== "undefined" && !lifecycleHooked) {
		lifecycleHooked = true;
		// One teardown per page: the bridge outlives SvelteKit navigation.
		window.addEventListener(
			"pagehide",
			() => {
				bridge?.dispose();
				bridge = null;
				handshake = null;
				lifecycleHooked = false;
			},
			{ once: true },
		);
	}
	return bridge;
}

/** Await once before branching on a capability; afterwards checks are sync. */
export function readyHost(): Promise<HostBridgeStatus | null> {
	handshake ??= ensureBridge().ready();
	return handshake;
}

export function getHostBridge(): HostBridgeClient {
	return ensureBridge();
}

export function supportsHostCapability(
	capability: HostBridgeCapability,
): boolean {
	return ensureBridge().supports(capability);
}

/**
 * Whether the host owns the token lifecycle. When true the web side must never
 * touch Logto storage: one credential is shared by every surface in the app,
 * and two refreshers would race.
 */
export function hostOwnsCredentials(): boolean {
	return supportsHostCapability("auth.token");
}

export function onHostEvent(
	listener: (event: HostBridgeEvent) => void,
): () => void {
	return ensureBridge().onEvent(listener);
}

export function callHost<M extends HostBridgeMethod>(
	method: M,
	params?: HostBridgeParams<M>,
	options?: HostBridgeCallOptions,
): Promise<HostBridgeResult<M>> {
	return ensureBridge().call(method, params, options);
}
