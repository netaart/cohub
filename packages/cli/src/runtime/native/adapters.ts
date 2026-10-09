import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { codexArchivedSessionsDirectory, codexRolloutBytes, codexRolloutIdOf, codexSessionsDirectory, readNativeTranscript,
  type NativeTranscript, type NativeTranscriptTurn } from "./transcript.js";

export type { NativeTranscript, NativeTranscriptTurn };
export type Harness = "pi" | "codex";

/**
 * Why a Codex thread exists. Codex writes every thread it starts into one rollout tree: the user's
 * conversations, its own background work (guardian reviews, compaction, memory consolidation) and
 * agents spawned from a conversation.
 */
export type ThreadKind = "user" | "internal" | "spawned";

export type SessionHeader = { harness: Harness; nativeSessionId: string; cwd: string; thread: ThreadKind };

const text = (value: unknown) => typeof value === "string" ? value : "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const HEADER_MAX_BYTES = 1024 * 1024;

/** Directories holding this harness's transcripts; a transcript's header says which project it is. */
export function transcriptRoots(harness: Harness): string[] {
  if (harness === "codex") return [codexSessionsDirectory(), codexArchivedSessionsDirectory()];
  const custom = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (custom) return [custom];
  return [join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "sessions")];
}

/** Pi's encoding of a project directory into its session folder name. */
export const piSessionDirectoryName = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Whether a Pi project folder may hold sessions of `cwd` or a subdirectory of it. */
function piProjectFolderMatches(folder: string, cwd: string): boolean {
  const project = piSessionDirectoryName(cwd).slice(0, -2);
  const name = basename(folder);
  return name === `${project}--` || name.startsWith(`${project}-`);
}

/** Whether a directory found under a root can hold transcripts of `cwd`. */
export function acceptsDirectory(path: string, root: string, harness: Harness, cwd: string): boolean {
  if (harness === "codex" || process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || dirname(path) !== root) return true;
  return piProjectFolderMatches(path, cwd);
}

/** Name-only check: can this path hold a transcript of this harness for `cwd`? */
export function acceptsTranscript(path: string, harness: Harness, cwd: string): boolean {
  const name = basename(path);
  if (harness === "codex") return codexRolloutIdOf(name) !== null;
  return name.endsWith(".jsonl") && (Boolean(process.env.PI_CODING_AGENT_SESSION_DIR?.trim()) || piProjectFolderMatches(dirname(path), cwd));
}

async function firstRecord(bytes: AsyncIterable<Buffer>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let buffered = 0;
  for await (const chunk of bytes) {
    chunks.push(chunk); buffered += chunk.length;
    const newline = chunk.indexOf(10);
    if (newline >= 0) return record(JSON.parse(Buffer.concat(chunks, buffered).subarray(0, buffered - chunk.length + newline).toString("utf8")));
    if (buffered > HEADER_MAX_BYTES) throw new Error("Native session header is too large");
  }
  throw new Error("Native transcript is empty");
}

/** Codex's first line is the only place a thread's purpose is recorded. */
export function codexThreadKind(payload: Record<string, unknown>): ThreadKind {
  const source = payload.source;
  if (source && typeof source === "object") return record(record(source).subagent).thread_spawn ? "spawned" : "internal";
  return ["subagent", "guardian_review", "memory_consolidation"].includes(text(payload.thread_source)) ? "internal" : "user";
}

/** The first line of a transcript: identity, project and purpose. Nothing else is read. */
export async function readSessionHeader(path: string, harness: Harness, signal?: AbortSignal): Promise<SessionHeader | null> {
  if (harness === "pi") {
    const header = await firstRecord(createReadStream(path, { signal }));
    if (header.type !== "session" || !text(header.id) || !text(header.cwd)) return null;
    return { harness, nativeSessionId: text(header.id), cwd: text(header.cwd), thread: "user" };
  }
  const header = await firstRecord(codexRolloutBytes(path, null, signal));
  const payload = record(header.payload);
  if (header.type !== "session_meta" || !text(payload.id) || !text(payload.cwd)) return null;
  return { harness, nativeSessionId: text(payload.id), cwd: text(payload.cwd), thread: codexThreadKind(payload) };
}

/**
 * Parse a transcript into Turns. Codex records its own Turn boundary; a Pi Turn's end is inferred
 * by the caller, so Pi is parsed as settled here and the caller withdraws a tail still in flight.
 */
export async function readTranscript(path: string, harness: Harness, signal?: AbortSignal): Promise<NativeTranscript> {
  return await readNativeTranscript(path, harness, { settled: harness === "pi", signal });
}
