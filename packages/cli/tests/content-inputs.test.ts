import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, afterEach, beforeEach, test } from "node:test";
import { Command } from "commander";
import { registerGenerations, registerUpload } from "../src/commands/generations.js";
import { registerPrompt } from "../src/commands/spaces.js";

const SPACE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const directory = mkdtempSync(join(tmpdir(), "cohub-content-inputs-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const reference = { type: "audio", source: { type: "url", url: "https://cdn.example.test/ref.wav" }, meta: { text: "What the reference says" } };
const recording = { type: "image", source: { type: "base64", media_type: "audio/wav", data: "UklGRg==" } };
const completion = {
  completionId: "completion-1",
  provider: "provider",
  model: "listen",
  systemPromptPath: null,
  message: { role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop" },
  usage: null,
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

type Run = { requests: Array<{ url: string; method: string; body: string }>; stdout: string; stderr: string; exitCode?: number };

async function run(argv: string[], stdin?: string): Promise<Run> {
  const result: Run = { requests: [], stdout: "", stderr: "" };
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalWrite = process.stderr.write;
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    result.requests.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/completions")) return Response.json(completion);
    if (url.endsWith("/api/public-assets/uploads")) {
      const { filename } = (JSON.parse(body) as { file: { filename: string } }).file;
      return Response.json({
        expiresAt: "2026-11-10T00:00:00.000Z",
        asset: {
          purpose: "generation_input",
          objectKey: `generation-inputs/${filename}`,
          publicUrl: `https://cdn.example.test/${filename}`,
          uploadUrl: `https://upload.example.test/${filename}`,
          uploadMethod: "PUT",
        },
      });
    }
    if (init?.method === "PUT") return new Response(null, { status: 200 });
    return Response.json({ taskRunId: "task-1" });
  };
  process.exit = ((code?: number) => {
    result.exitCode = code ?? 0;
    throw new ExitSignal(result.exitCode);
  }) as typeof process.exit;
  console.log = (value: unknown) => {
    result.stdout += `${String(value)}\n`;
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    result.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  if (stdin !== undefined) Object.defineProperty(process, "stdin", { value: Readable.from([Buffer.from(stdin)]), configurable: true });
  try {
    const program = new Command("cohub").option("-s, --space <id>");
    registerPrompt(program);
    registerGenerations(program);
    registerUpload(program);
    await program.parseAsync(["node", "cohub", "-s", SPACE_ID, ...argv]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    console.log = originalLog;
    process.stderr.write = originalWrite;
    if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
  }
  return result;
}

function onlyBody(result: Run, url: string): Record<string, unknown> {
  assert.deepEqual(result.requests.map((request) => request.url), [url]);
  return JSON.parse(result.requests[0]?.body ?? "") as Record<string, unknown>;
}

test("completion sends --content blocks after the text in one user message", async () => {
  const result = await run([
    "completion", "Transcribe this", "-m", "listen", "--temperature", "0", "--thinking-level", "off",
    "--content", JSON.stringify([recording]), "--json",
  ]);

  assert.deepEqual(onlyBody(result, `https://api.test/api/spaces/${SPACE_ID}/completions`), {
    model: "listen",
    messages: [{ role: "user", content: [{ type: "text", text: "Transcribe this" }, recording] }],
    temperature: 0,
    thinkingLevel: "off",
    stream: false,
  });
  assert.deepEqual(JSON.parse(result.stdout), completion);
});

test("completion reads --content - from stdin and needs no text", async () => {
  const result = await run(["completion", "-m", "listen", "--content", "-", "--json"], JSON.stringify([recording]));

  assert.deepEqual(onlyBody(result, `https://api.test/api/spaces/${SPACE_ID}/completions`).messages, [
    { role: "user", content: [recording] },
  ]);
});

test("generate appends --content blocks as given after the other inputs", async () => {
  const result = await run([
    "generate", "Say this", "-m", "scene", "--audio", "https://cdn.example.test/other.wav",
    "--content", JSON.stringify([reference]), "--async",
  ]);

  assert.deepEqual(onlyBody(result, "https://api.test/api/generations").content, [
    { type: "text", text: "Say this" },
    { type: "audio", source: { type: "url", url: "https://cdn.example.test/other.wav" } },
    reference,
  ]);
});

test("generate takes --content from a file without a prompt", async () => {
  const blocks = [{ type: "text", text: "<|speaker:0|>Hi<|speaker:1|>Hello" }, reference, reference];
  const path = join(directory, "content.json");
  writeFileSync(path, JSON.stringify(blocks));

  const result = await run(["generate", "-m", "scene", "--content", path, "--async"]);

  assert.deepEqual(onlyBody(result, "https://api.test/api/generations").content, blocks);
});

test("--content that is not a JSON array of objects is refused before sending", async () => {
  const objectFile = join(directory, "object.json");
  writeFileSync(objectFile, JSON.stringify(reference));
  for (const command of [["completion", "Hi"], ["generate", "Hi", "-m", "scene", "--async"]]) {
    for (const content of ['[{"type":', "[1]", objectFile, join(directory, "missing.json")]) {
      const result = await run([...command, "--content", content]);

      assert.equal(result.requests.length, 0, `${command[0]} ${content}: sent a request`);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /content/i);
    }
  }
});

test("upload prints a public URL for each file", async () => {
  const wav = join(directory, "a.wav");
  const mp3 = join(directory, "b.mp3");
  writeFileSync(wav, "RIFF");
  writeFileSync(mp3, "ID3");

  const result = await run(["upload", wav, mp3, "--json"]);

  assert.deepEqual(JSON.parse(result.stdout), [
    { path: wav, mimeType: "audio/wav", publicUrl: "https://cdn.example.test/a.wav" },
    { path: mp3, mimeType: "audio/mpeg", publicUrl: "https://cdn.example.test/b.mp3" },
  ]);
  const plans = result.requests
    .filter((request) => request.url === "https://api.test/api/public-assets/uploads")
    .map((request) => JSON.parse(request.body) as { file: { filename: string } })
    .sort((a, b) => a.file.filename.localeCompare(b.file.filename));
  assert.deepEqual(plans, [
    { purpose: "generation_input", uploadProtocol: "presigned_put_v1", spaceId: SPACE_ID, file: { size: 4, mimeType: "audio/wav", filename: "a.wav" } },
    { purpose: "generation_input", uploadProtocol: "presigned_put_v1", spaceId: SPACE_ID, file: { size: 3, mimeType: "audio/mpeg", filename: "b.mp3" } },
  ]);
  assert.deepEqual(result.requests.filter((request) => request.method === "PUT").map((request) => request.url).sort(), [
    "https://upload.example.test/a.wav",
    "https://upload.example.test/b.mp3",
  ]);
});

test("upload refuses a missing file before uploading anything", async () => {
  const wav = join(directory, "c.wav");
  writeFileSync(wav, "RIFF");

  const result = await run(["upload", wav, join(directory, "missing.wav")]);

  assert.equal(result.requests.length, 0);
  assert.match(result.stderr, /Input not found/);
});
