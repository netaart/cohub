import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { parsePduOutput, resolveWorkspaceScanPath, scanWorkspaceUsage } from "../src/system/jobs/workspace-usage/pdu.js";
import { usagePolicy } from "../src/system/jobs/workspace-usage/policy.js";
import { parseWorkspaceUsage, workspaceRuntime } from "../../../packages/infra/src/workspace-usage/index.js";

const output = (bytes: number) => JSON.stringify({ "schema-version": "2026-04-02", pdu: "0.24.0", unit: "bytes", tree: { size: bytes } });

test("missing Redis state is unknown, while a measured empty workspace is zero", () => {
  assert.deepEqual(parseWorkspaceUsage({}), { bytes: null, measuredAt: null, status: "pending" });
  assert.equal(parseWorkspaceUsage({ bytes: "0", measuredAt: "1000", dirty: "0" }).bytes, 0);
  assert.equal(parseWorkspaceUsage({ bytes: "4096", measuredAt: "1000", error: "scan_failed" }).bytes, 4096);
  assert.equal(parseWorkspaceUsage({ bytes: "4096", measuredAt: "1000", running: "1" }).status, "stale");
  assert.equal(parseWorkspaceUsage({ bytes: "-1", measuredAt: "1000" }).bytes, null);
});

test("rejects partial pdu results even with exit code zero", () => {
  assert.equal(parsePduOutput(output(4096), "\r\r", 0), 4096);
  assert.throws(() => parsePduOutput(output(4096), "Permission denied", 0));
  assert.throws(() => parsePduOutput(output(4096), "", 1));
  assert.throws(() => parsePduOutput(output(Number.MAX_SAFE_INTEGER + 1), "", 0));
  assert.throws(() => parsePduOutput('{"tree":{"size":0}}', "", 0));
});

test("limits NAS concurrency and treats uncertain sandbox lifecycle as writable", () => {
  assert.deepEqual(usagePolicy(), {
    threads: 1,
    concurrency: 1,
    timeoutMs: 300_000,
    minScanIntervalMs: 48 * 60 * 60_000,
    batchSize: 50,
  });
  const sandbox = { provider: "cloud", status: "error", podName: "pod", stoppedAt: null, meta: {} };
  assert.equal(workspaceRuntime(sandbox).running, true);
  assert.equal(workspaceRuntime({ ...sandbox, status: "stopped" }).running, false);
});

test("rejects symlink workspace roots and traversal before invoking pdu", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-usage-path-"));
  const id = "00000000-0000-0000-0000-000000000010";
  try {
    await mkdir(join(root, id, "workspace"), { recursive: true });
    assert.equal(await resolveWorkspaceScanPath(root, id), join(root, id, "workspace"));
    await assert.rejects(resolveWorkspaceScanPath(root, "../../outside"));
    await rm(join(root, id, "workspace"), { recursive: true });
    await symlink(tmpdir(), join(root, id, "workspace"));
    await assert.rejects(resolveWorkspaceScanPath(root, id));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("kills a timed out scanner without accepting its partial output", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-usage-process-"));
  try {
    const binary = join(root, "pdu");
    await writeFile(binary, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output(4096))}); setInterval(() => {}, 1000);`, { mode: 0o755 });
    await assert.rejects(scanWorkspaceUsage({ path: root, binary, threads: 1, timeoutMs: 100 }), /timed out/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(scanWorkspaceUsage({ path: root, binary, threads: 1, timeoutMs: 5000, signal: abort.signal }), /lease lost/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pinned pdu agrees with du on nested files, hardlinks and external symlinks", { skip: !process.env.COHUB_TEST_PDU_PATH }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-usage-pdu-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "node_modules", "package"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "package", "file"), Buffer.alloc(8192));
    await link(join(workspace, "node_modules", "package", "file"), join(workspace, "hardlink"));
    await writeFile(join(root, "outside"), Buffer.alloc(65536));
    await symlink(join(root, "outside"), join(workspace, "external"));
    const bytes = await scanWorkspaceUsage({ path: workspace, binary: process.env.COHUB_TEST_PDU_PATH, threads: 2, timeoutMs: 5000 });
    const du = await promisify(execFile)("du", ["-sx", "--block-size=1", workspace]);
    assert.equal(bytes, Number(du.stdout.split(/\s/)[0]));
    await assert.rejects(scanWorkspaceUsage({ path: join(root, "missing"), binary: process.env.COHUB_TEST_PDU_PATH, threads: 2, timeoutMs: 5000 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
