import assert from "node:assert/strict";
import test from "node:test";
import { writeUploadsThroughSandbox, type SandboxUploadWrite } from "./space-fs-upload.js";

const MiB = 1024 * 1024;

class SpaceFsError extends Error {
  override name = "SpaceFsError";
}

test("multipart uploads to a running sandbox write every file through it", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const write: SandboxUploadWrite = async (input) => {
    writes.push(input);
    return {
      path: input.path,
      size: Buffer.from(input.content, "base64").length,
      mtimeMs: 42,
      created: input.path.endsWith("a.txt"),
      createdDirs: ["docs", "docs/new"],
    };
  };

  const result = await writeUploadsThroughSandbox(
    [new File(["hello"], "a.txt"), new File(["world!"], "b.md")],
    "docs/new",
    write,
  );

  assert.deepEqual(writes, [
    { path: "docs/new/a.txt", content: Buffer.from("hello").toString("base64") },
    { path: "docs/new/b.md", content: Buffer.from("world!").toString("base64") },
  ]);
  assert.deepEqual(result.createdDirs, ["docs", "docs/new"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.uploaded.map(({ path, size, created, mimeType }) => ({ path, size, created, mimeType })), [
    { path: "docs/new/a.txt", size: 5, created: true, mimeType: "text/plain" },
    { path: "docs/new/b.md", size: 6, created: false, mimeType: "text/markdown" },
  ]);
});

test("files above the inline write limit and failed writes are reported per file", async () => {
  const write: SandboxUploadWrite = async (input) => {
    if (input.path === "locked.txt") throw new SpaceFsError("File changed.");
    if (input.path === "down.txt") throw new Error("connect ECONNREFUSED 10.0.0.1:7070");
    return { path: input.path, size: 1, mtimeMs: 1, created: true, createdDirs: [] };
  };

  const result = await writeUploadsThroughSandbox(
    [
      new File([new Uint8Array(10 * MiB + 1)], "big.bin"),
      new File(["x"], "locked.txt"),
      new File(["x"], "down.txt"),
      new File(["y"], "ok.txt"),
    ],
    "",
    write,
  );

  assert.deepEqual(result.uploaded.map((file) => file.path), ["ok.txt"]);
  assert.deepEqual(result.errors, [
    { name: "big.bin", code: "file_too_large", message: "file exceeds 10MB limit while the sandbox is running; use a staged upload" },
    { name: "locked.txt", code: "write_failed", message: "file changed" },
    { name: "down.txt", code: "write_failed", message: "failed to write file" },
  ]);
});
