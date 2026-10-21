import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep, win32 } from "node:path";
import type { ContentBlock, NativeTurnMessage } from "@neta-art/cohub";
import { record } from "../json-rpc.js";
import type { NativeTranscript, NativeTranscriptTurn } from "../native/transcript.js";
import { extendTurn, readChainedLines } from "./chained-transcript.js";
import { array, missing, text } from "./process.js";
import type { SessionHeader } from "./types.js";

const TRANSCRIPTS = "agent-transcripts";
const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const TIMESTAMP = /<timestamp>([^<]*)<\/timestamp>/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Chats (`store.db` and `meta.json`) live under the config directory, transcripts under the data directory. */
export const cursorConfigDirectory = () => process.env.CURSOR_CONFIG_DIR?.trim()
  || (process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME.trim(), "cursor") : join(homedir(), ".cursor"));
const dataDirectory = () => process.env.CURSOR_DATA_DIR?.trim() || join(homedir(), ".cursor");
export const cursorProjectsRoot = () => join(dataDirectory(), "projects");
export const cursorChatsRoot = () => join(cursorConfigDirectory(), "chats");

/** Cursor's project name for a workspace path. */
export const cursorProjectName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
/** Windows reuses a project folder whose name differs only in case, and file events name that folder. */
function projectFolder(cwd: string) {
  const name = cursorProjectName(cwd);
  if (process.platform !== "win32") return name;
  try { return readdirSync(cursorProjectsRoot()).find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name; } catch { return name; }
}
export const cursorTranscriptPath = (nativeSessionId: string, cwd: string) => join(cursorProjectsRoot(), projectFolder(cwd), TRANSCRIPTS, nativeSessionId, `${nativeSessionId}.jsonl`);
/** A chat's store directory is keyed by the MD5 of the directory the CLI ran in. */
export const cursorChatDirectory = (nativeSessionId: string, cwd: string) => join(cursorChatsRoot(), createHash("md5").update(resolve(cwd)).digest("hex"), nativeSessionId);

/** A chat's project never changes, so its header is read once. */
const headers = new Map<string, SessionHeader>();

/** `<project>/agent-transcripts/<id>/<id>.jsonl`; a subdirectory's project name extends its parent's. Sub-agent files are skipped. */
function transcriptParts(path: string, root: string): string[] | null {
  const parts = relative(root, path).split(sep);
  return parts.length && !parts[0]?.startsWith("..") ? parts : null;
}
/** Windows paths ignore case, so a terminal opened as `c:\\users` names the same project as `C:\\Users`. */
const fold = (value: string, platform: NodeJS.Platform) => platform === "win32" ? value.toLowerCase() : value;
const ownsProject = (name: string | undefined, cwd: string, platform = process.platform) => {
  const project = fold(cursorProjectName(cwd), platform), own = fold(name ?? "", platform);
  return own === project || own.startsWith(`${project}-`);
};

export function acceptsCursorDirectory(path: string, root: string, cwd: string): boolean {
  const parts = transcriptParts(path, root);
  if (!parts || parts.length > 3 || !ownsProject(parts[0], cwd)) return false;
  return parts.length === 1 || parts[1] === TRANSCRIPTS;
}

export function acceptsCursorTranscript(path: string, cwd: string): boolean {
  const parts = transcriptParts(path, cursorProjectsRoot());
  return parts?.length === 4 && ownsProject(parts[0], cwd) && parts[1] === TRANSCRIPTS && parts[3] === `${parts[2]}.jsonl`;
}

/**
 * The directory a project name stands for, matched against real directories. On Windows the name
 * starts with the drive letter and matching ignores case. Several directories with the same name
 * (`a/b` and `a-b`) cannot be told apart, so none is chosen.
 */
type Entry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };
export async function projectDirectory(name: string, platform = process.platform, list: (directory: string) => Promise<Entry[]> = (directory) => readdir(directory, { withFileTypes: true })): Promise<string | null> {
  const paths = platform === "win32" ? win32 : posix;
  const drive = platform === "win32" ? /^([A-Za-z])(?:-(.*))?$/.exec(name) : null;
  if (platform === "win32" && !drive) return null;
  const found: string[] = [];
  const walk = async (directory: string, rest: string): Promise<void> => {
    if (found.length > 1) return;
    if (!rest) { found.push(directory); return; }
    const entries = await list(directory).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const part = fold(cursorProjectName(entry.name), platform);
      if (part && (fold(rest, platform) === part || fold(rest, platform).startsWith(`${part}-`))) await walk(paths.join(directory, entry.name), rest.slice(part.length + 1));
    }
  };
  await (drive ? walk(`${drive[1]?.toUpperCase()}:\\`, drive[2] ?? "") : walk("/", name));
  return found.length === 1 ? found[0] ?? null : null;
}

/**
 * The transcript does not name its project. A CLI chat's `meta.json` does; the IDE writes the same
 * transcripts without one, so its project name is resolved to the directory it stands for.
 */
export async function cursorSessionHeader(path: string): Promise<SessionHeader | null> {
  const nativeSessionId = basename(path, ".jsonl");
  if (basename(dirname(path)) !== nativeSessionId) return null;
  const known = headers.get(nativeSessionId);
  if (known) return known;
  let header: SessionHeader | null = null;
  const hashes = await readdir(cursorChatsRoot()).catch((error) => { if (missing(error)) return []; throw error; });
  for (const hash of hashes) {
    const meta = await readFile(join(cursorChatsRoot(), hash, nativeSessionId, "meta.json"), "utf8").then((raw) => record(JSON.parse(raw)), () => null);
    if (!meta || !text(meta.cwd)) continue;
    header = { harness: "cursor", nativeSessionId, cwd: text(meta.cwd), thread: meta.isSubagent === true ? "spawned" : "user" };
    break;
  }
  const project = basename(dirname(dirname(dirname(path))));
  const cwd = header ? null : await projectDirectory(project);
  header ??= cwd ? { harness: "cursor", nativeSessionId, cwd, thread: "user" } : null;
  if (header) headers.set(nativeSessionId, header);
  return header;
}

/** "Saturday, Aug 01, 2026, 9:30 AM (UTC+8)": minutes only, so Turn times are approximate. */
function promptTime(value: string): string | null {
  const match = /^\w+, (\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?\)$/.exec(value.trim());
  const month = MONTHS.indexOf(match?.[1] ?? "");
  if (!match || month < 0) return null;
  const hour = Number(match[4]) % 12 + (match[6] === "PM" ? 12 : 0);
  const offset = (match[7] === "-" ? -1 : 1) * (Number(match[8] ?? 0) * 60 + Number(match[9] ?? 0));
  const time = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5])) - offset * 60_000;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

const blocks = (value: unknown) => array(record(record(value).message).content).map(record);

/**
 * Cursor writes the model's messages without ids or times: a prompt (`<user_query>`, or a bare text
 * that no other user line follows), one line per reply step with its tool calls (results are not
 * recorded), and `turn_ended` after every Turn. A user line followed by another is context. A Turn
 * is keyed by the file's checksum through its prompt, so a rewritten history never reuses a key.
 */
export async function readCursorTranscript(path: string, nativeSessionId: string, signal?: AbortSignal): Promise<NativeTranscript> {
  const read = await readChainedLines(path, signal);
  const modified = (await stat(path)).mtime.toISOString();
  const turns: NativeTranscriptTurn[] = [];
  let current: NativeTranscriptTurn | null = null;
  for (const [index, line] of read.lines.entries()) {
    const value = line.value;
    if (value.role === "user") {
      const raw = blocks(value).map((block) => text(block.text)).join("\n");
      // A bare text is a prompt only once a reply or end follows it; until then it may be context.
      const next = read.lines[index + 1]?.value;
      const query = USER_QUERY.exec(raw)?.[1] ?? (next && next.role !== "user" ? raw.replace(TIMESTAMP, "").trim() : null);
      if (!query) continue;
      const startedAt: string = promptTime(TIMESTAMP.exec(raw)?.[1] ?? "") ?? current?.startedAt ?? modified;
      current = {
        key: line.sha256, parentKey: turns.at(-1)?.key ?? null, userContent: [{ type: "text", text: query }], messages: [], startedAt,
        startBytes: line.startBytes, endBytes: line.endBytes, contentEndBytes: line.endBytes, boundaries: {}, sha256: line.sha256, result: null,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (value.role === "assistant") {
      const content = blocks(value).flatMap((block, position): ContentBlock[] => {
        if (block.type === "text") return text(block.text) ? [{ type: "text", text: text(block.text) }] : [];
        if (block.type !== "tool_use") return [];
        return [{ type: "tool_use", id: `cursor_${line.sha256.slice(0, 24)}_${position}`, name: text(block.name) || "tool", input: record(block.input) }];
      });
      if (content.length) current.messages.push({ content, provider: null, model: null, stopReason: content.some((block) => block.type === "tool_use") ? "tool_use" : "stop", errorMessage: null });
      extendTurn(current, line, true);
      continue;
    }
    if (value.type === "turn_ended" && !current.result) {
      const status = text(value.status) || "success";
      const last: NativeTurnMessage | undefined = current.messages.at(-1);
      if (last && status === "error") Object.assign(last, { stopReason: "error", errorMessage: text(value.error) || "Turn failed" });
      if (last && status === "aborted") last.stopReason = "aborted";
      current.result = { messages: current.messages, completedAt: modified, status: status === "error" ? "failed" : status === "aborted" ? "interrupted" : "completed" };
      current.ended = true;
      extendTurn(current, line, false);
    }
  }
  // A Turn ends no later than the next one starts.
  turns.forEach((turn, index) => { if (turn.result) turn.result.completedAt = turns[index + 1]?.startedAt ?? modified; });
  return { nativeSessionId, cwd: (await cursorSessionHeader(path))?.cwd ?? "", turns, prefixes: read.prefixes };
}
