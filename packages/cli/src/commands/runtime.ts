import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { json as outJson, jsonRequested } from "../output.js";
import { currentIdentityKey } from "../space.js";
import { resolveRuntimeTarget, runtimeUp, parseRuntimeHarnesses, type RuntimeUpOptions } from "../runtime/launch.js";
import { canonicalRuntimeRoot, getRuntimeSpaceBinding } from "../runtime/space-binding.js";
import { installNativeSync } from "../runtime/native-install.js";
import { discoverNativeImportCandidates, nativeRuntimeRoot, readNativeSyncConfig } from "../runtime/native-sync.js";
import { listNativeSyncStores } from "../runtime/native-sync-store.js";
import { requestNativeDaemon, type NativeIpcResponse } from "../runtime/native-ipc.js";
import { requestRuntimeInstance, runtimeInstanceDirectory } from "../runtime/instance.js";
import { atLeastLevel, diagnosticLevels, formatDiagnostic, formatNativeSync, printRuntimeSummary } from "../runtime/presentation.js";
import { RuntimeSessionStore } from "../runtime/session-store.js";
import { readRuntimeDiagnosticEvents, RuntimeDiagnosticReader, runtimeDiagnosticsDirectory, serializeDiagnosticError, type RuntimeDiagnosticLevel } from "../runtime/diagnostics.js";

export { resolveLocalSpaceName, parseRuntimeHarnesses } from "../runtime/launch.js";

const reportFailure = (cause: unknown) => {
  process.stderr.write(`Runtime failed: ${serializeDiagnosticError(cause).message}\n`);
  process.exitCode = 1;
};
type TargetOptions = { space?: string; json?: boolean };

export function applyNativeImportResponse(result: {
  imported: number;
  failed: Array<{ path: string; message: string }>;
  skipped: Array<{ path: string; message: string }>;
}, path: string, response: NativeIpcResponse): void {
  if (!response.ok) {
    if (response.skipped) {
      result.skipped.push({ path, message: response.message });
      return;
    }
    throw new Error(response.message);
  }
  result.imported += 1;
}

export function registerRuntime(program: Command) {
  const runtime = program.command("runtime").description("Connect a local workspace");
  runtime.command("up [dir]")
    .description("Connect local Harnesses and files")
    .option("-s, --space <id>", "Target Space")
    .option("-n, --new", "Create a new Space")
    .option("--name <name>", "New Space name")
    .option("-d, --detach", "Run in the background")
    .option("--harness <name>", "Pi or Codex; repeatable", (value: string, previous: string[]) => [...previous, value], [])
    .option("--pi <path>", "Pi executable")
    .option("--codex <path>", "Codex executable")
    .option("-y, --yes", "Accept defaults and authorize local execution and native sync")
    .option("--verbose", "Show diagnostic details")
    .option("--json", "JSON output")
    .action(async (dir: string | undefined, options: RuntimeUpOptions) => {
      try { await runtimeUp(program, dir, { ...options, json: jsonRequested(options) }); }
      catch (cause) { reportFailure(cause); }
    });

  runtime.command("detach")
    .description("Pause native sync; retain all receipts")
    .option("-s, --space <id>", "Target Space")
    .option("--harness <name>", "Pi or Codex; repeatable", (value: string, previous: string[]) => [...previous, value], [])
    .option("--json", "JSON output")
    .action(async (options: TargetOptions & { harness: string[] }) => {
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const identity = currentIdentityKey();
        if (!identity) throw new Error("Sign in first");
        const root = await canonicalRuntimeRoot(process.cwd());
        if ((await getRuntimeSpaceBinding(root, identity))?.spaceId !== spaceId) throw new Error("Bind this directory with runtime up first");
        const instance = await requestRuntimeInstance(runtimeInstanceDirectory(identity, spaceId));
        const harnesses = parseRuntimeHarnesses(options.harness.length ? options.harness : instance?.harnesses ?? ["pi", "codex"]);
        const result = await installNativeSync({ root, spaceId, identity, harnesses, disabled: true });
        if (jsonRequested(options)) outJson({ ...result, enabled: false });
        else process.stdout.write("Native sync paused; all local records retained\n");
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("import [dir]")
    .description("Import local conversations")
    .option("-s, --space <id>", "Target Space")
    .option("--harness <name>", "Filter by harness; repeatable", (value: string, previous: string[]) => [...previous, value], [])
    .option("--session <id>", "Filter by native session ID")
    .option("--dry-run", "Preview without importing")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async (dir: string | undefined, options: TargetOptions & { harness: string[]; session?: string; dryRun?: boolean; yes?: boolean }) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        const identity = currentIdentityKey();
        if (!identity) throw new Error("Sign in first");
        const root = await canonicalRuntimeRoot(dir ?? process.cwd());
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const binding = await getRuntimeSpaceBinding(root, identity);
        if (!binding || binding.spaceId !== spaceId) throw new Error("Bind this directory with runtime up first");
        const local = await requestRuntimeInstance(runtimeInstanceDirectory(identity, spaceId));
        if (!local) throw new Error("Local Runtime is not running");
        const config = await readNativeSyncConfig(nativeRuntimeRoot(spaceId), identity);
        if (!config || config.root !== root) throw new Error("Native sync is not enabled for this directory");
        const harnesses = parseRuntimeHarnesses(options.harness.length ? options.harness : config.harnesses);
        let lastProgress = 0;
        const discovered = await discoverNativeImportCandidates(root, harnesses, {
          signal: controller.signal,
          onProgress: ({ harness, scanned, candidates: found }) => {
            if (jsonRequested(options) || scanned - lastProgress < 25) return;
            lastProgress = scanned;
            process.stderr.write(`Scanned ${scanned} ${harness} transcript${scanned === 1 ? "" : "s"}; found ${found}\n`);
          },
        });
        const candidates = discovered.candidates.filter((candidate) => !options.session || candidate.nativeSessionId === options.session);
        const superseded = discovered.superseded.filter((skip) => !options.session || skip.nativeSessionId === options.session);
        const result = {
          spaceId, root, harnesses, candidates, errors: discovered.errors,
          imported: 0, pendingTurns: 0, failed: [] as Array<{ path: string; message: string }>, skipped: [] as Array<{ path: string; message: string }>, superseded, dryRun: Boolean(options.dryRun),
          complete: discovered.errors.length === 0 && superseded.length === 0,
        };
        if (jsonRequested(options) && options.dryRun) {
          result.complete = result.complete && result.failed.length === 0;
          outJson(result);
          if (!result.complete) process.exitCode = 1;
          return;
        }
        if (!candidates.length) {
          if (!result.complete) process.exitCode = 1;
          if (jsonRequested(options)) outJson(result);
          else {
            process.stdout.write("No existing native conversations found\n");
            for (const error of discovered.errors) process.stdout.write(`Skipped ${error.path}: ${error.message}\n`);
            for (const skip of superseded) process.stdout.write(`Superseded ${skip.path}: ${skip.message}\n`);
          }
          return;
        }
        if (options.dryRun) {
          if (jsonRequested(options)) outJson(result);
          else {
            process.stdout.write(`Found ${candidates.length} native conversation${candidates.length === 1 ? "" : "s"}\n`);
            for (const candidate of candidates) process.stdout.write(`  ${candidate.harness} ${candidate.nativeSessionId} ${candidate.turnCount} Turn${candidate.turnCount === 1 ? "" : "s"} ${candidate.path}\n`);
            for (const error of discovered.errors) process.stdout.write(`Skipped ${error.path}: ${error.message}\n`);
            for (const skip of superseded) process.stdout.write(`Superseded ${skip.path}: ${skip.message}\n`);
          }
          if (!result.complete) process.exitCode = 1;
          return;
        }
        if (!options.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes in non-interactive mode");
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await rl.question(`Import ${candidates.length} native conversation${candidates.length === 1 ? "" : "s"} to Space ${spaceId}? [Y/n] `);
            if (!/^(|y(es)?)$/i.test(answer.trim())) {
              if (jsonRequested(options)) outJson({ ...result, cancelled: true });
              else process.stdout.write("Import cancelled\n");
              return;
            }
          } finally { rl.close(); }
        }
        let processed = 0;
        for (const candidate of candidates) {
          if (controller.signal.aborted) break;
          try {
            const response = await requestNativeDaemon({ harness: candidate.harness, cwd: root, path: candidate.path, nativeSessionId: candidate.nativeSessionId,
              sessionStartedAt: candidate.sessionStartedAt, origin: "local_import", settled: true });
            applyNativeImportResponse(result, candidate.path, response);
            if (response.ok) result.pendingTurns += response.pendingTurns;
          } catch (error) {
            if (!controller.signal.aborted) result.failed.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error) });
          } finally {
            processed += 1;
            if (!jsonRequested(options) && !controller.signal.aborted) {
              process.stderr.write(`\rSubmitted ${result.imported}/${candidates.length} · pending ${result.pendingTurns} Turns`);
            }
          }
        }
        const cancelled = controller.signal.aborted;
        result.complete = result.complete && result.failed.length === 0 && !cancelled;
        if (jsonRequested(options)) outJson({ ...result, cancelled, processed });
        else {
          if (processed) process.stderr.write("\n");
          process.stdout.write(`Submitted ${result.imported}/${candidates.length} native conversation${candidates.length === 1 ? "" : "s"}${cancelled ? " (interrupted)" : ""}\n`);
          for (const error of [...discovered.errors, ...result.skipped, ...result.failed]) process.stdout.write(`Skipped ${error.path}: ${error.message}\n`);
          for (const skip of result.superseded) process.stdout.write(`Superseded ${skip.path}: ${skip.message}\n`);
          process.stdout.write("Uploads continue in the local Runtime background; use runtime status to check confirmation\n");
        }
        if (!result.complete && !cancelled) process.exitCode = 1;
      } catch (cause) { reportFailure(cause); }
      finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    });

  runtime.command("status").description("Local and server status")
    .option("-s, --space <id>", "Target Space")
    .option("--json", "JSON output")
    .action(async (options: TargetOptions) => {
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const identity = currentIdentityKey();
        const local = identity ? await requestRuntimeInstance(runtimeInstanceDirectory(identity, spaceId)) : null;
        const space = createClient().space(spaceId);
        const store = new RuntimeSessionStore(spaceId, { projectionSource: space, archiveTransport: null });
        const [remote, pendingLocalArchives, failedLocalArchives, nativeStores] = await Promise.all([
          space.getRuntime(undefined, { signal: AbortSignal.timeout(5000) }).then((value) => ({ value, error: null })).catch((error) => ({ value: null, error: serializeDiagnosticError(error).message })),
          store.archives.pendingCount(), store.archives.failedCaptureCount(),
          identity ? listNativeSyncStores(store.root, spaceId, identity) : [],
        ]);
        const nativeSessions = await Promise.all(nativeStores.map((native) => native.status()));
        // A corrupt native sync config must never take down the whole status report.
        const nativeSync = identity ? await readNativeSyncConfig(store.root, identity).then((config) => ({ config, error: null as string | null }), (error: unknown) => ({ config: null, error: serializeDiagnosticError(error).message })) : { config: null, error: null as string | null };
        const result = { ...remote.value, spaceId, local, remote: remote.value, remoteError: remote.error, diagnosticsPath: runtimeDiagnosticsDirectory(store.root), pendingLocalArchives, failedLocalArchives, nativeSync: nativeSync.config, nativeSyncError: nativeSync.error, nativeSessions };
        if (jsonRequested(options)) outJson(result);
        else {
          if (local) printRuntimeSummary(local);
          else process.stdout.write(`Local process  Not running\nSpace  ${spaceId}\nLogs  ${result.diagnosticsPath}\n`);
          process.stdout.write(`Server  ${remote.error ? `Unknown — ${remote.error}` : remote.value?.online ? "Harness connected" : "Offline"}\nArchives  ${pendingLocalArchives} pending · ${failedLocalArchives} failed\n`);
          process.stdout.write(formatNativeSync(nativeSync.config, nativeSessions, nativeSync.error));
        }
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("down").description("Stop this local Runtime; retain all data")
    .option("-s, --space <id>", "Target Space")
    .option("-y, --yes", "Stop even with unconfirmed executions")
    .option("--json", "JSON output")
    .action(async (options: TargetOptions & { yes?: boolean }) => {
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const identity = currentIdentityKey();
        if (!identity) throw new Error("Sign in to the Runtime account");
        const directory = runtimeInstanceDirectory(identity, spaceId);
        const local = await requestRuntimeInstance(directory, "stop", Boolean(options.yes));
        const until = Date.now() + 15_000;
        let running = Boolean(local);
        while (running && Date.now() < until) {
          await delay(250);
          try { running = Boolean(await requestRuntimeInstance(directory)); }
          catch { running = true; } // An unreachable control socket does not prove the process stopped.
        }
        if (running) throw new Error("Runtime is still stopping; inspect logs");
        if (jsonRequested(options)) outJson({ spaceId, stopped: true });
        else process.stdout.write("Runtime stopped; data retained\n");
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("logs").description("Read local Runtime diagnostics")
    .option("-s, --space <id>", "Target Space")
    .option("-l, --limit <count>", "Number of events", "100")
    .option("--level <level>", "Minimum level: debug, info, warn, error", "info")
    .option("-f, --follow", "Keep watching")
    .option("--json", "Raw diagnostic events")
    .action(async (options: TargetOptions & { limit: string; level: RuntimeDiagnosticLevel; follow?: boolean }) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const store = new RuntimeSessionStore(spaceId, { projectionSource: createClient().space(spaceId), archiveTransport: null });
        const limit = Number(options.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Use a limit from 1 to 10000");
        if (!diagnosticLevels.includes(options.level)) throw new Error("Use debug, info, warn or error");
        const asJson = jsonRequested(options);
        const reader = new RuntimeDiagnosticReader(store.root);
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        do {
          const events = (options.follow ? await reader.read({ limit }) : await readRuntimeDiagnosticEvents(store.root, { limit }))
            .filter((event) => atLeastLevel(event.level, options.level));
          if (asJson && !options.follow) outJson(events);
          else for (const event of events) process.stdout.write(asJson ? `${JSON.stringify(event)}\n` : formatDiagnostic(event, true));
          if (!options.follow) {
            if (!asJson && !events.length) process.stdout.write("No matching diagnostics\n");
            break;
          }
          await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
        } while (!controller.signal.aborted);
      } catch (cause) { reportFailure(cause); }
      finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    });
}
