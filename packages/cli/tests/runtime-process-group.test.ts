import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JsonRpcProcess, RpcProcessClosedError } from "../src/runtime/json-rpc.js";
import { ProcessCleanupUncertainError, confirmQuiescentProcessGroup, stopProcessGroup } from "../src/runtime/process-group.js";

const eperm = () => { const error = new Error("kill EPERM") as NodeJS.ErrnoException; error.code = "EPERM"; return error; };

test("an RPC process closed by the host is not a failure; one killed from outside reports the signal", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const failure = async (stop: (rpc: JsonRpcProcess) => Promise<unknown>) => {
    const rpc = new JsonRpcProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), "pi");
    const failed = new Promise<Error>((resolve) => rpc.onFailure(resolve));
    await stop(rpc);
    const error = await failed;
    await rpc.close();
    return error;
  };
  assert.ok(await failure((rpc) => rpc.close()) instanceof RpcProcessClosedError);
  assert.match((await failure(async (rpc) => process.kill(rpc.processGroupId ?? 0, "SIGTERM"))).message, /terminated by SIGTERM/);
});

test("RPC close waits for a SIGTERM-resistant descendant with detached pipes", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
  const rpc = new JsonRpcProcess(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-process-tree.mjs", import.meta.url))], process.cwd(), "codex");
  let pids: number[] = [];
  try {
    const response = await rpc.request("pid"); pids = [Number(response.branch), Number(response.leaf)];
    assert(pids.every((pid) => Number.isInteger(pid) && pid > 0));
    const started = Date.now();
    await rpc.close();
    assert(Date.now() - started >= 1900, "leader exit must not cancel group escalation");
    for (const pid of pids) {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
      assert(stat === null || ["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? ""), `descendant ${pid} cannot execute after close returns`);
    }
    await rpc.close();
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    await rpc.close();
  }
});

test("stopping a nonexistent group resolves immediately", { timeout: 5_000 }, async () => {
  await stopProcessGroup(999_999_999);
});

test("a zombie-only group is quiescent, not uncertain", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  // The child exits and stays a zombie until this process reaps it, so the group
  // holds nothing that can execute. Cleanup must confirm instead of escalating.
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: true });
  const pid = child.pid;
  assert(pid);
  await new Promise((resolve) => child.once("exit", resolve));
  try {
    await stopProcessGroup(pid);
  } finally {
    // Reap the zombie so the test process does not retain it.
    child.unref();
  }
});

test("EPERM on an emptied group confirms cleanup instead of escalating", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  // xnu's killpg1() returns EPERM (not ESRCH) once no member can be signalled, so a
  // naive caller misreads the normal end state as an unknown outcome. The platform
  // snapshot must be the source of truth.
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: true });
  const pid = child.pid;
  assert(pid);
  await new Promise((resolve) => child.once("exit", resolve));
  const kill = t.mock.method(process, "kill", () => { throw eperm(); });
  try {
    assert.equal(await confirmQuiescentProcessGroup(pid), true);
    await stopProcessGroup(pid);
  } finally {
    kill.mock.restore();
    child.unref();
  }
});

test("EPERM falls back to the snapshot, which still reports a live member", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  const pid = child.pid;
  assert(pid);
  const kill = t.mock.method(process, "kill", () => { throw eperm(); });
  try {
    assert.equal(await confirmQuiescentProcessGroup(pid), false);
  } finally {
    kill.mock.restore();
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
    child.unref();
  }
});

test("SIGKILL is sent exactly once to a SIGTERM-resistant group", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  // The child announces readiness once its SIGTERM handler is installed.
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const pid = child.pid;
  assert(pid);
  await new Promise<void>((resolve) => {
    child.stdout.once("data", () => resolve());
    setTimeout(resolve, 2_000); // Fall through; the handler test below is authoritative.
  });
  const realKill = process.kill;
  const kills: NodeJS.Signals[] = [];
  const kill = t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals) => {
    if (target === -pid && signal) kills.push(signal);
    return realKill.call(process, target, signal);
  });
  try {
    // SIGKILL cannot be caught, so the group dies; escalation must fire exactly once.
    await stopProcessGroup(pid);
    assert.equal(kills.filter((value) => value === "SIGKILL").length, 1, `SIGKILL sent ${kills.filter((value) => value === "SIGKILL").length} times`);
    assert.equal(kills[0], "SIGTERM", "SIGTERM precedes escalation");
  } finally {
    kill.mock.restore();
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
    child.unref();
  }
});

test("a group that survives escalation ends uncertain instead of confirmed", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const pid = child.pid;
  assert(pid);
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const realKill = process.kill;
  // Swallow every signal aimed at the group: the snapshot keeps seeing a runnable
  // member, so cleanup can neither confirm nor escalate further.
  const kill = t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals) => {
    if (target === -pid) return true;
    return realKill.call(process, target, signal);
  });
  const started = Date.now();
  try {
    await assert.rejects(stopProcessGroup(pid), (error: unknown) => error instanceof ProcessCleanupUncertainError, "a surviving group must surface an uncertain cleanup");
    assert.ok(Date.now() - started >= 5_000, "the timeout path, not an early exit, produced the verdict");
  } finally {
    kill.mock.restore();
    try { realKill.call(process, -pid, "SIGKILL"); } catch { /* Already gone. */ }
    child.unref();
  }
});
