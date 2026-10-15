import { readFile, stat } from "node:fs/promises";
import type { ContentBlock, RuntimeExecutionEvent, RuntimeMessage, RuntimeTurnInput } from "@neta-art/cohub";
import { downloadPublicImage } from "../../safe-remote-image.js";
import { describeError } from "../../network-error.js";
import { record } from "../json-rpc.js";
import { resolveWorkBuddyLaunch, WorkBuddyProcess } from "../workbuddy-process.js";
import { ProcessCleanupUncertainError } from "../process-group.js";
import type { Executor, HarnessResult } from "./execution.js";
import { readTranscript } from "./adapters.js";
import { parseWorkBuddyOrigin } from "./workbuddy-transcript.js";
import { workbuddyTranslator } from "./workbuddy-translate.js";

async function promptContent(blocks: ContentBlock[]) {
  return await Promise.all(blocks.map(async (block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      if (block.source.type === "base64") return block;
      const image = await downloadPublicImage(block.source.url);
      return { type: "image", source: { type: "base64", data: Buffer.from(image.bytes).toString("base64"), media_type: image.mimeType } };
    }
    throw new Error(`WorkBuddy cannot accept prompt content of type ${block.type}`);
  }));
}

/** A private copy preserves the Cohub conversation without taking over a desktop connection. */
export async function executeWorkBuddyTurn(executor: Executor, input: RuntimeTurnInput, emit: (event: RuntimeExecutionEvent) => void, signal: AbortSignal, requestId: string | null): Promise<HarnessResult> {
  signal.throwIfAborted();
  if (input.accessMode === "read_only") throw new Error("WorkBuddy cannot enforce read-only access");
  if (input.provider && input.provider !== "workbuddy") throw new Error("WorkBuddy requires its own configured model provider");
  if (input.thinkingLevel && input.thinkingLevel !== "off") throw new Error("WorkBuddy does not expose a configurable reasoning level");
  const diverged = await executor.results.admit(input);
  const prepared = await executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: "workbuddy", cwd: executor.cwd,
    context: input.context, provider: input.provider, signal,
    resumable: (transcript) => transcript.path !== diverged,
  });
  const session = prepared.session;
  const origin = parseWorkBuddyOrigin(JSON.parse(await readFile(`${session.path}.cohub.json`, "utf8")));
  if (origin.nativeSessionId !== session.nativeSessionId || origin.cloudSessionId !== input.sessionId || origin.turnId !== input.turnId) throw new Error("WorkBuddy execution origin mismatch");
  const content = await promptContent(input.messages.flatMap((message) => message.content));
  const launch = await resolveWorkBuddyLaunch(executor.cwd, executor.executables.workbuddy);
  signal.throwIfAborted();
  const host = new WorkBuddyProcess(launch, executor.cwd, {
    ...(origin.prefixBytes ? { resume: session.nativeSessionId } : { sessionId: session.nativeSessionId }),
    ...(input.model ? { model: input.model } : {}),
    context: { COHUB_SPACE_ID: input.spaceId, COHUB_SESSION_ID: input.sessionId, COHUB_TURN_ID: input.turnId },
  });
  const translator = workbuddyTranslator(emit);
  let begun = false;
  let message: RuntimeMessage = { ordinal: 0, content: [], provider: "workbuddy", model: input.model ?? null };
  let uncertainCleanup: HarnessResult["uncertainCleanup"];
  const closeHost = async () => {
    try { await host.close(); }
    catch (error) {
      if (!(error instanceof ProcessCleanupUncertainError) || host.processGroupId === null) throw error;
      uncertainCleanup = { processGroupId: host.processGroupId, error: describeError(error) };
    }
  };
  const stop = () => { void host.close().catch(() => { /* Awaited and reported by the finally block. */ }); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const catalog = await host.initialize();
    if (input.model && !catalog.models.some((model) => model.id === input.model)) throw new Error(`WorkBuddy model is unavailable: ${input.model}`);
    signal.throwIfAborted();
    await executor.results.start(session, input, requestId);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        offEvent(); offFailure(); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(signal.reason ?? new Error("Aborted"));
      const offEvent = host.onEvent((event) => {
        try {
          if (event.type === "control_request") {
            if (typeof event.request_id !== "string" || record(event.request).subtype !== "can_use_tool") throw new Error("Unsupported WorkBuddy control request");
            host.denyPermission(event.request_id, "This action needs approval in WorkBuddy before it can run from Cohub");
            return;
          }
          if ((event.type === "result" || event.type === "user") && event.session_id !== undefined && event.session_id !== session.nativeSessionId) throw new Error("WorkBuddy returned a different session");
          if (translator.push(event)) finish();
        } catch (error) { finish(error); }
      });
      const offFailure = host.onFailure(finish);
      signal.addEventListener("abort", aborted, { once: true });
      try {
        signal.throwIfAborted();
        begun = true;
        host.prompt({ type: "user", message: { role: "user", content } });
      } catch (error) { finish(error); }
    });
    message = translator.last();
  } catch (error) {
    if (!begun) throw error;
    message = { ...translator.last(), stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : describeError(error) };
  } finally {
    signal.removeEventListener("abort", stop);
    await closeHost();
  }
  translator.finish();
  if (signal.aborted) message = { ...message, stopReason: "aborted", errorMessage: null };
  // An uncertain child may still be writing. Do not archive or declare its result settled.
  if (uncertainCleanup) return { session, event: { type: "turn.end", message: { ...message, stopReason: "error", errorMessage: uncertainCleanup.error }, resume: prepared.resume, archive: null }, uncertainCleanup };
  const info = await stat(session.path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT" && message.stopReason !== "stop") return null; throw error; });
  if (!info || info.size === 0 && message.stopReason !== "stop") return { session, event: { type: "turn.end", message, resume: prepared.resume, archive: null } };
  // A successful stream is not enough: the same turn must be durably recoverable.
  if (message.stopReason === "stop") {
    const transcript = await readTranscript(session.path, "workbuddy", signal);
    if (transcript.turns.at(-1)?.cloudTurnId !== input.turnId || transcript.turns.at(-1)?.result?.status !== "completed") throw new Error("WorkBuddy did not persist the completed turn");
  }
  const archive = await executor.archives.stage({ ...session, sessionId: input.sessionId }, input.turnId);
  executor.ingest.advance(session.path, input.turnId);
  return { session, event: { type: "turn.end", message, resume: prepared.resume, archive } };
}
