import { pathToFileURL } from "node:url";
import { requestNativeDaemon } from "./native-ipc.js";

export async function runCodexNativeHook(payload: unknown) {
  if (process.env.COHUB_TURN_ID || process.env.COHUB_EXECUTION_TOKEN) return;
  const value = payload as { cwd?: unknown; transcript_path?: unknown; session_id?: unknown; hook_event_name?: unknown } | null;
  if (!value || typeof value.cwd !== "string" || typeof value.session_id !== "string") throw new Error("Invalid Codex hook identity / Codex Hook 身份无效");
  if (typeof value.transcript_path !== "string" || !value.transcript_path) return;
  const result = await requestNativeDaemon({ harness: "codex", cwd: value.cwd, path: value.transcript_path, nativeSessionId: value.session_id });
  if (!result.ok) throw new Error(result.message);
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error("Codex hook input is too large / Codex Hook 输入过大");
  }
  await runCodexNativeHook(JSON.parse(input));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`Cohub sync pending; native execution continues / Cohub 待同步，原生执行继续: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}
