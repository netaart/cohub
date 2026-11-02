import {
  BOARD_SHADER_BLENDS,
  BOARD_SHADER_LAYERS,
  type BOARD_SHADER_UNIFORM_TYPES,
  type BoardScriptParameter,
  type BoardShader,
  type BoardShaderUniformValues,
} from "./script.js";

export const BOARD_SHADER_LIMITS = {
  passes: 8,
  source: 64 * 1024,
  sprites: 65_536,
  stateEdge: 1024,
  uniformSlots: 128,
} as const;

export type BoardShaderUniformType = (typeof BOARD_SHADER_UNIFORM_TYPES)[number];
export type BoardShaderUniform = { name: string; type: BoardShaderUniformType; length: number | null };

const COMPONENTS: Record<BoardShaderUniformType, number> = { float: 1, int: 1, vec2: 2, vec3: 3, vec4: 4 };
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

export function boardShaderUniforms(declared: BoardShader["uniforms"]): BoardShaderUniform[] {
  const result: BoardShaderUniform[] = [];
  let slots = 0;
  for (const [name, spec] of Object.entries(declared ?? {})) {
    if (!IDENTIFIER.test(name) || name.includes("__")) throw new Error(`Invalid uniform name: ${name}`);
    const match = typeof spec === "string" ? /^(float|int|vec2|vec3|vec4)(?:\[(\d{1,3})\])?$/.exec(spec) : null;
    if (!match) throw new Error(`Uniform ${name} must be float, int, vec2, vec3 or vec4, optionally with [length].`);
    const type = match[1] as BoardShaderUniformType;
    const length = match[2] === undefined ? null : Number(match[2]);
    if (length !== null && (length < 1 || length > 256)) throw new Error(`Uniform ${name} takes 1 to 256 elements.`);
    slots += length ?? 1;
    result.push({ name, type, length });
  }
  if (slots > BOARD_SHADER_LIMITS.uniformSlots)
    throw new Error(`Shader uniforms take at most ${BOARD_SHADER_LIMITS.uniformSlots} vectors.`);
  return result;
}

export function boardShaderUniformValue(uniform: BoardShaderUniform, value: BoardShaderUniformValues[string] | undefined): number[] | null {
  const size = COMPONENTS[uniform.type] * (uniform.length ?? 1);
  if (value === undefined) return new Array(size).fill(0);
  const list = typeof value === "number" ? [value] : [...value];
  if (uniform.length === null ? list.length !== size : list.length > size || list.length % COMPONENTS[uniform.type]) return null;
  while (list.length < size) list.push(0);
  return list;
}

export type BoardShaderParameter = { name: string; type: "float" | "vec4" };

export function boardShaderParameters(parameters: Record<string, BoardScriptParameter> | undefined): BoardShaderParameter[] {
  const result: BoardShaderParameter[] = [];
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    if (!IDENTIFIER.test(name) || name.includes("__")) continue;
    if (spec.type === "number" || spec.type === "boolean") result.push({ name, type: "float" });
    else if (spec.type === "color") result.push({ name, type: "vec4" });
  }
  return result;
}

export function validateBoardShader(shader: unknown): asserts shader is BoardShader {
  if (!shader || typeof shader !== "object") throw new Error("shader must be an object.");
  const value = shader as BoardShader;
  if (value.layer !== undefined && !BOARD_SHADER_LAYERS.includes(value.layer))
    throw new Error(`shader.layer must be ${BOARD_SHADER_LAYERS.join(", ")}.`);
  if (value.surfaces !== undefined && typeof value.surfaces !== "boolean") throw new Error("shader.surfaces must be a boolean.");
  if (!Array.isArray(value.passes) || value.passes.length < 1 || value.passes.length > BOARD_SHADER_LIMITS.passes)
    throw new Error(`shader.passes takes 1 to ${BOARD_SHADER_LIMITS.passes} passes.`);
  for (const pass of value.passes) {
    if (!pass || typeof pass.glsl !== "string" || !pass.glsl.trim()) throw new Error("Each shader pass needs glsl source.");
    if (pass.glsl.length > BOARD_SHADER_LIMITS.source) throw new Error("A shader pass exceeds 64 KB of source.");
    if (pass.sprites !== undefined) {
      if (!Number.isSafeInteger(pass.sprites) || pass.sprites < 1 || pass.sprites > BOARD_SHADER_LIMITS.sprites)
        throw new Error(`sprites must be an integer from 1 to ${BOARD_SHADER_LIMITS.sprites}.`);
      if (value.layer === "filter") throw new Error("Filter passes draw over the owner's box; they cannot draw sprites.");
    }
    if (pass.blend !== undefined && !BOARD_SHADER_BLENDS.includes(pass.blend))
      throw new Error(`blend must be ${BOARD_SHADER_BLENDS.join(", ")}.`);
  }
  boardShaderUniforms(value.uniforms);
  const state = value.state;
  if (state !== undefined) {
    if (!state || typeof state.glsl !== "string" || !state.glsl.trim()) throw new Error("shader.state needs glsl source.");
    if (state.glsl.length > BOARD_SHADER_LIMITS.source) throw new Error("shader.state exceeds 64 KB of source.");
    for (const edge of [state.width, state.height])
      if (!Number.isSafeInteger(edge) || edge < 1 || edge > BOARD_SHADER_LIMITS.stateEdge)
        throw new Error(`shader.state width and height must be integers from 1 to ${BOARD_SHADER_LIMITS.stateEdge}.`);
    if (state.precision !== undefined && state.precision !== "byte" && state.precision !== "half")
      throw new Error("shader.state.precision must be byte or half.");
  }
}

const signatures = new WeakMap<BoardShader, string>();

export function boardShaderSignature(shader: BoardShader): string {
  let signature = signatures.get(shader);
  if (signature === undefined) {
    const text = JSON.stringify(shader);
    let a = 2166136261;
    let b = 5381;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 16777619) >>> 0;
      b = (Math.imul(b, 33) ^ code) >>> 0;
    }
    signature = `${text.length.toString(36)}.${a.toString(36)}.${b.toString(36)}`;
    signatures.set(shader, signature);
  }
  return signature;
}
