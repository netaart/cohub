import { PerspectiveCamera } from "three";
import { loadModelSource } from "./load";
import type { ModelSource } from "./source";
import {
	createModelRenderer,
	createStudioScene,
	disposeModel,
	fitModelView,
	MODEL_FOV,
	modelBounds,
	modelRadius,
} from "./studio";

const STILL_EDGE = 640;
const RELEASE_AFTER_MS = 30_000;
const IDLE_TIMEOUT_MS = 2_000;
const LOAD_TIMEOUT_MS = 60_000;

type Studio = {
	canvas: HTMLCanvasElement;
	renderer: ReturnType<typeof createModelRenderer>;
	studio: ReturnType<typeof createStudioScene>;
};

let current: Studio | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function release() {
	if (!current) return;
	current.studio.dispose();
	current.renderer.dispose();
	current.renderer.forceContextLoss();
	current = null;
}

function acquire(): Studio {
	if (releaseTimer) clearTimeout(releaseTimer);
	releaseTimer = setTimeout(release, RELEASE_AFTER_MS);
	if (current) return current;
	const canvas = document.createElement("canvas");
	const renderer = createModelRenderer(canvas);
	renderer.setPixelRatio(1);
	renderer.setSize(STILL_EDGE, STILL_EDGE, false);
	canvas.addEventListener("webglcontextlost", () => {
		if (current?.canvas === canvas) current = null;
	});
	current = { canvas, renderer, studio: createStudioScene(renderer) };
	return current;
}

const idle = () =>
	new Promise<void>((resolve) => {
		if (typeof requestIdleCallback === "function") {
			requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
		} else setTimeout(resolve, 0);
	});

export async function renderModelStill(
	source: ModelSource,
	options: { maxBytes?: number } = {},
): Promise<ImageBitmap> {
	await idle();
	const model = await loadModelSource(source, {
		signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
		maxBytes: options.maxBytes,
	});
	try {
		const { canvas, renderer, studio } = acquire();
		const bounds = modelBounds(model.root);
		const view = fitModelView(bounds, MODEL_FOV, 1);
		const radius = modelRadius(bounds);
		const camera = new PerspectiveCamera(
			MODEL_FOV,
			1,
			view.distance / 1000,
			view.distance + radius * 2,
		);
		camera.position.copy(view.position);
		camera.lookAt(view.center);
		studio.scene.add(model.root);
		renderer.render(studio.scene, camera);
		studio.scene.remove(model.root);
		return await createImageBitmap(canvas);
	} finally {
		disposeModel(model.root);
	}
}
