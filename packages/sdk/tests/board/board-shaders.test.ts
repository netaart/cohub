import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeBoardRenderer, exportBoardImageBytes } from "../../src/board/export/node/index.js";
import { boardScriptScope, validateBoardScriptCommit } from "../../src/board/model/script-scene.js";
import { applyBoardPatchToDocument } from "@cohub/protocol";
import { boardDocumentAt, withBoardScripts } from "../../src/board/model/animation.js";
import { removeBoardScriptPatch } from "../../src/board/model/script-index.js";
import { boardShaderSignature } from "../../src/board/model/shader.js";
import { buildBoardShaderProgram, describeBoardShaderError, prepareBoardShaderSource } from "../../src/board/render/shader/program.js";
import type { BoardScriptOutput } from "../../src/board/model/script.js";
import type { BoardScriptHost } from "../../src/board/render/renderers/board-renderer-registry.js";
import { boardShaderOwners } from "../../src/board/render/shader/layers.js";
import { boardDocument } from "./fixtures.js";

const SHADER = { passes: [{ glsl: "vec4 effect(Fragment f) { return vec4(1.0); }" }] };

function ran(outputs: Record<string, Partial<BoardScriptOutput>>): BoardScriptHost {
  const full = new Map(Object.entries(outputs).map(([id, output]) => [id, {
    patches: {}, world: {}, screen: {}, hits: {}, listens: [], animated: false, version: 1, ...output,
  } as BoardScriptOutput]));
  return {
    frame: () => null,
    error: () => null,
    release() {},
    shaders: (document) => boardShaderOwners(document, full, () => 0),
  };
}

test("a Board script reaches every item and may create top-level items", () => {
  const document = boardDocument({
    board: { scripts: { weather: { src: "board.js" } } },
    items: {
      card: { type: "shape", position: { x: 100, y: 100 }, size: { width: 200, height: 100 } },
      group: { type: "frame", position: { x: 400, y: 0 }, size: { width: 300, height: 300 } },
      child: { type: "shape", parent: "group", position: { x: 20, y: 20 }, size: { width: 40, height: 40 } },
    },
  });
  assert.deepEqual([...boardScriptScope(document, "weather")].sort(), ["card", "child", "group"]);
  const created = validateBoardScriptCommit(document, "weather", { items: { puddle: { type: "shape" } } });
  assert.ok(created.items.puddle);
  assert.throws(() => validateBoardScriptCommit(document, "weather", { items: { card: { type: "text" } } }), /types or parent/);
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
  const renderer = await createNodeBoardRenderer();
  try {
    const document = boardDocument({
      board: { scripts: { weather: { src: "board.js" } } },
      items: { card: { type: "custom", size: { width: 100, height: 60 }, script: { src: "card.js" } } },
    });
    const scripts = ran({ weather: { shader: SHADER }, card: { shader: SHADER, draws: true } });
    const result = exportBoardImageBytes(renderer, document, { scripts });
    assert.deepEqual(result?.warnings.find((warning) => warning.kind === "shaders-unsupported"), { kind: "shaders-unsupported", drawn: ["card"], omitted: ["weather"] });
  } finally { renderer.destroy(); }
});

test("tracks animate a Board script's params, and go with the script", () => {
  const document = boardDocument({
    board: { scripts: { rain: { src: "rain.js", params: { density: 0.2, tint: "#000000" } } } },
    animations: { storm: { duration: 1000, tracks: {
      density: { target: "rain", property: "params.density", keyframes: [{ at: 0, value: 0.2 }, { at: 1000, value: 1 }] },
      tint: { target: "rain", property: "params.tint", keyframes: [{ at: 0, value: "#000000" }, { at: 1000, value: "#ffffff" }] },
    } } },
  });
  const params = boardDocumentAt(document, "storm", 500).document.board.scripts?.rain?.params;
  assert.ok(Math.abs((params?.density as number) - 0.6) < 1e-9);
  assert.equal(params?.tint, "#808080");
  const edited = boardDocument({ board: { scripts: { rain: { src: "new.js", enabled: false } } } });
  const animated = withBoardScripts(edited, new Map([["rain", { src: "rain.js", params: { density: 1 }, targets: {}, enabled: true }], ["gone", { src: "x.js", params: {}, targets: {}, enabled: true }]]));
  assert.deepEqual(animated.board.scripts, { rain: { src: "new.js", params: { density: 1 }, targets: {}, enabled: false } });
  const invalid = applyBoardPatchToDocument(document, { animations: { storm: { tracks: { src: { target: "rain", property: "src", keyframes: [{ at: 0, value: "x.js" }] } } } } });
  assert.equal(invalid.ok, false);
  assert.equal(applyBoardPatchToDocument(document, { board: { scripts: { rain: null } } }).ok, false);
  const removed = applyBoardPatchToDocument(document, removeBoardScriptPatch(document, "rain"));
  assert.ok(removed.ok);
  assert.deepEqual(removed.document.animations.storm?.tracks, {});
});
