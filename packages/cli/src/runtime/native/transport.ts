import type { NativeRuntimeEvent } from "@neta-art/cohub";
import type { IngestTransport } from "./ingest.js";

/**
 * Transcript ingest travels over the existing Runtime WebSocket: one connection, one credential, no
 * second channel and no local receipts.
 */
export function nativeWebSocketTransport(send: (event: NativeRuntimeEvent) => Promise<unknown>): IngestTransport {
  const call = async <T>(event: NativeRuntimeEvent, options?: { signal?: AbortSignal }): Promise<T> => {
    options?.signal?.throwIfAborted();
    return await send(event) as T;
  };
  return {
    ingest: (event, options) => call(event, options),
    known: async (turnIds, options) => (await call<{ turns: Awaited<ReturnType<IngestTransport["known"]>> }>({ type: "known", input: { turnIds } }, options)).turns,
    progress: (event, options) => call(event, options),
    status: (sessionId, turnId, controllable, options) => call({ type: "status", sessionId, turnId, ...(controllable === undefined ? {} : { controllable }) }, options),
  };
}
