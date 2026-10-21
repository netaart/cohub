import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { Command } from "commander";
import { registerGenerations } from "../src/commands/generations.js";

const SPACE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const baselineBody = readFileSync(new URL("./fixtures/generate-baseline.body.txt", import.meta.url), "utf8");

type CapturedRequest = { url: string; body: string };
type CapturedRun = { requests: CapturedRequest[]; stderr: string[]; exitCode?: number };
type GenerationBody = {
  content: Array<{ type: string; text?: string; meta?: { role?: string }; source?: { type: string; url?: string } }>;
  parameters?: Record<string, unknown>;
};

const environment = ["ENV", "COHUB_BASE_URL", "COHUB_EXECUTION_TOKEN", "COHUB_SPACE_ID", "COHUB_SESSION_ID", "COHUB_TURN_ID"] as const;
let savedEnvironment: Partial<Record<(typeof environment)[number], string>> = {};

beforeEach(() => {
  savedEnvironment = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
  process.env.COHUB_BASE_URL = "https://api.test";
  process.env.COHUB_EXECUTION_TOKEN = "test-token";
  for (const key of ["ENV", "COHUB_SPACE_ID", "COHUB_SESSION_ID", "COHUB_TURN_ID"] as const) delete process.env[key];
});

afterEach(() => {
  for (const key of environment) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

async function runGenerate(argv: string[]): Promise<CapturedRun> {
  const run: CapturedRun = { requests: [], stderr: [] };
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalWrite = process.stderr.write;
  globalThis.fetch = async (input, init) => {
    run.requests.push({ url: String(input), body: String(init?.body ?? "") });
    return Response.json({ taskRunId: "task-1" });
  };
  process.exit = ((code?: number) => {
    run.exitCode = code ?? 0;
    throw new ExitSignal(run.exitCode);
  }) as typeof process.exit;
  console.log = () => {};
  process.stderr.write = ((chunk: string | Uint8Array) => {
    run.stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const program = new Command("cohub").option("-s, --space <id>");
    registerGenerations(program);
    await program.parseAsync(["node", "cohub", "-s", SPACE_ID, "generate", ...argv]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    console.log = originalLog;
    process.stderr.write = originalWrite;
  }
  return run;
}

function generationBody(run: CapturedRun): GenerationBody {
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0]?.url, "https://api.test/api/generations");
  return JSON.parse(run.requests[0]?.body ?? "") as GenerationBody;
}

test("generate keeps the request body unchanged without --text", async () => {
  const run = await runGenerate([
    "A calm lake at sunrise",
    "--model",
    "test-model",
    "--image",
    "https://cdn.example.test/input.png",
    "--param",
    "seed=42",
    "--param",
    "duration=5",
    "--meta",
    '{"source":"baseline"}',
    "--async",
  ]);

  assert.equal(run.requests[0]?.body, baselineBody);
});

test("generate sends several --text blocks in the given order without a positional prompt", async () => {
  const run = await runGenerate([
    "--model",
    "song2",
    "--text",
    "prompt=upbeat synthwave",
    "--text",
    "lyrics=[Verse] Neon lights",
    "--text",
    "abc=X:1",
    "--async",
  ]);

  assert.deepEqual(generationBody(run).content, [
    { type: "text", text: "upbeat synthwave", meta: { role: "prompt" } },
    { type: "text", text: "[Verse] Neon lights", meta: { role: "lyrics" } },
    { type: "text", text: "X:1", meta: { role: "abc" } },
  ]);
});

test("generate keeps equals signs and newlines inside --text values", async () => {
  const run = await runGenerate([
    "--model",
    "song2",
    "--text",
    "lyrics=[Verse]\nLine one = still text\nLine two",
    "--async",
  ]);

  assert.deepEqual(generationBody(run).content, [
    { type: "text", text: "[Verse]\nLine one = still text\nLine two", meta: { role: "lyrics" } },
  ]);
});

test("generate sends the positional prompt first without a role", async () => {
  const run = await runGenerate([
    "A calm lake",
    "--model",
    "song2",
    "--text",
    "prompt=upbeat synthwave",
    "--async",
  ]);

  assert.deepEqual(generationBody(run).content, [
    { type: "text", text: "A calm lake" },
    { type: "text", text: "upbeat synthwave", meta: { role: "prompt" } },
  ]);
});

test("generate trims surrounding spaces from --text roles", async () => {
  const run = await runGenerate([
    "--model",
    "song2",
    "--text",
    "  lyrics  =[Verse] Neon lights",
    "--async",
  ]);

  assert.deepEqual(generationBody(run).content, [
    { type: "text", text: "[Verse] Neon lights", meta: { role: "lyrics" } },
  ]);
});

test("generate orders text blocks before media and keeps parameters", async () => {
  const run = await runGenerate([
    "A calm lake",
    "--model",
    "test-model",
    "--text",
    "prompt=cinematic",
    "--image",
    "https://cdn.example.test/input.png",
    "--audio",
    "https://cdn.example.test/input.mp3",
    "--param",
    "seed=7",
    "--async",
  ]);

  const body = generationBody(run);
  assert.deepEqual(body.content, [
    { type: "text", text: "A calm lake" },
    { type: "text", text: "cinematic", meta: { role: "prompt" } },
    { type: "image", source: { type: "url", url: "https://cdn.example.test/input.png" } },
    { type: "audio", source: { type: "url", url: "https://cdn.example.test/input.mp3" } },
  ]);
  assert.deepEqual(body.parameters, { seed: 7 });
});

test("generate rejects invalid --text values before sending", async () => {
  const cases = [
    ["missing equals sign", "lyrics"],
    ["empty role", "=abc"],
    ["whitespace-only role", " =abc"],
    ["empty text", "lyrics="],
  ];
  for (const [label, value] of cases) {
    const run = await runGenerate(["A calm lake", "--model", "song2", "--text", value, "--async"]);

    assert.equal(run.requests.length, 0, `${label}: sent a request`);
    const stderr = run.stderr.join("");
    assert.match(stderr, /Invalid --text/, `${label}: missing error`);
    assert.match(stderr, /--text <role>=<text>/, `${label}: error does not say what to pass`);
  }
});

test("generate requires a prompt or --text before sending", async () => {
  const run = await runGenerate(["--model", "song2", "--async"]);

  assert.equal(run.requests.length, 0);
  assert.match(run.stderr.join(""), /prompt/);
});
