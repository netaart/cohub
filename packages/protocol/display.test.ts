import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stale } from "./scripts/display-vocabulary.js";
import {
  compileDisplayActions,
  DisplayActionError,
  type DisplayInputEvent,
  displayElementSchema,
  displayInfoSchema,
  displayInputBatchSchema,
  displaysSnapshotSchema,
} from "./src/display/index.js";

type Fixture = {
  inputBatches: { name: string; valid: boolean; events: unknown[] }[];
  displays: { name: string; info: unknown; known: { system: string[]; needs: string[] } }[];
  elements: { name: string; element: unknown; clean: { role: string; states: string[]; actions: string[] } }[];
};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/display.json", import.meta.url), "utf8")) as Fixture;

describe("displays", () => {
  it("compiles actions into one timeline that satisfies the wire schema", () => {
    const events = compileDisplayActions(
      [
        { type: "tap", x: 288, y: 640 },
        { type: "swipe", x: 288, y: 1000, to_x: 288, to_y: 200, duration_ms: 400 },
        { type: "type", text: "你".repeat(5_000) },
        { type: "key", key: "Meta+c" },
      ],
      577,
      1281,
    );
    assert.deepEqual(events.map((event) => [event.type, "action" in event ? event.action : undefined, event.t]), [
      ["pointer", "down", 0],
      ["pointer", "up", 60],
      ["pointer", "down", 210],
      ["pointer", "move", 410],
      ["pointer", "up", 610],
      ["text", undefined, 760],
      ["text", undefined, 760],
      ["key", "down", 910],
      ["key", "press", 910],
      ["key", "up", 910],
    ]);
    const tap = events[0] as Extract<DisplayInputEvent, { type: "pointer" }>;
    assert.deepEqual([tap.x, tap.y], [0.5, 0.5]);
    assert.equal(displayInputBatchSchema.safeParse({ events }).success, true);
  });

  it("refuses actions a device could not perform", () => {
    assert.throws(() => compileDisplayActions([{ type: "tap", x: 600, y: 10 }], 577, 1281), DisplayActionError);
    assert.throws(() => compileDisplayActions([{ type: "key", key: "Hyper+a" }], 577, 1281), DisplayActionError);
    assert.equal(displayInputBatchSchema.safeParse({ events: [{ type: "pointer", action: "down", x: 2, y: 0 }] }).success, false);
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
