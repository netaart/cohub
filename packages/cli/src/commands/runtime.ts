import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { json as outJson, jsonRequested } from "../output.js";
import { currentIdentityKey } from "../space.js";
import { resolveRuntimeTarget, runtimeUp, parseRuntimeHarnesses, type RuntimeUpOptions } from "../runtime/launch.js";
import { canonicalRuntimeRoot, getRuntimeSpaceBinding } from "../runtime/space-binding.js";
import { installNativeSync } from "../runtime/native-install.js";
import { listNativeSyncStores } from "../runtime/native-sync-store.js";
import { requestRuntimeInstance, runtimeInstanceDirectory } from "../runtime/instance.js";
import { atLeastLevel, diagnosticLevels, formatDiagnostic, printRuntimeSummary } from "../runtime/presentation.js";
import { RuntimeSessionStore } from "../runtime/session-store.js";
import { readRuntimeDiagnosticEvents, RuntimeDiagnosticReader, runtimeDiagnosticsDirectory, serializeDiagnosticError, type RuntimeDiagnosticLevel } from "../runtime/diagnostics.js";

export { resolveLocalSpaceName, parseRuntimeHarnesses } from "../runtime/launch.js";

const reportFailure = (cause: unknown) => {
  process.stderr.write(`Runtime failed / Runtime 失败: ${serializeDiagnosticError(cause).message}\n`);
  process.exitCode = 1;
};
type TargetOptions = { space?: string; json?: boolean };

export function registerRuntime(program: Command) {
  const runtime = program.command("runtime").description("Connect a local workspace / 连接本地工作区");
  runtime.command("up [dir]")
    .description("Connect local Harnesses and files / 连接本地 Harness 和文件")
    .option("-s, --space <id>", "Target Space / 目标 Space")
    .option("-n, --new", "Create a new Space / 创建新 Space")
    .option("--name <name>", "New Space name / 新 Space 名称")
    .option("-d, --detach", "Run in the background / 后台运行")
    .option("--harness <name>", "Pi or Codex; repeatable / 可重复指定", (value: string, previous: string[]) => [...previous, value], [])
    .option("--pi <path>", "Pi executable / Pi 可执行文件")
    .option("--codex <path>", "Codex executable / Codex 可执行文件")
    .option("-y, --yes", "Accept defaults and local execution / 接受默认选择并授权本地执行")
    .option("--verbose", "Show diagnostic details / 显示诊断详情")
    .option("--json", "JSON output / JSON 输出")
    .action(async (dir: string | undefined, options: RuntimeUpOptions) => {
      try { await runtimeUp(program, dir, { ...options, json: jsonRequested(options) }); }
      catch (cause) { reportFailure(cause); }
    });

  for (const action of ["attach", "detach"] as const) runtime.command(action)
    .description(action === "attach" ? "Sync native Pi / Codex Turns / 同步原生 Pi / Codex 对话" : "Pause native sync; retain all receipts / 暂停原生同步，保留所有回执")
    .option("-s, --space <id>", "Target Space / 目标 Space")
    .option("--harness <name>", "Pi or Codex; repeatable / 可重复指定", (value: string, previous: string[]) => [...previous, value], [])
    .option("--pi <path>", "Pi executable for capability checks / 用于能力检查的 Pi 路径")
    .option("--codex <path>", "Codex executable for capability checks / 用于能力检查的 Codex 路径")
    .option("-y, --yes", "Authorize project conversation and native archive uploads / 授权上传项目对话及原生归档")
    .option("--json", "JSON output / JSON 输出")
    .action(async (options: TargetOptions & { harness: string[]; yes?: boolean; pi?: string; codex?: string }) => {
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const identity = currentIdentityKey();
        if (!identity) throw new Error("Sign in first / 请先登录");
        const root = await canonicalRuntimeRoot(process.cwd());
        if (action === "attach" && (await getRuntimeSpaceBinding(root, identity))?.spaceId !== spaceId) throw new Error("Bind this directory with runtime up --space first / 请先使用 runtime up --space 绑定当前目录");
        const instance = await requestRuntimeInstance(runtimeInstanceDirectory(identity, spaceId));
        if (action === "attach" && (!instance || instance.root !== root)) throw new Error("Start this directory's Runtime first: cohub runtime up -d / 请先启动当前目录的 Runtime");
        if (action === "attach" && !instance?.nativeSync) throw new Error("Restart the Runtime with this CLI before attaching / 请先使用新版 CLI 重启 Runtime，再接入原生客户端");
        const harnesses = parseRuntimeHarnesses(options.harness.length ? options.harness : instance?.harnesses ?? ["pi", "codex"]);
        if (action === "attach" && harnesses.some((harness) => !instance?.harnesses.includes(harness))) throw new Error("Enable these Harnesses with runtime up first / 请先通过 runtime up 启用对应 Harness");
        if (action === "attach" && !options.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes to authorize native sync / 请使用 --yes 授权原生同步");
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await rl.question(`Install user-level ${harnesses.join(" / ")} integration and upload this project's opened conversations, tool output and raw archives to this Space? History may contain secrets. [y/N]\n安装用户级原生集成，并将当前项目打开的对话、工具输出和原始归档上传至此 Space？历史可能包含敏感信息。[y/N] `);
            if (!/^y(es)?$/i.test(answer.trim())) return;
          } finally { rl.close(); }
        }
        const result = await installNativeSync({ root, spaceId, identity, harnesses, disabled: action === "detach", executables: { pi: options.pi, codex: options.codex } });
        if (jsonRequested(options)) outJson(result);
        else process.stdout.write(action === "attach"
          ? `Native sync enabled. Reload Pi or restart Codex and review its hook trust prompt. / 原生同步已启用。请重载 Pi 或重启 Codex，并审核 Hook 信任提示。\n${result.configPath}\n`
          : "Native sync paused; all local records retained / 原生同步已暂停，所有本地记录已保留\n");
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("status").description("Local and server status / 本地与服务端状态")
    .option("-s, --space <id>", "Target Space / 目标 Space")
    .option("--json", "JSON output / JSON 输出")
    .action(async (options: TargetOptions) => {
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const identity = currentIdentityKey();
        const local = identity ? await requestRuntimeInstance(runtimeInstanceDirectory(identity, spaceId)) : null;
        const space = createClient().space(spaceId);
        const store = new RuntimeSessionStore(spaceId, { projectionSource: space });
        const [remote, pendingLocalArchives, failedLocalArchives, nativeStores] = await Promise.all([
          space.getRuntime(undefined, { signal: AbortSignal.timeout(5000) }).then((value) => ({ value, error: null })).catch((error) => ({ value: null, error: serializeDiagnosticError(error).message })),
          store.archives.pendingCount(), store.archives.failedCaptureCount(),
          identity ? listNativeSyncStores(store.root, spaceId, identity) : [],
        ]);
        const nativeSessions = await Promise.all(nativeStores.map((native) => native.status()));
        const result = { ...remote.value, spaceId, local, remote: remote.value, remoteError: remote.error, diagnosticsPath: runtimeDiagnosticsDirectory(store.root), pendingLocalArchives, failedLocalArchives, nativeSessions };
        if (jsonRequested(options)) outJson(result);
        else {
          if (local) printRuntimeSummary(local);
          else process.stdout.write(`Local process / 本地进程  Not running / 未运行\nSpace / 空间  ${spaceId}\nLogs / 日志  ${result.diagnosticsPath}\n`);
          process.stdout.write(`Server / 服务端  ${remote.error ? `Unknown / 未知 — ${remote.error}` : remote.value?.online ? "Harness connected / Harness 已连接" : "Offline / 离线"}\nArchives / 归档  ${pendingLocalArchives} pending / 待同步 · ${failedLocalArchives} failed / 失败\n`);
          if (nativeSessions.length) process.stdout.write(`Native chats / 原生对话  ${nativeSessions.length} · ${nativeSessions.reduce((sum, session) => sum + session.pendingTurns, 0)} Turns pending / Turn 待同步 · ${nativeSessions.reduce((sum, session) => sum + session.pendingArchives, 0)} archives pending / 归档待同步\n`);
        }
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("down").description("Stop this local Runtime; retain all data / 停止本地 Runtime，保留所有数据")
    .option("-s, --space <id>", "Target Space / 目标 Space")
    .option("-y, --yes", "Stop even with unconfirmed executions / 确认停止包含未确认执行的 Runtime")
    .option("--json", "JSON output / JSON 输出")
    .action(async (options: TargetOptions & { yes?: boolean }) => {
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const identity = currentIdentityKey();
        if (!identity) throw new Error("Sign in to the Runtime account / 请登录 Runtime 所属账号");
        const directory = runtimeInstanceDirectory(identity, spaceId);
        const local = await requestRuntimeInstance(directory, "stop", Boolean(options.yes));
        const until = Date.now() + 15_000;
        let running = Boolean(local);
        while (running && Date.now() < until) {
          await delay(250);
          try { running = Boolean(await requestRuntimeInstance(directory)); }
          catch { running = true; } // An unreachable control socket does not prove the process stopped.
        }
        if (running) throw new Error("Runtime is still stopping; inspect logs / Runtime 仍在停止，请检查日志");
        if (jsonRequested(options)) outJson({ spaceId, stopped: true });
        else process.stdout.write("Runtime stopped; data retained / Runtime 已停止，数据已保留\n");
      } catch (cause) { reportFailure(cause); }
    });

  runtime.command("logs").description("Read local Runtime diagnostics / 查看本地 Runtime 日志")
    .option("-s, --space <id>", "Target Space / 目标 Space")
    .option("-l, --limit <count>", "Number of events / 事件数量", "100")
    .option("--level <level>", "Minimum level: debug, info, warn, error / 最低级别", "info")
    .option("-f, --follow", "Keep watching / 持续查看")
    .option("--json", "Raw diagnostic events / 原始诊断事件")
    .action(async (options: TargetOptions & { limit: string; level: RuntimeDiagnosticLevel; follow?: boolean }) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      try {
        const spaceId = await resolveRuntimeTarget(program, options.space);
        const store = new RuntimeSessionStore(spaceId, { projectionSource: createClient().space(spaceId) });
        const limit = Number(options.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Use a limit from 1 to 10000 / 数量范围为 1 到 10000");
        if (!diagnosticLevels.includes(options.level)) throw new Error("Use debug, info, warn or error / 请使用有效日志级别");
        const asJson = jsonRequested(options);
        const reader = new RuntimeDiagnosticReader(store.root);
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        do {
          const events = (options.follow ? await reader.read({ limit }) : await readRuntimeDiagnosticEvents(store.root, { limit }))
            .filter((event) => atLeastLevel(event.level, options.level));
          if (asJson && !options.follow) outJson(events);
          else for (const event of events) process.stdout.write(asJson ? `${JSON.stringify(event)}\n` : formatDiagnostic(event, true));
          if (!options.follow) {
            if (!asJson && !events.length) process.stdout.write("No matching diagnostics / 未找到匹配日志\n");
            break;
          }
          await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
        } while (!controller.signal.aborted);
      } catch (cause) { reportFailure(cause); }
      finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    });
}
