import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { Job } from "bullmq";
import { drizzle } from "drizzle-orm/pglite";

process.env.LOG_LEVEL = "silent";
const migrations = join(import.meta.dirname, "../../api/drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
const db = drizzle(client);

const calls = { restore: 0, gitClone: 0 };
let workspaceNonEmpty = false;
let onAssertEmpty: (() => Promise<unknown>) | null = null;
let onPrepare: (() => Promise<unknown>) | null = null;
type Handler = (job: unknown) => Promise<unknown>;
let registered: Handler | null = null;
const handler = (job: unknown) => {
  if (!registered) throw new Error("create_space handler was not registered");
  return registered(job);
};
const mocks = [
  mock.module("../src/db.js", { exports: { db } }),
  mock.module("../src/tasks/registry.js", { exports: { registerTask: (_: string, fn: Handler) => { registered = fn; } } }),
  mock.module("../src/workspace-usage.js", { exports: { markWorkspaceChanged: async () => undefined } }),
  mock.module("../src/git.js", { exports: {
    assertDirectoryEmpty: async () => { await onAssertEmpty?.(); if (workspaceNonEmpty) throw new Error("refusing to bootstrap into non-empty workspace"); },
    ensureSpaceWorkspaceReady: async () => { await onPrepare?.(); },
    getSpaceWorkspaceDir: (id: string) => `/tmp/ws/${id}`,
    runGit: async (args: string[]) => { if (args[0] === "clone") calls.gitClone++; },
  } }),
  mock.module("../src/space-events.js", { exports: { publishSpaceEvent: async () => undefined, publishSpaceFsChanged: async () => undefined } }),
  mock.module("../src/tasks/enqueue.js", { exports: { enqueueTask: async () => ({ taskRunId: null }) } }),
  mock.module("../src/checkpoint/board.js", { exports: { restoreBoardCheckpointSnapshots: async () => ({ count: 0 }) } }),
  mock.module("../src/checkpoint/restore.js", { exports: { restoreWorkspaceFromCheckpoint: async () => { calls.restore++; throw new Error("refusing to bootstrap into non-empty workspace"); } } }),
  mock.module("../src/checkpoint/paths.js", { exports: { ensureCheckpointDirs: async () => ({ repoDir: "/tmp/r", workspaceDir: "/tmp/w", latestDir: "/tmp/l" }), getCheckpointLatestSubPath: () => "latest" } }),
  mock.module("../src/checkpoint/materialize.js", { exports: { materializeLatest: async () => undefined } }),
  mock.module("../src/checkpoint/scan.js", { exports: { scanWorkspace: async () => ({ files: [] }) } }),
  mock.module("../src/local-tmp.js", { exports: { ensureWorkerLocalTmpDir: async () => undefined, getWorkerLocalTmpDir: () => "/tmp/x", removeWorkerLocalTmpDir: async () => undefined } }),
  mock.module("../src/reference-index-queue.js", { exports: { enqueueReferences: () => undefined } }),
];
const { markCreateSpaceJobFailed } = await import("../src/tasks/create-space-task.js");
after(() => { for (const m of mocks) m.restore(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const addSpace = async (n: number, bootstrap: Record<string, unknown>) => {
  await client.query(`INSERT INTO v2.spaces (id, user_uuid, name, meta) VALUES ($1, 'u', $3, $2)`, [id(n), JSON.stringify({ keep: 1, bootstrap }), `s${n}`]);
};
type Meta = { keep?: number; bootstrap: { status: string; errorMessage?: string; initialCheckpointTaskRunId?: string; source: { type: string } } };
const meta = async (n: number) => {
  const { rows } = await client.query<{ meta: Meta }>(`SELECT meta FROM v2.spaces WHERE id = $1`, [id(n)]);
  if (!rows[0]) throw new Error(`space ${n} not found`);
  return rows[0].meta;
};
const job = (n: number, data: Record<string, unknown> = {}, jobId = `job-${n}`): Job => ({ id: jobId, name: "create_space", data: { type: "create_space", spaceId: id(n), data }, updateProgress: async () => undefined }) as unknown as Job;
const markReady = (n: number) => client.query(`UPDATE v2.spaces SET meta = jsonb_set(meta, '{bootstrap,status}', '"ready"') WHERE id = $1`, [id(n)]);
const reset = () => { for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0; workspaceNonEmpty = false; onAssertEmpty = null; onPrepare = null; };

test("rerun on a ready Space skips restore and leaves meta untouched", async () => {
  reset();
  await addSpace(1, { status: "ready", taskRunId: "job-1", source: { type: "checkpoint", checkpointId: "c" } });
  const before = await meta(1);
  const result = await handler(job(1, { source: { type: "checkpoint", checkpointId: "c" } }));
  assert.deepEqual(result, { ok: true, spaceId: id(1), alreadyReady: true });
  assert.equal(calls.restore, 0);
  assert.deepEqual(await meta(1), before);
});

test("a rerun racing the first run never overwrites ready", async () => {
  reset();
  await addSpace(2, { status: "running", taskRunId: "job-2" });
  onAssertEmpty = () => markReady(2);
  workspaceNonEmpty = true;
  await assert.rejects(handler(job(2, { source: { type: "git_repo", repoUrl: "https://example.test/r.git" } }, "job-2b")), /non-empty/);
  const m = await meta(2);
  assert.equal(m.bootstrap.status, "ready");
  await markCreateSpaceJobFailed(job(2), new Error("job stalled more than allowable limit"));
  assert.deepEqual(await meta(2), m);

  reset();
  await addSpace(3, { status: "running", taskRunId: "job-3" });
  onPrepare = () => markReady(3);
  assert.deepEqual(await handler(job(3, { source: { type: "git_repo", repoUrl: "https://example.test/r.git" } }, "job-3b")), { ok: true, spaceId: id(3), alreadyReady: true });
  assert.equal((await meta(3)).bootstrap.status, "ready");
  assert.equal(calls.gitClone, 0);
});

test("BullMQ fallback marks stuck pending/running bootstrap failed, ignores failed/ready and other jobs", async () => {
  reset();
  await addSpace(6, { status: "running", stage: "import" });
  await markCreateSpaceJobFailed(job(6), new Error("job stalled more than allowable limit"));
  const m = await meta(6);
  assert.equal(m.bootstrap.status, "failed");
  assert.equal(m.bootstrap.errorMessage, "job stalled more than allowable limit");
  assert.equal(m.keep, 1);

  await addSpace(7, { status: "pending" });
  await markCreateSpaceJobFailed(job(7), new Error("job stalled more than allowable limit"));
  assert.equal((await meta(7)).bootstrap.status, "failed");

  await addSpace(8, { status: "failed", errorMessage: "original" });
  await markCreateSpaceJobFailed(job(8), new Error("later"));
  assert.equal((await meta(8)).bootstrap.errorMessage, "original");

  await addSpace(9, { status: "running" });
  await markCreateSpaceJobFailed({ ...job(9), name: "save_checkpoint" }, new Error("x"));
  assert.equal((await meta(9)).bootstrap.status, "running");
});
