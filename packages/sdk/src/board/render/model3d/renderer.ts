import type { Renderer, WebGLRenderer } from "pixi.js";
import "@pixi/3d";

type Named = { name: string; value: unknown };
type Part = { init?(options: unknown): void; contextChange?(gl: unknown): void };
type StartedRenderer = {
	gl?: WebGLRenderer["gl"];
	renderPipes: Record<string, Part | undefined>;
	config: { loaders: { value: { load(): Promise<unknown> } }[]; systems: Named[]; renderPipes: Named[]; renderPipeAdaptors: Named[] };
	_systemsHash: Record<string, Part | undefined>;
	_initOptions: unknown;
	_addSystems(systems: Named[]): void;
	_addPipes(pipes: Named[], adaptors: Named[]): void;
};

const prepared = new WeakMap<Renderer, Promise<void>>();

/** PixiJS 3D is loaded on demand, after the stage renderer started, so it gets 3D's systems itself. */
export function prepareModelRenderer(renderer: Renderer): Promise<void> {
	let pending = prepared.get(renderer);
	if (!pending) {
		pending = adopt(renderer as unknown as StartedRenderer).catch((error) => {
			prepared.delete(renderer);
			throw error;
		});
		prepared.set(renderer, pending);
	}
	return pending;
}

async function adopt(renderer: StartedRenderer) {
	const pipeline = renderer.renderPipes;
	if (pipeline.view3d) return;
	await Promise.all(renderer.config.loaders.map((loader) => loader.value.load()));
	const systems = renderer.config.systems.filter(({ name }) => !renderer._systemsHash[name]);
	const pipes = renderer.config.renderPipes.filter(({ name }) => !pipeline[name]);
	renderer._addSystems(systems);
	renderer._addPipes(pipes, renderer.config.renderPipeAdaptors);
	const gl = renderer.gl;
	for (const { name } of systems) renderer._systemsHash[name]?.init?.(renderer._initOptions);
	for (const part of [...systems.map(({ name }) => renderer._systemsHash[name]), ...pipes.map(({ name }) => pipeline[name])]) part?.contextChange?.(gl);
}
