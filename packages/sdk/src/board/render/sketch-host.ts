
import type { BoardSketchItem } from "@cohub/protocol";
import { Texture } from "pixi.js";
import type { SceneItem } from "../model/scene.js";
import type { BoardSketchHost } from "./renderers/board-renderer-registry.js";

const MAX_EDGE = 2048;

const WORKER_SOURCE = `
const modules = new Map();
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches"]) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false }); } catch {}
}
self.onmessage = async (event) => {
  const { id, src, code, t, width, height, scale, seed, params, request } = event.data;
  try {
    let entry = modules.get(id);
    if (!entry || entry.code !== code) {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try { entry = { code, module: await import(url) }; } finally { URL.revokeObjectURL(url); }
      modules.set(id, entry);
    }
    if (typeof entry.module.draw !== "function") throw new Error(src + " does not export draw(ctx, frame)");
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    await entry.module.draw(ctx, { t, width, height, seed, params });
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ id, request, bitmap }, [bitmap]);
  } catch (error) {
    self.postMessage({ id, request, error: String(error && error.message || error) });
  }
};
`;

const FRAME_SOURCE = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:">
<script>
const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(WORKER_SOURCE)}], { type: "text/javascript" }));
const makeWorker = () => {
  const next = new Worker(workerUrl, { type: "module" });
  next.onmessage = (event) => parent.postMessage(event.data, "*", event.data.bitmap ? [event.data.bitmap] : []);
  return next;
};
let worker = makeWorker();
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  if (event.data?.reset) {
    worker.terminate();
    worker = makeWorker();
    return;
  }
  worker.postMessage(event.data);
});
parent.postMessage({ ready: true }, "*");
</script>`;

type Entry = {
	texture: Texture | null;
	error: string | null;
	shown: string;
	pending: string | null;
	request: number;
	code: string | null;
	loading: boolean;
	timeout: ReturnType<typeof setTimeout> | null;
	sourceError: string | null;
};

export type BoardSketchHostOptions = {
	readModule: (src: string) => Promise<string>;
	onFrame?: () => void;
	timeoutMs?: number;
};

export type BrowserBoardSketchHost = BoardSketchHost & {
	invalidate: (src?: string) => void;
	destroy: () => void;
};

function frameKey(item: SceneItem<BoardSketchItem>, time: number, width: number, height: number, scale: number): string {
	return `${time}|${width}|${height}|${scale}|${item.props.seed ?? ""}|${JSON.stringify(item.props.params)}`;
}

export function createBoardSketchHost(options: BoardSketchHostOptions): BrowserBoardSketchHost {
	const timeoutMs = options.timeoutMs ?? 2_000;
	const entries = new Map<string, Entry>();
	const sources = new Map<string, Promise<string>>();
	const iframe = document.createElement("iframe");
	iframe.setAttribute("sandbox", "allow-scripts");
	iframe.setAttribute("aria-hidden", "true");
	iframe.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
	iframe.srcdoc = FRAME_SOURCE;
	let ready = false;
	const queue: unknown[] = [];
	const post = (message: unknown) => {
		if (ready) iframe.contentWindow?.postMessage(message, "*");
		else queue.push(message);
	};

	const resetWorker = () => {
		for (const entry of entries.values()) {
			if (entry.pending === null) continue;
			if (entry.timeout) clearTimeout(entry.timeout);
			entry.timeout = null;
			entry.pending = null;
			entry.shown = "";
			entry.request += 1;
		}
		post({ reset: true });
	};

	const onMessage = (event: MessageEvent) => {
		if (event.source !== iframe.contentWindow) return;
		const data = event.data as { ready?: boolean; id?: string; request?: number; bitmap?: ImageBitmap; error?: string };
		if (data.ready) {
			ready = true;
			for (const message of queue.splice(0)) iframe.contentWindow?.postMessage(message, "*");
			return;
		}
		const entry = data.id ? entries.get(data.id) : undefined;
		if (!entry || data.request !== entry.request) {
			data.bitmap?.close();
			return;
		}
		if (data.bitmap) {
			if (entry.timeout) clearTimeout(entry.timeout);
			entry.timeout = null;
			entry.texture?.destroy(true);
			entry.texture = Texture.from(data.bitmap);
			entry.error = null;
		} else {
			if (entry.timeout) clearTimeout(entry.timeout);
			entry.timeout = null;
			entry.error = data.error ?? "Sketch failed.";
		}
		entry.shown = entry.pending ?? entry.shown;
		entry.pending = null;
		options.onFrame?.();
	};
	window.addEventListener("message", onMessage);
	document.body.appendChild(iframe);

	function source(src: string): Promise<string> {
		let promise = sources.get(src);
		if (!promise) {
			promise = options.readModule(src);
			sources.set(src, promise);
			promise.catch(() => sources.delete(src));
		}
		return promise;
	}

	return {
		frame(item, time, resolution) {
			let entry = entries.get(item.id);
			if (!entry) {
				entry = { texture: null, error: null, shown: "", pending: null, request: 0, code: null, loading: false, timeout: null, sourceError: null };
				entries.set(item.id, entry);
			}
			const { width, height } = item.frame;
			const scale = Math.min(resolution, MAX_EDGE / Math.max(1, width), MAX_EDGE / Math.max(1, height));
			const key = frameKey(item, time, width, height, scale);
			if (key !== entry.shown && entry.pending === null) {
				const current = entry;
				if (current.code === null) {
					if (!current.sourceError && !current.loading) {
						current.loading = true;
						source(item.props.src).then(
							(code) => {
								current.code = code;
								current.sourceError = null;
								current.loading = false;
								options.onFrame?.();
							},
							(error: unknown) => {
								current.loading = false;
								current.sourceError = error instanceof Error ? error.message : String(error);
								current.error = current.sourceError;
								options.onFrame?.();
							},
						);
					}
				} else {
					current.pending = key;
					current.request += 1;
					const request = current.request;
					current.timeout = setTimeout(() => {
						if (current.request !== request || current.pending !== key) return;
						resetWorker();
						current.shown = key;
						current.pending = null;
						current.timeout = null;
						current.error = `${item.props.src} exceeded the ${timeoutMs}ms sketch timeout.`;
						options.onFrame?.();
					}, timeoutMs);
					post({ id: item.id, src: item.props.src, code: current.code, t: time, width, height, scale, seed: item.props.seed ?? item.id, params: item.props.params, request: current.request });
				}
			}
			return entry.texture;
		},
		error: (id) => entries.get(id)?.error ?? null,
		release(id) {
			const entry = entries.get(id);
			if (entry?.timeout) clearTimeout(entry.timeout);
			entry?.texture?.destroy(true);
			entries.delete(id);
		},
		invalidate(src) {
			if (src) sources.delete(src);
			else sources.clear();
			for (const entry of entries.values()) {
					entry.code = null;
					entry.sourceError = null;
					entry.pending = null;
					entry.request += 1;
					if (entry.timeout) clearTimeout(entry.timeout);
					entry.timeout = null;
					entry.shown = "";
			}
			options.onFrame?.();
		},
		destroy() {
			window.removeEventListener("message", onMessage);
			for (const entry of entries.values()) {
				if (entry.timeout) clearTimeout(entry.timeout);
				entry.texture?.destroy(true);
			}
			entries.clear();
			iframe.remove();
		},
	};
}
