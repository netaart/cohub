import type {
	HostBridgeCapability,
	HostBridgeEvent,
	HostBridgeMethod,
	HostShortcut,
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

let requestedAppearance: string | null = null;
let appliedAppearance: string | null = null;

export function syncHostAppearance(backgroundColor: string) {
	requestedAppearance = backgroundColor;
	void readyHost().then(() => {
		if (
			requestedAppearance !== backgroundColor ||
			appliedAppearance === backgroundColor ||
			!supportsHostCapability("appearance")
		) {
			return;
		}
		appliedAppearance = backgroundColor;
		callHost("appearance.set", { backgroundColor }).catch(() => {
			if (appliedAppearance === backgroundColor) appliedAppearance = null;
		});
	});
}

let readyReported = false;

/** Lets the host lift its launch screen once the first screen has painted. */
export function markHostReady() {
	if (readyReported || typeof window === "undefined") return;
	readyReported = true;
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			void readyHost().then(() => {
				if (!supportsHostCapability("launch")) return;
				callHost("app.ready").catch(() => {});
			});
		}),
	);
}

let lastShortcut: string | null = null;

const SHORTCUT_LABEL_MAX = 64;

export function pushHostShortcut({ label, ...rest }: HostShortcut) {
	const cut = label
		.slice(0, SHORTCUT_LABEL_MAX)
		.replace(/[\uD800-\uDBFF]$/, "");
	const shortcut = { ...rest, label: cut };
	const key = JSON.stringify(shortcut);
	if (key === lastShortcut) return;
	lastShortcut = key;
	void readyHost().then(() => {
		if (!supportsHostCapability("shortcuts")) return;
		callHost("shortcuts.push", shortcut).catch(() => {
			if (lastShortcut === key) lastShortcut = null;
		});
	});
}
