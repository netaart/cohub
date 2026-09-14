import { chatScrollTrace } from "./chat-scroll-trace";

/**
 * Opt-in timeline for opening a Chat. Marks are recorded into the existing in-app scroll
 * diagnostics (and forwarded to the debug session when enabled), and carry only phase names,
 * elapsed milliseconds, and counts — never content or IDs. No-op while diagnostics is off.
 */
const MAX_TRACE_MS = 120_000;

let startedAt = 0;

export function startChatEntry() {
  startedAt = Date.now();
}

export function markChatEntry(phase: string, fields: Record<string, number | boolean> = {}) {
  if (startedAt === 0) return;
  const elapsed = Date.now() - startedAt;
  if (elapsed > MAX_TRACE_MS) {
    startedAt = 0;
    return;
  }
  chatScrollTrace.record(`entry.${phase}`, "chat.entry", { ms: elapsed, ...fields });
}
