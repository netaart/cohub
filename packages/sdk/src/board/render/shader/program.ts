import type { BoardShader } from "../../model/script.js";
import { type BoardShaderParameter, type BoardShaderUniform, boardShaderUniforms, validateBoardShader } from "../../model/shader.js";
import { BOARD_SHADER_LIBRARY } from "./library.js";

export type BoardShaderProgramKind = "box" | "sprites" | "filter" | "simulate";

export type BoardShaderProgramInput = {
  kind: BoardShaderProgramKind;
  glsl: string;
  parameters: readonly BoardShaderParameter[];
  uniforms: readonly BoardShaderUniform[];
  surfaces: boolean;
  state: boolean;
};

export type BoardShaderProgram = {
  vertex: string;
  fragment: string;
  firstLine: { vertex: number; fragment: number };
};

export const BOARD_SHADER_ITERATIONS = 65_536;

const FORBIDDEN = [
  [/#\s*(version|extension|pragma|line)\b/, "#version, #extension, #pragma and #line are set by Cohub"],
  [/\b(uniform|attribute|varying|layout)\b/, "declare uniforms in shader.uniforms; inputs and outputs belong to Cohub"],
  [/\b(while|do)\b/, "use for loops; while and do loops are not allowed"],
  [/##|\\\r?\n|#\s*define\b[^\n]*\bfor\b|\bfor\b(?!\s*\()/, "macros cannot paste tokens, continue lines or hide loops"],
  [/\b(gl_FragColor|gl_FragData|gl_Position|gl_FragDepth)\b/, "return colors from effect() instead of writing outputs"],
  [/\b[uv]?[Cc]ohub\w*/, "names starting with cohub are reserved"],
  [/__/, "names with two underscores are reserved"],
] as const;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (comment) => " ".repeat(comment.length));
}

function closing(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function guardLoops(source: string): string {
  const loops = [...source.matchAll(/\bfor\s*\(/g)].map((match) => (match.index ?? 0) + match[0].length - 1);
  let result = source;
  for (const open of loops.reverse()) {
    const close = closing(result, open);
    if (close < 0) throw new Error("Unbalanced parentheses in a for loop.");
    const header = result.slice(open + 1, close);
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < header.length; index++) {
      const char = header[index];
      if (char === "(") depth++;
      else if (char === ")") depth--;
      else if (char === ";" && depth === 0) {
        parts.push(header.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(header.slice(start));
    if (parts.length !== 3) throw new Error("A for loop needs an initializer, a condition and an increment.");
    const condition = parts[1]?.trim() ? `(${parts[1]}) && cohubStep()` : "cohubStep()";
    result = `${result.slice(0, open + 1)}${parts[0]};${condition};${parts[2]}${result.slice(close)}`;
  }
  return result;
}

export function prepareBoardShaderSource(glsl: string): { code: string; includes: string[] } {
  const includes: string[] = [];
  const code = stripComments(glsl).replace(/^[ \t]*#\s*include\s+"([^"]*)"[ \t]*$/gm, (_line, name: string) => {
    const library = name.startsWith("cohub:") ? name.slice(6) : "";
    if (!Object.hasOwn(BOARD_SHADER_LIBRARY, library))
      throw new Error(`Unknown include "${name}"; available: ${Object.keys(BOARD_SHADER_LIBRARY).map((key) => `cohub:${key}`).join(", ")}.`);
    if (!includes.includes(library)) includes.push(library);
    return "";
  });
  for (const match of code.matchAll(/^[ \t]*#\s*define\s+\w+(?:\([^)]*\))?(.*)$/gm)) {
    const body = match[1] ?? "";
    let depth = 0;
    for (const char of body) {
      if (char === "(") depth++;
      else if (char === ")" && --depth < 0) break;
    }
    if (body.includes(";") || depth !== 0) {
      const line = code.slice(0, match.index).split("\n").length;
      throw new Error(`Line ${line}: macros cannot contain ; or unbalanced parentheses.`);
    }
  }
  for (const [pattern, reason] of FORBIDDEN) {
    const match = pattern.exec(code);
    if (match) {
      const line = code.slice(0, match.index).split("\n").length;
      throw new Error(`Line ${line}: ${reason}.`);
    }
  }
  return { code: guardLoops(code), includes };
}

const GLSL_TYPES = { float: "float", int: "int", vec2: "vec2", vec3: "vec3", vec4: "vec4" } as const;

function declarations(input: BoardShaderProgramInput, stage: "vertex" | "fragment"): string {
  const lines = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    "precision highp sampler2D;",
    stage === "vertex" ? "#define COHUB_VERTEX 1" : "#define COHUB_FRAGMENT 1",
  ];
  if (stage === "vertex")
    lines.push("#define dFdx(x) ((x) * 0.0)", "#define dFdy(x) ((x) * 0.0)", "#define fwidth(x) ((x) * 0.0)", "#define discard return vec4(0.0)");
  lines.push(
    "struct Board { float time; float delta; int frame; vec2 size; vec4 view; vec2 resolution; float zoom; float seed; float quality; float dark; };",
    "uniform Board board;",
  );
  if (input.parameters.length) {
    lines.push(`struct Params { ${input.parameters.map(({ name, type }) => `${type} ${name};`).join(" ")} };`, "uniform Params params;");
  }
  if (input.uniforms.length) {
    const fields = input.uniforms.map(({ name, type, length }) => `${GLSL_TYPES[type]} ${name}${length === null ? "" : `[${length}]`};`);
    lines.push(`struct Uniforms { ${fields.join(" ")} };`, "uniform Uniforms uniforms;");
  }
  lines.push(
    "struct Fragment { vec2 uv; vec2 local; vec4 color; vec4 data; };",
    "struct Sprite { vec2 position; vec2 size; float rotation; vec4 color; vec4 data; bool visible; };",
    "Sprite makeSprite(vec2 position, vec2 size) { return Sprite(position, size, 0.0, vec4(1.0), vec4(0.0), true); }",
    "int cohubIterations;",
    `bool cohubStep() { cohubIterations++; return cohubIterations <= ${BOARD_SHADER_ITERATIONS}; }`,
  );
  if (input.surfaces)
    lines.push(
      "uniform sampler2D uCohubSurfaces;",
      "uniform vec4 uCohubSurfaceRegion;",
      "struct Surface { float distance; vec2 normal; bool inside; };",
      "Surface surface(vec2 local) {",
      "  vec2 uv = (local - uCohubSurfaceRegion.xy) / uCohubSurfaceRegion.zw;",
      "  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return Surface(1e6, vec2(0.0), false);",
      "  vec4 s = texture(uCohubSurfaces, uv);",
      "  return Surface(s.r, s.gb, s.a > 0.5);",
      "}",
    );
  if (input.state)
    lines.push(
      "uniform sampler2D uCohubState;",
      "uniform vec4 uCohubStateRegion;",
      "vec4 state(vec2 uv) { return texture(uCohubState, uv); }",
      "vec4 stateAt(vec2 local) {",
      "  vec2 uv = (local - uCohubStateRegion.xy) / uCohubStateRegion.zw;",
      "  return any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) ? vec4(0.0) : state(uv);",
      "}",
    );
  if (input.kind === "filter") {
    lines.push(
      "uniform sampler2D uTexture;",
      "uniform vec4 uInputSize;",
      "uniform vec4 uOutputFrame;",
      "uniform vec4 uInputClamp;",
      "uniform mat3 uCohubLocalToGlobal;",
      "uniform vec4 uCohubRegion;",
      "vec4 scene(vec2 uv) {",
      "  vec2 global = (uCohubLocalToGlobal * vec3(uCohubRegion.xy + uv * uCohubRegion.zw, 1.0)).xy;",
      "  vec2 coord = clamp((global - uOutputFrame.xy) * uInputSize.zw, uInputClamp.xy, uInputClamp.zw);",
      "  vec4 color = texture(uTexture, coord);",
      "  return color.a > 0.0 ? vec4(color.rgb / color.a, color.a) : vec4(0.0);",
      "}",
    );
  }
  return lines.join("\n");
}

const CLIP = `uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
vec4 cohubClip(vec2 local) {
  mat3 m = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  return vec4((m * vec3(local, 1.0)).xy, 0.0, 1.0);
}`;

const VARYINGS = "vec2 vCohubUv; vec2 vCohubLocal; vec4 vCohubColor; vec4 vCohubData;";

function vertexMain(kind: BoardShaderProgramKind): string {
  const out = VARYINGS.split(" ").reduce((text, part, index) => text + (index % 2 ? `${part} ` : `out ${part} `), "");
  if (kind === "filter")
    return `in vec2 aPosition;
uniform vec4 uOutputTexture;
uniform mat3 uCohubGlobalToLocal;
out vec2 vTextureCoord;
${out}
void main() {
  vec2 global = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  gl_Position = vec4(global.x * (2.0 / uOutputTexture.x) - 1.0, global.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
  vCohubLocal = (uCohubGlobalToLocal * vec3(global, 1.0)).xy;
  vCohubUv = (vCohubLocal - uCohubRegion.xy) / uCohubRegion.zw;
  vCohubColor = vec4(1.0);
  vCohubData = vec4(0.0);
}`;
  if (kind === "sprites")
    return `in vec2 aPosition;
${CLIP}
${out}
void main() {
  cohubIterations = 0;
  Sprite s = sprite(gl_InstanceID);
  if (!s.visible || s.size.x <= 0.0 || s.size.y <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 corner = (aPosition - 0.5) * s.size;
  float c = cos(s.rotation);
  float r = sin(s.rotation);
  vec2 local = s.position + vec2(corner.x * c - corner.y * r, corner.x * r + corner.y * c);
  gl_Position = cohubClip(local);
  vCohubUv = aPosition;
  vCohubLocal = local;
  vCohubColor = s.color;
  vCohubData = s.data;
}`;
  return `in vec2 aPosition;
uniform vec4 uCohubGeometry;
uniform vec4 uCohubRegion;
${CLIP}
${out}
void main() {
  gl_Position = cohubClip(uCohubGeometry.xy + aPosition * uCohubGeometry.zw);
  vCohubUv = aPosition;
  vCohubLocal = uCohubRegion.xy + aPosition * uCohubRegion.zw;
  vCohubColor = vec4(1.0);
  vCohubData = vec4(0.0);
}`;
}

function fragmentMain(kind: BoardShaderProgramKind): string {
  const inputs = VARYINGS.split(" ").reduce((text, part, index) => text + (index % 2 ? `${part} ` : `in ${part} `), "");
  const entry = kind === "simulate" ? "simulate" : "effect";
  const write = kind === "simulate"
    ? "finalColor = color;"
    : `color = clamp(color, 0.0, 1.0);
  finalColor = vec4(color.rgb * color.a, color.a)${kind === "filter" ? "" : " * uColor.a"};`;
  return `${inputs}
${kind === "filter" ? "in vec2 vTextureCoord;" : "uniform vec4 uColor;"}
out vec4 finalColor;
void main() {
  cohubIterations = 0;
  vec4 color = ${entry}(Fragment(vCohubUv, vCohubLocal, vCohubColor, vCohubData));
  ${write}
}`;
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

export function buildBoardShaderProgram(input: BoardShaderProgramInput): BoardShaderProgram {
  const { code, includes } = prepareBoardShaderSource(input.glsl);
  const library = includes.map((name) => BOARD_SHADER_LIBRARY[name]).join("\n");
  const stage = (name: "vertex" | "fragment") => {
    const head = `${declarations(input, name)}\n${library}`;
    const main = name === "vertex" ? vertexMain(input.kind) : fragmentMain(input.kind);
    return { source: `${head}\n${code}\n${main}\n`, firstLine: lineCount(head) + 1 };
  };
  const vertex = stage("vertex");
  const fragment = stage("fragment");
  return { vertex: vertex.source, fragment: fragment.source, firstLine: { vertex: vertex.firstLine, fragment: fragment.firstLine } };
}

export function describeBoardShaderError(log: string, firstLine: number, label: string): string {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(ERROR|WARNING):\s*\d+:(\d+):\s*/, (_match, _kind, at: string) => {
      const line = Number(at) - firstLine + 1;
      return line >= 1 ? `line ${line}: ` : "";
    }));
  return `${label}: ${lines.slice(0, 4).join("; ") || "the shader failed to compile"}`;
}

export type BoardShaderStage = { name: string; kind: BoardShaderProgramKind; glsl: string };

export function boardShaderStages(shader: BoardShader, label: string): BoardShaderStage[] {
  const stages = shader.passes.map((pass, index): BoardShaderStage => ({
    name: `${label} pass ${index + 1}`,
    kind: shader.layer === "filter" ? "filter" : pass.sprites ? "sprites" : "box",
    glsl: pass.glsl,
  }));
  if (shader.state) stages.push({ name: `${label} state`, kind: "simulate", glsl: shader.state.glsl });
  return stages;
}

export function checkBoardShader(shader: unknown, parameters: readonly BoardShaderParameter[], label: string): void {
  validateBoardShader(shader);
  const base = { parameters, uniforms: boardShaderUniforms(shader.uniforms), surfaces: shader.surfaces === true, state: shader.state !== undefined };
  for (const stage of boardShaderStages(shader, label)) {
    try {
      buildBoardShaderProgram({ ...base, kind: stage.kind, glsl: stage.glsl });
    } catch (error) {
      throw new Error(`${stage.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
