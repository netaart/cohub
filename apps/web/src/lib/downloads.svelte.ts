import {
	HOST_FILE_DATA_MAX_LENGTH,
	HOST_FILE_PROGRESS_EVENT,
	HOST_FILE_SAVE_TIMEOUT_MS,
	type HostFileLocation,
	type HostFileSaveParams,
	hostFileProgressSchema,
} from "@cohub/protocol/host-bridge";
import { HostBridgeErrorClass } from "@neta-art/cohub/host-bridge";
import {
	callHost,
	hostPlatform,
	onHostEvent,
	supportsHostCapability,
} from "$lib/host-bridge";

/**
 * `attachment` URLs download in place; `url` may render inline, so the browser
 * buffers it to honor the filename; `blob` is already in memory.
 */
export type SaveSource =
	| { kind: "attachment"; url: string }
	| { kind: "url"; url: string }
	| { kind: "blob"; blob: Blob };

export type SaveRequest = {
	key: string;
	name: string;
	mimeType?: string | null;
	source: () => SaveSource | Promise<SaveSource>;
};

export type DownloadFailure = "preparing" | "tooLarge" | "failed";

export type Download = {
	id: string;
	key: string;
	name: string;
	phase: "preparing" | "saving" | "started" | "saved" | "failed";
	/** False during the grace period, so instant saves never flash a toast. */
	shown: boolean;
	received: number | null;
	total: number | null;
	location: HostFileLocation | null;
	revealable: boolean;
	failure: DownloadFailure | null;
};

const SHOW_AFTER_MS = 300;
const STARTED_MS = 2_000;
const SAVED_MS = 5_000;
const PROGRESS_INTERVAL_MS = 100;
const MAX_INLINE_BYTES = Math.floor((HOST_FILE_DATA_MAX_LENGTH * 3) / 4);
const DESKTOP_HOSTS = new Set(["macos", "windows", "linux"]);

let items = $state<Download[]>([]);
const requests = new Map<string, SaveRequest>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const held = new Set<string>();

export const downloads = {
	get visible(): Download[] {
		return items.filter((item) => item.shown);
	},
	busy(key: string): boolean {
		return items.some(
			(item) =>
				item.key === key &&
				(item.phase === "preparing" || item.phase === "saving"),
		);
	},
	dismiss,
	retry(id: string) {
		const request = requests.get(id);
		if (request) void run(id, request);
	},
	async reveal(id: string) {
		if (await callHost("files.reveal", { id }).catch(() => false)) dismiss(id);
	},
	hold(id: string, holding: boolean) {
		if (holding) {
			held.add(id);
			clearTimer(id);
		} else if (held.delete(id)) {
			const item = find(id);
			if (item?.phase === "saved" || item?.phase === "started") {
				schedule(id, SAVED_MS, () => dismiss(id));
			}
		}
	},
};

/** Saves a file with visible progress. Never throws: failures surface in the toast. */
export function saveFile(request: SaveRequest): Promise<void> {
	if (downloads.busy(request.key)) return Promise.resolve();
	// A finished or failed toast for the same file is reused rather than stacked.
	const id =
		items.find((item) => item.key === request.key)?.id ?? crypto.randomUUID();
	requests.set(id, request);
	if (!find(id)) items = [...items, blank(id, request)];
	return run(id, request);
}

function blank(id: string, request: SaveRequest): Download {
	return {
		id,
		key: request.key,
		name: request.name,
		phase: "preparing",
		shown: false,
		received: null,
		total: null,
		location: null,
		revealable: false,
		failure: null,
	};
}

async function run(id: string, request: SaveRequest) {
	const shown = find(id)?.shown ?? false;
	// A reused toast may still be counting down to dismissal.
	clearTimer(id);
	update(id, { ...blank(id, request), shown });
	if (!shown) schedule(id, SHOW_AFTER_MS, () => update(id, { shown: true }));
	try {
		const source = await request.source();
		const target = supportsHostCapability("files")
			? await hostTarget(id, request, source)
			: source;
		if ("kind" in target) await saveInBrowser(id, request.name, target);
		else await saveWithHost(id, target);
	} catch (error) {
		if (error instanceof HostBridgeErrorClass && error.isCanceled) {
			dismiss(id);
			return;
		}
		console.warn(`Could not save ${request.name}`, error);
		clearTimer(id);
		update(id, { phase: "failed", shown: true, failure: failureOf(error) });
	}
}

async function saveWithHost(id: string, params: HostFileSaveParams) {
	update(id, { phase: "saving" });
	const stop = onHostEvent((event) => {
		if (event.name !== HOST_FILE_PROGRESS_EVENT) return;
		const progress = hostFileProgressSchema.safeParse(event.payload);
		if (progress.success && progress.data.id === id) {
			update(id, {
				received: progress.data.received,
				total: progress.data.total,
			});
		}
	});
	try {
		const saved: unknown = await callHost("files.save", params, {
			timeoutMs: HOST_FILE_SAVE_TIMEOUT_MS,
		});
		// Shells older than the `files.save` result announce the save themselves.
		if (typeof saved !== "object" || saved === null) {
			dismiss(id);
			return;
		}
		const { location, revealable } = saved as {
			location: HostFileLocation;
			revealable: boolean;
		};
		settle(id, { phase: "saved", location, revealable }, SAVED_MS);
	} finally {
		stop();
	}
}

/** Bytes too large for the bridge go back to the WebView, which desktop shells save natively. */
async function hostTarget(
	id: string,
	request: SaveRequest,
	source: SaveSource,
): Promise<HostFileSaveParams | SaveSource> {
	const base = {
		id,
		name: request.name,
		...(request.mimeType ? { mimeType: request.mimeType } : {}),
	};
	if (source.kind !== "blob" && /^https:/i.test(source.url)) {
		return { ...base, url: source.url };
	}
	const blob =
		source.kind === "blob"
			? source.blob
			: await (await fetch(source.url)).blob();
	if (blob.size > MAX_INLINE_BYTES) {
		if (DESKTOP_HOSTS.has(hostPlatform() ?? "unknown")) {
			return { kind: "blob", blob };
		}
		throw new SaveError("tooLarge");
	}
	return { ...base, data: await toBase64(blob) };
}

async function saveInBrowser(id: string, name: string, source: SaveSource) {
	if (source.kind === "attachment") clickLink(source.url, name);
	else if (source.kind === "blob") clickBlob(source.blob, name);
	else {
		const blob = await fetchBlob(id, source.url).catch(() => null);
		if (blob) clickBlob(blob, name);
		// Cross-origin without CORS: the browser decides whether to render or save.
		else clickLink(source.url, name, true);
	}
	settle(id, { phase: "started" }, STARTED_MS);
}

/** `no-store`: an `<img>` may have cached this URL without CORS headers. */
async function fetchBlob(id: string, url: string): Promise<Blob> {
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok || !response.body)
		throw new Error(`HTTP ${response.status}`);
	const total = Number(response.headers.get("content-length")) || null;
	update(id, { phase: "saving", received: 0, total });
	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let received = 0;
	let reportedAt = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		if (performance.now() - reportedAt >= PROGRESS_INTERVAL_MS) {
			reportedAt = performance.now();
			update(id, { received });
		}
	}
	const type = response.headers.get("content-type") ?? "";
	return new Blob(chunks, { type });
}

function clickLink(url: string, name: string, newTab = false) {
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	if (newTab) {
		link.target = "_blank";
		link.rel = "noopener noreferrer";
	}
	link.referrerPolicy = "no-referrer";
	document.body.appendChild(link);
	link.click();
	link.remove();
}

/** The object URL outlives the click for Safari. */
function clickBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	clickLink(url, name);
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

class SaveError extends Error {
	readonly failure: DownloadFailure;

	constructor(failure: DownloadFailure) {
		super(failure);
		this.failure = failure;
	}
}

function failureOf(error: unknown): DownloadFailure {
	if (error instanceof SaveError) return error.failure;
	if ((error as { status?: unknown } | null)?.status === 202)
		return "preparing";
	return "failed";
}

function find(id: string) {
	return items.find((item) => item.id === id);
}

function update(id: string, patch: Partial<Download>) {
	const index = items.findIndex((item) => item.id === id);
	if (index < 0) return;
	items[index] = { ...items[index], ...patch } as Download;
}

function settle(id: string, patch: Partial<Download>, ms: number) {
	clearTimer(id);
	update(id, { ...patch, shown: true });
	if (!held.has(id)) schedule(id, ms, () => dismiss(id));
}

function dismiss(id: string) {
	clearTimer(id);
	held.delete(id);
	requests.delete(id);
	items = items.filter((item) => item.id !== id);
}

function schedule(id: string, ms: number, action: () => void) {
	clearTimer(id);
	timers.set(
		id,
		setTimeout(() => {
			timers.delete(id);
			action();
		}, ms),
	);
}

function clearTimer(id: string) {
	const timer = timers.get(id);
	if (timer) clearTimeout(timer);
	timers.delete(id);
}

export function installHostDownloads(): () => void {
	const onClick = (event: MouseEvent) => {
		// Untrusted clicks are saveFile's own WebView fallback.
		if (
			!event.isTrusted ||
			event.defaultPrevented ||
			!supportsHostCapability("files")
		)
			return;
		const target = event.target instanceof Element ? event.target : null;
		const anchor = target?.closest("a[download]");
		if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) return;
		event.preventDefault();
		const url = anchor.href;
		void saveFile({
			key: url,
			name: anchor.download || fileNameOf(url),
			source: () => ({ kind: "url", url }),
		});
	};
	document.addEventListener("click", onClick, true);
	return () => document.removeEventListener("click", onClick, true);
}

function fileNameOf(href: string): string {
	try {
		const segment = new URL(href).pathname.split("/").filter(Boolean).pop();
		return segment ? decodeURIComponent(segment) : "download";
	} catch {
		return "download";
	}
}

function toBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result);
			resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
