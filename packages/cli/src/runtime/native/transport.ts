import type { NativeRuntimeEvent } from "@neta-art/cohub";
import type { IngestTransport } from "./ingest.js";

/** Transcript writes use the Runtime WebSocket; registrations are read through the scoped SDK. */
export function nativeWebSocketTransport(send: (event: NativeRuntimeEvent) => Promise<unknown>, registration?: IngestTransport["registration"]): IngestTransport {
  const call = async <T>(event: NativeRuntimeEvent, options?: { signal?: AbortSignal }): Promise<T> => {
    options?.signal?.throwIfAborted();
    return await send(event) as T;
  };
  return {
    ...(registration ? { registration } : {}),
    ingest: (event, options) => call(event, options),
    known: async (turnIds, options) => (await call<{ turns: Awaited<ReturnType<IngestTransport["known"]>> }>({ type: "known", input: { turnIds } }, options)).turns,
    progress: (event, options) => call(event, options),
    status: (sessionId, turnId, controllable, options) => call({ type: "status", sessionId, turnId, ...(controllable === undefined ? {} : { controllable }) }, options),
  };
}
