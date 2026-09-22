import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import { resolveWebsocketUrl, type RuntimeCapabilities } from "@neta-art/cohub";
import { AuthRequiredError, resolveAccessToken } from "../auth.js";
import { createClient } from "../client.js";
import { currentIdentityKey } from "../space.js";
import { ensureSandboxdBinary } from "../commands/sandboxd-binary.js";
import { serveRuntime } from "./connection.js";
import { discoverHarnesses, type HarnessOptions } from "./harness.js";
import { RuntimeDiagnostics, serializeDiagnosticError, type RuntimeDiagnostic, type RuntimeDiagnosticLevel } from "./diagnostics.js";
import { ownRuntimeInstance, runtimeInstanceDirectory } from "./instance.js";
import { createDiagnosticConsole, type RuntimeSummary } from "./presentation.js";
import { RuntimeSessionStore } from "./session-store.js";
import { captureNativeSession, flushNativeSessions, nativeWebSocketTransport } from "./native-sync.js";
import type { NativeRuntimeEvent } from "@neta-art/cohub";
import { serveNativeDaemon } from "./native-ipc.js";

export type RuntimeLaunch = {
  spaceId: string;
  root: string;
  identity: string;
  harnesses: ("pi" | "codex")[];
  executables: HarnessOptions;
  capabilities?: RuntimeCapabilities;
  background: boolean;
  verbose?: boolean;
};

export function sandboxOutputLevel(value: unknown, stream: "stdout" | "stderr"): RuntimeDiagnosticLevel {
  const level = typeof value === "string" ? value.toLowerCase() : "";
  if (["debug", "info", "warn", "error"].includes(level)) return level as RuntimeDiagnosticLevel;
  return stream === "stderr" ? "warn" : "debug";
}

export async function runRuntime(config: RuntimeLaunch, onState: (status: RuntimeSummary) => void, externalSignal?: AbortSignal, onDiagnostic?: (event: RuntimeDiagnostic) => void) {
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const client = createClient();
  const space = client.space(config.spaceId);
  const store = new RuntimeSessionStore(config.spaceId, { projectionSource: space });
  const consoleSink = config.background ? undefined : createDiagnosticConsole(config.verbose);
  const diagnostics = new RuntimeDiagnostics({
    root: store.root, spaceId: config.spaceId, runtimeId: randomUUID(),
    onEvent: (event) => { consoleSink?.(event); onDiagnostic?.(event); },
  });
  store.setDiagnostics(diagnostics);
  let status: RuntimeSummary = {
    spaceId: config.spaceId, root: config.root, runtimeId: diagnostics.runtimeId,
    pid: process.pid, harnesses: config.harnesses, background: config.background,
    state: "starting", harnessConnected: false, workspaceConnected: false,
    diagnosticsPath: diagnostics.directory,
    nativeSync: true,
  };
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
  let nativeSyncTask: Promise<void> | undefined;
  let closeNativeDaemon: (() => Promise<void>) | undefined;
  let nativeSend: ((event: NativeRuntimeEvent) => Promise<unknown>) | null = null;
  let tokenInFlight: Promise<string> | null = null;
  const token = (forceRefresh = false) => {
    tokenInFlight ??= (async () => {
      if (currentIdentityKey() !== config.identity) throw new AuthRequiredError("Runtime account changed; sign in to the original account / Runtime 账号已变化，请登录原账号");
      const value = await resolveAccessToken({ forceRefresh });
      if (!value) throw new AuthRequiredError();
      if (currentIdentityKey() !== config.identity) throw new AuthRequiredError("Runtime account changed / Runtime 账号已变化");
      return value;
    })().finally(() => { tokenInFlight = null; });
    return tokenInFlight;
  };
  try {
    closeInstance = await ownRuntimeInstance(runtimeInstanceDirectory(config.identity, config.spaceId), () => status, async (force) => {
      if (!force) for await (const batch of store.pendingExecutionBatches()) {
        if (batch.length) throw new Error("Unconfirmed executions remain. Use down --yes to stop; results and files are retained / 尚有未确认执行，使用 down --yes 停止；结果和文件会保留");
      }
      update({ state: "stopping" });
      setTimeout(stop, 30);
    });
    onState({ ...status });
    diagnostics.log("info", "runtime.cli_started", { platform: process.platform, node: process.versions.node, harnesses: config.harnesses });
    const [binary, capabilities] = await Promise.all([
      ensureSandboxdBinary({ onStatus: (message) => diagnostics.log("info", "sandboxd.download", { message }) }),
      config.capabilities ?? discoverHarnesses(config.harnesses, config.executables, config.root),
    ]);
    signal.throwIfAborted();
    const url = new URL(resolveWebsocketUrl({ url: process.env.COHUB_WS_URL })); url.pathname = "/runtime/relay";
    const relay = new URL(url); relay.pathname = "/sandbox/relay";

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
        try {
          const initialToken = await token();
          signal.throwIfAborted();
          const bridge = spawn(binary, ["--local", "--space", config.spaceId, "--root", config.root, "--relay", process.env.COHUB_RELAY_URL?.trim() || relay.toString()], {
            stdio: ["pipe", "pipe", "pipe", "pipe"],
            env: { ...process.env, COHUB_RELAY_TOKEN: initialToken, COHUB_RUNTIME_ID: status.runtimeId, COHUB_LOG_FORMAT: "json", COHUB_RUNTIME_MANAGED: "1" },
          });
          bridge.stdin?.on("error", () => undefined);
          const closed = new Promise<void>((resolve) => {
            bridge.once("error", (error) => diagnostics.log("error", "sandboxd.process_error", { error: serializeDiagnosticError(error) }));
            bridge.once("close", (code, exitSignal) => {
              childStopped = true;
              if (!signal.aborted) diagnostics.log("warn", "sandboxd.process_exit", { code, signal: exitSignal });
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
          const control = bridge.stdio[3] as Readable;
          const events = createInterface({ input: control });
          events.on("line", (line) => {
            try {
              const event = JSON.parse(line);
              if (event.type === "hello") managed = true;
              if (event.type === "connected" || event.type === "disconnected") {
                const connected = event.type === "connected";
                update({ workspaceConnected: connected });
                diagnostics.log(connected ? "info" : "warn", `sandboxd.${event.type}`);
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
            bridge.kill("SIGTERM");
            const timeout = setTimeout(() => bridge.kill("SIGKILL"), 3000);
            void closed.finally(() => clearTimeout(timeout));
          };
          signal.addEventListener("abort", terminate, { once: true });
          if (signal.aborted) terminate();
          await closed;
          signal.removeEventListener("abort", terminate);
        } catch (error) {
          if (!signal.aborted) diagnostics.log("warn", "sandboxd.restart_failed", { error: serializeDiagnosticError(error) });
        } finally {
          childStopped = true;
          clearTimeout(refreshTimer); clearTimeout(probeTimer);
          update({ workspaceConnected: false });
        }
        if (Date.now() - startedAt > 60_000) attempts = 0;
        const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6));
        await delay(backoff / 2 + Math.random() * backoff / 2, undefined, { signal }).catch(() => undefined);
      }
    };
    bridgeTask = runBridge();
    closeNativeDaemon = await serveNativeDaemon({ runtimeRoot: store.root, handle: async (request) => ({
      store: await captureNativeSession(request),
    }) });
    nativeSyncTask = (async () => {
      const report = (error: unknown) => diagnostics.log("warn", "native.sync_pending", { error: serializeDiagnosticError(error) });
      while (!signal.aborted) {
        try {
          if (nativeSend) await flushNativeSessions(config.spaceId, config.identity, signal, report, nativeWebSocketTransport(config.spaceId, config.identity, nativeSend));
        }
        catch (error) { if (!signal.aborted) report(error); }
        await delay(5000, undefined, { signal }).catch(() => undefined);
      }
    })();
    await serveRuntime({
      spaceId: config.spaceId, cwd: config.root, url: url.toString(), capabilities,
      harnesses: config.executables, runtimeId: status.runtimeId, diagnostics, token, signal, store,
      onReady: () => update({ harnessConnected: true }),
      onDisconnected: () => { nativeSend = null; update({ harnessConnected: false }); },
      onNativeChannel: (send) => { nativeSend = send; },
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
      await Promise.all([bridgeTask, nativeSyncTask]);
      await closeNativeDaemon?.();
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
