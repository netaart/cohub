import {
  defaultValue,
  extractAttributesFromGlProgram,
  type GlProgram,
  GlProgramData,
  getUboData,
  getUniformData,
  type Renderer,
  RendererType,
  type WebGLRenderer,
} from "pixi.js";
import { describeBoardShaderError } from "./program.js";

export type BoardProgramCompile = { poll(): boolean; cancel(): void };

type Job = { gl: WebGL2RenderingContext; program: WebGLProgram; shaders: [WebGLShader, WebGLShader] };

const READY: BoardProgramCompile = { poll: () => true, cancel() {} };
const COMPLETION_STATUS = 0x91b1;
const failures = new Map<number, string>();
const parallel = new WeakMap<WebGL2RenderingContext, boolean>();

type ProgramCache = Record<number, GlProgramData | undefined>;

function programs(renderer: WebGLRenderer): ProgramCache | null {
  return (renderer.shader as unknown as { _programDataHash?: ProgramCache })._programDataHash ?? null;
}

// Pixi compiles a program on its first draw and blocks until it links; this
// links it here instead, in the background where the driver allows, and hands
// the result to Pixi so the draw finds it ready. Mirrors Pixi's generateProgram.
function adopt(gl: WebGL2RenderingContext, glProgram: GlProgram, program: WebGLProgram, cache: ProgramCache) {
  glProgram._attributeData = extractAttributesFromGlProgram(program, gl, false);
  glProgram._uniformData = getUniformData(program, gl);
  glProgram._uniformBlockData = getUboData(program, gl);
  const uniforms: Record<string, { location: WebGLUniformLocation; value: unknown }> = {};
  for (const [name, data] of Object.entries(glProgram._uniformData))
    uniforms[name] = { location: gl.getUniformLocation(program, name) as WebGLUniformLocation, value: defaultValue(data.type, data.size) };
  cache[glProgram._key] = new GlProgramData(program, uniforms as ConstructorParameters<typeof GlProgramData>[1]);
}

function lineShift(raw: string, final: string): number {
  return final.split("\n").length - raw.split("\n").length;
}

export function compileBoardProgram(
  renderer: Renderer,
  glProgram: GlProgram,
  source: { vertex: string; fragment: string; firstLine: { vertex: number; fragment: number } },
  label: string,
  wait: boolean,
): BoardProgramCompile {
  if (renderer.type !== RendererType.WEBGL) return READY;
  const failure = failures.get(glProgram._key);
  if (failure) throw new Error(failure);
  const cache = programs(renderer as WebGLRenderer);
  if (cache?.[glProgram._key]) return READY;
  const gl = (renderer as WebGLRenderer).gl as WebGL2RenderingContext;
  if (!parallel.has(gl)) parallel.set(gl, Boolean(gl.getExtension("KHR_parallel_shader_compile")));
  const job: Job = {
    gl,
    program: gl.createProgram() as WebGLProgram,
    shaders: [gl.createShader(gl.VERTEX_SHADER) as WebGLShader, gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader],
  };
  const vertex = glProgram.vertex as string;
  const fragment = glProgram.fragment as string;
  const stages = [
    { shader: job.shaders[0], code: vertex, first: source.firstLine.vertex + lineShift(source.vertex, vertex), name: "vertex" },
    { shader: job.shaders[1], code: fragment, first: source.firstLine.fragment + lineShift(source.fragment, fragment), name: "fragment" },
  ];
  for (const { shader, code } of stages) {
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    gl.attachShader(job.program, shader);
  }
  gl.linkProgram(job.program);
  let done = false;
  const finish = (): true => {
    done = true;
    let error: string | null = null;
    if (!gl.getProgramParameter(job.program, gl.LINK_STATUS) && !gl.isContextLost()) {
      for (const { shader, first, name } of stages)
        if (!error && !gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          error = describeBoardShaderError(gl.getShaderInfoLog(shader) ?? "", first, `${label} (${name})`);
      error ??= `${label}: ${gl.getProgramInfoLog(job.program) ?? "the shader failed to link"}`;
    }
    for (const shader of job.shaders) gl.deleteShader(shader);
    if (error || !cache || gl.isContextLost()) {
      gl.deleteProgram(job.program);
      if (error) {
        if (failures.size > 256) failures.clear();
        failures.set(glProgram._key, error);
        throw new Error(error);
      }
      return true;
    }
    if (cache[glProgram._key]) gl.deleteProgram(job.program);
    else adopt(gl, glProgram, job.program, cache);
    return true;
  };
  if (wait || !parallel.get(gl)) {
    finish();
    return READY;
  }
  return {
    poll: () => done || (gl.getProgramParameter(job.program, COMPLETION_STATUS) === true ? finish() : false),
    cancel() {
      if (done) return;
      done = true;
      for (const shader of job.shaders) gl.deleteShader(shader);
      gl.deleteProgram(job.program);
    },
  };
}
