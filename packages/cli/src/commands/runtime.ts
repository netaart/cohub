import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { json as outJson, jsonRequested } from "../output.js";
import { currentIdentityKey } from "../space.js";
import { resolveRuntimeTarget, runtimeUp, parseRuntimeHarnesses, type RuntimeUpOptions } from "../runtime/launch.js";
import { canonicalRuntimeRoot, getRuntimeSpaceBinding } from "../runtime/space-binding.js";
import { join } from "node:path";
import { RuntimeArchiveStore } from "../runtime/archive-store.js";
import { readNativeConfig, runtimeStateRoot, writeNativeConfig } from "../runtime/native/config.js";
import type { NativeStatus } from "../runtime/native/daemon.js";
import { MAX_IMPORT_CONCURRENCY, DEFAULT_IMPORT_CONCURRENCY, type ImportJob } from "../runtime/native/ingest.js";
import { installPiExtension, piExtensionState } from "../runtime/native/install.js";
import { controlRuntimeInstance, requestRuntimeInstance, runtimeInstanceDirectory } from "../runtime/instance.js";
import { atLeastLevel, diagnosticLevels, formatDiagnostic, formatImportProgress, formatNativeSync, printRuntimeSummary } from "../runtime/presentation.js";
import { readRuntimeDiagnosticEvents, RuntimeDiagnosticReader, runtimeDiagnosticsDirectory, serializeDiagnosticError, type RuntimeDiagnosticLevel } from "../runtime/diagnostics.js";

export { resolveLocalSpaceName, parseRuntimeHarnesses } from "../runtime/launch.js";

const reportFailure = (cause: unknown) => {
  process.stderr.write(`Runtime failed: ${serializeDiagnosticError(cause).message}\n`);
  process.exitCode = 1;
};
type TargetOptions = { space?: string; json?: boolean };

type ImportPlan = { files: number; bytes: number; sample: Array<{ harness: string; path: string; nativeSessionId?: string; mtimeMs: number; size: number }> };
type ImportStatus = NativeStatus["import"];

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The bound Space of a directory, with its running Runtime; import and attach act through it. */
async function boundRuntime(program: Command, dir: string | undefined, space: string | undefined) {
  const identity = currentIdentityKey();
  if (!identity) throw new Error("Sign in first");
  const root = await canonicalRuntimeRoot(dir ?? process.cwd());
  const spaceId = await resolveRuntimeTarget(program, space);
  const binding = await getRuntimeSpaceBinding(root, identity);
  if (!binding || binding.spaceId !== spaceId) throw new Error("Bind this directory with runtime up first");
  return { identity, root, spaceId, directory: runtimeInstanceDirectory(identity, spaceId) };
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

  runtime.command("attach")
    .description("Connect native harnesses to Cohub: install the Pi extension")
    .option("-s, --space <id>", "Target Space")
    .option("--harness <name>", "Pi; repeatable", (value: string, previous: string[]) => [...previous, value], [])
    .option("--json", "JSON output")
    .action(async (options: TargetOptions & { harness: string[] }) => {
      try {
        const harnesses = parseRuntimeHarnesses(options.harness.length ? options.harness : ["pi"]);
        if (!harnesses.includes("pi")) throw new Error("Codex needs no extension; runtime up offers its shared app-server");
        const before = await piExtensionState();
        if (before === "foreign") throw new Error("A Pi extension named cohub exists and is not managed by Cohub; move it aside, then retry");
        await installPiExtension();
        const spaceId = await resolveRuntimeTarget(program, options.space).catch(() => null);
        const identity = currentIdentityKey();
        if (spaceId && identity) await controlRuntimeInstance(runtimeInstanceDirectory(identity, spaceId), "reload").catch(() => undefined);
        if (jsonRequested(options)) outJson({ harness: "pi", extension: "installed", updated: before !== "installed" });
        else process.stdout.write(before === "installed" ? "Pi extension is up to date\n" : "Pi extension installed. Run /reload in open Pi sessions to connect them\n");
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("detach")
    .description("Pause native sync; keep all data")
    .option("-s, --space <id>", "Target Space")
    .option("--harness <name>", "Pi or Codex; repeatable", (value: string, previous: string[]) => [...previous, value], [])
    .option("--json", "JSON output")
    .action(async (options: TargetOptions & { harness: string[] }) => {
      try {
        const { identity, spaceId, directory } = await boundRuntime(program, undefined, options.space);
        const stateRoot = runtimeStateRoot(spaceId);
        const config = await readNativeConfig(stateRoot, identity);
        const paused = parseRuntimeHarnesses(options.harness.length ? options.harness : config?.harnesses ?? ["pi", "codex"]);
        const harnesses = (config?.harnesses ?? []).filter((harness) => !paused.includes(harness));
        if (config) await writeNativeConfig(stateRoot, { ...config, harnesses, codexShared: harnesses.includes("codex") && config.codexShared });
        await controlRuntimeInstance(directory, "reload").catch(() => undefined);
        const codexWasShared = Boolean(config?.codexShared) && paused.includes("codex");
        if (jsonRequested(options)) outJson({ spaceId, harnesses, paused, enabled: harnesses.length > 0 });
        else {
          process.stdout.write(harnesses.length ? `Native sync paused for ${paused.join(", ")}; still syncing ${harnesses.join(", ")}\n` : "Native sync paused; all data retained\n");
          // Cohub never stops a server that terminal clients may be attached to.
          if (codexWasShared) process.stdout.write("Codex's shared app-server keeps running; stop it with codex app-server daemon stop\n");
        }
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("import [dir]")
    .description("Import earlier local conversations, newest first")
    .option("-s, --space <id>", "Target Space")
    .option("--harness <name>", "Filter by harness; repeatable", (value: string, previous: string[]) => [...previous, value], [])
    .option("--session <id>", "Filter by native session ID")
    .option("--concurrency <count>", `Conversations read in parallel, 1 to ${MAX_IMPORT_CONCURRENCY}`, String(DEFAULT_IMPORT_CONCURRENCY))
    .option("--dry-run", "Preview without importing")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async (dir: string | undefined, options: TargetOptions & { harness: string[]; session?: string; concurrency: string; dryRun?: boolean; yes?: boolean }) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      const asJson = jsonRequested(options);
      try {
        const concurrency = Number(options.concurrency);
        if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_IMPORT_CONCURRENCY) throw new Error(`Use a concurrency from 1 to ${MAX_IMPORT_CONCURRENCY}`);
        const { spaceId, root, directory } = await boundRuntime(program, dir, options.space);
        // The Runtime does the work, so an import survives this command: Ctrl-C only pauses it.
        const filter = { harnesses: options.harness.length ? parseRuntimeHarnesses(options.harness) : [], ...(options.session ? { nativeSessionId: options.session } : {}) };
        const control = async <T>(command: string, timeoutMs = 60_000) => {
          const response = await controlRuntimeInstance(directory, "import", { ...filter, command, concurrency }, timeoutMs);
          if (!response) throw new Error("Local Runtime is not running; start it with cohub runtime up");
          return response.result as T;
        };
        const plan = await control<ImportPlan>("plan");
        const summary = { spaceId, root, ...plan, dryRun: Boolean(options.dryRun) };
        if (options.dryRun || !plan.files) {
          if (asJson) outJson(summary);
          else if (!plan.files) process.stdout.write("No earlier conversations left to import\n");
          else {
            process.stdout.write(`Found ${plan.files} conversation${plan.files === 1 ? "" : "s"} · ${megabytes(plan.bytes)}\n`);
            for (const item of plan.sample) process.stdout.write(`  ${item.harness.padEnd(5)} ${new Date(item.mtimeMs).toISOString().slice(0, 16).replace("T", " ")}  ${item.nativeSessionId ?? ""}  ${item.path}\n`);
            if (plan.files > plan.sample.length) process.stdout.write(`  … and ${plan.files - plan.sample.length} more\n`);
          }
          return;
        }
        if (!options.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes in non-interactive mode");
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await rl.question(`Import ${plan.files} conversation${plan.files === 1 ? "" : "s"} (${megabytes(plan.bytes)}) to Space ${spaceId}? [Y/n] `);
            if (!/^(|y(es)?)$/i.test(answer.trim())) {
              if (asJson) outJson({ ...summary, cancelled: true });
              else process.stdout.write("Import cancelled\n");
              return;
            }
          } finally { rl.close(); }
        }
        let job = await control<ImportJob>("start");
        while (!controller.signal.aborted && job.state === "running") {
          if (!asJson && process.stderr.isTTY) process.stderr.write(`\r\x1b[2KImporting ${formatImportProgress(job as ImportStatus)}`);
          await delay(500, undefined, { signal: controller.signal }).catch(() => undefined);
          const status = await requestRuntimeInstance(directory);
          if (!status?.native) throw new Error("Local Runtime stopped; the import resumes when it starts again");
          job = status.native.import;
        }
        if (controller.signal.aborted) job = await control<ImportJob>("pause", 5_000);
        const paused = job.state === "paused";
        if (asJson) outJson({ ...summary, ...job, paused });
        else {
          if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
          process.stdout.write(`${paused ? "Paused" : "Imported"} ${formatImportProgress(job as ImportStatus)}\n`);
          for (const failure of job.failed) process.stdout.write(`Skipped ${failure.path}: ${failure.message}\n`);
          if (paused) process.stdout.write("Run cohub runtime import again to continue\n");
        }
        if (job.failed.length) process.exitCode = 1;
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
        const stateRoot = runtimeStateRoot(spaceId);
        const archives = new RuntimeArchiveStore(join(stateRoot, "archives"));
        const [remote, pendingLocalArchives, failedLocalArchives] = await Promise.all([
          space.getRuntime(undefined, { signal: AbortSignal.timeout(5000) }).then((value) => ({ value, error: null })).catch((error) => ({ value: null, error: serializeDiagnosticError(error).message })),
          archives.pendingCount(), archives.failedCaptureCount(),
        ]);
        // A corrupt native sync config must never take down the whole status report.
        const nativeSync = identity ? await readNativeConfig(stateRoot, identity).then((config) => ({ config, error: null as string | null }), (error: unknown) => ({ config: null, error: serializeDiagnosticError(error).message })) : { config: null, error: null as string | null };
        const result = { ...remote.value, spaceId, local, remote: remote.value, remoteError: remote.error, diagnosticsPath: runtimeDiagnosticsDirectory(stateRoot), pendingLocalArchives, failedLocalArchives, nativeSync: nativeSync.config, nativeSyncError: nativeSync.error, native: local?.native ?? null };
        if (jsonRequested(options)) outJson(result);
        else {
          if (local) printRuntimeSummary(local);
          else process.stdout.write(`Local process  Not running\nSpace  ${spaceId}\nLogs  ${result.diagnosticsPath}\n`);
          process.stdout.write(`Server  ${remote.error ? `Unknown — ${remote.error}` : remote.value?.online ? "Harness connected" : "Offline"}\nArchives  ${pendingLocalArchives} pending · ${failedLocalArchives} failed\n`);
          process.stdout.write(formatNativeSync(nativeSync.config, local?.native, nativeSync.error));
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
        else {
          process.stdout.write("Runtime stopped; data retained\n");
          // Terminal clients may still be attached to it, so it is never stopped for them.
          if (local?.native?.codex?.control === "shared") process.stdout.write("Codex's shared app-server keeps running; stop it with codex app-server daemon stop\n");
        }
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
        const stateRoot = runtimeStateRoot(spaceId);
        const limit = Number(options.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Use a limit from 1 to 10000");
        if (!diagnosticLevels.includes(options.level)) throw new Error("Use debug, info, warn or error");
        const asJson = jsonRequested(options);
        const reader = new RuntimeDiagnosticReader(stateRoot);
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        do {
          const events = (options.follow ? await reader.read({ limit }) : await readRuntimeDiagnosticEvents(stateRoot, { limit }))
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
