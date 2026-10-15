import assert from "node:assert/strict";
import { constants } from "node:fs";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { describe, test, type TestContext } from "node:test";
import { directoryEntry, openSpaceDirectory, openSpaceFile, removeSpaceEntry, resolveSpacePath, SPACE_FILE_FLAGS, SpaceFsPathError } from "./resolve.js";
import { createSpaceGitignoreFilter } from "./ignore.js";

async function fixture(t: TestContext) {
  const output = resolve("output");
  await mkdir(output, { recursive: true });
  const base = await mkdtemp(`${output}/fs-boundary-`);
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = `${base}/workspace`;
  const outside = `${base}/outside`;
  await mkdir(`${root}/docs`, { recursive: true });
  await mkdir(outside);
  await writeFile(`${root}/docs/file.txt`, "workspace");
  await writeFile(`${outside}/file.txt`, "outside");
  return { root, outside };
}

describe("Linux shared workspace paths", { skip: process.platform !== "linux" }, () => {

test("relative directory symlinks support reads, writes and parent traversal inside the workspace", async (t) => {
  const { root } = await fixture(t);
  await symlink("docs", `${root}/alias`);
  await mkdir(`${root}/nested`);
  await symlink("../alias", `${root}/nested/link`);
  await using file = await openSpaceFile(root, "nested/link/file.txt");
  assert.equal(await file.readFile("utf8"), "workspace");
  await using destination = await resolveSpacePath(root, "nested/link/new/file.txt", true);
  assert.deepEqual(destination.createdDirs, ["nested/link/new"]);
  await using written = await open(destination.target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | SPACE_FILE_FLAGS);
  await written.writeFile("created");
  assert.equal(await readFile(`${root}/docs/new/file.txt`, "utf8"), "created");
});

test("escaping, absolute and looping intermediate links are rejected", async (t) => {
  const { root, outside } = await fixture(t);
  await symlink("../outside", `${root}/escape`);
  await symlink(outside, `${root}/absolute`);
  await symlink(`${root}/docs`, `${root}/absolute-inside`);
  await symlink("loop", `${root}/loop`);
  for (const name of ["escape", "absolute", "absolute-inside", "loop"]) {
    await assert.rejects(openSpaceFile(root, `${name}/file.txt`), SpaceFsPathError);
    await assert.rejects(resolveSpacePath(root, `${name}/new/file.txt`, true), SpaceFsPathError);
  }
  assert.deepEqual(await readdir(outside), ["file.txt"]);
});

test("symlink expansion has a finite limit and preserves component order", async (t) => {
  const { root } = await fixture(t);
  for (let index = 0; index < 41; index += 1) {
    await symlink(index === 40 ? "docs" : `link-${index + 1}`, `${root}/link-${index}`);
  }
  await using file = await openSpaceFile(root, "link-1/file.txt");
  assert.equal(await file.readFile("utf8"), "workspace");
  await assert.rejects(openSpaceFile(root, "link-0/file.txt"), SpaceFsPathError);
  await symlink("docs/../../outside", `${root}/escape-after-parent`);
  await assert.rejects(openSpaceFile(root, "escape-after-parent/file.txt"), SpaceFsPathError);
});

test("leaf links can be renamed and deleted while file opens reject them", async (t) => {
  const { root, outside } = await fixture(t);
  await symlink(`${outside}/file.txt`, `${root}/leaf`);
  await assert.rejects(openSpaceFile(root, "leaf"), { code: "ELOOP" });
  await using source = await resolveSpacePath(root, "leaf");
  await using destination = await resolveSpacePath(root, "renamed");
  await rename(source.target, destination.target);
  await removeSpaceEntry(destination.target, false);
  assert.equal(await readFile(`${outside}/file.txt`, "utf8"), "outside");
});

test("replacing a resolved parent cannot redirect reads or writes", async (t) => {
  const { root, outside } = await fixture(t);
  await using source = await resolveSpacePath(root, "docs/file.txt");
  await rename(`${root}/docs`, `${root}/original`);
  await symlink(outside, `${root}/docs`);
  await using file = await open(source.target, constants.O_RDWR | SPACE_FILE_FLAGS);
  assert.equal(await file.readFile("utf8"), "workspace");
  await file.truncate(0);
  await file.write("updated", 0, "utf8");
  assert.equal(await readFile(`${root}/original/file.txt`, "utf8"), "updated");
  assert.equal(await readFile(`${outside}/file.txt`, "utf8"), "outside");
});

test("replacing an opened file cannot redirect file streams", async (t) => {
  const { root, outside } = await fixture(t);
  await using file = await openSpaceFile(root, "docs/file.txt");
  await rename(`${root}/docs/file.txt`, `${root}/docs/original.txt`);
  await symlink(`${outside}/file.txt`, `${root}/docs/file.txt`);
  const stream = file.createReadStream({ autoClose: false });
  try {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "workspace");
    assert.equal((await file.stat()).size, 9);
  } finally {
    stream.destroy();
  }
});

test("recursive deletion does not follow links to other directories", async (t) => {
  const { root, outside } = await fixture(t);
  await symlink(outside, `${root}/docs/external`);
  await using entry = await resolveSpacePath(root, "docs");
  await assert.rejects(removeSpaceEntry(entry.target, false), { code: "EISDIR" });
  await removeSpaceEntry(entry.target, true);
  assert.equal(await readFile(`${outside}/file.txt`, "utf8"), "outside");
});

test("opened directory listing remains bound after replacement", async (t) => {
  const { root, outside } = await fixture(t);
  await using entry = await resolveSpacePath(root, "docs");
  await using directory = await openSpaceDirectory(entry.target);
  await rename(`${root}/docs`, `${root}/original`);
  await symlink(outside, `${root}/docs`);
  await writeFile(`${root}/original/inside.txt`, "inside");
  assert.deepEqual((await readdir(directoryEntry(directory))).sort(), ["file.txt", "inside.txt"]);
});

test("gitignore reads use regular files inside the workspace", async (t) => {
  const { root, outside } = await fixture(t);
  await writeFile(`${root}/.gitignore`, "ignored.txt\n");
  assert.equal((await createSpaceGitignoreFilter(root)).isIgnored("ignored.txt"), true);
  await unlink(`${root}/.gitignore`);
  await symlink(`${outside}/file.txt`, `${root}/.gitignore`);
  await assert.rejects(createSpaceGitignoreFilter(root), { code: "ELOOP" });
});

test("web stream completion and cancellation close the file handle", async (t) => {
  const { root } = await fixture(t);
  const file = await openSpaceFile(root, "docs/file.txt");
  const stream = file.createReadStream({ start: 1, end: 3 });
  const closed = once(stream, "close");
  assert.equal(await text(Readable.toWeb(stream)), "ork");
  await closed;
  assert.equal(file.fd, -1);
  const cancelled = await openSpaceFile(root, "docs/file.txt");
  const cancelledStream = cancelled.createReadStream();
  const cancelledClose = new Promise<void>((done) => cancelledStream.once("close", done));
  await Readable.toWeb(cancelledStream).cancel();
  await cancelledClose;
  assert.equal(cancelled.fd, -1);
});

test("concurrent parent replacement never reads outside the workspace", async (t) => {
  const { root, outside } = await fixture(t);
  let running = true;
  let swaps = 0;
  const attacker = (async () => {
    while (running) {
      await rename(`${root}/docs`, `${root}/saved`);
      await symlink(outside, `${root}/docs`);
      await unlink(`${root}/docs`);
      await rename(`${root}/saved`, `${root}/docs`);
      swaps += 1;
    }
  })();
  let reads = 0;
  try {
    for (let index = 0; index < 150; index += 1) {
      let file: FileHandle;
      try {
        file = await openSpaceFile(root, "docs/file.txt");
      } catch (error) {
        assert.ok(error instanceof SpaceFsPathError || ["ENOENT", "ENOTDIR", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? ""));
        continue;
      }
      await using opened = file;
      assert.equal(await opened.readFile("utf8"), "workspace");
      reads += 1;
    }
  } finally {
    running = false;
    await attacker;
  }
  assert.ok(swaps > 0);
  // 正常读取单独验证，竞争期间允许全部请求被拒绝。
  await using file = await openSpaceFile(root, "docs/file.txt");
  assert.equal(await file.readFile("utf8"), "workspace");
  t.diagnostic(`${swaps} swaps, ${reads} successful concurrent reads`);
});

test("failed resolutions release every opened descriptor", async (t) => {
  const { root } = await fixture(t);
  await symlink("../../outside", `${root}/docs/escape`);
  const before = (await readdir("/proc/self/fd")).length;
  for (let index = 0; index < 50; index += 1) {
    await assert.rejects(openSpaceFile(root, "docs/escape/file.txt"), SpaceFsPathError);
    await assert.rejects(openSpaceFile(root, "missing/file.txt"), { code: "ENOENT" });
  }
  assert.equal((await readdir("/proc/self/fd")).length, before);
});

});
