import { Geometry, GlProgram, Mesh, RenderTexture, Shader, type TEXTURE_FORMATS, type UniformGroup } from "pixi.js";

export function boardQuadGeometry(instanceCount = 1): Geometry {
  return new Geometry({
    attributes: { aPosition: { buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), format: "float32x2" } },
    indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
    instanceCount,
  });
}

export type BoardShaderMesh = { mesh: Mesh<Geometry, Shader>; shader: Shader; geometry: Geometry };

export function boardGlProgram(name: string, source: { vertex: string; fragment: string }): GlProgram {
  return GlProgram.from({ name, vertex: source.vertex, fragment: source.fragment, preferredFragmentPrecision: "highp" });
}

export function boardShaderMesh(
  name: string,
  source: GlProgram | { vertex: string; fragment: string },
  resources: Record<string, unknown>,
  geometry = boardQuadGeometry(),
): BoardShaderMesh {
  const glProgram = source instanceof GlProgram ? source : boardGlProgram(name, source);
  const shader = new Shader({ glProgram, resources });
  return { mesh: new Mesh<Geometry, Shader>({ geometry, shader, label: name }), shader, geometry };
}

export function boardRenderTarget(width: number, height: number, format: TEXTURE_FORMATS): RenderTexture {
  return RenderTexture.create({ width, height, resolution: 1, format, scaleMode: "linear", antialias: false, autoGenerateMipmaps: false, dynamic: true });
}

export function setUniform(group: UniformGroup, name: string, value: number | readonly number[]) {
  const uniforms = group.uniforms as Record<string, unknown>;
  const current = uniforms[name];
  if (typeof value === "number") uniforms[name] = value;
  else if (current instanceof Float32Array || current instanceof Int32Array) current.set(value);
  else uniforms[name] = new Float32Array(value);
}

export function destroyBoardShaderMesh({ mesh, shader, geometry }: BoardShaderMesh) {
  mesh.destroy();
  shader.destroy();
  geometry.destroy();
}
