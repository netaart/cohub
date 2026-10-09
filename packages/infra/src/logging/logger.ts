import os from "node:os";
import { trace } from "@opentelemetry/api";
import { getCurrentRequestId } from "../tracing/request-context.js";
import { serviceNameFromEnv } from "../tracing/service-name.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export type LogMeta = Record<string, unknown>;

export type LoggerOptions = {
  serviceName: string;
  environment?: string;
  version?: string;
  defaultMeta?: LogMeta;
  defaultLevel?: LogLevel;
};

export type Logger = {
  readonly level: LogLevel;
  isErrorEnabled(): boolean;
  isWarnEnabled(): boolean;
  isInfoEnabled(): boolean;
  isDebugEnabled(): boolean;
  isTraceEnabled(): boolean;
  error(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  log(message: unknown, ...args: unknown[]): void;
  debug(message: unknown, ...args: unknown[]): void;
  trace(message: unknown, ...args: unknown[]): void;
};

const LEVEL_VALUES: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

const LOG_LEVELS = new Set<LogLevel>(["silent", "error", "warn", "info", "debug", "trace"]);

export function normalizeLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.has(normalized as LogLevel) ? (normalized as LogLevel) : fallback;
}

export function redactSensitiveData(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (input: unknown): unknown => {
    if (input == null) return input;
    if (input instanceof Error) return serializeError(input);
    if (typeof input === "string") return redactSensitiveString(input);
    if (typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);

    if (Array.isArray(input)) return input.map(visit);

    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(input as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : visit(nestedValue);
    }
    return output;
  };
  return visit(value);
}

function isSensitiveKey(key: string) {
  return /authorization|cookie|password|secret|token|access[_-]?key|access[_-]?token|refresh[_-]?token/i.test(key);
}

export function redactSensitiveString(value: string): string {
  return value
    .replace(/\b(rediss?:\/\/)([^@\s/]+)@/gi, "$1[REDACTED]@")
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]+[?][^\s]*)/g, (url) => redactUrlQuery(url))
    .replace(/\b(authorization|password|secret|token|access[_-]?key|access[_-]?token|refresh[_-]?token)([\s:=]+)([^\s,;]+)/gi, "$1$2[REDACTED]");
}

function redactUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function serializeError(error: Error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...Object.fromEntries(Object.entries(error).map(([key, value]) => [key, redactSensitiveData(value)])),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeMessage(message: unknown) {
  if (typeof message === "string") return redactSensitiveString(message);
  if (message instanceof Error) return message.message;
  return safeJson(message);
}

function normalizeArgs(args: unknown[]) {
  if (args.length === 0) return {};

  const meta: LogMeta = {};
  const extras: unknown[] = [];

  for (const arg of args) {
    if (arg instanceof Error) {
      meta.error = serializeError(arg);
    } else if (isPlainRecord(arg)) {
      Object.assign(meta, redactSensitiveData(arg));
    } else {
      extras.push(redactSensitiveData(arg));
    }
  }

  if (extras.length > 0) meta.args = extras;
  return meta;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(redactSensitiveData(value));
  } catch {
    return "[unserializable]";
  }
}

function getTraceMeta() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  const requestId = getCurrentRequestId();
  return {
    ...(requestId ? { request_id: requestId } : {}),
    ...(spanContext?.traceId ? { trace_id: spanContext.traceId } : {}),
    ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
  };
}

function writeLine(_level: LogLevel, entry: Record<string, unknown>) {
  // Keep structured application logs on stdout so LoongCollector can treat the
  // app stream as one ordered JSON source. Stderr is still collected for Node
  // runtime crashes and non-JSON dependency output.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const configuredLevel = normalizeLogLevel(process.env.LOG_LEVEL, options.defaultLevel ?? "info");
  const serviceName = serviceNameFromEnv(options.serviceName);
  const environment = options.environment ?? process.env.ENV ?? "dev";
  const version = options.version ?? process.env.IMAGE_TAG ?? "latest";
  const hostname = process.env.POD_NAME ?? process.env.HOSTNAME ?? os.hostname();

  const enabled = (level: LogLevel) => LEVEL_VALUES[configuredLevel] >= LEVEL_VALUES[level];

  const emit = (level: LogLevel, message: unknown, args: unknown[]) => {
    if (!enabled(level)) return;
    writeLine(level, {
      timestamp: new Date().toISOString(),
      level,
      service: serviceName,
      env: environment,
      version,
      hostname,
      message: normalizeMessage(message),
      ...getTraceMeta(),
      ...options.defaultMeta,
      ...(message instanceof Error ? { error: serializeError(message) } : {}),
      ...normalizeArgs(args),
    });
  };

  return {
    get level() {
      return configuredLevel;
    },
    isErrorEnabled: () => enabled("error"),
    isWarnEnabled: () => enabled("warn"),
    isInfoEnabled: () => enabled("info"),
    isDebugEnabled: () => enabled("debug"),
    isTraceEnabled: () => enabled("trace"),
    error: (message, ...args) => emit("error", message, args),
    warn: (message, ...args) => emit("warn", message, args),
    info: (message, ...args) => emit("info", message, args),
    log: (message, ...args) => emit("info", message, args),
    debug: (message, ...args) => emit("debug", message, args),
    trace: (message, ...args) => emit("trace", message, args),
  };
}
