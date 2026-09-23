import { existsSync } from "node:fs";
import { requestNativeDaemon } from "./native-ipc.js";

type PiContext = {
  cwd: string;
  sessionManager: { getSessionFile(): string | undefined; getSessionId(): string; getLeafId(): string | null };
  abort(): void;
  isIdle(): boolean;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void; setStatus(key: string, value: string | undefined): void };
};
type PiExtension = { on(event: string, handler: (event: unknown, context: PiContext) => Promise<void> | void): void };

/** Thin native adapter. The Runtime Daemon owns Cohub auth, WS, retries and archives. */
export default function cohubNativeExtension(pi: PiExtension) {
  if (process.env.COHUB_TURN_ID || process.env.COHUB_EXECUTION_TOKEN) return;
  let context: PiContext | null = null;
  let captures = Promise.resolve();
  let lastError = "";
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) context?.ui.notify(`Cohub sync pending: ${message}`, "warning");
    lastError = message;
  };
  const capture = (ctx: PiContext, settled = false) => {
    context = ctx;
    const path = ctx.sessionManager.getSessionFile();
    if (!path) return Promise.resolve();
    captures = captures.then(async () => {
      // Pi persists the transcript lazily; a not-yet-created file is not a sync failure.
      if (!existsSync(path)) return;
      const result = await requestNativeDaemon({ harness: "pi", cwd: ctx.cwd, path, nativeSessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(), settled });
      // Nothing to sync yet (unbound workspace, or config not installed) is silence, not a warning.
      if (!result.ok) {
        if (result.skipped) return;
        throw new Error(result.message);
      }
      ctx.ui.setStatus("cohub", "Cohub");
      lastError = "";
    }).catch(report);
    return captures;
  };
  pi.on("session_start", async (_event, ctx) => {
    await capture(ctx, ctx.isIdle());
  });
  pi.on("message_end", (_event, ctx) => capture(ctx));
  pi.on("agent_settled", (_event, ctx) => capture(ctx, true));
  pi.on("session_shutdown", async (_event, ctx) => {
    await captures;
    ctx.ui.setStatus("cohub", undefined);
    context = null;
  });
}
