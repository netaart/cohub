import { autoDetectRenderer, type Renderer } from "pixi.js";
import { loadModel } from "./load.js";
import type { ModelLighting } from "./lighting.js";
import { createModelScene } from "./scene.js";
import type { ModelLoadOptions, ModelSource } from "./source.js";
import type { ModelView } from "./view.js";

export const MODEL_STILL_EDGE = 640;
const RELEASE_AFTER_MS = 30_000;

let renderer: Promise<Renderer> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function acquire(): Promise<Renderer> {
	if (releaseTimer) clearTimeout(releaseTimer);
	releaseTimer = setTimeout(release, RELEASE_AFTER_MS);
	renderer ??= autoDetectRenderer({
		preference: "webgl",
		width: MODEL_STILL_EDGE,
		height: MODEL_STILL_EDGE,
		resolution: 1,
		backgroundAlpha: 0,
		antialias: true,
	}).catch((error) => {
		renderer = null;
		throw error;
	});
	return renderer;
}

const idle = () =>
	new Promise<void>((resolve) => {
		if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 2_000 });
		else setTimeout(resolve, 0);
	});

function release() {
	const current = renderer;
	renderer = null;
	releaseTimer = null;
	void current?.then((instance) => instance.destroy()).catch(() => {});
}

export type ModelStillOptions = ModelLoadOptions & {
	view?: ModelView;
	clip?: string;
	lighting?: ModelLighting;
};

export type ModelStill = { image: ImageBitmap; sha256: string | null };

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
	if (!globalThis.crypto?.subtle) return null;
	const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function renderModelStill(source: ModelSource, options: ModelStillOptions): Promise<ModelStill> {
	await idle();
	let sha256: Promise<string | null> = Promise.resolve(null);
	let separate = false;
	const model = await loadModel(
		{
			...source,
			async read(read) {
				const bytes = await source.read(read);
				sha256 = sha256Hex(bytes).catch(() => null);
				return bytes;
			},
			references(reference, signal) {
				separate = true;
				return source.references(reference, signal);
			},
		},
		options,
	);
	const clip = options.clip && model.player?.getAnimation(options.clip) ? options.clip : null;
	if (clip) model.player?.getState(clip).gotoAndStop(0);
	const draw = async () => {
		const target = await acquire();
		const scene = createModelScene(model, { reducedMotion: true, home: options.view, lighting: options.lighting });
		try {
			scene.resize(MODEL_STILL_EDGE, MODEL_STILL_EDGE);
			target.render({ container: scene.view, clear: true });
			return await createImageBitmap(target.canvas as HTMLCanvasElement);
		} finally {
			scene.destroy();
		}
	};
	const result = queue.then(draw, draw);
	queue = result.catch(() => {});
	try {
		return { image: await result, sha256: separate ? null : await sha256 };
	} finally {
		model.destroy();
	}
}
