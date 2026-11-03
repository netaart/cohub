import {
  AlphaFilter,
  type BLEND_MODES,
  Container,
  Filter,
  type GlProgram,
  Rectangle,
  type Renderer,
  RenderTarget,
  type RenderTexture,
  RendererType,
  Sprite,
  Texture,
  TextureSource,
  UniformGroup,
  type WebGLRenderer,
} from "pixi.js";
import type { BoardMatrix } from "@cohub/protocol/board-layout";
import type { Rect } from "../../model/geometry.js";
import {
  type BoardShaderParameter,
  type BoardShaderUniform,
  boardShaderPassLayer,
  boardShaderPassOn,
  boardShaderUniforms,
  boardShaderUniformValue,
} from "../../model/shader.js";
import type { BoardShader, BoardShaderPass, BoardShaderPassStates, BoardShaderUniformValues } from "../../model/script.js";
import { type BoardProgramCompile, compileBoardProgram } from "./compile.js";
import { BOARD_SPRITE_COLUMNS, BOARD_SPRITE_PLACEMENTS, type BoardShaderProgramKind, buildBoardShaderProgram } from "./program.js";
import {
  type BoardShaderMesh,
  boardGlProgram,
  boardQuadGeometry,
  boardRenderTarget,
  boardShaderMesh,
  destroyBoardShaderMesh,
  setUniform,
} from "./quad.js";

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
  passes?: BoardShaderPassStates;
  shading?: number;
};

export type BoardShaderLayer = {
  readonly below: Container | null;
  readonly above: Container | null;
  readonly filters: readonly Filter[] | null;
  readonly surfaces: boolean;
  readonly animated: boolean;
  ready(): boolean;
  update(frame: BoardShaderFrame): void;
  prepare(renderer: Renderer, options?: { catchUp?: boolean }): boolean;
  setSurfaces(texture: Texture, region: Rect, key?: string): void;
  rewind(): void;
  destroy(): void;
};

const STEP_MS = 1000 / 60;
const STEPS_PER_FRAME = 8;
const MAX_LAG = 60;
const MAX_REPLAY = 10 * 60 * 60;
const CHECKPOINT_STEPS = 10 * 60;
const CHECKPOINTS = 6;
const PIXI_TYPES = { float: "f32", int: "i32", vec2: "vec2<f32>", vec3: "vec3<f32>", vec4: "vec4<f32>" } as const;
const SIZES = { float: 1, int: 1, vec2: 2, vec3: 3, vec4: 4 } as const;

const placing = new WeakMap<Renderer, boolean>();

function canPlaceSprites(renderer: Renderer): boolean {
  let supported = placing.get(renderer);
  if (supported === undefined) {
    const gl = renderer.type === RendererType.WEBGL ? (renderer as WebGLRenderer).gl : null;
    supported = Boolean(gl?.getExtension("EXT_color_buffer_float") && gl.getParameter(gl.MAX_DRAW_BUFFERS) >= BOARD_SPRITE_PLACEMENTS.length);
    placing.set(renderer, supported);
  }
  return supported;
}

type Placement = { mesh: BoardShaderMesh; uniforms: UniformGroup; target: RenderTarget; textures: TextureSource[] };

function createPlacement(mesh: BoardShaderMesh, uniforms: UniformGroup, sprites: number): Placement {
  // Blending into 32-bit float targets needs EXT_float_blend.
  mesh.mesh.blendMode = "none";
  const height = Math.ceil(sprites / BOARD_SPRITE_COLUMNS);
  const textures = BOARD_SPRITE_PLACEMENTS.map(() =>
    new TextureSource({ width: BOARD_SPRITE_COLUMNS, height, resolution: 1, format: "rgba32float", scaleMode: "nearest", autoGenerateMipmaps: false }));
  return { mesh, uniforms, target: new RenderTarget({ colorTextures: textures, width: BOARD_SPRITE_COLUMNS, height, resolution: 1 }), textures };
}

// Pixi has no public release for a render target it did not create.
function destroyPlacement(renderer: Renderer, placement: Placement) {
  const system = renderer.renderTarget as unknown as {
    _renderSurfaceToRenderTargetHash?: Map<unknown, unknown>;
    _gpuRenderTargetHash?: Record<number, unknown>;
    adaptor?: { destroyGpuRenderTarget(target: unknown): void };
  };
  const gpu = system._gpuRenderTargetHash?.[placement.target.uid];
  if (gpu && system._gpuRenderTargetHash) {
    system._gpuRenderTargetHash[placement.target.uid] = null;
    system.adaptor?.destroyGpuRenderTarget(gpu);
  }
  system._renderSurfaceToRenderTargetHash?.delete(placement.target);
  placement.target.destroy();
  for (const texture of placement.textures) texture.destroy();
  destroyBoardShaderMesh(placement.mesh);
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
    uCohubSpriteCount: { value: 0, type: "i32" },
    uCohubRegion: { value: vec(4), type: "vec4<f32>" },
    uCohubSurfaceRegion: { value: new Float32Array([0, 0, 1, 1]), type: "vec4<f32>" },
    uCohubStateRegion: { value: new Float32Array([0, 0, 1, 1]), type: "vec4<f32>" },
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
  options: { wait?: boolean } = {},
): BoardShaderLayer {
  const uniforms = boardShaderUniforms(shader.uniforms);
  const surfaces = shader.surfaces === true;
  const hasState = shader.state !== undefined;
  const base = { parameters, uniforms, surfaces, state: hasState };
  const compiles: BoardProgramCompile[] = [];
  const program = (kind: BoardShaderProgramKind, glsl: string, name: string): GlProgram => {
    try {
      const built = buildBoardShaderProgram({ ...base, kind, glsl });
      const glProgram = boardGlProgram(`board-shader-${kind}`, built);
      compiles.push(compileBoardProgram(renderer, glProgram, built, name, options.wait === true));
      return glProgram;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith(name) ? message : `${name}: ${message}`);
    }
  };
  const group = boardUniforms(parameters, uniforms);
  const textures: Record<string, unknown> = {};
  if (surfaces) textures.uCohubSurfaces = Texture.EMPTY.source;
  if (hasState) textures.uCohubState = Texture.EMPTY.source;

  type Drawn = BoardShaderMesh & { pass: BoardShaderPass; sprites: number; placement: Placement | null; scaler: AlphaFilter | null };
  const meshes: Drawn[] = [];
  const filters: Array<{ filter: Filter; pass: BoardShaderPass }> = [];
  const containers: { below: Container | null; above: Container | null } = { below: null, above: null };
  const area = new Rectangle();
  const place = canPlaceSprites(renderer);
  let placementsStale = true;
  shader.passes.forEach((pass, index) => {
    const name = `${label} pass ${index + 1}`;
    const layer = boardShaderPassLayer(shader, pass);
    if (layer === "filter") {
      const filter = new Filter({
        glProgram: program("filter", pass.glsl, name),
        resources: { cohubUniforms: group, ...textures },
        padding: 0,
        resolution: "inherit",
      });
      filters.push({ filter, pass });
      return;
    }
    const sprites = pass.sprites ?? 0;
    let placement: Placement | null = null;
    if (sprites && place) {
      const own = boardUniforms(parameters, uniforms);
      placement = createPlacement(boardShaderMesh("board-shader-place", program("place", pass.glsl, name), { cohubUniforms: own, ...textures }), own, sprites);
    }
    const kind = !sprites ? "box" : placement ? "placed" : "sprites";
    const resources: Record<string, unknown> = { cohubUniforms: group, ...textures };
    placement?.textures.forEach((texture, slot) => { resources[BOARD_SPRITE_PLACEMENTS[slot] as string] = texture; });
    const drawn = boardShaderMesh("board-shader", program(kind, pass.glsl, name), resources, boardQuadGeometry(Math.max(1, sprites)));
    drawn.mesh.blendMode = (pass.blend ?? "normal") as BLEND_MODES;
    containers[layer] ??= new Container({ label: `board-shader-${label}-${layer}` });
    const container = containers[layer];
    container.boundsArea = area;
    container.addChild(drawn.mesh);
    meshes.push({ ...drawn, pass, sprites, placement, scaler: null });
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
  let compiled = compiles.length === 0;
  let last: BoardShaderFrame | null = null;

  const stateRegion = (frame: BoardShaderFrame): Rect => shader.state?.bounds ?? frame.region;
  function fill(target: UniformGroup, frame: BoardShaderFrame, geometry: Rect, step?: number) {
    const region = step === undefined ? frame.region : stateRegion(frame);
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
    setUniform(target, "uCohubRegion", [region.x, region.y, region.width, region.height]);
    if (shader.state) {
      const area = stateRegion(frame);
      setUniform(target, "uCohubStateRegion", [area.x, area.y, area.width, area.height]);
    }
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

  type State = NonNullable<typeof state>;
  const checkpoints: Array<{ steps: number; key: string; texture: RenderTexture }> = [];
  let surfaceKey = "";
  const copier = new Sprite();
  copier.blendMode = "none";
  const copy = (target: Renderer, from: RenderTexture, to: RenderTexture) => {
    copier.texture = from;
    target.render({ container: copier, target: to, clear: true, clearColor: [0, 0, 0, 0] });
  };
  const inputs = ({ time: _time, ...frame }: BoardShaderFrame) => JSON.stringify([frame, surfaceKey]);

  function checkpoint(target: Renderer, state: State, key: string) {
    if (checkpoints.some((entry) => entry.steps === state.steps && entry.key === key)) return;
    const reused = checkpoints.length >= CHECKPOINTS ? checkpoints.shift() : undefined;
    const texture = reused?.texture ?? boardRenderTarget(state.read.width, state.read.height, state.read.source.format);
    copy(target, state.read, texture);
    checkpoints.push({ steps: state.steps, key, texture });
  }

  function advance(target: Renderer, state: State, frame: BoardShaderFrame, catchUp: boolean): { ran: number; behind: boolean } {
    const wanted = Math.floor(frame.time / STEP_MS);
    const key = catchUp ? inputs(frame) : "";
    let replaying = false;
    if (wanted < state.steps || state.steps < 0) {
      replaying = catchUp;
      for (const texture of [state.read, state.write]) target.render({ container: blank, target: texture, clear: true, clearColor: [0, 0, 0, 0] });
      state.steps = Math.max(0, wanted - MAX_REPLAY);
      const resume = catchUp
        ? checkpoints.reduce<(typeof checkpoints)[number] | null>((best, entry) =>
            entry.key === key && entry.steps <= wanted && entry.steps > (best?.steps ?? state.steps - 1) ? entry : best, null)
        : null;
      if (resume) {
        copy(target, resume.texture, state.read);
        state.steps = resume.steps;
      }
    }
    if (!catchUp && wanted - state.steps > MAX_LAG) state.steps = wanted - STEPS_PER_FRAME;
    const limit = catchUp ? Number.POSITIVE_INFINITY : STEPS_PER_FRAME;
    let ran = 0;
    while (state.steps < wanted && ran < limit) {
      fill(state.uniforms, frame, { x: 0, y: 0, width: state.write.width, height: state.write.height }, state.steps);
      state.simulate.shader.resources.uCohubState = state.read.source;
      target.render({ container: state.simulate.mesh, target: state.write, clear: true });
      [state.read, state.write] = [state.write, state.read];
      state.steps++;
      ran++;
      if (replaying && state.steps % CHECKPOINT_STEPS === 0) checkpoint(target, state, key);
    }
    const source = state.read.source;
    for (const { shader, placement } of meshes) {
      shader.resources.uCohubState = source;
      if (placement) placement.mesh.shader.resources.uCohubState = source;
    }
    for (const { filter } of filters) filter.resources.uCohubState = source;
    return { ran, behind: state.steps < wanted };
  }

  function shade(drawn: Drawn, frame: BoardShaderFrame) {
    const resolution = frame.density * Math.min(1, frame.shading ?? 1);
    const blend = (drawn.pass.blend ?? "normal") as BLEND_MODES;
    if (resolution >= frame.density * 0.99) {
      if (!drawn.scaler) return;
      drawn.mesh.filters = null;
      drawn.mesh.filterArea = null as unknown as Rectangle;
      drawn.mesh.blendMode = blend;
      drawn.scaler.destroy();
      drawn.scaler = null;
      return;
    }
    if (!drawn.scaler) {
      drawn.scaler = new AlphaFilter({ alpha: 1, blendMode: blend });
      drawn.mesh.blendMode = "normal";
      drawn.mesh.filters = [drawn.scaler];
      drawn.mesh.filterArea = area;
    }
    drawn.scaler.resolution = resolution;
  }

  return {
    below: containers.below,
    above: containers.above,
    filters: filters.length ? filters.map(({ filter }) => filter) : null,
    surfaces,
    animated: hasState,
    ready() {
      if (!compiled) compiled = compiles.every((compile) => compile.poll());
      return compiled;
    },
    update(frame) {
      if (frame.quality !== quality) {
        quality = frame.quality;
        for (const { geometry, sprites } of meshes)
          if (sprites) geometry.instanceCount = Math.max(1, Math.round(sprites * quality));
      }
      area.x = frame.region.x;
      area.y = frame.region.y;
      area.width = frame.region.width;
      area.height = frame.region.height;
      for (const drawn of meshes) {
        drawn.mesh.visible = boardShaderPassOn(drawn.pass, frame.passes);
        if (!drawn.sprites) shade(drawn, frame);
      }
      for (const { filter, pass } of filters) filter.enabled = boardShaderPassOn(pass, frame.passes);
      fill(group, frame, frame.region);
      for (const { geometry, placement } of meshes) {
        if (!placement) continue;
        (placement.uniforms.uniforms as Record<string, unknown>).uCohubSpriteCount = geometry.instanceCount;
        fill(placement.uniforms, frame, { x: 0, y: 0, width: BOARD_SPRITE_COLUMNS, height: Math.ceil(geometry.instanceCount / BOARD_SPRITE_COLUMNS) });
      }
      time = frame.time;
      last = frame;
      placementsStale = true;
    },
    prepare(target, options) {
      if (!last) return false;
      const stepped = state ? advance(target, state, last, options?.catchUp === true) : { ran: 0, behind: false };
      if (placementsStale || stepped.ran) {
        for (const { placement, mesh } of meshes)
          if (placement && mesh.visible) target.render({ container: placement.mesh.mesh, target: placement.target, clear: true, clearColor: [0, 0, 0, 0] });
        placementsStale = false;
      }
      return stepped.behind;
    },
    rewind() {
      if (state) state.steps = -1;
    },
    setSurfaces(texture, region, key = "") {
      surfaceKey = key;
      const shaders = [...meshes.flatMap(({ shader, placement }) => (placement ? [shader, placement.mesh.shader] : [shader])), ...filters.map(({ filter }) => filter)];
      if (state) shaders.push(state.simulate.shader);
      for (const target of shaders) target.resources.uCohubSurfaces = texture.source;
      const groups = [group, ...meshes.flatMap(({ placement }) => (placement ? [placement.uniforms] : []))];
      if (state) groups.push(state.uniforms);
      for (const target of groups) {
        setUniform(target, "uCohubSurfaceRegion", [region.x, region.y, region.width, region.height]);
        target.update();
      }
      placementsStale = true;
    },
    destroy() {
      for (const compile of compiles) compile.cancel();
      for (const drawn of meshes) {
        drawn.scaler?.destroy();
        destroyBoardShaderMesh(drawn);
        if (drawn.placement) destroyPlacement(renderer, drawn.placement);
      }
      containers.below?.destroy();
      containers.above?.destroy();
      for (const { filter } of filters) filter.destroy();
      blank.destroy();
      if (state) {
        destroyBoardShaderMesh(state.simulate);
        state.read.destroy(true);
        state.write.destroy(true);
      }
      for (const { texture } of checkpoints) texture.destroy(true);
      copier.destroy();
    },
  };
}
