import assert from "node:assert/strict";
import { test } from "node:test";
import { CohubHttpClient } from "../src/http.js";
import type { Fetch } from "../src/transport.js";

function jsonResponse(body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("space file mutations forward client mutation ids", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: Fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse();
  };
  const files = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch })
    .space("space-1")
    .files;

  await files.createDir("docs", "mutation-dir");
  await files.delete("docs", true, "mutation-delete");
  await files.move({ fromPath: "a.txt", toPath: "b.txt", mutationId: "mutation-move" });

  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    path: "docs",
    mutationId: "mutation-dir",
  });

  const deleteUrl = new URL(requests[1]?.url ?? "");
  assert.equal(deleteUrl.pathname, "/api/spaces/space-1/fs/node");
  assert.equal(deleteUrl.searchParams.get("path"), "docs");
  assert.equal(deleteUrl.searchParams.get("recursive"), "true");
  assert.equal(deleteUrl.searchParams.get("mutationId"), "mutation-delete");

  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
    fromPath: "a.txt",
    toPath: "b.txt",
    mutationId: "mutation-move",
  });
});

test("space files resolve preview and playback URLs with distinct delivery rules", async () => {
  const responses = [
    {
      path: "image.png",
      name: "image.png",
      size: 3,
      mimeType: "image/png",
      mtimeMs: 1,
      kind: "binary",
      encoding: "base64",
      content: "YWJj",
      delivery: "inline",
    },
    {
      path: "video.mp4",
      name: "video.mp4",
      size: 100,
      mimeType: "video/mp4",
      mtimeMs: 2,
      kind: "binary",
      encoding: "base64",
      content: "",
      delivery: "url",
      url: "https://cdn.example/video.mp4",
    },
    {
      path: "audio.mp3",
      name: "audio.mp3",
      size: 3,
      mimeType: "audio/mpeg",
      mtimeMs: 3,
      kind: "binary",
      encoding: "base64",
      content: "YWJj",
      delivery: "inline",
    },
  ];
  const fetch: Fetch = async () => jsonResponse(responses.shift());
  const files = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch })
    .space("space-1")
    .files;

  assert.equal(
    await files.resolveUrl("image.png", { purpose: "preview" }),
    "data:image/png;base64,YWJj",
  );
  assert.equal(
    await files.resolveUrl("video.mp4", { purpose: "playback" }),
    "https://cdn.example/video.mp4",
  );
  assert.equal(
    await files.resolveUrl("audio.mp3", { purpose: "playback" }),
    null,
  );
});

test("space file URL resolution respects a zero preparation timeout", async () => {
  const fetch: Fetch = async () =>
    jsonResponse({
      path: "video.mp4",
      name: "video.mp4",
      size: 100,
      mimeType: "video/mp4",
      mtimeMs: 1,
      retryAfterMs: 2_000,
    });
  const files = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch })
    .space("space-1")
    .files;

  assert.equal(await files.resolveUrl("video.mp4", { timeoutMs: 0 }), null);
});

test("space file URL resolution aborts a stuck request at its deadline", async () => {
  let requestSignal: AbortSignal | null = null;
  const fetch: Fetch = async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener(
        "abort",
        () => reject(requestSignal?.reason),
        { once: true },
      );
    });
  };
  const files = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch })
    .space("space-1")
    .files;

  assert.equal(await files.resolveUrl("video.mp4", { timeoutMs: 5 }), null);
  assert.equal(requestSignal?.aborted, true);
});

test("board creation forwards its mutation id", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: Fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse();
  };
  const boards = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch })
    .space("space-1")
    .boards;

  await boards.create({ path: "plan.board", mutationId: "mutation-board" });

  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    path: "plan.board",
    mutationId: "mutation-board",
  });
});

test("space file reads revalidate a cached body by ETag", async () => {
  const file = {
    path: "manifest.json",
    name: "manifest.json",
    size: 2,
    mimeType: "application/json",
    mtimeMs: 1,
    kind: "text",
    encoding: "utf-8",
    content: "{}",
    delivery: "inline",
  };
  const sentTags: Array<string | null> = [];
  const fetch: Fetch = async (_input, init) => {
    const ifNoneMatch = new Headers(init?.headers).get("If-None-Match");
    sentTags.push(ifNoneMatch);
    if (ifNoneMatch === '"v1"') return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
    return new Response(JSON.stringify(file), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"v1"' },
    });
  };
  const files = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch })
    .space("space-revalidate")
    .files;

  const first = await files.read("manifest.json");
  const second = await files.read("manifest.json");

  assert.deepEqual(sentTags, [null, '"v1"']);
  assert.deepEqual(first, file);
  assert.deepEqual(second, file);
  assert.notEqual(first, second);
});
