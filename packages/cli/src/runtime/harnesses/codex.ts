import { homedir } from "node:os";
import { basename, join } from "node:path";
import { projectNativeSession, type ContentBlock, type RuntimeMessage, type RuntimeTurnInput } from "@neta-art/cohub";
import { JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import { codexModelCatalog } from "../model-catalog.js";
import { describeError } from "../../network-error.js";
import type { Executor } from "../native/execution.js";
import { openPrivateServer, type CodexChannel } from "../native/codex-link.js";
import { ArchiveNotRestorableError, copyNativeArchive } from "../native/archive.js";
import {
  codexArchivedSessionsDirectory, codexRolloutBytes, codexRolloutIdOf, codexSessionsDirectory, ensurePlainCodexRollout, readFirstRecord, readNativeTranscript,
} from "../native/transcript.js";
import { codexTranslator } from "../native/translate.js";
import { array, closeHost, harnessCommand, inlineImage, text, turnEnvironment, watchHost } from "./process.js";
import type { HarnessRun, HarnessTurn, LocalHarnessAdapter, ThreadKind } from "./types.js";

/** A stop request that the harness does not honour within this long ends its private process. */
const ABORT_ESCALATION_MS = 5_000;

function codexSessionPath(nativeSessionId: string): string {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const day = new Date().toISOString().replace(/\.\d{3}Z$/, "").replaceAll(":", "-");
  return join(home, "sessions", day.slice(0, 4), day.slice(5, 7), day.slice(8, 10), `rollout-${day}-${nativeSessionId}.jsonl`);
}

async function initializeCodex(rpc: JsonRpcProcess) {
  await rpc.request("initialize", { clientInfo: { name: "cohub", title: "Cohub", version: "1" }, capabilities: { experimentalApi: true } });
  rpc.write({ method: "initialized", params: {} });
}

/** Codex's first line is the only place a thread's purpose is recorded. */
export function codexThreadKind(payload: Record<string, unknown>): ThreadKind {
  const source = payload.source;
  if (source && typeof source === "object") return record(record(source).subagent).thread_spawn ? "spawned" : "internal";
  return ["subagent", "guardian_review", "memory_consolidation"].includes(text(payload.thread_source)) ? "internal" : "user";
}

async function runCodex(executor: Executor, turn: HarnessTurn): Promise<HarnessRun> {
  const { input, signal, context } = turn;
  const shared = await executor.codex.get();
  const prepared = await executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: "codex", cwd: executor.cwd,
    provider: input.provider, context: input.context, signal,
    // Only the shared server coordinates with terminal clients; a private one never opens their files.
    resumable: (transcript) => transcript.path !== turn.diverged && (transcript.origin === "cohub" || shared !== null),
  });
  let session = prepared.session;
  let host: JsonRpcProcess | null = null;
  let channel: CodexChannel | null = shared;
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let begun = false;
  try {
    if (!channel) {
      host = new JsonRpcProcess(...harnessCommand(executor.executables.codex || "codex", ["app-server", "--listen", "stdio://"], executor.cwd), executor.cwd, "jsonrpc", turnEnvironment(input));
      watchHost(host, executor.diagnostics, context);
      channel = await openPrivateServer(host);
    }
    const codex = channel;
    const threadOptions = {
      cwd: executor.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider && input.provider !== "codex" ? { modelProvider: input.provider } : {}),
      ...(input.accessMode === "read_only" ? { sandbox: "read-only" } : {}),
      // Tools of a shared server otherwise see the environment of whoever started that server.
      config: { "shell_environment_policy.set.COHUB_SPACE_ID": input.spaceId, "shell_environment_policy.set.COHUB_SESSION_ID": input.sessionId },
    };
    const existing = { ...threadOptions, threadId: session.nativeSessionId, path: session.path, excludeTurns: true };
    const opened = prepared.resume === "new" ? await codex.request("thread/start", threadOptions)
      : prepared.resume === "restored" ? await codex.request("thread/fork", existing)
        : await codex.request("thread/resume", existing);
    const thread = record(opened.thread);
    if (typeof thread.id !== "string" || typeof thread.path !== "string") throw new Error("Codex did not provide a durable native thread");
    const threadId = thread.id;
    if (thread.path !== session.path || threadId !== session.nativeSessionId) {
      session = { ...session, nativeSessionId: threadId, path: thread.path };
      executor.ingest.adopt(session, input.sessionId);
    }
    const translator = codexTranslator(turn.emit, { provider: text(opened.modelProvider) || "codex", model: text(opened.model) || input.model || null });
    const content = await codexPrompt(input);
    signal.throwIfAborted();
    await turn.started(session);
    begun = true;
    let nativeTurnId: string | null = null;
    executor.codex.driving.add(threadId);
    await new Promise<void>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        off(); offClose(); signal.removeEventListener("abort", abort); clearTimeout(escalation);
        if (error) reject(error); else resolve();
      };
      const interrupt = () => { if (nativeTurnId) void codex.request("turn/interrupt", { threadId, turnId: nativeTurnId }).catch(() => undefined); };
      const off = codex.onEvent((event) => {
        const params = event.params;
        if (event.id != null) {
          // An unattended Cohub Turn never grants an escalation.
          if (!codex.shared || params.threadId === threadId && (!nativeTurnId || params.turnId === nativeTurnId)) codex.refuse(event.id, "Approval requires an interactive local client");
          return;
        }
        if (params.threadId !== threadId) return;
        // A resumed thread replays its last usage; only this Turn's counts belong to it.
        if (event.method === "thread/tokenUsage/updated" && params.turnId !== nativeTurnId) return;
        if (event.method === "turn/started" && !nativeTurnId) { nativeTurnId = text(record(params.turn).id) || null; if (signal.aborted) interrupt(); }
        if (event.method === "turn/completed" && nativeTurnId && text(record(params.turn).id) !== nativeTurnId) return;
        try { if (translator.push(event)) finish(); } catch (error) { finish(error); }
      });
      const offClose = codex.onClose((error) => finish(error));
      const abort = () => {
        interrupt();
        if (host) escalation = setTimeout(() => void host?.close().catch(() => undefined), ABORT_ESCALATION_MS);
      };
      signal.addEventListener("abort", abort, { once: true });
      codex.request("turn/start", { threadId, clientUserMessageId: input.turnId, input: content, ...(input.thinkingLevel ? { effort: input.thinkingLevel === "off" ? "none" : input.thinkingLevel } : {}) })
        .then((result) => { nativeTurnId ??= text(record(result.turn).id) || null; if (signal.aborted) interrupt(); })
        .catch(finish);
    }).finally(() => executor.codex.driving.delete(threadId));
    message = translator.last();
  } catch (error) {
    if (!begun) {
      if (host) await closeHost(host, null).catch(() => undefined);
      throw error;
    }
    message = { ...message, stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : describeError(error) };
  }
  return { session, resume: prepared.resume, message, host };
}

async function codexPrompt(input: RuntimeTurnInput): Promise<JsonRecord[]> {
  return await Promise.all(input.messages.flatMap((message) => message.content).map(async (block: ContentBlock) => {
    if (block.type === "image") {
      const image = await inlineImage(block);
      return { type: "image", url: `data:${image.mimeType};base64,${image.data}` };
    }
    return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block), text_elements: [] };
  }));
}

export const codexHarness: LocalHarnessAdapter = {
  id: "codex",
  binary: "codex",
  async models(executable, cwd) {
    const rpc = new JsonRpcProcess(...harnessCommand(executable, ["app-server", "--listen", "stdio://"], cwd), cwd, "jsonrpc");
    try {
      await initializeCodex(rpc);
      const config = await rpc.request("config/read", { includeLayers: false, cwd });
      const entries: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = await rpc.request("model/list", { cursor, limit: 100 });
        entries.push(...array(result.data));
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
        if (entries.length > 2000 || cursor && cursors.has(cursor)) throw new Error("Invalid model catalog pagination");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return codexModelCatalog(config, entries);
    } finally { await rpc.close(); }
  },
  run: runCodex,
  session: {
    path: (nativeSessionId) => codexSessionPath(nativeSessionId),
    startsWithoutFile: true,
    project: (input) => projectNativeSession(input, "codex"),
    rebind: (records, nativeSessionId) => records.map((entry) => entry.sourceTurnId === null && entry.record.type === "session_meta"
      ? { ...entry, record: { ...entry.record, payload: { ...record(entry.record.payload), id: nativeSessionId, session_id: nativeSessionId } } }
      : entry),
    archive: {
      target: ({ id }) => codexSessionPath(id),
      async import(input) {
        const { checksum } = await copyNativeArchive({
          ...input,
          header: (header) => {
            const payload = record(header.payload);
            if (header.type !== "session_meta" || payload.id !== input.nativeSessionId) throw new Error("Codex archive identity mismatch");
            // A leaf archive does not carry its ancestor rollout.
            if (payload.history_base != null) throw new ArchiveNotRestorableError("Codex archive references history it does not carry; rebuild from the Session instead");
            return { ...header, payload: { ...payload, id: input.id, ...(payload.session_id != null ? { session_id: input.id } : {}), history_mode: "legacy", cwd: input.cwd } };
          },
        });
        return { checksum, nativeSessionId: input.id };
      },
    },
  },
  transcript: {
    roots: () => [codexSessionsDirectory(), codexArchivedSessionsDirectory()],
    acceptsDirectory: () => true,
    acceptsTranscript: (path) => codexRolloutIdOf(basename(path)) !== null,
    async header(path, signal) {
      const header = await readFirstRecord(codexRolloutBytes(path, null, signal));
      const payload = record(header.payload);
      if (header.type !== "session_meta" || !text(payload.id) || !text(payload.cwd)) return null;
      return { harness: "codex", nativeSessionId: text(payload.id), cwd: text(payload.cwd), thread: codexThreadKind(payload) };
    },
    read: (path, signal) => readNativeTranscript(path, "codex", { signal }),
    boundaries: ['"UserMessage"', '"user_message"', '"turn_complete"', '"task_complete"', '"turn_aborted"'],
    turnEndRecorded: true,
    userFinalMarked: true,
    globalTurnKeys: true,
    archiveSource: (path, cacheDirectory) => ensurePlainCodexRollout(path, cacheDirectory),
  },
  nativeSync: true,
};
