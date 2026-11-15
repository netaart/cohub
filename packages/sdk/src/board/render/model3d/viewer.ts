import { Application } from "pixi.js";
import type { LoadedModel } from "./load.js";
import { createModelScene, type ModelScene } from "./scene.js";

export type ModelViewer = {
	setModel(model: LoadedModel | null): void;
	readonly animated: boolean;
	playing: boolean;
	home(): void;
	destroy(): void;
};

export type ModelViewerOptions = {
	reducedMotion?: boolean;
	onContextLost?: () => void;
};

export async function mountModelViewer(canvas: HTMLCanvasElement, options: ModelViewerOptions = {}): Promise<ModelViewer> {
	const app = new Application();
	await app.init({
		canvas,
		preference: "webgl",
		width: Math.max(1, canvas.clientWidth),
		height: Math.max(1, canvas.clientHeight),
		resolution: Math.min(globalThis.devicePixelRatio || 1, 2),
		autoDensity: false,
		backgroundAlpha: 0,
		antialias: true,
		autoStart: false,
	});
	let current: { model: LoadedModel; scene: ModelScene } | null = null;
	let frame = 0;
	let last = 0;
	let visible = true;
	let destroyed = false;

	function layout() {
		const width = Math.max(1, canvas.clientWidth);
		const height = Math.max(1, canvas.clientHeight);
		if (app.screen.width !== width || app.screen.height !== height) app.renderer.resize(width, height);
		current?.scene.resize(width, height, 1, app.renderer.resolution);
		request();
	}

	function tick(now: number) {
		frame = 0;
		const scene = current?.scene;
		const moving = scene ? scene.step(last ? now - last : 0) || scene.playing : false;
		app.render();
		last = moving ? now : 0;
		if (moving) request();
	}

	function request() {
		if (!frame && visible && !destroyed) frame = requestAnimationFrame(tick);
	}

	const resizeObserver = new ResizeObserver(layout);
	resizeObserver.observe(canvas);
	const visibility = new IntersectionObserver(([entry]) => {
		visible = Boolean(entry?.isIntersecting);
		if (visible) request();
		else {
			cancelAnimationFrame(frame);
			frame = 0;
			last = 0;
		}
	});
	visibility.observe(canvas);

	const onDown = (event: PointerEvent) => {
		if (!current || event.button > 0) return;
		canvas.setPointerCapture(event.pointerId);
		current.scene.press(event.pointerId, event.clientX, event.clientY);
	};
	const onMove = (event: PointerEvent) => {
		if (!canvas.hasPointerCapture(event.pointerId)) return;
		current?.scene.move(event.pointerId, event.clientX, event.clientY);
		request();
	};
	const onUp = (event: PointerEvent) => current?.scene.release(event.pointerId);
	const onWheel = (event: WheelEvent) => {
		if (!current) return;
		event.preventDefault();
		current.scene.wheel(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
		request();
	};
	const onDoubleClick = () => {
		current?.scene.home();
		request();
	};
	const onContextLost = (event: Event) => {
		event.preventDefault();
		options.onContextLost?.();
	};
	const listeners: [string, EventListener, AddEventListenerOptions?][] = [
		["pointerdown", onDown as EventListener],
		["pointermove", onMove as EventListener],
		["pointerup", onUp as EventListener],
		["pointercancel", onUp as EventListener],
		["wheel", onWheel as EventListener, { passive: false }],
		["dblclick", onDoubleClick],
		["webglcontextlost", onContextLost],
	];
	for (const [type, listener, listenerOptions] of listeners) canvas.addEventListener(type, listener, listenerOptions);

	function clear() {
		if (!current) return;
		app.stage.removeChild(current.scene.view);
		current.scene.destroy();
		current.model.destroy();
		current = null;
	}

	return {
		setModel(model) {
			clear();
			if (model) {
				const scene = createModelScene(model, { reducedMotion: options.reducedMotion });
				current = { model, scene };
				app.stage.addChild(scene.view);
				scene.playing = !options.reducedMotion;
			}
			layout();
		},
		get animated() {
			return current?.scene.animated ?? false;
		},
		get playing() {
			return current?.scene.playing ?? false;
		},
		set playing(value) {
			if (current) current.scene.playing = value;
			request();
		},
		home() {
			current?.scene.home();
			request();
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			cancelAnimationFrame(frame);
			resizeObserver.disconnect();
			visibility.disconnect();
			for (const [type, listener] of listeners) canvas.removeEventListener(type, listener);
			clear();
			app.destroy({ removeView: false }, { children: true });
		},
	};
}
