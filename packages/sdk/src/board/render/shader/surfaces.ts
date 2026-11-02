import { Container, Graphics, type Renderer, type RenderTexture, Texture, UniformGroup } from "pixi.js";
import { type BoardShaderMesh, boardRenderTarget, boardShaderMesh, destroyBoardShaderMesh, setUniform } from "./quad.js";

export type BoardSurfaceRegion = { x: number; y: number; width: number; height: number };

const VERTEX = `#version 300 es
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec2 uSize;
void main() {
  mat3 m = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((m * vec3(aPosition * uSize, 1.0)).xy, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 finalColor;
const float NONE = -16384.0;
`;

const SEED = `${HEAD}
uniform sampler2D uMask;
bool inside(ivec2 p, ivec2 size) {
  if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) return false;
  return texelFetch(uMask, p, 0).a > 0.5;
}
void main() {
  ivec2 size = textureSize(uMask, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool here = inside(p, size);
  bool edge = here && !(inside(p + ivec2(1, 0), size) && inside(p - ivec2(1, 0), size)
    && inside(p + ivec2(0, 1), size) && inside(p - ivec2(0, 1), size));
  finalColor = vec4(edge ? gl_FragCoord.xy : vec2(NONE), here ? 1.0 : 0.0, 1.0);
}`;

const FLOOD = `${HEAD}
uniform sampler2D uSeeds;
uniform float uStep;
void main() {
  ivec2 size = textureSize(uSeeds, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 best = texelFetch(uSeeds, p, 0);
  float bestDistance = best.x == NONE ? 1e20 : distance(best.xy, gl_FragCoord.xy);
  int step = int(uStep);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 q = p + ivec2(x, y) * step;
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      vec2 seed = texelFetch(uSeeds, q, 0).xy;
      if (seed.x == NONE) continue;
      float d = distance(seed, gl_FragCoord.xy);
      if (d < bestDistance) { bestDistance = d; best.xy = seed; }
    }
  }
  finalColor = best;
}`;

const RESOLVE = `${HEAD}
uniform sampler2D uSeeds;
uniform float uTexel;
void main() {
  vec4 here = texelFetch(uSeeds, ivec2(gl_FragCoord.xy), 0);
  float side = here.z > 0.5 ? -1.0 : 1.0;
  if (here.x == NONE) { finalColor = vec4(1e4 * side, 0.0, 0.0, here.z); return; }
  vec2 away = gl_FragCoord.xy - here.xy;
  float d = length(away);
  vec2 normal = d > 0.0 ? away / d * side : vec2(0.0, -1.0);
  finalColor = vec4((d - 0.5 * side) * uTexel * side, normal, here.z);
}`;

type Pass = BoardShaderMesh & { uniforms: UniformGroup };

function pass(name: string, fragment: string, texture: string, extra: Record<string, { value: number; type: "f32" }>): Pass {
  const uniforms = new UniformGroup({ uSize: { value: new Float32Array(2), type: "vec2<f32>" }, ...extra });
  return { ...boardShaderMesh(name, { vertex: VERTEX, fragment }, { [texture]: Texture.EMPTY.source, surfaceUniforms: uniforms }), uniforms };
}

export type BoardSurfaceField = {
  readonly texture: Texture;
  readonly region: BoardSurfaceRegion;
  build(renderer: Renderer, region: BoardSurfaceRegion, outlines: readonly (readonly number[])[], edge: number): void;
  destroy(): void;
};

export function createBoardSurfaceField(): BoardSurfaceField {
  const shapes = new Graphics({ label: "board-surface-mask" });
  const holder = new Container();
  holder.addChild(shapes);
  const seed = pass("board-surface-seed", SEED, "uMask", {});
  const flood = pass("board-surface-flood", FLOOD, "uSeeds", { uStep: { value: 1, type: "f32" } });
  const resolve = pass("board-surface-resolve", RESOLVE, "uSeeds", { uTexel: { value: 1, type: "f32" } });
  let mask: RenderTexture | null = null;
  let ping: RenderTexture | null = null;
  let pong: RenderTexture | null = null;
  let output: RenderTexture | null = null;
  let current: BoardSurfaceRegion = { x: 0, y: 0, width: 1, height: 1 };

  function targets(width: number, height: number) {
    if (output && output.width === width && output.height === height) return;
    if (mask && ping && pong && output) {
      for (const texture of [mask, ping, pong, output]) texture.resize(width, height);
      return;
    }
    mask = boardRenderTarget(width, height, "rgba8unorm");
    ping = boardRenderTarget(width, height, "rgba16float");
    pong = boardRenderTarget(width, height, "rgba16float");
    output = boardRenderTarget(width, height, "rgba16float");
  }

  function run(renderer: Renderer, step: Pass, input: RenderTexture, target: RenderTexture, name: string) {
    setUniform(step.uniforms, "uSize", [target.width, target.height]);
    step.uniforms.update();
    step.shader.resources[name] = input.source;
    renderer.render({ container: step.mesh, target, clear: true });
  }

  return {
    get texture() {
      return output ?? Texture.EMPTY;
    },
    get region() {
      return current;
    },
    build(renderer, region, outlines, edge) {
      const ratio = region.width / Math.max(1e-6, region.height);
      const width = Math.max(8, Math.round(ratio >= 1 ? edge : edge * ratio));
      const height = Math.max(8, Math.round(ratio >= 1 ? edge / ratio : edge));
      targets(width, height);
      current = { ...region };
      const scale = width / region.width;
      shapes.clear();
      for (const outline of outlines) if (outline.length >= 6) shapes.poly(outline as number[]).fill(0xffffff);
      shapes.position.set(-region.x * scale, -region.y * (height / region.height));
      shapes.scale.set(scale, height / region.height);
      if (!mask || !ping || !pong || !output) return;
      renderer.render({ container: holder, target: mask, clear: true, clearColor: [0, 0, 0, 0] });
      run(renderer, seed, mask, ping, "uMask");
      let from = ping;
      let to = pong;
      for (let step = 2 ** Math.ceil(Math.log2(Math.max(width, height))) / 2; step >= 1; step /= 2) {
        flood.uniforms.uniforms.uStep = step;
        run(renderer, flood, from, to, "uSeeds");
        [from, to] = [to, from];
      }
      resolve.uniforms.uniforms.uTexel = region.width / width;
      run(renderer, resolve, from, output, "uSeeds");
    },
    destroy() {
      for (const step of [seed, flood, resolve]) destroyBoardShaderMesh(step);
      holder.destroy({ children: true });
      for (const texture of [mask, ping, pong, output]) texture?.destroy(true);
      mask = ping = pong = output = null;
    },
  };
}
