import { resolveCohubEnvironment } from "@neta-art/cohub";
import type { RuntimeDiagnostic, RuntimeDiagnosticLevel } from "./diagnostics.js";

export const diagnosticLevels: RuntimeDiagnosticLevel[] = ["debug", "info", "warn", "error"];
export const atLeastLevel = (level: RuntimeDiagnosticLevel, minimum: RuntimeDiagnosticLevel) =>
  diagnosticLevels.indexOf(level) >= diagnosticLevels.indexOf(minimum);
export const runtimeWebUrl = (spaceId: string) =>
  `https://${resolveCohubEnvironment() === "prod" ? "" : "dev."}cohub.live/spaces/${spaceId}`;

const messages: Record<string, string> = {
  "runtime.ready": "Harness connected / Harness 已连接",
  "runtime.available": "Runtime ready / Runtime 已就绪",
  "runtime.websocket.closed": "Connection lost; reconnecting / 连接中断，正在重连",
  "runtime.heartbeat_timeout": "Connection timed out; reconnecting / 连接超时，正在重连",
  "runtime.auth_token_failed": "Cannot obtain credentials; retrying / 暂时无法获取凭证，正在重试",
  "runtime.auth_required": "Sign in with cohub auth login / 请运行 cohub auth login 登录",
  "runtime.stopped": "Runtime stopped / Runtime 已停止",
  "runtime.failed": "Runtime needs attention / Runtime 需要处理",
  "runtime.turn_failed": "Turn failed; local files retained / 执行失败，本地文件已保留",
  "runtime.connection_failed": "Connection attempt failed; retrying / 连接失败，将继续重试",
  "runtime.execution_transport_lost": "Execution disconnected; outcome needs reconciliation / 执行连接中断，结果待确认",
  "archive.upload_pending": "Archive upload pending; local data retained / 归档待上传，本地数据已保留",
  "native.sync_pending": "Native sync pending; local records retained / 原生同步待处理，本地记录已保留",
  "archive.capture_pending": "Archive capture pending / 归档待处理",
  "archive.capture_unavailable": "Archive unavailable; original receipt retained / 归档不可用，原始回执已保留",
  "archive.restore_failed": "Native restore unavailable; using saved history / 原生恢复不可用，使用已保存历史",
  "sandboxd.process_exit": "File bridge stopped; restarting / 文件桥接已退出，正在重启",
  "sandboxd.download": "Preparing file bridge / 正在准备文件桥接",
  "sandboxd.connected": "File bridge connected / 文件桥接已连接",
  "sandboxd.disconnected": "File bridge disconnected; reconnecting / 文件桥接已断开，正在重连",
};

export function formatDiagnostic(event: RuntimeDiagnostic, verbose = false): string {
  const text = messages[event.event] ?? (typeof event.data?.message === "string" ? event.data.message : event.event);
  const detail = event.error?.message ? ` — ${event.error.message}` : "";
  const context = verbose ? ` ${JSON.stringify({ ...event.data, runtimeId: event.runtimeId, sessionId: event.sessionId, turnId: event.turnId })}` : "";
  return `${event.timestamp.slice(11, 19)} ${event.level.toUpperCase().padEnd(5)} ${text}${detail}${context}\n`;
}

/** File logs retain every event; repeated terminal warnings are coalesced. */
export function createDiagnosticConsole(verbose = false, write = (line: string) => process.stderr.write(line)) {
  const last = new Map<string, { at: number; suppressed: number }>();
  return (event: RuntimeDiagnostic) => {
    if (!verbose && (event.level === "debug" || !atLeastLevel(event.level, "warn") && !messages[event.event])) return;
    const key = `${event.component}:${event.event}:${event.level}:${event.error?.message ?? event.data?.message ?? ""}`;
    const previous = last.get(key);
    const now = Date.now();
    if (!verbose && previous && now - previous.at < 30_000 && atLeastLevel(event.level, "warn")) {
      previous.suppressed++;
      return;
    }
    if (last.size >= 256) last.delete(last.keys().next().value ?? "");
    last.set(key, { at: now, suppressed: 0 });
    const repeated = previous?.suppressed ? ` (+${previous.suppressed} repeated / 重复)` : "";
    write(`${formatDiagnostic(event, verbose).trimEnd()}${repeated}\n`);
  };
}

export type RuntimeSummary = {
  spaceId: string;
  runtimeId: string;
  root: string;
  harnesses: string[];
  pid: number;
  state: "starting" | "ready" | "reconnecting" | "attention" | "stopping";
  harnessConnected: boolean;
  workspaceConnected: boolean;
  diagnosticsPath: string;
  background: boolean;
  nativeSync?: boolean;
};

export function printRuntimeSummary(summary: RuntimeSummary, json = false, reused = false) {
  const value = { ...summary, url: runtimeWebUrl(summary.spaceId), reused };
  if (json) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return; }
  const label = summary.state === "ready" ? "Runtime ready / Runtime 已就绪" : `Runtime ${summary.state} / Runtime 尚未就绪`;
  process.stdout.write(`\n${label}${reused ? " · reused / 已复用" : ""}\n\n`);
  const rows = [
    ["Space / 空间", summary.spaceId],
    ["URL / 链接", value.url],
    ["Directory / 目录", summary.root],
    ["Harness", summary.harnesses.join(" · ")],
    ["Mode / 模式", summary.background ? "Background / 后台" : "Foreground / 前台"],
    ["PID", String(summary.pid)],
    ["Logs / 日志", summary.diagnosticsPath],
  ];
  for (const [name, text] of rows) process.stdout.write(`  ${name}  ${text}\n`);
  process.stdout.write(`\n  cohub runtime logs --space ${summary.spaceId} --follow\n  cohub runtime down --space ${summary.spaceId}\n`);
  if (!summary.background && !reused) process.stdout.write("  Ctrl+C to stop / 按 Ctrl+C 停止\n");
  process.stdout.write("\n");
}
