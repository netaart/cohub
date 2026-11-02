import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createNodeBoardRenderer, type BoardNodeRenderer, exportBoardImageBytes } from "../../src/board/export/node/index.js";
import { boardScriptScope, validateBoardScriptCommit } from "../../src/board/model/script-scene.js";
import { boardShaderSignature } from "../../src/board/model/shader.js";
import { buildBoardShaderProgram, describeBoardShaderError, prepareBoardShaderSource } from "../../src/board/render/shader/program.js";
import { createBoardScriptHarness } from "../../src/board/testing/index.js";
import { boardDocument } from "./fixtures.js";

let renderer: BoardNodeRenderer;
before(async () => {
  renderer = await createNodeBoardRenderer();
});
after(() => renderer.destroy());

const BOARD = `
export default function (ctx) {
  ctx.state.seen = Object.keys(ctx.items).sort();
  ctx.on("change", ({ data }) => { ctx.state.changes = [...(ctx.state.changes ?? []), data]; });
  ctx.onFrame(() => ctx.present("card", { opacity: 0.5 }));
  ctx.scene({ drop: { type: "shape", position: { x: 10, y: 20 }, size: { width: 4, height: 4 } } });
}`;

function harness(modules: Record<string, string>, document = boardDocument({
  board: { scripts: { weather: { src: "board.js" } } },
  items: {
    card: { type: "shape", position: { x: 100, y: 100 }, size: { width: 200, height: 100 } },
    group: { type: "frame", position: { x: 400, y: 0 }, size: { width: 300, height: 300 } },
    child: { type: "shape", parent: "group", position: { x: 20, y: 20 }, size: { width: 40, height: 40 } },
  },
})) {
  return createBoardScriptHarness({
    renderer,
    document,
    readModule: async (path) => {
      const code = modules[path];
      if (code === undefined) throw new Error(`${path} is not available.`);
      return code;
    },
  });
}

test("a Board script reaches every item, presents any of them and may create top-level items", async () => {
  const board = await harness({ "board.js": BOARD });
  try {
    await board.advance(50);
    assert.equal(board.error("weather"), null);
    assert.equal(board.editor.scene.get("card")?.opacity, 0.5);
    assert.ok(board.editor.scene.items.some((item) => item.id.endsWith("drop")));
    assert.deepEqual([...boardScriptScope(board.document, "weather")].sort(), ["card", "child", "group"]);
    board.editor.commitPatch({ items: { note: { type: "text", props: { text: "Hi" } } } });
    await board.advance(50);
    assert.equal(board.error("weather"), null);
    const created = validateBoardScriptCommit(board.document, "weather", { items: { puddle: { type: "shape" } } });
    assert.ok(created.items.puddle);
    assert.throws(() => validateBoardScriptCommit(board.document, "weather", { items: { card: { type: "text" } } }), /types or parent/);
  } finally { board.destroy(); }
});

test("author GLSL gets bounded loops, Cohub includes and errors on its own lines", () => {
  const { code, includes } = prepareBoardShaderSource(`#include "cohub:hash"\nvec4 effect(Fragment f) {\n  for (int i = 0; i < 4; i++) {}\n  for (;;) { break; }\n  return vec4(hash(1));\n}`);
  assert.deepEqual(includes, ["hash"]);
  assert.match(code, /\(\s*i < 4\s*\) && cohubStep\(\)/);
  assert.match(code, /for \(;cohubStep\(\);\)/);
  assert.throws(() => prepareBoardShaderSource("void f() { while (true) {} }"), /Line 1: use for loops/);
  assert.throws(() => prepareBoardShaderSource("uniform float x;"), /declare uniforms/);
  assert.throws(() => prepareBoardShaderSource(`#include "cohub:nope"`), /Unknown include/);
  assert.throws(() => prepareBoardShaderSource("#define LOOP for\nvoid f() { LOOP(;;) {} }"), /hide loops/);
  assert.throws(() => prepareBoardShaderSource("#define W(a, b) a##b"), /paste tokens/);
  assert.throws(() => prepareBoardShaderSource("#define F(x) x\nvoid f() { F(for)(int i = 0;; i++) {} }"), /hide loops/);
  assert.throws(() => prepareBoardShaderSource("#define L \\\nfor\nvoid f() { L(;;) {} }"), /continue lines/);
  assert.throws(() => prepareBoardShaderSource("#define Y(a)\n#define X 0;;i++) Y(\nvoid f() { for(int i=X;true;i){} }"), /macros cannot contain/);
  assert.doesNotThrow(() => prepareBoardShaderSource("#define ROT(a) mat2(cos(a), -sin(a), sin(a), cos(a))\n#define PARTS 4"));
  const shader = { passes: [{ glsl: "vec4 effect(Fragment f) { return vec4(1.0); }" }] };
  assert.equal(boardShaderSignature(shader), boardShaderSignature(structuredClone(shader)));
  assert.notEqual(boardShaderSignature(shader), boardShaderSignature({ passes: [{ glsl: "vec4 effect(Fragment f) { return vec4(0.0); }" }] }));
  const program = buildBoardShaderProgram({ kind: "sprites", glsl: "Sprite sprite(int id) { return makeSprite(vec2(0.0), vec2(1.0)); }\nvec4 effect(Fragment f) { return f.color; }", parameters: [{ name: "speed", type: "float" }], uniforms: [], surfaces: true, state: false });
  assert.match(program.vertex, /Sprite s = sprite\(gl_InstanceID\)/);
  assert.match(program.fragment, /uniform Params params;/);
  assert.match(program.fragment, /Surface surface\(vec2 local\)/);
  assert.equal(describeBoardShaderError(`ERROR: 0:${program.firstLine.fragment + 1}: 'x' : undeclared identifier`, program.firstLine.fragment, "rain"), "rain: line 2: 'x' : undeclared identifier");
});

test("Canvas exports name the shaders they could not run", async () => {
  const modules = {
    "board.js": `export const shader = { passes: [{ glsl: "vec4 effect(Fragment f) { return vec4(1.0); }" }] };`,
    "card.js": `export const shader = { passes: [{ glsl: "vec4 effect(Fragment f) { return vec4(1.0); }" }] };
export function draw(ctx, { width, height }) { ctx.fillRect(0, 0, width, height); }`,
  };
  const board = await harness(modules, boardDocument({
    board: { scripts: { weather: { src: "board.js" } } },
    items: { card: { type: "custom", size: { width: 100, height: 60 }, script: { src: "card.js" } } },
  }));
  try {
    await board.advance(50);
    const { document, scripts } = await board.shown();
    const result = exportBoardImageBytes(renderer, document, { scripts });
    assert.deepEqual(result?.warnings.find((warning) => warning.kind === "shaders-unsupported"), { kind: "shaders-unsupported", drawn: ["card"], omitted: ["weather"] });
  } finally { board.destroy(); }
});
