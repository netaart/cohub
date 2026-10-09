import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBoardPatchToDocument,
  emptyBoardDocument,
} from "@cohub/protocol";
import { Command } from "commander";
import { BOARD_EXAMPLES } from "../src/commands/boards/examples.js";
import { framePath, parseJsonObject, parseRect, registerBoards } from "../src/commands/boards.js";
import { formatBoardTime, parseBoardTime, parseBoardTimes } from "../src/board-time.js";

function createProgram(): { program: Command; boards: Command } {
  const program = new Command("cohub")
    .option("-s, --space <id>", "Target space ID")
    .helpOption("-h, --help", "Show help");
  return { program, boards: registerBoards(program) };
}

function capture(run: () => void | Promise<void>): Promise<string[]> {
  const output: string[] = [];
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (value?: unknown) => output.push(String(value));
  process.stdout.write = ((chunk: string) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return Promise.resolve(run()).finally(() => {
    console.log = log;
    process.stdout.write = write;
  }).then(() => output);
}

test("Board commands are one small, flat set and all expose -h", () => {
  const { boards } = createProgram();
  assert.deepEqual(boards.commands.map((command) => command.name()), [
    "create", "get", "apply", "history", "schema", "preset", "examples", "export",
    "play", "pause", "resume", "seek", "next", "stop", "watch",
  ]);
  for (const command of boards.commands) {
    assert.match(command.helpInformation(), /-h, --help/, `${command.name()} is missing -h`);
  }
});

test("every example is a valid Board document", () => {
  for (const [name, example] of Object.entries(BOARD_EXAMPLES)) {
    const result = applyBoardPatchToDocument(emptyBoardDocument(), example.value as never);
    assert.ok(result.ok, `${name}: ${result.ok ? "" : result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  }
});

test("examples list and print documents", async () => {
  const { boards } = createProgram();
  const listed = await capture(() => boards.parseAsync(["examples"], { from: "user" }));
  assert.ok(listed.some((line) => line.startsWith("lesson")));
  const printed = await capture(() => boards.parseAsync(["examples", "workflow"], { from: "user" }));
  const workflow = JSON.parse(printed.join("")) as { items: Record<string, unknown> };
  assert.deepEqual(Object.keys(workflow.items), ["request", "agent", "result", "request-agent", "agent-result"]);
});

test("preset prints an apply-ready patch", async () => {
  const { boards } = createProgram();
  const output = await capture(() => boards.parseAsync(["preset", "rise", "--targets", "a,b", "--animation", "intro", "--stagger", "100ms"], { from: "user" }));
  const patch = JSON.parse(output.join("")) as { animations: { intro: { tracks: Record<string, { keyframes: Array<{ at: number }> }> } } };
  assert.equal(patch.animations.intro.tracks["b-rise-y"]?.keyframes[0]?.at, 100);
  const seeded = applyBoardPatchToDocument(emptyBoardDocument(), { items: { a: { type: "shape" }, b: { type: "text" } } });
  assert.ok(seeded.ok);
  assert.ok(applyBoardPatchToDocument(seeded.document, patch as never).ok, "a new animation takes its duration from the tracks");
});

test("schema describes targets and animatable properties", async () => {
  const { boards } = createProgram();
  const overview = JSON.parse((await capture(() => boards.parseAsync(["schema"], { from: "user" }))).join("")) as { properties: Record<string, string[]>; units: { time: string } };
  assert.equal(overview.units.time, "milliseconds");
  assert.ok(overview.properties.text?.includes("props.fontSize"));
  assert.ok(overview.properties.shape?.includes("style.fill"));
  const text = JSON.parse((await capture(() => boards.parseAsync(["schema", "text"], { from: "user" }))).join("")) as { schema: { properties: Record<string, unknown> } };
  assert.ok(text.schema.properties.props);
});

test("times accept milliseconds, seconds, minutes and ranges", () => {
  assert.equal(parseBoardTime("1500"), 1500);
  assert.equal(parseBoardTime("500ms"), 500);
  assert.equal(parseBoardTime("12.5s"), 12_500);
  assert.equal(parseBoardTime("2m"), 120_000);
  assert.throws(() => parseBoardTime("soon"), /expected a time/);
  assert.deepEqual(parseBoardTimes("0:1s:250ms"), [0, 250, 500, 750, 1000]);
  assert.deepEqual(parseBoardTimes("2s"), [2000]);
  assert.throws(() => parseBoardTimes("0:1s:0"), /step/);
  assert.throws(() => parseBoardTimes("0:100s:1ms"), /exceed the limit/);
  assert.equal(formatBoardTime(250), "250ms");
  assert.equal(formatBoardTime(12_500), "12.5s");
});

test("frame paths, rects and JSON inputs parse without rewriting data", () => {
  assert.equal(framePath("frames/%04d.png", 12), "frames/0012.png");
  assert.equal(framePath("f%d.png", 3), "f3.png");
  assert.deepEqual(parseRect("-10,20,1280,720"), { x: -10, y: 20, width: 1280, height: 720 });
  assert.throws(() => parseRect("0,0,0,100"), /greater than zero/);
  assert.deepEqual(parseJsonObject('{"items":{"x":{"type":"acme.chart","props":{"raw":true}}}}'), { items: { x: { type: "acme.chart", props: { raw: true } } } });
  assert.throws(() => parseJsonObject("[]"), /JSON object/);
});
