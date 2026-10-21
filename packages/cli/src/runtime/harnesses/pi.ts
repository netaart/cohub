import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { projectNativeSession, type RuntimeMessage, type RuntimeTurnInput } from "@neta-art/cohub";
import { JsonRpcProcess, record } from "../json-rpc.js";
import { piModelCatalog } from "../model-catalog.js";
import { describeError } from "../../network-error.js";
import type { Executor } from "../native/execution.js";
import { PI_DISCONNECTED, type PiSessionLink } from "../native/pi-link.js";
import { copyNativeArchive } from "../native/archive.js";
import { readFirstRecord, readNativeTranscript } from "../native/transcript.js";
import { piTranslator } from "../native/translate.js";
import { array, closeHost, harnessCommand, inlineImage, text, turnEnvironment, watchHost } from "./process.js";
import type { HarnessRun, HarnessTurn, LocalHarnessAdapter } from "./types.js";

/** A stop request that the harness does not honour within this long ends its private process. */
const ABORT_ESCALATION_MS = 5_000;
/** Pause before asking a busy Pi again, so a Turn that is starting has reported itself. */
const PI_BUSY_RETRY_MS = 100;
/** Pi stop reasons that end a reply; anything else (a tool call) means more is coming. */
const PI_ENDED = ["stop", "length", "error", "aborted"];

const agentDirectory = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const sessionRoot = () => process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(agentDirectory(), "sessions");

/** Pi's encoding of a project directory into its session folder name. */
export const piSessionDirectoryName = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Whether a Pi project folder may hold sessions of `cwd` or a subdirectory of it. */
function piProjectFolderMatches(folder: string, cwd: string): boolean {
  const project = piSessionDirectoryName(cwd).slice(0, -2);
  const name = basename(folder);
  return name === `${project}--` || name.startsWith(`${project}-`);
}

function piSessionPath(nativeSessionId: string, cwd: string): string {
  const directory = process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(agentDirectory(), "sessions", piSessionDirectoryName(cwd));
  return join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}_${nativeSessionId}.jsonl`);
}

async function runPi(executor: Executor, turn: HarnessTurn): Promise<HarnessRun> {
  const { input, signal, context } = turn;
  // Cohub drives every Pi through its extension, which needs the control socket and a recent Pi.
  if (executor.pi.unavailable) throw new Error(executor.pi.unavailable);
  const prepared = await executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: "pi", cwd: executor.cwd,
    provider: input.provider, context: input.context, signal,
    // A terminal Pi is continued only through its extension; without one it is read-only.
    resumable: (transcript) => transcript.path !== turn.diverged && (transcript.origin === "cohub" || executor.pi.find(transcript.nativeSessionId) !== null),
  });
  let session = prepared.session;
  let link = executor.pi.find(session.nativeSessionId);
  let host: JsonRpcProcess | null = null;
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let begun = false;
  try {
    if (!link) {
      host = new JsonRpcProcess(...harnessCommand(executor.executables.pi || "pi", ["--mode", "rpc", "--session", session.path, "-e", executor.piExtension], executor.cwd), executor.cwd, "pi", turnEnvironment(input));
      watchHost(host, executor.diagnostics, context);
      const rpc = host;
      // Nobody is at this Pi's terminal to answer an extension's question.
      rpc.onEvent((event) => {
        if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(text(event.method))) rpc.write({ type: "extension_ui_response", id: event.id, cancelled: true });
      });
      await configurePiHost(host, input);
      link = await Promise.race([
        executor.pi.waitFor({ sessionId: session.nativeSessionId, sessionFile: session.path }, signal),
        new Promise<never>((_, reject) => host?.onFailure(reject)),
      ]);
    }
    const piSession: PiSessionLink = link;
    session = { ...session, nativeSessionId: piSession.sessionId };
    // Never interleave with a Turn a terminal user is running; follow it instead.
    await executor.pi.idle(piSession.sessionId, signal);
    const content = await piPrompt(input);
    signal.throwIfAborted();
    await turn.started(session);
    begun = true;
    const translator = piTranslator(turn.emit);
    const model = !host && input.model && input.provider ? { provider: input.provider, id: input.model } : null;
    await new Promise<void>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      /** Events held until Pi takes the prompt; until then they belong to a terminal Turn. */
      let held: Array<Record<string, unknown>> | null = [];
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        off(); signal.removeEventListener("abort", abort); clearTimeout(escalation);
        if (error) reject(error); else resolve();
      };
      const feed = (event: Record<string, unknown>) => {
        try { if (translator.push(event)) finish(); } catch (error) { finish(error); }
      };
      const off = executor.pi.subscribe(piSession.sessionId, (event) => {
        if (event.type === PI_DISCONNECTED) { finish(new Error("Pi exited during the Turn")); return; }
        if (held) held.push(event); else feed(event);
      });
      const abort = () => {
        // Not taken yet: the Pi is running someone else's Turn, which is not Cohub's to stop.
        if (held) { finish(signal.reason ?? new Error("Aborted")); return; }
        void executor.pi.abort(piSession.sessionId).catch(() => undefined);
        if (host) escalation = setTimeout(() => void host?.close().catch(() => undefined), ABORT_ESCALATION_MS);
      };
      signal.addEventListener("abort", abort, { once: true });
      void (async () => {
        for (;;) {
          // Only what follows this request can be this Turn's.
          held = [];
          const { accepted } = await executor.pi.prompt(piSession.sessionId, { turnId: input.turnId, content, model, thinkingLevel: host ? null : input.thinkingLevel ?? null, env: turnEnvironment(input) });
          if (accepted) break;
          // The terminal started a Turn first: wait for it to settle, then ask again.
          await new Promise((resolve) => setTimeout(resolve, PI_BUSY_RETRY_MS));
          await executor.pi.idle(piSession.sessionId, signal);
          if (done) return;
        }
        const events = held ?? [];
        held = null;
        if (done) { void executor.pi.abort(piSession.sessionId).catch(() => undefined); return; }
        for (const event of events) feed(event);
        if (signal.aborted) abort();
      })().catch(finish);
      if (signal.aborted) abort();
    });
    message = translator.last();
    // The Pi keeps running for its terminal user; its tools no longer work for this Turn.
    if (!host) void executor.pi.context(piSession.sessionId, { COHUB_TURN_ID: null }).catch(() => undefined);
  } catch (error) {
    // Before the prompt, nothing ran and the error is the outcome.
    if (!begun) {
      if (host) await closeHost(host, null).catch(() => undefined);
      throw error;
    }
    message = { ...message, stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : describeError(error) };
  }
  return { session, resume: prepared.resume, message, host };
}

/** A Pi that Cohub starts is configured through its RPC before the extension takes the prompt. */
async function configurePiHost(host: JsonRpcProcess, input: RuntimeTurnInput) {
  if (input.model) {
    let provider = input.provider;
    if (!provider) {
      const catalog = await host.request("get_available_models");
      const matches = (Array.isArray(catalog.models) ? catalog.models : []).map(record).filter((model) => model.id === input.model);
      if (matches.length !== 1) throw new Error("Select a provider for this local model");
      provider = text(matches[0]?.provider);
    }
    await host.request("set_model", { provider, modelId: input.model });
  }
  if (input.thinkingLevel) await host.request("set_thinking_level", { level: input.thinkingLevel });
}

async function piPrompt(input: RuntimeTurnInput) {
  const blocks = input.messages.flatMap((message) => message.content);
  return await Promise.all(blocks.map(async (block): Promise<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> => {
    if (block.type === "image") return await inlineImage(block);
    return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block) };
  }));
}

export const piHarness: LocalHarnessAdapter = {
  id: "pi",
  binary: "pi",
  async models(executable, cwd) {
    const rpc = new JsonRpcProcess(...harnessCommand(executable, ["--mode", "rpc", "--no-session"], cwd), cwd, "pi");
    try {
      const result = await rpc.request("get_available_models");
      const state = await rpc.request("get_state");
      return piModelCatalog(array(result.models), state);
    } finally { await rpc.close(); }
  },
  run: runPi,
  session: {
    path: piSessionPath,
    startsWithoutFile: false,
    project: (input) => projectNativeSession(input, "pi"),
    rebind: (records, nativeSessionId) => records.map((entry) => entry.sourceTurnId === null && entry.record.type === "session"
      ? { ...entry, record: { ...entry.record, id: nativeSessionId, affinity: { ...record(entry.record.affinity), threadId: nativeSessionId } } }
      : entry),
    archive: {
      target: ({ id, cwd }) => piSessionPath(id, cwd),
      async import(input) {
        const { checksum } = await copyNativeArchive({
          ...input,
          header: (header) => {
            if (header.type !== "session" || header.id !== input.nativeSessionId) throw new Error("Pi archive identity mismatch");
            const next: Record<string, unknown> = { ...header, cwd: input.cwd };
            delete next.parentSession;
            return next;
          },
        });
        return { checksum, nativeSessionId: input.nativeSessionId };
      },
    },
  },
  transcript: {
    roots: () => [sessionRoot()],
    acceptsDirectory: (path, root, cwd) => Boolean(process.env.PI_CODING_AGENT_SESSION_DIR?.trim()) || dirname(path) !== root || piProjectFolderMatches(path, cwd),
    acceptsTranscript: (path, cwd) => path.endsWith(".jsonl") && (Boolean(process.env.PI_CODING_AGENT_SESSION_DIR?.trim()) || piProjectFolderMatches(dirname(path), cwd)),
    async header(path, signal) {
      const header = await readFirstRecord(createReadStream(path, { signal }));
      if (header.type !== "session" || !text(header.id) || !text(header.cwd)) return null;
      return { harness: "pi", nativeSessionId: text(header.id), cwd: text(header.cwd), thread: "user" };
    },
    // A Pi Turn's end is inferred by the caller, so the tail is parsed as settled here.
    read: (path, signal) => readNativeTranscript(path, "pi", { settled: true, signal }),
    boundaries: ['"role":"user"', ...PI_ENDED.map((reason) => `"stopReason":"${reason}"`)],
    turnEndRecorded: false,
    replyEnded: (turn) => PI_ENDED.includes(turn.messages.at(-1)?.stopReason ?? ""),
    userFinalMarked: false,
    globalTurnKeys: false,
    marksCohubTurns: true,
  },
};
