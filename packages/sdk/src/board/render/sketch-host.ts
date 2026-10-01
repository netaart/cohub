
import type { BoardSketchItem } from "@cohub/protocol";
import { Texture } from "pixi.js";
import type { SceneItem } from "../core/scene.js";
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
const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER_SOURCE)}], { type: "text/javascript" })), { type: "module" });
worker.onmessage = (event) => parent.postMessage(event.data, "*", event.data.bitmap ? [event.data.bitmap] : []);
addEventListener("message", (event) => { if (event.source === parent) worker.postMessage(event.data); });
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
};

export type BoardSketchHostOptions = {
	readModule: (src: string) => Promise<string>;
	onFrame?: () => void;
};

export type BrowserBoardSketchHost = BoardSketchHost & {
	invalidate: (src?: string) => void;
	destroy: () => void;
};

function frameKey(item: SceneItem<BoardSketchItem>, time: number, width: number, height: number, scale: number): string {
	return `${time}|${width}|${height}|${scale}|${item.props.seed ?? ""}|${JSON.stringify(item.props.params)}`;
}

export function createBoardSketchHost(options: BoardSketchHostOptions): BrowserBoardSketchHost {
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
			entry.texture?.destroy(true);
			entry.texture = Texture.from(data.bitmap);
			entry.error = null;
		} else entry.error = data.error ?? "Sketch failed.";
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
				entry = { texture: null, error: null, shown: "", pending: null, request: 0, code: null, loading: false };
				entries.set(item.id, entry);
			}
			const { width, height } = item.frame;
			const scale = Math.min(resolution, MAX_EDGE / Math.max(1, width), MAX_EDGE / Math.max(1, height));
			const key = frameKey(item, time, width, height, scale);
			if (key !== entry.shown && entry.pending === null) {
				const current = entry;
				if (current.code === null) {
					if (!current.loading) {
						current.loading = true;
						source(item.props.src).then(
							(code) => {
								current.code = code;
								current.loading = false;
								options.onFrame?.();
							},
							(error: unknown) => {
								current.loading = false;
								current.error = error instanceof Error ? error.message : String(error);
								options.onFrame?.();
							},
						);
					}
				} else {
					current.pending = key;
					current.request += 1;
					post({ id: item.id, src: item.props.src, code: current.code, t: time, width, height, scale, seed: item.props.seed ?? item.id, params: item.props.params, request: current.request });
				}
			}
			return entry.texture;
		},
		error: (id) => entries.get(id)?.error ?? null,
		release(id) {
			entries.get(id)?.texture?.destroy(true);
			entries.delete(id);
		},
		invalidate(src) {
			if (src) sources.delete(src);
			else sources.clear();
			for (const entry of entries.values()) {
				entry.code = null;
				entry.shown = "";
			}
			options.onFrame?.();
		},
		destroy() {
			window.removeEventListener("message", onMessage);
			for (const entry of entries.values()) entry.texture?.destroy(true);
			entries.clear();
			iframe.remove();
		},
	};
}
