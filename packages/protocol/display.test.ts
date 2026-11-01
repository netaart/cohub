import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stale } from "./scripts/display-vocabulary.js";
import {
  compileDisplayPlan,
  DisplayActionError,
  displayActParamsSchema,
  displayActStepSchema,
  displayElementSchema,
  displayInfoSchema,
  displayInputBatchSchema,
  displaysSnapshotSchema,
} from "./src/display/index.js";

type Fixture = {
  inputBatches: { name: string; valid: boolean; events: unknown[] }[];
  actSteps: { name: string; valid: boolean; step: unknown }[];
  displays: { name: string; info: unknown; known: { system: string[]; needs: string[] } }[];
  elements: { name: string; element: unknown; clean: { role: string; states: string[]; actions: string[] } }[];
};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/display.json", import.meta.url), "utf8")) as Fixture;

describe("displays", () => {
  it("compiles actions into checked steps, one per action", () => {
    const steps = compileDisplayPlan(
      [
        { type: "launch", app: "com.tencent.mm" },
        { type: "tap", name: "Search", until: { text: "Ada" } },
        { type: "tap", x: 288, y: 640 },
        { type: "key", key: "Meta+c" },
      ],
      577,
      1281,
    );
    assert.deepEqual(steps.map((step) => step.type), ["launch", "element", "input", "input"]);
    assert.equal(displayActParamsSchema.safeParse({ steps }).success, true);
    assert.throws(() => compileDisplayPlan([{ type: "tap", x: 600, y: 10 }], 577, 1281), DisplayActionError);
  });

  it("guards display ids and drops unknown system buttons", () => {
    const display = { id: "main", name: "Pixel", width: 1080, height: 2400, stream: true, capture: true, input: true };
    const parsed = displaysSnapshotSchema.parse({ displays: [{ ...display, system: ["back", "assistant"] }] });
    assert.deepEqual(parsed.displays[0]?.system, ["back"]);
    assert.equal(displaysSnapshotSchema.safeParse({ displays: [{ ...display, id: "../etc" }] }).success, false);
  });

  it("agrees with sandboxd on the shared cases", () => {
    for (const { name, valid, events } of fixture.inputBatches) {
      assert.equal(displayInputBatchSchema.safeParse({ events }).success, valid, name);
    }
    for (const { name, valid, step } of fixture.actSteps) {
      assert.equal(displayActStepSchema.safeParse(step).success, valid, name);
    }
    for (const { name, info, known } of fixture.displays) {
      const parsed = displayInfoSchema.parse(info);
      assert.deepEqual({ system: parsed.system, needs: parsed.needs }, known, name);
    }
    for (const { name, element, clean } of fixture.elements) {
      const parsed = displayElementSchema.parse(element);
      assert.deepEqual({ role: parsed.role, states: parsed.states, actions: parsed.actions }, clean, name);
    }
  });

  it("keeps the generated Go and Kotlin vocabulary current", async () => {
    assert.deepEqual(await stale(), [], "run pnpm --filter @cohub/protocol generate:display");
  });
});
