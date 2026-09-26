import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-agent" });
export type SessionAffinity = {
  sessionId: string;
  threadId: string;
};

export type SessionHeader = {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  affinity?: SessionAffinity;
  /** Relative path to the pre-compaction archive, set when the file is rewritten after compaction. */
  compactionArchive?: string;
};

export type SessionEntryBase = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type SessionMessageEntry = SessionEntryBase & {
  type: "message";
  message: AgentMessage;
};

export type ThinkingLevelChangeEntry = SessionEntryBase & {
  type: "thinking_level_change";
  thinkingLevel: string;
};

export type ModelChangeEntry = SessionEntryBase & {
  type: "model_change";
  provider: string;
  modelId: string;
};

export type CompactionEntry = SessionEntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
};

export type CustomEntry = SessionEntryBase & {
  type: "custom";
  customType: string;
  data?: unknown;
};

export type CustomMessageEntry = SessionEntryBase & {
  type: "custom_message";
  customType: string;
  content: unknown;
  display: boolean;
  details?: unknown;
};

export type SessionInfoEntry = SessionEntryBase & {
  type: "session_info";
  name?: string;
};

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | CustomEntry
  | CustomMessageEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export type SessionContext = {
  messages: AgentMessage[];
  /** Latest recorded thinking level, or null when the file has no thinking_level_change. */
  thinkingLevel: string | null;
  model: { provider: string; modelId: string } | null;
};

const SESSION_SETTING_ENTRY_TYPES = ["model_change", "thinking_level_change"] as const;

/** Settings that live before firstKeptEntryId must be copied into the rewritten file. */
function settingsToCarryForward(branch: SessionEntry[], keptIds: Set<string>): SessionEntry[] {
  const latest = new Map<string, SessionEntry>();
  for (const entry of branch) {
    if (entry.type === "model_change" || entry.type === "thinking_level_change") latest.set(entry.type, entry);
  }
  const carried: SessionEntry[] = [];
  for (const type of SESSION_SETTING_ENTRY_TYPES) {
    const entry = latest.get(type);
    if (entry && !keptIds.has(entry.id)) carried.push(entry);
  }
  return carried;
}

function nowIso() {
  return new Date().toISOString();
}

function generateEntryId(existing: { has(id: string): boolean }) {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

function createSessionId() {
  return randomUUID();
}

function serializeJsonlEntry(entry: FileEntry): string {
  const json = JSON.stringify(entry);
  if (json === undefined) throw new TypeError("Session entry is not JSON serializable");
  // JSON permits U+2028/U+2029 in strings, but Node readline treats them as line endings.
  // Escape these two characters so one LF always represents exactly one JSONL record.
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// Node readline also treats U+2028/U+2029 as line endings, although JSON permits them in strings.
async function* readLfDelimitedLines(path: string): AsyncGenerator<{ line: string; terminated: boolean }> {
  const input = createReadStream(path, { encoding: "utf-8" });
  let fragments: string[] = [];

  for await (const chunk of input) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) break;
      fragments.push(text.slice(start, newline));
      let line = fragments.join("");
      fragments = [];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield { line, terminated: true };
      start = newline + 1;
    }
    if (start < text.length) fragments.push(text.slice(start));
  }

  if (fragments.length > 0) yield { line: fragments.join(""), terminated: false };
}

function getAgentMessageMeta(message: AgentMessage): Record<string, unknown> | null {
  const meta = (message as unknown as { meta?: unknown }).meta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : null;
}

function getSessionUserMessageId(message: AgentMessage): string | null {
  const meta = getAgentMessageMeta(message);
  const messageId = meta?.messageId;
  if (typeof messageId === "string" && messageId.trim()) return messageId.trim();
  const userMessageId = meta?.userMessageId;
  if (typeof userMessageId === "string" && userMessageId.trim()) return userMessageId.trim();
  return null;
}

function getSessionTurnId(message: AgentMessage): string | null {
  const meta = getAgentMessageMeta(message);
  const turnId = meta?.turnId;
  return typeof turnId === "string" && turnId.trim() ? turnId.trim() : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function syncFile(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function archiveAndReplaceSessionFile(path: string, sessionDir: string, replacement: Uint8Array): Promise<string> {
  const recoveryDir = join(sessionDir, "archives", "recovery");
  await mkdir(recoveryDir, { recursive: true });
  const recoveryId = randomUUID();
  const archivePath = join(recoveryDir, `${basename(path)}.${recoveryId}.partial`);
  const tempPath = join(dirname(path), `.${basename(path)}.${recoveryId}.recovered`);

  await copyFile(path, archivePath);
  await syncFile(archivePath);
  await syncFile(recoveryDir);
  try {
    await writeFile(tempPath, replacement);
    await syncFile(tempPath);
    await rename(tempPath, path);
    await syncFile(dirname(path));
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return archivePath;
}

async function recoverTrailingPartialEntry(path: string, sessionDir: string, failedLine: number): Promise<string | null> {
  const raw = await readFile(path);
  if (raw.length === 0 || raw.at(-1) === 0x0a) return null;

  const lastNewline = raw.lastIndexOf(0x0a);
  if (lastNewline < 0) return null;
  const completeLineCount = raw.subarray(0, lastNewline + 1).reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  if (failedLine !== completeLineCount + 1) return null;
  return archiveAndReplaceSessionFile(path, sessionDir, raw.subarray(0, lastNewline + 1));
}

async function repairMissingFinalNewline(path: string, sessionDir: string): Promise<string | null> {
  const raw = await readFile(path);
  if (raw.length === 0 || raw.at(-1) === 0x0a) return null;
  return archiveAndReplaceSessionFile(path, sessionDir, Buffer.concat([raw, Buffer.from("\n")]));
}

async function parseEntries(
  path: string,
  options: { sessionDir?: string; recoverTrailingPartial?: boolean } = {},
): Promise<FileEntry[]> {
  if (!(await pathExists(path))) return [];
  const entries: FileEntry[] = [];
  let finalLineTerminated = true;
  let lineNumber = 0;
  for await (const { line, terminated } of readLfDelimitedLines(path)) {
    finalLineTerminated = terminated;
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch (error) {
      if (options.recoverTrailingPartial && options.sessionDir && entries[0]?.type === "session") {
        const archivePath = await recoverTrailingPartialEntry(path, options.sessionDir, lineNumber);
        if (archivePath) {
          logger.warn(`[SessionManager] recovered trailing partial JSONL entry path=${path} archive=${archivePath}`);
          return parseEntries(path);
        }
      }
      throw new Error(`Invalid session JSONL ${path}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.recoverTrailingPartial && options.sessionDir && entries[0]?.type === "session" && !finalLineTerminated) {
    const archivePath = await repairMissingFinalNewline(path, options.sessionDir);
    if (archivePath) logger.warn(`[SessionManager] repaired missing final JSONL newline path=${path} archive=${archivePath}`);
  }
  return entries;
}

export class SessionManager {
  private header: SessionHeader | null = null;
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private userMessageIds = new Set<string>();
  private userMessageEntryIds = new Map<string, string>();
  private leafId: string | null = null;
  public sessionFile?: string;
  private fileReady = false;
  private sessionDirReady = false;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  /** Persistent append stream — keeps the fd open to avoid per-write open/close overhead on NFS. */
  private appendStream: WriteStream | null = null;

  private constructor(
    private readonly cwd: string,
    private readonly sessionDir: string,
    sessionFile?: string,
    parsed: FileEntry[] = [],
  ) {
    this.sessionFile = sessionFile;
    if (parsed.length > 0) {
      this.header = (parsed.find((entry) => entry.type === "session") as SessionHeader | undefined) ?? null;
      this.entries = parsed.filter((entry) => entry.type !== "session") as SessionEntry[];
      this.rebuildIndex();
      this.fileReady = Boolean(sessionFile && this.header);
    }
  }

  static create(cwd: string, sessionDir: string): SessionManager {
    return new SessionManager(cwd, sessionDir);
  }

  static async open(
    path: string,
    sessionDir: string,
    options: { recoverTrailingPartial?: boolean } = {},
  ): Promise<SessionManager> {
    const parsed = await parseEntries(path, { sessionDir, recoverTrailingPartial: options.recoverTrailingPartial });
    const header = parsed.find((entry) => entry.type === "session") as SessionHeader | undefined;
    const cwd = header?.cwd ?? process.cwd();
    return new SessionManager(cwd, sessionDir, path, parsed);
  }

  setSessionFile(path: string) {
    this.sessionFile = path;
    this.fileReady = false;
    this.rewriteFile();
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.writeError) {
      throw this.writeError;
    }
  }

  /** Flush pending writes and close the persistent append stream. */
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.closeAppendStream();
    }
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  serializeSnapshot(): string {
    if (!this.header) throw new Error("Session has not been initialized");
    return `${[this.header, ...this.entries].map(serializeJsonlEntry).join("\n")}\n`;
  }

  getMessageMetaValues(key: string, role?: string): Set<string> {
    const values = new Set<string>();
    for (const entry of this.getBranch()) {
      if (entry.type !== "message") continue;
      if (role && entry.message.role !== role) continue;
      const meta = (entry.message as unknown as { meta?: unknown }).meta;
      const value = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>)[key] : null;
      if (typeof value === "string") values.add(`${value}:${entry.message.role}`);
    }
    return values;
  }

  getCustomEntries(customType: string): CustomEntry[] {
    return this.getBranch().filter(
      (entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType,
    );
  }

  findUserMessageEntryId(userMessageId: string): string | null {
    return this.userMessageEntryIds.get(userMessageId.trim()) ?? null;
  }

  /** Returns the linear branch from root to current leaf. */
  getBranchEntries(): SessionEntry[] {
    return this.getBranch();
  }

  /**
   * Find the entry ID of the user message that starts the turn containing
   * the given entry. If the entry itself is a user message, returns its ID.
   * Returns null if no turn-start user message is found.
   */
  findTurnStartEntryId(entryId: string): string | null {
    const branch = this.getBranch();
    const idx = branch.findIndex((e) => e.id === entryId);
    if (idx < 0) return null;
    for (let i = idx; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message.role === "user") {
        return entry.id;
      }
    }
    return null;
  }

  /**
   * Get the turnId from the entry at the given ID.
   * Returns null if the entry is not a message or has no turnId.
   */
  getEntryTurnId(entryId: string): string | null {
    const entry = this.byId.get(entryId);
    if (entry?.type === "message") {
      return getSessionTurnId(entry.message);
    }
    return null;
  }

  /**
   * Find the turnId of the first kept entry, starting from firstKeptEntryId
   * and scanning forward through the branch. Handles entries without turnId
   * (e.g. model_change, thinking_level_change) by skipping them.
   */
  getFirstKeptTurnId(firstKeptEntryId: string): string | null {
    const branch = this.getBranch();
    const startIdx = branch.findIndex((e) => e.id === firstKeptEntryId);
    if (startIdx < 0) return null;
    for (let i = startIdx; i < branch.length; i++) {
      const entry = branch[i];
      if (entry?.type === "message") {
        const turnId = getSessionTurnId(entry.message);
        if (turnId) return turnId;
      }
    }
    return null;
  }

  getSessionId(): string {
    if (!this.header) throw new Error("Session has not been initialized");
    return this.header.id;
  }

  getSessionAffinity(): SessionAffinity {
    if (!this.header) throw new Error("Session has not been initialized");
    return this.header.affinity ?? { sessionId: this.header.id, threadId: this.header.id };
  }

  newSession(options: { id?: string; parentSession?: string }) {
    const sessionId = options.id ?? createSessionId();
    this.header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: nowIso(),
      cwd: this.cwd,
      parentSession: options.parentSession,
      affinity: { sessionId, threadId: sessionId },
    };
    this.entries = [];
    this.byId.clear();
    this.userMessageIds.clear();
    this.leafId = null;
    this.fileReady = false;
    this.rewriteFile();
  }

  buildSessionContext(): SessionContext {
    const branch = this.getBranch();

    // Scan all entries for the latest settings (model/thinking persist across compaction boundaries).
    let thinkingLevel: string | null = null;
    let model: { provider: string; modelId: string } | null = null;
    let compaction: CompactionEntry | null = null;
    for (const entry of branch) {
      if (entry.type === "thinking_level_change") {
        thinkingLevel = entry.thinkingLevel;
      } else if (entry.type === "model_change") {
        model = { provider: entry.provider, modelId: entry.modelId };
      } else if (entry.type === "message" && entry.message.role === "assistant") {
        const msg = entry.message as unknown as { provider?: string; model?: string };
        if (msg.provider && msg.model) model = { provider: msg.provider, modelId: msg.model };
      } else if (entry.type === "compaction") {
        compaction = entry;
      }
    }

    const messages: AgentMessage[] = [];
    const appendMessage = (entry: SessionEntry) => {
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (entry.type === "custom_message") {
        messages.push({ role: "user", content: entry.content as never, timestamp: Date.now() } as AgentMessage);
      }
    };

    if (compaction) {
      // Prepend a compactionSummary message, then only entries from firstKeptEntryId onward.
      messages.push({
        role: "compactionSummary",
        summary: compaction.summary,
        tokensBefore: compaction.tokensBefore,
        timestamp: new Date(compaction.timestamp).getTime(),
      } as AgentMessage);

      const compactionIdx = branch.findIndex((e) => e.id === compaction?.id);
      const firstKeptIdx = branch.findIndex((e) => e.id === compaction.firstKeptEntryId);

      if (compactionIdx === 0) {
        // Post-rewrite layout: compaction is root, all other entries are kept.
        // No filtering needed — the file was already trimmed by archiveAndRewrite.
        for (let i = 1; i < branch.length; i++) {
          const entry = branch[i];
          if (entry) appendMessage(entry);
        }
      } else if (firstKeptIdx < 0 || firstKeptIdx >= compactionIdx) {
        // Pre-rewrite layout (compaction at end) but firstKeptEntryId not found
        // before compaction — fallback to avoid silent data loss.
        logger.warn(`[SessionManager] firstKeptEntryId ${compaction.firstKeptEntryId} not found before compaction; including all pre-compaction entries`);
        for (let i = 0; i < compactionIdx; i++) {
          const entry = branch[i];
          if (entry) appendMessage(entry);
        }
      } else {
        // Pre-rewrite layout: include entries from firstKeptEntryId to compaction.
        let foundFirstKept = false;
        for (let i = 0; i < compactionIdx; i++) {
          const entry = branch[i];
          if (!entry) continue;
          if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
          if (foundFirstKept) appendMessage(entry);
        }
      }
      if (compactionIdx > 0) {
        // Post-compaction entries only in pre-rewrite layouts. When the
        // compaction entry is the root, the post-rewrite loop above already
        // appended every kept entry once — appending again would duplicate
        // the entire context in every request.
        for (let i = compactionIdx + 1; i < branch.length; i++) {
          const entry = branch[i];
          if (entry) appendMessage(entry);
        }
      }
    } else {
      for (const entry of branch) appendMessage(entry);
    }

    return { messages, thinkingLevel, model };
  }

  hasUserMessage(userMessageId: string): boolean {
    const normalizedUserMessageId = userMessageId.trim();
    return normalizedUserMessageId ? this.userMessageIds.has(normalizedUserMessageId) : false;
  }

  appendMessage(message: AgentMessage, options?: { id?: string }): string {
    const entryId = options?.id && !this.byId.has(options.id) ? options.id : generateEntryId(this.byId);
    const entry: SessionMessageEntry = {
      type: "message",
      id: entryId,
      parentId: this.leafId,
      timestamp: nowIso(),
      message,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: nowIso(),
      provider,
      modelId,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: ThinkingLevelChangeEntry = {
      type: "thinking_level_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: nowIso(),
      thinkingLevel,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: nowIso(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: nowIso(),
      customType,
      data,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomMessageEntry(customType: string, content: unknown, display: boolean, details?: unknown): string {
    const entry: CustomMessageEntry = {
      type: "custom_message",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: nowIso(),
      customType,
      content,
      display,
      details,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: nowIso(),
      name,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  /**
   * Archive the current file and rewrite it with only post-compaction entries.
   * The archive preserves the full pre-compaction history on disk.
   * Returns the relative archive path (stored in the header).
   */
  async archiveAndRewrite(compactionEntryId: string, firstKeptEntryId: string): Promise<string | undefined> {
    if (!this.sessionFile || !this.header) return undefined;
    await this.flush();

    const branch = this.getBranch();
    const compactionIdx = branch.findIndex((e) => e.id === compactionEntryId);
    if (compactionIdx < 0) return undefined;

    const firstKeptIdx = branch.findIndex((e) => e.id === firstKeptEntryId);
    if (firstKeptIdx < 0 || firstKeptIdx >= compactionIdx) return undefined;

    // Archive: copy the current file before rewriting.
    // Sanitize header.id to prevent path traversal (it comes from file parsing).
    const safeId = this.header.id.replace(/[^a-zA-Z0-9-]/g, "");
    const archiveName = `${safeId}.${this.nextArchiveNumber()}.jsonl`;
    const archiveDir = join(this.sessionDir, "archives");
    await mkdir(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, archiveName);
    await copyFile(this.sessionFile, archivePath);

    // Rewrite: compaction entry becomes the new root (parentId: null),
    // followed by carried model/thinking settings, kept entries from
    // firstKeptEntryId onward, then any entries appended after compaction.
    // Fix the parentId chain so getBranch() can walk leaf → root uninterrupted.
    const compactionEntry = branch[compactionIdx];
    if (compactionEntry?.type !== "compaction") return undefined;
    const keptBefore = branch.slice(firstKeptIdx, compactionIdx);
    const keptAfter = branch.slice(compactionIdx + 1);
    const keptIds = new Set([...keptBefore, ...keptAfter].map((entry) => entry.id));
    const carried = settingsToCarryForward(branch, keptIds);
    const middle = [...carried, ...keptBefore];

    // Rebuild chain: compaction → carried settings → firstKept → ... → leaf
    const rewrittenCompaction: CompactionEntry = { ...compactionEntry, parentId: null };
    const rewrittenMiddle: SessionEntry[] = middle.map((entry, i) => ({
      ...entry,
      parentId: i === 0 ? compactionEntry.id : (middle[i - 1]?.id ?? compactionEntry.id),
    }));
    // keptAfter entries already chain to each other; fix the first one's parent
    // to point to the last entry in the middle chain (or compaction if empty).
    const rewrittenAfter: SessionEntry[] = keptAfter.length > 0
      ? keptAfter.map((entry, i) => ({
          ...entry,
          parentId: i === 0
            ? (rewrittenMiddle.at(-1)?.id ?? compactionEntry.id)
            : (keptAfter[i - 1]?.id ?? null),
        }))
      : [];

    const keptEntries = [rewrittenCompaction, ...rewrittenMiddle, ...rewrittenAfter];

    // Snapshot state so we can roll back if the file rewrite fails.
    const savedHeader = this.header;
    const savedEntries = this.entries;

    this.header = { ...this.header, compactionArchive: `archives/${archiveName}` };
    this.entries = keptEntries;
    this.rebuildIndex();
    this.fileReady = false;
    this.rewriteFile();
    try {
      await this.flush();
    } catch (flushError) {
      // Restore in-memory state to pre-rewrite. The file on disk may be
      // stale (old content + appended compaction entry), but removeLastEntry
      // will be called by the caller to rewrite it back to the old state.
      this.header = savedHeader;
      this.entries = savedEntries;
      this.rebuildIndex();
      this.fileReady = false;
      this.writeError = null;
      this.rewriteFile();
      throw flushError;
    }
    return `archives/${archiveName}`;
  }

  private nextArchiveNumber(): number {
    const match = this.header?.compactionArchive?.match(/\.(\d+)\.jsonl$/);
    return match ? Number(match[1]) + 1 : 1;
  }

  /**
   * Remove the last appended entry and restore the previous leaf.
   * Used to roll back an appendCompaction when archiveAndRewrite fails
   * *before* rewriting (returns undefined). The entry is still at the end.
   * Rewrites the file so the stale compaction entry is removed from disk too.
   */
  removeLastEntry(): void {
    if (this.entries.length === 0) return;
    const removed = this.entries[this.entries.length - 1];
    if (!removed) return;
    // Safety: only roll back if the last entry is a compaction entry.
    if (removed.type !== "compaction") {
      logger.warn(`[SessionManager] removeLastEntry: last entry is ${removed.type}, not compaction; skipping`);
      return;
    }
    this.entries.pop();
    this.byId.delete(removed.id);
    this.leafId = this.entries.at(-1)?.id ?? null;
    this.rebuildBranchUserMessageIndex();
    // The stale compaction entry was already appended to disk. Rewrite to
    // remove it. Clear writeError first so the rewrite is not skipped.
    if (this.writeError) {
      logger.warn("[SessionManager] clearing writeError during removeLastEntry rollback");
      this.writeError = null;
    }
    this.fileReady = false;
    this.rewriteFile();
  }

  /**
   * Restore the full pre-compaction state by reloading from the archive file.
   * Used when DB persistence fails *after* archiveAndRewrite succeeded.
   * At that point the compaction entry is root (index 0), not last, so
   * removeLastEntry cannot be used.
   */
  async restoreFromArchive(archivePath: string): Promise<boolean> {
    if (!this.sessionFile) return false;
    const fullArchivePath = join(this.sessionDir, archivePath);
    if (!(await pathExists(fullArchivePath))) return false;
    const parsed = await parseEntries(fullArchivePath);
    const header = parsed.find((e) => e.type === "session") as SessionHeader | undefined;
    if (!header) return false;
    const entries = parsed.filter((e) => e.type !== "session") as SessionEntry[];
    this.header = { ...header, compactionArchive: undefined };
    this.entries = entries;
    this.rebuildIndex();
    this.fileReady = false;
    this.writeError = null;
    this.rewriteFile();
    await this.flush();
    return true;
  }

  async createBranchedSession(leafId: string, options?: { id?: string; filePath?: string; parentSession?: string }): Promise<string | undefined> {
    await this.flush();
    let pathEntries = this.getBranch(leafId);

    // If the entry was removed by compaction, try to recover from the archive chain.
    // Each compaction archives the full pre-compaction file; the entry may exist there.
    if (pathEntries.length === 0 && this.header?.compactionArchive) {
      pathEntries = await this.recoverBranchFromArchive(leafId);
    }

    if (pathEntries.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }
    const newSessionId = options?.id ?? createSessionId();
    const newSessionFile = options?.filePath ?? join(this.sessionDir, `${newSessionId}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      version: 3,
      id: newSessionId,
      timestamp: nowIso(),
      cwd: this.cwd,
      parentSession: options?.parentSession ?? this.sessionFile,
      affinity: { sessionId: this.getSessionAffinity().sessionId, threadId: newSessionId },
    };
    await this.ensureSessionDir();
    const lines = `${[serializeJsonlEntry(header), ...pathEntries.map((entry) => serializeJsonlEntry(entry))].join("\n")}\n`;
    await writeFile(newSessionFile, lines, "utf-8");
    return newSessionFile;
  }

  /**
   * Walk the compactionArchive chain to find a branch path ending at leafId.
   * Each archive is a full pre-compaction snapshot. We load each archive,
   * try getBranch, and if found return the path. If not found, follow the
   * archive's own compactionArchive link further back.
   */
  private async recoverBranchFromArchive(leafId: string): Promise<SessionEntry[]> {
    let archivePath = this.header?.compactionArchive;
    let depth = 0;
    while (archivePath && depth < 32) {
      depth++;
      const fullPath = join(this.sessionDir, archivePath);
      if (!(await pathExists(fullPath))) break;
      const parsed = await parseEntries(fullPath);
      const archiveHeader = parsed.find((e) => e.type === "session") as SessionHeader | undefined;
      const entries = parsed.filter((e) => e.type !== "session") as SessionEntry[];
      const byId = new Map(entries.map((e) => [e.id, e]));
      // Walk from leafId to root within this archive's entries.
      const path: SessionEntry[] = [];
      let current = byId.get(leafId);
      while (current) {
        path.push(current);
        current = current.parentId ? (byId.get(current.parentId) ?? undefined) : undefined;
      }
      if (path.length > 0) {
        path.reverse();
        return path;
      }
      // Not found in this archive — go deeper.
      archivePath = archiveHeader?.compactionArchive;
    }
    return [];
  }

  private appendEntry(entry: SessionEntry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.indexBranchUserMessage(entry);
    this.appendToFile(entry);
  }

  private enqueueWrite(label: string, task: () => Promise<void>) {
    if (this.writeError) return;

    this.writeChain = this.writeChain
      .then(async () => {
        if (this.writeError) return;
        await task();
      })
      .catch((error) => {
        this.writeError = error;
        logger.error(`[SessionManager] Failed to write session file (${label}) ${this.sessionFile ?? "<unset>"}:`, error);
      });
  }

  private appendToFile(entry: SessionEntry) {
    if (!this.sessionFile) return;
    if (!this.fileReady) {
      this.rewriteFile();
      return;
    }

    this.enqueueWrite(`append:${entry.id}`, async () => {
      if (!this.sessionFile || this.writeError) return;
      const stream = this.getAppendStream();
      if (!stream || stream.destroyed) return;
      await new Promise<void>((resolve, reject) => {
        stream.write(`${serializeJsonlEntry(entry)}\n`, (error) => (error ? reject(error) : resolve()));
      });
    });
  }

  private getAppendStream(): WriteStream | null {
    if (!this.sessionFile) return null;
    if (!this.appendStream) {
      const stream = createWriteStream(this.sessionFile, { flags: "a", encoding: "utf-8" });
      stream.on("error", (error) => {
        this.appendStream = null;
        this.writeError = error;
        logger.error(`[SessionManager] Append stream error ${this.sessionFile ?? "<unset>"}:`, error);
      });
      this.appendStream = stream;
    }
    return this.appendStream;
  }

  private async closeAppendStream(): Promise<void> {
    const stream = this.appendStream;
    if (!stream) return;
    this.appendStream = null;
    if (stream.destroyed) return;
    await new Promise<void>((resolve) => {
      stream.end(resolve);
    });
  }

  private rewriteFile() {
    if (!this.sessionFile || !this.header) return;
    this.enqueueWrite("rewrite", async () => {
      if (!this.sessionFile || !this.header) return;
      await this.ensureSessionDir();
      await this.closeAppendStream();
      const lines = [serializeJsonlEntry(this.header), ...this.entries.map((entry) => serializeJsonlEntry(entry))].join("\n");
      await writeFile(this.sessionFile, `${lines}${lines ? "\n" : ""}`, "utf-8");
      this.fileReady = true;
    });
  }

  private async ensureSessionDir() {
    if (this.sessionDirReady) return;
    await mkdir(this.sessionDir, { recursive: true });
    this.sessionDirReady = true;
  }

  private indexBranchUserMessage(entry: SessionEntry) {
    if (entry.type !== "message") return;
    const userMessageId = getSessionUserMessageId(entry.message);
    if (!userMessageId) return;
    this.userMessageIds.add(userMessageId);
    this.userMessageEntryIds.set(userMessageId, entry.id);
  }

  private rebuildBranchUserMessageIndex() {
    this.userMessageIds = new Set();
    this.userMessageEntryIds = new Map();
    for (const entry of this.getBranch()) this.indexBranchUserMessage(entry);
  }

  private rebuildIndex() {
    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    this.leafId = this.entries.at(-1)?.id ?? null;
    this.rebuildBranchUserMessageIndex();
  }

  private getBranch(fromId?: string): SessionEntry[] {
    const targetId = fromId ?? this.leafId;
    if (!targetId) return [];
    const path: SessionEntry[] = [];
    let current = this.byId.get(targetId) ?? null;
    while (current) {
      path.push(current);
      current = current.parentId ? (this.byId.get(current.parentId) ?? null) : null;
    }
    return path.reverse();
  }
}
