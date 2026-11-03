import {
	AnimationMixer,
	InstancedMesh,
	Mesh,
	type Object3D,
	PerspectiveCamera,
	Vector3,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { LoadedModel } from "./load";
import {
	createModelRenderer,
	createStudioScene,
	disposeModel,
	fitModelView,
	MODEL_FOV,
	materialsOf,
	modelBounds,
	modelRadius,
	unitBounds,
} from "./studio";

export type ModelStats = {
	triangles: number;
	size: [number, number, number];
	animations: number;
};

export type ModelViewer = ReturnType<typeof createModelViewer>;

const MAX_PIXEL_RATIO = 2;
const RESET_MS = 320;

const reducedMotion = () =>
	typeof matchMedia === "function" &&
	matchMedia("(prefers-reduced-motion: reduce)").matches;

function triangleCount(root: Object3D) {
	let total = 0;
	root.traverse((object) => {
		if (!(object instanceof Mesh)) return;
		const { index, attributes } = object.geometry;
		const vertices = index ? index.count : (attributes.position?.count ?? 0);
		const instances = object instanceof InstancedMesh ? object.count : 1;
		total += Math.floor(vertices / 3) * instances;
	});
	return total;
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export function createModelViewer(
	canvas: HTMLCanvasElement,
	{
		onContextLost,
		onRender,
		pixelRatio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO),
		frameMs = 0,
	}: {
		onContextLost: () => void;
		onRender?: () => void;
		pixelRatio?: number;
		frameMs?: number;
	},
) {
	const renderer = createModelRenderer(canvas, {
		preserveDrawingBuffer: Boolean(onRender),
	});
	renderer.setPixelRatio(pixelRatio);
	const studio = createStudioScene(renderer);
	const { scene } = studio;

	const camera = new PerspectiveCamera(MODEL_FOV, 1, 0.01, 1000);
	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.12;
	controls.autoRotateSpeed = 1.6;

	let model: LoadedModel | null = null;
	let mixer: AnimationMixer | null = null;
	let playing = false;
	let bounds = unitBounds();
	let radius = 1;
	let visible = true;
	let pristine = true;
	let disposed = false;
	let frame = 0;
	let lastFrameAt = 0;
	let transition: {
		start: number;
		fromPosition: Vector3;
		fromTarget: Vector3;
		toPosition: Vector3;
		toTarget: Vector3;
	} | null = null;

	function request() {
		if (frame || disposed || !visible) return;
		frame = requestAnimationFrame(tick);
	}

	function stepTransition(now: number) {
		if (!transition) return false;
		const t = Math.min(1, (now - transition.start) / RESET_MS);
		const eased = easeOutCubic(t);
		camera.position.lerpVectors(
			transition.fromPosition,
			transition.toPosition,
			eased,
		);
		controls.target.lerpVectors(
			transition.fromTarget,
			transition.toTarget,
			eased,
		);
		if (t === 1) transition = null;
		return true;
	}

	function tick(now: number) {
		frame = 0;
		if (lastFrameAt && now - lastFrameAt < frameMs - 1) {
			request();
			return;
		}
		const delta = lastFrameAt ? Math.min((now - lastFrameAt) / 1000, 0.1) : 0;
		lastFrameAt = now;
		let moving = stepTransition(now);
		moving = controls.update(delta) || moving;
		if (mixer && playing) {
			mixer.update(delta);
			moving = true;
		}
		renderer.render(scene, camera);
		onRender?.();
		if (moving || controls.autoRotate) request();
		else lastFrameAt = 0;
	}

	function homeView() {
		return fitModelView(bounds, camera.fov, camera.aspect);
	}

	function applyClipping(distance: number) {
		controls.minDistance = radius * 0.05;
		controls.maxDistance = distance * 10;
		camera.near = distance / 1000;
		camera.far = controls.maxDistance + radius * 2;
		camera.updateProjectionMatrix();
	}

	function resetView(animate = true) {
		const home = homeView();
		applyClipping(home.distance);
		transition = null;
		pristine = true;
		if (animate && !reducedMotion()) {
			transition = {
				start: performance.now(),
				fromPosition: camera.position.clone(),
				fromTarget: controls.target.clone(),
				toPosition: home.position,
				toTarget: home.center,
			};
		} else {
			camera.position.copy(home.position);
			controls.target.copy(home.center);
		}
		request();
	}

	function clearModel() {
		if (!model) return;
		mixer?.stopAllAction();
		mixer?.uncacheRoot(model.root);
		mixer = null;
		playing = false;
		scene.remove(model.root);
		disposeModel(model.root);
		model = null;
	}

	function setModel(next: LoadedModel): ModelStats {
		clearModel();
		model = next;
		scene.add(next.root);
		bounds = modelBounds(next.root);
		radius = modelRadius(bounds);
		const size = bounds.getSize(new Vector3());
		if (next.animations.length > 0) {
			mixer = new AnimationMixer(next.root);
			mixer.clipAction(next.animations[0]).play();
			playing = !reducedMotion();
		}
		resetView(false);
		return {
			triangles: triangleCount(next.root),
			size: [size.x, size.y, size.z],
			animations: next.animations.length,
		};
	}

	function resize(width: number, height: number) {
		if (width <= 0 || height <= 0) return;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		if (pristine && model) resetView(false);
		request();
	}

	const resizeObserver = new ResizeObserver(([entry]) => {
		if (entry) resize(entry.contentRect.width, entry.contentRect.height);
	});
	resizeObserver.observe(canvas);
	// Hidden windows keep their canvas mounted; stop drawing until shown again.
	const visibilityObserver = new IntersectionObserver(([entry]) => {
		visible = Boolean(entry?.isIntersecting);
		if (visible) request();
		else if (frame) {
			cancelAnimationFrame(frame);
			frame = 0;
			lastFrameAt = 0;
		}
	});
	visibilityObserver.observe(canvas);

	const handleContextLost = (event: Event) => {
		event.preventDefault();
		onContextLost();
	};
	canvas.addEventListener("webglcontextlost", handleContextLost);
	const handleStart = () => {
		pristine = false;
		transition = null;
	};
	controls.addEventListener("start", handleStart);
	controls.addEventListener("change", request);

	return {
		setModel,
		clearModel,
		resetView: () => resetView(true),
		setAutoRotate(on: boolean) {
			controls.autoRotate = on;
			request();
		},
		setWireframe(on: boolean) {
			if (!model) return;
			for (const material of materialsOf(model.root)) {
				if ("wireframe" in material) material.wireframe = on;
			}
			request();
		},
		setPixelRatio(ratio: number) {
			if (renderer.getPixelRatio() === ratio) return;
			renderer.setPixelRatio(ratio);
			resize(canvas.clientWidth, canvas.clientHeight);
		},
		setPlaying(on: boolean) {
			playing = on && Boolean(mixer);
			request();
		},
		get playing() {
			return playing;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (frame) cancelAnimationFrame(frame);
			resizeObserver.disconnect();
			visibilityObserver.disconnect();
			controls.removeEventListener("start", handleStart);
			controls.removeEventListener("change", request);
			canvas.removeEventListener("webglcontextlost", handleContextLost);
			controls.dispose();
			clearModel();
			studio.dispose();
			renderer.dispose();
			// Free the context now; browsers cap how many can be alive at once.
			renderer.forceContextLoss();
		},
	};
}
