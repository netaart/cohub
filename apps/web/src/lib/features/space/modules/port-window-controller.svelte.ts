import type { SpacePublicEndpoints } from "@cohub/protocol/ports";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { SpaceRecord } from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";
import {
	applyPortsChangedToEndpoints,
	extractPublicEndpoints,
	isHttpUrl,
} from "./port-window-utils.ts";
import { createRequestDedupe } from "./request-dedupe.ts";

export type InlinePortPreview = {
	port: string;
	url: string;
	autoOpened: boolean;
};

export type PortReadyToast = {
	port: string;
	url: string;
};

type PortPreviewControllerOptions = {
	getSpaceId: () => string;
	getSpace: () => SpaceRecord | null;
	getPageMounted: () => boolean;
	getHasMinimalAccess: () => boolean;
	onOpenPanel?: () => void;
	onClosePanel?: () => void;
	/** A tab actually went away, so a coordinator can re-derive the active ref. */
	onPortClosed?: (port: string) => void;
	onBeforeOpenPort?: () => void;
};

export function createPortPreviewController(
	options: PortPreviewControllerOptions,
) {
	let endpoints = $state<SpacePublicEndpoints>({});
	let previews = $state<InlinePortPreview[]>([]);
	let activePort = $state<string | null>(null);
	let readyToast = $state<PortReadyToast | null>(null);
	let readyToastTimer: ReturnType<typeof setTimeout> | null = null;
	const requests = createRequestDedupe();

	function maybeNotifyReady(
		previous: SpacePublicEndpoints,
		next: SpacePublicEndpoints,
		changedPorts?: string[],
	) {
		if (!options.getPageMounted() || options.getHasMinimalAccess()) return;
		const entries = (
			changedPorts?.length
				? changedPorts.map((port) => [port, next[port]] as const)
				: Object.entries(next)
		).filter(
			([, endpoint]) => endpoint?.status === "listening" && endpoint.url,
		);
		for (const [port, endpoint] of entries) {
			const previousStatus = previous[port]?.status;
			const cameFromPortsChangedEvent = Boolean(changedPorts?.length);
			const becameListening = previousStatus !== "listening";
			if (!(cameFromPortsChangedEvent || becameListening) || !endpoint?.url)
				continue;
			if (activePort === port) continue;
			showReadyToast(port, endpoint.url);
			return;
		}
	}

	async function loadEndpoints() {
		const currentSpaceId = options.getSpaceId();
		const previous = endpoints;
		try {
			const result = await requests.run(`space:${currentSpaceId}:ports`, () =>
				sdk.space(currentSpaceId).sandbox.ports(),
			);
			if (options.getSpaceId() !== currentSpaceId) return;
			const next = result.endpoints ?? {};
			endpoints = next;
			maybeNotifyReady(previous, next);
		} catch {
			if (options.getSpaceId() !== currentSpaceId) return;
			const next = extractPublicEndpoints(options.getSpace());
			endpoints = next;
			maybeNotifyReady(previous, next);
		}
	}

	function setEndpoints(next: SpacePublicEndpoints, notify = false) {
		const previous = endpoints;
		endpoints = next;
		if (notify) maybeNotifyReady(previous, next);
	}

	function applyPortsChanged(payload: ChannelEnvelope) {
		const previous = endpoints;
		const result = applyPortsChangedToEndpoints(endpoints, payload);
		endpoints = result.endpoints;
		maybeNotifyReady(previous, result.endpoints, result.changedPorts);
	}

	function showReadyToast(port: string, url: string) {
		if (!isHttpUrl(url)) return;
		readyToast = { port, url };
		if (readyToastTimer) clearTimeout(readyToastTimer);
		readyToastTimer = setTimeout(() => {
			readyToast = null;
			readyToastTimer = null;
		}, 7000);
	}

	function closeReadyToast() {
		readyToast = null;
		if (readyToastTimer) {
			clearTimeout(readyToastTimer);
			readyToastTimer = null;
		}
	}

	function previewFromToast() {
		if (!readyToast) return;
		openPort(readyToast.port, readyToast.url);
		closeReadyToast();
	}

	function openPort(
		port: string,
		url: string,
		optionsArg: { autoOpened?: boolean } = {},
	) {
		options.onBeforeOpenPort?.();
		const preview = { port, url, autoOpened: optionsArg.autoOpened ?? false };
		previews = previews.some((item) => item.port === port)
			? previews.map((item) => (item.port === port ? preview : item))
			: [...previews, preview];
		activePort = port;
		// Open the panel only once this port is the committed active surface.
		options.onOpenPanel?.();
	}

	function closePort(port = activePort) {
		if (!port) return;
		const index = previews.findIndex((item) => item.port === port);
		const nextPreviews = previews.filter((item) => item.port !== port);
		previews = nextPreviews;
		if (activePort === port)
			activePort =
				nextPreviews[Math.max(0, index - 1)]?.port ??
				nextPreviews[0]?.port ??
				null;
		if (nextPreviews.length === 0) options.onClosePanel?.();
		options.onPortClosed?.(port);
	}

	function activatePort(port: string) {
		if (!previews.some((item) => item.port === port)) return;
		activePort = port;
		options.onOpenPanel?.();
	}

	function dispose() {
		requests.clear();
		if (readyToastTimer) clearTimeout(readyToastTimer);
		readyToastTimer = null;
	}

	return {
		get endpoints() {
			return endpoints;
		},
		get preview() {
			return previews.find((item) => item.port === activePort) ?? null;
		},
		get previews() {
			return previews;
		},
		get activePort() {
			return activePort;
		},
		get readyToast() {
			return readyToast;
		},
		loadEndpoints,
		setEndpoints,
		applyPortsChanged,
		openPort,
		closePort,
		activatePort,
		previewFromToast,
		closeReadyToast,
		dispose,
	};
}
