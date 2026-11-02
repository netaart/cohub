import {
  type BLEND_MODES,
  Container,
  Filter,
  GlProgram,
  type Renderer,
  type RenderTexture,
  RendererType,
  Texture,
  UniformGroup,
  type WebGLRenderer,
} from "pixi.js";
import type { BoardMatrix } from "@cohub/protocol/board-layout";
import type { Rect } from "../../model/geometry.js";
import {
  type BoardShaderParameter,
  type BoardShaderUniform,
  boardShaderUniforms,
  boardShaderUniformValue,
} from "../../model/shader.js";
import type { BoardShader, BoardShaderUniformValues } from "../../model/script.js";
import { type BoardShaderProgram, type BoardShaderProgramKind, buildBoardShaderProgram, describeBoardShaderError } from "./program.js";
import { type BoardShaderMesh, boardQuadGeometry, boardRenderTarget, boardShaderMesh, destroyBoardShaderMesh, setUniform } from "./quad.js";

export type BoardShaderFrame = {
  time: number;
  region: Rect;
  view: Rect;
  localToGlobal: BoardMatrix;
  zoom: number;
  density: number;
  seed: number;
  quality: number;
  dark: boolean;
  params: Readonly<Record<string, number | readonly number[]>>;
  uniforms?: BoardShaderUniformValues;
};

export type BoardShaderLayer = {
  readonly layer: NonNullable<BoardShader["layer"]>;
  readonly container: Container | null;
  readonly filters: readonly Filter[] | null;
  readonly surfaces: boolean;
  readonly animated: boolean;
  update(frame: BoardShaderFrame): void;
  prepare(renderer: Renderer, options?: { catchUp?: boolean }): boolean;
  setSurfaces(texture: Texture, region: Rect): void;
  destroy(): void;
};

const STEP_MS = 1000 / 60;
const STEPS_PER_FRAME = 8;
const PIXI_TYPES = { float: "f32", int: "i32", vec2: "vec2<f32>", vec3: "vec3<f32>", vec4: "vec4<f32>" } as const;
const SIZES = { float: 1, int: 1, vec2: 2, vec3: 3, vec4: 4 } as const;

const compiled = new Map<string, string | null>();

function check(renderer: Renderer, program: BoardShaderProgram, label: string) {
  if (renderer.type !== RendererType.WEBGL) return;
  const key = `${program.vertex}\u0000${program.fragment}`;
  let error = compiled.get(key);
  if (error === undefined) {
    const gl = (renderer as WebGLRenderer).gl;
    error = null;
    const shaders: WebGLShader[] = [];
    const glProgram = gl.createProgram();
    for (const [stage, type, source, first] of [
      ["vertex", gl.VERTEX_SHADER, program.vertex, program.firstLine.vertex],
      ["fragment", gl.FRAGMENT_SHADER, program.fragment, program.firstLine.fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) continue;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      shaders.push(shader);
      if (!error && !gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost())
        error = describeBoardShaderError(gl.getShaderInfoLog(shader) ?? "", first, `${label} (${stage})`);
      gl.attachShader(glProgram, shader);
    }
    if (!error) {
      gl.linkProgram(glProgram);
      if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS) && !gl.isContextLost())
        error = `${label}: ${gl.getProgramInfoLog(glProgram) ?? "the shader failed to link"}`;
    }
    for (const shader of shaders) gl.deleteShader(shader);
    gl.deleteProgram(glProgram);
    if (compiled.size > 256) compiled.clear();
    compiled.set(key, error);
  }
  if (error) throw new Error(error);
}

function boardUniforms(parameters: readonly BoardShaderParameter[], uniforms: readonly BoardShaderUniform[]): UniformGroup {
  const vec = (size: number) => new Float32Array(size);
  const fields: Record<string, { value: unknown; type: string; size?: number }> = {
    "board.time": { value: 0, type: "f32" },
    "board.delta": { value: 0, type: "f32" },
    "board.frame": { value: 0, type: "i32" },
    "board.size": { value: vec(2), type: "vec2<f32>" },
    "board.view": { value: vec(4), type: "vec4<f32>" },
    "board.resolution": { value: vec(2), type: "vec2<f32>" },
    "board.zoom": { value: 1, type: "f32" },
    "board.seed": { value: 0, type: "f32" },
    "board.quality": { value: 1, type: "f32" },
    "board.dark": { value: 0, type: "f32" },
    uCohubGeometry: { value: vec(4), type: "vec4<f32>" },
    uCohubRegion: { value: vec(4), type: "vec4<f32>" },
    uCohubSurfaceRegion: { value: new Float32Array([0, 0, 1, 1]), type: "vec4<f32>" },
    uCohubGlobalToLocal: { value: vec(9), type: "mat3x3<f32>" },
    uCohubLocalToGlobal: { value: vec(9), type: "mat3x3<f32>" },
  };
  for (const { name, type } of parameters) fields[`params.${name}`] = { value: type === "float" ? 0 : vec(4), type: PIXI_TYPES[type] };
  for (const { name, type, length } of uniforms) {
    const size = SIZES[type] * (length ?? 1);
    const value = size === 1 ? 0 : type === "int" ? new Int32Array(size) : vec(size);
    fields[`uniforms.${name}`] = { value, type: PIXI_TYPES[type], ...(length === null ? {} : { size: length }) };
  }
  return new UniformGroup(fields as ConstructorParameters<typeof UniformGroup>[0]);
}

function columns(m: BoardMatrix): number[] {
  return [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1];
}

function inverse(m: BoardMatrix): BoardMatrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function seedOf(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash / 4294967296;
}

export function boardShaderSeed(seed: string): number {
  return seedOf(seed);
}

export function createBoardShaderLayer(
  renderer: Renderer,
  shader: BoardShader,
  parameters: readonly BoardShaderParameter[],
  label: string,
): BoardShaderLayer {
  const layer = shader.layer ?? "above";
  const uniforms = boardShaderUniforms(shader.uniforms);
  const surfaces = shader.surfaces === true;
  const hasState = shader.state !== undefined;
  const base = { parameters, uniforms, surfaces, state: hasState };
  const program = (kind: BoardShaderProgramKind, glsl: string, name: string) => {
    const built = buildBoardShaderProgram({ ...base, kind, glsl });
    check(renderer, built, name);
    return built;
  };
  const group = boardUniforms(parameters, uniforms);
  const textures: Record<string, unknown> = {};
  if (surfaces) textures.uCohubSurfaces = Texture.EMPTY.source;
  if (hasState) textures.uCohubState = Texture.EMPTY.source;

  const meshes: Array<BoardShaderMesh & { sprites: number }> = [];
  const filters: Filter[] = [];
  const container = layer === "filter" ? null : new Container({ label: `board-shader-${label}` });
  shader.passes.forEach((pass, index) => {
    const name = `${label} pass ${index + 1}`;
    if (layer === "filter") {
      const built = program("filter", pass.glsl, name);
      const filter = new Filter({
        glProgram: GlProgram.from({ name: `board-shader-filter`, vertex: built.vertex, fragment: built.fragment, preferredFragmentPrecision: "highp" }),
        resources: { cohubUniforms: group, ...textures },
        padding: 0,
      });
      filters.push(filter);
      return;
    }
    const sprites = pass.sprites ?? 0;
    const built = program(sprites ? "sprites" : "box", pass.glsl, name);
    const drawn = boardShaderMesh("board-shader", built, { cohubUniforms: group, ...textures }, boardQuadGeometry(Math.max(1, sprites)));
    drawn.mesh.blendMode = (pass.blend ?? "normal") as BLEND_MODES;
    container?.addChild(drawn.mesh);
    meshes.push({ ...drawn, sprites });
  });

  let state: { simulate: BoardShaderMesh; uniforms: UniformGroup; read: RenderTexture; write: RenderTexture; steps: number } | null = null;
  if (shader.state) {
    const { width, height, glsl, precision } = shader.state;
    const stateGroup = boardUniforms(parameters, uniforms);
    const simulate = boardShaderMesh("board-shader-state", program("simulate", glsl, `${label} state`), { cohubUniforms: stateGroup, ...textures });
    const format = precision === "byte" ? "rgba8unorm" : "rgba16float";
    state = { simulate, uniforms: stateGroup, read: boardRenderTarget(width, height, format), write: boardRenderTarget(width, height, format), steps: -1 };
  }

  const blank = new Container();
  let time = 0;
  let quality = 1;
  let last: BoardShaderFrame | null = null;

  function fill(target: UniformGroup, frame: BoardShaderFrame, geometry: Rect, step?: number) {
    const values = target.uniforms as Record<string, unknown>;
    values["board.time"] = (step === undefined ? frame.time : step * STEP_MS) / 1000;
    values["board.delta"] = step === undefined ? Math.max(0, frame.time - time) / 1000 : STEP_MS / 1000;
    values["board.frame"] = step ?? Math.floor(frame.time / STEP_MS);
    setUniform(target, "board.size", [frame.region.width, frame.region.height]);
    setUniform(target, "board.view", [frame.view.x, frame.view.y, frame.view.width, frame.view.height]);
    setUniform(target, "board.resolution", [frame.region.width * frame.zoom * frame.density, frame.region.height * frame.zoom * frame.density]);
    values["board.zoom"] = frame.zoom;
    values["board.seed"] = frame.seed;
    values["board.quality"] = frame.quality;
    values["board.dark"] = frame.dark ? 1 : 0;
    setUniform(target, "uCohubGeometry", [geometry.x, geometry.y, geometry.width, geometry.height]);
    setUniform(target, "uCohubRegion", [frame.region.x, frame.region.y, frame.region.width, frame.region.height]);
    setUniform(target, "uCohubLocalToGlobal", columns(frame.localToGlobal));
    setUniform(target, "uCohubGlobalToLocal", columns(inverse(frame.localToGlobal)));
    for (const { name, type } of parameters) {
      const value = frame.params[name];
      setUniform(target, `params.${name}`, type === "float" ? (typeof value === "number" ? value : 0) : (Array.isArray(value) ? value : [0, 0, 0, 0]));
    }
    for (const uniform of uniforms) {
      const value = boardShaderUniformValue(uniform, frame.uniforms?.[uniform.name]);
      if (!value) throw new Error(`uniforms.${uniform.name} does not match its declaration ${uniform.type}${uniform.length === null ? "" : `[${uniform.length}]`}.`);
      setUniform(target, `uniforms.${uniform.name}`, value.length === 1 ? (value[0] as number) : value);
    }
    target.update();
  }

  return {
    layer,
    container,
    filters: layer === "filter" ? filters : null,
    surfaces,
    animated: hasState,
    update(frame) {
      fill(group, frame, frame.region);
      time = frame.time;
      last = frame;
      if (frame.quality !== quality) {
        quality = frame.quality;
        for (const { geometry, sprites } of meshes)
          if (sprites) geometry.instanceCount = Math.max(1, Math.round(sprites * quality));
      }
    },
    prepare(target, options) {
      if (!state || !last) return false;
      const wanted = Math.floor(last.time / STEP_MS);
      if (wanted < state.steps || state.steps < 0) {
        for (const texture of [state.read, state.write]) target.render({ container: blank, target: texture, clear: true, clearColor: [0, 0, 0, 0] });
        state.steps = 0;
      }
      const limit = options?.catchUp ? Number.POSITIVE_INFINITY : STEPS_PER_FRAME;
      let ran = 0;
      while (state.steps < wanted && ran < limit) {
        fill(state.uniforms, last, { x: 0, y: 0, width: state.write.width, height: state.write.height }, state.steps);
        state.simulate.shader.resources.uCohubState = state.read.source;
        target.render({ container: state.simulate.mesh, target: state.write, clear: true });
        [state.read, state.write] = [state.write, state.read];
        state.steps++;
        ran++;
      }
      const source = state.read.source;
      for (const { shader } of meshes) shader.resources.uCohubState = source;
      for (const filter of filters) filter.resources.uCohubState = source;
      return state.steps < wanted;
    },
    setSurfaces(texture, region) {
      for (const { shader } of meshes) shader.resources.uCohubSurfaces = texture.source;
      for (const filter of filters) filter.resources.uCohubSurfaces = texture.source;
      if (state) state.simulate.shader.resources.uCohubSurfaces = texture.source;
      for (const target of state ? [group, state.uniforms] : [group]) {
        setUniform(target, "uCohubSurfaceRegion", [region.x, region.y, region.width, region.height]);
        target.update();
      }
    },
    destroy() {
      for (const drawn of meshes) destroyBoardShaderMesh(drawn);
      container?.destroy();
      for (const filter of filters) filter.destroy();
      blank.destroy();
      if (state) {
        destroyBoardShaderMesh(state.simulate);
        state.read.destroy(true);
        state.write.destroy(true);
      }
    },
  };
}
