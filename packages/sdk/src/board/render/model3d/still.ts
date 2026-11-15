import { autoDetectRenderer, type Renderer } from "pixi.js";
import { loadModel } from "./load.js";
import { createModelScene } from "./scene.js";
import type { ModelLoadOptions, ModelSource } from "./source.js";

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

export async function renderModelStill(source: ModelSource, options: ModelLoadOptions): Promise<ImageBitmap> {
	await idle();
	const model = await loadModel(source, options);
	const draw = async () => {
		const target = await acquire();
		const scene = createModelScene(model, { reducedMotion: true });
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
		return await result;
	} finally {
		model.destroy();
	}
}
