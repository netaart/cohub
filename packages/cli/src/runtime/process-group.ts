import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

export class ProcessCleanupUncertainError extends Error {}

type GroupMember = { pid: number; state: string };
type ProcessGroupState =
  | { state: "alive"; members: GroupMember[] }
  | { state: "quiescent"; members: GroupMember[] }
  | { state: "unknown"; cause: unknown };

/** A member that can still execute code. Zombies cannot, so they never block cleanup. */
const executable = (member: GroupMember) => member.state !== "Z" && member.state !== "X";

/** Linux: /proc/<pid>/stat exposes pgrp and state for every member of the group. */
async function probeLinux(pid: number): Promise<ProcessGroupState> {
  const members: GroupMember[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      // After removing `pid (comm)`: state, ppid, pgrp, session, ...
      const [state, , processGroupId] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (processGroupId !== undefined && Number(processGroupId) === pid) members.push({ pid: Number(entry), state: state ?? "U" });
    } catch (error) {
      // Exited between readdir and read.
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return members.some(executable) ? { state: "alive", members } : { state: "quiescent", members };
}

/** macOS/BSD: one `ps` snapshot; a zombie's STAT starts with Z. */
async function probePosixSnapshot(pid: number): Promise<ProcessGroupState> {
  const output = await new Promise<string>((resolve, reject) => {
    const task = spawn("ps", ["-A", "-o", "pid=,pgid=,stat="], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    task.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    task.once("error", reject);
    task.once("close", (code) => code === 0 ? resolve(text) : reject(new Error(`ps exited ${code}`)));
  });
  const members: GroupMember[] = [];
  for (const line of output.split("\n")) {
    const [processId, processGroupId, stat] = line.trim().split(/\s+/);
    if (processGroupId !== undefined && Number(processGroupId) === pid) members.push({ pid: Number(processId), state: stat?.[0] ?? "U" });
  }
  return members.some(executable) ? { state: "alive", members } : { state: "quiescent", members };
}

/**
 * `kill(-pgid)` outcomes that carry no liveness information on their own.
 * ESRCH: the group is gone. EPERM: xnu's killpg1() reports it when no member can be
 * signalled anymore (exited or zombie), so on macOS it is the normal end state; our
 * harnesses run as the same user, so a real permission denial cannot occur here.
 */
const signalCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const groupUnsignallable = (error: unknown) => signalCode(error) === "ESRCH" || signalCode(error) === "EPERM";

/**
 * Windows has no process groups: cleanup kills the tree with taskkill, so the leader's
 * absence is the practical quiescence signal. A reused PID can only keep a result
 * uncertain, never wrongly confirm it.
 */
async function probeWindows(pid: number): Promise<ProcessGroupState> {
  try { process.kill(pid, 0); }
  catch (error) {
    if (signalCode(error) === "ESRCH") return { state: "quiescent", members: [] };
    return { state: "unknown", cause: error };
  }
  return { state: "alive", members: [{ pid, state: "R" }] };
}

/**
 * A group is alive only while a member can still execute. `kill(0)` is only a fast
 * path; the platform snapshot is the source of truth, and only a failing snapshot is
 * uncertain.
 */
async function probeProcessGroup(pid: number): Promise<ProcessGroupState> {
  if (process.platform === "win32") return probeWindows(pid);
  try { process.kill(-pid, 0); }
  catch (error) {
    if (signalCode(error) === "ESRCH") return { state: "quiescent", members: [] };
    if (signalCode(error) !== "EPERM") return { state: "unknown", cause: error };
  }
  if (process.platform === "linux") {
    try { return await probeLinux(pid); }
    catch (error) { return { state: "unknown", cause: error }; }
  }
  try { return await probePosixSnapshot(pid); }
  catch (error) { return { state: "unknown", cause: error }; }
}

const describeMembers = (members: GroupMember[]) => members.map((member) => `${member.pid}:${member.state}`).join(" ") || "none";

/** True only when the process group is gone or holds nothing that can execute. */
export async function confirmQuiescentProcessGroup(pid: number): Promise<boolean> {
  const probe = await probeProcessGroup(pid);
  return probe.state === "quiescent";
}

/**
 * Poll until the probe confirms quiescence. The interval backs off from 25ms to 200ms:
 * normal exits confirm on the first probe, while a resistant group stops spawning
 * snapshot subprocesses at full rate.
 */
async function awaitQuiescence(pid: number, probe: (pid: number) => Promise<ProcessGroupState>, escalate?: () => void) {
  const started = Date.now();
  let escalated = false;
  let pollMs = 25;
  for (;;) {
    const state = await probe(pid);
    if (state.state === "quiescent") return;
    if (state.state === "unknown" || Date.now() - started >= 5000) {
      throw new Error(state.state === "unknown" ? `probe failed: ${state.cause instanceof Error ? state.cause.message : String(state.cause)}` : `still running: ${describeMembers(state.members)}`);
    }
    if (escalate && !escalated && Date.now() - started >= 2000) { escalate(); escalated = true; }
    await delay(pollMs);
    pollMs = Math.min(pollMs * 2, 200);
  }
}

export async function stopProcessGroup(pid: number) {
  try {
    if (process.platform === "win32") {
      // taskkill's exit code is not authoritative: a PID that already exited is an
      // "error". The request is sent, then liveness decides.
      await new Promise<void>((resolve) => {
        const task = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
        task.once("error", () => resolve());
        task.once("exit", () => resolve());
      });
      await awaitQuiescence(pid, probeWindows);
      return;
    }
    const signal = (value: NodeJS.Signals) => {
      try { process.kill(-pid, value); }
      catch (error) { if (!groupUnsignallable(error)) throw error; }
    };
    signal("SIGTERM");
    await awaitQuiescence(pid, probeProcessGroup, () => signal("SIGKILL"));
  } catch (cause) {
    // Any cleanup failure leaves the outcome unresolved; callers treat it as uncertain.
    throw new ProcessCleanupUncertainError(`Tool process cleanup could not be confirmed; execution remains unresolved (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
}
