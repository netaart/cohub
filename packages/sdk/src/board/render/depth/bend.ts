import { type Renderer, RendererType, type WebGLRenderer } from "pixi.js";
import { BOARD_SHADER_LIBRARY } from "../shader/library.js";
import { BOARD_SHADER_ITERATIONS, describeBoardShaderError, prepareBoardShaderSource } from "../shader/program.js";

export type BoardDepthBendSource = { glsl: string };

export type BoardDepthBend = {
	readonly key: string;
	readonly header: string;
};

const PREPARED_LIMIT = 64;
const prepared = new Map<string, BoardDepthBend | Error>();
const checked = new WeakMap<WebGL2RenderingContext, Map<string, string | null>>();
let sources = 0;

function remember(glsl: string, result: BoardDepthBend | Error) {
	if (prepared.size >= PREPARED_LIMIT) prepared.delete(prepared.keys().next().value as string);
	prepared.set(glsl, result);
}

export function isBoardDepthBendSource(value: unknown): value is BoardDepthBendSource {
	return !!value && typeof value === "object" && typeof (value as { glsl?: unknown }).glsl === "string";
}

export function prepareBoardDepthBend(source: BoardDepthBendSource): BoardDepthBend {
	const cached = prepared.get(source.glsl);
	if (cached instanceof Error) throw cached;
	if (cached) return cached;
	try {
		if (source.glsl.length > 64_000) throw new Error("bend GLSL is longer than 64000 characters.");
		const { code, includes } = prepareBoardShaderSource(source.glsl);
		if (!/\bvec3\s+bend\s*\(/.test(code)) throw new Error("bend GLSL must define vec3 bend(vec2 uv, vec2 size, float amount, float phase).");
		const header = [
			"int cohubIterations;",
			`bool cohubStep() { cohubIterations++; return cohubIterations <= ${BOARD_SHADER_ITERATIONS}; }`,
			...includes.map((name) => BOARD_SHADER_LIBRARY[name] ?? ""),
			"#define bend cohubBend",
			code,
			"#undef bend",
		].join("\n");
		const bend = { key: String(++sources), header };
		remember(source.glsl, bend);
		return bend;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		remember(source.glsl, failure);
		throw failure;
	}
}

export function compileBoardDepthBend(renderer: Renderer, bend: BoardDepthBend, label: string): string | null {
	if (renderer.type !== RendererType.WEBGL) return `${label}: custom bends need a WebGL renderer`;
	const gl = (renderer as WebGLRenderer).gl as WebGL2RenderingContext;
	const results = checked.get(gl) ?? new Map<string, string | null>();
	checked.set(gl, results);
	if (results.has(bend.key)) return results.get(bend.key) ?? null;
	const prefix = "#version 300 es\nprecision highp float;\nprecision highp int;\n";
	const vertex = `${prefix}${bend.header}\nvoid main() { vec3 d = cohubBend(vec2(0.5), vec2(1.0), 0.0, 0.0); gl_Position = vec4(d, 1.0); }\n`;
	const fragment = `${prefix}out vec4 color;\nvoid main() { color = vec4(1.0); }\n`;
	const shaders = [gl.createShader(gl.VERTEX_SHADER), gl.createShader(gl.FRAGMENT_SHADER)] as WebGLShader[];
	const program = gl.createProgram() as WebGLProgram;
	let error: string | null = null;
	try {
		[vertex, fragment].forEach((code, index) => {
			const shader = shaders[index] as WebGLShader;
			gl.shaderSource(shader, code);
			gl.compileShader(shader);
			gl.attachShader(program, shader);
		});
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getShaderInfoLog(shaders[0] as WebGLShader) || gl.getProgramInfoLog(program) || "";
			const userLine = prefix.split("\n").length - 1 + bend.header.split("\n").indexOf("#define bend cohubBend") + 2;
			error = describeBoardShaderError(log, userLine, label);
		}
	} finally {
		for (const shader of shaders) {
			gl.detachShader(program, shader);
			gl.deleteShader(shader);
		}
		gl.deleteProgram(program);
	}
	results.set(bend.key, error);
	return error;
}
