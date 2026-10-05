import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CopyPathChangedError, createCopyLimits, emptyCopyStats, planCopy, stageCopyOp, type CopyRoot } from "../src/system/jobs/space-fs-copy/tree.js";

const limits = createCopyLimits(4);
const options = { recursive: true };
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(spaceId: string, files: Record<string, string>): Promise<CopyRoot> {
  const root = await mkdtemp(join(tmpdir(), `copy-${spaceId}-`));
  cleanups.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    if (path.endsWith("/")) await mkdir(join(root, path), { recursive: true });
    else await writeFile(join(root, path), content);
  }
  return { spaceId, root, filter: null };
}

const plan = (target: CopyRoot, source: CopyRoot, path: string, destination: string) =>
  planCopy({ target, sources: [{ root: source, path }], destination, options, limits });

const stage = (target: CopyRoot, op: Parameters<typeof stageCopyOp>[0]["op"] | undefined, stagingPath: string) => {
  assert.ok(op);
  return stageCopyOp({ op, stagingPath, targetRoot: target.root, options, limits, progress: emptyCopyStats() });
};

test("copies a directory into an existing directory under its own name", async () => {
  const source = await workspace("a", { "docs/readme.md": "hello", "docs/guide/intro.md": "intro" });
  const target = await workspace("b", { "imports/": "" });

  const result = await plan(target, source, "docs", "imports");
  await stage(target, result.ops[0], "imports/.cohub-upload.copy-test");
  await rename(join(target.root, "imports/.cohub-upload.copy-test"), join(target.root, "imports/docs"));

  assert.deepEqual(result.paths, ["imports/docs"]);
  assert.equal(await readFile(join(target.root, "imports/docs/guide/intro.md"), "utf8"), "intro");
});

test("sources swapped for symlinks after planning are never followed", async () => {
  const victim = await workspace("victim", { ".env": "SECRET=1", "private/key.pem": "key" });
  const source = await workspace("a", { "note.md": "note", "docs/a.md": "a" });
  const target = await workspace("b", {});

  const file = await plan(target, source, "note.md", "copy");
  const dir = await plan(target, source, "docs", "copy");
  await rm(join(source.root, "note.md"));
  await symlink(join(victim.root, ".env"), join(source.root, "note.md"));
  await rm(join(source.root, "docs"), { recursive: true });
  await symlink(join(victim.root, "private"), join(source.root, "docs"));

  await assert.rejects(stage(target, file.ops[0], ".cohub-upload.copy-file"), CopyPathChangedError);
  await assert.rejects(stage(target, dir.ops[0], ".cohub-upload.copy-dir"), CopyPathChangedError);
  assert.deepEqual(await readdir(target.root), []);
});

test("a destination parent swapped for a symlink is never written through", async () => {
  const victim = await workspace("victim", {});
  const source = await workspace("a", { "note.md": "note" });
  const target = await workspace("b", { "inbox/": "" });

  const result = await plan(target, source, "note.md", "inbox");
  await rm(join(target.root, "inbox"), { recursive: true });
  await symlink(victim.root, join(target.root, "inbox"));

  await assert.rejects(stage(target, result.ops[0], "inbox/.cohub-upload.copy-test"), CopyPathChangedError);
  assert.deepEqual(await readdir(victim.root), []);
});
