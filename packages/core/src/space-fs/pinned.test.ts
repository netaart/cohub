import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createSpacePathDirectory, openSpaceDirectory, openSpaceFile, pinSpacePath,
  pinnedDirectoryEntry, removeSpacePath, renameSpacePath, SpaceFsPathError, writeSpacePath,
} from "./pinned.js";

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "cohub-fs-boundary-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const other = join(base, "other-tenant");
  await Promise.all([mkdir(root), mkdir(other)]);
  await writeFile(join(other, "secret.txt"), "outside-secret");
  return { base, root, other };
}

const blocked = (error: unknown) => error instanceof SpaceFsPathError ||
  (error instanceof Error && "code" in error && ["ELOOP", "EEXIST", "ENOTDIR"].includes(String(error.code)));

test("regular workspace operations preserve create, overwrite, version and exclusive semantics", async (t) => {
  const { root } = await fixture(t);
  const created = await writeSpacePath(root, "docs/nested/note.txt", Buffer.from("first"));
  assert.equal(created.created, true);
  assert.deepEqual(created.createdDirs, ["docs", "docs/nested"]);
  const file = await openSpaceFile(root, "docs/nested/note.txt");
  try { assert.equal(await file.readFile("utf8"), "first"); } finally { await file.close(); }
  await assert.rejects(writeSpacePath(root, "docs/nested/note.txt", Buffer.from("bad"), { exclusive: true }), blocked);
  await assert.rejects(writeSpacePath(root, "docs/nested/note.txt", Buffer.from("bad"), {
    checkVersion: () => { throw new Error("version conflict"); },
  }), /version conflict/);
  assert.equal(await readFile(join(root, "docs/nested/note.txt"), "utf8"), "first");
  assert.equal((await writeSpacePath(root, "docs/nested/note.txt", Buffer.from("ok"))).created, false);
  assert.equal(await readFile(join(root, "docs/nested/note.txt"), "utf8"), "ok");
  await renameSpacePath(root, "docs/nested/note.txt", "moved/note.txt");
  await removeSpacePath(root, "docs", true);
  assert.equal(await readFile(join(root, "moved/note.txt"), "utf8"), "ok");
});

test("intermediate directory links cannot read, list, create, overwrite, move or delete another tenant", async (t) => {
  const { root, other } = await fixture(t);
  await symlink(other, join(root, "escape"));
  await writeFile(join(root, "own.txt"), "own");
  for (const action of [
    () => openSpaceFile(root, "escape/secret.txt"),
    () => openSpaceDirectory(root, "escape"),
    () => writeSpacePath(root, "escape/secret.txt", Buffer.from("bad")),
    () => writeSpacePath(root, "escape/new/created.txt", Buffer.from("bad")),
    () => createSpacePathDirectory(root, "escape/new"),
    () => removeSpacePath(root, "escape/secret.txt", true),
    () => renameSpacePath(root, "own.txt", "escape/replaced.txt"),
    () => renameSpacePath(root, "escape/secret.txt", "stolen.txt"),
  ]) await assert.rejects(action(), blocked);
  assert.equal(await readFile(join(other, "secret.txt"), "utf8"), "outside-secret");
  assert.deepEqual(await readdir(other), ["secret.txt"]);
});

test("leaf and dangling links are never opened or overwritten; unlink and rename operate on the link", async (t) => {
  const { root, other } = await fixture(t);
  await symlink(join(other, "secret.txt"), join(root, "link"));
  await symlink(join(other, "new.txt"), join(root, "dangling"));
  for (const name of ["link", "dangling"]) {
    await assert.rejects(openSpaceFile(root, name), blocked);
    await assert.rejects(writeSpacePath(root, name, Buffer.from("bad")), blocked);
    await assert.rejects(writeSpacePath(root, name, Buffer.from("bad"), { exclusive: true }), blocked);
  }
  await renameSpacePath(root, "link", "renamed-link");
  assert.equal((await lstat(join(root, "renamed-link"))).isSymbolicLink(), true);
  await removeSpacePath(root, "renamed-link", true);
  await removeSpacePath(root, "dangling", true);
  assert.equal(await readFile(join(other, "secret.txt"), "utf8"), "outside-secret");
  assert.deepEqual(await readdir(other), ["secret.txt"]);
});

test("pinned parent remains the original directory after it is replaced by a symlink", async (t) => {
  const { root, other } = await fixture(t);
  await mkdir(join(root, "inbox"));
  const pinned = await pinSpacePath(root, "inbox/new.txt");
  try {
    await rename(join(root, "inbox"), join(root, "original"));
    await symlink(other, join(root, "inbox"));
    const file = await open(pinned.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
    try { await file.writeFile("safe"); } finally { await file.close(); }
    assert.equal(await readFile(join(root, "original/new.txt"), "utf8"), "safe");
    assert.deepEqual(await readdir(other), ["secret.txt"]);
    await assert.rejects(writeSpacePath(root, "inbox/new.txt", Buffer.from("bad")), blocked);
  } finally { await pinned.close(); }
});

test("open file and range streams retain the validated inode after leaf replacement", async (t) => {
  const { root, other } = await fixture(t);
  await writeFile(join(root, "file.txt"), "safe-content");
  const file = await openSpaceFile(root, "file.txt");
  await rename(join(root, "file.txt"), join(root, "original.txt"));
  await symlink(join(other, "secret.txt"), join(root, "file.txt"));
  const chunks: Buffer[] = [];
  for await (const chunk of file.createReadStream({ start: 0, end: 3 })) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "safe");
  assert.equal(file.fd, -1);
  await assert.rejects(openSpaceFile(root, "file.txt"), blocked);
});

test("directory listing is bound to the opened directory after path replacement", async (t) => {
  const { root, other } = await fixture(t);
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir/visible.txt"), "safe");
  const directory = await openSpaceDirectory(root, "dir");
  try {
    await rename(join(root, "dir"), join(root, "original"));
    await symlink(other, join(root, "dir"));
    assert.deepEqual(await readdir(pinnedDirectoryEntry(directory)), ["visible.txt"]);
  } finally { await directory.close(); }
});

test("recursive deletion unlinks nested symlinks without descending into their targets", async (t) => {
  const { root, other } = await fixture(t);
  await mkdir(join(root, "tree/nested"), { recursive: true });
  await symlink(other, join(root, "tree/nested/outside"));
  await writeFile(join(root, "tree/owned.txt"), "owned");
  await removeSpacePath(root, "tree", true);
  assert.equal(await readFile(join(other, "secret.txt"), "utf8"), "outside-secret");
});

test("redirected workspace roots, lexical escapes and non-files fail closed", async (t) => {
  const { base, root, other } = await fixture(t);
  await symlink(other, join(base, "redirected"));
  await assert.rejects(openSpaceFile(join(base, "redirected"), "secret.txt"), blocked);
  await mkdir(join(root, "dir"));
  await assert.rejects(openSpaceFile(root, "dir"), blocked);
  for (const path of ["../other-tenant/secret.txt", "/etc/passwd", "dir/../../secret.txt", "dir//file", "dir\\file", "x\0y"]) {
    await assert.rejects(openSpaceFile(root, path), blocked);
    await assert.rejects(writeSpacePath(root, path, Buffer.from("bad")), blocked);
  }
});

test("a missing rename source does not create destination directories", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(renameSpacePath(root, "missing.txt", "new/nested/file.txt"), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), []);
});

test("native directory entry names remain listable and recursively removable", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "tree"));
  const name = "literal\\name.txt";
  await writeFile(join(root, "tree", name), "owned");
  const directory = await openSpaceDirectory(root, "tree");
  try {
    assert.deepEqual(await readdir(pinnedDirectoryEntry(directory)), [name]);
    assert.equal((await lstat(pinnedDirectoryEntry(directory, name))).isFile(), true);
    for (const invalid of [".", "..", "../outside", "child/", "child/file", "x\0y"]) {
      assert.throws(() => pinnedDirectoryEntry(directory, invalid), blocked);
    }
  } finally {
    await directory.close();
  }
  await removeSpacePath(root, "tree", true);
  await assert.rejects(lstat(join(root, "tree")), { code: "ENOENT" });
});

test("directory deletion still requires the recursive option", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "empty"));
  await assert.rejects(removeSpacePath(root, "empty", false), { code: "EISDIR" });
  assert.equal((await lstat(join(root, "empty"))).isDirectory(), true);
  await removeSpacePath(root, "empty", true);
});

test("repeated rejected operations close directory and file descriptors", async (t) => {
  const { root, other } = await fixture(t);
  await symlink(other, join(root, "escape"));
  const before = (await readdir("/proc/self/fd")).length;
  for (let n = 0; n < 40; n++) await assert.rejects(openSpaceFile(root, "escape/secret.txt"), blocked);
  const after = (await readdir("/proc/self/fd")).length;
  assert.equal(after, before);
});
