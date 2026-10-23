import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough, type Readable } from "node:stream";
import { resolveWebsocketUrl, type LocalHarness, type RuntimeCapabilities } from "@neta-art/cohub";
import { AuthRequiredError, resolveAccessToken } from "../auth.js";
import { createClient } from "../client.js";
import { currentIdentityKey } from "../space.js";
import { ensureSandboxdBinary } from "../commands/sandboxd-binary.js";
import { serveRuntime } from "./connection.js";
import { discoverHarnesses, type HarnessExecutables } from "./harnesses/index.js";
import { RuntimeDiagnostics, serializeDiagnosticError, type RuntimeDiagnostic, type RuntimeDiagnosticLevel } from "./diagnostics.js";
import { ownRuntimeInstance, runtimeInstanceDirectory } from "./instance.js";
import { createDiagnosticConsole, type RuntimeSummary } from "./presentation.js";
import { join } from "node:path";
import { RuntimeArchiveStore } from "./archive-store.js";
import { readNativeConfig, runtimeStateRoot } from "./native/config.js";
import { NativeRuntime } from "./native/daemon.js";

export type RuntimeLaunch = {
  spaceId: string;
  root: string;
  identity: string;
  harnesses: LocalHarness[];
  executables: HarnessExecutables;
  capabilities?: RuntimeCapabilities;
  background: boolean;
  verbose?: boolean;
  /** Start importing earlier conversations as soon as the Runtime is connected. */
  importHistory?: boolean;
  display?: string;
};

export function sandboxOutputLevel(value: unknown, stream: "stdout" | "stderr"): RuntimeDiagnosticLevel {
  const level = typeof value === "string" ? value.toLowerCase() : "";
  if (["debug", "info", "warn", "error"].includes(level)) return level as RuntimeDiagnosticLevel;
  return stream === "stderr" ? "warn" : "debug";
}

/**
 * Windows cannot hand sandboxd an extra inherited pipe, so control frames use a
 * named pipe instead. Only the first client is accepted; the name is unguessable.
 */
async function listenWindowsControlPipe() {
  const path = `\\\\.\\pipe\\cohub-sandboxd-${randomUUID()}`;
  const stream = new PassThrough();
  const server = createServer((socket) => {
    server.close();
    socket.on("error", () => stream.end());
    socket.pipe(stream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });
  return { path, stream, close: () => { server.close(); stream.end(); } };
}

export async function runRuntime(config: RuntimeLaunch, onState: (status: RuntimeSummary) => void, externalSignal?: AbortSignal, onDiagnostic?: (event: RuntimeDiagnostic) => void) {
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const client = createClient();
  const space = client.space(config.spaceId);
  const stateRoot = runtimeStateRoot(config.spaceId);
  const archives = new RuntimeArchiveStore(join(stateRoot, "archives"), space);
  const consoleSink = config.background ? undefined : createDiagnosticConsole(config.verbose);
  const diagnostics = new RuntimeDiagnostics({
    root: stateRoot, spaceId: config.spaceId, runtimeId: randomUUID(),
    onEvent: (event) => { consoleSink?.(event); onDiagnostic?.(event); },
  });
  archives.setErrorReporter((error, index) => diagnostics.log("warn", "archive.upload_pending", { error: serializeDiagnosticError(error) }, {
    component: "archive", sessionId: index?.sessionId, turnId: index?.turnId, harness: index?.harness,
  }));
  const native = new NativeRuntime({
    spaceId: config.spaceId, root: config.root, stateRoot, harnesses: config.harnesses, executables: config.executables,
    identity: config.identity, config: await readNativeConfig(stateRoot, config.identity).catch(() => null),
    archives, projectionSource: space, diagnostics,
  });
  let status: RuntimeSummary = {
    spaceId: config.spaceId, root: config.root, runtimeId: diagnostics.runtimeId,
    pid: process.pid, harnesses: config.harnesses, background: config.background,
    ...(config.display ? { display: config.display } : {}),
    state: "starting", harnessConnected: false, workspaceConnected: false,
    diagnosticsPath: diagnostics.directory,
  };
  const summary = (): RuntimeSummary => ({ ...status, native: native.status() });
  let hasBeenReady = false;
  const update = (patch: Partial<RuntimeSummary>) => {
    const next = { ...status, ...patch };
    if (next.state !== "stopping" && next.state !== "attention") next.state = next.harnessConnected && next.workspaceConnected ? "ready" : hasBeenReady ? "reconnecting" : "starting";
    if (JSON.stringify(status) === JSON.stringify(next)) return;
    const becameReady = next.state === "ready" && status.state !== "ready";
    status = next;
    if (becameReady) { hasBeenReady = true; diagnostics.log("info", "runtime.available"); }
    onState({ ...status });
  };
  let closeInstance: (() => Promise<void>) | undefined;
  let bridgeTask: Promise<void> | undefined;
  let retryDisconnectedBridge: (() => void) | undefined;
  let nativeStarted = false;
  let tokenInFlight: Promise<string> | null = null;
  const token = (forceRefresh = false) => {
    tokenInFlight ??= (async () => {
      if (currentIdentityKey() !== config.identity) throw new AuthRequiredError("Runtime account changed; sign in to the original account");
      const value = await resolveAccessToken({ forceRefresh });
      if (!value) throw new AuthRequiredError();
      if (currentIdentityKey() !== config.identity) throw new AuthRequiredError("Runtime account changed");
      return value;
    })().finally(() => { tokenInFlight = null; });
    return tokenInFlight;
  };
  try {
    closeInstance = await ownRuntimeInstance(runtimeInstanceDirectory(config.identity, config.spaceId), summary, async (force) => {
      if (!force) for await (const batch of native.executor.results.pendingBatches()) {
        if (batch.length) throw new Error("Unconfirmed executions remain. Use down --yes to stop; results and files are retained");
      }
      update({ state: "stopping" });
      setTimeout(stop, 30);
    }, (action, message) => native.control(action, message));
    onState({ ...status });
    diagnostics.log("info", "runtime.cli_started", { platform: process.platform, node: process.versions.node, harnesses: config.harnesses });
    const [binary, capabilities] = await Promise.all([
      ensureSandboxdBinary({ onStatus: (message) => diagnostics.log("info", "sandboxd.download", { message }) }),
      config.capabilities ?? discoverHarnesses(config.harnesses, config.executables, config.root),
    ]);
    signal.throwIfAborted();
    const url = new URL(resolveWebsocketUrl()); url.pathname = url.pathname.replace(/\/ws$/, "/runtime/relay");
    const relay = new URL(url); relay.pathname = relay.pathname.replace(/\/runtime\/relay$/, "/sandbox/relay");

    const runBridge = async () => {
      let attempts = 0;
      while (!signal.aborted) {
        // A bridge may only register while this process owns the Harness lease.
        if (!status.harnessConnected) { await delay(500, undefined, { signal }).catch(() => undefined); continue; }
        const startedAt = Date.now();
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let probeTimer: ReturnType<typeof setTimeout> | undefined;
        let managed = false;
        let childStopped = false;
        let bridgeDisconnected = false;
        let terminating = false;
        let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
        let controlPipe: Awaited<ReturnType<typeof listenWindowsControlPipe>> | null = null;
        try {
          const initialToken = await token();
          signal.throwIfAborted();
          if (process.platform === "win32") controlPipe = await listenWindowsControlPipe();
          const bridge = spawn(binary, ["--local", "--space", config.spaceId, "--root", config.root, "--relay", process.env.COHUB_RELAY_URL?.trim() || relay.toString()], {
            stdio: controlPipe ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, COHUB_RELAY_TOKEN: initialToken, COHUB_RUNTIME_ID: status.runtimeId, COHUB_LOG_FORMAT: "json", COHUB_RUNTIME_MANAGED: "1", COHUB_DISPLAY: config.display ?? "", ...(controlPipe ? { COHUB_RUNTIME_CONTROL_PIPE: controlPipe.path } : {}) },
          });
          bridge.stdin?.on("error", () => undefined);
          const closed = new Promise<void>((resolve) => {
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            bridge.once("error", (error) => diagnostics.log("error", "sandboxd.process_error", { error: serializeDiagnosticError(error) }));
            bridge.once("exit", (code, exitSignal) => {
              childStopped = true;
              clearTimeout(recoveryTimer); recoveryTimer = undefined;
              if (!signal.aborted) diagnostics.log("warn", "sandboxd.process_exit", { code, signal: exitSignal });
              // Descendants may still hold inherited pipes. After draining buffered
              // output, close only our ends so supervision can continue.
              drainTimer = setTimeout(() => {
                diagnostics.log("warn", "sandboxd.stdio_drain_timeout");
                for (const stream of bridge.stdio) stream?.destroy();
              }, 1000);
            });
            bridge.once("close", () => {
              childStopped = true;
              clearTimeout(drainTimer);
              resolve();
            });
          });
          for (const streamName of ["stdout", "stderr"] as const) {
            const stream = bridge[streamName];
            if (!stream) continue;
            const lines = createInterface({ input: stream });
            lines.on("line", (line) => {
              let parsed: Record<string, unknown> | null = null;
              try {
                const value: unknown = JSON.parse(line);
                if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
              } catch { /* Compatibility with text loggers. */ }
              const data = parsed ? Object.fromEntries(Object.entries(parsed).filter(([key]) => !["msg", "level", "time"].includes(key))) : {};
              diagnostics.log(sandboxOutputLevel(parsed?.level, streamName), "sandboxd.log", { ...data, message: parsed?.msg ?? line }, { component: "sandboxd" });
            });
          }
          const control = controlPipe ? controlPipe.stream : bridge.stdio[3] as Readable;
          const events = createInterface({ input: control });
          events.on("line", (line) => {
            try {
              const event = JSON.parse(line);
              if (event.type === "hello") managed = true;
              if (event.type === "connected" || event.type === "disconnected") {
                const connected = event.type === "connected";
                bridgeDisconnected = !connected;
                update({ workspaceConnected: connected });
                diagnostics.log(connected ? "info" : "warn", `sandboxd.${event.type}`);
                retryDisconnectedBridge?.();
              }
            } catch { diagnostics.log("warn", "sandboxd.control_invalid"); }
          });
          const refresh = async () => {
            try {
              const next = await token();
              if (!childStopped && managed && !signal.aborted) bridge.stdin?.write(`${JSON.stringify({ type: "auth", token: next })}\n`);
            } catch (error) {
              diagnostics.log("warn", error instanceof AuthRequiredError ? "runtime.auth_required" : "runtime.auth_token_failed", { error: serializeDiagnosticError(error) });
            }
            if (!childStopped && !signal.aborted) refreshTimer = setTimeout(() => void refresh(), 10_000);
          };
          void refresh();
          // Released older sandboxd binaries do not have the private control pipe.
          // Ask the authoritative API instead of parsing human-readable log lines.
          const probe = async () => {
            if (!managed && !childStopped && !signal.aborted) {
              try {
                const remote = await space.getRuntime(undefined, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
                if (!childStopped && !managed) update({ workspaceConnected: remote.runtimeId === status.runtimeId && remote.workspace?.online === true });
              } catch { if (!childStopped && !managed) update({ workspaceConnected: false }); }
            }
            if (!childStopped && !signal.aborted && !managed) probeTimer = setTimeout(() => void probe(), 5000);
          };
          probeTimer = setTimeout(() => void probe(), 1000);
          const terminate = () => {
            if (terminating || childStopped) return;
            terminating = true;
            clearTimeout(recoveryTimer); recoveryTimer = undefined;
            // Windows has no SIGTERM; closing the managed stdin lets sandboxd stop gracefully.
            if (process.platform === "win32") bridge.stdin?.end();
            else bridge.kill("SIGTERM");
            const timeout = setTimeout(() => bridge.kill("SIGKILL"), 3000);
            void closed.finally(() => clearTimeout(timeout));
          };
          // A managed bridge may be sleeping for five minutes after a lease
          // rejection. Retry only after it reports a lost connection and the
          // Harness has regained its lease; a connected bridge stays untouched.
          retryDisconnectedBridge = () => {
            if (signal.aborted || !status.harnessConnected || !bridgeDisconnected || terminating || childStopped) {
              clearTimeout(recoveryTimer);
              recoveryTimer = undefined;
            } else if (!recoveryTimer) {
              // Give the bridge its normal retry and channel reattachment
              // window before replacing a process stuck in config backoff.
              recoveryTimer = setTimeout(() => {
                recoveryTimer = undefined;
                if (!signal.aborted && status.harnessConnected && bridgeDisconnected && !terminating && !childStopped) {
                  diagnostics.log("info", "sandboxd.lease_recovery");
                  terminate();
                }
              }, 30_000);
            }
          };
          signal.addEventListener("abort", terminate, { once: true });
          if (signal.aborted) terminate();
          await closed;
          signal.removeEventListener("abort", terminate);
        } catch (error) {
          if (!signal.aborted) diagnostics.log("warn", "sandboxd.restart_failed", { error: serializeDiagnosticError(error) });
        } finally {
          retryDisconnectedBridge = undefined;
          childStopped = true;
          controlPipe?.close();
          clearTimeout(refreshTimer); clearTimeout(probeTimer);
          clearTimeout(recoveryTimer);
          update({ workspaceConnected: false });
        }
        if (Date.now() - startedAt > 60_000) attempts = 0;
        const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6));
        await delay(backoff / 2 + Math.random() * backoff / 2, undefined, { signal }).catch(() => undefined);
      }
    };
    bridgeTask = runBridge();
    await native.start(signal);
    nativeStarted = true;
    let importRequested = Boolean(config.importHistory);
    await serveRuntime({
      spaceId: config.spaceId, cwd: config.root, url: url.toString(), capabilities,
      runtimeId: status.runtimeId, diagnostics, token, signal, executor: native.executor,
      onReady: () => { update({ harnessConnected: true }); retryDisconnectedBridge?.(); },
      onDisconnected: () => { native.connect(null); update({ harnessConnected: false }); retryDisconnectedBridge?.(); },
      onNativeStop: (stop) => { native.stop(stop.sessionId, stop.turnId); },
      onNativeChannel: (send) => {
        native.connect(send);
        if (!importRequested) return;
        importRequested = false;
        void native.control("import", { command: "start" }).catch((error: unknown) => diagnostics.log("warn", "native.import_failed", { error: serializeDiagnosticError(error) }));
      },
    });
  } catch (error) {
    if (!signal.aborted) {
      update({ state: "attention" });
      diagnostics.log("error", "runtime.failed", { error: serializeDiagnosticError(error) });
      throw error;
    }
  } finally {
    controller.abort();
    try {
      await bridgeTask;
      if (nativeStarted) await native.close(AbortSignal.timeout(5_000));
    } finally {
      try {
        await diagnostics.close();
      } finally {
        try {
          await closeInstance?.();
        } finally {
          process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
        }
      }
    }
  }
}
