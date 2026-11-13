import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDialectRegistry,
  createEditingSession,
  createScoreFileKeeper,
} from "@neta-art/score-editor";
import { song2Dialect } from "@neta-art/score-dialect-song2";
import type {
  SpaceFsFileResponse,
  SpaceFsPreparingFile,
  SpaceFsWriteFileInput,
} from "@neta-art/cohub";
import { createScoreHost, type OpenResult } from "../src/host/host.ts";
import type { TaskRunSnapshot } from "../src/host/task.ts";
import { createSdkFileClient, type SdkFileSource } from "../src/host/sdk.ts";

const SAMPLE = `X:1
T:
M:4/4
L:1/16
Q:1/4=190
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:E
% intro
V: Vocal
z12e2e2|b6b4e4f2-|f4g4z4e4|b6b4e2-e2f2-|
V: Ins
Z4|
`;
const CHINESE = SAMPLE.replace("% intro", "% 主歌");
const PATH = "scores/morning-walk.abc";

function fileResponse(overrides: Partial<SpaceFsFileResponse> = {}): SpaceFsFileResponse {
  return {
    path: PATH,
    name: "morning-walk.abc",
    size: 120,
    mimeType: null,
    mtimeMs: 1_000,
    kind: "text",
    encoding: "utf-8",
    content: SAMPLE,
    ...overrides,
  };
}

function sdkWith(options: {
  reads: Array<SpaceFsFileResponse | SpaceFsPreparingFile | Error>;
  writes?: Array<{ input: SpaceFsWriteFileInput; version: { mtimeMs: number; size: number } }>;
  fetch?: typeof fetch;
  entries?: Array<{ name: string; path: string; type: "file" | "dir" | "symlink" }>;
  deleted?: string[];
  task?: TaskRunSnapshot;
}): SdkFileSource {
  const reads = [...options.reads];
  return {
    auth: {
      async authorize() {
        return {
          status: "granted",
          target: { kind: "space", spaceId: "space-1", name: "Mine" },
          grant: { scopes: ["file.view", "file.edit"] },
        };
      },
    },
    tasks: {
      async get() {
        if (!options.task) throw new Error("no task staged");
        return { run: options.task };
      },
      async list() {
        return {
          runs: options.task ? [options.task] : [],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      },
    },
    navigation: {
      async open() {
        return { handled: true };
      },
    },
    space() {
      return {
        files: {
          async read() {
            const next = reads.shift();
            if (!next) throw new Error("no more reads staged");
            if (next instanceof Error) throw next;
            return next;
          },
          async list() {
            return { path: "", entries: options.entries ?? [] };
          },
          async delete(path: string) {
            options.deleted?.push(path);
            return { ok: true as const, path };
          },
          async write(input: SpaceFsWriteFileInput) {
            options.writes?.push({ input, version: { mtimeMs: 2_000, size: 130 } });
            return { ok: true, path: input.path, size: 130, mtimeMs: 2_000 };
          },
        },
      };
    },
  };
}

function clientFor(options: Parameters<typeof sdkWith>[0]) {
  return createSdkFileClient(sdkWith(options), { fetch: options.fetch });
}

async function opened(client: ReturnType<typeof clientFor>): Promise<OpenResult> {
  const host = createScoreHost({ client, language: "en" });
  return host.openFile({ spaceId: "space-1", path: PATH });
}

test("a base64 file decodes as UTF-8, Chinese lyrics included", async () => {
  const client = clientFor({
    reads: [fileResponse({ encoding: "base64", content: Buffer.from(CHINESE, "utf8").toString("base64") })],
  });

  const result = await opened(client);

  assert.ok(result.ok);
  assert.equal(result.kind, "scoreFile");
  assert.ok(result.source);
  assert.equal(result.project.score, CHINESE);
  assert.match(result.project.score, /% 主歌/);
  assert.equal(result.source.version, "1000:120");
});

test("a url delivery fetches the body as UTF-8 text", async () => {
  const fetched: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(CHINESE, { status: 200 });
  }) as typeof globalThis.fetch;
  const client = clientFor({
    reads: [fileResponse({ delivery: "url", url: "https://files.test/scores/morning-walk.abc", content: "" })],
    fetch,
  });

  const result = await opened(client);

  assert.ok(result.ok);
  assert.equal(result.kind, "scoreFile");
  assert.ok(result.source);
  assert.equal(result.project.score, CHINESE);
  assert.deepEqual(fetched, ["https://files.test/scores/morning-walk.abc"]);
  assert.equal(result.source.version, "1000:120");
});

test("a URL file that is not valid UTF-8 fails the read", async () => {
  const fetch = (async () =>
    new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200 })) as typeof globalThis.fetch;
  const client = clientFor({
    reads: [fileResponse({ delivery: "url", url: "https://files.test/scores/morning-walk.abc", content: "" })],
    fetch,
  });

  const result = await opened(client);

  assert.equal(result.ok, false);
  assert.deepEqual(result.state, { status: "failed" });
});

test("a preparing file is read again until it has content", async () => {
  const preparing: SpaceFsPreparingFile = {
    path: PATH,
    name: "morning-walk.abc",
    size: 120,
    mimeType: null,
    mtimeMs: 1_000,
    retryAfterMs: 1,
  };
  const client = clientFor({ reads: [preparing, fileResponse()] });

  const result = await opened(client);

  assert.ok(result.ok);
  assert.equal(result.kind, "scoreFile");
  assert.ok(result.source);
  assert.equal(result.project.score, SAMPLE);
  assert.equal(result.source.version, "1000:120");
});

test("a file that is not valid UTF-8 fails the read instead of showing noise", async () => {
  const client = clientFor({
    reads: [fileResponse({ encoding: "base64", content: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") })],
  });

  const result = await opened(client);

  assert.equal(result.ok, false);
  assert.deepEqual(result.state, { status: "failed" });
});

test("after a base64 open, a save writes UTF-8 text with the version it read", async () => {
  const writes: Array<{ input: SpaceFsWriteFileInput; version: { mtimeMs: number; size: number } }> = [];
  const client = clientFor({
    reads: [fileResponse({ encoding: "base64", content: Buffer.from(CHINESE, "utf8").toString("base64") })],
    writes,
  });
  const result = await opened(client);
  assert.ok(result.ok);
  assert.equal(result.kind, "scoreFile");
  assert.ok(result.source);

  const edited = CHINESE.replace("% 主歌", "% 主歌 二");
  const session = createEditingSession({
    project: result.project,
    dialects: createDialectRegistry([song2Dialect]),
    language: "en",
  });
  const keeper = createScoreFileKeeper({ session, original: result.project, source: result.source });
  session.dispatch({ type: "replaceScoreText", text: edited });
  const saved = await keeper.save();

  assert.equal(saved.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.input.content, edited);
  assert.notEqual(writes[0]?.input.content, Buffer.from(edited, "utf8").toString("base64"));
  assert.deepEqual(writes[0]?.input.expected, { mtimeMs: 1_000, size: 120 });
});

test("deleting a file calls the SDK delete", async () => {
  const deleted: string[] = [];
  const client = clientFor({ reads: [], deleted });

  await client.delete({ spaceId: "space-1", path: ".cohub/score-drafts/task-1.json" });

  assert.deepEqual(deleted, [".cohub/score-drafts/task-1.json"]);
});

test("a task is read through tasks.get", async () => {
  const task: TaskRunSnapshot = {
    id: "task-1",
    spaceId: "space-1",
    payload: {},
    result: {},
  };
  const client = clientFor({ reads: [], task });

  assert.deepEqual(await client.getTask("task-1"), task);
});

test("authorization reports the granted Space and forwards fallback", async () => {
  const source = sdkWith({ reads: [] });
  const seen: Array<{ fallback?: string }> = [];
  source.auth.authorize = async (input) => {
    seen.push(input);
    return {
      status: "granted",
      target: { kind: "space", spaceId: "space-9", name: "Mine" },
      grant: { scopes: ["file.view"] },
    };
  };
  const client = createSdkFileClient(source);
  const result = await client.authorize({
    spaceId: "space-1",
    scopes: ["file.view"],
    reason: "test",
    fallback: "none",
  });
  assert.deepEqual(result, {
    status: "granted",
    space: { id: "space-9", name: "Mine" },
    scopes: ["file.view"],
  });
  assert.equal(seen[0]?.fallback, "none");
});
