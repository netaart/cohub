import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RuntimeTraceContext } from "@neta-art/cohub";

export type RuntimeDiagnosticLevel = "debug" | "info" | "warn" | "error";

export type RuntimeDiagnosticError = {
  name?: string;
  message: string;
  code?: string;
  status?: number;
  syscall?: string;
  hostname?: string;
  causeCode?: string;
  causeMessage?: string;
  causeSyscall?: string;
  causeHostname?: string;
  traceContext?: RuntimeTraceContext;
  stack?: string;
};

export type RuntimeDiagnostic = {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  level: RuntimeDiagnosticLevel;
  component: string;
  event: string;
  runtimeId: string;
  connectionId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  harness?: "pi" | "codex" | null;
  traceContext?: RuntimeTraceContext;
  data?: Record<string, unknown>;
  error?: RuntimeDiagnosticError;
};

export type RuntimeDiagnosticContext = {
  component?: string;
  connectionId?: string | null;
  requestId?: string | null;
  spaceId?: string;
  sessionId?: string | null;
  turnId?: string | null;
  harness?: "pi" | "codex" | null;
  traceContext?: RuntimeTraceContext;
};

export type RuntimeDiagnosticsOptions = {
  root: string;
  runtimeId?: string;
  spaceId: string;
  component?: string;
  logFlushIntervalMs?: number;
  maxLogFileBytes?: number;
  maxTotalLogBytes?: number;
  /** Receives only the redacted event, before asynchronous disk I/O. */
  onEvent?: (event: RuntimeDiagnostic) => void;
};

export type ReadRuntimeDiagnosticsOptions = {
  limit?: number;
};

type BufferedDiagnostic = { event: RuntimeDiagnostic; line: string; bytes: number };
type DiagnosticReaderFileState = { offset: number; partial: string; decoder: StringDecoder };

const DEFAULT_LOG_FLUSH_INTERVAL_MS = 250;
const MAX_PENDING_LOG_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_LOG_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LOG_FILE_AGE_MS = 60 * 60 * 1_000;
const MAX_VALUE_STRING_LENGTH = 4_096;
const MAX_EVENT_BYTES = 48 * 1024;
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|access[_-]?key|refresh[_-]?token/i;
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const diagnosticsDirectoryName = "diagnostics";

export const runtimeDiagnosticsDirectory = (root: string) => join(root, diagnosticsDirectoryName);
export const runtimeDiagnosticsPath = (root: string, runtimeId: string) =>
  join(runtimeDiagnosticsDirectory(root), `${runtimeId}.jsonl`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    // Redaction must not rewrite the string when there is nothing to hide;
    // URL.toString() re-encodes (e.g. quotes from wrapped log lines) and
    // makes healthy URLs look corrupted.
    const sensitive = [...url.searchParams.keys()].some((key) => SENSITIVE_KEY.test(key));
    if (!sensitive) return value;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactDiagnosticString(value: string): string {
  const shortened = value.length > MAX_VALUE_STRING_LENGTH
    ? `${value.slice(0, MAX_VALUE_STRING_LENGTH)}…`
    : value;
  return shortened
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    // Trailing quotes/brackets from wrapped log lines are not part of the URL.
    .replace(/\b(rediss?|https?|wss?):\/\/[^\s"'<>]+/gi, (url) => redactUrl(url))
    .replace(/\b(authorization|password|secret|token|access[_-]?key|refresh[_-]?token)([\s:=]+)([^\s,;]+)/gi, "$1$2[REDACTED]");
}

function redactValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactDiagnosticString(value);
  if (depth > 5) return "[Truncated]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactValue(item, seen, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(nested, seen, depth + 1);
  }
  return output;
}

function normalizeDiagnosticTraceContext(value: unknown): RuntimeTraceContext | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = typeof value.requestId === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value.requestId)
    ? value.requestId
    : undefined;
  const traceId = typeof value.traceId === "string" && /^[0-9a-f]{32}$/i.test(value.traceId) ? value.traceId : undefined;
  const spanId = typeof value.spanId === "string" && /^[0-9a-f]{16}$/i.test(value.spanId) ? value.spanId : undefined;
  const traceparent = typeof value.traceparent === "string" && TRACEPARENT.test(value.traceparent) ? value.traceparent : undefined;
  if (!requestId && !traceId && !spanId && !traceparent) return undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    ...(traceparent ? { traceparent } : {}),
  };
}

export function serializeDiagnosticError(error: unknown): RuntimeDiagnosticError {
  if (!(error instanceof Error)) return { message: redactDiagnosticString(String(error)) };
  const source = error as Error & Record<string, unknown>;
  const result: RuntimeDiagnosticError = {
    message: error.message || error.name || "Unknown error",
    ...(error.name ? { name: error.name } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  };
  for (const key of ["code", "status", "syscall", "hostname"] as const) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value as never;
  }
  const cause = isRecord(source.cause) ? source.cause : null;
  const traceContext = normalizeDiagnosticTraceContext(source.traceContext);
  if (traceContext) result.traceContext = traceContext;
  if (typeof cause?.code === "string") result.causeCode = cause.code;
  if (typeof cause?.message === "string") result.causeMessage = cause.message;
  if (typeof cause?.syscall === "string") result.causeSyscall = cause.syscall;
  if (typeof cause?.hostname === "string") result.causeHostname = cause.hostname;
  return redactValue(result) as RuntimeDiagnosticError;
}

function compactEvent(event: RuntimeDiagnostic): RuntimeDiagnostic {
  let result = redactValue(event) as RuntimeDiagnostic;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_EVENT_BYTES) return result;
  result = {
    ...result,
    data: { truncated: true },
    ...(result.error ? { error: { ...result.error, stack: undefined } } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_EVENT_BYTES) return result;
  return {
    ...result,
    data: undefined,
    error: result.error ? { message: result.error.message, name: result.error.name } : undefined,
  };
}

function compareDiagnosticEvents(left: RuntimeDiagnostic, right: RuntimeDiagnostic): number {
  if (left.runtimeId === right.runtimeId) return left.sequence - right.sequence;
  return left.timestamp.localeCompare(right.timestamp) || left.runtimeId.localeCompare(right.runtimeId) || left.sequence - right.sequence;
}

export class RuntimeDiagnostics {
  readonly runtimeId: string;
  readonly directory: string;
  readonly logPath: string;

  private readonly spaceId: string;
  private readonly component: string;
  private readonly onEvent?: (event: RuntimeDiagnostic) => void;
  private readonly logFlushIntervalMs: number;
  private readonly maxLogFileBytes: number;
  private readonly maxTotalLogBytes: number;
  private readonly startedAtMs = Date.now();
  private readonly ready: Promise<void>;
  private logFile: Awaited<ReturnType<typeof open>> | null = null;
  private logFileSize = 0;
  private logFileStartedAt = 0;
  private writeChain = Promise.resolve();
  private writeBuffer: BufferedDiagnostic[] = [];
  private writeBufferBytes = 0;
  private droppedWriteEvents = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private closed = false;

  constructor(options: RuntimeDiagnosticsOptions) {
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.spaceId = options.spaceId;
    this.component = options.component ?? "runtime";
    this.onEvent = options.onEvent;
    this.logFlushIntervalMs = options.logFlushIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS;
    this.maxLogFileBytes = options.maxLogFileBytes ?? DEFAULT_MAX_LOG_FILE_BYTES;
    this.maxTotalLogBytes = options.maxTotalLogBytes ?? DEFAULT_MAX_TOTAL_LOG_BYTES;
    this.directory = runtimeDiagnosticsDirectory(options.root);
    this.logPath = runtimeDiagnosticsPath(options.root, this.runtimeId);
    this.ready = mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined);
  }

  log(
    level: RuntimeDiagnosticLevel,
    event: string,
    data?: Record<string, unknown>,
    context: RuntimeDiagnosticContext = {},
  ): void {
    if (this.closed) return;
    const traceContext = normalizeDiagnosticTraceContext(context.traceContext ?? (
      context.requestId ? { requestId: context.requestId } : undefined
    ));
    const rawError = data?.error;
    const diagnosticError = rawError instanceof Error
      ? serializeDiagnosticError(rawError)
      : isRecord(rawError) && typeof rawError.message === "string"
        ? redactValue(rawError) as RuntimeDiagnosticError
        : typeof rawError === "string"
          ? { message: redactDiagnosticString(rawError) }
          : undefined;
    const eventTraceContext = traceContext ?? normalizeDiagnosticTraceContext(diagnosticError?.traceContext);
    const eventData = data ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "error")) : undefined;
    const value = compactEvent({
      schemaVersion: 1,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAtMs,
      level,
      component: context.component ?? this.component,
      event,
      runtimeId: this.runtimeId,
      ...(context.connectionId ? { connectionId: context.connectionId } : {}),
      spaceId: context.spaceId ?? this.spaceId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.harness ? { harness: context.harness } : {}),
      ...(eventTraceContext ? { traceContext: eventTraceContext } : {}),
      ...(eventData && Object.keys(eventData).length > 0 ? { data: eventData } : {}),
      ...(diagnosticError ? { error: diagnosticError } : {}),
    });
    this.enqueueWrite(value);
    this.onEvent?.(value);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    await this.flushLogBuffer();
    await this.writeChain;
    if (this.logFile) {
      const file = this.logFile;
      this.logFile = null;
      await file.sync().catch(() => undefined);
      await file.close().catch(() => undefined);
    }
  }

  private enqueueWrite(event: RuntimeDiagnostic): void {
    let nextEvent = event;
    if (this.droppedWriteEvents > 0) {
      nextEvent = { ...event, data: { ...(event.data ?? {}), droppedDiagnosticsBeforeWrite: this.droppedWriteEvents } };
      this.droppedWriteEvents = 0;
    }
    const line = `${JSON.stringify(nextEvent)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    while (this.writeBufferBytes + bytes > MAX_PENDING_LOG_BYTES && this.writeBuffer.length > 0) {
      const index = this.writeBuffer.findIndex(({ event: queued }) => queued.level === "debug" || queued.level === "info");
      const removed = this.writeBuffer.splice(index >= 0 ? index : 0, 1)[0];
      if (removed) {
        this.writeBufferBytes -= removed.bytes;
        this.droppedWriteEvents += 1;
      }
    }
    if (this.writeBufferBytes + bytes > MAX_PENDING_LOG_BYTES && nextEvent.level !== "error") {
      this.droppedWriteEvents += 1;
      return;
    }
    this.writeBuffer.push({ event: nextEvent, line, bytes });
    this.writeBufferBytes += bytes;
    if (nextEvent.level === "error" || this.writeBufferBytes >= 64 * 1024) void this.flushLogBuffer();
    else this.scheduleLogFlush();
  }

  private scheduleLogFlush(): void {
    if (this.writeTimer || this.closed) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flushLogBuffer();
    }, this.logFlushIntervalMs);
  }

  private async flushLogBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0) return this.writeChain;
    const entries = this.writeBuffer;
    this.writeBuffer = [];
    this.writeBufferBytes = 0;
    this.writeChain = this.writeChain.then(() => this.writeEntries(entries)).catch(() => {
      // Local diagnostics must never take down the Runtime.
    });
    return this.writeChain;
  }

  private async writeEntries(entries: BufferedDiagnostic[]): Promise<void> {
    await this.ready;
    for (const entry of entries) {
      await this.ensureLogFile();
      const shouldRotate = this.logFileSize > 0 && (
        this.logFileSize + entry.bytes > this.maxLogFileBytes ||
        Date.now() - this.logFileStartedAt >= DEFAULT_MAX_LOG_FILE_AGE_MS
      );
      if (shouldRotate) {
        await this.rotateLog(entry.event.sequence);
        await this.ensureLogFile();
      }
      await this.logFile?.write(entry.line);
      this.logFileSize += entry.bytes;
    }
    await this.logFile?.sync();
  }

  private async ensureLogFile(): Promise<void> {
    if (this.logFile) return;
    this.logFile = await open(this.logPath, "a", 0o600);
    await this.logFile.chmod(0o600).catch(() => undefined);
    this.logFileSize = (await stat(this.logPath)).size;
    this.logFileStartedAt = Date.now();
  }

  private async rotateLog(nextSequence: number): Promise<void> {
    const file = this.logFile;
    this.logFile = null;
    if (file) {
      await file.sync();
      await file.close();
    }
    await rename(this.logPath, join(this.directory, `${this.runtimeId}-${nextSequence}-${Date.now()}.jsonl`));
    this.logFileSize = 0;
    this.logFileStartedAt = 0;
    await this.enforceLogCapacity();
  }

  private async enforceLogCapacity(): Promise<void> {
    const names = await readdir(this.directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const files = await Promise.all(names.filter((name) => name.endsWith(".jsonl") && name !== `${this.runtimeId}.jsonl`).map(async (name) => {
      const path = join(this.directory, name);
      const info = await stat(path).catch(() => null);
      return info ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
    }));
    let total = this.logFileSize + files.reduce((sum, file) => sum + (file?.size ?? 0), 0);
    for (const file of files.filter((value): value is { path: string; size: number; mtimeMs: number } => value !== null).sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= this.maxTotalLogBytes) break;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }
}

export class RuntimeDiagnosticReader {
  private readonly files = new Map<string, DiagnosticReaderFileState>();
  private readonly lastSequenceByRuntime = new Map<string, number>();
  private initialized = false;
  constructor(readonly root: string) {}

  async read(options: { limit?: number } = {}): Promise<RuntimeDiagnostic[]> {
    const directory = runtimeDiagnosticsDirectory(this.root);
    const names = await readdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const fileEntries = await Promise.all(names.filter((value) => value.endsWith(".jsonl")).map(async (name) => {
      const path = join(directory, name);
      const info = await stat(path).catch(() => null);
      return info ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
    }));
    const events: RuntimeDiagnostic[] = [];
    for (const file of fileEntries.filter((value): value is { path: string; size: number; mtimeMs: number } => value !== null).sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      const state = this.files.get(file.path) ?? { offset: 0, partial: "", decoder: new StringDecoder("utf8") };
      if (file.size < state.offset) {
        state.offset = 0;
        state.partial = "";
        state.decoder = new StringDecoder("utf8");
      }
      const stream = createReadStream(file.path, { start: state.offset });
      let bytesRead = 0;
      let text = state.partial;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytesRead += buffer.length;
        text += state.decoder.write(buffer);
      }
      state.offset += bytesRead;
      const lines = text.split("\n");
      state.partial = lines.pop() ?? "";
      this.files.set(file.path, state);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value: unknown = JSON.parse(line);
          if (isRecord(value) && value.schemaVersion === 1 && typeof value.sequence === "number") events.push(value as RuntimeDiagnostic);
        } catch {
          // Ignore only the damaged line; source files remain untouched.
        }
      }
    }

    events.sort(compareDiagnosticEvents);
    const fresh = events.filter((event) => event.sequence > (this.lastSequenceByRuntime.get(event.runtimeId) ?? -1));
    for (const event of fresh) this.lastSequenceByRuntime.set(event.runtimeId, event.sequence);
    if (!this.initialized) {
      this.initialized = true;
      const limit = options.limit ?? 100;
      return limit > 0 ? fresh.slice(-limit) : fresh;
    }
    return fresh;
  }
}

export async function readRuntimeDiagnosticEvents(
  root: string,
  options: ReadRuntimeDiagnosticsOptions = {},
): Promise<RuntimeDiagnostic[]> {
  return new RuntimeDiagnosticReader(root).read(options);
}

export function isValidRuntimeTraceparent(value: string | null | undefined): value is string {
  return typeof value === "string" && TRACEPARENT.test(value);
}
