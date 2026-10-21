import { createReadStream } from "node:fs";
import { basename, dirname } from "node:path";
import type { ContentBlock, LocalHarness } from "@neta-art/cohub";
import type { JsonRecord } from "../json-rpc.js";
import { iso, readFirstMatchingRecord, readTranscriptLines, type NativeTranscriptTurn, type TranscriptLine } from "../native/transcript.js";
import { text } from "./process.js";
import type { SessionHeader } from "./types.js";

/**
 * `<data root>/projects/<project>/<session id>.jsonl`; sub-agent files live in deeper directories. A
 * subdirectory's project name extends its parent's, so a prefix admits them; the header decides ownership.
 */
export function projectTranscript(path: string, root: string, project: string): boolean {
  return path.endsWith(".jsonl") && projectDirectory(dirname(path), root, project);
}

export function projectDirectory(path: string, root: string, project: string): boolean {
  return dirname(path) === root && basename(path).startsWith(project);
}

/** The session id is the file name; the first record carrying a `cwd` names the project. */
export async function chainedSessionHeader(path: string, harness: LocalHarness, signal?: AbortSignal): Promise<SessionHeader | null> {
  const value = await readFirstMatchingRecord(createReadStream(path, { signal }), (entry) => Boolean(text(entry.cwd)) && Boolean(text(entry.sessionId)));
  return value ? { harness, nativeSessionId: basename(path, ".jsonl"), cwd: text(value.cwd), thread: "user" } : null;
}

export async function readChainedLines(path: string, signal?: AbortSignal) {
  const read = await readTranscriptLines(createReadStream(path, { signal }));
  if (!read.lines.length) throw new Error("Native transcript is empty");
  return read;
}

/**
 * The branch ending at the file's last linked record, oldest first. These formats only append, so a
 * parent is the latest earlier record with that id: a rewound or repeated id never forms a cycle.
 */
export function chainBranch(lines: TranscriptLine[], id: (value: JsonRecord) => string, parent: (value: JsonRecord) => string): TranscriptLine[] {
  const latest = new Map<string, number>();
  const parents: number[] = [];
  let leaf = -1;
  lines.forEach((line, index) => {
    const own = id(line.value);
    parents[index] = -1;
    if (!own) return;
    const before = latest.get(parent(line.value));
    parents[index] = before ?? -1;
    latest.set(own, index);
    leaf = index;
  });
  const branch: TranscriptLine[] = [];
  for (let index = leaf; index >= 0; index = parents[index] ?? -1) branch.push(lines[index] as TranscriptLine);
  return branch.reverse();
}

export function startTurn(line: TranscriptLine, key: string, parentKey: string | null, userContent: ContentBlock[], cloudTurnId: string): NativeTranscriptTurn {
  return {
    key, parentKey, ...(cloudTurnId ? { cloudTurnId } : {}), userContent, messages: [], startedAt: iso(line.value.timestamp),
    startBytes: line.startBytes, endBytes: line.endBytes, contentEndBytes: line.endBytes, boundaries: {}, sha256: line.sha256, result: null,
  };
}

/** Every branch record extends the Turn's bytes; only conversation records extend its content. */
export function extendTurn(turn: NativeTranscriptTurn, line: TranscriptLine, content: boolean) {
  turn.endBytes = line.endBytes;
  turn.sha256 = line.sha256;
  turn.boundaries[line.endBytes] = line.sha256;
  if (content) turn.contentEndBytes = line.endBytes;
}
